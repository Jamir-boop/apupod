import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createModelCatalog } from "../src/providers/catalog.mjs";
import { synthesizeTurn, turnClipDescriptor } from "../src/providers/generate.mjs";
import { fetchBytes, fetchJsonWithBody, providerUrl } from "../src/providers/transport.mjs";
import { startTestServer, waitFor, withEnv } from "./helpers.mjs";

const header = (init, name) => new Headers(init.headers).get(name);
const LANGUAGE = { id: "en-US", apiCode: "en", name: "English (United States)" };
const audio = () => new Response(Buffer.from("audio"), { headers: { "content-type": "audio/mpeg" } });
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
  modelCatalog.providers.compatible = [{ id: "custom", name: "Custom", status: "ready", ttsModels: [{ id: "compat:custom:tts-1" }], discoveredModels: [] }];
  modelCatalog.providers.mimo.ttsModels = [{ id: "mimo-v2.5-tts" }];
  return {
    fetchImpl,
    modelCatalog,
    credentials: { CUSTOM_API_KEY: apiKey, MIMO_API_KEY: "mimo-key" },
    config: {
      providers: { mimo: { baseUrl: "https://mimo.test/v1" } },
      compatibleConnections: [{ id: "custom", name: "Custom", baseUrl: "https://custom.test/v1", ttsBaseUrl: "", apiKeyEnv: "CUSTOM_API_KEY", enabled: true, activeModels: {} }],
    },
  };
}

const speak = (ctx) => synthesizeTurn(ctx, { voiceModel: "compat:custom:tts-1" }, { voiceId: "alloy" }, "Hello", "", LANGUAGE);
const speakMimo = (ctx) => synthesizeTurn(ctx, { voiceModel: "mimo-v2.5-tts" }, { voiceId: "default" }, "Hello", "", LANGUAGE);
const wav = () => { const bytes = Buffer.alloc(12); bytes.write("RIFF", 0); bytes.write("WAVE", 8); return bytes; };

test("provider requests ignore OPENAI_* environment variables", async (t) => {
  withEnv(t, {
    OPENAI_BASE_URL: "http://env-proxy.invalid/v1", OPENAI_API_KEY: "env-openai-key", OPENAI_ORG_ID: "env-org", OPENAI_PROJECT_ID: "env-project", OPENAI_ADMIN_KEY: "env-admin",
    OPENAI_CUSTOM_HEADERS: "X-Leak: env-openai-custom\nAuthorization: Bearer env-custom-auth",
  });
  const { calls, fetchImpl } = recorder((url) => url.endsWith("/audio/speech") ? audio() : Response.json({ choices: [{ message: { audio: { data: wav().toString("base64") } } }] }));

  await speak(context(fetchImpl));
  await speak(context(fetchImpl, { apiKey: "" }));
  await speakMimo(context(fetchImpl));

  assert.deepEqual(calls.map((call) => call.url), [
    "https://custom.test/v1/audio/speech",
    "https://custom.test/v1/audio/speech",
    "https://mimo.test/v1/chat/completions",
  ]);
  const [keyed, keyless, mimo] = calls.map((call) => call.init);
  assert.equal(header(keyed, "authorization"), "Bearer sk-custom");
  assert.equal(header(keyless, "authorization"), null);
  for (const init of calls.map((call) => call.init)) {
    assert.equal(header(init, "openai-organization"), null);
    assert.equal(header(init, "openai-project"), null);
    assert.equal(header(init, "x-leak"), null);
    assert.doesNotMatch([...new Headers(init.headers).values()].join(" "), /env-/);
  }
  for (const init of [keyed, keyless, mimo]) {
    assert.equal(init.method, "POST");
    assert.equal(header(init, "content-type"), "application/json");
  }
  assert.deepEqual(JSON.parse(keyed.body), { model: "tts-1", voice: "alloy", input: "Hello", response_format: "mp3" });
  assert.equal(header(mimo, "api-key"), "mimo-key");
  assert.equal(header(mimo, "authorization"), null);
});

test("an empty base URL sends nothing instead of falling back to a default host", async () => {
  const { calls, fetchImpl } = recorder(() => audio());
  const ctx = context(fetchImpl);
  ctx.config.compatibleConnections[0].baseUrl = "";
  await assert.rejects(speak(ctx), /Provider base URL is not configured\.$/);
  assert.throws(() => providerUrl("", "/models"), /Provider base URL is not configured\./);
  ctx.config.providers.mimo.baseUrl = "";
  await assert.rejects(speakMimo(ctx), { message: "Provider base URL is not configured." });
  assert.equal(calls.length, 0);
});

