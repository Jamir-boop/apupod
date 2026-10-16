import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

export const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_AUDIO_RESPONSE_BYTES = 128 * 1024 * 1024;
export const MAX_TTS_JSON_RESPONSE_BYTES = Math.ceil(MAX_AUDIO_RESPONSE_BYTES * 4 / 3) + 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
export const MODEL_TIMEOUT_MS = 15_000;
export const LLM_TIMEOUT_MS = 240_000;
export const TTS_TIMEOUT_MS = 120_000;
export const MAX_STREAM_RESPONSE_BYTES = 32 * 1024 * 1024;
export const LLM_RETRIES = 2;

export async function fetchJson(fetchImpl, url, headers, label) {
  return fetchJsonWithBody(fetchImpl, url, { headers }, label, MODEL_TIMEOUT_MS);
}

// One byte cap for raw reads and SDK clients. It fails the body stream, not fetch(), so an SDK never retries it as a connection error.
function capResponse(response, maximum, label) {
  const limit = response.ok ? maximum : MAX_ERROR_RESPONSE_BYTES;
  const tooLarge = () => Object.assign(new Error(`${label} response exceeds ${limit} byte limit.`), { code: "response_too_large" });
  const declared = Number(response.headers.get("content-length") || 0);
  let bytes = 0;
  const body = response.body?.pipeThrough(new TransformStream({
    start(controller) { if (Number.isFinite(declared) && declared > limit) controller.error(tooLarge()); },
    transform(chunk, controller) { bytes += chunk.byteLength; if (bytes > limit) controller.error(tooLarge()); else controller.enqueue(chunk); },
  }));
  return new Response(body ?? null, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export async function readResponseBuffer(response, maximum, label) {
  return Buffer.from(await capResponse(response, maximum, label).arrayBuffer());
}

const KEY_HEADERS = ["authorization", "x-api-key", "api-key", "xi-api-key"];

// The key values this request sent, so an error body that echoes one never reaches a message.
function sentKeys(init) {
  const headers = new Headers(init?.headers ?? undefined);
  return KEY_HEADERS.map((name) => headers.get(name)?.replace(/^Bearer\s+/i, "").trim()).filter(Boolean);
}

export function redactSecrets(text, keys = []) {
  let result = String(text);
  for (const key of keys) if (key?.length >= 6) result = result.replaceAll(key, "[redacted]");
  // Only token-like values, so "Missing bearer token" or "api-key: missing" keep their meaning.
  return result.replace(/(Bearer\s+|(?i:(?:x-|xi-)?api-key)["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{12,}/g, "$1[redacted]");
}

// The SDKs keep only body.error of an error body. This keeps the old detail rule: error.message, then detail.message, then raw text.
async function errorResponse(response, label, keys) {
  let text;
  try { text = (await readResponseBuffer(response, MAX_ERROR_RESPONSE_BYTES, label)).toString("utf8"); }
  catch (error) { if (error.code !== "response_too_large") throw error; text = error.message; }
  text = redactSecrets(text, keys);
  let data = null;
  try { data = JSON.parse(text); } catch {}
  const error = data?.error && typeof data.error === "object" ? data.error : {};
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  // The Anthropic SDK honors any retry-after, which could outlast the call deadline; keep the OpenAI SDK rule (over 60 s means default backoff).
  let waitMs = parseFloat(headers.get("retry-after-ms"));
  const retryAfter = headers.get("retry-after");
  if (Number.isNaN(waitMs) && retryAfter) waitMs = Number.isNaN(parseFloat(retryAfter)) ? Date.parse(retryAfter) - Date.now() : parseFloat(retryAfter) * 1000;
  if (waitMs > 60_000) { headers.delete("retry-after-ms"); headers.delete("retry-after"); }
  return new Response(JSON.stringify({ error: { ...error, message: data?.error?.message || data?.detail?.message || text || response.statusText } }), { status: response.status, statusText: response.statusText, headers });
}

export function cappedFetch(fetchImpl, maximum, label) {
  return async (url, init) => {
    const response = await fetchImpl(url, init);
    return response.ok ? capResponse(response, maximum, label) : errorResponse(response, label, sentKeys(init));
  };
}

// The SDKs read OPENAI_CUSTOM_HEADERS and ANTHROPIC_CUSTOM_HEADERS in the constructor and send them to every host, including an Authorization line.
function withoutEnv(name, create) {
  const saved = process.env[name];
  delete process.env[name];
  try { return create(); } finally { if (saved !== undefined) process.env[name] = saved; }
}

// An empty baseURL makes the SDKs fall back to api.openai.com or api.anthropic.com, which would send the key to the wrong host.
function requireBaseURL(baseURL) {
  if (!baseURL) throw new Error("Provider base URL is not configured.");
}

// fetch drops only Authorization on a cross-origin redirect, so a client that sends the key in another header must not follow one.
const NO_REDIRECT = { redirect: "error" };
const rawOptions = (options, signal) => {
  const headers = new Headers(options?.headers ?? undefined);
  return { ...(KEY_HEADERS.some((name) => name !== "authorization" && headers.has(name)) ? NO_REDIRECT : {}), ...options, signal };
};

export function openAiClient({ baseURL, apiKey, headers, fetch, fetchOptions }) {
  requireBaseURL(baseURL);
  return withoutEnv("OPENAI_CUSTOM_HEADERS", () => new OpenAI({
    baseURL, apiKey: apiKey || "none",
    // Explicit nulls stop the SDK reading OPENAI_ADMIN_KEY, OPENAI_ORG_ID, OPENAI_PROJECT_ID and OPENAI_WEBHOOK_SECRET.
    adminAPIKey: null, organization: null, project: null, webhookSecret: null,
    // "none" only satisfies the constructor. The null header removes it, so a keyless server gets no Authorization.
    defaultHeaders: { ...(apiKey ? {} : { Authorization: null }), ...headers },
    fetch, fetchOptions: headers?.["api-key"] ? { ...NO_REDIRECT, ...fetchOptions } : fetchOptions, maxRetries: 0, logLevel: "off",
  }));
}

export function anthropicClient({ baseURL, apiKey, fetch }) {
  // Explicit baseURL, apiKey and authToken stop the SDK reading ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN and profiles.
  requireBaseURL(baseURL);
  return withoutEnv("ANTHROPIC_CUSTOM_HEADERS", () => new Anthropic({ baseURL, apiKey, authToken: null, fetch, fetchOptions: NO_REDIRECT, maxRetries: 0, logLevel: "off" }));
}

// The SDK timeout covers one attempt (for a stream, only until headers). The signal is the app's total deadline across retries and the body.
export const callOptions = (timeoutMs, maxRetries = 0) => ({ timeout: timeoutMs, maxRetries, signal: AbortSignal.timeout(timeoutMs) });

// The SDKs parse only application/json. The app has always parsed any 2xx body as JSON.
export async function sdkJson(request, label) {
  const text = await (await request.asResponse()).text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (data == null) throw new Error(`${label} response was not valid JSON.`);
  if (data.error && typeof data.error === "object") throw new Error(`${label} request failed: ${data.error.message || JSON.stringify(data.error)}`);
  return data;
}

// Undici reports a refused redirect as "fetch failed" and keeps the reason ("unexpected redirect") on the deepest cause.
function causeMessage(error) {
  let deepest = error;
  for (let depth = 0; depth < 10 && deepest?.cause?.message; depth++) deepest = deepest.cause;
  const message = error?.message || String(error);
  return deepest !== error && deepest.message !== message ? `${message} (${deepest.message})` : message;
}

const sdkError = (error, name) => error instanceof OpenAI[name] || error instanceof Anthropic[name];

// apiKey is the key this call sent: it is redacted from every message, and no key means a 401 or 403 asks for one.
export function providerError(error, label, keyName, timeoutMs, apiKey) {
  const result = providerMessage(error, label, keyName, timeoutMs, Boolean(apiKey));
  if (result instanceof Error) result.message = redactSecrets(result.message, [apiKey]);
  return result;
}

function providerMessage(error, label, keyName, timeoutMs, keySent) {
  const tooLarge = [error, error?.cause].find((item) => item?.code === "response_too_large");
  if (tooLarge) return new Error(`${label} request failed: ${tooLarge.message}`);
  if (sdkError(error, "APIUserAbortError") || sdkError(error, "APIConnectionTimeoutError") || ["AbortError", "TimeoutError"].includes(error?.name)) return new Error(`${label} request timed out after ${timeoutMs / 1000} seconds.`);
  if (sdkError(error, "APIConnectionError")) return new Error(`${label} request failed: ${causeMessage(error.cause?.message ? error.cause : error)}`);
  if (error instanceof SyntaxError) return new Error(`${label} response was not valid JSON.`);
  if (!sdkError(error, "APIError")) return error;
  const detail = error.error?.error?.message ?? error.error?.message ?? error.message;
  if (!keySent && (error.status === 401 || error.status === 403)) return new Error(`${label} request failed: HTTP ${error.status}. The provider requires an API key and none is configured. Set ${keyName} in .env, then refresh models. ${detail}`);
  if (error.status === 401 || error.status === 403) return new Error(`${label} request failed: HTTP ${error.status}. The provider rejected ${keyName}${error.status === 403 ? " for this model or endpoint" : ""}. Check the key. ${detail}`);
  if (error.status === 429 || error.type === "rate_limit_error") return new Error(`${label} is rate-limited (HTTP 429). Wait, then try again. ${detail}`);
  if (error.status === 529 || error.type === "overloaded_error") return new Error(`${label} is overloaded (HTTP 529). Try again shortly. ${detail}`);
  return new Error(`${label} request failed: ${error.status ? `HTTP ${error.status} ` : ""}${detail}`);
}

export async function fetchJsonWithBody(fetchImpl, url, options, label, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(url, rawOptions(options, signal));
    const text = (await readResponseBuffer(response, MAX_JSON_RESPONSE_BYTES, label)).toString("utf8");
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!response.ok) throw new Error(redactSecrets(`${label} request failed: HTTP ${response.status} ${data?.error?.message || data?.detail?.message || text || response.statusText}`, sentKeys(options)));
    if (data == null) throw new Error(`${label} response was not valid JSON.`);
    return data;
  } catch (error) {
    if (signal.aborted) throw new Error(`${label} request timed out after ${timeoutMs / 1000} seconds.`);
    if (String(error?.message || error).startsWith(`${label} request`)) throw error;
    throw new Error(redactSecrets(`${label} request failed: ${causeMessage(error)}`, sentKeys(options)));
  }
}

export async function fetchBytes(fetchImpl, url, options, label, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  let bytes;
  try {
    response = await fetchImpl(url, rawOptions(options, signal));
    bytes = await readResponseBuffer(response, MAX_AUDIO_RESPONSE_BYTES, label);
  } catch (error) {
    if (signal.aborted) throw new Error(`${label} request timed out after ${timeoutMs / 1000} seconds.`);
    throw new Error(redactSecrets(`${label} request failed: ${causeMessage(error)}`, sentKeys(options)));
  }
  if (!response.ok) throw new Error(redactSecrets(`${label} request failed: HTTP ${response.status} ${bytes.toString("utf8") || response.statusText}`, sentKeys(options)));
  return audioResult(bytes, response.headers.get("content-type"), label, sentKeys(options));
}

// A 2xx JSON or text body is a provider error page, not audio; ffmpeg would only report it as a decode failure.
export function audioResult(bytes, contentType, label, keys) {
  if (bytes.length === 0) throw new Error(`${label} returned empty audio.`);
  if (/json|^text\//i.test(contentType || "")) throw new Error(redactSecrets(`${label} returned ${contentType} instead of audio: ${bytes.toString("utf8", 0, 500)}`, keys));
  return { bytes, contentType: contentType || "audio/mpeg", extension: (contentType || "").includes("wav") ? "wav" : "mp3", label };
}
