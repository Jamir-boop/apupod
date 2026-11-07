import { badRequest, normalizeUrl } from "../util.mjs";
import { MAX_JSON_RESPONSE_BYTES, MODEL_TIMEOUT_MS, fetchJson, cappedFetch, openAiClient, callOptions, sdkJson, providerError, redactSecrets } from "./transport.mjs";

export const DEFAULT_MIMO_BASE_URL = "https://api.xiaomimimo.com/v1";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

const ELEVENLABS_MODELS_URL = "https://api.elevenlabs.io/v1/models";

const OPENAI_COMPATIBLE_MODELS_URL = "/models";

const COMPAT_MODEL_RE = /^compat:([a-zA-Z0-9_-]+):(.+)$/;

export const MIMO_VOICES = ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"];
export const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"];
export const ELEVENLABS_MODELS = ["eleven_flash_v2_5", "eleven_multilingual_v2", "eleven_v3", "eleven_v4"];
export const TTS_MODELS = ["mimo-v2.5-tts", ...ELEVENLABS_MODELS];
export const LANGUAGE_OPTIONS = [
  ["en-US", "en", "English (United States)", "American"],
  ["ja-JP", "ja", "Japanese (Japan)", "Japanese"],
  ["zh-CN", "zh", "Chinese (Mainland)", "Mainland Mandarin"],
  ["de-DE", "de", "German (Germany)", "German"],
  ["hi-IN", "hi", "Hindi (India)", "Indian"],
  ["fr-FR", "fr", "French (France)", "Metropolitan French"],
  ["ko-KR", "ko", "Korean (South Korea)", "South Korean"],
  ["pt-BR", "pt", "Portuguese (Brazil)", "Brazilian"],
  ["it-IT", "it", "Italian (Italy)", "Italian"],
  ["es-419", "es", "Spanish (Latin America)", "Latin American"],
  ["id-ID", "id", "Indonesian (Indonesia)", "Indonesian"],
  ["nl-NL", "nl", "Dutch (Netherlands)", "Dutch"],
  ["tr-TR", "tr", "Turkish (Türkiye)", "Turkish"],
  ["fil-PH", "fil", "Filipino (Philippines)", "Filipino"],
  ["pl-PL", "pl", "Polish (Poland)", "Polish"],
  ["sv-SE", "sv", "Swedish (Sweden)", "Swedish"],
  ["bg-BG", "bg", "Bulgarian (Bulgaria)", "Bulgarian"],
  ["ro-RO", "ro", "Romanian (Romania)", "Romanian"],
  ["ar-SA", "ar", "Arabic (Saudi Arabia)", "Saudi Arabian"],
  ["cs-CZ", "cs", "Czech (Czechia)", "Czech"],
  ["el-GR", "el", "Greek (Greece)", "Greek"],
  ["fi-FI", "fi", "Finnish (Finland)", "Finnish"],
  ["hr-HR", "hr", "Croatian (Croatia)", "Croatian"],
  ["ms-MY", "ms", "Malay (Malaysia)", "Malaysian"],
  ["sk-SK", "sk", "Slovak (Slovakia)", "Slovak"],
  ["da-DK", "da", "Danish (Denmark)", "Danish"],
  ["ta-IN", "ta", "Tamil (India)", "Indian Tamil"],
  ["uk-UA", "uk", "Ukrainian (Ukraine)", "Ukrainian"],
  ["ru-RU", "ru", "Russian (Russia)", "Russian"],
  ["hu-HU", "hu", "Hungarian (Hungary)", "Hungarian"],
  ["no-NO", "no", "Norwegian (Norway)", "Norwegian"],
  ["vi-VN", "vi", "Vietnamese (Vietnam)", "Vietnamese"],
].map(([id, apiCode, name, defaultAccent]) => ({ id, apiCode, name, defaultAccent }));
const MIMO_LANGUAGE_CODES = new Set(["en", "zh"]);
const ELEVEN_LANGUAGE_CODES = new Map(`afr:af amh:am ara:ar hye:hy asm:as aze:az bel:be ben:bn bos:bs bul:bg mya:my cat:ca hrv:hr ces:cs dan:da nld:nl eng:en est:et fin:fi fra:fr ful:ff glg:gl kat:ka deu:de ell:el guj:gu hau:ha heb:he hin:hi hun:hu isl:is ind:id ita:it jpn:ja jav:jv kan:kn kaz:kk kor:ko kir:ky lao:lo lav:lv lin:ln lit:lt lug:lg ltz:lb mkd:mk msa:ms mal:ml mlt:mt cmn:zh zho:zh mri:mi mar:mr mon:mn nep:ne nob:no nor:no oci:oc ori:or pus:ps fas:fa pol:pl por:pt pan:pa ron:ro rus:ru srp:sr sna:sn snd:sd slk:sk slv:sl som:so spa:es swa:sw swe:sv tgk:tg tam:ta tel:te tha:th tur:tr ukr:uk urd:ur uzb:uz vie:vi cym:cy wol:wo zul:zu gle:ga nya:ny`.split(" ").map((pair) => pair.split(":")));

