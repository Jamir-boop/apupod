import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPodcastServer } from "../src/app.mjs";

const TOUCHED_ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "MIMO_API_KEY", "ELEVENLABS_API_KEY", "OPENAI_API_KEY", "OPENCODE_GO_API_KEY", "CHATTERBOX_API_KEY", "TYPESAFE_API_KEY", "MIMO_BASE_URL"];

// Each test sets its own environment and restores the previous values afterwards, also on failure.
// Save only once per test: a later save would capture this test's own values, and its restore runs last.
const isolated = new WeakSet();
function isolateEnv(t) {
  if (!isolated.has(t)) {
    isolated.add(t);
    const saved = Object.fromEntries(TOUCHED_ENV.map((name) => [name, process.env[name]]));
    t.after(() => {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
  }
  for (const name of TOUCHED_ENV) delete process.env[name];
  // The explicit base URL and key must win over these.
  Object.assign(process.env, { ANTHROPIC_BASE_URL: "http://env-proxy.invalid", ANTHROPIC_AUTH_TOKEN: "env-anthropic-token" });
}

const KEY = "sk-ant-test-key";
const MODELS_URL = "https://api.anthropic.com/v1/models";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages?beta=true";
const header = (init, name) => new Headers(init.headers).get(name);

const MODEL_PAGES = [
  { data: [{ type: "model", id: "claude-retired", display_name: "Claude Retired", created_at: "2025-01-01T00:00:00Z", max_tokens: 8_000, lifecycle: "retired" },
    { type: "model", id: "claude-test", display_name: "Claude Test", created_at: "2026-01-01T00:00:00Z", max_tokens: 128_000,
    capabilities: { effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: false }, max: { supported: false } } } }],
  has_more: true, first_id: "claude-test", last_id: "claude-test" },
  { data: [{ type: "model", id: "claude-small", display_name: "Claude Small", created_at: "2026-01-01T00:00:00Z", max_tokens: 32_000, capabilities: { effort: { supported: false } } }],
  has_more: false, first_id: "claude-small", last_id: "claude-small" },
];

function sse(events) {
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

const start = () => ({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
const stop = (stopReason, stopDetails = null) => [{ type: "message_delta", delta: { stop_reason: stopReason, stop_details: stopDetails }, usage: { output_tokens: 5 } }, { type: "message_stop" }];
const textBlock = (index, text) => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index },
];

// Thinking, then partial text, then a fallback block, then the fallback model's continuation.
function answerWithFallback(answer) {
  const json = JSON.stringify(answer);
  const split = Math.floor(json.length / 2);
  return sse([
    start(),
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "{\"message\":\"thinking decoy\",\"proposal\":null}" } },
    { type: "content_block_stop", index: 0 },
    ...textBlock(1, json.slice(0, split)),
    { type: "content_block_start", index: 2, content_block: { type: "fallback", from: { model: "claude-test" }, to: { model: "claude-small" }, trigger: { type: "refusal", category: "cyber" } } },
    { type: "content_block_stop", index: 2 },
    ...textBlock(3, json.slice(split)),
    ...stop("end_turn"),
  ]);
}

async function startServer(t, { respond, activeModels = { "claude-test": { text: true } }, apiKey = KEY } = {}) {
  isolateEnv(t);
  const rootDir = await mkdtemp(join(tmpdir(), "podcast-anthropic-"));
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(rootDir, { recursive: true, force: true });
  });
  if (apiKey) process.env.ANTHROPIC_API_KEY = apiKey;
  else delete process.env.ANTHROPIC_API_KEY;
  await mkdir(join(rootDir, "data"), { recursive: true });
  await writeFile(join(rootDir, "data", "config.json"), JSON.stringify({ providers: { anthropic: { enabled: true, activeModels } } }));
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, init });
    if (target.startsWith(MODELS_URL)) return Response.json(new URL(target).searchParams.get("after_id") === "claude-test" ? MODEL_PAGES[1] : MODEL_PAGES[0]);
    if (target === MESSAGES_URL) return respond(JSON.parse(init.body), calls.filter((call) => call.url === MESSAGES_URL).length);
    return Response.json({ data: [] });
  };
  server = await createPodcastServer({ rootDir, chatgptClient: { status: () => ({ accounts: [] }), close: async () => {} }, fetchImpl });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(base + path, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  };
  const messageCalls = () => calls.filter((call) => call.url === MESSAGES_URL);
  return { rootDir, api, calls, messageCalls, models: () => settledModels(base) };
}

async function settledModels(base) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const catalog = await (await fetch(`${base}/api/models`)).json();
    if (catalog.status !== "loading") return catalog;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The model catalog did not settle.");
}

async function chatWith(api, planningEffort) {
  const plan = (await api("/api/plans", { name: "Claude plan", planningModel: "compat:anthropic:claude-test", planningEffort })).value.plan;
  assert.equal(plan.planningModel, "compat:anthropic:claude-test");
  return api("/api/plans/chat", { planId: plan.id, model: plan.planningModel, text: "Explain the plan." });
}

