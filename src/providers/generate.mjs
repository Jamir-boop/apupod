import { createHash } from "node:crypto";
import { ChatGptError } from "../chatgpt.mjs";
import { badRequest, oneLine, normalizeDelivery } from "../util.mjs";
import { MAX_JSON_RESPONSE_BYTES, MAX_AUDIO_RESPONSE_BYTES, MAX_TTS_JSON_RESPONSE_BYTES, MODEL_TIMEOUT_MS, LLM_TIMEOUT_MS, TTS_TIMEOUT_MS, LLM_RETRIES, fetchJsonWithBody, fetchBytes, cappedFetch, openAiClient, anthropicClient, callOptions, sdkJson, providerError } from "./transport.mjs";
import { openCodeGoProtocol, resolveOpenCodeGoCredential, awaitLatestModelCatalog, parseCompatibleModelId, builtInConnectionId, effortLevelsForModel, usesResponsesApi, compatibleConnection, builtInChatterboxConnection, availableModelIds, isElevenLabsModel, modelLanguageError, elevenLabsCapabilities, apiKeyName } from "./catalog.mjs";

const ELEVENLABS_URL = "https://api.elevenlabs.io/v1/text-to-speech";

const ELEVENLABS_VOICES_URL = "https://api.elevenlabs.io/v2/voices?page_size=100&include_total_count=false";

// Only part of the clip cache key now; the SDK builds the request URL.
const OPENAI_COMPATIBLE_TTS_URL = "/audio/speech";

export const OPENAI_TTS_NO_INSTRUCTIONS = new Set(["tts-1", "tts-1-hd"]);

export const CHATTERBOX_DEFAULTS = { exaggeration: 0.7, cfgWeight: 0.3, temperature: 0.7 };
const MIMO_TTS_DEFAULTS = { temperature: null, topP: null, instructionPreset: "", instructionText: "" };
export const ELEVENLABS_DEFAULTS = {
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0,
  useSpeakerBoost: true,
  speed: 1,
  seed: null,
  textNormalization: "auto",
};
export const MIMO_INSTRUCTION_PRESETS = {
  natural: "Use a natural podcast delivery with clear pacing.",
  warm: "Use a warm, friendly delivery.",
  calm: "Use a calm, steady delivery.",
  expressive: "Use a more expressive delivery while keeping the words exact.",
  energetic: "Use an energetic delivery without rushing.",
};
export const CHATTERBOX_TAGS = [
  "advertisement", "angry", "chuckle", "clear throat", "cough", "crying", "dramatic", "fear", "gasp", "groan",
  "happy", "laugh", "narration", "sarcastic", "shush", "sigh", "sniff", "surprised", "whispering",
];
export const TTS_CUE_RE = /\[([^\]\r\n]{1,80})\]/g;
export const ELEVEN_BREAK_RE = /<break\s+time="([0-9]+(?:\.[0-9]+)?)s"\s*\/>/gi;
export const ELEVEN_BREAK_ANY_RE = /<break\b[^>]*\/?>/gi;
export const TTS_DOCS = {
  mimo: "https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/speech-synthesis-v2.5",
  elevenlabs: "https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices",
  chatterbox: "https://github.com/resemble-ai/chatterbox",
};

export function speakerAccent(speaker, language) {
  return String(speaker.accent || language.defaultAccent || "").trim();
}

export function ttsCueCapability(context, model, language) {
  if (model === "mimo-v2.5-tts") return { provider: "mimo", cueMode: "tags", squareTags: true, breaks: false };
  if (isElevenLabsModel(context, model)) {
    const capability = elevenLabsCapabilities(model);
    return { provider: "elevenlabs", cueMode: capability.squareTags ? "tags" : "breaks", ...capability };
  }
  const parsed = parseCompatibleModelId(model);
  const connection = parsed && compatibleConnection(context, parsed.connectionId);
  if (connection?.kind === "chatterbox") {
    const supported = parsed.modelId.toLowerCase().includes("turbo") && language.apiCode === "en";
    return { provider: "chatterbox", cueMode: supported ? "tags" : "delivery", squareTags: supported, breaks: false };
  }
  return { provider: "generic", cueMode: "delivery", squareTags: false, breaks: false };
}

