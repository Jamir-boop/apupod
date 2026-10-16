import {
  mkdir,
  rename,
} from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DATA } from "./defaults.mjs";
import { createChatGptClient, ChatGptError } from "./chatgpt.mjs";
import { badRequest, assertSafeId, readJsonBody, assertLocalRequest, sendJson, sendFile, htmlContentSecurityPolicy } from "./util.mjs";
import { createModelCatalog, queueModelCatalogRefresh, awaitLatestModelCatalog, chatGptRecovery, chatGptStatus, chatGptCatalogAccount, refreshChatGptAccount, availableModelIds } from "./providers/catalog.mjs";
export { MIMO_VOICES, ELEVENLABS_MODELS, TTS_MODELS } from "./providers/catalog.mjs";
import { fetchElevenLabsVoices, fetchChatterboxVoices } from "./providers/generate.mjs";
import { serializeMutation, listPlans, listEpisodes, readJson, writeJsonAtomic, exists } from "./store.mjs";
import { defaultConfig, readConfig, activateReferencedModels, redactConfig, saveConfigRequest } from "./config.mjs";
import { deleteEpisodeRequest, deleteSpeakerProfileRequest, saveEpisodeRequest, getEpisodeResponse, renameEpisodeRequest, applyLatestProfilesRequest, resolveTranscriptPromptRequest, saveTranscriptRequest, validateProfileData, assertProfileRevisionsCurrent, applyProfileRevisions, mergeSavedProfileSelections, modelReferenceWarnings, assertProfilesCompatibleWithEpisodes } from "./episodes.mjs";
import { createKnowledgeBase, deleteKnowledgeBase, createPlanRequest, getPlanResponse, updatePlanRequest, deletePlannedEpisodeRequest, deletePlanRequest, generatePlanRequest, createPlanEpisodesRequest } from "./plans.mjs";
import { interruptStaleJobs, cleanupInterruptedEpisodeDeletes, cleanupStoredArtifacts, listJobsResponse, rememberJob, enqueueTranscriptJob, enqueueTtsJob, ensureFfmpeg, previewVoice } from "./jobs.mjs";
import { cleanupLegacyAssistantChats, listChatThreadsResponse, getChatThread, sendPlannerChatMessage, applyPlannerChatProposal, deleteChatThread } from "./chat.mjs";
export { validateProfileData, transcriptSpeakerRule, validateOutline, validateTranscriptJson, transcriptToMarkdown, parseTranscript } from "./episodes.mjs";
export { clipCacheKey, writeAudioAsWav, runProcess } from "./jobs.mjs";
export { sanitizeProposalEpisode } from "./chat.mjs";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function createAppContext(options = {}) {
  const rootDir = options.rootDir || HERE;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const paths = makePaths(rootDir);
  await ensureData(paths);
  const config = await readConfig(paths);
  if (activateReferencedModels(config, await readJson(paths.profiles))) await writeJsonAtomic(paths.config, config);
  const context = {
    paths,
    fetchImpl,
    config,
    modelCatalog: createModelCatalog(),
    modelRefreshTail: Promise.resolve(),
    latestModelRefresh: null,
    latestModelRefreshRevision: 0,
    chatterboxVoiceCache: { revision: 0, voices: null },
    queue: [],
    activeJobId: null,
    recentJobs: new Map(),
    mutationTail: Promise.resolve(),
    ffmpegCheck: null,
    chatBusy: new Map(),
  };
  await cleanupInterruptedEpisodeDeletes(paths);
  await interruptStaleJobs(paths);
  for (const episode of (await listEpisodes(paths)).toReversed()) if (episode.job) rememberJob(context, episode.job);
  await cleanupStoredArtifacts(context);
  await cleanupLegacyAssistantChats(paths);
  context.chatgptClient = options.chatgptClient || await createChatGptClient({ fetchImpl,
    ...(options.chatgptStorageDir || resolve(rootDir) !== HERE ? { storageDir: options.chatgptStorageDir || join(rootDir, ".chatgpt-auth") } : {}),
  });
  context.chatgptCatalogAccount = chatGptCatalogAccount(context);
  void queueModelCatalogRefresh(context).promise;

  return context;
}

