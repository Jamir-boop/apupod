// Shared test helpers. The file name has no .test suffix, so `npm test` does not run it as a test file.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPodcastServer } from "../src/app.mjs";

export const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
export const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
export const source = (name) => script.match(new RegExp(`    (?:async )?function ${name}\\([^]*?\\n    }`))[0];

export function setEnv(values) {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === null) delete process.env[name];
    else process.env[name] = value;
  }
}

// Only the first value seen per test is saved, so repeated calls in one test still restore the original environment.
const savedEnv = new WeakMap();
export function withEnv(t, values) {
  let saved = savedEnv.get(t);
  if (!saved) {
    savedEnv.set(t, saved = {});
    t.after(() => setEnv(saved));
  }
  for (const name of Object.keys(values)) if (!Object.hasOwn(saved, name)) saved[name] = process.env[name];
  setEnv(values);
}

const testServers = new Map();
export function fetch(input, options = {}) {
  const url = new URL(input instanceof Request ? input.url : input);
  const token = testServers.get(url.origin);
  const headers = new Headers(options.headers || (input instanceof Request ? input.headers : undefined));
  if (token && url.pathname.startsWith("/api/") && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  return globalThis.fetch(input, { ...options, headers });
}

export const sendJson = (url, body, method = "POST") => fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export function createApi(baseUrl) {
  return async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await (body === undefined ? fetch(baseUrl + path, { method }) : sendJson(baseUrl + path, body, method));
    return { status: response.status, value: response.headers.get("content-type")?.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  };
}

// Pass `rootDir` to restart on the directory of an earlier server; only a directory this call creates is removed.
export async function startTestServer(t, { rootDir, ...options } = {}, prepare) {
  if (!rootDir) {
    rootDir = await mkdtemp(join(tmpdir(), "apupod-test-"));
    t.after(() => rm(rootDir, { recursive: true, force: true }));
  }
  await prepare?.(rootDir);
  const server = await createPodcastServer({ rootDir, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = () => new Promise((resolve) => server.close(resolve));
  t.after(close);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  testServers.set(baseUrl, (await readFile(join(options.configDir || rootDir, "mcp-token"), "utf8")).trim());
  t.after(() => testServers.delete(baseUrl));
  return { rootDir, baseUrl, api: createApi(baseUrl), close };
}

// POST a knowledge base, POST an episode on it, and PUT the transcript when one is given.
export async function seedEpisode(baseUrl, name, { knowledge = "# Source", transcript } = {}) {
  const kb = await (await sendJson(`${baseUrl}/api/knowledge`, { name: "book.md", content: knowledge })).json();
  const episode = await (await sendJson(`${baseUrl}/api/episodes`, { name, episodeProfileId: "episode-example-format", knowledgeBaseId: kb.id })).json();
  if (transcript !== undefined) await sendJson(`${baseUrl}/api/episodes/${episode.id}/transcript`, { transcript }, "PUT");
  return episode;
}

export async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Condition not met within ${timeoutMs} ms.`);
}

export function silentWav(sampleRate = 24_000, channels = 1, durationSeconds = 0.01) {
  const samples = Math.round(sampleRate * durationSeconds);
  const blockAlign = channels * 2;
  const buffer = Buffer.alloc(44 + samples * blockAlign);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVE", 8);
  buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * blockAlign, 28); buffer.writeUInt16LE(blockAlign, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(samples * blockAlign, 40);
  return buffer;
}