export function turnClipDescriptor(context, speakerProfile, speaker, turn, language) {
  const model = speaker.ttsModelOverride || speakerProfile.voiceModel;
  const connection = compatibleConnection(context, parseCompatibleModelId(model)?.connectionId);
  return {
    model,
    provider: ttsProviderFingerprint(context, model),
    voice: speaker.voiceId,
    ...(model === "eleven_v4" ? {} : { style: speaker.style }),
    language: language.id,
    ...(model === "eleven_v4" ? {} : { accent: speakerAccent(speaker, language) }),
    cue: turn.delivery,
    text: turn.text,
    ...(connection?.kind === "chatterbox" ? { chatterbox: chatterboxSettings(speaker) } : {}),
    ...(model === "mimo-v2.5-tts" ? { mimo: mimoTtsSettings(speaker) } : {}),
    ...(model.startsWith("eleven") ? { elevenlabs: elevenLabsSettings(speaker, model) } : {}),
  };
}

function ttsProviderFingerprint(context, model) {
  const parsed = parseCompatibleModelId(model);
  const connection = parsed && compatibleConnection(context, parsed.connectionId);
  const endpoint = parsed
    ? connection ? `${connection.ttsBaseUrl || connection.baseUrl}${OPENAI_COMPATIBLE_TTS_URL}` : ""
    : model === "mimo-v2.5-tts" ? `${context.config.providers.mimo.baseUrl}/chat/completions` : ELEVENLABS_URL;
  const apiKey = parsed
    ? connection ? runtimeCredential(context, connection.apiKeyEnv) : ""
    : model === "mimo-v2.5-tts" ? runtimeCredential(context, "MIMO_API_KEY") : runtimeCredential(context, "ELEVENLABS_API_KEY");
  const account = apiKey ? createHash("sha256").update(apiKey).digest("hex").slice(0, 16) : "";
  return { endpoint, account };
}

export async function callTextModel({ context, model, system, prompt, maxTokens, temperature, topP, effort }) {
  await awaitLatestModelCatalog(context);
  const compatible = parseCompatibleModelId(model);
  if (compatible) {
    const builtInId = builtInConnectionId(context.config, compatible.connectionId);
    if (builtInId === "chatgpt") {
      if (!availableModelIds(context).textModels.has(model)) throw badRequest(`Unsupported or inactive ChatGPT model "${model}".`);
      if (!context.chatgptAccountId) throw new ChatGptError("chatgpt_sign_in_required", { status: 401 });
      return context.chatgptClient.respond({ accountId: context.chatgptAccountId, model: compatible.modelId, system, prompt, ...(effort ? { effort } : {}) });
    }
    // ponytail: Responses API only for the built-in openai connection; compatible connections stay on chat/completions
    if (builtInId === "openai" && usesResponsesApi(compatible.modelId)) {
      return callOpenAiResponses(context, model, { system, prompt, maxTokens, effort }, LLM_TIMEOUT_MS);
    }
    if (builtInId === "opencode-go") {
      const protocol = openCodeGoProtocol(compatible.modelId);
      if (protocol === "messages") return callOpenCodeGoMessages(context, model, { system, prompt, maxTokens, temperature, topP }, LLM_TIMEOUT_MS);
      if (protocol !== "chat") throw badRequest(`Unsupported OpenCode Go model "${compatible.modelId}". Refresh models or update its protocol mapping.`);
    }
    const tokenLimit = builtInId === "openai" ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens };
    return callCompatibleChat(context, model, {
      model: compatible.modelId,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      ...tokenLimit,
      temperature,
      top_p: topP,
    }, LLM_TIMEOUT_MS);
  }
  return callMimo(context, {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_object" },
    max_completion_tokens: maxTokens,
    temperature,
    top_p: topP,
    thinking: { type: "disabled" },
  }, LLM_TIMEOUT_MS);
}

