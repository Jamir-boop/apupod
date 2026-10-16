import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { badRequest, normalizeUrl } from "../util.mjs";
import { fetchJson } from "./transport.mjs";

export const DEFAULT_MIMO_BASE_URL = "https://api.xiaomimimo.com/v1";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

const OPENCODE_GO_CHAT_MODELS = new Set([
  "grok-4.5", "glm-5.2", "glm-5.1", "glm-5", "kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5",
  "deepseek-v4-pro", "deepseek-v4-flash", "mimo-v2.5", "mimo-v2.5-pro", "mimo-v2-pro", "mimo-v2-omni", "hy3", "hy3-preview",
]);
const OPENCODE_GO_MESSAGES_MODELS = new Set([
  "minimax-m3", "minimax-m2.7", "minimax-m2.5", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.5-plus",
]);

const ELEVENLABS_MODELS_URL = "https://api.elevenlabs.io/v1/models";

const OPENAI_COMPATIBLE_MODELS_URL = "/models";

const COMPAT_MODEL_RE = /^compat:([a-zA-Z0-9_-]+):(.+)$/;

export const MIMO_VOICES = ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"];
export const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"];
export const ELEVENLABS_MODELS = ["eleven_flash_v2_5", "eleven_multilingual_v2", "eleven_v3", "eleven_v4"];
export const TTS_MODELS = ["mimo-v2.5-tts", ...ELEVENLABS_MODELS];
export const TEXT_MODELS = ["mimo-v2.5-pro", "mimo-v2.5"];
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

export function openCodeGoProtocol(rawModelId) {
  const modelId = String(rawModelId || "");
  if (OPENCODE_GO_CHAT_MODELS.has(modelId)) return "chat";
  if (OPENCODE_GO_MESSAGES_MODELS.has(modelId)) return "messages";
  return null;
}