export function createModelCatalog(credentials = null) {
  const credential = (name) => credentials ? credentials[name] || "" : process.env[name]?.trim() || "";
  return {
    status: "loading",
    updatedAt: null,
    languages: structuredClone(LANGUAGE_OPTIONS),
    providers: {
      mimo: { configured: Boolean(credential("MIMO_API_KEY")), status: "loading", error: null, discoveredModels: [], ttsModels: [] },
      elevenlabs: { configured: Boolean(credential("ELEVENLABS_API_KEY")), status: "loading", error: null, discoveredModels: [], ttsModels: [] },
      openai: { id: "openai", name: "OpenAI", configured: Boolean(credential("OPENAI_API_KEY")), status: "loading", error: null, discoveredModels: [], ttsModels: [] },
      chatterbox: { id: "chatterbox", name: "Chatterbox", configured: false, status: "unconfigured", error: null, discoveredModels: [], ttsModels: [] },
      compatible: [],
    },
  };
}

async function modelDiscoverySnapshot(context) {
  const config = structuredClone(context.config);
  const names = new Set([
    "MIMO_API_KEY",
    "ELEVENLABS_API_KEY",
    "OPENAI_API_KEY",
    "CHATTERBOX_API_KEY",
    "TYPESAFE_API_KEY",
    ...config.compatibleConnections.map((connection) => connection.apiKeyEnv),
  ]);
  return { config, credentials: Object.fromEntries([...names].map((name) => [name, process.env[name]?.trim() || ""])) };
}

export function queueModelCatalogRefresh(context, { force = false } = {}) {
  if (!force && context.latestModelRefresh?.pending) return context.latestModelRefresh;
  const revision = context.latestModelRefreshRevision + 1;
  context.latestModelRefreshRevision = revision;
  const snapshot = modelDiscoverySnapshot(context);
  context.chatterboxVoiceCache.revision += 1;
  context.chatterboxVoiceCache.voices = null;
  context.modelCatalog = { ...structuredClone(context.modelCatalog), status: "loading" };
  const promise = context.modelRefreshTail
    .then(() => snapshot)
    .then((value) => buildModelCatalog(context.fetchImpl, value))
    .then((catalog) => {
      if (context.latestModelRefreshRevision === revision) context.modelCatalog = catalog;
      return catalog;
    });
  context.modelRefreshTail = promise.catch(() => {});
  const refresh = { revision, snapshot, promise, pending: true };
  context.latestModelRefresh = refresh;
  void promise.then(() => { refresh.pending = false; }, () => { refresh.pending = false; });
  return refresh;
}

export async function awaitLatestModelCatalog(context) {
  for (;;) {
    const latest = context.latestModelRefresh;
    if (!latest) return context.modelCatalog;
    const catalog = await latest.promise;
    if (latest === context.latestModelRefresh) return catalog;
  }
}

export async function modelRuntimeSnapshot(context) {
  for (;;) {
    const refresh = context.latestModelRefresh;
    if (!refresh) {
      const snapshot = await modelDiscoverySnapshot(context);
      return { ...snapshot, paths: context.paths, fetchImpl: context.fetchImpl, modelCatalog: structuredClone(context.modelCatalog), chatterboxVoiceCache: context.chatterboxVoiceCache };
    }
    const [snapshot, modelCatalog] = await Promise.all([refresh.snapshot, refresh.promise]);
    if (refresh === context.latestModelRefresh) {
      return { ...snapshot, paths: context.paths, fetchImpl: context.fetchImpl, modelCatalog: structuredClone(modelCatalog), chatterboxVoiceCache: context.chatterboxVoiceCache };
    }
  }
}

