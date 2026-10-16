import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { runInNewContext } from "node:vm";
import { createPodcastServer, writeAudioAsWav } from "../src/app.mjs";
import { DEFAULT_DATA } from "../src/defaults.mjs";
import { createModelCatalog, openCodeGoProtocol } from "../src/providers/catalog.mjs";
import { callTextModel, synthesizeTurn } from "../src/providers/generate.mjs";
import { fetchBytes, fetchJsonWithBody } from "../src/providers/transport.mjs";

// Keys in the developer's shell would start discovery against the stubs.
const CLEARED_ENV = ["MIMO_API_KEY", "ELEVENLABS_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENCODE_GO_API_KEY", "CHATTERBOX_API_KEY", "TYPESAFE_API_KEY"];
const savedEnv = Object.fromEntries(CLEARED_ENV.map((name) => [name, process.env[name]]));
for (const name of CLEARED_ENV) delete process.env[name];
after(() => restoreEnv(savedEnv));

const LANGUAGE = { id: "en-US", apiCode: "en", name: "English (United States)" };
const chat = (content = "{\"ok\":true}") => Response.json({ choices: [{ message: { content } }] });

function restoreEnv(values) {
  for (const [name, value] of Object.entries(values)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
}

// An undefined value deletes the variable; every variable is restored after the test.
function withEnv(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  restoreEnv(values);
  t.after(() => restoreEnv(saved));
}

async function start(t, options = {}, prepare) {
  const rootDir = await mkdtemp(join(tmpdir(), "podcast-hardening-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await prepare?.(rootDir);
  const server = await createPodcastServer({ rootDir, chatgptClient: { status: () => ({ accounts: [] }), close: async () => {} }, fetchImpl: async () => Response.json({ data: [] }), ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(base + path, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
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

function unitContext(fetchImpl, { apiKey = "sk-custom-secret" } = {}) {
  const modelCatalog = createModelCatalog({});
  modelCatalog.providers.compatible = [{ id: "custom", name: "Custom", status: "ready", textModels: [], ttsModels: [{ id: "compat:custom:tts-1" }], discoveredModels: [] }];
  return {
    fetchImpl,
    modelCatalog,
    credentials: { CUSTOM_API_KEY: apiKey, MIMO_API_KEY: "mimo-key-secret", OPENCODE_GO_API_KEY: "go-key-secret" },
    config: {
      providers: { mimo: { baseUrl: "https://mimo.test/v1" }, opencodeGo: {} },
      compatibleConnections: [{ id: "custom", name: "Custom", baseUrl: "https://custom.test/v1", llmBaseUrl: "", ttsBaseUrl: "", apiKeyEnv: "CUSTOM_API_KEY", enabled: true, activeModels: {} }],
    },
  };
}

const text = (ctx, model = "compat:custom:chat-model") => callTextModel({ context: ctx, model, system: "s", prompt: "p", maxTokens: 100, temperature: 0.5, topP: 1 });
const speak = (ctx) => synthesizeTurn(ctx, { voiceModel: "compat:custom:tts-1" }, { voiceId: "alloy" }, "Hello", "", LANGUAGE);
const hostCopy = (profiles, id) => {
  const host = { ...structuredClone(profiles.speakerProfiles[0]), id, name: `Host ${id}` };
  delete host.revision;
  return host;
};

test("B1: /api/jobs reads only the episodes its jobs name, shows renames, and drops deleted episodes", async (t) => {
  const job = { id: "job-1", episodeId: "ep-1", type: "transcript", status: "failed", queuedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  const { rootDir, api } = await start(t, {}, async (root) => {
    await mkdir(join(root, "data", "episodes", "ep-1"), { recursive: true });
    await writeFile(join(root, "data", "episodes", "ep-1", "episode.json"), JSON.stringify({ id: "ep-1", name: "Old name", status: "draft", updatedAt: job.updatedAt, job }));
  });
  const episodePath = join(rootDir, "data", "episodes", "ep-1", "episode.json");
  await writeFile(episodePath, JSON.stringify({ ...JSON.parse(await readFile(episodePath, "utf8")), name: "New name" }));
  await mkdir(join(rootDir, "data", "episodes", "junk"), { recursive: true });
  await writeFile(join(rootDir, "data", "episodes", "junk", "episode.json"), "{");
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  t.after(() => { console.warn = warn; });
  let response = await api("/api/jobs");
  assert.equal(response.status, 200);
  assert.deepEqual(response.value.jobs.map((item) => [item.id, item.episodeName]), [["job-1", "New name"]]);
  assert.equal(warnings.filter((line) => line.includes("[episode:junk]")).length, 0);
  await rm(join(rootDir, "data", "episodes", "ep-1"), { recursive: true });
  response = await api("/api/jobs");
  assert.deepEqual(response.value.jobs, []);
});

test("B2: profiles.json without both arrays is quarantined at boot and episodes can be created", async (t) => {
  const partial = JSON.stringify({ speakerProfiles: DEFAULT_DATA.speakerProfiles });
  const { rootDir, api } = await start(t, {}, async (root) => {
    await mkdir(join(root, "data"), { recursive: true });
    await writeFile(join(root, "data", "profiles.json"), partial);
  });
  const quarantined = (await readdir(join(rootDir, "data"))).filter((name) => name.startsWith("profiles.json.corrupt-"));
  assert.equal(quarantined.length, 1);
  assert.equal(await readFile(join(rootDir, "data", quarantined[0]), "utf8"), partial);
  const response = await api("/api/episodes", { name: "After repair", episodeProfileId: "episode-chisme-crianza" });
  assert.equal(response.status, 201, response.value.error);
});

test("B3: a plans or knowledge index that is valid JSON but not an array is quarantined and /api/state works", async (t) => {
  const { rootDir, api } = await start(t, {}, async (root) => {
    await mkdir(join(root, "data", "plans"), { recursive: true });
    await writeFile(join(root, "data", "plans", "index.json"), "{}");
    await mkdir(join(root, "data", "knowledge"), { recursive: true });
    await writeFile(join(root, "data", "knowledge", "index.json"), "{}");
  });
  const response = await api("/api/state");
  assert.equal(response.status, 200, response.value.error);
  assert.deepEqual(response.value.plans, []);
  assert.equal((await readdir(join(rootDir, "data", "plans"))).filter((name) => name.startsWith("index.json.corrupt-")).length, 1);
  assert.equal((await readdir(join(rootDir, "data", "knowledge"))).filter((name) => name.startsWith("index.json.corrupt-")).length, 1);
});

test("B3: a corrupt plan file that boot does not quarantine fails with an error that names the file", async (t) => {
  const { rootDir, api } = await start(t, {}, async (root) => {
    await mkdir(join(root, "data", "plans"), { recursive: true });
    await writeFile(join(root, "data", "plans", "index.json"), JSON.stringify([{ id: "p1", name: "Plan" }]));
    await writeFile(join(root, "data", "plans", "p1.json"), "{");
  });
  const response = await api("/api/plans/p1");
  assert.equal(response.status, 500);
  assert.ok(response.value.error.includes(`${join(rootDir, "data", "plans", "p1.json")} is not valid JSON`), response.value.error);
});

test("B4: a stale tab cannot bring back a host that another tab deleted", async (t) => {
  const { api } = await start(t);
  const { profiles } = (await api("/api/state")).value;
  let response = await api("/api/profiles", { ...profiles, speakerProfiles: [...profiles.speakerProfiles, hostCopy(profiles, "second-host")], expectedUpdatedAt: profiles.updatedAt }, "PUT");
  assert.equal(response.status, 200, response.value.error);
  const tabB = response.value.profiles;
  assert.equal((await api("/api/speaker-profiles/second-host", undefined, "DELETE")).status, 200);
  response = await api("/api/profiles", { ...tabB, expectedUpdatedAt: tabB.updatedAt }, "PUT");
  assert.equal(response.status, 409);
  assert.match(response.value.error, /Reload the page, then apply the change again/);
  assert.equal((await api("/api/state")).value.profiles.speakerProfiles.some((item) => item.id === "second-host"), false);
});

test("B4: a stale tab cannot silently delete a host that another tab added; requests without the field keep old behavior", async (t) => {
  const { api } = await start(t);
  // A baseline save normalizes the seed, so the per-profile revision check alone would not catch tab B.
  const baseline = await api("/api/profiles", (await api("/api/state")).value.profiles, "PUT");
  assert.equal(baseline.status, 200, baseline.value.error);
  const { profiles } = baseline.value;
  const tabA = structuredClone(profiles);
  const tabB = structuredClone(profiles);
  let response = await api("/api/profiles", { ...tabA, speakerProfiles: [...tabA.speakerProfiles, hostCopy(tabA, "host-x")], expectedUpdatedAt: tabA.updatedAt }, "PUT");
  assert.equal(response.status, 200, response.value.error);
  response = await api("/api/profiles", { ...tabB, expectedUpdatedAt: tabB.updatedAt }, "PUT");
  assert.equal(response.status, 409);
  const current = (await api("/api/state")).value.profiles;
  assert.equal(current.speakerProfiles.some((item) => item.id === "host-x"), true);
  assert.equal(Object.hasOwn(current, "expectedUpdatedAt"), false);
  response = await api("/api/profiles", current, "PUT");
  assert.equal(response.status, 200, response.value.error);
});

test("B4: every profiles.json writer advances updatedAt, so single-tab save, add, delete, plan, and apply flows never conflict", async (t) => {
  withEnv(t, { MIMO_API_KEY: "single-tab-mimo-key" });
  const generatedPlan = { episodeFormat: { name: "Generated format", description: "Created by plan generation" }, episodes: [{ number: 1, title: "Only" }] };
  const proposal = { message: "Add Charlie.", questions: [], proposal: { speakerProfile: { mode: "create", value: { name: "Charlie", voiceModel: "mimo-v2.5-tts", speakers: [{ name: "Charlie", voiceId: "Mia" }] } } } };
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith("/chat/completions")) {
      const request = JSON.parse(init.body);
      return chat(JSON.stringify(request.messages[0].content.includes("podcast content planner") ? generatedPlan : proposal));
    }
    return Response.json({ data: [{ id: "mimo-v2.5-pro" }, { id: "mimo-v2.5-tts" }] });
  };
  const { api } = await start(t, { fetchImpl });
  await waitFor(async () => (await api("/api/models")).value.providers.mimo.status === "ready");
  let profiles = (await api("/api/state")).value.profiles;
  const seen = [profiles.updatedAt];
  const adopt = (next) => {
    assert.ok(next.updatedAt > seen.at(-1), `updatedAt must advance past ${seen.at(-1)}`);
    seen.push(next.updatedAt);
    profiles = next;
  };
  const save = async (value) => {
    const response = await api("/api/profiles", { ...value, expectedUpdatedAt: profiles.updatedAt }, "PUT");
    assert.equal(response.status, 200, response.value.error);
    adopt(response.value.profiles);
  };
  assert.equal(typeof profiles.updatedAt, "string");
  await save(profiles);
  await save({ ...profiles, speakerProfiles: [...profiles.speakerProfiles, hostCopy(profiles, "added-host")] });
  let response = await api("/api/speaker-profiles/added-host", undefined, "DELETE");
  assert.equal(response.status, 200, response.value.error);
  assert.equal(response.value.previousProfilesUpdatedAt, profiles.updatedAt);
  adopt(response.value.profiles);
  response = await api("/api/plans", { name: "Plan", speakerProfileId: profiles.speakerProfiles[0].id, planningModel: "mimo-v2.5-pro", theme: "Theme", audience: "Everyone", goal: "Learn", episodeCount: 1 });
  assert.equal(response.status, 201, response.value.error);
  const plan = response.value.plan;
  response = await api(`/api/plans/${plan.id}/generate`, {});
  assert.equal(response.status, 200, response.value.error);
  adopt(response.value.profiles);
  response = await api("/api/plans/chat", { planId: plan.id, text: "Add Charlie", model: "mimo-v2.5-pro" });
  assert.equal(response.status, 200, response.value.error);
  const thread = (await api(`/api/chat?threadId=${response.value.threadId}`)).value;
  response = await api("/api/plans/chat/apply", { threadId: response.value.threadId, messageIndex: thread.messages.findLastIndex((message) => message.role === "assistant") });
  assert.equal(response.status, 200, response.value.error);
  assert.equal(response.value.previousProfilesUpdatedAt, profiles.updatedAt);
  adopt(response.value.profiles);
  await save(profiles);
});

test("B4: the page sends the loaded updatedAt and adopts the saved one, so a second save is not stale", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  const source = (name) => script.match(new RegExp(`    (?:async )?function ${name}\\([^]*?\\n    }`))[0];
  const noop = () => {};
  const sent = [];
  let serverUpdatedAt = "v1";
  const context = {
    structuredClone, uiRequests: { state: 0 }, profilesDirty: true,
    state: { profiles: { speakerProfiles: [{ id: "s", name: "Hosts" }], episodeProfiles: [{ id: "f", name: "Format" }], updatedAt: "v1" } },
    activeViewName: () => "transcript", validateControls: () => true, $: () => ({}), notify: noop,
    syncSpeakerForm: noop, syncFormatForm: noop, renderProfileOptions: noop, renderBuildOptions: noop, renderFormatView: noop, renderEpisodeSettingsFields: noop, renderTtsView: noop,
    api: async (_, options) => {
      const { expectedUpdatedAt, ...profiles } = JSON.parse(options.body);
      sent.push(expectedUpdatedAt);
      if (expectedUpdatedAt !== serverUpdatedAt) throw new Error("Profiles changed somewhere else after this page loaded.");
      serverUpdatedAt = `${serverUpdatedAt}+`;
      return { profiles: { ...profiles, updatedAt: serverUpdatedAt } };
    },
  };
  runInNewContext(["saveEditor", "saveProfiles"].map(source).join("\n"), context);
  await context.saveProfiles();
  await context.saveProfiles();
  assert.deepEqual(sent, ["v1", "v1+"]);
  assert.equal(context.state.profiles.updatedAt, "v1++");
  assert.equal(context.profilesDirty, false);
});

test("B4: the page adopts updatedAt after host delete and Apply only when it held the replaced one", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  const source = (name) => script.match(new RegExp(`    (?:async )?function ${name}\\([^]*?\\n    }`))[0];
  const deleteListener = script.match(/\$\("deleteSpeakerProfile"\)\.addEventListener\("click", (guard\([^]*?\}\))\);\n    \$\("saveProfiles"\)/)[1];
  const noop = () => {};
  const hosts = () => [{ id: "s", name: "Hosts" }, { id: "x", name: "Host X" }];
  let server = "v1";
  const sent = [];
  const write = (speakerProfiles) => {
    const previousProfilesUpdatedAt = server;
    server = `${server}+`;
    return { previousProfilesUpdatedAt, profiles: { speakerProfiles, episodeProfiles: [{ id: "f", name: "Format", speakerProfileId: "s" }], updatedAt: server } };
  };
  const context = {
    structuredClone, uiRequests: { state: 0 }, profilesDirty: false, activeSpeakerProfileId: "x", activePlan: { id: "p" }, activePlanId: "p", currentEpisode: null,
    plannerChatThreadId: "t", plannerChatThread: { threadId: "t", messages: [{ role: "assistant", content: JSON.stringify({ proposal: { speakerProfile: {} } }) }] },
    state: { plans: [], episodes: [], profiles: { speakerProfiles: hosts(), episodeProfiles: [{ id: "f", name: "Format", speakerProfileId: "s" }], updatedAt: "v1" } },
    guard: (action) => action, confirm: () => true, notify: noop, activeViewName: () => "transcript", validateControls: () => true,
    $: () => ({}), document: { querySelectorAll: () => [] },
    syncSpeakerForm: noop, syncFormatForm: noop, renderProfileOptions: noop, renderBuildOptions: noop, renderFormatView: noop, renderEpisodeSettingsFields: noop, renderTtsView: noop,
    refreshState: noop, refreshPlanIndex: noop, refreshPlanVersionAfterRepoint: noop, loadPlannerChatThread: noop, loadSpeakerForm: noop, loadPlanForm: noop,
    api: async (path, options) => {
      if (options.method === "DELETE") return { ...write([{ id: "s", name: "Hosts" }]), fallbackId: "s" };
      if (path === "/api/plans/chat/apply") return { ...write(hosts()), appliedType: "speakerProfile", appliedId: "s", plan: null, warnings: [] };
      const { expectedUpdatedAt, ...profiles } = JSON.parse(options.body);
      sent.push(expectedUpdatedAt);
      if (expectedUpdatedAt !== server) throw new Error("Profiles changed somewhere else after this page loaded.");
      return write(profiles.speakerProfiles);
    },
  };
  runInNewContext(`${["saveEditor", "saveProfiles", "mergeAppliedHostsDraft", "applyAssistantProposal"].map(source).join("\n")}\ndeleteHost = ${deleteListener};`, context);
  await context.deleteHost();
  await context.saveProfiles();
  await context.applyAssistantProposal(0, false);
  await context.saveProfiles();
  assert.deepEqual(sent, ["v1+", "v1+++"]);
  // Another tab wrote in between: neither response may launder this tab's stale list.
  context.state.profiles.speakerProfiles = hosts();
  context.activeSpeakerProfileId = "x";
  server = "other-tab";
  await context.deleteHost();
  await assert.rejects(context.saveProfiles(), /changed somewhere else/);
  context.profilesDirty = false;
  await context.applyAssistantProposal(0, false);
  await assert.rejects(context.saveProfiles(), /changed somewhere else/);
  assert.deepEqual(sent.slice(2), ["v1++++", "v1++++"]);
});

test("B7: a 2xx body with an object error fails with the provider message on SDK JSON paths", async () => {
  const fetchImpl = async () => Response.json({ error: { message: "invalid api key" } });
  await assert.rejects(text(unitContext(fetchImpl)), /^Error: Custom chat request failed: invalid api key$/);
  await assert.rejects(text(unitContext(fetchImpl), "mimo-v2.5"), /^Error: MiMo request failed: invalid api key$/);
});

test("B8: a 2xx JSON or text body is not accepted as audio on the SDK and raw paths", async () => {
  const jsonBody = async () => Response.json({ error: "quota exceeded" });
  await assert.rejects(speak(unitContext(jsonBody)), /Custom TTS returned application\/json instead of audio: .*quota exceeded/);
  await assert.rejects(fetchBytes(async () => new Response("quota exceeded", { headers: { "content-type": "text/plain" } }), "https://api.elevenlabs.io/v1/text-to-speech/v", {}, "ElevenLabs TTS", 1_000),
    /^Error: ElevenLabs TTS returned text\/plain instead of audio: quota exceeded$/);
  const audio = await fetchBytes(async () => new Response(Buffer.from("ID3audio"), { headers: { "content-type": "audio/mpeg" } }), "https://api.elevenlabs.io/v1/text-to-speech/v", {}, "ElevenLabs TTS", 1_000);
  assert.equal(audio.extension, "mp3");
});

test("B9: a WAV that is not RIFF names the provider that returned it", async (t) => {
  const audio = await speak(unitContext(async () => new Response(Buffer.from("not a wav file"), { headers: { "content-type": "audio/wav" } })));
  const directory = await mkdtemp(join(tmpdir(), "podcast-hardening-wav-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(writeAudioAsWav(audio, join(directory, "clip.wav")), /^Error: Custom TTS returned audio data, but it is not a WAV RIFF file\.$/);
});

test("B10: model and voice parsing skips null entries and a non-array voices field", async (t) => {
  withEnv(t, { MIMO_API_KEY: "parse-mimo-key", ELEVENLABS_API_KEY: "parse-eleven-key" });
  let voices = {};
  const fetchImpl = async (url) => {
    if (String(url).startsWith("https://api.elevenlabs.io/v2/voices")) return Response.json({ voices });
    if (String(url).startsWith("https://api.elevenlabs.io/")) return Response.json([]);
    return Response.json({ data: [null, { id: "mimo-v2.5" }] });
  };
  const { api } = await start(t, { fetchImpl });
  const mimo = await waitFor(async () => {
    const provider = (await api("/api/models")).value.providers.mimo;
    return provider.status === "loading" ? null : provider;
  });
  assert.equal(mimo.status, "ready", mimo.error);
  assert.deepEqual(mimo.discoveredModels.map((model) => model.id), ["mimo-v2.5"]);
  let response = await api("/api/tts/elevenlabs/voices");
  assert.equal(response.status, 200, response.value.error);
  assert.deepEqual(response.value.voices, []);
  voices = [null, { voice_id: "v1", name: "Voice", verified_languages: [null] }];
  response = await api("/api/tts/elevenlabs/voices");
  assert.equal(response.status, 200, response.value.error);
  assert.deepEqual(response.value.voices.map((voice) => voice.id), ["v1"]);
});

test("B10: the ChatGPT model catalog skips a null model entry", async (t) => {
  const chatgptClient = {
    status: () => ({ activeAccountId: "account-a", accounts: [{ id: "account-a", label: "a", active: true, grant: true, status: "connected" }] }),
    models: async () => [null, { slug: "model-a", display_name: "Model A", visibility: "list" }], close: async () => {},
  };
  // PUT /api/config writes MIMO_BASE_URL into process.env.
  withEnv(t, { MIMO_BASE_URL: process.env.MIMO_BASE_URL });
  const { api } = await start(t, { chatgptClient });
  const { config } = (await api("/api/state")).value;
  config.providers.chatgpt.enabled = true;
  assert.equal((await api("/api/config", config, "PUT")).status, 200);
  const chatgpt = await waitFor(async () => {
    const provider = (await api("/api/models")).value.providers.chatgpt;
    return ["loading", "unconfigured"].includes(provider.status) ? null : provider;
  });
  assert.equal(chatgpt.status, "ready", chatgpt.error);
  assert.deepEqual(chatgpt.discoveredModels.map((model) => model.rawId), ["model-a"]);
});

test("B11: discovery reports every failed /models URL, and an unconfigured provider names its key", async (t) => {
  withEnv(t, { OPENAI_API_KEY: "two-url-openai-key" });
  const fetchImpl = async (url) => String(url).startsWith("http://llm.test/") ? new Response("gateway down", { status: 502 })
    : String(url).startsWith("http://tts.test/") ? new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401, headers: { "content-type": "application/json" } })
      : Response.json({ data: [] });
  const { api } = await start(t, { fetchImpl }, async (root) => {
    await mkdir(join(root, "data"), { recursive: true });
    await writeFile(join(root, "data", "config.json"), JSON.stringify({ providers: { openai: { llmBaseUrl: "http://llm.test/v1", ttsBaseUrl: "http://tts.test/v1" } } }));
  });
  const catalog = await waitFor(async () => {
    const value = (await api("/api/models")).value;
    return value.providers.openai.status === "error" ? value : null;
  });
  assert.match(catalog.providers.openai.error, /HTTP 502/);
  assert.match(catalog.providers.openai.error, /HTTP 401/);
  assert.equal(catalog.providers.mimo.error, "MiMo API key is not configured. Set MIMO_API_KEY in .env.");
});

test("B12: OpenCode Go keeps every listed id on its protocol and routes new ids by family", () => {
  const chatModels = ["grok-4.5", "glm-5.2", "glm-5.1", "glm-5", "kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5", "deepseek-v4-pro", "deepseek-v4-flash", "mimo-v2.5", "mimo-v2.5-pro", "mimo-v2-pro", "mimo-v2-omni", "hy3", "hy3-preview"];
  const messagesModels = ["minimax-m3", "minimax-m2.7", "minimax-m2.5", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.5-plus"];
  for (const id of chatModels) assert.equal(openCodeGoProtocol(id), "chat", id);
  for (const id of messagesModels) assert.equal(openCodeGoProtocol(id), "messages", id);
  assert.equal(openCodeGoProtocol("kimi-k4"), "chat");
  assert.equal(openCodeGoProtocol("minimax-m4"), "messages");
  assert.equal(openCodeGoProtocol("qwen4-max"), "messages");
  assert.equal(openCodeGoProtocol("future-unknown"), null);
  assert.equal(openCodeGoProtocol(""), null);
});

test("S1: an error body that echoes the key never puts the key into the error message", async () => {
  const echo = (status, body) => async () => new Response(body, { status, headers: { "content-type": "application/json", "x-should-retry": "false" } });
  const chatError = await text(unitContext(echo(400, JSON.stringify({ error: { message: "Incorrect API key provided: sk-custom-secret" } })))).then(() => null, (error) => error);
  assert.match(chatError.message, /Incorrect API key provided: \[redacted\]/);
  const mimoError = await text(unitContext(echo(400, "rejected header api-key: mimo-key-secret")), "mimo-v2.5").then(() => null, (error) => error);
  assert.doesNotMatch(mimoError.message, /mimo-key-secret/);
  const goError = await text(unitContext(echo(401, JSON.stringify({ error: { message: "x-api-key go-key-secret is not valid" } }))), "compat:opencode-go:minimax-m3").then(() => null, (error) => error);
  assert.doesNotMatch(goError.message, /go-key-secret/);
  await assert.rejects(fetchJsonWithBody(echo(401, "Authorization: Bearer leaked-token-value"), "https://voices.test", { headers: { "xi-api-key": "eleven-secret-key" } }, "ElevenLabs voices", 1_000),
    (error) => /Bearer \[redacted\]/.test(error.message) && !/leaked-token-value/.test(error.message));
  await assert.rejects(fetchBytes(echo(401, "Missing bearer token; api-key: missing"), "https://tts.test", {}, "ElevenLabs TTS", 1_000),
    (error) => /Missing bearer token; api-key: missing/.test(error.message));
  await assert.rejects(fetchBytes(echo(401, "bad key eleven-secret-key"), "https://tts.test", { headers: { "xi-api-key": "eleven-secret-key" } }, "ElevenLabs TTS", 1_000),
    (error) => /bad key \[redacted\]/.test(error.message));
  // A 2xx body can carry an error object or a JSON error page in place of audio.
  for (const [model, key] of [["compat:custom:chat-model", "sk-custom-secret"], ["mimo-v2.5", "mimo-key-secret"], ["compat:opencode-go:kimi-k3", "go-key-secret"], ["compat:opencode-go:minimax-m3", "go-key-secret"]]) {
    const error = await text(unitContext(echo(200, JSON.stringify({ error: { message: `key ${key} has no quota` } }))), model).then(() => null, (failure) => failure);
    assert.match(error.message, /key \[redacted\] has no quota/, model);
  }
  const ttsError = await speak(unitContext(echo(200, JSON.stringify({ error: "invalid key sk-custom-secret" })))).then(() => null, (error) => error);
  assert.match(ttsError.message, /instead of audio: .*invalid key \[redacted\]/);
  await assert.rejects(fetchBytes(echo(200, "{\"detail\":\"bad key eleven-secret-key\"}"), "https://tts.test", { headers: { "xi-api-key": "eleven-secret-key" } }, "ElevenLabs TTS", 1_000),
    (error) => /instead of audio: .*bad key \[redacted\]/.test(error.message));
});

test("S2: clients that send the key in a non-Authorization header do not follow redirects", async () => {
  const inits = [];
  const fetchImpl = async (url, init) => {
    inits.push([String(url), init.redirect]);
    return String(url).endsWith("/messages") ? Response.json({ content: [{ type: "text", text: "{}" }] }) : chat();
  };
  await text(unitContext(fetchImpl), "mimo-v2.5");
  await text(unitContext(fetchImpl), "compat:opencode-go:minimax-m3");
  await text(unitContext(fetchImpl));
  assert.deepEqual(inits, [
    ["https://mimo.test/v1/chat/completions", "error"],
    ["https://opencode.ai/zen/go/v1/messages", "error"],
    ["https://custom.test/v1/chat/completions", undefined],
  ]);
  const raw = [];
  const rawFetch = async (url, init) => { raw.push(init.redirect); return Response.json({}); };
  await fetchJsonWithBody(rawFetch, "https://api.elevenlabs.test/v1/models", { headers: { "xi-api-key": "eleven-secret-key" } }, "ElevenLabs models", 1_000);
  await fetchJsonWithBody(rawFetch, "https://voices.test/v1/audio/voices", { headers: { Authorization: "Bearer token" } }, "Chatterbox voices", 1_000);
  assert.deepEqual(raw, ["error", undefined]);
  // Undici's shape for a refused redirect: the reason sits on the cause of "fetch failed".
  const refuse = async () => { throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") }); };
  await assert.rejects(text(unitContext(refuse), "mimo-v2.5"), /^Error: MiMo request failed: fetch failed \(unexpected redirect\)$/);
  await assert.rejects(fetchJsonWithBody(refuse, "https://api.elevenlabs.test/v1/models", { headers: { "xi-api-key": "eleven-secret-key" } }, "ElevenLabs models", 1_000), /^Error: ElevenLabs models request failed: fetch failed \(unexpected redirect\)$/);
});

test("S3: a 401 on a connection that sent no key says the provider needs a key", async () => {
  const unauthorized = async () => new Response(JSON.stringify({ error: { message: "missing credentials" } }), { status: 401, headers: { "content-type": "application/json", "x-should-retry": "false" } });
  const keyless = await text(unitContext(unauthorized, { apiKey: "" })).then(() => null, (error) => error);
  assert.match(keyless.message, /requires an API key and none is configured\. Set CUSTOM_API_KEY in \.env/);
  assert.doesNotMatch(keyless.message, /rejected/);
  const keyed = await text(unitContext(unauthorized)).then(() => null, (error) => error);
  assert.match(keyed.message, /The provider rejected CUSTOM_API_KEY/);
});

test("D2: the raw fetch helpers keep their timeout message", async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  await assert.rejects(fetchJsonWithBody(hang, "https://slow.test", {}, "Slow voices", 50), /^Error: Slow voices request timed out after 0\.05 seconds\.$/);
  await assert.rejects(fetchBytes(hang, "https://slow.test", {}, "Slow TTS", 50), /^Error: Slow TTS request timed out after 0\.05 seconds\.$/);
});