export async function resolveOpenCodeGoCredential() {
  const environmentKey = process.env.OPENCODE_GO_API_KEY?.trim();
  if (environmentKey) return { key: environmentKey, source: "environment", error: null };
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  const authPath = join(dataHome, "opencode", "auth.json");
  let auth;
  try {
    auth = await readFile(authPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { key: "", source: null, error: "OpenCode Go login was not found. Run /connect in OpenCode or set OPENCODE_GO_API_KEY." };
    return { key: "", source: null, error: "OpenCode Go auth file could not be read." };
  }
  let entry;
  try {
    entry = JSON.parse(auth)?.["opencode-go"];
  } catch {
    return { key: "", source: null, error: "OpenCode Go auth file contains invalid JSON." };
  }
  const key = entry?.type === "api" && typeof entry.key === "string" ? entry.key.trim() : "";
  if (key) return { key, source: "opencode-login", error: null };
  return { key: "", source: null, error: "OpenCode Go login was not found. Run /connect in OpenCode or set OPENCODE_GO_API_KEY." };
}

export function createModelCatalog(credentials = null) {
  const credential = (name) => credentials ? credentials[name] || "" : process.env[name]?.trim() || "";
  return {
    status: "loading",
    updatedAt: null,
    languages: structuredClone(LANGUAGE_OPTIONS),
    providers: {
      mimo: { configured: Boolean(credential("MIMO_API_KEY")), status: "loading", error: null, discoveredModels: [], textModels: [], ttsModels: [] },
      elevenlabs: { configured: Boolean(credential("ELEVENLABS_API_KEY")), status: "loading", error: null, discoveredModels: [], ttsModels: [] },
      openai: { id: "openai", name: "OpenAI", configured: Boolean(credential("OPENAI_API_KEY")), status: "loading", error: null, textModels: [], ttsModels: [] },
      chatgpt: { id: "chatgpt", name: "ChatGPT plan", configured: false, status: "unconfigured", error: null, discoveredModels: [], textModels: [], ttsModels: [] },
      opencodeGo: { id: "opencode-go", name: "OpenCode Go", configured: Boolean(credential("OPENCODE_GO_API_KEY")), status: "loading", error: null, credentialSource: null, discoveredModels: [], textModels: [], ttsModels: [] },
      chatterbox: { id: "chatterbox", name: "Chatterbox", configured: false, status: "unconfigured", error: null, discoveredModels: [], textModels: [], ttsModels: [] },
      compatible: [],
    },
  };
}

function modelDiscoverySnapshot(context) {
  const config = structuredClone(context.config);
  const names = new Set([
    "MIMO_API_KEY",
    "ELEVENLABS_API_KEY",
    "OPENAI_API_KEY",
    "CHATTERBOX_API_KEY",
    "TYPESAFE_API_KEY",
    ...config.compatibleConnections.map((connection) => connection.apiKeyEnv),
  ]);
  const credentials = Object.fromEntries([...names].map((name) => [name, process.env[name]?.trim() || ""]));
  return resolveOpenCodeGoCredential().then((openCodeGoCredential) => ({
    config,
    credentials: {
      ...credentials,
      OPENCODE_GO_API_KEY: openCodeGoCredential.key,
    },
    openCodeGoCredentialSource: openCodeGoCredential.source,
    openCodeGoCredentialError: openCodeGoCredential.error,
    chatgptClient: context.chatgptClient,
    chatgptAccountId: chatGptCatalogAccount(context),
  }));
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
  const chatgpt = catalog.providers.chatgpt;
  const openaiConnection = builtInOpenAiConnection(context.config);
  const opencodeGo = catalog.providers.opencodeGo;
  const openCodeGoConnection = builtInOpenCodeGoConnection(context.config);
  const chatterbox = catalog.providers.chatterbox;
  const chatterboxConnection = builtInChatterboxConnection(context.config);
  const compatible = context.config.compatibleConnections.map((connection) => ({
    id: connection.id,
    name: connection.name,
    configured: Boolean(connection.enabled && connection.baseUrl),
    status: "loading",
    error: null,
    textModels: [],
    ttsModels: [],
    discoveredModels: [],
  }));
  catalog.providers.compatible = compatible;
  mimo.configured = Boolean(context.config.providers.mimo.enabled && context.credentials.MIMO_API_KEY);
  elevenlabs.configured = Boolean(context.config.providers.elevenlabs.enabled && context.credentials.ELEVENLABS_API_KEY);
  openai.configured = Boolean(openaiConnection.enabled && context.credentials.OPENAI_API_KEY && builtInConnectionId(context.config, "openai"));
  chatgpt.configured = Boolean(context.config.providers.chatgpt.enabled && context.chatgptAccountId && builtInConnectionId(context.config, "chatgpt"));
  opencodeGo.configured = Boolean(openCodeGoConnection.enabled && context.credentials.OPENCODE_GO_API_KEY && builtInConnectionId(context.config, "opencode-go"));
  opencodeGo.credentialSource = snapshot.openCodeGoCredentialSource;
  chatterbox.configured = Boolean(chatterboxConnection.enabled && chatterboxConnection.baseUrl && builtInConnectionId(context.config, "chatterbox"));
  for (const provider of [mimo, elevenlabs, openai, chatgpt, opencodeGo, chatterbox, ...compatible]) {
    provider.status = provider.configured ? "loading" : "unconfigured";
    provider.error = provider.configured ? null : unconfiguredProviderMessage(context, provider);
    provider.ttsModels = [];
    provider.discoveredModels = [];
    if ("textModels" in provider) provider.textModels = [];
  }
  for (const provider of [openai, chatgpt, opencodeGo, chatterbox]) if (!builtInConnectionId(context.config, provider.id)) {
    provider.status = "error";
    provider.error = `A saved compatible connection uses the reserved ID "${provider.id}". Its references are preserved. Resolve this connection ID conflict before using built-in ${provider.name}.`;
  }
  catalog.status = "loading";
  catalog.languages = structuredClone(LANGUAGE_OPTIONS);

  await Promise.all([
    mimo.configured ? loadMimoModels(context).catch((error) => setProviderError(mimo, error)) : null,
    elevenlabs.configured ? loadElevenLabsModels(context).catch((error) => setProviderError(elevenlabs, error)) : null,
    openai.configured ? loadCompatibleModels(context, openaiConnection, openai).catch((error) => setProviderError(openai, error)) : null,
    chatgpt.configured ? loadChatGptModels(context).catch((error) => { chatgpt.status = "error"; chatgpt.error = chatGptRecovery(error.code); }) : null,
    opencodeGo.configured ? loadCompatibleModels(context, openCodeGoConnection, opencodeGo).catch((error) => setProviderError(opencodeGo, error)) : null,
    chatterbox.configured ? loadCompatibleModels(context, chatterboxConnection, chatterbox).catch((error) => setProviderError(chatterbox, error)) : null,
    ...context.config.compatibleConnections.map((connection) => {
      const provider = compatible.find((item) => item.id === connection.id);
      return provider?.configured ? loadCompatibleModels(context, connection, provider).catch((error) => setProviderError(provider, error)) : null;
    }),
  ]);
  const configured = [mimo, elevenlabs, openai, chatgpt, opencodeGo, chatterbox, ...compatible].filter((provider) => provider.configured);
  const ready = configured.filter((provider) => provider.status === "ready").length;
  mergeDiscoveredLanguages(catalog);
  catalog.status = configured.length === 0 ? "unconfigured" : ready === configured.length ? "ready" : ready > 0 ? "partial" : "error";
  catalog.updatedAt = new Date().toISOString();
  return catalog;
}

function unconfiguredProviderMessage(context, provider) {
  if (provider === context.modelCatalog.providers.chatgpt) return context.config.providers.chatgpt.enabled ? "Sign in to ChatGPT and enable plan usage." : "Provider is disabled.";
  if (provider === context.modelCatalog.providers.mimo) return context.config.providers.mimo.enabled ? "API key is not configured." : "Provider is disabled.";
  if (provider === context.modelCatalog.providers.elevenlabs) return context.config.providers.elevenlabs.enabled ? "API key is not configured." : "Provider is disabled.";
  if (provider === context.modelCatalog.providers.openai) return context.config.providers.openai.enabled ? "API key is not configured." : "Provider is disabled.";
  if (provider === context.modelCatalog.providers.opencodeGo) return context.config.providers.opencodeGo.enabled ? context.openCodeGoCredentialError || "OpenCode Go login was not found. Run /connect in OpenCode or set OPENCODE_GO_API_KEY." : "Provider is disabled.";
  if (provider === context.modelCatalog.providers.chatterbox) return context.config.providers.chatterbox.enabled ? "Base URL is not configured." : "Provider is disabled.";
  const connection = context.config.compatibleConnections.find((item) => item.id === provider.id);
  return connection?.enabled ? "Base URL is not configured." : "Connection is disabled.";
}

async function loadMimoModels(context) {
  const provider = context.modelCatalog.providers.mimo;
  const data = await fetchJson(context.fetchImpl, `${context.config.providers.mimo.baseUrl}/models`, { "api-key": context.credentials.MIMO_API_KEY }, "MiMo models");
  const models = Array.isArray(data?.data) ? data.data : [];
  provider.discoveredModels = models.filter((model) => typeof model.id === "string" && !model.id.includes("-asr")).map((model) => ({
    id: model.id,
    rawId: model.id,
    name: model.id === "mimo-v2.5-tts" ? "MiMo v2.5 TTS" : model.id,
    provider: "mimo",
    suggested: model.id.includes("-tts") ? { text: false, tts: true } : { text: true, tts: false },
  }));
  const active = context.config.providers.mimo.activeModels;
  provider.textModels = provider.discoveredModels.filter((model) => active[model.rawId]?.text);
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

export function chatGptRecovery(code, param) {
  if (/unsupported_capability/.test(code || "")) return `The selected ChatGPT model does not support ${param ? `parameter "${param}"` : "this request capability"}. Remove this setting or select a model that supports it.`;
  if (/plan_usage_disabled/.test(code || "")) return "ChatGPT plan usage is not allowed. Continue with ChatGPT and allow plan usage.";
  if (/account_changed/.test(code || "")) return "The ChatGPT account changed. Select an account and try again.";
  if (/sign_in|required|token|grant|401/.test(code || "")) return "Sign in to ChatGPT again to use this account.";
  if (/limit|quota|usage|credits|rate/.test(code || "")) return "ChatGPT usage is limited. Check Manage usage or select another provider. API-key billing will not start automatically.";
  return `ChatGPT could not complete the request (${code || "connection_error"}). Check the connection and try again.`;
}

export function chatGptStatus(context) {
  const status = context.chatgptClient.status();
  return {
    activeAccountId: status.activeAccountId || null,
    accounts: (status.accounts || []).map((account) => ({ id: account.id, label: account.label, active: account.active === true, grant: account.grant === true, status: account.status })),
    pending: status.pending ? { accountId: status.pending.accountId || null, status: status.pending.status } : null,
    lastSignIn: { status: status.lastSignIn?.status || "idle", ...(status.lastSignIn?.error?.code ? { error: chatGptRecovery(status.lastSignIn.error.code) } : {}) },
  };
}

export function chatGptCatalogAccount(context) {
  const status = context.chatgptClient?.status();
  return status?.accounts?.some((account) => account.id === status.activeAccountId && account.status === "connected" && account.grant) ? status.activeAccountId : null;
}

export function refreshChatGptAccount(context, force = false) {
  const accountId = chatGptCatalogAccount(context);
  if (force || accountId !== context.chatgptCatalogAccount) {
    context.chatgptCatalogAccount = accountId;
    return queueModelCatalogRefresh(context, { force: true });
  }
  return null;
}

async function loadChatGptModels(context) {
  const provider = context.modelCatalog.providers.chatgpt;
  const models = await context.chatgptClient.models(context.chatgptAccountId);
  provider.discoveredModels = models.filter((model) => model.visibility === "list" && typeof model.slug === "string" && model.slug).map((model) => ({
    id: compatibleModelId("chatgpt", model.slug), rawId: model.slug, name: model.display_name || model.slug,
    connectionId: "chatgpt", connectionName: "ChatGPT plan", provider: "chatgpt", suggested: { text: true, tts: false },
  }));
  provider.textModels = provider.discoveredModels.filter((model) => context.config.providers.chatgpt.activeModels[model.rawId]?.text);
  provider.status = "ready";
  provider.error = null;
}

async function loadCompatibleModels(context, connection, provider) {
  const apiKey = context.credentials[connection.apiKeyEnv];
  if (connection.requiresApiKey && !apiKey) throw new Error("API key is not configured.");
  const requests = await Promise.allSettled(modelDiscoveryUrls(connection).map((url) => fetchJson(
    context.fetchImpl,
    url,
    apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    `${connection.name} models`
  )));
  const successful = requests.filter((result) => result.status === "fulfilled");
  if (successful.length === 0) throw requests[0]?.reason || new Error(`${connection.name} models request failed.`);
  const models = [...new Map(successful.flatMap((result) => Array.isArray(result.value?.data) ? result.value.data : [])
    .filter((model) => typeof model?.id === "string")
    .map((model) => [model.id, model])).values()];
  const discoveredModels = [];
  const activeIds = new Set(Object.keys(connection.activeModels || {}));
  for (const rawId of activeIds) if (!models.some((model) => model.id === rawId)) models.push({ id: rawId });
  for (const model of models) {
    const rawId = typeof model?.id === "string" ? model.id : "";
    if (!rawId) continue;
    const protocol = connection.kind === "opencodeGo" ? openCodeGoProtocol(rawId) : null;
    const capability = connection.kind === "opencodeGo" ? { text: Boolean(protocol), tts: false } : compatibleCapability(model);
    const shared = {
      id: compatibleModelId(connection.id, rawId),
      rawId,
      name: model?.name || rawId,
      provider: ["openai", "opencodeGo", "chatterbox"].includes(connection.kind) ? connection.kind : "compatible",
      connectionId: connection.id,
      connectionName: connection.name,
      suggested: capability,
      ...(connection.kind === "opencodeGo" ? { protocol, supported: Boolean(protocol) } : {}),
    };
    discoveredModels.push(shared);
  }
  provider.discoveredModels = discoveredModels;
  provider.textModels = discoveredModels.filter((model) => model.supported !== false && connection.activeModels?.[model.rawId]?.text);
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
  provider.error = error.message || String(error);
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

const EFFORT_LEVELS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

export function normalizeEffort(value) {
  const effort = String(value || "").trim();
  return EFFORT_LEVELS.has(effort) ? effort : "";
}

// ponytail: hardcoded from OpenAI docs — the models endpoint does not enumerate supported efforts
export function effortLevelsForModel(rawModelId) {
  const id = String(rawModelId || "");
  if (/^gpt-5\.6/.test(id)) return ["none", "low", "medium", "high", "xhigh", "max"];
  if (/^gpt-5\.5-pro(?:-|$)/.test(id)) return ["medium", "high", "xhigh"];
  if (/^gpt-5\.5/.test(id)) return ["none", "low", "medium", "high", "xhigh"];
  return [];
}

export function usesResponsesApi(rawModelId) {
  return /^gpt-5\.(5|6)/.test(String(rawModelId || ""));
}

export function compatibleConnection(context, connectionId) {
  const custom = context.config.compatibleConnections.find((item) => item.id === connectionId);
  if (custom) return custom;
  if (connectionId === "openai") return builtInOpenAiConnection(context.config);
  if (connectionId === "opencode-go") return builtInOpenCodeGoConnection(context.config);
  if (connectionId === "chatterbox") return builtInChatterboxConnection(context.config);
  return null;
}

function builtInOpenAiConnection(config) {
  return { id: "openai", name: "OpenAI", apiKeyEnv: "OPENAI_API_KEY", kind: "openai", requiresApiKey: true, ...config.providers.openai };
}

function builtInOpenCodeGoConnection(config) {
  return { id: "opencode-go", name: "OpenCode Go", apiKeyEnv: "OPENCODE_GO_API_KEY", kind: "opencodeGo", requiresApiKey: true, baseUrl: OPENCODE_GO_BASE_URL, modelsUrl: `${OPENCODE_GO_BASE_URL}/models`, llmBaseUrl: "", ttsBaseUrl: "", ...config.providers.opencodeGo };
}

export function builtInChatterboxConnection(config) {
  return { id: "chatterbox", name: "Chatterbox", apiKeyEnv: "CHATTERBOX_API_KEY", kind: "chatterbox", ttsBaseUrl: "", llmBaseUrl: "", ...config.providers.chatterbox };
}

function modelDiscoveryUrls(connection) {
  if (connection.modelsUrl) return [modelsEndpoint(connection.modelsUrl)];
  return [...new Set([connection.llmBaseUrl || connection.baseUrl, connection.ttsBaseUrl || connection.baseUrl].map(modelsEndpoint))];
}

function modelsEndpoint(value) {
  const url = normalizeUrl(value);
  return url.endsWith(OPENAI_COMPATIBLE_MODELS_URL) ? url : `${url}${OPENAI_COMPATIBLE_MODELS_URL}`;
}

function guessCompatibleCapability(modelId) {
  const id = String(modelId).toLowerCase();
  if (/(whisper|transcribe|transcription|asr|scribe)/.test(id)) return { text: false, tts: false };
  if (/(^tts-|tts$|text-to-speech|speech)/.test(id)) return { text: false, tts: true };
  return { text: true, tts: false };
}

function compatibleCapability(model) {
  const capabilities = model?.capabilities;
  if (typeof capabilities?.text === "boolean" || typeof capabilities?.tts === "boolean") {
    return { text: capabilities.text === true, tts: capabilities.tts === true };
  }
  return guessCompatibleCapability(model?.id);
}

export function availableModelIds(context) {
  const providers = context.modelCatalog.providers;
  const openaiText = providers.openai.textModels.map((model) => model.id);
  const openCodeGoText = providers.opencodeGo.textModels.map((model) => model.id);
  const openaiTts = providers.openai.ttsModels.map((model) => model.id);
  const chatterboxText = providers.chatterbox.textModels.map((model) => model.id);
  const chatterboxTts = providers.chatterbox.ttsModels.map((model) => model.id);
  const compatibleText = (providers.compatible || []).flatMap((provider) => provider.textModels.map((model) => model.id));
  const compatibleTts = (providers.compatible || []).flatMap((provider) => provider.ttsModels.map((model) => model.id));
  return {
    textModels: new Set([...providers.mimo.textModels.map((model) => model.id), ...openaiText, ...(providers.chatgpt?.textModels || []).map((model) => model.id), ...openCodeGoText, ...chatterboxText, ...compatibleText]),
    ttsModels: new Set([...providers.mimo.ttsModels, ...providers.elevenlabs.ttsModels, ...openaiTts, ...chatterboxTts, ...compatibleTts].map((model) => typeof model === "string" ? model : model.id)),
    languages: new Set(context.modelCatalog.languages.map((language) => language.id)),
  };
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