export async function createPodcastServer(options = {}) {
  const context = await createAppContext(options);
  const server = createServer((req, res) => {
    routeRequest(req, res, context).catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof ChatGptError) {
        const diagnostics = Object.fromEntries(["requestId", "param", "bodyShape"].filter((key) => typeof error[key] === "string" && error[key].length <= 160 && /^[A-Za-z0-9_.:/\[\]-]+$/.test(error[key])).map((key) => [key, error[key]]));
        return sendJson(res, error.status || 502, { error: chatGptRecovery(error.code, diagnostics.param), code: error.code, ...diagnostics });
      }
      sendJson(res, error.statusCode || 500, { error: error.message || String(error) });
    });
  });
  const close = server.close.bind(server);
  let closing;
  server.close = (callback) => {
    closing ||= Promise.resolve(context.chatgptClient.close());
    void closing.then(() => close(callback), () => close(callback));
    return server;
  };
  return server;
}

const RETRY_MODEL_MUTATION = Symbol("retry-model-mutation");

async function serializeWithLatestModelCatalog(context, action) {
  for (;;) {
    const latest = context.latestModelRefresh;
    if (latest) await latest.promise;
    const result = await serializeMutation(context, () => {
      if (latest !== context.latestModelRefresh) return RETRY_MODEL_MUTATION;
      return action();
    });
    if (result !== RETRY_MODEL_MUTATION) return result;
  }
}

function makePaths(rootDir) {
  const data = join(rootDir, "data");
  return {
    root: rootDir,
    data,
    profiles: join(data, "profiles.json"),
    config: join(data, "config.json"),
    knowledge: join(data, "knowledge"),
    knowledgeIndex: join(data, "knowledge", "index.json"),
    plans: join(data, "plans"),
    plansIndex: join(data, "plans", "index.json"),
    episodes: join(data, "episodes"),
    chat: join(data, "chat"),
    publicIndex: join(rootDir, "public", "index.html"),
    publicIcon: join(rootDir, "public", "icon.png"),
    env: join(rootDir, ".env"),
  };
}

async function quarantineCorruptJson(path) {
  if (!(await exists(path))) return;
  try {
    await readJson(path);
  } catch (error) {
    if (!error.invalidJson) throw error;
    const moved = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await rename(path, moved);
    console.warn(`[data] ${path} could not be read (${error.message || error}); moved to ${moved} and re-seeded defaults.`);
  }
}

async function ensureData(paths) {
  await Promise.all([mkdir(paths.knowledge, { recursive: true }), mkdir(paths.plans, { recursive: true }), mkdir(paths.episodes, { recursive: true }), mkdir(paths.chat, { recursive: true })]);
  await Promise.all([quarantineCorruptJson(paths.profiles), quarantineCorruptJson(paths.config)]);
  if (!(await exists(paths.profiles))) {
    await writeJsonAtomic(paths.profiles, DEFAULT_DATA);
  }
  if (!(await exists(paths.knowledgeIndex))) {
    await writeJsonAtomic(paths.knowledgeIndex, []);
  }
  if (!(await exists(paths.plansIndex))) {
    await writeJsonAtomic(paths.plansIndex, []);
  }
  if (!(await exists(paths.config))) {
    await writeJsonAtomic(paths.config, defaultConfig());
  }
}

