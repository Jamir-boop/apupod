// The /mcp endpoint: deterministic tools over the same core functions the REST handlers use.
// Stateless streamable HTTP: one McpServer per request, so all state stays in the app context and its write lock.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod";
import { notFound, readJsonBody, sendJson } from "./util.mjs";
import { serializeMutation, serializeWithLatestModelCatalog, listPlans, listEpisodes, loadPlan, loadEpisode, resolveEpisodeProfiles, profileRevision, readJson } from "./store.mjs";
import { redactConfig, setTtsModels } from "./config.mjs";
import { availableModelIds, awaitLatestModelCatalog, discoveredModelLanguages, inactiveTtsModels, modelLanguageError, resolveLanguage, MIMO_VOICES, OPENAI_VOICES } from "./providers/catalog.mjs";
import { ttsCueCapability, fetchElevenLabsVoices, fetchChatterboxVoices, CHATTERBOX_TAGS, CHATTERBOX_DEFAULTS, ELEVENLABS_DEFAULTS, MIMO_INSTRUCTION_PRESETS, TTS_DOCS } from "./providers/generate.mjs";
import { TRANSCRIPT_TARGET_WORDS_PER_MINUTE, TRANSCRIPT_MINIMUM_WORDS_PER_MINUTE, deleteEpisode, deleteSpeakerProfile, saveEpisodeFromBody, renameEpisode, resolveTranscriptPrompt, saveTranscript, transcriptLengthWarning, transcriptSpeakerRule, parseTranscript, writeProfiles } from "./episodes.mjs";
import { addKnowledgeBase, readKnowledgeBase, removeKnowledgeBase, saveAgentPlan, deletePlan, createPlanEpisodes } from "./plans.mjs";
import { listJobs, enqueueTts, ensureFfmpeg, previewVoiceAudio } from "./jobs.mjs";
import { jevDecide, voiceCatalog } from "./decide.mjs";
import { JEV_MODEL } from "./jev.mjs";
import { VERSION, mcpClientList, recordMcpClients } from "./system.mjs";
import { WIDGET_MIME_TYPE, WORKSPACE_WIDGET_URI, EPISODE_WIDGET_URI, WORKSPACE_WIDGET_HTML, EPISODE_WIDGET_HTML } from "./widgets.mjs";

const PREVIEW_MAX_AGE_MS = 60 * 60 * 1000;

// GET /api/state and get_workspace.
export async function readWorkspaceState(context) {
  const [profiles, knowledgeBases, plans, episodes] = await Promise.all([
    readJson(context.paths.profiles),
    readJson(context.paths.knowledgeIndex),
    listPlans(context.paths),
    listEpisodes(context.paths),
  ]);
  return { profiles, knowledgeBases, plans, episodes, config: redactConfig(context.config) };
}

export async function handleMcpRequest(req, res, context) {
  const origin = `http://${String(req.headers.host || "").toLowerCase()}`;
  if (req.headers.origin) {
    let value = "invalid";
    try { value = new URL(req.headers.origin).origin.toLowerCase(); } catch {}
    if (value !== origin) return sendJson(res, 403, { error: "Cross-origin MCP requests are forbidden." });
  }
  const expected = Buffer.from(`Bearer ${context.mcpToken}`);
  const given = Buffer.from(String(req.headers.authorization || ""));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="apupod"');
    return sendJson(res, 401, { error: "Missing or invalid MCP bearer token." });
  }
  // Stateless: no session, so no standalone SSE stream (GET) and nothing to delete (DELETE).
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "Method not allowed." });
  }
  const body = await readJsonBody(req);
  recordMcpClients(context, body);
  const server = createMcpServer(context, origin);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

const id = (label = "ID") => z.string().regex(/^[a-zA-Z0-9_-]+$/, `${label} is invalid.`);
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = ({ destructive = false, idempotent = false, openWorld = false } = {}) => ({ readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: openWorld });

const result = (summary, data) => ({ content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }], structuredContent: data });

const speakerSchema = z.object({
  name: z.string().describe("Spoken name used in the script, e.g. \"Alex\". No colons or square brackets."),
  backstory: z.string().optional(),
  personality: z.string().optional(),
  style: z.string().optional().describe("Voice and delivery style."),
  accent: z.string().optional(),
  voiceId: z.string().optional().describe("Voice ID from list_voices for this speaker's model."),
  ttsModelOverride: z.string().optional().describe("TTS model for this speaker only; empty uses the profile voiceModel."),
  chatterboxExaggeration: z.number().optional(),
  chatterboxCfgWeight: z.number().optional(),
  chatterboxTemperature: z.number().optional(),
  mimoTemperature: z.number().nullable().optional(),
  mimoTopP: z.number().nullable().optional(),
  mimoInstructionPreset: z.string().optional(),
  mimoInstructionText: z.string().optional(),
  elevenlabsStability: z.number().optional(),
  elevenlabsSimilarityBoost: z.number().optional(),
  elevenlabsStyle: z.number().optional(),
  elevenlabsUseSpeakerBoost: z.boolean().optional(),
  elevenlabsSpeed: z.number().optional(),
  elevenlabsSeed: z.number().int().nullable().optional(),
  elevenlabsTextNormalization: z.enum(["auto", "on", "off"]).optional(),
});

