import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  rm,
} from "node:fs/promises";
import { JEV_MODEL } from "./jev.mjs";
import { DECISIONS_MODEL } from "./decisions.mjs";
import { badRequest, conflict, normalizeUrl, validateId } from "./util.mjs";
import { DEFAULT_MIMO_BASE_URL, DEFAULT_OPENAI_BASE_URL, openCodeGoProtocol, resolveOpenCodeGoCredential, parseCompatibleModelId, builtInConnectionId } from "./providers/catalog.mjs";
import { listPlans, loadPlan, listEpisodes, readJson, writeJsonAtomic, writeTextAtomic, exists, listChatThreads } from "./store.mjs";

const ENV_FILE_MODE = 0o600;
export function defaultConfig() {
  return normalizeConfig({ providers: { mimo: { baseUrl: process.env.MIMO_BASE_URL } } });
}

export async function readConfig(paths) {
  return normalizeConfig(await readJson(paths.config));
}

function normalizeConfig(value) {
  const raw = value && typeof value === "object" ? value : {};
  const providers = raw.providers && typeof raw.providers === "object" ? raw.providers : {};
  return {
    providers: {
      mimo: {
        baseUrl: normalizeUrl(providers.mimo?.baseUrl || DEFAULT_MIMO_BASE_URL) || DEFAULT_MIMO_BASE_URL,
        enabled: providers.mimo?.enabled !== false,
        activeModels: normalizeCapabilityMap(providers.mimo?.activeModels),
      },
      elevenlabs: {
        enabled: providers.elevenlabs?.enabled !== false,
        activeModels: normalizeCapabilityMap(providers.elevenlabs?.activeModels),
      },
      openai: {
        baseUrl: normalizeUrl(providers.openai?.baseUrl || DEFAULT_OPENAI_BASE_URL) || DEFAULT_OPENAI_BASE_URL,
        llmBaseUrl: normalizeUrl(providers.openai?.llmBaseUrl || ""),
        ttsBaseUrl: normalizeUrl(providers.openai?.ttsBaseUrl || ""),
        modelsUrl: normalizeUrl(providers.openai?.modelsUrl || ""),
        enabled: providers.openai?.enabled !== false,
        activeModels: normalizeCapabilityMap(providers.openai?.activeModels || providers.openai?.modelCapabilities),
      },
      chatgpt: { enabled: providers.chatgpt?.enabled === true, activeModels: normalizeTextCapabilityMap(providers.chatgpt?.activeModels) },
      anthropic: { enabled: providers.anthropic?.enabled !== false, activeModels: normalizeTextCapabilityMap(providers.anthropic?.activeModels) },
      opencodeGo: {
        enabled: providers.opencodeGo?.enabled !== false,
        activeModels: normalizeOpenCodeGoCapabilityMap(providers.opencodeGo?.activeModels),
      },
      chatterbox: {
        baseUrl: normalizeUrl(providers.chatterbox?.baseUrl || ""),
        modelsUrl: normalizeUrl(providers.chatterbox?.modelsUrl || ""),
        enabled: providers.chatterbox?.enabled === true,
        activeModels: normalizeCapabilityMap(providers.chatterbox?.activeModels),
      },
    },
    compatibleConnections: Array.isArray(raw.compatibleConnections)
      ? raw.compatibleConnections.map((connection) => normalizeCompatibleConnection(connection))
      : [],
    assistantDecision: { enabled: raw.assistantDecision?.enabled === true && [undefined, "typesafe", "openai"].includes(raw.assistantDecision?.provider),
      provider: raw.assistantDecision?.provider === "openai" ? "openai" : "typesafe", model: raw.assistantDecision?.provider === "openai" ? DECISIONS_MODEL : JEV_MODEL },
  };
}