export function spokenTextForModel(context, modelId, text, language) {
  assertElevenLabsMarkup(modelId, text);
  const capability = ttsCueCapability(context, modelId, language);
  let spoken = String(text);
  if (!capability.squareTags) spoken = spoken.replace(TTS_CUE_RE, " ");
  if (!capability.breaks) spoken = spoken.replace(ELEVEN_BREAK_ANY_RE, " ");
  spoken = spoken.replace(/\s+/g, " ").trim();
  if (!spoken) throw badRequest("Transcript turn contains only unsupported nonverbal tags.");
  return spoken;
}

export function chatterboxSettings(speaker) {
  return {
    exaggeration: speaker.chatterboxExaggeration ?? CHATTERBOX_DEFAULTS.exaggeration,
    cfgWeight: speaker.chatterboxCfgWeight ?? CHATTERBOX_DEFAULTS.cfgWeight,
    temperature: speaker.chatterboxTemperature ?? CHATTERBOX_DEFAULTS.temperature,
  };
}

export function mimoTtsSettings(speaker) {
  return {
    temperature: speaker.mimoTemperature ?? MIMO_TTS_DEFAULTS.temperature,
    topP: speaker.mimoTopP ?? MIMO_TTS_DEFAULTS.topP,
    instructionPreset: speaker.mimoInstructionPreset || MIMO_TTS_DEFAULTS.instructionPreset,
    instructionText: speaker.mimoInstructionText || MIMO_TTS_DEFAULTS.instructionText,
  };
}

export function assertElevenLabsMarkup(model, text) {
  if (model === "eleven_v4" && /<\/?(?:speak|break|phoneme|prosody|emphasis|say-as|sub|voice|audio|p|s|lang|mark)\b[^>]*>/i.test(String(text))) {
    throw badRequest("eleven_v4 does not support SSML markup. Remove SSML tags and use audio tags or punctuation for pauses.");
  }
}

export function elevenLabsSettings(speaker, model) {
  const settings = {
    stability: speaker.elevenlabsStability ?? ELEVENLABS_DEFAULTS.stability,
    similarityBoost: speaker.elevenlabsSimilarityBoost ?? ELEVENLABS_DEFAULTS.similarityBoost,
    style: speaker.elevenlabsStyle ?? ELEVENLABS_DEFAULTS.style,
    useSpeakerBoost: speaker.elevenlabsUseSpeakerBoost !== false,
    speed: speaker.elevenlabsSpeed ?? ELEVENLABS_DEFAULTS.speed,
    seed: speaker.elevenlabsSeed ?? ELEVENLABS_DEFAULTS.seed,
    textNormalization: speaker.elevenlabsTextNormalization || ELEVENLABS_DEFAULTS.textNormalization,
  };
  const supported = [...elevenLabsCapabilities(model).voiceSettings, "seed", "textNormalization"];
  return Object.fromEntries(Object.entries(settings).filter(([key]) => supported.includes(key)));
}

export async function synthesizeTurn(context, profile, speaker, text, delivery, language) {
  await awaitLatestModelCatalog(context);
  const model = speaker.ttsModelOverride || profile.voiceModel;
  text = spokenTextForModel(context, model, text, language);
  const accent = speakerAccent(speaker, language);
  if (!availableModelIds(context).ttsModels.has(model)) throw badRequest(`Unsupported TTS model "${model}".`);
  const languageError = modelLanguageError(context, model, language);
  if (languageError) throw badRequest(languageError);
  if (parseCompatibleModelId(model)) {
    return synthesizeCompatible(context, model, speaker.voiceId, text, delivery, language, accent, speaker.style, chatterboxSettings(speaker));
  }
  if (isElevenLabsModel(context, model)) {
    return synthesizeElevenLabs(context, model, speaker.voiceId, text, delivery, language, elevenLabsSettings(speaker, model));
  }
  const mimoSettings = mimoTtsSettings(speaker);
  const instruction = [
    speaker.style,
    MIMO_INSTRUCTION_PRESETS[mimoSettings.instructionPreset] || "",
    mimoSettings.instructionText,
    delivery ? `Delivery for this turn: ${delivery}.` : "",
    `Required spoken language: ${language.name} (${language.id}).`,
    accent ? `Required accent: ${accent}.` : "",
    "The language and accent requirements override conflicting style directions. Speak the supplied text exactly. Do not translate, summarize, or add words.",
  ].filter(Boolean).join("\n");
  const payload = {
    model,
    messages: [
      { role: "user", content: instruction },
      { role: "assistant", content: text },
    ],
    audio: { format: "wav", voice: speaker.voiceId },
    stream: false,
  };
  if (mimoSettings.temperature != null) payload.temperature = mimoSettings.temperature;
  if (mimoSettings.topP != null) payload.top_p = mimoSettings.topP;
  const data = await callMimo(context, payload, TTS_TIMEOUT_MS);
  const audio = data?.choices?.[0]?.message?.audio?.data;
  if (!audio) throw new Error("MiMo TTS response did not include choices[0].message.audio.data.");
  const wav = Buffer.from(audio, "base64");
  if (wav.length > MAX_AUDIO_RESPONSE_BYTES) throw new Error(`MiMo TTS response exceeds ${MAX_AUDIO_RESPONSE_BYTES} byte audio limit.`);
  assertWav(wav);
  return { bytes: wav, contentType: "audio/wav", extension: "wav" };
}