async function routeRequest(req, res, context) {
  const method = req.method || "GET";
  const url = new URL(req.url || "/", "http://127.0.0.1");
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    throw badRequest("Request path is malformed.");
  }
  assertLocalRequest(req, method);

  if (method === "GET" && path === "/") {
    const csp = await exists(context.paths.publicIndex) ? await htmlContentSecurityPolicy(context.paths.publicIndex) : "";
    return sendFile(req, res, context.paths.publicIndex, "text/html; charset=utf-8", csp);
  }

  if (method === "GET" && path === "/icon.png") {
    return sendFile(req, res, context.paths.publicIcon, "image/png");
  }

  if (method === "GET" && path === "/api/state") {
    const [profiles, knowledgeBases, plans, episodes] = await Promise.all([
      readJson(context.paths.profiles),
      readJson(context.paths.knowledgeIndex),
      listPlans(context.paths),
      listEpisodes(context.paths),
    ]);
    return sendJson(res, 200, { profiles, knowledgeBases, plans, episodes, config: await redactConfig(context.config) });
  }

  if (method === "GET" && path === "/api/config") {
    return sendJson(res, 200, await redactConfig(context.config));
  }

  if (method === "PUT" && path === "/api/config") {
    const value = await readJsonBody(req);
    const { saved, refresh } = await serializeMutation(context, async () => ({
      saved: await saveConfigRequest(context, value),
      refresh: queueModelCatalogRefresh(context, { force: true }),
    }));
    return sendJson(res, 200, { ...saved, modelCatalog: await refresh.promise });
  }

  if (method === "GET" && path === "/api/models") {
    return sendJson(res, 200, context.modelCatalog);
  }

  if (path === "/api/chatgpt/status" && method === "GET") {
    const refresh = refreshChatGptAccount(context);
    return sendJson(res, 200, { ...chatGptStatus(context), ...(refresh ? { modelCatalog: await refresh.promise } : {}) });
  }
  const chatGptAction = path.match(/^\/api\/chatgpt\/(signin|select|signout|cancel)$/);
  if (chatGptAction && method === "POST") {
    const body = await readJsonBody(req);
    const action = chatGptAction[1];
    const accountId = String(body.accountId || "").trim();
    let result;
    if (action === "signin") {
      result = await context.chatgptClient.signIn(accountId || undefined);
      const url = new URL(result.authorizeUrl);
      if (url.origin !== "https://auth.openai.com" || url.pathname !== "/api/accounts/authorize" || url.username || url.password || url.hash) throw badRequest("ChatGPT returned an invalid sign-in URL.");
    } else if (action === "select") await context.chatgptClient.select(accountId);
    else if (action === "signout") result = await context.chatgptClient.signOut(accountId || undefined);
    else context.chatgptClient.cancel();
    const refresh = refreshChatGptAccount(context, action === "select" || action === "signout");
    return sendJson(res, 200, { ...chatGptStatus(context), ...(action === "signin" ? { authorizeUrl: result.authorizeUrl } : {}), ...(result?.warning ? { warning: result.warning } : {}), ...(refresh ? { modelCatalog: await refresh.promise } : {}) });
  }

  if (method === "POST" && path === "/api/models/refresh") {
    void queueModelCatalogRefresh(context).promise;
    return sendJson(res, 202, { status: "loading" });
  }

  if (method === "GET" && path === "/api/jobs") {
    return listJobsResponse(res, context);
  }

  if (method === "PUT" && path === "/api/profiles") {
    const value = await readJsonBody(req);
    const result = await serializeWithLatestModelCatalog(context, async () => {
      const models = availableModelIds(context);
      const current = await readJson(context.paths.profiles);
      mergeSavedProfileSelections(models, current);
      validateProfileData(value, models);
      assertProfileRevisionsCurrent(value, current);
      await assertProfilesCompatibleWithEpisodes(context.paths, value, current);
      applyProfileRevisions(value, current);
      await writeJsonAtomic(context.paths.profiles, value);
      return { profiles: value, warnings: modelReferenceWarnings(value, availableModelIds(context)) };
    });
    return sendJson(res, 200, result);
  }

  if (method === "POST" && path === "/api/knowledge") {
    return serializeMutation(context, () => createKnowledgeBase(req, res, context.paths));
  }

  const knowledgeMatch = path.match(/^\/api\/knowledge\/([a-zA-Z0-9_-]+)$/);
  if (method === "DELETE" && knowledgeMatch) {
    assertSafeId(knowledgeMatch[1]);
    return serializeMutation(context, () => deleteKnowledgeBase(res, context, knowledgeMatch[1]));
  }

  if (method === "POST" && path === "/api/episodes") {
    return serializeMutation(context, () => saveEpisodeRequest(req, res, context.paths));
  }

  if (method === "GET" && path === "/api/plans") {
    return sendJson(res, 200, { plans: await listPlans(context.paths) });
  }

  if (method === "POST" && path === "/api/plans") {
    return serializeWithLatestModelCatalog(context, () => createPlanRequest(req, res, context));
  }

  if (method === "POST" && path === "/api/plans/chat") {
    return sendPlannerChatMessage(req, res, context);
  }

  if (method === "POST" && path === "/api/plans/chat/apply") {
    return serializeMutation(context, () => applyPlannerChatProposal(req, res, context));
  }

  if (method === "POST" && path === "/api/preview") {
    await awaitLatestModelCatalog(context);
    return previewVoice(req, res, context);
  }

  if (method === "GET" && path === "/api/tts/elevenlabs/voices") {
    return listElevenLabsVoices(res, context);
  }

  if (method === "GET" && path === "/api/tts/chatterbox/voices") {
    return listChatterboxVoices(res, context);
  }

  if (method === "GET" && path === "/api/chats") {
    return listChatThreadsResponse(req, res, context);
  }

  if (method === "GET" && path === "/api/chat") {
    return getChatThread(req, res, context);
  }

  if (method === "DELETE" && path === "/api/chat") {
    return serializeMutation(context, () => deleteChatThread(req, res, context));
  }

  if (method === "POST" && path === "/api/transcript-prompt/resolve") {
    await awaitLatestModelCatalog(context);
    return resolveTranscriptPromptRequest(req, res, context);
  }

  const speakerMatch = path.match(/^\/api\/speaker-profiles\/([a-zA-Z0-9_-]+)$/);
  if (speakerMatch && method === "DELETE") {
    assertSafeId(speakerMatch[1]);
    return serializeMutation(context, () => deleteSpeakerProfileRequest(res, context, speakerMatch[1]));
  }

  const plannedEpisodeMatch = path.match(/^\/api\/plans\/([a-zA-Z0-9_-]+)\/episodes\/([a-zA-Z0-9_-]+)$/);
  if (plannedEpisodeMatch && method === "DELETE") {
    const [, planId, plannedEpisodeId] = plannedEpisodeMatch;
    assertSafeId(planId);
    assertSafeId(plannedEpisodeId);
    return serializeMutation(context, () => deletePlannedEpisodeRequest(res, context.paths, planId, plannedEpisodeId));
  }

  const planMatch = path.match(/^\/api\/plans\/([a-zA-Z0-9_-]+)(?:\/(generate|create-episodes))?$/);
  if (planMatch) {
    const [, id, action] = planMatch;
    assertSafeId(id);
    if (method === "GET" && !action) return getPlanResponse(res, context.paths, id);
    if (method === "PUT" && !action) return serializeMutation(context, () => updatePlanRequest(req, res, context, id));
    if (method === "DELETE" && !action) return serializeMutation(context, () => deletePlanRequest(res, context, id));
    if (method === "POST" && action === "generate") return generatePlanRequest(req, res, context, id);
    if (method === "POST" && action === "create-episodes") return serializeMutation(context, () => createPlanEpisodesRequest(req, res, context, id));
  }

  const episodeMatch = path.match(/^\/api\/episodes\/([a-zA-Z0-9_-]+)(?:\/(generate|transcript|render|profiles))?$/);
  if (episodeMatch) {
    const [, id, action] = episodeMatch;
    assertSafeId(id);
    if (method === "GET" && !action) return getEpisodeResponse(res, context.paths, id);
    if (method === "DELETE" && !action) return serializeMutation(context, () => deleteEpisodeRequest(res, context, id));
    if (method === "PATCH" && !action) return serializeMutation(context, () => renameEpisodeRequest(req, res, context.paths, id));
    if (method === "PUT" && action === "transcript") return serializeWithLatestModelCatalog(context, () => saveTranscriptRequest(req, res, context, id));
    if (method === "PUT" && action === "profiles") return serializeMutation(context, () => applyLatestProfilesRequest(res, context.paths, id));
    if (method === "POST" && action === "generate") return serializeWithLatestModelCatalog(context, () => enqueueTranscriptJob(req, res, context, id));
    if (method === "POST" && action === "render") {
      await ensureFfmpeg(context);
      return serializeWithLatestModelCatalog(context, () => enqueueTtsJob(req, res, context, id));
    }
  }

  const artifactMatch = path.match(/^\/artifacts\/([a-zA-Z0-9_-]+)\/episode\.mp3$/);
  if (method === "GET" && artifactMatch) {
    assertSafeId(artifactMatch[1]);
    return sendFile(req, res, join(context.paths.episodes, artifactMatch[1], "episode.mp3"), "audio/mpeg");
  }

  sendJson(res, 404, { error: "Not found." });
}

async function listElevenLabsVoices(res, context) {
  sendJson(res, 200, await fetchElevenLabsVoices(context));
}

async function listChatterboxVoices(res, context) {
  sendJson(res, 200, { voices: await fetchChatterboxVoices(context) });
}