function normalizeCompatibleConnection(value) {
  const raw = value && typeof value === "object" ? value : {};
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : randomUUID();
  return {
    id,
    name: typeof raw.name === "string" ? raw.name : "OpenAI-compatible",
    baseUrl: normalizeUrl(raw.baseUrl || ""),
    llmBaseUrl: normalizeUrl(raw.llmBaseUrl || ""),
    ttsBaseUrl: normalizeUrl(raw.ttsBaseUrl || ""),
    modelsUrl: normalizeUrl(raw.modelsUrl || ""),
    apiKeyEnv: typeof raw.apiKeyEnv === "string" && raw.apiKeyEnv.trim() ? raw.apiKeyEnv.trim() : compatibleApiKeyEnv(id, raw.name || "connection"),
    enabled: raw.enabled !== false,
    activeModels: normalizeCapabilityMap(raw.activeModels || raw.modelCapabilities),
  };
}

function normalizeCapabilityMap(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).map(([key, capability]) => [key, {
    text: Boolean(capability?.text),
    tts: Boolean(capability?.tts),
  }]));
}

function normalizeTextCapabilityMap(value) {
  return Object.fromEntries(Object.entries(normalizeCapabilityMap(value)).map(([id, capability]) => [id, { text: capability.text, tts: false }]));
}

function normalizeOpenCodeGoCapabilityMap(value) {
  return Object.fromEntries(Object.entries(normalizeCapabilityMap(value)).filter(([id]) => openCodeGoProtocol(id)).map(([id, capability]) => [id, {
    text: capability.text,
    tts: false,
  }]));
}

// A Map, not an object: a custom connection id such as "__proto__" must not resolve to a prototype key.
const BUILT_IN_PROVIDER_KEYS = new Map([["openai", "openai"], ["chatgpt", "chatgpt"], ["anthropic", "anthropic"], ["opencode-go", "opencodeGo"], ["chatterbox", "chatterbox"]]);

function connectionProviderConfig(config, connectionId) {
  const key = BUILT_IN_PROVIDER_KEYS.get(builtInConnectionId(config, connectionId));
  return key ? config.providers[key] : config.compatibleConnections.find((connection) => connection.id === connectionId);
}

export function activateReferencedModels(config, profiles) {
  let changed = false;
  const activate = (target, modelId, type) => {
    if (!modelId) return;
    const current = target[modelId] || { text: false, tts: false };
    if (current[type]) return;
    target[modelId] = { ...current, [type]: true };
    changed = true;
  };
  const activateComposite = (modelId, type) => {
    const parsed = parseCompatibleModelId(modelId);
    if (!parsed) return false;
    const builtInId = builtInConnectionId(config, parsed.connectionId);
    if (builtInId === "opencode-go" && (type !== "text" || !openCodeGoProtocol(parsed.modelId))) return true;
    const target = ["chatgpt", "anthropic"].includes(builtInId) && type !== "text" ? null : connectionProviderConfig(config, parsed.connectionId)?.activeModels;
    if (target) activate(target, parsed.modelId, type);
    return true;
  };
  for (const profile of profiles.speakerProfiles || []) {
    for (const modelId of [profile.voiceModel, ...(profile.speakers || []).map((speaker) => speaker.ttsModelOverride)].filter(Boolean)) {
      if (!activateComposite(modelId, "tts")) activate(modelId === "mimo-v2.5-tts" ? config.providers.mimo.activeModels : config.providers.elevenlabs.activeModels, modelId, "tts");
    }
  }
  for (const profile of profiles.episodeProfiles || []) {
    for (const modelId of [profile.outlineModel, profile.transcriptModel].filter(Boolean)) {
      if (!activateComposite(modelId, "text")) activate(config.providers.mimo.activeModels, modelId, "text");
    }
  }
  return changed;
}

export async function redactConfig(config) {
  const openCodeGoCredential = await resolveOpenCodeGoCredential();
  return {
    providers: {
      mimo: {
        ...config.providers.mimo,
        hasApiKey: Boolean(process.env.MIMO_API_KEY?.trim()),
      },
      elevenlabs: {
        ...config.providers.elevenlabs,
        hasApiKey: Boolean(process.env.ELEVENLABS_API_KEY?.trim()),
      },
      openai: {
        ...config.providers.openai,
        hasApiKey: Boolean(process.env.OPENAI_API_KEY?.trim()),
      },
      chatgpt: { ...config.providers.chatgpt },
      anthropic: { ...config.providers.anthropic, hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY?.trim()) },
      opencodeGo: {
        ...config.providers.opencodeGo,
        hasApiKey: Boolean(openCodeGoCredential.key),
        credentialSource: openCodeGoCredential.source,
      },
      chatterbox: {
        ...config.providers.chatterbox,
        hasApiKey: Boolean(process.env.CHATTERBOX_API_KEY?.trim()),
      },
    },
    compatibleConnections: config.compatibleConnections.map((connection) => ({
      ...connection,
      hasApiKey: Boolean(process.env[connection.apiKeyEnv]?.trim()),
    })),
    assistantDecision: { ...config.assistantDecision, hasApiKey: Boolean(process.env.TYPESAFE_API_KEY?.trim()), hasOpenAiApiKey: Boolean(process.env.OPENAI_API_KEY?.trim()) },
  };
}