async function synthesizeCompatible(context, compositeModelId, voiceId, text, delivery, language, accent, style, chatterbox) {
  const parsed = parseCompatibleModelId(compositeModelId);
  const connection = parsed && compatibleConnection(context, parsed.connectionId);
  if (!parsed || !connection) throw badRequest(`Unsupported compatible model "${compositeModelId}".`);
  const apiKey = runtimeCredential(context, connection.apiKeyEnv);
  if (connection.requiresApiKey && !apiKey) throw badRequest(`${connection.apiKeyEnv} is required in .env.`);
  const instructions = [
    style,
    delivery ? `Delivery for this turn: ${delivery}.` : "",
    `Required spoken language: ${language.name} (${language.id}).`,
    accent ? `Required accent: ${accent}.` : "",
    "Speak supplied text exactly. Do not translate, summarize, or add words.",
  ].filter(Boolean).join("\n");
  const body = {
    model: parsed.modelId,
    voice: voiceId,
    input: text,
    response_format: connection.kind === "chatterbox" ? "wav" : "mp3",
  };
  if (connection.kind === "chatterbox") {
    body.exaggeration = chatterbox.exaggeration;
    body.cfg_weight = chatterbox.cfgWeight;
    body.temperature = chatterbox.temperature;
    body.language = language.apiCode;
  }
  if (!OPENAI_TTS_NO_INSTRUCTIONS.has(parsed.modelId)) body.instructions = instructions;
  const label = `${connection.name} TTS`;
  let response;
  let bytes;
  try {
    response = await openAiClient({ baseURL: connection.ttsBaseUrl || connection.baseUrl, apiKey, fetch: cappedFetch(context.fetchImpl, MAX_AUDIO_RESPONSE_BYTES, label) }).audio.speech.create(body, callOptions(TTS_TIMEOUT_MS));
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw providerError(error, label, apiKeyName(connection), TTS_TIMEOUT_MS);
  }
  if (bytes.length === 0) throw new Error(`${label} returned empty audio.`);
  return {
    bytes,
    contentType: response.headers.get("content-type") || "audio/mpeg",
    extension: (response.headers.get("content-type") || "").includes("wav") ? "wav" : "mp3",
  };
}