async function buildModelCatalog(fetchImpl, snapshot) {
  const catalog = createModelCatalog(snapshot.credentials);
  const context = { ...snapshot, fetchImpl, modelCatalog: catalog };
  const mimo = catalog.providers.mimo;
  const elevenlabs = catalog.providers.elevenlabs;
  const openai = catalog.providers.openai;
  const openaiConnection = builtInOpenAiConnection(context.config);
  const chatterbox = catalog.providers.chatterbox;
  const chatterboxConnection = builtInChatterboxConnection(context.config);
  const compatible = context.config.compatibleConnections.map((connection) => ({
    id: connection.id,
    name: connection.name,
    configured: Boolean(connection.enabled && connection.baseUrl),
    status: "loading",
    error: null,
    ttsModels: [],
    discoveredModels: [],
  }));
  catalog.providers.compatible = compatible;
  mimo.configured = Boolean(context.config.providers.mimo.enabled && context.credentials.MIMO_API_KEY);
  elevenlabs.configured = Boolean(context.config.providers.elevenlabs.enabled && context.credentials.ELEVENLABS_API_KEY);
  openai.configured = Boolean(openaiConnection.enabled && context.credentials.OPENAI_API_KEY && builtInConnectionId(context.config, "openai"));
  chatterbox.configured = Boolean(chatterboxConnection.enabled && chatterboxConnection.baseUrl && builtInConnectionId(context.config, "chatterbox"));
  for (const provider of [mimo, elevenlabs, openai, chatterbox, ...compatible]) {
    provider.status = provider.configured ? "loading" : "unconfigured";
    provider.error = provider.configured ? null : unconfiguredProviderMessage(context, provider);
  }
  for (const provider of [openai, chatterbox]) if (!builtInConnectionId(context.config, provider.id)) {
    provider.status = "error";
    provider.error = `A saved compatible connection uses the reserved ID "${provider.id}". Its references are preserved. Resolve this connection ID conflict before using built-in ${provider.name}.`;
  }

  await Promise.all([
    mimo.configured ? loadMimoModels(context).catch((error) => setProviderError(mimo, error)) : null,
    elevenlabs.configured ? loadElevenLabsModels(context).catch((error) => setProviderError(elevenlabs, error)) : null,
    openai.configured ? loadCompatibleModels(context, openaiConnection, openai).catch((error) => setProviderError(openai, error)) : null,
    chatterbox.configured ? loadCompatibleModels(context, chatterboxConnection, chatterbox).catch((error) => setProviderError(chatterbox, error)) : null,
    ...context.config.compatibleConnections.map((connection) => {
      const provider = compatible.find((item) => item.id === connection.id);
      return provider?.configured ? loadCompatibleModels(context, connection, provider).catch((error) => setProviderError(provider, error)) : null;
    }),
  ]);
  const configured = [mimo, elevenlabs, openai, chatterbox, ...compatible].filter((provider) => provider.configured);
  const ready = configured.filter((provider) => provider.status === "ready").length;
  mergeDiscoveredLanguages(catalog);
  catalog.status = configured.length === 0 ? "unconfigured" : ready === configured.length ? "ready" : ready > 0 ? "partial" : "error";
  catalog.updatedAt = new Date().toISOString();
  return catalog;
}

function unconfiguredProviderMessage(context, provider) {
  if (provider === context.modelCatalog.providers.mimo) return context.config.providers.mimo.enabled ? missingKeyMessage("MiMo", "MIMO_API_KEY") : "Provider is disabled.";
  if (provider === context.modelCatalog.providers.elevenlabs) return context.config.providers.elevenlabs.enabled ? missingKeyMessage("ElevenLabs", "ELEVENLABS_API_KEY") : "Provider is disabled.";
  if (provider === context.modelCatalog.providers.openai) return context.config.providers.openai.enabled ? missingKeyMessage("OpenAI", "OPENAI_API_KEY") : "Provider is disabled.";
  if (provider === context.modelCatalog.providers.chatterbox) return context.config.providers.chatterbox.enabled ? "Base URL is not configured." : "Provider is disabled.";
  const connection = context.config.compatibleConnections.find((item) => item.id === provider.id);
  return connection?.enabled ? "Base URL is not configured." : "Connection is disabled.";
}

const missingKeyMessage = (name, keyName) => `${name} API key is not configured. Set ${keyName} in .env.`;

