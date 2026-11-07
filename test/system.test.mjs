import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { REGISTRY_URL, OWN_BIN, compareVersions, newestBin } from "../src/system.mjs";
import { silentWav, startTestServer, waitFor, withEnv } from "./helpers.mjs";

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const NO_KEYS = { MIMO_API_KEY: undefined, ELEVENLABS_API_KEY: undefined, OPENAI_API_KEY: undefined, CHATTERBOX_API_KEY: undefined, TYPESAFE_API_KEY: undefined, PORT: undefined };
const INITIALIZE = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "system-test", version: "1.2.3" } } };

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const postMcp = (baseUrl, token, body = INITIALIZE) => fetch(`${baseUrl}/mcp`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify(body),
});

// Registry answers come from `registry`; every other URL answers an empty model list.
function stubFetch(state) {
  return async (url, options) => {
    if (String(url) === REGISTRY_URL) {
      state.registryCalls = (state.registryCalls || 0) + 1;
      return state.registry();
    }
    return state.other ? state.other(url, options) : Response.json({ data: [] });
  };
}

test("compareVersions orders releases and prereleases; newestBin prefers a newer runtime apupod", async (t) => {
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.1.0", "1.1.0"), 0);
  assert.equal(compareVersions("1.1.0-beta.2", "1.1.0"), -1);
  assert.equal(compareVersions("1.1.0", "v1.1.0-rc.1"), 1);
  assert.equal(compareVersions("latest", "1.0.0"), null);

  const dataDir = await mkdtemp(join(tmpdir(), "apupod-runtime-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  assert.deepEqual(newestBin(dataDir), { bin: OWN_BIN, version });
  const runtime = join(dataDir, "runtime", "node_modules", "apupod");
  await mkdir(join(runtime, "bin"), { recursive: true });
  await writeFile(join(runtime, "package.json"), JSON.stringify({ version: "0.0.1" }));
  await writeFile(join(runtime, "bin", "apupod.mjs"), "");
  assert.deepEqual(newestBin(dataDir), { bin: OWN_BIN, version }, "an older runtime is ignored");
  await writeFile(join(runtime, "package.json"), JSON.stringify({ version: "99.0.0" }));
  assert.deepEqual(newestBin(dataDir), { bin: join(runtime, "bin", "apupod.mjs"), version: "99.0.0" });
});

test("GET /api/system reports the setup checklist without key values; the update check caches and tolerates offline and 404", async (t) => {
  withEnv(t, { ...NO_KEYS, ELEVENLABS_API_KEY: "secret-eleven-value", TYPESAFE_API_KEY: "secret-typesafe-value" });
  const state = { registry: () => Response.json({ version: "99.0.0" }) };
  const { api, baseUrl, rootDir } = await startTestServer(t, { fetchImpl: stubFetch(state), restart: () => {} });

  const response = await fetch(`${baseUrl}/api/system`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /secret-eleven-value|secret-typesafe-value/);
  assert.doesNotMatch(text, new RegExp((await readFile(join(rootDir, "mcp-token"), "utf8")).trim()), "the MCP token is never returned");
  const system = JSON.parse(text);
  assert.equal(system.version, version);
  assert.equal(system.node, process.versions.node);
  assert.deepEqual(system.update, { ...system.update, current: version, latest: "99.0.0", status: "available", changesUrl: `https://github.com/Jamir-boop/apupod/compare/v${version}...v99.0.0` });
  assert.equal(system.daemon.port, Number(new URL(baseUrl).port));
  assert.equal(system.daemon.url, baseUrl);
  assert.equal(system.daemon.pid, process.pid);
  assert.equal(system.dataDir, join(rootDir, "data"));
  assert.equal(system.configDir, rootDir);
  assert.equal(system.mcpToken, true);
  assert.deepEqual(system.mcpClients, []);
  const keys = Object.fromEntries(system.keys.map((key) => [key.name, key.configured]));
  assert.deepEqual(keys, { ELEVENLABS_API_KEY: true, MIMO_API_KEY: false, OPENAI_API_KEY: false, CHATTERBOX_API_KEY: false, TYPESAFE_API_KEY: true });
  const check = Object.fromEntries(system.checks.map((item) => [item.id, item]));
  assert.equal(check["key:ELEVENLABS_API_KEY"].status, "ok");
  assert.deepEqual([check["key:MIMO_API_KEY"].status, check["key:MIMO_API_KEY"].card], ["warning", "provider:mimo"]);
  assert.deepEqual([check["key:TYPESAFE_API_KEY"].status, check["key:TYPESAFE_API_KEY"].card], ["ok", "decision"]);
  assert.equal(check["tts-key"].status, "ok");
  assert.equal(check["mcp-token"].status, "ok");
  assert.equal(check.version.status, "warning");
  assert.equal(check.models.status, system.activeModels > 0 ? "ok" : "missing");
  for (const id of ["ffmpeg", "ffprobe"]) {
    assert.ok(["ok", "missing"].includes(check[id].status));
    if (check[id].status === "missing") assert.match(check[id].hint, /Install FFmpeg/);
    else assert.match(check[id].label, /^FF(mpeg|probe) \S+/);
  }
  for (const item of system.checks) assert.ok(["ok", "missing", "warning"].includes(item.status) && item.hint, item.id);

  // Cached for an hour; ?refresh=1 asks the registry again.
  assert.equal((await api("/api/system")).value.update.status, "available");
  assert.equal(state.registryCalls, 1);
  state.registry = () => new Response("not found", { status: 404 });
  assert.deepEqual([(await api("/api/system?refresh=1")).value.update.status, state.registryCalls], ["not-published", 2]);
  state.registry = () => { throw new TypeError("fetch failed"); };
  const offline = (await api("/api/system?refresh=1")).value;
  assert.equal(offline.update.status, "offline");
  assert.equal(offline.update.latest, null);
  assert.equal(offline.update.changesUrl, "https://github.com/Jamir-boop/apupod/releases");
  state.registry = () => Response.json({ version });
  assert.equal((await api("/api/system?refresh=1")).value.update.status, "current");
  state.registry = () => new Response("bad gateway", { status: 502 });
  assert.equal((await api("/api/system?refresh=1")).value.update.status, "error");
});

test("PUT /api/system/port validates the port, writes PORT to the config-dir .env, and restarts", async (t) => {
  withEnv(t, NO_KEYS);
  const restarts = [];
  const { api, baseUrl, rootDir } = await startTestServer(t, { fetchImpl: stubFetch({ registry: () => Response.json({ version }) }), restart: (port) => restarts.push(port) });
  for (const port of [80, 1023, 65_536, 4173.5, "abc", null]) {
    const result = await api("/api/system/port", { port }, "PUT");
    assert.equal(result.status, 400, String(port));
    assert.match(result.value.error, /from 1024 to 65535/);
  }
  assert.match((await api("/api/system/port", { port: Number(new URL(baseUrl).port) }, "PUT")).value.error, /already uses port/);
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const busy = await api("/api/system/port", { port: blocker.address().port }, "PUT");
  assert.deepEqual([busy.status, /is in use/.test(busy.value.error)], [409, true]);
  const foreign = await fetch(`${baseUrl}/api/system/port`, { method: "PUT", headers: { "Content-Type": "application/json", Origin: "http://evil.example" }, body: JSON.stringify({ port: 5000 }) });
  assert.equal(foreign.status, 403);
  assert.deepEqual(restarts, []);
  await assert.rejects(readFile(join(rootDir, ".env"), "utf8"), { code: "ENOENT" });

  const port = await freePort();
  const changed = await api("/api/system/port", { port }, "PUT");
  assert.equal(changed.status, 202);
  assert.deepEqual(changed.value, { restarting: true, port, url: `http://127.0.0.1:${port}/` });
  await waitFor(() => restarts.length === 1);
  assert.deepEqual(restarts, [port]);
  assert.match(await readFile(join(rootDir, ".env"), "utf8"), new RegExp(`^PORT=${port}$`, "m"));
  if (process.platform !== "win32") assert.equal((await stat(join(rootDir, ".env"))).mode & 0o777, 0o600);
});

test("a new MCP token invalidates the old one; initialize is tracked in /api/system and get_workspace", async (t) => {
  withEnv(t, NO_KEYS);
  const state = { registry: () => Response.json({ version: "99.0.0" }) };
  const { api, baseUrl, rootDir } = await startTestServer(t, { fetchImpl: stubFetch(state), restart: () => {} });
  const tokenPath = join(rootDir, "mcp-token");
  const oldToken = (await readFile(tokenPath, "utf8")).trim();
  assert.equal((await postMcp(baseUrl, oldToken)).status, 200);
  const [client] = (await api("/api/system")).value.mcpClients;
  assert.deepEqual({ ...client, at: undefined }, { name: "system-test", version: "1.2.3", protocolVersion: "2025-06-18", at: undefined });
  assert.ok(Date.now() - Date.parse(client.at) < 10_000);

  const mcp = new Client({ name: "workspace-test", version: "4.5.6" });
  t.after(() => mcp.close());
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${oldToken}` } } }));
  const workspace = (await mcp.callTool({ name: "get_workspace", arguments: {} })).structuredContent.apupod;
  assert.equal(workspace.version, version);
  assert.equal(workspace.update.status, "available", "get_workspace reports the cached update check");
  assert.deepEqual(workspace.mcpClients.map((item) => `${item.name} ${item.version}`), ["workspace-test 4.5.6", "system-test 1.2.3"]);
  assert.equal(state.registryCalls, 1, "get_workspace makes no registry call");

  const rotated = await fetch(`${baseUrl}/api/system/mcp-token`, { method: "POST" });
  assert.equal(rotated.status, 200);
  const newToken = (await readFile(tokenPath, "utf8")).trim();
  assert.notEqual(newToken, oldToken);
  assert.ok(newToken.length >= 32);
  assert.doesNotMatch(await rotated.text(), new RegExp(newToken));
  if (process.platform !== "win32") assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
  assert.equal((await postMcp(baseUrl, oldToken)).status, 401);
  assert.equal((await postMcp(baseUrl, newToken)).status, 200);
});

test("update is refused during a TTS job, runs npm install with the exact args through the injected runner, then restarts", async (t) => {
  withEnv(t, { ...NO_KEYS, ELEVENLABS_API_KEY: "test-eleven-key" });
  let releaseTts;
  const ttsGate = new Promise((resolve) => { releaseTts = resolve; });
  t.after(() => releaseTts());
  const state = {
    registry: () => Response.json({ version: "99.0.0" }),
    other: async (url) => {
      if (String(url).endsWith("/v1/models")) return Response.json([{ model_id: "eleven_v3", name: "Eleven v3", can_do_text_to_speech: true }]);
      if (String(url).includes("/v2/voices")) return Response.json({ voices: [{ voice_id: "voice-es", name: "Voz" }], has_more: false });
      if (String(url).includes("/text-to-speech/")) {
        await ttsGate;
        return new Response(silentWav(24_000, 1, 0.1), { headers: { "Content-Type": "audio/wav" } });
      }
      return Response.json({ data: [] });
    },
  };
  const runs = [];
  let runner = async () => { throw new Error("npm exited with code 1: E404 Not Found"); };
  const restarts = [];
  const { api, baseUrl, rootDir } = await startTestServer(t, { fetchImpl: stubFetch(state), restart: (port) => restarts.push(port), runCommand: (...args) => { runs.push(args); return runner(...args); } });
  const runtime = join(rootDir, "data", "runtime");

  // Hold a TTS render in its first synthesis request.
  const token = (await readFile(join(rootDir, "mcp-token"), "utf8")).trim();
  const mcp = new Client({ name: "update-test", version: "0" });
  t.after(() => mcp.close());
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const call = async (name, args) => {
    const result = await mcp.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content?.[0]?.text);
    return result.structuredContent;
  };
  const config = (await api("/api/state")).value.config;
  config.providers.elevenlabs.activeModels = { eleven_v3: { tts: true } };
  assert.equal((await api("/api/config", config, "PUT")).status, 200);
  await call("save_host_profile", { id: "speaker-example-hosts", voiceModel: "eleven_v3", speakers: [{ name: "Alex", voiceId: "voice-es" }, { name: "Sam", voiceId: "voice-es" }] });
  const { episodes: [episode] } = await call("create_episodes", { name: "Held render", episodeProfileId: "episode-example-format" });
  const { job } = await call("save_script", { episodeId: episode.id, script: "## Uno\nAlex: Hola.\nSam: Hola.", render: true });

  for (const [path, body, method] of [["/api/system/update", {}, "POST"], ["/api/system/port", { port: await freePort() }, "PUT"]]) {
    const refused = await api(path, body, method);
    assert.equal(refused.status, 409, path);
    assert.match(refused.value.error, /TTS job is queued or running/);
  }
  assert.deepEqual([runs, restarts], [[], []]);
  releaseTts();
  await waitFor(async () => ["completed", "failed"].includes((await call("get_job", { jobId: job.id })).job.status), 30_000);

  // A failed install is reported with its error and does not restart.
  assert.equal((await api("/api/system/update", {}, "POST")).status, 202);
  const failed = await waitFor(async () => { const { updateJob } = (await api("/api/system")).value; return updateJob?.status === "failed" && updateJob; });
  assert.match(failed.error, /E404 Not Found/);
  assert.deepEqual(restarts, []);

  runner = async (command, args) => {
    const dir = join(args[2], "node_modules", "apupod");
    await mkdir(join(dir, "bin"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "apupod", version: "99.0.0" }));
    await writeFile(join(dir, "bin", "apupod.mjs"), "");
    return "added 1 package\n";
  };
  const started = await api("/api/system/update", {}, "POST");
  assert.equal(started.status, 202);
  assert.deepEqual([started.value.updateJob.status, started.value.updateJob.version], ["running", "99.0.0"]);
  const restarting = await waitFor(async () => { const { updateJob } = (await api("/api/system")).value; return updateJob?.status === "restarting" && updateJob; });
  assert.match(restarting.log, /added 1 package/);
  assert.equal(runs.length, 2);
  for (const [command, args, timeout] of runs) {
    assert.equal(command, "npm");
    assert.deepEqual(args, ["install", "--prefix", runtime, "--no-audit", "--no-fund", "--omit=dev", "apupod@99.0.0"]);
    assert.ok(timeout > 0);
  }
  assert.deepEqual(restarts, [Number(new URL(baseUrl).port)]);
  assert.match((await api("/api/system/update", {}, "POST")).value.error, /already running/);

  state.registry = () => Response.json({ version });
  const latest = await startTestServer(t, { fetchImpl: stubFetch(state), restart: () => {}, runCommand: () => assert.fail("no install") });
  const upToDate = await latest.api("/api/system/update", {}, "POST");
  assert.deepEqual([upToDate.status, /is the latest version/.test(upToDate.value.error)], [409, true]);
});
