import {
  chmod,
  mkdir,
  readFile,
  rename,
} from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { DEFAULT_DATA } from "./defaults.mjs";
import { envFileNames, badRequest, conflict, assertSafeId, readJsonBody, assertLocalRequest, sendJson, sendFile, htmlContentSecurityPolicy } from "./util.mjs";
import { createModelCatalog, queueModelCatalogRefresh, awaitLatestModelCatalog } from "./providers/catalog.mjs";
import { fetchElevenLabsVoices, fetchChatterboxVoices } from "./providers/generate.mjs";
import { serializeMutation, serializeWithLatestModelCatalog, listPlans, listEpisodes, readJson, writeJsonAtomic, exists, nextUpdatedAt } from "./store.mjs";
import { defaultConfig, readConfig, activateReferencedModels, redactConfig, saveConfigRequest } from "./config.mjs";
import { deleteEpisodeRequest, deleteSpeakerProfileRequest, saveEpisodeRequest, getEpisodeResponse, renameEpisodeRequest, applyLatestProfilesRequest, resolveTranscriptPromptRequest, saveTranscriptRequest, writeProfiles } from "./episodes.mjs";
import { createKnowledgeBase, deleteKnowledgeBase, createPlanRequest, getPlanResponse, updatePlanRequest, deletePlannedEpisodeRequest, deletePlanRequest, createPlanEpisodesRequest } from "./plans.mjs";
import { interruptStaleJobs, cleanupInterruptedEpisodeDeletes, cleanupStoredArtifacts, listJobsResponse, rememberJob, enqueueTtsJob, ensureFfmpeg, previewVoice, runProcess } from "./jobs.mjs";
import { handleMcpRequest, readWorkspaceState } from "./mcp.mjs";
import { handleSystemRequest, restartDaemon, writeMcpToken } from "./system.mjs";
export { validateProfileData, transcriptSpeakerRule, parseTranscript } from "./episodes.mjs";
export { clipCacheKey, writeAudioAsWav, runProcess } from "./jobs.mjs";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Data and config never depend on cwd: harness plugins start apupod from any folder.
export function resolveDirs(env = process.env) {
  const home = homedir();
  return {
    dataDir: env.APUPOD_DATA_DIR || join(env.XDG_DATA_HOME || join(home, ".local", "share"), "apupod"),
    configDir: env.APUPOD_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "apupod"),
  };
}

// Keys saved in the config-dir .env; a variable already in the process environment wins.
export async function loadEnvFile(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (Object.hasOwn(process.env, name)) continue;
    process.env[name] = value;
    envFileNames.add(name);
  }
}

async function createAppContext(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const paths = makePaths(options);
  await ensureData(paths);
  await loadEnvFile(paths.env);
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
    revision: 0,
    mcpToken: await ensureMcpToken(paths.mcpToken),
    mcpClients: new Map(),
    ffmpegCheck: null,
    mediaTools: null,
    updateCheck: null,
    updateJob: null,
    // Tests inject these: the npm runner and the daemon restart (which exits the process).
    runCommand: options.runCommand || runProcess,
    restart: options.restart || ((port) => restartDaemon(context, port)),
    server: null,
  };
  await cleanupInterruptedEpisodeDeletes(paths);
  await interruptStaleJobs(paths);
  for (const episode of (await listEpisodes(paths)).toReversed()) if (episode.job) rememberJob(context, episode.job);
  await cleanupStoredArtifacts(context);
  void queueModelCatalogRefresh(context).promise;

  return context;
}

export async function createPodcastServer(options = {}) {
  const context = await createAppContext(options);
  const server = context.server = createServer((req, res) => {
    routeRequest(req, res, context).catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, error.statusCode || 500, { error: error.message || String(error) });
    });
  });
  return server;
}

// The bearer token the stdio bridge sends to /mcp. Created once, readable only by the user.
async function ensureMcpToken(path) {
  if (await exists(path)) {
    await chmod(path, 0o600);
    const token = (await readFile(path, "utf8")).trim();
    if (token.length >= 32) return token;
  }
  return writeMcpToken(path);
}

// Tests pass dataDir and configDir, or a rootDir that holds data/, config.json, .env and public/.
function makePaths({ rootDir, dataDir, configDir }) {
  const defaults = rootDir ? { dataDir: join(rootDir, "data"), configDir: rootDir } : resolveDirs();
  const data = dataDir || defaults.dataDir;
  const config = configDir || defaults.configDir;
  const app = rootDir || HERE;
  return {
    data,
    profiles: join(data, "profiles.json"),
    config: join(config, "config.json"),
    knowledge: join(data, "knowledge"),
    knowledgeIndex: join(data, "knowledge", "index.json"),
    plans: join(data, "plans"),
    plansIndex: join(data, "plans", "index.json"),
    episodes: join(data, "episodes"),
    previews: join(data, "previews"),
    mcpToken: join(config, "mcp-token"),
    publicIndex: join(app, "public", "index.html"),
    publicIcon: join(app, "public", "icon.png"),
    env: join(config, ".env"),
  };
}

