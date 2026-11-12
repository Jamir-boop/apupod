export const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_AUDIO_RESPONSE_BYTES = 128 * 1024 * 1024;
export const MAX_TTS_JSON_RESPONSE_BYTES = Math.ceil(MAX_AUDIO_RESPONSE_BYTES * 4 / 3) + 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
export const MODEL_TIMEOUT_MS = 15_000;
export const TTS_TIMEOUT_MS = 120_000;

export async function fetchJson(fetchImpl, url, headers, label) {
  return fetchJsonWithBody(fetchImpl, url, { headers }, label, MODEL_TIMEOUT_MS);
}

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
  return result.replace(/(Bearer\s+|(?i:(?:x-|xi-)?api-key)["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{12,}/g, "$1[redacted]")
    // Key shapes a provider may echo (OpenAI sk-/sk-proj-, ElevenLabs sk_ or 32+ hex) and masked fragments such as "sk-proj-****…RNQA".
    .replace(/\bsk[-_][\w*…-]{6,}|\b[A-Fa-f0-9]{32,}\b|[\w-]*\*{3,}[\w*…-]*/g, "[redacted]");
}

export function providerUrl(baseURL, path) {
  if (!baseURL) throw new Error("Provider base URL is not configured.");
  if (/^https?:\/\//i.test(path)) return path;
  const base = new URL(baseURL);
  const query = base.search;
  if (query) { base.search = ""; base.hash = ""; baseURL = String(base); }
  const url = new URL(baseURL + (baseURL.endsWith("/") && path.startsWith("/") ? path.slice(1) : path));
  if (query) url.search = query;
  return String(url);
}

// fetch drops only Authorization on a cross-origin redirect, so a client that sends the key in another header must not follow one.
const NO_REDIRECT = { redirect: "error" };
const sendsKeyHeader = (headers) => KEY_HEADERS.some((name) => name !== "authorization" && headers.has(name));
const rawOptions = (options, signal) => ({ ...(sendsKeyHeader(new Headers(options?.headers ?? undefined)) ? NO_REDIRECT : {}), ...options, signal });

// Undici reports a refused redirect as "fetch failed" and keeps the reason ("unexpected redirect") on the deepest cause.
function causeMessage(error) {
  let deepest = error;
  for (let depth = 0; depth < 10 && deepest?.cause?.message; depth++) deepest = deepest.cause;
  const message = error?.message || String(error);
  return deepest !== error && deepest.message !== message ? `${message} (${deepest.message})` : message;
}

// apiKey is the key this call sent: it is redacted from every message, and no key means a 401 or 403 asks for one.
export function providerError(error, label, keyName, timeoutMs, apiKey) {
  const result = providerMessage(error, label, keyName, timeoutMs, Boolean(apiKey));
  if (result instanceof Error) result.message = redactSecrets(result.message, [apiKey]);
  return result;
}

function providerMessage(error, label, keyName, timeoutMs, keySent) {
  const tooLarge = [error, error?.cause].find((item) => item?.code === "response_too_large");
  if (tooLarge) return new Error(`${label} request failed: ${tooLarge.message}`);
  if (["AbortError", "TimeoutError"].includes(error?.name)) return new Error(`${label} request timed out after ${timeoutMs / 1000} seconds.`);
  if (error instanceof SyntaxError) return new Error(`${label} response was not valid JSON.`);
  if (!error?.status) return error;
  const detail = error.error?.error?.message ?? error.error?.message ?? error.message;
  if (!keySent && (error.status === 401 || error.status === 403)) return new Error(`${label} request failed: HTTP ${error.status}. The provider requires an API key and none is configured. Set ${keyName} in .env, then refresh models. ${detail}`);
  if (error.status === 401 || error.status === 403) return new Error(`${label} request failed: HTTP ${error.status}. The provider rejected ${keyName}${error.status === 403 ? " for this model or endpoint" : ""}. Check the key. ${detail}`);
  if (error.status === 429 || error.type === "rate_limit_error") return new Error(`${label} is rate-limited (HTTP 429). Wait, then try again. ${detail}`);
  if (error.status === 529 || error.type === "overloaded_error") return new Error(`${label} is overloaded (HTTP 529). Try again shortly. ${detail}`);
  return new Error(`${label} request failed: ${error.status ? `HTTP ${error.status} ` : ""}${detail}`);
}

function responseError(response, text, label, keyName, options) {
  let data;
  try { data = JSON.parse(text); } catch {}
  if (!keyName) return new Error(redactSecrets(`${label} request failed: HTTP ${response.status} ${data?.error?.message || data?.detail?.message || text || response.statusText}`, sentKeys(options)));
  return providerError({ status: response.status, type: data?.error?.type, message: data?.error?.message || data?.detail?.message || text || response.statusText }, label, keyName, 0, sentKeys(options)[0]);
}

export async function fetchJsonWithBody(fetchImpl, url, options, label, timeoutMs, maximum = MAX_JSON_RESPONSE_BYTES, keyName) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(url, rawOptions(options, signal));
    let text;
    try { text = (await readResponseBuffer(response, maximum, label)).toString("utf8"); }
    catch (error) { if (response.ok || !keyName || error.code !== "response_too_large") throw error; text = error.message; }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!response.ok) throw responseError(response, text, label, keyName, options);
    if (data == null) throw new Error(`${label} response was not valid JSON.`);
    if (keyName && data.error && typeof data.error === "object") throw new Error(redactSecrets(`${label} request failed: ${data.error.message || JSON.stringify(data.error)}`, sentKeys(options)));
    return data;
  } catch (error) {
    if (signal.aborted || keyName && ["AbortError", "TimeoutError"].includes(error?.name)) throw new Error(`${label} request timed out after ${timeoutMs / 1000} seconds.`);
    if (String(error?.message || error).startsWith(`${label} request`) || keyName && (error.message === `${label} response was not valid JSON.` || error.message.startsWith(`${label} is `))) { error.message = redactSecrets(error.message, sentKeys(options)); throw error; }
    throw new Error(redactSecrets(`${label} request failed: ${causeMessage(error)}`, sentKeys(options)));
  }
}