async function loadMimoModels(context) {
  const provider = context.modelCatalog.providers.mimo;
  const apiKey = context.credentials.MIMO_API_KEY;
  let data;
  try {
    data = await sdkJson(openAiClient({ baseURL: context.config.providers.mimo.baseUrl, apiKey, headers: { Authorization: null, "api-key": apiKey }, fetch: cappedFetch(context.fetchImpl, MAX_JSON_RESPONSE_BYTES, "MiMo models") }).get("/models", callOptions(MODEL_TIMEOUT_MS)), "MiMo models");
  } catch (error) {
    throw providerError(error, "MiMo models", "MIMO_API_KEY", MODEL_TIMEOUT_MS, apiKey);
  }
  const models = Array.isArray(data?.data) ? data.data : [];
  provider.discoveredModels = models.filter((model) => typeof model?.id === "string" && model.id.includes("-tts")).map((model) => ({
    id: model.id,
    rawId: model.id,
    name: model.id === "mimo-v2.5-tts" ? "MiMo v2.5 TTS" : model.id,
    provider: "mimo",
    suggested: { tts: true },
  }));
  const active = context.config.providers.mimo.activeModels;
  provider.ttsModels = provider.discoveredModels.filter((model) => active[model.rawId]?.tts);
  provider.status = "ready";
  provider.error = null;
}

async function loadElevenLabsModels(context) {
  const provider = context.modelCatalog.providers.elevenlabs;
  const data = await fetchJson(context.fetchImpl, ELEVENLABS_MODELS_URL, { "xi-api-key": context.credentials.ELEVENLABS_API_KEY }, "ElevenLabs models");
  provider.discoveredModels = (Array.isArray(data) ? data : [])
    .filter((model) => model?.can_do_text_to_speech && typeof model.model_id === "string")
    .map((model) => ({
      id: model.model_id,
      name: model.name || model.model_id,
      provider: "elevenlabs",
      requiresAlphaAccess: Boolean(model.requires_alpha_access),
      supported: !["eleven_v4_turbo", "eleven_v3_conversational"].includes(model.model_id),
      unsupportedReason: ["eleven_v4_turbo", "eleven_v3_conversational"].includes(model.model_id)
        ? `${model.name || model.model_id} requires the realtime dialogue API, which is not supported by this app.` : "",
      canUseStyle: typeof model.can_use_style === "boolean" ? model.can_use_style : null,
      canUseSpeakerBoost: typeof model.can_use_speaker_boost === "boolean" ? model.can_use_speaker_boost : null,
      maximumTextLengthPerRequest: Number.isSafeInteger(model.maximum_text_length_per_request) && model.maximum_text_length_per_request > 0
        ? model.maximum_text_length_per_request : null,
      ttsCapabilities: elevenLabsCapabilities(model.model_id),
      languages: (Array.isArray(model.languages) ? model.languages : [])
        .filter((language) => typeof language?.language_id === "string")
        .map((language) => ({ id: ELEVEN_LANGUAGE_CODES.get(language.language_id) || language.language_id, name: language.name || language.language_id })),
    }));
  const active = context.config.providers.elevenlabs.activeModels;
  provider.ttsModels = provider.discoveredModels.filter((model) => model.supported && active[model.id]?.tts);
  provider.status = "ready";
  provider.error = null;
}

async function loadCompatibleModels(context, connection, provider) {
  const apiKey = context.credentials[connection.apiKeyEnv];
  if (connection.requiresApiKey && !apiKey) throw new Error(missingKeyMessage(connection.name, connection.apiKeyEnv));
  const label = `${connection.name} models`;
  const client = openAiClient({ baseURL: connection.baseUrl, apiKey, fetch: cappedFetch(context.fetchImpl, MAX_JSON_RESPONSE_BYTES, label) });
  const requests = await Promise.allSettled(modelDiscoveryUrls(connection).map((url) => sdkJson(client.get(url, callOptions(MODEL_TIMEOUT_MS)), label)
    .catch((error) => { throw providerError(error, label, connection.apiKeyEnv, MODEL_TIMEOUT_MS, apiKey); })));
  const successful = requests.filter((result) => result.status === "fulfilled");
  if (successful.length === 0) throw new Error([...new Set(requests.map((result) => result.reason?.message || String(result.reason)))].join(" ") || `${connection.name} models request failed.`);
  const models = [...new Map(successful.flatMap((result) => Array.isArray(result.value?.data) ? result.value.data : [])
    .filter((model) => typeof model?.id === "string")
    .map((model) => [model.id, model])).values()];
  const discoveredModels = [];
  const activeIds = new Set(Object.keys(connection.activeModels || {}));
  for (const rawId of activeIds) if (!models.some((model) => model.id === rawId)) models.push({ id: rawId });
  for (const model of models) {
    const rawId = typeof model?.id === "string" ? model.id : "";
    if (!rawId) continue;
    discoveredModels.push({
      id: compatibleModelId(connection.id, rawId),
      rawId,
      name: model?.name || rawId,
      provider: ["openai", "chatterbox"].includes(connection.kind) ? connection.kind : "compatible",
      connectionId: connection.id,
      connectionName: connection.name,
      suggested: { tts: suggestsTts(model) },
    });
  }
  provider.discoveredModels = discoveredModels;
  provider.ttsModels = discoveredModels.filter((model) => connection.activeModels?.[model.rawId]?.tts);
  provider.status = "ready";
  provider.error = null;
}