test("a request that sends a key header of any case refuses redirects", async () => {
  const { calls, fetchImpl } = recorder(() => Response.json({ data: [] }));
  await fetchJsonWithBody(fetchImpl, "https://mimo.test/v1/models", { headers: { "Api-Key": "k" } }, "MiMo models", 1_000);
  assert.equal(calls[0].init.redirect, "error");
});

test("withEnv restores the original environment when the test ends", async (t) => {
  delete process.env.APUPOD_PROBE;
  await t.test("sets twice", (st) => { withEnv(st, { APUPOD_PROBE: "a" }); withEnv(st, { APUPOD_PROBE: "b" }); });
  assert.equal(process.env.APUPOD_PROBE, undefined);
});

test("compatible TTS clips keep the /audio/speech endpoint in their cache descriptor", () => {
  assert.equal(providerUrl("https://custom.test/v1/", "/audio/speech"), "https://custom.test/v1/audio/speech");
  assert.equal(providerUrl("https://custom.test/v1?api-version=1", "/audio/speech"), "https://custom.test/v1/audio/speech?api-version=1");
  assert.equal(providerUrl("https://custom.test/v1", "https://models.test/v2/models"), "https://models.test/v2/models");
  assert.equal(providerUrl("https://user:password@custom.test/v1", "/audio/speech"), "https://user:password@custom.test/v1/audio/speech");
  const descriptor = turnClipDescriptor(context(async () => audio()), { voiceModel: "compat:custom:tts-1" }, { voiceId: "alloy" }, { text: "Hello", delivery: "" }, LANGUAGE);
  assert.equal(descriptor.provider.endpoint, "https://custom.test/v1/audio/speech");
});

test("error bodies keep the detail rule, map statuses to readable messages, and do not retry", async () => {
  const cases = [
    [fail(500, { detail: { message: "boom" } }), /Custom TTS request failed: HTTP 500 boom$/],
    [fail(401, { error: { message: "bad key" } }), /Custom TTS request failed: HTTP 401\. The provider rejected CUSTOM_API_KEY\. Check the key\. bad key$/],
    [fail(403, { error: { message: "denied" } }), /HTTP 403\. The provider rejected CUSTOM_API_KEY for this model or endpoint\. Check the key\. denied$/],
    [fail(429, { error: { message: "slow down" } }), /Custom TTS is rate-limited \(HTTP 429\)\. Wait, then try again\. slow down$/],
    [fail(529, { error: { message: "busy" } }, { "retry-after-ms": "0" }), /Custom TTS is overloaded \(HTTP 529\)\. Try again shortly\. busy$/],
    [fail(502, "x".repeat(70 * 1024)), /Custom TTS request failed: HTTP 502 Custom TTS response exceeds 65536 byte limit\.$/],
  ];
  for (const [response, expected] of cases) {
    const { calls, fetchImpl } = recorder(() => response);
    await assert.rejects(speak(context(fetchImpl)), expected);
    assert.equal(calls.length, 1);
  }
  const mimo = recorder(() => fail(503, { error: { message: "down" } }, { "retry-after-ms": "0" }));
  await assert.rejects(speakMimo(context(mimo.fetchImpl)), /HTTP 503 down$/);
  assert.equal(mimo.calls.length, 1);
  assert.ok(mimo.calls[0].url.endsWith("/chat/completions") && JSON.parse(mimo.calls[0].init.body).audio);
});

test("an oversized 2xx body fails with the cap message and is not retried", async () => {
  const { calls, fetchImpl } = recorder(() => new Response(Buffer.alloc(2048, 32), { headers: { "content-type": "application/json" } }));
  await assert.rejects(fetchJsonWithBody(fetchImpl, "https://custom.test/v1/models", {}, "Custom models", 1_000, 1024, "CUSTOM_API_KEY"),
    { message: "Custom models request failed: Custom models response exceeds 1024 byte limit." });
  assert.equal(calls.length, 1);
});

test("a fetch timeout maps to the timed-out message", async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  const started = Date.now();
  await assert.rejects(fetchBytes(hang, "https://custom.test/v1/audio/speech", { method: "POST", body: JSON.stringify({ model: "m", voice: "alloy", input: "Hi" }) }, "Custom TTS", 50, "CUSTOM_API_KEY"),
    { message: "Custom TTS request timed out after 0.05 seconds." });
  assert.ok(Date.now() - started < 2_000);
});