export async function saveConfigRequest(context, value) {
  const next = validateConfigPayload(value, context.config);
  const dependents = await loadModelDependents(context.paths);
  assertConnectionsCanBeRemoved(context.config, next.config, dependents);
  const warnings = inactiveModelWarnings(context.config, next.config, dependents);
  const retainedIds = new Set(next.config.compatibleConnections.map((connection) => connection.id));
  for (const connection of context.config.compatibleConnections) {
    if (!retainedIds.has(connection.id)) next.envPatch[connection.apiKeyEnv] = null;
  }
  let previousEnvFile;
  if (Object.keys(next.envPatch).length) {
    previousEnvFile = await exists(context.paths.env) ? await readFile(context.paths.env, "utf8") : null;
    await updateEnvFile(context.paths.env, next.envPatch);
  }
  try {
    await writeJsonAtomic(context.paths.config, next.config);
  } catch (error) {
    if (previousEnvFile !== undefined) {
      if (previousEnvFile == null) await rm(context.paths.env, { force: true });
      else await writeTextAtomic(context.paths.env, previousEnvFile, ENV_FILE_MODE);
    }
    throw error;
  }
  for (const [key, envValue] of Object.entries(next.envPatch)) {
    if (envValue == null) delete process.env[key];
    else process.env[key] = envValue;
  }
  context.config = next.config;
  return { config: await redactConfig(context.config), warnings };
}