function mergeDiscoveredLanguages(catalog) {
  const knownCodes = new Set(catalog.languages.map((language) => language.apiCode));
  for (const model of catalog.providers.elevenlabs.ttsModels) {
    for (const language of model.languages || []) {
      if (knownCodes.has(language.id)) continue;
      catalog.languages.push({ id: language.id, apiCode: language.id, name: language.name, defaultAccent: "" });
      knownCodes.add(language.id);
    }
  }
  catalog.languages.sort((a, b) => a.name.localeCompare(b.name));
}

function setProviderError(provider, error) {
  provider.status = "error";
  // Every provider status error passes the shared key redaction, whatever built it.
  provider.error = redactSecrets(error.message || String(error));
}

function compatibleModelId(connectionId, modelId) {
  return `compat:${connectionId}:${modelId}`;
}

export function parseCompatibleModelId(modelId) {
  const match = String(modelId || "").match(COMPAT_MODEL_RE);
  return match ? { connectionId: match[1], modelId: match[2] } : null;
}

export function builtInConnectionId(config, connectionId) {
  return config.compatibleConnections.some((connection) => connection.id === connectionId) ? "" : connectionId;
}

export function compatibleConnection(context, connectionId) {
  const custom = context.config.compatibleConnections.find((item) => item.id === connectionId);
  if (custom) return custom;
  if (connectionId === "openai") return builtInOpenAiConnection(context.config);
  if (connectionId === "chatterbox") return builtInChatterboxConnection(context.config);
  return null;
}

function builtInOpenAiConnection(config) {
  return { id: "openai", name: "OpenAI", apiKeyEnv: "OPENAI_API_KEY", kind: "openai", requiresApiKey: true, ...config.providers.openai };
}

export function builtInChatterboxConnection(config) {
  return { id: "chatterbox", name: "Chatterbox", apiKeyEnv: "CHATTERBOX_API_KEY", kind: "chatterbox", ttsBaseUrl: "", ...config.providers.chatterbox };
}

function modelDiscoveryUrls(connection) {
  if (connection.modelsUrl) return [modelsEndpoint(connection.modelsUrl)];
  return [...new Set([connection.baseUrl, connection.ttsBaseUrl || connection.baseUrl].map(modelsEndpoint))];
}

function modelsEndpoint(value) {
  const url = normalizeUrl(value);
  return url.endsWith(OPENAI_COMPATIBLE_MODELS_URL) ? url : `${url}${OPENAI_COMPATIBLE_MODELS_URL}`;
}

function suggestsTts(model) {
  if (typeof model?.capabilities?.tts === "boolean") return model.capabilities.tts;
  const id = String(model?.id).toLowerCase();
  return !/(whisper|transcribe|transcription|asr|scribe)/.test(id) && /(^tts-|tts$|text-to-speech|speech)/.test(id);
}

export function availableModelIds(context) {
  const providers = context.modelCatalog.providers;
  const openaiTts = providers.openai.ttsModels.map((model) => model.id);
  const chatterboxTts = providers.chatterbox.ttsModels.map((model) => model.id);
  const compatibleTts = (providers.compatible || []).flatMap((provider) => provider.ttsModels.map((model) => model.id));
  return {
    ttsModels: new Set([...providers.mimo.ttsModels, ...providers.elevenlabs.ttsModels, ...openaiTts, ...chatterboxTts, ...compatibleTts].map((model) => typeof model === "string" ? model : model.id)),
    languages: new Set(context.modelCatalog.languages.map((language) => language.id)),
  };
}

// Discovered, supported TTS models of ready providers that are not active yet: what set_tts_models can activate.
export function inactiveTtsModels(context) {
  const providers = context.modelCatalog.providers;
  return [providers.mimo, providers.elevenlabs, providers.openai, providers.chatterbox, ...(providers.compatible || [])]
    .filter((provider) => provider.status === "ready")
    .flatMap((provider) => provider.discoveredModels.filter((model) => model.supported !== false && model.suggested?.tts !== false
      && !provider.ttsModels.some((item) => item.id === model.id)));
}

