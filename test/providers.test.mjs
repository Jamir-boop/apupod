import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createModelCatalog } from "../src/providers/catalog.mjs";
import { callTextModel, synthesizeTurn, turnClipDescriptor } from "../src/providers/generate.mjs";
import { anthropicClient, callOptions, cappedFetch, openAiClient, providerError } from "../src/providers/transport.mjs";
import { chatgptStub, startTestServer, waitFor, withEnv } from "./helpers.mjs";

const header = (init, name) => new Headers(init.headers).get(name);
const LANGUAGE = { id: "en-US", apiCode: "en", name: "English (United States)" };
const chat = (content = "{\"ok\":true}") => Response.json({ choices: [{ message: { content } }] });
const fail = (status, body, headers = { "x-should-retry": "false" }) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function recorder(respond) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init, calls.length);
  };
  return { calls, fetchImpl };
}

function context(fetchImpl, { apiKey = "sk-custom" } = {}) {
  const modelCatalog = createModelCatalog({});
  modelCatalog.providers.compatible = [{ id: "custom", name: "Custom", status: "ready", textModels: [], ttsModels: [{ id: "compat:custom:tts-1" }], discoveredModels: [] }];
  return {
    fetchImpl,
    modelCatalog,
    credentials: { CUSTOM_API_KEY: apiKey, MIMO_API_KEY: "mimo-key", OPENCODE_GO_API_KEY: "go-key" },
    config: {
      providers: { mimo: { baseUrl: "https://mimo.test/v1" }, opencodeGo: {} },
      compatibleConnections: [{ id: "custom", name: "Custom", baseUrl: "https://custom.test/v1", llmBaseUrl: "", ttsBaseUrl: "", apiKeyEnv: "CUSTOM_API_KEY", enabled: true, activeModels: {} }],
    },
  };
}

const text = (ctx, model = "compat:custom:chat-model") => callTextModel({ context: ctx, model, system: "s", prompt: "p", maxTokens: 100, temperature: 0.5, topP: 1 });
const speak = (ctx) => synthesizeTurn(ctx, { voiceModel: "compat:custom:tts-1" }, { voiceId: "alloy" }, "Hello", "", LANGUAGE);

test("SDK clients ignore OPENAI_* and ANTHROPIC_* environment variables", async (t) => {
  withEnv(t, {
    OPENAI_BASE_URL: "http://env-proxy.invalid/v1", OPENAI_API_KEY: "env-openai-key", OPENAI_ORG_ID: "env-org", OPENAI_PROJECT_ID: "env-project", OPENAI_ADMIN_KEY: "env-admin",
    ANTHROPIC_BASE_URL: "http://env-proxy.invalid", ANTHROPIC_API_KEY: "env-anthropic-key", ANTHROPIC_AUTH_TOKEN: "env-anthropic-token",
    OPENAI_CUSTOM_HEADERS: "X-Leak: env-openai-custom\nAuthorization: Bearer env-custom-auth", ANTHROPIC_CUSTOM_HEADERS: "X-Leak: env-anthropic-custom\nX-Api-Key: env-custom-key",
  });
  const { calls, fetchImpl } = recorder((url) => url.endsWith("/audio/speech") ? new Response(Buffer.from("audio"), { headers: { "content-type": "audio/mpeg" } })
    : url.endsWith("/v1/messages") ? Response.json({ content: [{ type: "text", text: "{}" }] }) : chat());

  await text(context(fetchImpl));
  await text(context(fetchImpl, { apiKey: "" }));
  await speak(context(fetchImpl, { apiKey: "" }));
  await text(context(fetchImpl), "mimo-v2.5");
  await text(context(fetchImpl), "compat:opencode-go:minimax-m3");

  assert.deepEqual(calls.map((call) => call.url), [
    "https://custom.test/v1/chat/completions",
    "https://custom.test/v1/chat/completions",
    "https://custom.test/v1/audio/speech",
    "https://mimo.test/v1/chat/completions",
    "https://opencode.ai/zen/go/v1/messages",
  ]);
  const [keyed, keyless, tts, mimo, messages] = calls.map((call) => call.init);
  assert.equal(header(keyed, "authorization"), "Bearer sk-custom");
  for (const init of [keyless, tts]) assert.equal(header(init, "authorization"), null);
  for (const init of calls.map((call) => call.init)) {
    assert.equal(header(init, "openai-organization"), null);
    assert.equal(header(init, "openai-project"), null);
    assert.equal(header(init, "x-leak"), null);
    assert.doesNotMatch([...new Headers(init.headers).values()].join(" "), /env-/);
  }
  assert.equal(header(mimo, "api-key"), "mimo-key");
  assert.equal(header(mimo, "authorization"), null);
  assert.equal(header(messages, "x-api-key"), "go-key");
  assert.equal(header(messages, "authorization"), null);
  assert.match(process.env.OPENAI_CUSTOM_HEADERS, /X-Leak/, "the environment is restored after a client is built");
});