const plannedEpisodeSchema = z.object({
  id: z.string().optional().describe("Existing planned episode ID, to keep it and its created-episode link."),
  number: z.number().int().describe("Position in the plan, starting at 1."),
  title: z.string(),
  premise: z.string().optional(),
  knowledgeScope: z.string().optional(),
  keyPoints: z.array(z.string()).optional(),
  listenerOutcome: z.string().optional(),
  episodeProfileId: z.string().optional(),
  additionalInstructions: z.string().optional(),
  transcriptPromptGuidance: z.string().optional(),
});

const MARKDOWN_FORMAT = `# Episode title (optional; renames an episode still called "New episode")
## Segment title
Speaker Name: Spoken text.
Speaker Name [short delivery direction]: Spoken text with only the cues this speaker's model allows.`;

// Documentation of the profile tuning ranges validateProfileData enforces.
const TTS_SETTINGS = {
  chatterbox: {
    chatterboxExaggeration: { min: 0.25, max: 2, default: CHATTERBOX_DEFAULTS.exaggeration },
    chatterboxCfgWeight: { min: 0, max: 1, default: CHATTERBOX_DEFAULTS.cfgWeight },
    chatterboxTemperature: { min: 0.05, max: 5, default: CHATTERBOX_DEFAULTS.temperature },
  },
  mimo: {
    mimoTemperature: { min: 0, max: 2, default: null },
    mimoTopP: { min: 0, max: 1, default: null },
    mimoInstructionPreset: { options: ["", ...Object.keys(MIMO_INSTRUCTION_PRESETS)], default: "" },
    mimoInstructionText: { maxLength: 500, default: "" },
  },
  elevenlabs: {
    elevenlabsStability: { min: 0, max: 1, default: ELEVENLABS_DEFAULTS.stability },
    elevenlabsSimilarityBoost: { min: 0, max: 1, default: ELEVENLABS_DEFAULTS.similarityBoost },
    elevenlabsStyle: { min: 0, max: 1, default: ELEVENLABS_DEFAULTS.style },
    elevenlabsUseSpeakerBoost: { type: "boolean", default: true },
    elevenlabsSpeed: { min: 0.7, max: 1.2, default: ELEVENLABS_DEFAULTS.speed },
    elevenlabsSeed: { min: 0, max: 4294967295, integer: true, default: null },
    elevenlabsTextNormalization: { options: ["auto", "on", "off"], default: ELEVENLABS_DEFAULTS.textNormalization },
  },
  accent: { maxLength: 100, default: "the language default" },
};

function ttsReadiness(context, config) {
  const providers = context.modelCatalog.providers;
  const provider = (name) => ({ status: providers[name].status, hasApiKey: config.providers[name].hasApiKey, error: providers[name].error || null });
  const models = [...availableModelIds(context).ttsModels];
  // A provider with a key, or a keyless one that is configured (Chatterbox, compatible), needs activation or a fix, not a key.
  const hasKey = ["mimo", "elevenlabs", "openai", "chatterbox"].some((name) => config.providers[name].hasApiKey || providers[name].status !== "unconfigured")
    || (providers.compatible || []).some((item) => item.status !== "unconfigured");
  return {
    ready: models.length > 0,
    catalogStatus: context.modelCatalog.status,
    models,
    hint: models.length ? null : hasKey && inactiveTtsModels(context).length
      ? "No TTS model is active. Activate one with set_tts_models (model IDs from list_tts_options \"available\") or in Settings > Models."
      : hasKey ? "No TTS model is active or available. Check the provider status in Settings, then refresh models."
        : "No TTS provider has a key. Add a TTS key in Settings.",
    providers: {
      mimo: provider("mimo"),
      elevenlabs: provider("elevenlabs"),
      openai: provider("openai"),
      chatterbox: provider("chatterbox"),
      compatible: (providers.compatible || []).map((item) => ({ id: item.id, name: item.name, status: item.status, error: item.error || null, hasApiKey: config.compatibleConnections.find((connection) => connection.id === item.id)?.hasApiKey === true })),
    },
  };
}

const jobView = (job) => job ? { id: job.id, type: job.type, status: job.status, phase: job.phase, completed: job.completed, total: job.total, message: job.message, error: job.error, queuedAt: job.queuedAt, finishedAt: job.finishedAt } : null;