function validateConfigPayload(value, current) {
  const body = value && typeof value === "object" ? value : {};
  const providers = body.providers && typeof body.providers === "object" ? body.providers : {};
  const envPatch = {};
  const mimoInput = providers.mimo && typeof providers.mimo === "object" ? providers.mimo : {};
  const mimoBaseUrl = requireUrl(mimoInput.baseUrl || current.providers.mimo.baseUrl, "MiMo base URL");
  applyApiKeyPatch(envPatch, "MIMO_API_KEY", mimoInput, "MiMo");
  envPatch.MIMO_BASE_URL = mimoBaseUrl;
  const elevenInput = providers.elevenlabs && typeof providers.elevenlabs === "object" ? providers.elevenlabs : {};
  applyApiKeyPatch(envPatch, "ELEVENLABS_API_KEY", elevenInput, "ElevenLabs");
  const mimo = {
    baseUrl: mimoBaseUrl,
    enabled: Object.hasOwn(mimoInput, "enabled") ? mimoInput.enabled !== false : current.providers.mimo.enabled !== false,
    activeModels: normalizeCapabilityMap(mimoInput.activeModels ?? current.providers.mimo.activeModels),
  };
  const elevenlabs = {
    enabled: Object.hasOwn(elevenInput, "enabled") ? elevenInput.enabled !== false : current.providers.elevenlabs.enabled !== false,
    activeModels: normalizeCapabilityMap(elevenInput.activeModels ?? current.providers.elevenlabs.activeModels),
  };
  const openaiInput = providers.openai && typeof providers.openai === "object" ? providers.openai : {};
  const currentOpenai = current.providers.openai;
  const openai = {
    baseUrl: requireUrl(openaiInput.baseUrl || currentOpenai.baseUrl, "OpenAI base URL"),
    llmBaseUrl: optionalUrl(openaiInput.llmBaseUrl ?? currentOpenai.llmBaseUrl, "OpenAI LLM base URL"),
    ttsBaseUrl: optionalUrl(openaiInput.ttsBaseUrl ?? currentOpenai.ttsBaseUrl, "OpenAI TTS base URL"),
    modelsUrl: optionalUrl(openaiInput.modelsUrl ?? currentOpenai.modelsUrl, "OpenAI models URL"),
    enabled: Object.hasOwn(openaiInput, "enabled") ? openaiInput.enabled !== false : currentOpenai.enabled !== false,
    activeModels: normalizeCapabilityMap(openaiInput.activeModels ?? currentOpenai.activeModels),
  };
  applyApiKeyPatch(envPatch, "OPENAI_API_KEY", openaiInput, "OpenAI");
  const chatGptInput = providers.chatgpt || {};
  const chatgpt = { enabled: Object.hasOwn(chatGptInput, "enabled") ? chatGptInput.enabled === true : current.providers.chatgpt.enabled,
    activeModels: normalizeTextCapabilityMap(chatGptInput.activeModels ?? current.providers.chatgpt.activeModels) };
  const anthropicInput = providers.anthropic && typeof providers.anthropic === "object" ? providers.anthropic : {};
  const anthropic = { enabled: Object.hasOwn(anthropicInput, "enabled") ? anthropicInput.enabled !== false : current.providers.anthropic.enabled !== false,
    activeModels: normalizeTextCapabilityMap(anthropicInput.activeModels ?? current.providers.anthropic.activeModels) };
  applyApiKeyPatch(envPatch, "ANTHROPIC_API_KEY", anthropicInput, "Anthropic");
  const decisionInput = body.assistantDecision || {};
  const decisionProvider = decisionInput.provider ?? current.assistantDecision.provider ?? "typesafe";
  if (!["typesafe", "openai"].includes(decisionProvider)) throw badRequest("Unsupported assistant decision provider.");
  const assistantDecision = { enabled: Object.hasOwn(decisionInput, "enabled") ? decisionInput.enabled === true : current.assistantDecision.enabled,
    provider: decisionProvider, model: decisionProvider === "openai" ? DECISIONS_MODEL : JEV_MODEL };
  // This field always means the TypeSafe key. The OpenAI card owns OPENAI_API_KEY.
  applyApiKeyPatch(envPatch, "TYPESAFE_API_KEY", decisionInput, "Jev");
  const openCodeGoInput = providers.opencodeGo && typeof providers.opencodeGo === "object" ? providers.opencodeGo : {};
  const currentOpenCodeGo = current.providers.opencodeGo;
  const opencodeGo = {
    enabled: Object.hasOwn(openCodeGoInput, "enabled") ? openCodeGoInput.enabled !== false : currentOpenCodeGo.enabled !== false,
    activeModels: normalizeOpenCodeGoCapabilityMap(openCodeGoInput.activeModels ?? currentOpenCodeGo.activeModels),
  };
  const chatterboxInput = providers.chatterbox && typeof providers.chatterbox === "object" ? providers.chatterbox : {};
  const currentChatterbox = current.providers.chatterbox;
  const chatterboxEnabled = Object.hasOwn(chatterboxInput, "enabled") ? chatterboxInput.enabled === true : currentChatterbox.enabled === true;
  const chatterbox = {
    baseUrl: chatterboxEnabled ? requireUrl(chatterboxInput.baseUrl || currentChatterbox.baseUrl, "Chatterbox base URL") : optionalUrl(chatterboxInput.baseUrl ?? currentChatterbox.baseUrl, "Chatterbox base URL"),
    modelsUrl: optionalUrl(chatterboxInput.modelsUrl ?? currentChatterbox.modelsUrl, "Chatterbox models URL"),
    enabled: chatterboxEnabled,
    activeModels: normalizeCapabilityMap(chatterboxInput.activeModels ?? currentChatterbox.activeModels),
  };
  applyApiKeyPatch(envPatch, "CHATTERBOX_API_KEY", chatterboxInput, "Chatterbox");

  const currentById = new Map(current.compatibleConnections.map((connection) => [connection.id, connection]));
  const compatibleConnections = Array.isArray(body.compatibleConnections) ? body.compatibleConnections.map((item) => {
    const existing = currentById.get(item.id);
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : randomUUID();
    validateId(id, "Compatible connection");
    if (!existing && ["chatgpt", "anthropic", "openai", "opencode-go", "chatterbox"].includes(id)) throw badRequest(`Compatible connection ID "${id}" is reserved for a built-in provider.`);
    const name = String(item.name || "").trim();
    if (!name) throw badRequest("Compatible connection name is required.");
    const connection = {
      id,
      name,
      baseUrl: requireUrl(item.baseUrl, `${name} base URL`),
      llmBaseUrl: optionalUrl(item.llmBaseUrl, `${name} LLM base URL`),
      ttsBaseUrl: optionalUrl(item.ttsBaseUrl, `${name} TTS base URL`),
      modelsUrl: optionalUrl(item.modelsUrl, `${name} models URL`),
      apiKeyEnv: existing?.apiKeyEnv || compatibleApiKeyEnv(id, name),
      enabled: item.enabled !== false,
      activeModels: normalizeCapabilityMap(item.activeModels),
    };
    applyApiKeyPatch(envPatch, connection.apiKeyEnv, item, name);
    return connection;
  }) : [];

  const ids = new Set();
  for (const connection of compatibleConnections) {
    if (ids.has(connection.id)) throw badRequest(`Duplicate compatible connection ID "${connection.id}".`);
    ids.add(connection.id);
  }

  return {
    config: {
      providers: { mimo, elevenlabs, openai, chatgpt, anthropic, opencodeGo, chatterbox },
      compatibleConnections,
      assistantDecision,
    },
    envPatch,
  };
}