test("config save writes ANTHROPIC_API_KEY to .env with mode 0600 and reports only hasApiKey", async (t) => {
  const { api, rootDir } = await startServer(t, { apiKey: "", activeModels: {} });
  const config = (await api("/api/config")).value;
  assert.equal(config.providers.anthropic.enabled, true);
  assert.equal(config.providers.anthropic.hasApiKey, false);
  const saved = await api("/api/config", { ...config, providers: { ...config.providers, anthropic: { ...config.providers.anthropic, apiKey: KEY } } }, "PUT");
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  const envPath = join(rootDir, ".env");
  assert.match(await readFile(envPath, "utf8"), new RegExp(`^ANTHROPIC_API_KEY=${KEY}$`, "m"));
  assert.equal((await stat(envPath)).mode & 0o777, 0o600);
  const redacted = await api("/api/config");
  assert.equal(redacted.value.providers.anthropic.hasApiKey, true);
  assert.doesNotMatch(JSON.stringify(redacted.value), new RegExp(KEY));
  const cleared = await api("/api/config", { ...redacted.value, providers: { ...redacted.value.providers, anthropic: { ...redacted.value.providers.anthropic, clearApiKey: true } } }, "PUT");
  assert.equal(cleared.status, 200, JSON.stringify(cleared.value));
  assert.doesNotMatch(await readFile(envPath, "utf8"), /ANTHROPIC_API_KEY/);
  assert.equal((await api("/api/config")).value.providers.anthropic.hasApiKey, false);
});

