export const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_AUDIO_RESPONSE_BYTES = 128 * 1024 * 1024;
export const MAX_TTS_JSON_RESPONSE_BYTES = Math.ceil(MAX_AUDIO_RESPONSE_BYTES * 4 / 3) + 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
export const MODEL_TIMEOUT_MS = 15_000;
export const LLM_TIMEOUT_MS = 240_000;
export const TTS_TIMEOUT_MS = 120_000;

export async function fetchJson(fetchImpl, url, headers, label) {
  return fetchJsonWithBody(fetchImpl, url, { headers }, label, MODEL_TIMEOUT_MS);
}

export async function readResponseBuffer(response, maximum, label) {
  const limit = response.ok ? maximum : MAX_ERROR_RESPONSE_BYTES;
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > limit) throw new Error(`${label} response exceeds ${limit} byte limit.`);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body || []) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new Error(`${label} response exceeds ${limit} byte limit.`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

export async function fetchJsonWithBody(fetchImpl, url, options, label, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const text = (await readResponseBuffer(response, MAX_JSON_RESPONSE_BYTES, label)).toString("utf8");
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!response.ok) throw new Error(`${label} request failed: HTTP ${response.status} ${data?.error?.message || data?.detail?.message || text || response.statusText}`);
    if (data == null) throw new Error(`${label} response was not valid JSON.`);
    return data;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`${label} request timed out after ${timeoutMs / 1000} seconds.`);
    if (String(error?.message || error).startsWith(`${label} request`)) throw error;
    throw new Error(`${label} request failed: ${error.message || error}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBytes(fetchImpl, url, options, label, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const bytes = await readResponseBuffer(response, MAX_AUDIO_RESPONSE_BYTES, label);
    if (!response.ok) throw new Error(`${label} request failed: HTTP ${response.status} ${bytes.toString("utf8") || response.statusText}`);
    if (bytes.length === 0) throw new Error(`${label} returned empty audio.`);
    return {
      bytes,
      contentType: response.headers.get("content-type") || "audio/mpeg",
      extension: (response.headers.get("content-type") || "").includes("wav") ? "wav" : "mp3",
    };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`${label} request timed out after ${timeoutMs / 1000} seconds.`);
    if (String(error?.message || error).startsWith(`${label} request`)) throw error;
    throw new Error(`${label} request failed: ${error.message || error}`);
  } finally {
    clearTimeout(timer);
  }
}