async function synthesizeElevenLabs(context, model, voiceId, text, delivery, language, settings) {
  const apiKey = runtimeCredential(context, "ELEVENLABS_API_KEY");
  if (!apiKey) throw badRequest("ELEVENLABS_API_KEY is required in .env.");
  const cue = model === "eleven_v4" ? normalizeDelivery(delivery || "") : oneLine(delivery || "");
  assertElevenLabsMarkup(model, cue);
  const prefix = elevenLabsCapabilities(model).squareTags && cue ? `[${cue}] ` : "";
  const discoveredLimit = context.modelCatalog.providers.elevenlabs.ttsModels.find((item) => item.id === model)?.maximumTextLengthPerRequest;
  const defaultLimit = ({ eleven_v3: 5_000, eleven_multilingual_v2: 10_000, eleven_flash_v2: 30_000, eleven_turbo_v2: 30_000, eleven_flash_v2_5: 40_000, eleven_turbo_v2_5: 40_000 })[model] || 10_000;
  const maximum = model === "eleven_v4" ? Math.min(10_000, discoveredLimit || 10_000) : discoveredLimit || defaultLimit;
  const texts = splitElevenLabsText(text, prefix, maximum, model);
  const settingNames = { stability: "stability", similarityBoost: "similarity_boost", style: "style", useSpeakerBoost: "use_speaker_boost", speed: "speed" };
  const body = {
    model_id: model,
    language_code: language.apiCode,
    voice_settings: Object.fromEntries(elevenLabsCapabilities(model).voiceSettings.map((key) => [settingNames[key], settings[key]])),
    apply_text_normalization: settings.textNormalization,
  };
  if (settings.seed != null) body.seed = settings.seed;
  const chunks = [];
  let bytes = 0;
  for (const spokenText of texts) {
    const audio = await fetchBytes(
      context.fetchImpl,
      `${ELEVENLABS_URL}/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "xi-api-key": apiKey },
        body: JSON.stringify({ text: spokenText, ...body }),
      },
      "ElevenLabs TTS",
      TTS_TIMEOUT_MS
    );
    bytes += audio.bytes.length;
    if (bytes > MAX_AUDIO_RESPONSE_BYTES) throw new Error(`ElevenLabs turn audio exceeds ${MAX_AUDIO_RESPONSE_BYTES} byte limit.`);
    chunks.push(audio);
  }
  return chunks.length === 1 ? chunks[0] : { chunks, contentType: "audio/wav", extension: "wav" };
}

function splitElevenLabsText(text, prefix, maximum, model) {
  const budget = maximum - prefix.length;
  if (budget < 1) throw badRequest(`${model} delivery cue exceeds the ${maximum}-character request limit. Shorten the delivery cue.`);
  if (text.length > budget && /<\/?(?!break\b)[a-z][a-z0-9:-]*(?:\s[^<>]*)?\s*\/?>/i.test(text)) throw badRequest(`${model} cannot safely split SSML markup within the ${maximum}-character request limit. Shorten the turn or use separate turns.`);
  const chunks = [];
  let remaining = text;
  while (remaining.length > budget) {
    let insideTag = false;
    let insideMarkup = false;
    let boundary = 0;
    let sentenceBoundary = 0;
    for (let index = 0; index <= budget; index += 1) {
      const character = remaining[index];
      if (character === "[") insideTag = true;
      if (character === "]") insideTag = false;
      if (character === "<" && /^<break\b[^<>]*\/?>/i.test(remaining.slice(index))) insideMarkup = true;
      if (character === ">") insideMarkup = false;
      if (!insideTag && !insideMarkup && /[。！？]/u.test(character) && index + 1 <= budget) {
        boundary = index + 1;
        sentenceBoundary = index + 1;
      }
      if (character === " " && !insideTag && !insideMarkup) {
        boundary = index;
        if (/[.!?。！？…]/u.test(remaining[index - 1] || "")) sentenceBoundary = index;
      }
    }
    const end = sentenceBoundary >= budget / 2 ? sentenceBoundary : boundary;
    if (!end) throw badRequest(`${model} cannot split this turn within the ${maximum}-character request limit without cutting a word or audio tag. Add a space or shorten the text or delivery cue.`);
    chunks.push(prefix + remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) chunks.push(prefix + remaining);
  return chunks;
}

export async function fetchElevenLabsVoices(context, timeoutMs = TTS_TIMEOUT_MS) {
  const apiKey = runtimeCredential(context, "ELEVENLABS_API_KEY");
  if (!apiKey) throw badRequest("ELEVENLABS_API_KEY is required in .env.");
  const data = await fetchJsonWithBody(context.fetchImpl, ELEVENLABS_VOICES_URL, { headers: { "xi-api-key": apiKey } }, "ElevenLabs voices", timeoutMs);
  const voices = (data?.voices || []).map((voice) => ({
    id: voice.voice_id,
    name: voice.name,
    labels: voice.labels || {},
    verifiedLanguages: (Array.isArray(voice.verified_languages) ? voice.verified_languages : []).map((language) => ({
      language: language.language,
      locale: language.locale,
      accent: language.accent,
    })),
  }));
  return { voices, hasMore: Boolean(data?.has_more) };
}

export async function fetchChatterboxVoices(context, timeoutMs = MODEL_TIMEOUT_MS, useCache = false) {
  const cache = context.chatterboxVoiceCache;
  if (useCache && cache?.voices) return cache.voices;
  const cacheRevision = cache?.revision;
  const connection = builtInChatterboxConnection(context.config);
  if (!connection.enabled || !connection.baseUrl) throw badRequest("Chatterbox is not configured.");
  const apiKey = runtimeCredential(context, "CHATTERBOX_API_KEY");
  const data = await fetchJsonWithBody(
    context.fetchImpl,
    `${connection.baseUrl}/voices`,
    { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} },
    "Chatterbox voices",
    timeoutMs
  );
  const items = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.voices) ? data.voices : [];
  const voices = items.filter((voice) => typeof voice?.id === "string" && voice.id.trim()).map((voice) => ({
    id: voice.id.trim(),
    name: typeof voice.name === "string" && voice.name.trim() ? voice.name.trim() : voice.id.trim(),
    builtin: voice.builtin === true,
  }));
  if (cache?.revision === cacheRevision) cache.voices = voices;
  return voices;
}

function runtimeCredential(context, name) {
  return context.credentials ? context.credentials[name] || "" : process.env[name]?.trim() || "";
}

async function callMimo(context, payload, timeoutMs) {
  const apiKey = runtimeCredential(context, "MIMO_API_KEY");
  if (!apiKey) throw badRequest("MIMO_API_KEY is required in .env.");
  let data;
  try {
    data = await sdkJson(openAiClient({
      baseURL: context.config.providers.mimo.baseUrl,
      apiKey,
      headers: { Authorization: null, "api-key": apiKey },
      fetch: cappedFetch(context.fetchImpl, payload.audio ? MAX_TTS_JSON_RESPONSE_BYTES : MAX_JSON_RESPONSE_BYTES, "MiMo"),
    }).chat.completions.create(payload, callOptions(timeoutMs, payload.audio ? 0 : LLM_RETRIES)), "MiMo");
  } catch (error) {
    throw providerError(error, "MiMo", "MIMO_API_KEY", timeoutMs);
  }
  if (data?.error) throw new Error(`MiMo request failed: ${data.error.message || JSON.stringify(data.error)}`);
  return data;
}

async function callCompatibleChat(context, compositeModelId, payload, timeoutMs) {
  const parsed = parseCompatibleModelId(compositeModelId);
  const connection = parsed && compatibleConnection(context, parsed.connectionId);
  if (!parsed || !connection) throw badRequest(`Unsupported compatible model "${compositeModelId}".`);
  const apiKey = await connectionApiKey(context, connection);
  if (connection.requiresApiKey && !apiKey) throw badRequest(connection.kind === "opencodeGo"
    ? "OpenCode Go login is required. Run /connect in OpenCode or set OPENCODE_GO_API_KEY."
    : `${connection.apiKeyEnv} is required in .env.`);
  const label = `${connection.name} chat`;
  try {
    return await sdkJson(openAiClient({ baseURL: connection.llmBaseUrl || connection.baseUrl, apiKey, fetch: cappedFetch(context.fetchImpl, MAX_JSON_RESPONSE_BYTES, label) })
      .chat.completions.create(payload, callOptions(timeoutMs, LLM_RETRIES)), label);
  } catch (error) {
    throw providerError(error, label, apiKeyName(connection), timeoutMs);
  }
}

async function connectionApiKey(context, connection) {
  if (context.credentials) return runtimeCredential(context, connection.apiKeyEnv);
  if (connection.kind === "opencodeGo") return (await resolveOpenCodeGoCredential()).key;
  return runtimeCredential(context, connection.apiKeyEnv);
}

async function callOpenCodeGoMessages(context, compositeModelId, { system, prompt, maxTokens, temperature, topP }, timeoutMs) {
  const parsed = parseCompatibleModelId(compositeModelId);
  const connection = parsed && compatibleConnection(context, parsed.connectionId);
  if (!parsed || connection?.kind !== "opencodeGo") throw badRequest(`Unsupported OpenCode Go model "${compositeModelId}".`);
  const apiKey = await connectionApiKey(context, connection);
  if (!apiKey) throw badRequest("OpenCode Go login is required. Run /connect in OpenCode or set OPENCODE_GO_API_KEY.");
  const label = `${connection.name} messages`;
  let data;
  try {
    // The SDK adds /v1/messages itself.
    data = await sdkJson(anthropicClient({ baseURL: connection.baseUrl.replace(/\/v1$/, ""), apiKey, fetch: cappedFetch(context.fetchImpl, MAX_JSON_RESPONSE_BYTES, label) }).messages.create({
      model: parsed.modelId,
      system,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature,
      top_p: topP,
    }, callOptions(timeoutMs, LLM_RETRIES)), label);
  } catch (error) {
    throw providerError(error, label, apiKeyName(connection), timeoutMs);
  }
  const text = Array.isArray(data?.content)
    ? data.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
    : "";
  if (!text) throw new Error(`${connection.name} messages did not include text content.`);
  return { choices: [{ message: { content: text } }] };
}

async function callOpenAiResponses(context, compositeModelId, { system, prompt, maxTokens, effort }, timeoutMs) {
  const parsed = parseCompatibleModelId(compositeModelId);
  const connection = parsed && compatibleConnection(context, parsed.connectionId);
  if (!parsed || !connection) throw badRequest(`Unsupported compatible model "${compositeModelId}".`);
  const apiKey = await connectionApiKey(context, connection);
  if (connection.requiresApiKey && !apiKey) throw badRequest(`${connection.apiKeyEnv} is required in .env.`);
  const body = {
    model: parsed.modelId,
    instructions: system,
    input: prompt,
    max_output_tokens: maxTokens,
    text: { format: { type: "json_object" } },
    // ponytail: no temperature/top_p — reasoning models reject them
    ...(effort && effortLevelsForModel(parsed.modelId).includes(effort) ? { reasoning: { effort } } : {}),
  };
  const label = `${connection.name} responses`;
  let data;
  try {
    data = await sdkJson(openAiClient({ baseURL: connection.llmBaseUrl || connection.baseUrl, apiKey, fetch: cappedFetch(context.fetchImpl, MAX_JSON_RESPONSE_BYTES, label) })
      .responses.create(body, callOptions(timeoutMs, LLM_RETRIES)), label);
  } catch (error) {
    throw providerError(error, label, apiKeyName(connection), timeoutMs);
  }
  const text = data?.output_text
    || (Array.isArray(data?.output) ? data.output.flatMap((item) => item?.content || []).find((part) => part?.type === "output_text")?.text : "");
  if (!text) throw new Error(`${connection.name} responses did not include output text.`);
  // ponytail: shim to chat/completions shape so every caller stays untouched
  return { choices: [{ message: { content: text } }] };
}

export function parseChatJson(data, label) {
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`${label} response did not include choices[0].message.content.`);
  try {
    return parseJsonLoose(content);
  } catch (error) {
    throw new Error(`${label} response was not valid JSON: ${error.message}`);
  }
}

export function parseJsonLoose(content) {
  const text = String(content ?? "").trim();
  try {
    return JSON.parse(text);
  } catch (error) {
    // ponytail: models wrap JSON in ``` fences or prose; salvage the outermost object before giving up
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw error;
    return JSON.parse(text.slice(start, end + 1));
  }
}

export function assertWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.subarray(0, 4).toString("ascii") !== "RIFF" || buffer.subarray(8, 12).toString("ascii") !== "WAVE") {
    throw new Error("MiMo TTS returned audio data, but it is not a WAV RIFF file.");
  }
}