async function workspaceOverview(context, origin) {
  const state = await readWorkspaceState(context);
  return {
    uiUrl: `${origin}/`,
    revision: context.revision,
    profilesUpdatedAt: state.profiles.updatedAt ?? null,
    hosts: state.profiles.speakerProfiles.map((profile) => ({ id: profile.id, name: profile.name, revision: profileRevision(profile), voiceModel: profile.voiceModel, speakers: profile.speakers.map((speaker) => ({ name: speaker.name, voiceId: speaker.voiceId, ttsModelOverride: speaker.ttsModelOverride || "" })) })),
    formats: state.profiles.episodeProfiles.map((profile) => ({ id: profile.id, name: profile.name, revision: profileRevision(profile), speakerProfileId: profile.speakerProfileId, language: profile.language, targetMinutes: profile.targetMinutes, numSegments: profile.numSegments })),
    knowledgeBases: state.knowledgeBases,
    plans: state.plans,
    episodes: state.episodes.map((episode) => ({ id: episode.id, name: episode.name, status: episode.status, audioReady: episode.audioReady === true, transcriptWords: episode.transcriptWords ?? null, episodeProfileId: episode.episodeProfileId ?? null, knowledgeBaseId: episode.knowledgeBaseId ?? null, job: jobView(episode.job), updatedAt: episode.updatedAt })),
    tts: ttsReadiness(context, state.config),
    jev: { available: state.config.assistantDecision.hasApiKey, model: JEV_MODEL },
    // The last update check the Settings view ran (no network call here), and the most recent MCP initialize per client.
    apupod: { version: VERSION, update: context.updateCheck?.value ?? null, mcpClients: mcpClientList(context) },
  };
}

async function episodeView(context, origin, episodeId, extra = {}) {
  const episode = await loadEpisode(context.paths, episodeId, true);
  let stats = { segments: null, words: episode.transcriptWords ?? null, targetMinutes: null };
  try {
    const { episodeProfile, speakerProfile } = await resolveEpisodeProfiles(context.paths, episode);
    stats = { ...stats, targetMinutes: episodeProfile.targetMinutes, maxSegments: episodeProfile.numSegments, minimumWords: Math.round(episodeProfile.targetMinutes * TRANSCRIPT_MINIMUM_WORDS_PER_MINUTE) };
    if (episode.transcript.trim()) stats.segments = parseTranscript(episode.transcript, speakerProfile.speakers, episodeProfile.numSegments).segments.length;
  } catch {}
  return {
    episode: { ...episode, job: episode.job ?? null },
    audioUrl: episode.audioUrl ? `${origin}${episode.audioUrl}` : null,
    uiUrl: `${origin}/?view=episode&episode=${encodeURIComponent(episode.id)}`,
    stats,
    ...extra,
  };
}

const episodeSummary = (view) => `Episode "${view.episode.name}" (${view.episode.id}): ${view.episode.status}${view.audioUrl ? `, audio ${view.audioUrl}` : ""}.`;

function wavSeconds(bytes) {
  let byteRate = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const chunk = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (chunk === "fmt ") byteRate = bytes.readUInt32LE(offset + 16);
    if (chunk === "data") return byteRate ? Math.round(size / byteRate * 1000) / 1000 : null;
    offset += 8 + size + size % 2;
  }
  return null;
}

