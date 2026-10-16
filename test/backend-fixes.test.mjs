import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPodcastServer, writeAudioAsWav } from "../src/app.mjs";
import { ChatGptError } from "../src/chatgpt.mjs";
import { DEFAULT_DATA } from "../src/defaults.mjs";

// A key in the developer's shell would start Anthropic discovery against the stubs.
delete process.env.ANTHROPIC_API_KEY;

for (const name of ["MIMO_API_KEY", "ELEVENLABS_API_KEY", "OPENAI_API_KEY", "OPENCODE_GO_API_KEY", "CHATTERBOX_API_KEY", "TYPESAFE_API_KEY"]) process.env[name] = `backend-test-${name}`;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function start(t, options = {}, prepare) {
  const rootDir = await mkdtemp(join(tmpdir(), "podcast-backend-fixes-"));
  await prepare?.(rootDir);
  const server = await createPodcastServer({ rootDir, chatgptClient: { status: () => ({ accounts: [] }), close: async () => {} }, fetchImpl: async () => Response.json({ data: [] }), ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(rootDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(base + path, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: response.status, value: response.headers.get("content-type")?.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  };
  return { rootDir, api };
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Test condition was not reached.");
}

function wav(frames = 240) {
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVE", 8);
  bytes.write("fmt ", 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24_000, 24); bytes.writeUInt32LE(48_000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(frames * 2, 40);
  return bytes;
}

function accountClient(respond) {
  let active = "account-a";
  return {
    status: () => ({ activeAccountId: active, accounts: ["account-a", "account-b"].map((id) => ({ id, label: id, active: id === active, grant: true, status: "connected" })) }),
    models: async () => [{ slug: "shared-model", display_name: "Shared model", visibility: "list" }],
    select: async (id) => { active = id; }, close: async () => {},
    respond: (request) => respond(request, () => active),
  };
}

test("plan write preconditions reject an old tab and all successful writes advance the stamp", async (t) => {
  const { api } = await start(t);
  const original = (await api("/api/plans", { name: "Original" })).value.plan;
  t.mock.method(Date, "now", () => Date.parse(original.updatedAt));
  const first = await api(`/api/plans/${original.id}`, { ...original, name: "New saved work", expectedUpdatedAt: original.updatedAt }, "PUT");
  assert.equal(first.status, 200);
  assert.equal(Date.parse(first.value.plan.updatedAt), Date.parse(original.updatedAt) + 1);
  const stale = await api(`/api/plans/${original.id}`, { ...original, name: "Old tab", expectedUpdatedAt: original.updatedAt }, "PUT");
  assert.equal(stale.status, 409);
  assert.match(stale.value.error, /another tab/);
  assert.equal((await api(`/api/plans/${original.id}`)).value.plan.name, "New saved work");
  const next = await api(`/api/plans/${original.id}`, { ...first.value.plan, name: "Next", expectedUpdatedAt: first.value.plan.updatedAt }, "PUT");
  assert.equal(next.status, 200);
  assert.equal(Date.parse(next.value.plan.updatedAt), Date.parse(first.value.plan.updatedAt) + 1);
  assert.equal((await api(`/api/plans/${original.id}`, { ...next.value.plan, name: "Old HTTP client" }, "PUT")).status, 200);
});

test("Hosts deletion returns pre-delete revision evidence for a safe own-tab Format rebase", async (t) => {
  const { api } = await start(t);
  const profiles = (await api("/api/state")).value.profiles;
  const deletedId = profiles.speakerProfiles[0].id;
  profiles.speakerProfiles.push({ ...structuredClone(profiles.speakerProfiles[0]), id: "fallback-hosts", name: "Fallback" });
  const saved = await api("/api/profiles", profiles, "PUT");
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  const before = saved.value.profiles;
  const result = await api(`/api/speaker-profiles/${deletedId}`, undefined, "DELETE");
  assert.equal(result.status, 200);
  assert.deepEqual(result.value.beforeRevisions, {
    speakerProfiles: Object.fromEntries(before.speakerProfiles.filter((profile) => profile.id !== deletedId).map((profile) => [profile.id, profile.revision ?? 0])),
    episodeProfiles: Object.fromEntries(before.episodeProfiles.map((profile) => [profile.id, profile.revision ?? 0])),
  });
  const format = result.value.profiles.episodeProfiles[0];
  assert.equal(format.speakerProfileId, "fallback-hosts");
  assert.equal(format.revision, (before.episodeProfiles[0].revision ?? 0) + 1);
  assert.equal(result.value.profiles.speakerProfiles[0].revision, before.speakerProfiles[1].revision ?? 0);
});

test("queued ChatGPT jobs stay pinned to the enqueue account even with identical model catalogs", async (t) => {
  const entered = deferred();
  const gate = deferred();
  t.after(() => gate.resolve());
  const calls = [];
  const client = accountClient(async (request, active) => {
    calls.push(request);
    entered.resolve();
    await gate.promise;
    if (request.accountId !== active()) throw new ChatGptError("chatgpt_account_changed", { status: 409 });
    throw new Error("The account change must prevent generation.");
  });
  const { api } = await start(t, { chatgptClient: client });
  const state = (await api("/api/state")).value;
  for (const [name, provider] of Object.entries(state.config.providers)) provider.enabled = name === "chatgpt";
  state.config.providers.chatgpt.activeModels = { "shared-model": { text: true } };
  assert.equal((await api("/api/config", state.config, "PUT")).status, 200);
  Object.assign(state.profiles.episodeProfiles[0], { outlineModel: "compat:chatgpt:shared-model", transcriptModel: "compat:chatgpt:shared-model" });
  assert.equal((await api("/api/profiles", state.profiles, "PUT")).status, 200);
  const episodes = [];
  for (const name of ["First under A", "Queued under A"]) episodes.push((await api("/api/episodes", { name, episodeProfileId: state.profiles.episodeProfiles[0].id })).value);
  const first = await api(`/api/episodes/${episodes[0].id}/generate`, {});
  assert.equal(first.status, 202);
  await entered.promise;
  const second = await api(`/api/episodes/${episodes[1].id}/generate`, {});
  assert.equal(second.status, 202);
  assert.equal((await api("/api/jobs")).value.jobs.find((job) => job.id === second.value.job.id).status, "queued");
  await api("/api/chatgpt/select", { accountId: "account-b" });
  gate.resolve();
  const jobs = await waitFor(async () => { const result = (await api("/api/jobs")).value; return !result.activeJobId && result.jobs.every((job) => job.status === "failed") && result.jobs; });
  assert.equal(jobs.length, 2);
  assert.match(jobs.find((job) => job.id === second.value.job.id).error, /chatgpt_account_changed/);
  assert.equal(calls.length, 1, "the queued request must not use account B");
  assert.equal(calls[0].accountId, "account-a");
});

test("plan and Knowledge Base deletion cannot race a new unsaved assistant thread", async (t) => {
  const entered = deferred();
  const gate = deferred();
  t.after(() => gate.resolve());
  const { api } = await start(t, { fetchImpl: async (url) => {
    if (String(url).endsWith("/chat/completions")) { entered.resolve(); await gate.promise; return Response.json({ choices: [{ message: { content: JSON.stringify({ message: "Saved answer", proposal: null }) } }] }); }
    return Response.json({ data: [{ id: "mimo-v2.5-pro" }] });
  } });
  const state = (await api("/api/state")).value;
  const kb = (await api("/api/knowledge", { name: "Source.md", content: "Safe test source" })).value;
  const plan = (await api("/api/plans", { name: "Busy plan", knowledgeBaseId: kb.id, planningModel: "mimo-v2.5-pro", speakerProfileId: state.profiles.speakerProfiles[0].id })).value.plan;
  const pending = api("/api/plans/chat", { planId: plan.id, model: "mimo-v2.5-pro", kbId: kb.id, text: "Explain this source." });
  await entered.promise;
  assert.equal((await api(`/api/plans/${plan.id}`, undefined, "DELETE")).status, 409);
  assert.equal((await api(`/api/knowledge/${kb.id}`, undefined, "DELETE")).status, 409);
  gate.resolve();
  const reply = await pending;
  assert.equal(reply.status, 200, JSON.stringify(reply.value));
  assert.equal((await api(`/api/knowledge/${kb.id}`, undefined, "DELETE")).status, 200);
  assert.equal((await api(`/api/chat?threadId=${reply.value.threadId}`)).value.kbId, "");
  assert.equal((await api(`/api/plans/${plan.id}`, undefined, "DELETE")).status, 200);
  assert.equal((await api(`/api/chat?threadId=${reply.value.threadId}`)).status, 404);
});

test("deletion commits before a later chat registers, without a provider call or restored references", async (t) => {
  for (const kind of ["plan", "knowledge", "chat"]) {
    const entered = deferred();
    const gate = deferred();
    t.after(() => gate.resolve());
    let providerCalls = 0;
    const { api, rootDir } = await start(t, { fetchImpl: async (url) => {
      if (String(url).endsWith("/chat/completions")) { providerCalls += 1; return Response.json({ choices: [{ message: { content: JSON.stringify({ message: "Saved response", proposal: null }) } }] }); }
      return Response.json({ data: [{ id: "mimo-v2.5-pro" }] });
    } });
    const kb = (await api("/api/knowledge", { name: "Source.md", content: "Test source" })).value;
    const plan = (await api("/api/plans", { name: "Deletion race", planningModel: "mimo-v2.5-pro", knowledgeBaseId: kb.id })).value.plan;
    const body = { planId: plan.id, model: plan.planningModel, kbId: kb.id, text: "Explain the source." };
    const existing = kind === "chat" ? await api("/api/plans/chat", body) : null;
    if (existing) { assert.equal(existing.status, 200); body.threadId = existing.value.threadId; }
    const before = providerCalls;
    const target = kind === "chat" ? join(rootDir, "data", "chat", `${body.threadId}.json`) : join(rootDir, "data", kind === "plan" ? "plans" : "knowledge", "index.json");
    const method = kind === "chat" ? "rm" : "rename";
    const original = fs[method];
    t.mock.method(fs, method, async (...args) => {
      if (String(args[kind === "chat" ? 0 : 1]) === target) { entered.resolve(); await gate.promise; }
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      const path = kind === "plan" ? `/api/plans/${plan.id}` : kind === "knowledge" ? `/api/knowledge/${kb.id}` : `/api/chat?threadId=${body.threadId}`;
      const deleting = api(path, undefined, "DELETE");
      await entered.promise;
      const sending = api("/api/plans/chat", body);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(providerCalls, before, `${kind}: no provider request while deletion commits`);
      gate.resolve();
      assert.equal((await deleting).status, 200);
      const rejected = await sending;
      assert.equal(rejected.status, kind === "knowledge" ? 400 : 404, JSON.stringify(rejected.value));
      assert.equal(providerCalls, before);
      assert.deepEqual((await api(`/api/chats?planId=${plan.id}`)).value.chats, []);
    } finally {
      gate.resolve();
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  }
});

test("new reserved connection IDs are rejected and a saved custom ChatGPT connection keeps its routing and references", async (t) => {
  const first = await start(t);
  const config = (await first.api("/api/config")).value;
  for (const id of ["chatgpt", "anthropic", "openai", "opencode-go", "chatterbox"]) {
    const result = await first.api("/api/config", { ...config, compatibleConnections: [{ id, name: "Custom", baseUrl: "https://custom.invalid/v1", activeModels: {} }] }, "PUT");
    assert.equal(result.status, 400);
    assert.match(result.value.error, /reserved/);
  }
  const calls = [];
  let nativeCalls = 0;
  const entered = deferred();
  const gate = deferred();
  let pause = false;
  t.after(() => gate.resolve());
  const client = accountClient(async () => { nativeCalls += 1; throw new Error("Custom IDs cannot call ChatGPT plan usage."); });
  const { api, rootDir } = await start(t, { chatgptClient: client, fetchImpl: async (url, options = {}) => {
    const target = String(url);
    calls.push(target);
    if (target === "https://custom.invalid/v1/models") return Response.json({ data: [{ id: "shared-model" }, { id: "custom-tts", capabilities: { tts: true } }] });
    if (target === "https://custom.invalid/v1/chat/completions") { if (pause) { entered.resolve(); await gate.promise; } return Response.json({ choices: [{ message: { content: JSON.stringify({ message: "Custom response", proposal: null }) } }] }); }
    if (target === "https://custom.invalid/v1/audio/speech") { assert.equal(JSON.parse(options.body).model, "custom-tts"); return new Response(wav(), { headers: { "Content-Type": "audio/wav" } }); }
    if (target === "https://api.xiaomimimo.com/v1/models") return Response.json({ data: [{ id: "mimo-v2.5-tts" }] });
    return Response.json({ data: [] });
  } }, async (root) => {
    await mkdir(join(root, "data"), { recursive: true });
    await writeFile(join(root, "data", "config.json"), JSON.stringify({ providers: { chatgpt: { enabled: true, activeModels: { "shared-model": { text: true } } } }, compatibleConnections: [{ id: "chatgpt", name: "Legacy Custom", baseUrl: "https://custom.invalid/v1", activeModels: { "shared-model": { text: true }, "custom-tts": { tts: true } } }] }));
  });
  const stateResult = await api("/api/state");
  assert.equal(stateResult.status, 200, JSON.stringify(stateResult.value));
  const state = stateResult.value;
  const savedConfig = await api("/api/config", state.config, "PUT");
  assert.equal(savedConfig.status, 200, JSON.stringify(savedConfig.value));
  assert.equal(savedConfig.value.modelCatalog.providers.chatgpt.status, "error");
  assert.match(savedConfig.value.modelCatalog.providers.chatgpt.error, /reserved ID "chatgpt".*references are preserved/);
  assert.deepEqual(savedConfig.value.modelCatalog.providers.chatgpt.textModels, []);
  assert.doesNotMatch(savedConfig.value.warnings.join(" "), /compat:chatgpt/);
  const plan = (await api("/api/plans", { name: "Legacy plan", planningModel: "compat:chatgpt:shared-model", speakerProfileId: state.profiles.speakerProfiles[0].id })).value.plan;
  pause = true;
  const pending = api("/api/plans/chat", { planId: plan.id, model: plan.planningModel, text: "Use the custom provider." });
  await entered.promise;
  assert.equal((await api("/api/chatgpt/select", { accountId: "account-b" })).status, 200);
  gate.resolve();
  assert.equal((await pending).status, 200);
  state.profiles.speakerProfiles[0].voiceModel = "compat:chatgpt:custom-tts";
  state.profiles.speakerProfiles[0].speakers[0].voiceId = "custom-voice";
  assert.equal((await api("/api/profiles", state.profiles, "PUT")).status, 200);
  const preview = await api("/api/preview", { episodeProfileId: state.profiles.episodeProfiles[0].id, speakerProfileId: state.profiles.speakerProfiles[0].id, speakerIndex: 0, text: "Custom speech." });
  assert.equal(preview.status, 200, JSON.stringify(preview.value));
  assert.equal(nativeCalls, 0);
  assert.ok(calls.includes("https://custom.invalid/v1/chat/completions"));
  assert.ok(calls.includes("https://custom.invalid/v1/audio/speech"));
  const restored = (await api("/api/state")).value.profiles;
  restored.speakerProfiles[0].voiceModel = "mimo-v2.5-tts";
  assert.equal((await api("/api/profiles", restored, "PUT")).status, 200);
  const current = (await api("/api/config")).value;
  const blocked = await api("/api/config", { ...current, compatibleConnections: [] }, "PUT");
  assert.equal(blocked.status, 409);
  assert.match(blocked.value.error, /content plan "Legacy plan"/);
  assert.equal(JSON.parse(await readFile(join(rootDir, "data", "config.json"), "utf8")).compatibleConnections[0].id, "chatgpt");
});

test("other saved reserved connection IDs use their custom endpoints and activation maps", async (t) => {
  for (const [id, textModel, ttsModel] of [["openai", "gpt-5.6", "tts-1"], ["opencode-go", "minimax-m2.7", "custom-tts"], ["chatterbox", "gpt-5.6", "chatterbox-turbo"], ["anthropic", "claude-custom", "custom-tts"]]) {
    const calls = [];
    const { api } = await start(t, { fetchImpl: async (url, options = {}) => {
      const target = String(url);
      if (target === "https://custom.invalid/v1/models") return Response.json({ data: [{ id: textModel }, { id: ttsModel, capabilities: { tts: true } }] });
      if (target === "https://custom.invalid/v1/chat/completions") { calls.push(target); const body = JSON.parse(options.body); assert.equal(body.max_tokens, 8_000); assert.equal(body.max_completion_tokens, undefined); return Response.json({ choices: [{ message: { content: JSON.stringify({ message: "Custom response", proposal: null }) } }] }); }
      if (target === "https://custom.invalid/v1/audio/speech") { calls.push(target); const body = JSON.parse(options.body); assert.equal(body.response_format, "mp3"); assert.equal(body.exaggeration, undefined); return new Response(wav(), { headers: { "Content-Type": "audio/wav" } }); }
      return Response.json({ data: [] });
    } }, async (root) => {
      await mkdir(join(root, "data"), { recursive: true });
      const profiles = structuredClone(DEFAULT_DATA);
      profiles.speakerProfiles[0].voiceModel = `compat:${id}:${ttsModel}`;
      for (const speaker of profiles.speakerProfiles[0].speakers) speaker.voiceId = "custom-voice";
      Object.assign(profiles.episodeProfiles[0], { outlineModel: `compat:${id}:${textModel}`, transcriptModel: `compat:${id}:${textModel}` });
      await writeFile(join(root, "data", "profiles.json"), JSON.stringify(profiles));
      await writeFile(join(root, "data", "config.json"), JSON.stringify({ compatibleConnections: [{ id, name: "Legacy", baseUrl: "https://custom.invalid/v1", activeModels: {} }] }));
    });
    const state = (await api("/api/state")).value;
    const custom = state.config.compatibleConnections[0];
    assert.equal(custom.activeModels[textModel].text, true);
    assert.equal(custom.activeModels[ttsModel].tts, true);
    const plan = (await api("/api/plans", { name: id, planningModel: `compat:${id}:${textModel}` })).value.plan;
    const chat = await api("/api/plans/chat", { planId: plan.id, model: plan.planningModel, text: "Explain." });
    assert.equal(chat.status, 200, JSON.stringify(chat.value));
    const provider = (await api("/api/models")).value.providers[id === "opencode-go" ? "opencodeGo" : id];
    assert.equal(provider.status, "error");
    assert.match(provider.error, /reserved ID/);
    const preview = await api("/api/preview", { episodeProfileId: state.profiles.episodeProfiles[0].id, speakerProfileId: state.profiles.speakerProfiles[0].id, speakerIndex: 0, text: "Custom speech." });
    assert.equal(preview.status, 200, JSON.stringify(preview.value));
    assert.deepEqual(calls, ["https://custom.invalid/v1/chat/completions", "https://custom.invalid/v1/audio/speech"]);
  }
});

test("ChatGPT capability errors expose only safe diagnostics and name the unsupported setting", async (t) => {
  let diagnostic = { param: "reasoning.effort", bodyShape: "error" };
  const client = accountClient(async () => { throw new ChatGptError("subscription_sharing_unsupported_capability", { status: 400, requestId: "req-test", ...diagnostic }); });
  const { api } = await start(t, { chatgptClient: client });
  const config = (await api("/api/config")).value;
  config.providers.chatgpt = { enabled: true, activeModels: { "shared-model": { text: true } } };
  assert.equal((await api("/api/config", config, "PUT")).status, 200);
  const plan = (await api("/api/plans", { name: "Errors", planningModel: "compat:chatgpt:shared-model" })).value.plan;
  const request = { planId: plan.id, model: plan.planningModel, text: "Test capability error." };
  const result = await api("/api/plans/chat", request);
  assert.equal(result.status, 400);
  assert.equal(result.value.code, "subscription_sharing_unsupported_capability");
  assert.equal(result.value.requestId, "req-test");
  assert.equal(result.value.param, "reasoning.effort");
  assert.equal(result.value.bodyShape, "error");
  assert.match(result.value.error, /does not support parameter "reasoning.effort".*Remove this setting/);
  assert.doesNotMatch(result.value.error, /try again|retry/);
  diagnostic = { param: "secret credential value", bodyShape: '{"access_token":"hidden"}' };
  const unsafe = await api("/api/plans/chat", request);
  assert.equal(unsafe.value.param, undefined);
  assert.equal(unsafe.value.bodyShape, undefined);
  assert.doesNotMatch(JSON.stringify(unsafe.value), /credential|access_token|hidden/);
});

test("ElevenLabs honors discovered legacy limits without cutting tags or SSML breaks", async (t) => {
  const requests = [];
  const { api } = await start(t, { fetchImpl: async (url, options = {}) => {
    if (String(url) === "https://api.elevenlabs.io/v1/models") return Response.json(["eleven_v4", "eleven_v3", "eleven_multilingual_v2", "eleven_flash_v2_5"].map((model_id) => ({ model_id, can_do_text_to_speech: true, maximum_text_length_per_request: 60, languages: [{ language_id: "es", name: "Spanish" }] })));
    if (String(url).includes("/text-to-speech/")) { const body = JSON.parse(options.body); requests.push(body); assert.ok(body.text.length <= 60); return new Response(wav(), { headers: { "Content-Type": "audio/wav" } }); }
    return Response.json({ data: [] });
  } });
  const state = (await api("/api/state")).value;
  state.config.providers.elevenlabs.activeModels = Object.fromEntries(["eleven_v4", "eleven_v3", "eleven_multilingual_v2", "eleven_flash_v2_5"].map((id) => [id, { tts: true }]));
  assert.equal((await api("/api/config", state.config, "PUT")).status, 200);
  let profiles = state.profiles;
  for (const model of ["eleven_v4", "eleven_v3", "eleven_multilingual_v2", "eleven_flash_v2_5"]) {
    profiles.speakerProfiles[0].voiceModel = model;
    profiles.speakerProfiles[0].speakers[0].voiceId = "test-voice";
    const saved = await api("/api/profiles", profiles, "PUT");
    assert.equal(saved.status, 200);
    profiles = saved.value.profiles;
    const squareTags = ["eleven_v3", "eleven_v4"].includes(model);
    const text = squareTags ? "One [quietly and naturally] complete sentence. ".repeat(5).trim() : 'One sentence. <break time="0.5s" /> Next sentence. '.repeat(5).trim();
    const before = requests.length;
    const result = await api("/api/preview", { episodeProfileId: profiles.episodeProfiles[0].id, speakerProfileId: profiles.speakerProfiles[0].id, speakerIndex: 0, text, cue: "calm" });
    assert.equal(result.status, 200, JSON.stringify(result.value));
    const chunks = requests.slice(before);
    assert.ok(chunks.length > 1);
    assert.equal(chunks.map((chunk) => squareTags ? chunk.text.replace(/^\[calm\] /, "") : chunk.text).join(" "), text);
    for (const chunk of chunks) assert.equal((chunk.text.match(/\[/g) || []).length, (chunk.text.match(/\]/g) || []).length);
    for (const sentence of ["1 < 2, and this comparison is true. ", squareTags ? "1 < 2, and 3 > 1. " : '1 < 2. <break time="0.5s" /> 3 > 1. ']) {
      const comparison = sentence.repeat(5).trim();
      const comparisonStart = requests.length;
      const literal = await api("/api/preview", { episodeProfileId: profiles.episodeProfiles[0].id, speakerProfileId: profiles.speakerProfiles[0].id, speakerIndex: 0, text: comparison, cue: "calm" });
      assert.equal(literal.status, 200, JSON.stringify(literal.value));
      assert.equal(requests.slice(comparisonStart).map((chunk) => squareTags ? chunk.text.replace(/^\[calm\] /, "") : chunk.text).join(" "), comparison);
    }
  }
  const before = requests.length;
  const unsafe = await api("/api/preview", { episodeProfileId: profiles.episodeProfiles[0].id, speakerProfileId: profiles.speakerProfiles[0].id, speakerIndex: 0, text: `<prosody rate="slow">${"Word ".repeat(30)}</prosody>` });
  assert.equal(unsafe.status, 400);
  assert.match(unsafe.value.error, /cannot safely split SSML/);
  assert.equal(requests.length, before);
  const unsplittable = await api("/api/preview", { episodeProfileId: profiles.episodeProfiles[0].id, speakerProfileId: profiles.speakerProfiles[0].id, speakerIndex: 0, text: "x".repeat(61) });
  assert.equal(unsplittable.status, 400);
  assert.equal(requests.length, before);
});

test("empty normalized WAV frames fail conversion, preview, and a multi-turn job without publishing", async (t) => {
  let returnEmpty = true;
  const calls = [];
  const { api, rootDir } = await start(t, { fetchImpl: async (url, options = {}) => {
    if (String(url) === "https://api.elevenlabs.io/v1/models") return Response.json([{ model_id: "eleven_v3", can_do_text_to_speech: true, languages: [{ language_id: "es", name: "Spanish" }] }]);
    if (String(url).includes("/text-to-speech/")) { const text = JSON.parse(options.body).text; calls.push(text); return new Response(wav(returnEmpty && text.includes("EMPTY") ? 0 : 240), { headers: { "Content-Type": "audio/wav" } }); }
    return Response.json({ data: [] });
  } });
  await assert.rejects(writeAudioAsWav({ bytes: wav(0), extension: "wav" }, join(rootDir, "empty.wav")), /empty WAV audio.*audio frame/);
  await assert.rejects(readFile(join(rootDir, "empty.wav")), { code: "ENOENT" });
  const state = (await api("/api/state")).value;
  state.config.providers.elevenlabs.activeModels = { eleven_v3: { tts: true } };
  assert.equal((await api("/api/config", state.config, "PUT")).status, 200);
  state.profiles.speakerProfiles[0].voiceModel = "eleven_v3";
  state.profiles.speakerProfiles[0].speakers = [{ ...state.profiles.speakerProfiles[0].speakers[0], voiceId: "test-voice" }];
  assert.equal((await api("/api/profiles", state.profiles, "PUT")).status, 200);
  const preview = await api("/api/preview", { episodeProfileId: state.profiles.episodeProfiles[0].id, speakerProfileId: state.profiles.speakerProfiles[0].id, speakerIndex: 0, text: "EMPTY turn." });
  assert.equal(preview.status, 502);
  assert.match(preview.value.error, /unsupported or invalid audio/);
  const episode = (await api("/api/episodes", { name: "Empty turn", episodeProfileId: state.profiles.episodeProfiles[0].id })).value;
  const speaker = state.profiles.speakerProfiles[0].speakers[0].name;
  assert.equal((await api(`/api/episodes/${episode.id}/transcript`, { transcript: `## Segmento 1\n${speaker}: EMPTY first turn.\n${speaker}: Valid second turn.` }, "PUT")).status, 200);
  const queued = await api(`/api/episodes/${episode.id}/render`, {});
  assert.equal(queued.status, 202);
  const job = await waitFor(async () => { const current = (await api("/api/jobs")).value.jobs.find((item) => item.id === queued.value.job.id); return current?.status === "failed" && current; });
  assert.match(job.error, /empty WAV audio/);
  assert.equal((await api(`/api/episodes/${episode.id}`)).value.audioReady, false);
  await assert.rejects(readFile(join(rootDir, "data", "episodes", episode.id, "episode.mp3")), { code: "ENOENT" });
  returnEmpty = false;
  const valid = await api(`/api/episodes/${episode.id}/render`, {});
  const completed = await waitFor(async () => { const current = (await api("/api/jobs")).value.jobs.find((item) => item.id === valid.value.job.id); return ["failed", "completed"].includes(current?.status) && current; });
  assert.equal(completed.status, "completed", completed.error);
  const mp3Path = join(rootDir, "data", "episodes", episode.id, "episode.mp3");
  const previousMp3 = await readFile(mp3Path);
  const clips = join(rootDir, "data", "episodes", episode.id, "clips");
  const turnClips = (await readdir(clips)).filter((name) => /^[a-f0-9]+\.wav$/.test(name));
  assert.equal(turnClips.length, 2);
  for (const name of turnClips) await writeFile(join(clips, name), wav(0));
  returnEmpty = true;
  const before = calls.length;
  const retry = await api(`/api/episodes/${episode.id}/render`, {});
  await waitFor(async () => (await api("/api/jobs")).value.jobs.find((item) => item.id === retry.value.job.id)?.status === "failed");
  assert.equal(calls.length, before + 1, "an empty cached clip must be synthesized again");
  assert.deepEqual(await readFile(mp3Path), previousMp3, "a failed retry must not replace an existing render");
  assert.equal((await api(`/api/episodes/${episode.id}`)).value.audioReady, true);
});

test("single-clip normalization checks the normalized byte limit before publishing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "podcast-normalized-size-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "oversized.wav");
  const originalStat = fs.stat;
  t.mock.method(fs, "stat", (path, ...options) => String(path) === `${output}.tmp.wav` ? Promise.resolve({ size: 128 * 1024 * 1024 + 1 }) : originalStat(path, ...options));
  syncBuiltinESMExports();
  try {
    await assert.rejects(writeAudioAsWav({ bytes: wav(), extension: "wav" }, output), /Normalized TTS turn exceeds 134217728 byte limit/);
    await assert.rejects(readFile(output), { code: "ENOENT" });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("legacy ElevenLabs models use their documented request limits when discovery omits them", async (t) => {
  const limits = { eleven_v3: 5_000, eleven_multilingual_v2: 10_000, eleven_flash_v2_5: 40_000 };
  const requests = [];
  const { api } = await start(t, { fetchImpl: async (url, options = {}) => {
    if (String(url) === "https://api.elevenlabs.io/v1/models") return Response.json(Object.keys(limits).map((model_id) => ({ model_id, can_do_text_to_speech: true, languages: [{ language_id: "es", name: "Spanish" }] })));
    if (String(url).includes("/text-to-speech/")) { const body = JSON.parse(options.body); requests.push(body); assert.ok(body.text.length <= limits[body.model_id]); return new Response(wav(), { headers: { "Content-Type": "audio/wav" } }); }
    return Response.json({ data: [] });
  } });
  const state = (await api("/api/state")).value;
  state.config.providers.elevenlabs.activeModels = Object.fromEntries(Object.keys(limits).map((id) => [id, { tts: true }]));
  assert.equal((await api("/api/config", state.config, "PUT")).status, 200);
  let profiles = state.profiles;
  for (const [model, maximum] of Object.entries(limits)) {
    profiles.speakerProfiles[0].voiceModel = model;
    profiles.speakerProfiles[0].speakers[0].voiceId = "test-voice";
    profiles = (await api("/api/profiles", profiles, "PUT")).value.profiles;
    const episode = (await api("/api/episodes", { name: model, episodeProfileId: profiles.episodeProfiles[0].id })).value;
    const text = "Short sentence. ".repeat(Math.ceil((maximum + 100) / 16)).trim();
    assert.ok(text.length > maximum);
    assert.equal((await api(`/api/episodes/${episode.id}/transcript`, { transcript: `## Segmento 1\n${profiles.speakerProfiles[0].speakers[0].name} [calm]: ${text}` }, "PUT")).status, 200);
    const before = requests.length;
    const queued = await api(`/api/episodes/${episode.id}/render`, {});
    assert.equal(queued.status, 202);
    const job = await waitFor(async () => { const current = (await api("/api/jobs")).value.jobs.find((item) => item.id === queued.value.job.id); return ["failed", "completed"].includes(current?.status) && current; });
    assert.equal(job.status, "completed", job.error);
    const chunks = requests.slice(before);
    assert.ok(chunks.length > 1);
    assert.equal(chunks.map((chunk) => model === "eleven_v3" ? chunk.text.replace(/^\[calm\] /, "") : chunk.text).join(" "), text);
  }
});