export async function fetchBytes(fetchImpl, url, options, label, timeoutMs, keyName) {
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  let bytes;
  try {
    response = await fetchImpl(url, rawOptions(options, signal));
    try { bytes = await readResponseBuffer(response, MAX_AUDIO_RESPONSE_BYTES, label); }
    catch (error) { if (response.ok || !keyName || error.code !== "response_too_large") throw error; bytes = Buffer.from(error.message); }
  } catch (error) {
    if (signal.aborted || keyName && ["AbortError", "TimeoutError"].includes(error?.name)) throw new Error(`${label} request timed out after ${timeoutMs / 1000} seconds.`);
    throw new Error(redactSecrets(`${label} request failed: ${causeMessage(error)}`, sentKeys(options)));
  }
  if (!response.ok) {
    if (keyName) throw responseError(response, bytes.toString("utf8"), label, keyName, options);
    throw new Error(redactSecrets(`${label} request failed: HTTP ${response.status} ${bytes.toString("utf8") || response.statusText}`, sentKeys(options)));
  }
  return audioResult(bytes, response.headers.get("content-type"), label, sentKeys(options));
}

// A 2xx JSON or text body is a provider error page, not audio; ffmpeg would only report it as a decode failure.
export function audioResult(bytes, contentType, label, keys) {
  if (bytes.length === 0) throw new Error(`${label} returned empty audio.`);
  if (/json|^text\//i.test(contentType || "")) throw new Error(redactSecrets(`${label} returned ${contentType} instead of audio: ${bytes.toString("utf8", 0, 500)}`, keys));
  return { bytes, contentType: contentType || "audio/mpeg", extension: (contentType || "").includes("wav") ? "wav" : "mp3", label };
}