function applyApiKeyPatch(patch, key, input, label) {
  const replacement = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (input.clearApiKey === true && replacement) throw badRequest(`${label} API key cannot be replaced and cleared together.`);
  if (input.clearApiKey === true) patch[key] = null;
  else if (replacement) patch[key] = replacement;
}

function requireUrl(value, label) {
  const url = normalizeUrl(value);
  if (!url) throw badRequest(`${label} is required.`);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest(`${label} must be a valid URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw badRequest(`${label} must use http or https.`);
  return url;
}

function optionalUrl(value, label) {
  const url = normalizeUrl(value);
  return url ? requireUrl(url, label) : "";
}

function compatibleApiKeyEnv(id, name) {
  const suffix = createHash("sha256").update(String(id)).digest("hex").slice(0, 12).toUpperCase();
  return `OPENAI_COMPAT_${slugEnv(name) || "CONNECTION"}_${suffix}_API_KEY`;
}

function slugEnv(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20);
}

async function updateEnvFile(path, patch) {
  const current = await exists(path) ? await readFile(path, "utf8") : "";
  const lines = current ? current.split(/\r?\n/) : [];
  const seen = new Set();
  const updated = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || !(match[1] in patch)) return line;
    seen.add(match[1]);
    if (patch[match[1]] == null) return null;
    return `${match[1]}=${encodeEnvValue(patch[match[1]])}`;
  });
  for (const [key, envValue] of Object.entries(patch)) {
    if (!seen.has(key) && envValue != null) updated.push(`${key}=${encodeEnvValue(envValue)}`);
  }
  await writeTextAtomic(path, `${updated.filter((line, index, all) => line != null && !(line === "" && index === all.length - 1)).join("\n")}\n`, ENV_FILE_MODE);
}

function assertConnectionsCanBeRemoved(current, next, dependents) {
  const retained = new Set(next.compatibleConnections.map((connection) => connection.id));
  const removed = current.compatibleConnections.filter((connection) => !retained.has(connection.id));
  if (removed.length === 0) return;
  if (dependents.corrupt.length) throw conflict("Cannot remove connections while a corrupt episode may reference them.");
  for (const connection of removed) {
    const prefix = `compat:${connection.id}:`;
    const owners = [...new Set(dependents.references.filter((reference) => reference.modelId.startsWith(prefix)).map((reference) => reference.owner))];
    if (owners.length) throw conflict(`Cannot remove ${connection.name}; used by ${owners.join(", ")}.`);
  }
}

function inactiveModelWarnings(current, config, dependents) {
  const inactive = new Map();
  for (const reference of dependents.references) {
    if (!reference.modelId || modelIsActive(config, reference.modelId, reference.type)) continue;
    const key = `${reference.type}:${reference.modelId}`;
    if (!inactive.has(key)) inactive.set(key, { ...reference, owners: new Set() });
    inactive.get(key).owners.add(reference.owner);
  }
  const warnings = [...inactive.values()].map((reference) => `${reference.type === "text" ? "Text" : "TTS"} model "${reference.modelId}" is inactive but used by ${[...reference.owners].join(", ")}.`);
  if (dependents.corrupt.length && disablesCapabilities(current, config)) warnings.push("Providers or models were disabled while corrupt episodes may still reference them.");
  return warnings;
}

function modelIsActive(config, modelId, type) {
  const parsed = parseCompatibleModelId(modelId);
  const rawId = parsed?.modelId || modelId;
  const provider = parsed
    ? connectionProviderConfig(config, parsed.connectionId)
    : type === "text" || modelId === "mimo-v2.5-tts"
      ? config.providers.mimo
      : config.providers.elevenlabs;
  return Boolean(provider?.enabled && provider.activeModels?.[rawId]?.[type]);
}

async function loadModelDependents(paths) {
  const profiles = await readJson(paths.profiles);
  const references = [];
  collectModelReferences(profiles, (kind, name) => `${kind} profile "${name}"`, references);
  for (const entry of await listPlans(paths)) {
    const plan = await loadPlan(paths, entry.id);
    if (plan.planningModel) references.push({ modelId: plan.planningModel, type: "text", owner: `content plan "${plan.name}"` });
  }
  for (const thread of await listChatThreads(paths)) {
    if (thread.lastModel) references.push({ modelId: thread.lastModel, type: "text", owner: `assistant chat "${thread.title}"` });
  }
  const corrupt = [];
  for (const episode of await listEpisodes(paths)) {
    if (episode.corrupt) {
      corrupt.push(episode);
      continue;
    }
    let episodeProfile = episode.episodeProfile;
    let speakerProfile = episode.speakerProfile;
    if (!episodeProfile || !speakerProfile) {
      episodeProfile = profiles.episodeProfiles.find((profile) => profile.id === episode.episodeProfileId);
      speakerProfile = profiles.speakerProfiles.find((profile) => profile.id === episodeProfile?.speakerProfileId);
    }
    collectModelReferences({
      speakerProfiles: speakerProfile ? [speakerProfile] : [],
      episodeProfiles: episodeProfile ? [episodeProfile] : [],
    }, () => `saved episode "${episode.name}"`, references);
  }
  return { references, corrupt };
}

export function collectModelReferences(profiles, ownerFor, references) {
  for (const profile of profiles.speakerProfiles || []) {
    const owner = ownerFor("speaker", profile.name);
    if (profile.voiceModel) references.push({ modelId: profile.voiceModel, type: "tts", owner });
    for (const speaker of profile.speakers || []) {
      if (speaker.ttsModelOverride) references.push({ modelId: speaker.ttsModelOverride, type: "tts", owner });
    }
  }
  for (const profile of profiles.episodeProfiles || []) {
    const owner = ownerFor("episode", profile.name);
    if (profile.outlineModel) references.push({ modelId: profile.outlineModel, type: "text", owner });
    if (profile.transcriptModel) references.push({ modelId: profile.transcriptModel, type: "text", owner });
  }
}

function disablesCapabilities(current, next) {
  const disabled = (before, after) => before?.enabled !== false && after?.enabled === false
    || Object.entries(before?.activeModels || {}).some(([id, capability]) =>
      capability.text && !after?.activeModels?.[id]?.text || capability.tts && !after?.activeModels?.[id]?.tts);
  if (["mimo", "elevenlabs", "openai", "chatgpt", "anthropic", "opencodeGo", "chatterbox"].some((id) => disabled(current.providers[id], next.providers[id]))) return true;
  const nextById = new Map(next.compatibleConnections.map((connection) => [connection.id, connection]));
  return current.compatibleConnections.some((connection) => !nextById.has(connection.id) || disabled(connection, nextById.get(connection.id)));
}

function encodeEnvValue(value) {
  const text = String(value ?? "");
  return /^[A-Za-z0-9_./:@\-]+$/.test(text) ? text : JSON.stringify(text);
}