// Language IDs a discovered model reports; a model that reports none (compatible servers) lists every language.
export function discoveredModelLanguages(context, model) {
  const codes = model.provider === "mimo" ? MIMO_LANGUAGE_CODES : model.languages?.length ? new Set(model.languages.map((language) => language.id)) : null;
  return context.modelCatalog.languages.filter((language) => !codes || codes.has(language.apiCode)).map((language) => language.id);
}

export function isElevenLabsModel(context, model) {
  return ELEVENLABS_MODELS.includes(model) || context.modelCatalog.providers.elevenlabs.discoveredModels.some((item) => item.id === model);
}

function isCompatibleTtsModel(context, modelId) {
  const parsed = parseCompatibleModelId(modelId);
  if (!parsed) return false;
  return compatibleModelProvider(context, parsed.connectionId)?.ttsModels.some((model) => model.id === modelId) === true;
}

function compatibleModelProvider(context, connectionId) {
  return [...(context.modelCatalog.providers.compatible || []), context.modelCatalog.providers.openai, context.modelCatalog.providers.chatterbox]
    .find((provider) => provider.id === connectionId);
}

export function resolveLanguage(context, id) {
  const language = context.modelCatalog.languages.find((item) => item.id === id);
  if (!language) throw badRequest(`Unsupported language "${id}".`);
  return language;
}

export function modelLanguageError(context, modelId, language) {
  if (modelId === "mimo-v2.5-tts") {
    const provider = context.modelCatalog.providers.mimo;
    if (!provider.ttsModels.some((model) => model.id === modelId)) return provider.status === "loading"
      ? "MiMo models are still loading; retry shortly."
      : provider.status === "error" ? `MiMo is unavailable: ${provider.error || "connection failed"}.`
        : provider.status === "unconfigured" ? "MiMo is not configured." : `TTS model "${modelId}" is not active.`;
    return MIMO_LANGUAGE_CODES.has(language.apiCode) ? "" : `MiMo preset TTS does not support ${language.name}; choose an ElevenLabs model.`;
  }
  const parsed = parseCompatibleModelId(modelId);
  if (parsed) {
    const provider = compatibleModelProvider(context, parsed.connectionId);
    const connection = compatibleConnection(context, parsed.connectionId);
    if (provider?.status === "loading") return `${provider.name} models are still loading; retry shortly.`;
    if (provider?.status === "error") return `${provider.name} is unavailable${connection?.baseUrl ? ` at ${connection.baseUrl}` : ""}: ${provider.error || "connection failed"}. Start or reconnect it, then refresh models.`;
    if (provider?.status === "unconfigured") return `${provider.name} is not configured.`;
    if (isCompatibleTtsModel(context, modelId)) return "";
  }
  if (!isElevenLabsModel(context, modelId)) return `Unknown TTS model "${modelId}".`;
  const provider = context.modelCatalog.providers.elevenlabs;
  const discovered = provider.discoveredModels.find((item) => item.id === modelId);
  if (discovered?.supported === false) return discovered.unsupportedReason;
  const model = provider.ttsModels.find((item) => item.id === modelId);
  if (!model) return provider.status === "loading"
    ? "ElevenLabs models are still loading; retry shortly."
    : provider.status === "error" ? `ElevenLabs is unavailable: ${provider.error || "connection failed"}.`
      : provider.status === "unconfigured" ? "ElevenLabs is not configured." : `TTS model "${modelId}" is not active.`;
  if (model?.languages?.length && !model.languages.some((item) => item.id === language.apiCode)) {
    return `${model.name || modelId} does not support ${language.name}.`;
  }
  return "";
}

export function assertTtsLanguageCompatibility(context, speakerProfile, language) {
  const errors = speakerProfile.speakers.map((speaker) => {
    const model = speaker.ttsModelOverride || speakerProfile.voiceModel;
    const error = modelLanguageError(context, model, language);
    return error ? `${speaker.name}: ${error}` : "";
  }).filter(Boolean);
  if (errors.length) throw badRequest(errors.join(" "));
}

export function elevenLabsCapabilities(model) {
  return {
    squareTags: ["eleven_v3", "eleven_v4"].includes(model),
    breaks: !["eleven_v3", "eleven_v4"].includes(model),
    voiceSettings: model === "eleven_v4" ? ["stability", "similarityBoost"] : ["stability", "similarityBoost", "style", "useSpeakerBoost", "speed"],
  };
}