// isUsable rejects valid JSON with a shape that every reader would fail on; it is quarantined like invalid JSON.
async function quarantineCorruptJson(path, isUsable = () => true) {
  if (!(await exists(path))) return;
  try {
    if (!isUsable(await readJson(path))) throw Object.assign(new Error("unexpected data shape"), { invalidJson: true });
  } catch (error) {
    if (!error.invalidJson) throw error;
    const moved = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await rename(path, moved);
    console.warn(`[data] ${path} could not be read (${error.message || error}); moved to ${moved} and re-seeded defaults.`);
  }
}

async function ensureData(paths) {
  await Promise.all([mkdir(paths.knowledge, { recursive: true }), mkdir(paths.plans, { recursive: true }), mkdir(paths.episodes, { recursive: true }), mkdir(dirname(paths.config), { recursive: true, mode: 0o700 })]);
  await Promise.all([
    quarantineCorruptJson(paths.profiles, (value) => Array.isArray(value?.speakerProfiles) && Array.isArray(value?.episodeProfiles)),
    quarantineCorruptJson(paths.config),
    quarantineCorruptJson(paths.knowledgeIndex, Array.isArray),
    quarantineCorruptJson(paths.plansIndex, Array.isArray),
  ]);
  if (!(await exists(paths.profiles))) {
    await writeJsonAtomic(paths.profiles, { ...DEFAULT_DATA, updatedAt: nextUpdatedAt() });
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

  if (path === "/mcp") return handleMcpRequest(req, res, context);

  if (path === "/api/system" || path.startsWith("/api/system/")) return handleSystemRequest(req, res, context, method, path, url);

  if (method === "GET" && path === "/api/state") {
    return sendJson(res, 200, await readWorkspaceState(context));
  }

  if (method === "GET" && path === "/api/revision") {
    return sendJson(res, 200, { revision: context.revision });
  }

  if (method === "GET" && path === "/api/config") {
    return sendJson(res, 200, redactConfig(context.config));
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

  if (method === "POST" && path === "/api/models/refresh") {
    void queueModelCatalogRefresh(context).promise;
    return sendJson(res, 202, { status: "loading" });
  }

  if (method === "GET" && path === "/api/jobs") {
    return listJobsResponse(res, context);
  }

  if (method === "PUT" && path === "/api/profiles") {
    const value = await readJsonBody(req);
    // Optional, like PUT /api/plans/:id: a stale tab's list would bring back deleted hosts or drop hosts added elsewhere.
    const expectedUpdatedAt = value?.expectedUpdatedAt;
    if (value && typeof value === "object") delete value.expectedUpdatedAt;
    const result = await serializeWithLatestModelCatalog(context, async () => {
      const current = await readJson(context.paths.profiles);
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== (current.updatedAt ?? null)) throw conflict("Profiles changed somewhere else after this page loaded. Reload the page, then apply the change again.");
      return writeProfiles(context, value, current);
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
    return serializeMutation(context, () => createPlanRequest(req, res, context));
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

  const planMatch = path.match(/^\/api\/plans\/([a-zA-Z0-9_-]+)(?:\/(create-episodes))?$/);
  if (planMatch) {
    const [, id, action] = planMatch;
    assertSafeId(id);
    if (method === "GET" && !action) return getPlanResponse(res, context.paths, id);
    if (method === "PUT" && !action) return serializeMutation(context, () => updatePlanRequest(req, res, context, id));
    if (method === "DELETE" && !action) return serializeMutation(context, () => deletePlanRequest(res, context, id));
    if (method === "POST" && action === "create-episodes") return serializeMutation(context, () => createPlanEpisodesRequest(req, res, context, id));
  }

  const episodeMatch = path.match(/^\/api\/episodes\/([a-zA-Z0-9_-]+)(?:\/(transcript|render|profiles))?$/);
  if (episodeMatch) {
    const [, id, action] = episodeMatch;
    assertSafeId(id);
    if (method === "GET" && !action) return getEpisodeResponse(res, context.paths, id);
    if (method === "DELETE" && !action) return serializeMutation(context, () => deleteEpisodeRequest(res, context, id));
    if (method === "PATCH" && !action) return serializeMutation(context, () => renameEpisodeRequest(req, res, context.paths, id));
    if (method === "PUT" && action === "transcript") return serializeWithLatestModelCatalog(context, () => saveTranscriptRequest(req, res, context, id));
    if (method === "PUT" && action === "profiles") return serializeMutation(context, () => applyLatestProfilesRequest(res, context.paths, id));
    if (method === "POST" && action === "render") {
      await ensureFfmpeg(context);
      return serializeWithLatestModelCatalog(context, () => enqueueTtsJob(req, res, context, id));
    }
  }

  const previewMatch = path.match(/^\/previews\/([a-zA-Z0-9_-]+)\.wav$/);
  if (method === "GET" && previewMatch) {
    return sendFile(req, res, join(context.paths.previews, `${previewMatch[1]}.wav`), "audio/wav");
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