test("an empty base URL sends nothing instead of falling back to the SDK default host", async () => {
  const { calls, fetchImpl } = recorder(() => chat());
  const ctx = context(fetchImpl);
  ctx.config.compatibleConnections[0].baseUrl = "";
  await assert.rejects(text(ctx), /Provider base URL is not configured\.$/);
  assert.throws(() => openAiClient({ baseURL: "", apiKey: "k", fetch: fetchImpl }), /Provider base URL is not configured\./);
  assert.throws(() => anthropicClient({ baseURL: "", apiKey: "k", fetch: fetchImpl }), /Provider base URL is not configured\./);
  assert.equal(calls.length, 0);
});

test("an empty Anthropic API key throws instead of using the SDK credential fallback", (t) => {
  withEnv(t, { ANTHROPIC_API_KEY: "env-key" });
  assert.throws(() => anthropicClient({ baseURL: "https://messages.test", apiKey: "", fetch: async () => chat() }), /^Error: Provider API key is not configured\.$/);
});

test("an OpenAI client that sends a key header of any case refuses redirects", async () => {
  const { calls, fetchImpl } = recorder(() => Response.json({ data: [] }));
  await openAiClient({ baseURL: "https://mimo.test/v1", apiKey: "k", headers: { Authorization: null, "Api-Key": "k" }, fetch: fetchImpl }).get("/models");
  assert.equal(calls[0].init.redirect, "error");
});

test("withEnv restores the original environment when the test ends", async (t) => {
  delete process.env.POD_GOD_PROBE;
  await t.test("sets twice", (st) => { withEnv(st, { POD_GOD_PROBE: "a" }); withEnv(st, { POD_GOD_PROBE: "b" }); });
  assert.equal(process.env.POD_GOD_PROBE, undefined);
});

test("compatible TTS clips keep the /audio/speech endpoint in their cache descriptor", () => {
  const descriptor = turnClipDescriptor(context(async () => chat()), { voiceModel: "compat:custom:tts-1" }, { voiceId: "alloy" }, { text: "Hello", delivery: "" }, LANGUAGE);
  assert.equal(descriptor.provider.endpoint, "https://custom.test/v1/audio/speech");
});

test("error bodies keep the detail rule and map statuses to readable messages", async () => {
  const cases = [
    [fail(500, { detail: { message: "boom" } }), /Custom chat request failed: HTTP 500 boom$/],
    [fail(401, { error: { message: "bad key" } }), /Custom chat request failed: HTTP 401\. The provider rejected CUSTOM_API_KEY\. Check the key\. bad key$/],
    [fail(403, { error: { message: "denied" } }), /HTTP 403\. The provider rejected CUSTOM_API_KEY for this model or endpoint\. Check the key\. denied$/],
    [fail(429, { error: { message: "slow down" } }), /Custom chat is rate-limited \(HTTP 429\)\. Wait, then try again\. slow down$/],
    [fail(529, { error: { message: "busy" } }), /Custom chat is overloaded \(HTTP 529\)\. Try again shortly\. busy$/],
    [fail(502, "x".repeat(70 * 1024)), /Custom chat request failed: HTTP 502 Custom chat response exceeds 65536 byte limit\.$/],
  ];
  for (const [response, expected] of cases) {
    const { calls, fetchImpl } = recorder(() => response);
    await assert.rejects(text(context(fetchImpl)), expected);
    assert.equal(calls.length, 1);
  }
});

test("an oversized 2xx body fails with the cap message and is not retried", async () => {
  const { calls, fetchImpl } = recorder(() => new Response(Buffer.alloc(8 * 1024 * 1024 + 1024, 32), { headers: { "content-type": "application/json" } }));
  await assert.rejects(text(context(fetchImpl)), /Custom chat request failed: Custom chat response exceeds 8388608 byte limit\.$/);
  assert.equal(calls.length, 1);
});