test("model discovery does not retry", async (t) => {
  const { calls, fetchImpl } = recorder((url) => url.startsWith("https://custom.test/") ? fail(503, { error: { message: "down" } }, { "retry-after-ms": "0" }) : Response.json({ data: [] }));
  const { baseUrl } = await startTestServer(t, { fetchImpl }, async (rootDir) => {
    await writeFile(join(rootDir, "config.json"), JSON.stringify({ compatibleConnections: [{ id: "custom", name: "Custom", baseUrl: "https://custom.test/v1", activeModels: {} }] }));
  });
  const custom = await waitFor(async () => {
    const provider = (await (await fetch(`${baseUrl}/api/models`)).json()).providers.compatible.find((item) => item.id === "custom");
    return provider?.status === "error" && provider;
  });
  assert.equal(custom.error, "Custom models request failed: HTTP 503 down");
  assert.equal(calls.filter((call) => call.url.startsWith("https://custom.test/")).length, 1);
});

test("JSON transport preserves exact status details, type checks, and key redaction", async () => {
  const cases = [
    [500, { error: { message: "first" }, detail: { message: "second" } }, "MiMo request failed: HTTP 500 first"],
    [500, { detail: { message: "second" } }, "MiMo request failed: HTTP 500 second"],
    [500, "raw error", "MiMo request failed: HTTP 500 raw error"],
    [500, "", "MiMo request failed: HTTP 500 Server Error"],
    [401, { error: { message: "bad key" } }, "MiMo request failed: HTTP 401. The provider rejected MIMO_API_KEY. Check the key. bad key"],
    [403, { error: { message: "denied" } }, "MiMo request failed: HTTP 403. The provider rejected MIMO_API_KEY for this model or endpoint. Check the key. denied"],
    [429, { error: { message: "slow" } }, "MiMo is rate-limited (HTTP 429). Wait, then try again. slow"],
    [529, { error: { message: "busy" } }, "MiMo is overloaded (HTTP 529). Try again shortly. busy"],
    [400, { error: { type: "rate_limit_error", message: "slow" } }, "MiMo is rate-limited (HTTP 429). Wait, then try again. slow"],
    [400, { error: { type: "overloaded_error", message: "busy" } }, "MiMo is overloaded (HTTP 529). Try again shortly. busy"],
    [200, { error: { message: "echo mimo-key" } }, "MiMo request failed: echo [redacted]"],
    [200, { error: { code: "failed" } }, 'MiMo request failed: {"code":"failed"}'],
    [200, "not json", "MiMo response was not valid JSON."],
    [200, "null", "MiMo response was not valid JSON."],
  ];
  for (const [status, body, message] of cases) {
    const { calls, fetchImpl } = recorder(() => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, statusText: "Server Error" }));
    await assert.rejects(fetchJsonWithBody(fetchImpl, "https://mimo.test/v1/chat/completions", { headers: { "api-key": "mimo-key" } }, "MiMo", 1_000, 1024, "MIMO_API_KEY"), { message });
    assert.equal(calls.length, 1);
  }
  for (const status of [401, 403]) {
    await assert.rejects(speak(context(async () => fail(status, "missing"), { apiKey: "" })),
      { message: `Custom TTS request failed: HTTP ${status}. The provider requires an API key and none is configured. Set CUSTOM_API_KEY in .env, then refresh models. missing` });
  }
});

test("fetch transport caps declared and streamed bodies and rejects empty audio", async () => {
  for (const headers of [{}, { "content-length": "2048" }]) {
    await assert.rejects(fetchJsonWithBody(async () => new Response("x".repeat(2048), { headers }), "https://models.test", {}, "Models", 1_000, 1024, "TEST_KEY"),
      { message: "Models request failed: Models response exceeds 1024 byte limit." });
  }
  await assert.rejects(speak(context(async () => new Response())), { message: "Custom TTS returned empty audio." });
  await assert.rejects(speak(context(async () => new Response("x", { headers: { "content-length": String(128 * 1024 * 1024 + 1) } }))),
    { message: `Custom TTS request failed: Custom TTS response exceeds ${128 * 1024 * 1024} byte limit.` });
  const network = async () => { throw new TypeError("fetch failed", { cause: new Error("outer", { cause: new Error("key mimo-key refused") }) }); };
  await assert.rejects(speakMimo(context(network)), { message: "MiMo request failed: fetch failed (key [redacted] refused)" });
});

test("one fetch deadline includes response body reads without a retry", async () => {
  for (const json of [true, false]) {
    const { calls, fetchImpl } = recorder((url, init) => new Response(new ReadableStream({
      start(controller) { init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true }); },
    })));
    const request = json ? fetchJsonWithBody(fetchImpl, "https://slow.test", {}, "Slow", 50, 1024, "TEST_KEY")
      : fetchBytes(fetchImpl, "https://slow.test", {}, "Slow", 50, "TEST_KEY");
    await assert.rejects(request, { message: "Slow request timed out after 0.05 seconds." });
    assert.equal(calls.length, 1);
  }
});