test("an old config.json without an anthropic entry still loads with the provider enabled and no models", async (t) => {
  isolateEnv(t);
  const rootDir = await mkdtemp(join(tmpdir(), "podcast-anthropic-legacy-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await mkdir(join(rootDir, "data"), { recursive: true });
  await writeFile(join(rootDir, "data", "config.json"), JSON.stringify({ providers: { chatgpt: { enabled: false, activeModels: {} } }, compatibleConnections: [] }));
  const server = await createPodcastServer({ rootDir, chatgptClient: { status: () => ({ accounts: [] }), close: async () => {} }, fetchImpl: async () => Response.json({ data: [] }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.deepEqual(config.providers.anthropic, { enabled: true, activeModels: {}, hasApiKey: false });
  const anthropic = (await settledModels(base)).providers.anthropic;
  assert.equal(anthropic.status, "unconfigured");
  assert.equal(anthropic.error, "Anthropic API key is not configured. Set ANTHROPIC_API_KEY in .env.");
});

test("discovery follows pagination and keeps effort levels and max tokens from the model capabilities", async (t) => {
  const { calls, models: settled } = await startServer(t, { respond: () => assert.fail("no generation expected") });
  const models = await settled();
  const anthropic = models.providers.anthropic;
  assert.equal(anthropic.status, "ready", anthropic.error);
  assert.deepEqual(calls.filter((call) => call.url.startsWith(MODELS_URL)).map((call) => call.url), [`${MODELS_URL}?limit=1000`, `${MODELS_URL}?limit=1000&after_id=claude-test`]);
  for (const call of calls) assert.equal(header(call.init, "x-api-key"), KEY);
  assert.deepEqual(anthropic.discoveredModels.map((model) => [model.id, model.name, model.effortLevels, model.maxTokens, model.suggested]), [
    ["compat:anthropic:claude-test", "Claude Test", ["low", "medium", "high"], 128_000, { text: true, tts: false }],
    ["compat:anthropic:claude-small", "Claude Small", [], 32_000, { text: true, tts: false }],
  ]);
  assert.deepEqual(anthropic.textModels.map((model) => model.id), ["compat:anthropic:claude-test"]);
  assert.deepEqual(anthropic.ttsModels, []);
});

test("Claude models activate as text models only and are rejected as TTS models", async (t) => {
  const { api } = await startServer(t, { activeModels: {}, respond: () => assert.fail("no generation expected") });
  const config = (await api("/api/config")).value;
  const saved = await api("/api/config", { ...config, providers: { ...config.providers, anthropic: { ...config.providers.anthropic, activeModels: { "claude-test": { text: true }, "claude-small": { tts: true } } } } }, "PUT");
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  assert.deepEqual(saved.value.config.providers.anthropic.activeModels, { "claude-test": { text: true, tts: false }, "claude-small": { text: false, tts: false } });
  assert.deepEqual(saved.value.modelCatalog.providers.anthropic.textModels.map((model) => model.id), ["compat:anthropic:claude-test"]);
  const profiles = (await api("/api/state")).value.profiles;
  profiles.speakerProfiles[0].voiceModel = "compat:anthropic:claude-small";
  const rejected = await api("/api/profiles", profiles, "PUT");
  assert.equal(rejected.status, 400);
  assert.match(rejected.value.error, /Unsupported TTS model "compat:anthropic:claude-small"/);
});

test("planner chat streams one Messages request with the fallback beta, a supported effort and no sampling settings", async (t) => {
  const answer = { message: "Claude response", proposal: null };
  const { api, messageCalls } = await startServer(t, { respond: () => answerWithFallback(answer) });
  const chat = await chatWith(api, "high");
  assert.equal(chat.status, 200, JSON.stringify(chat.value));
  assert.match(JSON.stringify(chat.value), /Claude response/);
  assert.doesNotMatch(JSON.stringify(chat.value), /thinking decoy/);
  const [call] = messageCalls();
  assert.equal(messageCalls().length, 1);
  assert.equal(call.url, MESSAGES_URL);
  assert.equal(call.init.method, "POST");
  assert.equal(header(call.init, "x-api-key"), KEY);
  assert.equal(header(call.init, "authorization"), null);
  assert.equal(header(call.init, "anthropic-version"), "2023-06-01");
  assert.match(header(call.init, "anthropic-beta"), /(^|,)server-side-fallback-2026-07-01(,|$)/);
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, "claude-test");
  assert.equal(body.max_tokens, 64_000);
  assert.equal(body.stream, true);
  assert.equal(body.fallbacks, "default");
  assert.deepEqual(body.output_config, { effort: "high" });
  assert.deepEqual(body.messages.map((message) => message.role), ["user"]);
  assert.equal(typeof body.system, "string");
  for (const key of ["thinking", "temperature", "top_p", "top_k", "response_format", "betas"]) assert.equal(Object.hasOwn(body, key), false, key);
  t.diagnostic(`captured headers: ${JSON.stringify(Object.fromEntries([...new Headers(call.init.headers)].filter(([name]) => /^(x-api-key|authorization|anthropic-|content-type|accept)/.test(name)).map(([name, value]) => [name, name === "x-api-key" ? "<key>" : value])))}`);
  t.diagnostic(`captured body keys: ${JSON.stringify(Object.keys(body))} max_tokens=${body.max_tokens} stream=${body.stream} fallbacks=${body.fallbacks} output_config=${JSON.stringify(body.output_config)}`);
});

test("an effort level the model does not support is omitted", async (t) => {
  const { api, messageCalls } = await startServer(t, { respond: () => answerWithFallback({ message: "ok", proposal: null }) });
  const chat = await chatWith(api, "xhigh");
  assert.equal(chat.status, 200, JSON.stringify(chat.value));
  assert.equal(Object.hasOwn(JSON.parse(messageCalls()[0].init.body), "output_config"), false);
});

test("refusal and max_tokens stops give clear errors", async (t) => {
  const refusal = await startServer(t, { respond: () => sse([start(), ...stop("refusal", { type: "refusal", category: "cyber", explanation: "x" })]) });
  const declined = await chatWith(refusal.api, "");
  assert.equal(declined.status >= 400, true);
  assert.match(declined.value.error, /claude-test declined this request \(category: cyber\)\. Change the request or select another model\./);
  assert.equal(refusal.messageCalls().length, 1);

  const truncated = await startServer(t, { respond: () => sse([start(), ...textBlock(0, "{\"message\":"), ...stop("max_tokens")]) });
  const limited = await chatWith(truncated.api, "");
  assert.equal(limited.status >= 400, true);
  assert.match(limited.value.error, /64000-token output limit/);
});

test("HTTP errors name ANTHROPIC_API_KEY and follow the retry headers", async (t) => {
  const unauthorized = await startServer(t, { respond: () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401, headers: { "content-type": "application/json" } }) });
  const rejected = await chatWith(unauthorized.api, "");
  assert.match(rejected.value.error, /Anthropic messages request failed: HTTP 401\. The provider rejected ANTHROPIC_API_KEY\. Check the key\. invalid x-api-key/);
  assert.equal(unauthorized.messageCalls().length, 1);

  const overloaded = await startServer(t, { respond: () => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: 529, headers: { "content-type": "application/json", "x-should-retry": "false" } }) });
  const busy = await chatWith(overloaded.api, "");
  assert.match(busy.value.error, /Anthropic messages is overloaded \(HTTP 529\)/);
  assert.equal(overloaded.messageCalls().length, 1);

  const retried = await startServer(t, { respond: (body, count) => count === 1
    ? new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: 529, headers: { "content-type": "application/json", "retry-after-ms": "0" } })
    : answerWithFallback({ message: "after retry", proposal: null }) });
  const recovered = await chatWith(retried.api, "");
  assert.equal(recovered.status, 200, JSON.stringify(recovered.value));
  assert.equal(retried.messageCalls().length, 2);
});

test("ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN in the environment are ignored", async (t) => {
  const { api, calls } = await startServer(t, { respond: () => answerWithFallback({ message: "ok", proposal: null }) });
  assert.equal((await chatWith(api, "")).status, 200);
  assert.ok(calls.length > 0);
  for (const call of calls.filter((item) => item.url.includes("anthropic"))) {
    assert.match(call.url, /^https:\/\/api\.anthropic\.com\/v1\//);
    assert.equal(header(call.init, "authorization"), null);
    assert.doesNotMatch([...new Headers(call.init.headers).values()].join(" "), /env-anthropic-token/);
  }
  assert.equal(calls.some((call) => call.url.includes("env-proxy")), false);
});