test("an SDK timeout maps to the timed-out message", async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  const client = openAiClient({ baseURL: "https://custom.test/v1", apiKey: "k", fetch: cappedFetch(hang, 1024, "Custom chat") });
  const started = Date.now();
  const error = await client.chat.completions.create({ model: "m", messages: [] }, callOptions(50, 2)).then(() => null, (failure) => failure);
  assert.equal(providerError(error, "Custom chat", "CUSTOM_API_KEY", 50).message, "Custom chat request timed out after 0.05 seconds.");
  assert.ok(Date.now() - started < 2_000);
});

test("LLM text retries 529 twice; TTS fails fast", async () => {
  const overloaded = () => fail(529, { error: { message: "busy" } }, { "retry-after-ms": "0" });
  const llm = recorder(overloaded);
  await assert.rejects(text(context(llm.fetchImpl)), /overloaded \(HTTP 529\)/);
  assert.equal(llm.calls.length, 3);

  const recovered = recorder((url, init, count) => count === 1 ? overloaded() : chat());
  assert.deepEqual(await text(context(recovered.fetchImpl)), { choices: [{ message: { content: "{\"ok\":true}" } }] });
  assert.equal(recovered.calls.length, 2);

  const tts = recorder(() => fail(503, { error: { message: "down" } }, { "retry-after-ms": "0" }));
  await assert.rejects(speak(context(tts.fetchImpl)), /Custom TTS request failed: HTTP 503 down$/);
  assert.equal(tts.calls.length, 1);

  const mimo = recorder(() => fail(503, { error: { message: "down" } }, { "retry-after-ms": "0" }));
  const mimoContext = context(mimo.fetchImpl);
  mimoContext.modelCatalog.providers.mimo.ttsModels = [{ id: "mimo-v2.5-tts" }];
  await assert.rejects(synthesizeTurn(mimoContext, { voiceModel: "mimo-v2.5-tts" }, { voiceId: "default" }, "Hello", "", LANGUAGE), /HTTP 503 down$/);
  assert.equal(mimo.calls.length, 1);
  assert.ok(mimo.calls[0].url.endsWith("/chat/completions") && JSON.parse(mimo.calls[0].init.body).audio);
});

test("a retry-after over 60 s does not hold an Anthropic-format call until its deadline", async () => {
  const { calls, fetchImpl } = recorder(() => fail(429, { error: { message: "slow down" } }, { "retry-after": "600" }));
  const client = anthropicClient({ baseURL: "https://messages.test", apiKey: "k", fetch: cappedFetch(fetchImpl, 1024, "OpenCode Go messages") });
  const started = Date.now();
  const error = await client.messages.create({ model: "m", max_tokens: 1, messages: [] }, callOptions(10_000, 2)).then(() => null, (failure) => failure);
  assert.equal(providerError(error, "OpenCode Go messages", "OPENCODE_GO_API_KEY", 10_000).message, "OpenCode Go messages is rate-limited (HTTP 429). Wait, then try again. slow down");
  assert.equal(calls.length, 3);
  assert.ok(Date.now() - started < 5_000);
});

test("model discovery does not retry", async (t) => {
  const { calls, fetchImpl } = recorder((url) => url.startsWith("https://custom.test/") ? fail(503, { error: { message: "down" } }, { "retry-after-ms": "0" }) : Response.json({ data: [] }));
  const { baseUrl } = await startTestServer(t, { chatgptClient: chatgptStub(), fetchImpl }, async (rootDir) => {
    await mkdir(join(rootDir, "data"), { recursive: true });
    await writeFile(join(rootDir, "data", "config.json"), JSON.stringify({ compatibleConnections: [{ id: "custom", name: "Custom", baseUrl: "https://custom.test/v1", activeModels: {} }] }));
  });
  const custom = await waitFor(async () => {
    const provider = (await (await fetch(`${baseUrl}/api/models`)).json()).providers.compatible.find((item) => item.id === "custom");
    return provider?.status === "error" && provider;
  });
  assert.equal(custom.error, "Custom models request failed: HTTP 503 down");
  assert.equal(calls.filter((call) => call.url.startsWith("https://custom.test/")).length, 1);
});