async function savePreview(context, bytes) {
  await mkdir(context.paths.previews, { recursive: true });
  // Previews are throwaway listening checks; drop the ones older than an hour.
  for (const name of await readdir(context.paths.previews)) {
    const path = join(context.paths.previews, name);
    if (Date.now() - (await stat(path).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs > PREVIEW_MAX_AGE_MS) await rm(path, { force: true });
  }
  const name = randomUUID();
  await writeFile(join(context.paths.previews, `${name}.wav`), bytes);
  return name;
}

// Read the stored profiles, change a copy, and write it through the same validation as PUT /api/profiles.
function updateProfiles(context, change) {
  return serializeWithLatestModelCatalog(context, async () => {
    const current = await readJson(context.paths.profiles);
    const next = structuredClone(current);
    const view = change(next, current);
    const saved = await writeProfiles(context, next, current);
    return { ...view(saved.profiles), warnings: saved.warnings };
  });
}

function upsert(list, input, kind, prefix) {
  const { id: itemId, expectedRevision, ...fields } = input;
  const existing = itemId ? list.find((item) => item.id === itemId) : null;
  if (itemId && !existing) throw notFound(`${kind} not found.`);
  if (existing) {
    const speakers = fields.speakers?.map((speaker) => ({ ...(existing.speakers.find((item) => item.name === speaker.name) || {}), ...speaker }));
    Object.assign(existing, fields, speakers ? { speakers } : {}, { revision: expectedRevision ?? profileRevision(existing) });
    return existing.id;
  }
  const created = { id: `${prefix}-${randomUUID()}`, ...fields };
  list.push(created);
  return created.id;
}

export function createMcpServer(context, origin) {
  const server = new McpServer({ name: "apupod", version: VERSION }, { instructions: "apupod is a local podcast studio. Start with get_workspace. You write hosts, plans, and scripts; apupod validates, saves, and renders audio with TTS." });
  const { paths } = context;
  const csp = { connectDomains: [origin], resourceDomains: [origin] };
  const widget = (uri) => ({ ui: { resourceUri: uri } });
  for (const [name, uri, html, description] of [
    ["workspace", WORKSPACE_WIDGET_URI, WORKSPACE_WIDGET_HTML, "apupod workspace overview"],
    ["episode", EPISODE_WIDGET_URI, EPISODE_WIDGET_HTML, "apupod episode status and player"],
  ]) {
    server.registerResource(name, uri, { description, mimeType: WIDGET_MIME_TYPE }, async () => ({
      contents: [{ uri, mimeType: WIDGET_MIME_TYPE, text: html, _meta: { ui: { csp, prefersBorder: true } } }],
    }));
  }
  const tool = (name, config, handler) => server.registerTool(name, config, handler);

  tool("get_workspace", {
    title: "Get workspace",
    description: "Overview of the apupod workspace: host profiles, Episode Formats, knowledge bases, plans, episodes (IDs, names, status), TTS readiness, Jev availability, the apupod version and update status, recent MCP client connections, and the UI URL. Call this first.",
    inputSchema: {},
    annotations: READ,
    _meta: widget(WORKSPACE_WIDGET_URI),
  }, async () => {
    const data = await workspaceOverview(context, origin);
    return result(`apupod workspace: ${data.hosts.length} host profiles, ${data.formats.length} formats, ${data.knowledgeBases.length} knowledge bases, ${data.plans.length} plans, ${data.episodes.length} episodes. TTS ${data.tts.ready ? "ready" : `not ready: ${data.tts.hint}`}. UI: ${data.uiUrl}`, data);
  });

  tool("open_ui", {
    title: "Open apupod UI",
    description: "Return the apupod browser UI URL, optionally deep-linked to a view or episode, with the workspace overview.",
    inputSchema: {
      view: z.enum(["production", "hosts", "format", "script", "tts", "player", "activity", "settings", "episode"]).optional(),
      episodeId: id("Episode").optional(),
    },
    annotations: READ,
    _meta: widget(WORKSPACE_WIDGET_URI),
  }, async ({ view, episodeId }) => {
    const query = new URLSearchParams({ ...(view ? { view } : episodeId ? { view: "episode" } : {}), ...(episodeId ? { episode: episodeId } : {}) }).toString();
    const url = `${origin}/${query ? `?${query}` : ""}`;
    return result(`Open apupod: ${url}`, { url, ...(await workspaceOverview(context, origin)) });
  });

  tool("list_tts_options", {
    title: "List TTS options",
    description: "Active TTS models (`models`) with provider, supported languages, and cue capability (square-bracket tags, ElevenLabs breaks, or delivery-only) for a language; discovered but inactive models (`available`) that set_tts_models can activate; providers with keys; tuning ranges and defaults; Chatterbox tags; MiMo presets.",
    inputSchema: { language: z.string().optional().describe("Language ID for cue capabilities, e.g. \"es-419\". Default en-US.") },
    annotations: READ,
  }, async ({ language = "en-US" }) => {
    await awaitLatestModelCatalog(context);
    const target = resolveLanguage(context, language);
    const config = redactConfig(context.config);
    const models = [...availableModelIds(context).ttsModels].map((model) => {
      const { provider, cueMode, squareTags, breaks } = ttsCueCapability(context, model, target);
      return { id: model, provider, cue: { cueMode, squareTags, breaks }, languages: context.modelCatalog.languages.filter((item) => !modelLanguageError(context, model, item)).map((item) => item.id) };
    });
    const available = inactiveTtsModels(context).map((model) => {
      const { cueMode, squareTags, breaks } = ttsCueCapability(context, model.id, target);
      return { id: model.id, name: model.name || model.id, provider: model.provider, capabilities: { cueMode, squareTags, breaks }, languages: discoveredModelLanguages(context, model) };
    });
    const tts = ttsReadiness(context, config);
    const data = { language: target.id, models, available, tts, settings: TTS_SETTINGS, chatterboxTags: CHATTERBOX_TAGS, mimoInstructionPresets: Object.keys(MIMO_INSTRUCTION_PRESETS), languages: context.modelCatalog.languages.map(({ id: languageId, name, defaultAccent }) => ({ id: languageId, name, defaultAccent })), docs: TTS_DOCS };
    return result(`${models.length} active TTS models: ${models.map((model) => model.id).join(", ") || `none. ${tts.hint}`}${available.length ? ` ${available.length} available to activate: ${available.map((model) => model.id).join(", ")}.` : ""}`, data);
  });

  tool("set_tts_models", {
    title: "Set active TTS models",
    description: "Activate (active: true) or deactivate (active: false) TTS models by the IDs list_tts_options returns (`available` to activate, `models` to deactivate). Uses the same config save as Settings > Models and refreshes the model catalog. Deactivating a model that a host profile or saved episode uses is refused. Writes local config only; deactivation can make profiles unrenderable, so it is marked destructive. Returns the active model list.",
    inputSchema: {
      models: z.array(z.string().min(1)).min(1).describe("TTS model IDs from list_tts_options."),
      active: z.boolean().describe("true activates the models; false deactivates them."),
    },
    annotations: write({ destructive: true, idempotent: true }),
  }, async ({ models, active }) => {
    const saved = await setTtsModels(context, models, active);
    const activeModels = [...availableModelIds(context).ttsModels];
    return result(`${active ? "Activated" : "Deactivated"} ${models.join(", ")}. ${activeModels.length} active TTS models: ${activeModels.join(", ") || "none"}.`, { models: activeModels, warnings: saved.warnings });
  });

  tool("list_voices", {
    title: "List voices",
    description: "Voices for a TTS provider (elevenlabs, chatterbox, mimo, openai) or, with `model`, for one active TTS model (compatible models list the voice IDs saved in profiles).",
    inputSchema: {
      provider: z.enum(["elevenlabs", "chatterbox", "mimo", "openai"]).optional(),
      model: z.string().optional(),
    },
    annotations: { ...READ, openWorldHint: true },
  }, async ({ provider, model }) => {
    let voices;
    if (model) {
      await awaitLatestModelCatalog(context);
      const catalog = await voiceCatalog(context, await readJson(paths.profiles), true);
      if (!catalog.has(model)) throw notFound(`TTS model "${model}" is not active.`);
      voices = catalog.get(model);
    } else if (provider === "elevenlabs") voices = (await fetchElevenLabsVoices(context)).voices;
    else if (provider === "chatterbox") voices = await fetchChatterboxVoices(context);
    else if (provider === "mimo") voices = MIMO_VOICES.map((voice) => ({ id: voice, name: voice }));
    else if (provider === "openai") voices = OPENAI_VOICES.map((voice) => ({ id: voice, name: voice }));
    else throw new Error("Give a provider or a model.");
    return result(`${voices.length} voices.`, { provider: provider ?? null, model: model ?? null, voices });
  });

  tool("save_host_profile", {
    title: "Save host profile",
    description: "Create (no id) or update (id) a host profile with 1 to 4 speakers. On update, given fields replace saved ones and each speaker keeps its saved settings for fields you omit (matched by name). expectedRevision rejects the save if the profile changed since you read it.",
    inputSchema: {
      id: id("Host profile").optional(),
      expectedRevision: z.number().int().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      instructions: z.string().optional().describe("Show rules for the hosts."),
      voiceModel: z.string().optional().describe("Default TTS model from list_tts_options."),
      speakers: z.array(speakerSchema).min(1).max(4).optional(),
    },
    annotations: write(),
  }, async (input) => {
    if (!input.id && !input.voiceModel) throw new Error("A new host profile needs voiceModel. Pick one from list_tts_options.");
    let savedId;
    const data = await updateProfiles(context, (next) => {
      savedId = upsert(next.speakerProfiles, input, "Host profile", "speaker");
      return (profiles) => ({ profile: profiles.speakerProfiles.find((item) => item.id === savedId), profilesUpdatedAt: profiles.updatedAt });
    });
    return result(`Saved host profile "${data.profile.name}" (${savedId}), revision ${data.profile.revision}.${data.warnings.length ? ` Warnings: ${data.warnings.join(" ")}` : ""}`, data);
  });

  tool("delete_host_profile", {
    title: "Delete host profile",
    description: "Delete a host profile. Episode Formats and plans that use it move to the first remaining profile. At least one profile must remain.",
    inputSchema: { id: id("Host profile") },
    annotations: write({ destructive: true, idempotent: true }),
  }, async ({ id: profileId }) => {
    const { id: deletedId, deleted, fallbackId, repointedPlans } = await serializeMutation(context, () => deleteSpeakerProfile(context, profileId));
    return result(`Deleted host profile ${deletedId}; ${repointedPlans} plans now use ${fallbackId}.`, { id: deletedId, deleted, fallbackId, repointedPlans });
  });

  tool("save_episode_format", {
    title: "Save Episode Format",
    description: "Create (no id) or update (id) an Episode Format: name, description, host profile, language, and target minutes (5 to 60; the segment count is derived).",
    inputSchema: {
      id: id("Episode Format").optional(),
      expectedRevision: z.number().int().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      speakerProfileId: z.string().optional(),
      language: z.string().optional(),
      targetMinutes: z.number().int().optional(),
    },
    annotations: write(),
  }, async (input) => {
    let savedId;
    const data = await updateProfiles(context, (next) => {
      savedId = upsert(next.episodeProfiles, input, "Episode Format", "episode-format");
      return (profiles) => ({ format: profiles.episodeProfiles.find((item) => item.id === savedId), profilesUpdatedAt: profiles.updatedAt });
    });
    return result(`Saved Episode Format "${data.format.name}" (${savedId}): ${data.format.targetMinutes} min, ${data.format.numSegments} segments.`, data);
  });

  tool("delete_episode_format", {
    title: "Delete Episode Format",
    description: "Delete an Episode Format that no episode or plan uses. At least one format must remain.",
    inputSchema: { id: id("Episode Format") },
    annotations: write({ destructive: true, idempotent: true }),
  }, async ({ id: formatId }) => {
    const data = await updateProfiles(context, (next) => {
      if (!next.episodeProfiles.some((item) => item.id === formatId)) throw notFound("Episode Format not found.");
      next.episodeProfiles = next.episodeProfiles.filter((item) => item.id !== formatId);
      return (profiles) => ({ id: formatId, deleted: true, profilesUpdatedAt: profiles.updatedAt });
    });
    return result(`Deleted Episode Format ${formatId}.`, data);
  });

  tool("add_knowledge", {
    title: "Add knowledge base",
    description: "Save a Markdown knowledge base (name must end in .md, at most 3 MiB) for plans and episodes to use as source.",
    inputSchema: { name: z.string().describe("File name ending in .md."), content: z.string() },
    annotations: write(),
  }, async (input) => {
    const item = await serializeMutation(context, () => addKnowledgeBase(paths, input));
    return result(`Added knowledge base "${item.name}" (${item.id}), ${item.characters} characters.`, { knowledgeBase: item });
  });

  tool("get_knowledge", {
    title: "Read knowledge base",
    description: "Read a knowledge base's Markdown, in pages. Continue with offset = nextOffset until nextOffset is null.",
    inputSchema: {
      id: id("Knowledge base"),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100_000).default(20_000),
    },
    annotations: READ,
  }, async ({ id: knowledgeId, offset, limit }) => {
    const data = await readKnowledgeBase(paths, knowledgeId, { offset, limit });
    return { content: [{ type: "text", text: `Knowledge base "${data.name}" characters ${data.offset}-${data.offset + data.content.length} of ${data.characters}${data.nextOffset == null ? "" : `; next offset ${data.nextOffset}`}.\n\n${data.content}` }], structuredContent: data };
  });

  tool("delete_knowledge", {
    title: "Delete knowledge base",
    description: "Delete a knowledge base. Plans and episodes that use it keep working without a source.",
    inputSchema: { id: id("Knowledge base") },
    annotations: write({ destructive: true, idempotent: true }),
  }, async ({ id: knowledgeId }) => {
    const data = await serializeMutation(context, () => removeKnowledgeBase(context, knowledgeId));
    return result(`Deleted knowledge base ${knowledgeId}.`, data);
  });

  tool("save_plan", {
    title: "Save content plan",
    description: "Create (no id) or update (id) a content plan, including the planned episode list you wrote. `episodes` replaces the whole list in order (numbers from 1); give an existing planned episode's id to keep it. If the plan has no episodeFormatId, give episodeFormat {name, description} to create one. Fields you omit keep their saved values.",
    inputSchema: {
      id: id("Plan").optional(),
      expectedUpdatedAt: z.string().optional(),
      name: z.string().optional(),
      knowledgeBaseId: z.string().optional(),
      speakerProfileId: z.string().optional(),
      episodeFormatId: z.string().optional(),
      language: z.string().optional(),
      targetMinutes: z.number().int().optional(),
      theme: z.string().optional(),
      audience: z.string().optional(),
      goal: z.string().optional(),
      episodeCount: z.number().int().nullable().optional(),
      episodes: z.array(plannedEpisodeSchema).optional(),
      episodeFormat: z.object({ name: z.string(), description: z.string() }).optional(),
    },
    annotations: write(),
  }, async (input) => {
    const data = await serializeMutation(context, () => saveAgentPlan(context, input));
    return result(`Saved plan "${data.plan.name}" (${data.plan.id}) with ${data.plan.episodes.length} planned episodes.`, data);
  });

  tool("get_plan", {
    title: "Get content plan",
    description: "A content plan with its planned episodes.",
    inputSchema: { id: id("Plan") },
    annotations: READ,
  }, async ({ id: planId }) => {
    const plan = await loadPlan(paths, planId);
    return result(`Plan "${plan.name}" (${plan.id}): ${plan.episodes.length} planned episodes.`, { plan });
  });

  tool("delete_plan", {
    title: "Delete content plan",
    description: "Delete a content plan. Episodes created from it stay.",
    inputSchema: { id: id("Plan") },
    annotations: write({ destructive: true, idempotent: true }),
  }, async ({ id: planId }) => {
    const data = await serializeMutation(context, () => deletePlan(context, planId));
    return result(`Deleted plan ${planId}.`, data);
  });

  tool("create_episodes", {
    title: "Create episodes",
    description: "Create episode drafts from planned episodes (planId + plannedEpisodeIds), or one ad-hoc episode (name + episodeProfileId). Write the script next with get_script_rules and save_script.",
    inputSchema: {
      planId: id("Plan").optional(),
      plannedEpisodeIds: z.array(z.string()).optional(),
      name: z.string().optional(),
      episodeProfileId: z.string().optional(),
      speakerProfileId: z.string().optional(),
      knowledgeBaseId: z.string().optional(),
      additionalInstructions: z.string().optional(),
      transcriptPromptGuidance: z.string().optional(),
    },
    annotations: write(),
  }, async ({ planId, plannedEpisodeIds, ...body }) => {
    const data = planId
      ? await serializeMutation(context, () => createPlanEpisodes(context, planId, plannedEpisodeIds))
      : await serializeMutation(context, async () => {
        const saved = await saveEpisodeFromBody(paths, body);
        return { episodes: [saved.episode], warning: saved.warning };
      });
    return result(`Created ${data.episodes.length} episodes: ${data.episodes.map((episode) => `"${episode.name}" (${episode.id})`).join(", ") || "none (already created)"}.`, data);
  });

  tool("get_episode", {
    title: "Get episode",
    description: "An episode with its script, status, render job, and audio URL.",
    inputSchema: { id: id("Episode") },
    annotations: READ,
    _meta: widget(EPISODE_WIDGET_URI),
  }, async ({ id: episodeId }) => {
    const data = await episodeView(context, origin, episodeId);
    return result(episodeSummary(data), data);
  });

  tool("get_script_rules", {
    title: "Get script rules",
    description: "Everything needed to write a valid script for an episode: exact speaker names, segment limit, word targets, language, the locked TTS cue rules, per-speaker cue capability, allowed tags, source, and the Markdown format. Call before save_script.",
    inputSchema: { episodeId: id("Episode") },
    annotations: READ,
  }, async ({ episodeId }) => {
    await awaitLatestModelCatalog(context);
    const episode = await loadEpisode(paths, episodeId, false);
    const { episodeProfile, speakerProfile } = await resolveEpisodeProfiles(paths, episode);
    const language = resolveLanguage(context, episodeProfile.language);
    const prompt = await resolveTranscriptPrompt(context, { episodeId, guidance: episode.transcriptPromptGuidance || "" });
    const knowledge = episode.knowledgeBaseId ? (await readJson(paths.knowledgeIndex)).find((item) => item.id === episode.knowledgeBaseId) || null : null;
    const names = speakerProfile.speakers.map((speaker) => speaker.name);
    const data = {
      episodeId,
      episodeName: episode.name,
      language: { id: language.id, name: language.name, defaultAccent: language.defaultAccent },
      speakerNames: names,
      speakerRule: transcriptSpeakerRule(names),
      maxSegments: episodeProfile.numSegments,
      targetMinutes: episodeProfile.targetMinutes,
      words: {
        target: episodeProfile.targetMinutes * TRANSCRIPT_TARGET_WORDS_PER_MINUTE,
        minimum: Math.round(episodeProfile.targetMinutes * TRANSCRIPT_MINIMUM_WORDS_PER_MINUTE),
        perMinute: { target: TRANSCRIPT_TARGET_WORDS_PER_MINUTE, minimum: TRANSCRIPT_MINIMUM_WORDS_PER_MINUTE },
      },
      speakers: prompt.capabilities.map((capability) => ({ ...capability, ...ttsCueCapability(context, capability.model, language), allowedTags: capability.provider === "chatterbox" && capability.cueMode === "tags" ? CHATTERBOX_TAGS : null })),
      lockedPrompt: prompt.lockedPrompt,
      customGuidance: prompt.customGuidance,
      effectivePrompt: prompt.effectivePrompt,
      docs: prompt.docs,
      knowledgeBase: knowledge,
      episode: { additionalInstructions: episode.additionalInstructions || "", transcriptPromptGuidance: episode.transcriptPromptGuidance || "" },
      format: { id: episodeProfile.id, name: episodeProfile.name, description: episodeProfile.description || "" },
      host: { id: speakerProfile.id, name: speakerProfile.name, description: speakerProfile.description || "", instructions: speakerProfile.instructions || "", speakers: speakerProfile.speakers.map(({ name, backstory, personality, style, accent }) => ({ name, backstory, personality, style, accent: accent || "" })) },
      markdownFormat: MARKDOWN_FORMAT,
    };
    return result(`Script rules for "${episode.name}": speakers ${names.join(", ")}; at most ${data.maxSegments} segments; about ${data.words.target} words (minimum ${data.words.minimum}) in ${language.name}.`, data);
  });

  tool("save_script", {
    title: "Save script",
    description: "Validate and save an episode's Markdown script (speaker names, segment limit, and per-model TTS cues). Warns when the script is shorter than the minimum words. An episode still named \"New episode\" takes the script's \"# Title\". render: true also queues TTS rendering.",
    inputSchema: { episodeId: id("Episode"), script: z.string(), render: z.boolean().optional() },
    annotations: write({ idempotent: true, openWorld: true }),
    _meta: widget(EPISODE_WIDGET_URI),
  }, async ({ episodeId, script, render }) => {
    const saved = await serializeWithLatestModelCatalog(context, () => saveTranscript(context, episodeId, script, { renameFromTitle: true }));
    const { episodeProfile } = await resolveEpisodeProfiles(paths, saved);
    const warnings = [saved.warning, transcriptLengthWarning(saved.transcriptWords, episodeProfile.targetMinutes)].filter(Boolean);
    let job = null;
    if (render) {
      await ensureFfmpeg(context);
      job = await serializeWithLatestModelCatalog(context, () => enqueueTts(context, episodeId));
    }
    const data = await episodeView(context, origin, episodeId, { warnings, job });
    return result(`Saved script for "${data.episode.name}": ${saved.transcriptWords} words.${warnings.length ? ` Warnings: ${warnings.join(" ")}` : ""}${job ? ` Render job ${job.id} queued.` : ""}`, data);
  });

  tool("render_audio", {
    title: "Render audio",
    description: "Queue TTS rendering of the saved script into an MP3. Follow progress with get_job or get_episode.",
    inputSchema: { episodeId: id("Episode") },
    annotations: write({ openWorld: true }),
    _meta: widget(EPISODE_WIDGET_URI),
  }, async ({ episodeId }) => {
    await ensureFfmpeg(context);
    const job = await serializeWithLatestModelCatalog(context, () => enqueueTts(context, episodeId));
    const data = await episodeView(context, origin, episodeId, { job });
    return result(`Render job ${job.id} queued for "${data.episode.name}" (${job.total} turns).`, data);
  });

  tool("get_job", {
    title: "Get job",
    description: "Status and progress of a render job.",
    inputSchema: { jobId: id("Job") },
    annotations: READ,
  }, async ({ jobId }) => {
    const { jobs } = await listJobs(context);
    let job = jobs.find((item) => item.id === jobId);
    if (!job) {
      const episode = (await listEpisodes(paths)).find((item) => item.job?.id === jobId);
      if (episode) job = { ...episode.job, episodeName: episode.name };
    }
    if (!job) throw notFound("Job not found.");
    return result(`Job ${job.id}: ${job.status} (${job.completed ?? 0}/${job.total ?? 0}) ${job.message || ""}`.trim(), { job });
  });

  tool("list_jobs", {
    title: "List jobs",
    description: "Recent render jobs, newest first, and the active job ID.",
    inputSchema: {},
    annotations: READ,
  }, async () => {
    const data = await listJobs(context);
    return result(`${data.jobs.length} recent jobs${data.activeJobId ? `; active ${data.activeJobId}` : ""}.`, data);
  });

  tool("preview_voice", {
    title: "Preview voice",
    description: "Synthesize up to 600 characters for one speaker (speakerIndex) of a host profile with a format's language, or of an episode's saved hosts. Saves a WAV served by apupod and returns its URL and duration.",
    inputSchema: {
      text: z.string(),
      speakerIndex: z.number().int().min(0).max(3).default(0),
      speakerProfileId: z.string().optional(),
      episodeProfileId: z.string().optional(),
      episodeId: id("Episode").optional(),
      cue: z.string().optional().describe("Delivery direction, default \"warm and conversational\"."),
    },
    annotations: write({ openWorld: true }),
  }, async (input) => {
    await awaitLatestModelCatalog(context);
    const bytes = await previewVoiceAudio(context, input);
    const name = await savePreview(context, bytes);
    const data = { url: `${origin}/previews/${name}.wav`, durationSeconds: wavSeconds(bytes), bytes: bytes.length };
    return result(`Preview ready: ${data.url} (${data.durationSeconds} s).`, data);
  });

  tool("rename_episode", {
    title: "Rename episode",
    description: "Rename an episode.",
    inputSchema: { id: id("Episode"), name: z.string() },
    annotations: write({ idempotent: true }),
  }, async ({ id: episodeId, name }) => {
    const { transcript, ...episode } = await serializeMutation(context, () => renameEpisode(paths, episodeId, name));
    return result(`Renamed episode ${episodeId} to "${episode.name}".`, { episode });
  });

  tool("delete_episode", {
    title: "Delete episode",
    description: "Delete an episode with its script and audio. Plans drop their link to it.",
    inputSchema: { id: id("Episode") },
    annotations: write({ destructive: true, idempotent: true }),
  }, async ({ id: episodeId }) => {
    const data = await serializeMutation(context, () => deleteEpisode(context, episodeId));
    return result(`Deleted episode ${episodeId}.`, data);
  });

  tool("jev_decide", {
    title: "Jev decision check",
    description: "Optional TypeSafe Jev check: Jev reads the user's request and picks the route (plan, hosts, format, episode, next step, question) and configuration values (language, host profile, TTS model, per-speaker voice, delivery preset, ...) only from options in the live workspace. Give `proposal` ({[route]: value}) to lock your proposed value to Jev's choices. Without TYPESAFE_API_KEY it returns status \"unavailable\"; continue without it. Nothing is saved.",
    inputSchema: {
      request: z.string().min(1).max(20_000).describe("The user's request text."),
      fields: z.array(z.string()).optional().describe("Field IDs Jev may decide (e.g. language, voiceModel, speakers.0.voiceId); others keep their values."),
      planId: id("Plan").optional(),
      episodeId: id("Episode").optional(),
      focus: z.object({ view: z.enum(["speakers", "format"]).optional(), speakerProfileId: z.string().optional(), episodeProfileId: z.string().optional() }).optional(),
      proposal: z.record(z.string(), z.unknown()).optional(),
    },
    annotations: { ...READ, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    const data = await jevDecide(context, input);
    return result(`Jev: ${data.status}${data.reason ? `. ${data.reason}` : ""}`, data);
  });

  return server;
}
