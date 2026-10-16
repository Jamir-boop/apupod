import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createPodcastServer } from "../src/app.mjs";
import { ChatGptError } from "../src/chatgpt.mjs";
import { DECISIONS_MODEL } from "../src/decisions.mjs";

process.env.OPENCODE_GO_API_KEY = "test-opencode-go-key";

async function start(t, options = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "pod-god-integrations-"));
  const server = await createPodcastServer({ rootDir, chatgptClient: { status: () => ({ accounts: [] }), close: async () => {} }, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(rootDir, { recursive: true, force: true }); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, value, method = value === undefined ? "GET" : "POST") => {
    const response = await fetch(baseUrl + path, { method, ...(value === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }) });
    return { status: response.status, value: await response.json() };
  };
  return { rootDir, baseUrl, api };
}

function chatGptMock() {
  let active = null;
  let pending = null;
  let closed = false;
  let lastSignIn = { status: "idle" };
  const accounts = [{ id: "account-a", label: "A", grant: true, status: "connected" }, { id: "account-b", label: "B", grant: true, status: "connected" }];
  const calls = [];
  let wait = null;
  return {
    calls, get closed() { return closed; },
    status: () => ({ activeAccountId: active, accounts: accounts.map((account) => ({ ...account, active: account.id === active, tokens: "DO_NOT_EXPOSE" })), pending, lastSignIn, accessToken: "DO_NOT_EXPOSE" }),
    signIn: async () => { pending = { status: "waiting", accountId: null }; return { authorizeUrl: "https://auth.openai.com/api/accounts/authorize?state=test" }; },
    complete: () => { active = "account-a"; pending = null; lastSignIn = { status: "complete" }; },
    select: async (id) => { if (!accounts.some((account) => account.id === id)) throw new ChatGptError("chatgpt_account_not_found", { status: 404 }); active = id; pending = null; },
    signOut: async () => { active = null; pending = null; return { revoked: true }; },
    cancel: () => { pending = null; lastSignIn = { status: "cancelled" }; },
    models: async (id) => { assert.equal(id, active); return [{ slug: id === "account-a" ? "account-model-a" : "account-model-b", display_name: "Account model", visibility: "list" }, { slug: "hidden-model", display_name: "Hidden", visibility: "hidden" }]; },
    respond: async (request) => {
      calls.push(request);
      if (wait) await wait;
      if (active !== request.accountId) throw new ChatGptError("chatgpt_account_changed", { status: 409 });
      return { choices: [{ message: { content: JSON.stringify({ message: "Account response", questions: [], proposal: null, nextStep: null }) } }] };
    },
    pause: () => { let release; wait = new Promise((resolve) => { release = resolve; }); return () => { release(); wait = null; }; },
    close: async () => { closed = true; pending = null; },
  };
}

test("ChatGPT account routes are guarded, redacted, text-only, and pinned without API-key fallback", async (t) => {
  const client = chatGptMock();
  const { api, baseUrl } = await start(t, { chatgptClient: client, fetchImpl: async (url) => { throw new Error(`No API-key call is allowed: ${url}`); } });
  const state = (await api("/api/state")).value;
  assert.equal(state.config.providers.chatgpt.enabled, false);
  assert.equal(state.config.assistantDecision.enabled, false);
  let result = await api("/api/chatgpt/status");
  assert.doesNotMatch(JSON.stringify(result.value), /DO_NOT_EXPOSE|accessToken|tokens/);
  let response = await fetch(baseUrl + "/api/chatgpt/signin", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.invalid" }, body: "{}" });
  assert.equal(response.status, 403);
  response = await fetch(baseUrl + "/api/chatgpt/signin", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(response.status, 415);
  result = await api("/api/chatgpt/signin", {});
  assert.equal(result.status, 200);
  assert.match(result.value.authorizeUrl, /^https:\/\/auth\.openai\.com\/api\/accounts\/authorize/);
  assert.equal(result.value.pending.status, "waiting");
  assert.equal((await api("/api/chatgpt/cancel", {})).value.pending, null);
  await api("/api/chatgpt/signin", {});
  client.complete();
  assert.equal((await api("/api/chatgpt/status")).value.activeAccountId, "account-a");
  state.config.providers.chatgpt = { enabled: true, activeModels: { "account-model-a": { text: true, tts: true }, "account-model-b": { text: true } } };
  result = await api("/api/config", state.config, "PUT");
  const provider = result.value.modelCatalog.providers.chatgpt;
  assert.deepEqual(provider.ttsModels, []);
  assert.deepEqual(provider.textModels.map((model) => model.id), ["compat:chatgpt:account-model-a"]);
  assert.equal(result.value.config.providers.chatgpt.activeModels["account-model-a"].tts, false);
  const plan = (await api("/api/plans", { name: "Test", theme: "Topic", speakerProfileId: state.profiles.speakerProfiles[0].id, planningModel: "compat:chatgpt:account-model-a" })).value.plan;
  result = await api("/api/plans/chat", { planId: plan.id, model: "compat:chatgpt:account-model-a", text: "Explain this plan." });
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(client.calls[0].accountId, "account-a");
  assert.equal(client.calls[0].model, "account-model-a");
  assert.deepEqual(Object.keys(client.calls[0]).sort(), ["accountId", "model", "prompt", "system"]);
  const release = client.pause();
  const pending = api("/api/plans/chat", { planId: plan.id, model: "compat:chatgpt:account-model-a", text: "A slow request." });
  while (client.calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  result = await api("/api/chatgpt/select", { accountId: "account-b" });
  assert.deepEqual(result.value.modelCatalog.providers.chatgpt.textModels.map((model) => model.id), ["compat:chatgpt:account-model-b"]);
  release();
  result = await pending;
  assert.equal(result.status, 409);
  assert.match(result.value.error, /account changed/);
  assert.doesNotMatch(JSON.stringify(result.value), /DO_NOT_EXPOSE/);
  await api("/api/chatgpt/signout", { accountId: "account-b" });
  result = await api("/api/plans/chat", { planId: plan.id, model: "compat:chatgpt:account-model-b", text: "After sign-out." });
  assert.equal(result.status, 400);
  assert.equal(client.calls.length, 2);
});

const hashId = (id) => ["keep_current", "not_requested", "clarify"].includes(id) ? id : `option_${createHash("sha256").update(id).digest("hex")}`;

function jevMock() {
  const requests = [];
  const generations = [];
  const choices = { route: "speakerProfile", profileAction: "create", speakerCount: "1", voiceModel: "eleven_v4", "speakers.0.voiceId": "es-voice" };
  let lowConfidence = false;
  let unavailable = false;
  let removedVoice = "";
  let generated = { message: "Proposed hosts", proposal: { speakerProfile: { mode: "update", targetId: "invented", value: { name: "Charlie", voiceModel: "mimo-v2.5-tts", speakers: [{ name: "Charlie", backstory: "A host", personality: "Calm", style: "Natural", voiceId: "alloy", elevenlabsSpeed: 1.19 }] } } } };
  return {
    requests, generations, choices,
    set lowConfidence(value) { lowConfidence = value; }, set unavailable(value) { unavailable = value; }, set generated(value) { generated = value; },
    set removedVoice(value) { removedVoice = value; },
    fetchImpl: async (url, options = {}) => {
      if (String(url).includes("typesafe.ai")) {
        const request = JSON.parse(options.body);
        requests.push(request);
        assert.equal(options.headers.Authorization, "Bearer test-typesafe-key");
        assert.equal(request.model, "jev-1.13.0");
        assert.doesNotMatch(JSON.stringify(request.state), /test-typesafe-key|FULL_KNOWLEDGE/);
        if (unavailable) return Response.json({ secret: "do not expose" }, { status: 503 });
        return Response.json({ model: "jev-1.13.0", answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
          if (question.type === "noul") return [id, { type: "noul", noul: 1 }];
          const selected = hashId(choices[id] || "keep_current");
          return [id, { type: "choice", choice: selected, confidence: lowConfidence ? 0.2 : 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === selected ? 1 : 0])) }];
        })) });
      }
      if (String(url).includes("xiaomimimo.com") && String(url).endsWith("/models")) return Response.json({ data: [{ id: "mimo-v2.5-pro" }, { id: "mimo-v2.5" }, { id: "mimo-v2.5-tts" }] });
      if (String(url).includes("xiaomimimo.com") && String(url).endsWith("/chat/completions")) { generations.push(JSON.parse(options.body)); return Response.json({ choices: [{ message: { content: JSON.stringify(generated) } }] }); }
      if (String(url).endsWith("/v1/models")) return Response.json([{ model_id: "eleven_v4", name: "Eleven v4", can_do_text_to_speech: true, languages: [{ language_id: "es", name: "Spanish" }] }, { model_id: "eleven_flash_v2_5", name: "Flash", can_do_text_to_speech: true, languages: [{ language_id: "es", name: "Spanish" }] }]);
      if (String(url).includes("/v2/voices")) return Response.json({ voices: [{ voice_id: "es-voice", name: "Spanish voice", labels: { language: "es", accent: "Latin American" } }, { voice_id: "second-voice", name: "Second Spanish voice", labels: { language: "es" } }].filter((voice) => voice.voice_id !== removedVoice) });
      throw new Error(`Unexpected request ${url}`);
    },
  };
}

async function jevSetup(t, mock) {
  const previous = { mimo: process.env.MIMO_API_KEY, eleven: process.env.ELEVENLABS_API_KEY, typesafe: process.env.TYPESAFE_API_KEY };
  process.env.MIMO_API_KEY = "test-mimo-key";
  process.env.ELEVENLABS_API_KEY = "test-eleven-key";
  process.env.TYPESAFE_API_KEY = "test-typesafe-key";
  t.after(() => { for (const [key, value] of [["MIMO_API_KEY", previous.mimo], ["ELEVENLABS_API_KEY", previous.eleven], ["TYPESAFE_API_KEY", previous.typesafe]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const result = await start(t, { fetchImpl: mock.fetchImpl });
  const state = (await result.api("/api/state")).value;
  state.config.providers.elevenlabs.activeModels = { eleven_v4: { tts: true }, eleven_flash_v2_5: { tts: true } };
  state.config.assistantDecision = { enabled: true, model: "malicious-other-model" };
  const saved = await result.api("/api/config", state.config, "PUT");
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  assert.equal(saved.value.config.assistantDecision.model, "jev-1.13.0");
  assert.doesNotMatch(JSON.stringify(saved.value.config), /test-typesafe-key/);
  const plan = (await result.api("/api/plans", { name: "Spanish podcast", theme: "Topic", language: "es-419", speakerProfileId: state.profiles.speakerProfiles[0].id, episodeFormatId: state.profiles.episodeProfiles[0].id, planningModel: "mimo-v2.5-pro" })).value.plan;
  return { ...result, state, plan, chat: (text, extra = {}) => result.api("/api/plans/chat", { planId: plan.id, model: "mimo-v2.5-pro", text, ...extra }) };
}

function decisionsMock() {
  const legacy = jevMock();
  const requests = [];
  const choices = { route: "speakerProfile", profileAction: "update", deliveryOnly: 1 };
  let mutate = (answer) => answer;
  return { ...legacy, requests, choices, generations: legacy.generations,
    set generated(value) { legacy.generated = value; }, set mutate(value) { mutate = value; },
    fetchImpl: async (url, options = {}) => {
      if (String(url) === "https://api.openai.com/v1/models") return Response.json({ data: [] });
      if (String(url) !== "https://api.openai.com/v1/decisions") return legacy.fetchImpl(url, options);
      const request = JSON.parse(options.body);
      requests.push(request);
      assert.equal(options.headers.Authorization, "Bearer test-openai-decisions-key");
      assert.equal(options.redirect, "error");
      assert.doesNotMatch(request.input, /test-openai-decisions-key|test-typesafe-key|FULL_KNOWLEDGE/);
      const answers = request.questions.map((question) => {
        const name = question.name;
        if (question.type === "predicate") return { type: "predicate", name, probability: choices[name] ?? 1 };
        if (question.type === "score") {
          const score = choices[name] ?? 1;
          return { type: "score", name, score, confidence: 1, probabilities: question.levels.map((level, value) => ({ value, label: level.label, probability: value === score ? 1 : 0 })) };
        }
        const choice = name.endsWith(".role") ? choices[name] || "guide" : hashId(choices[name] || "keep_current");
        return { type: "choice", name, choice, confidence: 1, probabilities: question.choices.map(({ value }) => ({ value, probability: value === choice ? 1 : 0 })) };
      }).map((answer) => mutate(answer, request));
      return Response.json({ model: DECISIONS_MODEL, answers });
    },
  };
}

async function decisionsSetup(t, mock) {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-decisions-key";
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
  const fixture = await jevSetup(t, mock);
  const config = (await fixture.api("/api/config")).value;
  config.assistantDecision = { ...config.assistantDecision, provider: "openai", model: "unsupported-model" };
  config.providers.openai.baseUrl = "https://proxy.invalid/v1";
  config.providers.openai.enabled = false;
  const result = await fixture.api("/api/config", config, "PUT");
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.config.assistantDecision.model, DECISIONS_MODEL);
  return fixture;
}

test("OpenAI native Hosts suggestion uses the full current draft, no text model, manual Apply, locks, and transcript direction", { concurrency: false }, async (t) => {
  const mock = decisionsMock();
  const { api, state, plan } = await decisionsSetup(t, mock);
  const saved = structuredClone((await api("/api/state")).value.profiles.speakerProfiles[0]);
  const draft = structuredClone(saved);
  draft.instructions = "Profile rules from the draft.";
  draft.speakers[0].backstory = "FULL current backstory: a patient researcher from Lima.";
  draft.speakers[0].personality = "FULL current personality: thoughtful and warm.";
  draft.speakers[0].style = "FULL current style: use clear short sentences.";
  draft.speakers[0].mimoInstructionText = "Private TTS direction from the current draft.";
  draft.speakers[0].elevenlabsStability = 0.66;
  draft.speakers[0].elevenlabsSpeed = 0.92;
  mock.choices["speakers.0.deliveryPreset.energy"] = 0;
  const result = await api("/api/plans/chat", { planId: plan.id, text: "Suggest delivery setup from the current draft.", action: "suggestDeliverySetup", activeContext: { view: "speakers", speakerProfileId: draft.id }, workspaceDraft: draft });
  assert.equal(result.status, 200, JSON.stringify(result.value));
  const message = result.value.message;
  assert.equal(message.decisionReceipt.status, "ready");
  assert.equal(message.decisionReceipt.provider, "openai");
  assert.equal(message.decisionReceipt.model, DECISIONS_MODEL);
  assert.equal(message.decisionReceipt.gate.calibration, "UNCALIBRATED");
  assert.equal(mock.generations.length, 0);
  assert.equal(mock.requests.length, 1, "one typed traits batch for all hosts, no routing or scope call for the explicit action");
  assert.equal(mock.requests.flatMap((request) => request.questions).filter((question) => question.type === "score").length, 10);
  for (const request of mock.requests) {
    const input = JSON.parse(request.input).requestContext;
    assert.equal(input.speakerProfile.speakers[0].backstory, draft.speakers[0].backstory);
    assert.equal(input.speakerProfile.speakers[0].personality, draft.speakers[0].personality);
    assert.equal(input.speakerProfile.speakers[0].style, draft.speakers[0].style);
    assert.equal(input.proposedProse[0].style, draft.speakers[0].style);
    assert.equal(input.proposedProfileInstructions, draft.instructions);
    assert.equal(input.episodeLanguage, "es-419");
    assert.equal(input.message, "Suggest delivery setup from the current draft.");
  }
  const proposed = message.proposal.speakerProfile.value;
  assert.equal(proposed.voiceModel, draft.voiceModel);
  assert.equal(proposed.speakers.length, draft.speakers.length);
  for (const [index, host] of proposed.speakers.entries()) for (const key of ["name", "voiceId", "ttsModelOverride", "accent", "backstory", "personality", "elevenlabsSpeed", "elevenlabsStability"]) assert.equal(host[key], draft.speakers[index][key] ?? (["accent", "ttsModelOverride"].includes(key) ? "" : undefined));
  assert.match(proposed.speakers[0].style, /Delivery setup: guide/);
  assert.equal(message.nextStep, null);
  assert.doesNotMatch(JSON.stringify(message.decisionReceipt), /FULL current|Private TTS direction|Profile rules from the draft|test-openai-decisions-key/);
  assert.deepEqual((await api("/api/state")).value.profiles.speakerProfiles[0], saved);
  let applied = await api("/api/plans/chat/apply", { threadId: result.value.threadId, messageIndex: 1, workspaceDraft: { ...draft, instructions: "Changed later" } });
  assert.equal(applied.status, 409);
  assert.match(applied.value.error, /draft changed/);
  applied = await api("/api/plans/chat/apply", { threadId: result.value.threadId, messageIndex: 1, workspaceDraft: draft });
  assert.equal(applied.status, 200, JSON.stringify(applied.value));
  const persisted = (await api("/api/state")).value.profiles.speakerProfiles.find((profile) => profile.id === applied.value.appliedId);
  assert.equal(persisted.instructions, draft.instructions);
  assert.match(persisted.speakers[0].style, /Delivery setup: guide/);
  const prompt = await api("/api/transcript-prompt/resolve", { speakerProfileId: persisted.id, episodeProfileId: state.profiles.episodeProfiles[0].id });
  assert.equal(prompt.status, 200, JSON.stringify(prompt.value));
  assert.match(JSON.stringify(prompt.value), /Delivery setup: guide/);
});

test("OpenAI trait refusal, malformed score, or uncertainty makes no profile change or partial proposal", { concurrency: false }, async (t) => {
  const mock = decisionsMock();
  const { api, plan } = await decisionsSetup(t, mock);
  const draft = (await api("/api/state")).value.profiles.speakerProfiles[0];
  for (const mutate of [
    (answer) => answer.name.endsWith(".energy") ? { type: "refusal", name: answer.name } : answer,
    (answer) => answer.name.endsWith(".energy") ? { ...answer, score: 2 } : answer,
    (answer) => answer.name.endsWith(".energy") ? { ...answer, confidence: 0.2 } : answer,
  ]) {
    mock.mutate = mutate;
    const result = await api("/api/plans/chat", { planId: plan.id, action: "suggestDeliverySetup", text: "Suggest delivery setup.", activeContext: { view: "speakers", speakerProfileId: draft.id }, workspaceDraft: draft });
    assert.equal(result.status, 200, JSON.stringify(result.value));
    assert.notEqual(result.value.message.decisionReceipt.status, "ready");
    assert.equal(result.value.message.proposal, null);
    assert.equal(result.value.message.nextStep, null);
    assert.ok(result.value.message.questions.length);
    assert.equal(mock.generations.length, 0);
    assert.deepEqual((await api("/api/state")).value.profiles.speakerProfiles[0], draft);
  }
});

test("OpenAI delivery chat locks current persona, model, voice, and count; numeric user tuning needs clarification", { concurrency: false }, async (t) => {
  const mock = decisionsMock();
  const { api, chat } = await decisionsSetup(t, mock);
  const saved = (await api("/api/state")).value.profiles.speakerProfiles[0];
  let result = await chat("Only suggest a delivery setup for the existing hosts.");
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.message.proposal.speakerProfile.mode, "update");
  const proposed = result.value.message.proposal.speakerProfile.value;
  assert.equal(proposed.speakers.length, saved.speakers.length);
  assert.equal(proposed.voiceModel, saved.voiceModel);
  for (const [index, host] of proposed.speakers.entries()) for (const key of ["name", "voiceId", "accent", "ttsModelOverride", "backstory", "personality"]) assert.equal(host[key], saved.speakers[index][key] ?? "");
  const before = mock.generations.length;
  result = await chat("Suggest delivery setup with stability 0.65 and speed 1.1.");
  assert.equal(result.status, 200);
  assert.equal(result.value.message.proposal, null);
  assert.equal(result.value.message.decisionReceipt.status, "needs_clarification");
  assert.equal(mock.generations.length, before);
});

test("OpenAI exact host model, voice, and count pins remain authoritative in a generated profile", { concurrency: false }, async (t) => {
  const mock = decisionsMock();
  Object.assign(mock.choices, { profileAction: "create", deliveryOnly: 0, voiceModel: "eleven_v4", "speakers.0.voiceId": "es-voice", "speakers.1.voiceId": "second-voice" });
  mock.generated = { message: "Two new hosts", proposal: { speakerProfile: { mode: "update", targetId: "wrong", value: { name: "Duo", voiceModel: "mimo-v2.5-tts", speakers: ["Ana", "Luis"].map((name) => ({ name, backstory: `FULL proposed ${name} backstory`, personality: `FULL proposed ${name} personality`, style: `FULL proposed ${name} style`, voiceId: "wrong" })) } } } };
  const { chat } = await decisionsSetup(t, mock);
  const text = "Create 2 hosts Ana and Luis. Use eleven_v4. Ana uses es-voice; Luis uses second-voice.";
  let result = await chat(text);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.message.decisionReceipt.status, "ready");
  const proposed = result.value.message.proposal.speakerProfile;
  assert.equal(proposed.mode, "create");
  assert.equal(proposed.value.voiceModel, "eleven_v4");
  assert.deepEqual(proposed.value.speakers.map((host) => [host.name, host.voiceId]), [["Ana", "es-voice"], ["Luis", "second-voice"]]);
  const inputs = mock.requests.map((request) => JSON.parse(request.input)).filter((input) => input.requestContext?.proposedProse);
  assert.ok(inputs.some((input) => input.requestContext.proposedProse[1].style === "FULL proposed Luis style"));
  mock.choices["speakers.0.voiceId"] = "second-voice";
  result = await chat(text);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.message.proposal, null);
  assert.equal(result.value.message.decisionReceipt.status, "unavailable");
});

test("OpenAI focused profile routing and source guards reject a saved-profile edit before Apply", { concurrency: false }, async (t) => {
  const mock = decisionsMock();
  const { api, plan } = await decisionsSetup(t, mock);
  let profiles = (await api("/api/state")).value.profiles;
  profiles.speakerProfiles.push({ ...structuredClone(profiles.speakerProfiles[0]), id: "focused-hosts", name: "Focused hosts" });
  let saved = await api("/api/profiles", profiles, "PUT");
  assert.equal(saved.status, 200);
  const draft = structuredClone(saved.value.profiles.speakerProfiles[1]);
  draft.speakers[0].style = "Unsaved focused direction";
  const result = await api("/api/plans/chat", { planId: plan.id, action: "suggestDeliverySetup", text: "Suggest delivery setup.", activeContext: { view: "speakers", speakerProfileId: draft.id }, workspaceDraft: draft });
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.message.proposal.speakerProfile.targetId, draft.id);
  assert.equal(result.value.message.decisionReceipt.profileTarget.id, draft.id);
  assert.equal(result.value.message.decisionReceipt.profileTarget.hash, createHash("sha256").update(JSON.stringify(saved.value.profiles.speakerProfiles[1])).digest("hex"));
  profiles = saved.value.profiles;
  profiles.speakerProfiles[1].description = "Edited saved source after suggestion";
  saved = await api("/api/profiles", profiles, "PUT");
  const applied = await api("/api/plans/chat/apply", { threadId: result.value.threadId, messageIndex: 1, workspaceDraft: draft });
  assert.equal(applied.status, 409);
  assert.match(applied.value.error, /selected profile changed/);
  assert.deepEqual((await api("/api/state")).value.profiles, saved.value.profiles);
});

test("OpenAI action routing pins the focused episode and cannot start generation", { concurrency: false }, async (t) => {
  const mock = decisionsMock();
  Object.assign(mock.choices, { route: "nextStep", nextAction: "generateTranscript" });
  const { api, state, plan, chat } = await decisionsSetup(t, mock);
  const saved = await api(`/api/plans/${plan.id}`, { ...plan, audience: "Parents", goal: "Explain" }, "PUT");
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  mock.generated = { episodes: [{ number: 1, title: "Focused" }] };
  const generated = await api(`/api/plans/${plan.id}/generate`, {});
  assert.equal(generated.status, 200, JSON.stringify(generated.value));
  const created = await api(`/api/plans/${plan.id}/create-episodes`, { plannedEpisodeIds: generated.value.plan.episodes.map((row) => row.id) });
  assert.equal(created.status, 200, JSON.stringify(created.value));
  const episode = created.value.episodes[0];
  mock.generated = { message: "Review the next action", questions: [], proposal: null, nextStep: null };
  const result = await chat("Suggest the next script action for this focused episode.", { activeContext: { view: "transcript", episodeId: episode.id } });
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.message.proposal, null);
  assert.equal(result.value.message.nextStep.action, "generateTranscript");
  assert.deepEqual(result.value.message.nextStep.targetIds, [episode.id]);
  assert.equal((await api("/api/jobs")).value.jobs.length, 0);
  assert.ok(mock.requests.some((request) => JSON.parse(request.input).focusedEpisode?.id === episode.id));
  const other = (await api("/api/episodes", { name: "Other", episodeProfileId: episode.episodeProfileId, speakerProfileId: state.profiles.speakerProfiles[0].id })).value;
  const outside = await chat("Change this episode.", { activeContext: { view: "transcript", episodeId: other.id } });
  assert.equal(outside.status, 400);
  assert.match(outside.value.error, /does not belong to this podcast/);
  assert.equal((await api(`/api/plans/${plan.id}`)).value.plan.episodes[0].createdEpisodeId, episode.id);
});

test("decision provider settings retain separate blank keys and reject unsupported providers", { concurrency: false }, async (t) => {
  const mock = decisionsMock();
  const { api } = await decisionsSetup(t, mock);
  const config = (await api("/api/config")).value;
  assert.equal(config.assistantDecision.hasApiKey, true);
  assert.equal(config.assistantDecision.hasOpenAiApiKey, true);
  config.providers.openai.apiKey = "";
  config.assistantDecision.apiKey = "";
  let saved = await api("/api/config", config, "PUT");
  assert.equal(saved.status, 200);
  assert.equal(process.env.OPENAI_API_KEY, "test-openai-decisions-key");
  assert.equal(process.env.TYPESAFE_API_KEY, "test-typesafe-key");
  config.assistantDecision.provider = "typesafe";
  saved = await api("/api/config", config, "PUT");
  assert.equal(saved.value.config.assistantDecision.model, "jev-1.13.0");
  config.assistantDecision.provider = "unknown";
  assert.equal((await api("/api/config", config, "PUT")).status, 400);
  config.assistantDecision.provider = "openai";
  config.assistantDecision.clearApiKey = true;
  saved = await api("/api/config", config, "PUT");
  assert.equal(saved.status, 200);
  assert.equal(process.env.TYPESAFE_API_KEY, undefined);
  assert.equal(process.env.OPENAI_API_KEY, "test-openai-decisions-key");
  assert.doesNotMatch(JSON.stringify(saved.value.config), /test-openai-decisions-key|test-typesafe-key/);
});

test("Jev keeps old two-host profiles unchanged and maps a new solo Charlie to supported Spanish v4 choices", { concurrency: false }, async (t) => {
  const mock = jevMock();
  const { api, rootDir, state, plan, chat } = await jevSetup(t, mock);
  const before = structuredClone(state.profiles.speakerProfiles[0]);
  let result = await chat("Create a new solo host named Charlie. Use eleven_v4 and es-voice.");
  assert.equal(result.status, 200, JSON.stringify(result.value));
  const message = result.value.message;
  assert.equal(message.proposal.speakerProfile.mode, "create");
  assert.equal(message.proposal.speakerProfile.targetId, before.id);
  assert.equal(message.proposal.speakerProfile.value.voiceModel, "eleven_v4");
  assert.equal(message.proposal.speakerProfile.value.speakers.length, 1);
  assert.equal(message.proposal.speakerProfile.value.speakers[0].name, "Charlie");
  assert.equal(message.proposal.speakerProfile.value.speakers[0].voiceId, "es-voice");
  assert.equal(message.proposal.speakerProfile.value.speakers[0].elevenlabsSpeed, before.speakers[0].elevenlabsSpeed ?? 1);
  assert.equal(message.decisionReceipt.status, "ready");
  assert.equal(message.decisionReceipt.profileTarget.role, "source");
  assert.equal(message.decisionReceipt.profileTarget.id, before.id);
  assert.ok(mock.requests.some((request) => request.state.message?.includes("solo host named Charlie")));
  const voiceQuestion = mock.requests.flatMap((request) => Object.entries(request.questions)).find(([id]) => id === "speakers.0.voiceId")[1];
  assert.ok(Object.hasOwn(voiceQuestion.criteria, hashId("es-voice")));
  assert.ok(!Object.hasOwn(voiceQuestion.criteria, hashId("alloy")));
  const modelQuestion = mock.requests.flatMap((request) => Object.entries(request.questions)).find(([id]) => id === "voiceModel")[1];
  assert.ok(!Object.hasOwn(modelQuestion.criteria, hashId("mimo-v2.5-tts")));
  assert.deepEqual((await api("/api/state")).value.profiles.speakerProfiles[0], before, "proposal must not save configuration");
  const thread = (await api(`/api/chat?threadId=${result.value.threadId}`)).value;
  const config = (await api("/api/config")).value;
  config.assistantDecision.enabled = false;
  await api("/api/config", config, "PUT");
  result = await api("/api/plans/chat/apply", { threadId: thread.threadId, messageIndex: 1 });
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.appliedType, "speakerProfile");
  const savedHost = result.value.profiles.speakerProfiles.find((profile) => profile.id === result.value.appliedId);
  assert.equal(savedHost.voiceModel, "eleven_v4");
  assert.equal(savedHost.speakers.length, 1);
  assert.equal(savedHost.speakers[0].voiceId, "es-voice");
  const stored = JSON.parse(await readFile(join(rootDir, "data", "plans", `${plan.id}.json`), "utf8"));
  assert.notEqual(stored.speakerProfileId, before.id);
  assert.deepEqual((await api("/api/state")).value.profiles.speakerProfiles[0], { ...before, revision: 0 });
});

test("Jev stops before generation on uncertainty or service failure; disabled Jev preserves the old assistant", { concurrency: false }, async (t) => {
  const mock = jevMock();
  const { api, chat } = await jevSetup(t, mock);
  mock.lowConfidence = true;
  let result = await chat("Choose a configuration.");
  assert.equal(result.status, 200);
  assert.equal(result.value.message.proposal, null);
  assert.equal(result.value.message.decisionReceipt.status, "needs_clarification");
  assert.equal(mock.generations.length, 0);
  mock.lowConfidence = false;
  mock.unavailable = true;
  result = await chat("Choose a configuration.");
  assert.equal(result.value.message.proposal, null);
  assert.equal(result.value.message.decisionReceipt.status, "unavailable");
  assert.equal(mock.generations.length, 0);
  const config = (await api("/api/config")).value;
  config.assistantDecision.enabled = false;
  await api("/api/config", config, "PUT");
  const decisionsBefore = mock.requests.length;
  result = await chat("Describe Charlie.");
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(mock.generations.length, 1);
  assert.equal(mock.requests.length, decisionsBefore);
  assert.equal(result.value.message.decisionReceipt, undefined);
});

test("Jev rejects a voice from another provider and blocks stale Apply after selected model deactivation", { concurrency: false }, async (t) => {
  const mock = jevMock();
  const { api, chat } = await jevSetup(t, mock);
  mock.choices["speakers.0.voiceId"] = "alloy";
  let result = await chat("Create solo Charlie with eleven_v4.");
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.message.proposal, null);
  assert.equal(result.value.message.decisionReceipt.status, "unavailable");
  mock.choices["speakers.0.voiceId"] = "es-voice";
  result = await chat("Create solo Charlie with eleven_v4 and es-voice.");
  assert.ok(result.value.message.proposal, JSON.stringify(result.value));
  const config = (await api("/api/config")).value;
  config.assistantDecision.enabled = false;
  config.providers.elevenlabs.activeModels = {};
  await api("/api/config", config, "PUT");
  result = await api("/api/plans/chat/apply", { threadId: result.value.threadId, messageIndex: 1 });
  assert.equal(result.status, 409);
  assert.match(result.value.error, /not active|no longer active/);
});

test("Jev resolves all four new hosts without creating old-profile slots", { concurrency: false }, async (t) => {
  const mock = jevMock();
  mock.choices.speakerCount = "4";
  for (let index = 0; index < 4; index += 1) mock.choices[`speakers.${index}.voiceId`] = index % 2 ? "second-voice" : "es-voice";
  mock.generated = { message: "Four hosts", proposal: { speakerProfile: { value: { name: "Panel", speakers: ["Ana", "Beto", "Cora", "Dani"].map((name) => ({ name, backstory: "Host", personality: "Calm", style: "Natural", voiceId: "invented" })) } } } };
  const { api, state, chat } = await jevSetup(t, mock);
  state.profiles.speakerProfiles[0].speakers = [state.profiles.speakerProfiles[0].speakers[0]];
  const saved = await api("/api/profiles", state.profiles, "PUT");
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  const result = await chat("Create a new four-host Spanish panel. Use eleven_v4.");
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.deepEqual(result.value.message.proposal.speakerProfile.value.speakers.map((speaker) => speaker.name), ["Ana", "Beto", "Cora", "Dani"]);
  assert.deepEqual(result.value.message.proposal.speakerProfile.value.speakers.map((speaker) => speaker.voiceId), ["es-voice", "second-voice", "es-voice", "second-voice"]);
  for (let index = 0; index < 4; index += 1) assert.ok(mock.requests.some((request) => request.questions[`speakers.${index}.voiceId`]));
});

test("Jev cannot override exact user IDs and respects negative model phrasing", { concurrency: false }, async (t) => {
  const mock = jevMock();
  const { chat } = await jevSetup(t, mock);
  mock.choices.voiceModel = "eleven_flash_v2_5";
  let result = await chat("Create solo Charlie. Use eleven_v4 with es-voice.");
  assert.equal(result.status, 200);
  assert.equal(result.value.message.proposal, null);
  assert.equal(result.value.message.decisionReceipt.status, "unavailable");
  result = await chat("Create solo Charlie. Do not use eleven_v4. Use eleven_flash_v2_5 with es-voice.");
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.message.proposal.speakerProfile.value.voiceModel, "eleven_flash_v2_5");
  assert.equal(result.value.message.proposal.speakerProfile.value.speakers[0].ttsModelOverride, "", "a default model request must not add an override");
});

test("named Jev presets keep unrelated legacy tuning and new Apply checks fresh voice membership", { concurrency: false }, async (t) => {
  const mock = jevMock();
  mock.choices["speakers.0.deliveryPreset"] = "expressive";
  const { api, state, chat } = await jevSetup(t, mock);
  const result = await chat("Create solo Charlie with eleven_v4 and es-voice. Use expressive delivery.");
  assert.equal(result.status, 200, JSON.stringify(result.value));
  const host = result.value.message.proposal.speakerProfile.value.speakers[0];
  assert.equal(host.elevenlabsStability, 0.3);
  assert.equal(host.elevenlabsSpeed, state.profiles.speakerProfiles[0].speakers[0].elevenlabsSpeed);
  const before = (await api("/api/state")).value.profiles;
  mock.removedVoice = "es-voice";
  const applied = await api("/api/plans/chat/apply", { threadId: result.value.threadId, messageIndex: 1 });
  assert.equal(applied.status, 409);
  assert.match(applied.value.error, /es-voice.*not available.*eleven_v4/);
  assert.deepEqual((await api("/api/state")).value.profiles, before);
});

test("Jev effort sentinels work and unrelated duration and model settings stay unchanged", { concurrency: false }, async (t) => {
  const mock = jevMock();
  Object.assign(mock.choices, { route: "episodeFormat", profileAction: "update", language: "es-419", outlineEffort: "default_effort" });
  mock.generated = { message: "Spanish format", proposal: { episodeFormat: { mode: "create", targetId: "invented", value: { name: "Updated format", language: "en-US", targetMinutes: 59, outlineModel: "invented-model", transcriptModel: "invented-model", outlineEffort: "ultra" } } } };
  const { state, chat } = await jevSetup(t, mock);
  const result = await chat("Use Spanish es-419 and the default outline effort.");
  assert.equal(result.status, 200, JSON.stringify(result.value));
  const format = result.value.message.proposal.episodeFormat;
  assert.equal(format.mode, "update");
  assert.equal(format.value.language, "es-419");
  assert.equal(format.value.outlineEffort, "");
  assert.equal(format.value.targetMinutes, state.profiles.episodeProfiles[0].targetMinutes);
  assert.equal(format.value.outlineModel, state.profiles.episodeProfiles[0].outlineModel);
  assert.equal(format.value.transcriptModel, state.profiles.episodeProfiles[0].transcriptModel);
});

test("Jev episode changes cannot retarget a generated proposal to another podcast", { concurrency: false }, async (t) => {
  const mock = jevMock();
  const { api, state, plan, chat } = await jevSetup(t, mock);
  await api(`/api/plans/${plan.id}`, { ...plan, audience: "Parents", goal: "Explain", episodes: [] }, "PUT");
  mock.generated = { episodes: [{ number: 1, title: "First episode" }] };
  const generated = await api(`/api/plans/${plan.id}/generate`, {});
  assert.equal(generated.status, 200, JSON.stringify(generated.value));
  const created = await api(`/api/plans/${plan.id}/create-episodes`, { plannedEpisodeIds: [generated.value.plan.episodes[0].id] });
  assert.equal(created.status, 200, JSON.stringify(created.value));
  const focused = created.value.episodes[0];
  const foreign = (await api("/api/episodes", { name: "Other podcast", episodeProfileId: state.profiles.episodeProfiles[0].id })).value;
  Object.assign(mock.choices, { route: "episodePatch" });
  mock.generated = { message: "Rename focused episode", proposal: { episodePatch: { episodeId: foreign.id, changes: { name: "Renamed focused episode" } } } };
  const result = await chat("Rename this episode.", { activeContext: { view: "transcript", episodeId: focused.id } });
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.message.proposal.episodePatch.episodeId, focused.id);
  const applied = await api("/api/plans/chat/apply", { threadId: result.value.threadId, messageIndex: 1 });
  assert.equal(applied.status, 200, JSON.stringify(applied.value));
  assert.equal((await api(`/api/episodes/${focused.id}`)).value.name, "Renamed focused episode");
  assert.equal((await api(`/api/episodes/${foreign.id}`)).value.name, "Other podcast");
});

test("Jev Apply bypasses cached Chatterbox voices and rejects a deleted voice", { concurrency: false }, async (t) => {
  const mock = jevMock();
  const originalFetch = mock.fetchImpl;
  let available = true;
  let voiceReads = 0;
  mock.fetchImpl = async (url, options) => {
    if (String(url).startsWith("http://chatterbox.example")) {
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "chatterbox-turbo", capabilities: { tts: true } }] });
      if (String(url).endsWith("/voices")) { voiceReads++; return Response.json({ voices: available ? [{ id: "custom-voice", name: "Custom host" }] : [] }); }
    }
    return originalFetch(url, options);
  };
  const { api, chat } = await jevSetup(t, mock);
  const config = (await api("/api/config")).value;
  config.providers.chatterbox = { enabled: true, baseUrl: "http://chatterbox.example/v1", activeModels: { "chatterbox-turbo": { tts: true } } };
  assert.equal((await api("/api/config", config, "PUT")).status, 200);
  Object.assign(mock.choices, { voiceModel: "compat:chatterbox:chatterbox-turbo", "speakers.0.voiceId": "custom-voice" });
  const result = await chat("Create solo Charlie. Use compat:chatterbox:chatterbox-turbo and custom-voice.");
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.message.proposal.speakerProfile.value.speakers[0].voiceId, "custom-voice");
  const before = (await api("/api/state")).value.profiles;
  const readsBefore = voiceReads;
  available = false;
  const applied = await api("/api/plans/chat/apply", { threadId: result.value.threadId, messageIndex: 1 });
  assert.equal(applied.status, 409);
  assert.match(applied.value.error, /custom-voice.*not available/);
  assert.equal(voiceReads, readsBefore + 1);
  assert.deepEqual((await api("/api/state")).value.profiles, before);
});

test("focused Format edits lock the selected target and reject a stale target revision", { concurrency: false }, async (t) => {
  const mock = jevMock();
  Object.assign(mock.choices, { route: "episodeFormat", profileAction: "update" });
  const { api, state, chat } = await jevSetup(t, mock);
  state.profiles.episodeProfiles.push({ ...state.profiles.episodeProfiles[0], id: "other-format", name: "Other format", targetMinutes: 12 });
  let saved = await api("/api/profiles", state.profiles, "PUT");
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  const defaultFormat = structuredClone(saved.value.profiles.episodeProfiles[0]);
  mock.generated = { message: "Renamed format", proposal: { episodeFormat: { mode: "update", targetId: defaultFormat.id, value: { name: "Renamed focused format", targetMinutes: 59 } } } };
  const context = { activeContext: { view: "format", episodeProfileId: "other-format" } };
  let result = await chat("Rename this format.", context);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.message.proposal.episodeFormat.targetId, "other-format");
  assert.equal(result.value.message.proposal.episodeFormat.value.targetMinutes, 12);
  assert.deepEqual(result.value.message.decisionReceipt.profileTarget, {
    type: "episodeFormat", role: "target", id: "other-format", revision: saved.value.profiles.episodeProfiles[1].revision,
    hash: createHash("sha256").update(JSON.stringify(saved.value.profiles.episodeProfiles[1])).digest("hex"),
  });
  const applied = await api("/api/plans/chat/apply", { threadId: result.value.threadId, messageIndex: 1 });
  assert.equal(applied.status, 200, JSON.stringify(applied.value));
  assert.equal(applied.value.appliedId, "other-format");
  let profiles = (await api("/api/state")).value.profiles;
  assert.deepEqual(profiles.episodeProfiles[0], defaultFormat);
  assert.equal(profiles.episodeProfiles[1].name, "Renamed focused format");
  result = await chat("Rename this format again.", context);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  profiles.episodeProfiles[1].name = "Edited after proposal";
  saved = await api("/api/profiles", profiles, "PUT");
  assert.equal(saved.status, 200);
  const rejected = await api("/api/plans/chat/apply", { threadId: result.value.threadId, messageIndex: 1 });
  assert.equal(rejected.status, 409);
  assert.match(rejected.value.error, /selected profile changed/);
  assert.deepEqual((await api("/api/state")).value.profiles, saved.value.profiles);
  const missing = await chat("Rename this format.", { activeContext: { view: "format", episodeProfileId: "missing-format" } });
  assert.equal(missing.status, 400);
  assert.match(missing.value.error, /selected Episode Format no longer exists/);
});

test("focused Hosts edits use the selected profile and preserve shared-profile copy-on-write", { concurrency: false }, async (t) => {
  const mock = jevMock();
  Object.assign(mock.choices, { profileAction: "update", speakerCount: "2", voiceModel: "keep_current", "speakers.0.voiceId": "keep_current" });
  const { api, state, chat } = await jevSetup(t, mock);
  state.profiles.speakerProfiles.push({ ...state.profiles.speakerProfiles[0], id: "other-hosts", name: "Other hosts" });
  const saved = await api("/api/profiles", state.profiles, "PUT");
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  const defaultHosts = structuredClone(saved.value.profiles.speakerProfiles[0]);
  const otherHosts = structuredClone(saved.value.profiles.speakerProfiles[1]);
  mock.generated = { message: "Renamed hosts", proposal: { speakerProfile: { mode: "update", targetId: defaultHosts.id, value: { name: "Renamed focused hosts", speakers: structuredClone(otherHosts.speakers) } } } };
  const context = { activeContext: { view: "speakers", speakerProfileId: "other-hosts" } };
  let result = await chat("Rename this Hosts profile.", context);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.message.proposal.speakerProfile.targetId, "other-hosts");
  assert.equal(result.value.message.decisionReceipt.profileTarget.id, "other-hosts");
  const applied = await api("/api/plans/chat/apply", { threadId: result.value.threadId, messageIndex: 1 });
  assert.equal(applied.status, 200, JSON.stringify(applied.value));
  assert.equal(applied.value.appliedId, "other-hosts");
  let profiles = (await api("/api/state")).value.profiles;
  assert.deepEqual(profiles.speakerProfiles[0], defaultHosts);
  assert.equal(profiles.speakerProfiles[1].name, "Renamed focused hosts");
  await api("/api/plans", { name: "Another podcast", speakerProfileId: "other-hosts", planningModel: "mimo-v2.5-pro" });
  mock.generated = { message: "Scoped hosts", proposal: { speakerProfile: { value: { name: "Current podcast hosts", speakers: structuredClone(otherHosts.speakers) } } } };
  result = await chat("Rename this Hosts profile for this podcast.", context);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  const shared = await api("/api/plans/chat/apply", { threadId: result.value.threadId, messageIndex: 1 });
  assert.equal(shared.status, 200, JSON.stringify(shared.value));
  assert.notEqual(shared.value.appliedId, "other-hosts");
  profiles = (await api("/api/state")).value.profiles;
  assert.deepEqual(profiles.speakerProfiles[0], defaultHosts);
  assert.equal(profiles.speakerProfiles[1].name, "Renamed focused hosts");
  assert.equal(profiles.speakerProfiles.find((item) => item.id === shared.value.appliedId).name, "Current podcast hosts");
  const missing = await chat("Rename this Hosts profile.", { activeContext: { view: "speakers", speakerProfileId: "missing-hosts" } });
  assert.equal(missing.status, 400);
  assert.match(missing.value.error, /selected Hosts profile no longer exists/);
});

test("exact dotted model IDs cannot be shortened to a prefix or overridden by Jev", { concurrency: false }, async (t) => {
  const mock = jevMock();
  Object.assign(mock.choices, { route: "planPatch", planningModel: "mimo-v2.5" });
  mock.generated = { message: "Use pro", proposal: { planPatch: { planningModel: "mimo-v2.5-pro" } } };
  const { api, chat } = await jevSetup(t, mock);
  const config = (await api("/api/config")).value;
  config.providers.mimo.activeModels["mimo-v2.5"] = { text: true };
  await api("/api/config", config, "PUT");
  let result = await chat("Set planningModel to mimo-v2.5-pro.");
  assert.equal(result.status, 200);
  assert.equal(result.value.message.proposal, null);
  assert.equal(result.value.message.decisionReceipt.status, "unavailable");
  const question = mock.requests.flatMap((request) => Object.entries(request.questions)).find(([id]) => id === "planningModel")[1];
  assert.ok(Object.hasOwn(question.criteria, hashId("mimo-v2.5-pro")));
  assert.ok(!Object.hasOwn(question.criteria, hashId("mimo-v2.5")));
  mock.choices.planningModel = "mimo-v2.5-pro";
  result = await chat("Set planningModel to mimo-v2.5-pro instead of mimo-v2.5.");
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.message.proposal.planPatch.planningModel, "mimo-v2.5-pro");
});

test("a positive model choice stays locked beside a negative voice choice in the same clause", { concurrency: false }, async (t) => {
  const mock = jevMock();
  const { chat } = await jevSetup(t, mock);
  let result = await chat("Create solo Charlie: use eleven_v4 but do not use es-voice.");
  assert.equal(result.status, 200);
  assert.equal(result.value.message.proposal, null);
  const modelQuestion = mock.requests.flatMap((request) => Object.entries(request.questions)).find(([id]) => id === "voiceModel")[1];
  const voiceQuestion = mock.requests.flatMap((request) => Object.entries(request.questions)).find(([id]) => id === "speakers.0.voiceId")[1];
  assert.ok(Object.hasOwn(modelQuestion.criteria, hashId("eleven_v4")));
  assert.ok(!Object.hasOwn(modelQuestion.criteria, hashId("eleven_flash_v2_5")));
  assert.ok(!Object.hasOwn(voiceQuestion.criteria, hashId("es-voice")));
  mock.choices["speakers.0.voiceId"] = "second-voice";
  result = await chat("Create solo Charlie: use eleven_v4 but do not use es-voice.");
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.message.proposal.speakerProfile.value.voiceModel, "eleven_v4");
  assert.equal(result.value.message.proposal.speakerProfile.value.speakers[0].voiceId, "second-voice");
});

test("a Jev planned-row retarget cannot carry the original row's kept format into another row", { concurrency: false }, async (t) => {
  const mock = jevMock();
  const { api, state, plan, chat } = await jevSetup(t, mock);
  state.profiles.episodeProfiles.push({ ...state.profiles.episodeProfiles[0], id: "other-format", name: "Other format" });
  assert.equal((await api("/api/profiles", state.profiles, "PUT")).status, 200);
  await api(`/api/plans/${plan.id}`, { ...plan, audience: "Parents", goal: "Explain", episodes: [] }, "PUT");
  mock.generated = { episodes: [{ number: 1, title: "First row" }, { number: 2, title: "Second row" }] };
  const generated = await api(`/api/plans/${plan.id}/generate`, {});
  assert.equal(generated.status, 200, JSON.stringify(generated.value));
  const current = generated.value.plan;
  current.episodes[0].episodeProfileId = state.profiles.episodeProfiles[0].id;
  current.episodes[1].episodeProfileId = "other-format";
  const saved = await api(`/api/plans/${plan.id}`, current, "PUT");
  assert.equal(saved.status, 200);
  Object.assign(mock.choices, { route: "plannedEpisodePatches", "episode.0.target": current.episodes[1].id });
  mock.generated = { message: "Edit second row", proposal: { plannedEpisodePatches: [{ id: current.episodes[0].id, changes: { title: "Changed row" } }] } };
  const result = await chat("Rename the second planned episode.");
  const generatedContext = JSON.parse(mock.generations.at(-1).messages[1].content.slice("PROJECT CONTEXT:\n".length).split("\n\n")[0]);
  assert.deepEqual(generatedContext.availableOptions.plannedEpisodes, current.episodes.map((item) => ({ id: item.id, title: item.title, episodeProfileId: item.episodeProfileId, createdEpisodeId: item.createdEpisodeId })));
  assert.ok(mock.requests.some((request) => request.state.plannedEpisodes?.some((item) => item.id === current.episodes[1].id)));
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.message.proposal, null);
  assert.equal(result.value.message.decisionReceipt.status, "needs_clarification");
  assert.deepEqual((await api(`/api/plans/${plan.id}`)).value.plan, saved.value.plan);
  const applied = await api("/api/plans/chat/apply", { threadId: result.value.threadId, messageIndex: 1 });
  assert.equal(applied.status, 400);
  assert.deepEqual((await api(`/api/plans/${plan.id}`)).value.plan, saved.value.plan);
});

test("async ChatGPT status renders keep edits, focus, and caret made during the request", async () => {
  const html = await readFile(join(process.cwd(), "public", "index.html"), "utf8");
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  const source = (name) => script.match(new RegExp(`    (?:async )?function ${name}\\([^]*?\\n    }`))[0];
  let field;
  let row;
  let rendered = [];
  let resolveStatus;
  const request = new Promise((resolve) => { resolveStatus = resolve; });
  const configState = { providers: { openai: { enabled: true, apiKey: "before-poll" } }, compatibleConnections: [] };
  const document = {
    activeElement: null,
    querySelector(selector) {
      if (selector === '[data-provider-id="openai"]') return row;
      if (selector === '[data-provider-id="openai"] [data-field="apiKey"]') return field;
      return null;
    }, querySelectorAll: () => [],
  };
  const makeFields = (value) => {
    row = { dataset: { providerId: "openai" }, hasAttribute: () => false, querySelector: (selector) => selector === '[data-field="enabled"]' ? { checked: true } : selector === '[data-field="apiKey"]' ? field : null };
    field = { value, dataset: { field: "apiKey" }, selectionStart: 0, selectionEnd: 0, selectionDirection: "none", closest: () => row, matches: () => false,
      focus: () => { document.activeElement = field; }, setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; } };
  };
  makeFields("before-poll");
  document.activeElement = field;
  const context = {
    document, configState, state: {}, profilesDirty: false, configDirty: true, CSS: { escape: (value) => value },
    chatGptPollTimer: null, chatGptPollCount: 0, chatGptAuthorizeUrl: "", chatGptConnection: {}, modelCatalog: {}, api: () => request, clearTimeout() {},
    renderModelStatus() {}, renderProfileOptions() {}, renderBuildOptions() {}, renderChatControls() {}, renderEpisodeSettingsFields() {}, renderFormatView() {}, renderTtsView() {}, renderJobIndicators() {},
    renderConfigView: () => { rendered.push(configState.providers.openai.apiKey); makeFields(configState.providers.openai.apiKey); },
  };
  runInNewContext(["syncConfigForm", "renderSettingsAfterAsync", "renderModelSelectors", "refreshChatGptStatus"].map(source).join("\n"), context);
  const pending = context.refreshChatGptStatus();
  field.value = "typed-during-status";
  field.selectionStart = 7;
  field.selectionEnd = 11;
  field.selectionDirection = "forward";
  resolveStatus({ accounts: [], pending: null, lastSignIn: { status: "idle" }, modelCatalog: { providers: {} } });
  await pending;
  assert.deepEqual(rendered, ["typed-during-status", "typed-during-status"]);
  assert.equal(configState.providers.openai.apiKey, "typed-during-status");
  assert.equal(document.activeElement, field);
  assert.equal(field.selectionStart, 7);
  assert.equal(field.selectionEnd, 11);
  assert.equal(field.selectionDirection, "forward");
  const uiContext = { activeViewName: () => "speakers", activeTranscriptSection: "script", activeEpisodeProfileId: "format", activeSpeakerProfileId: "selected-hosts", currentEpisode: null };
  const getContext = runInNewContext(`(${source("assistantContext")})`, uiContext);
  assert.equal(getContext().speakerProfileId, "selected-hosts");
});

test("Jev Format creation uses a checked source without treating it as the new destination", { concurrency: false }, async (t) => {
  const mock = jevMock();
  Object.assign(mock.choices, { route: "episodeFormat", profileAction: "create" });
  const { api, state, plan, chat } = await jevSetup(t, mock);
  state.profiles.episodeProfiles.push({ ...state.profiles.episodeProfiles[0], id: "source-format", name: "Source format", targetMinutes: 12 });
  const saved = await api("/api/profiles", state.profiles, "PUT");
  assert.equal(saved.status, 200);
  const before = structuredClone(saved.value.profiles);
  mock.generated = { message: "New format", proposal: { episodeFormat: { value: { name: "New focused format", description: "New format prose" } } } };
  const result = await chat("Create a new format from this format.", { activeContext: { view: "format", episodeProfileId: "source-format" } });
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.message.proposal.episodeFormat.mode, "create");
  assert.equal(result.value.message.proposal.episodeFormat.targetId, "");
  assert.equal(result.value.message.proposal.episodeFormat.value.targetMinutes, 12);
  assert.equal(result.value.message.decisionReceipt.profileTarget.role, "source");
  assert.equal(result.value.message.decisionReceipt.profileTarget.id, "source-format");
  const applied = await api("/api/plans/chat/apply", { threadId: result.value.threadId, messageIndex: 1 });
  assert.equal(applied.status, 200, JSON.stringify(applied.value));
  assert.notEqual(applied.value.appliedId, "source-format");
  assert.notEqual(applied.value.appliedId, plan.episodeFormatId);
  assert.equal(applied.value.plan.episodeFormatId, applied.value.appliedId);
  const profiles = (await api("/api/state")).value.profiles;
  assert.deepEqual(profiles.episodeProfiles.slice(0, 2), before.episodeProfiles);
  const destination = profiles.episodeProfiles.find((item) => item.id === applied.value.appliedId);
  assert.equal(destination.name, "New focused format");
  assert.equal(destination.targetMinutes, 12);
});

for (const change of ["edited", "removed"]) test(`Jev Format creation rejects a source profile that was ${change}`, { concurrency: false }, async (t) => {
  const mock = jevMock();
  Object.assign(mock.choices, { route: "episodeFormat", profileAction: "create" });
  const { api, state, chat } = await jevSetup(t, mock);
  state.profiles.episodeProfiles.push({ ...state.profiles.episodeProfiles[0], id: "source-format", name: "Source format" });
  const saved = await api("/api/profiles", state.profiles, "PUT");
  assert.equal(saved.status, 200);
  mock.generated = { message: "New format", proposal: { episodeFormat: { value: { name: "New format" } } } };
  const result = await chat("Create a new format from this format.", { activeContext: { view: "format", episodeProfileId: "source-format" } });
  assert.equal(result.status, 200, JSON.stringify(result.value));
  const profiles = saved.value.profiles;
  if (change === "edited") profiles.episodeProfiles[1].description = "Source changed after proposal";
  else profiles.episodeProfiles = profiles.episodeProfiles.filter((item) => item.id !== "source-format");
  const changed = await api("/api/profiles", profiles, "PUT");
  assert.equal(changed.status, 200, JSON.stringify(changed.value));
  const applied = await api("/api/plans/chat/apply", { threadId: result.value.threadId, messageIndex: 1 });
  assert.equal(applied.status, 409);
  assert.match(applied.value.error, /selected profile changed|selected profile no longer exists/);
  assert.deepEqual((await api("/api/state")).value.profiles, changed.value.profiles);
});

test("named-host clauses keep each exact voice and reject swapped Jev decisions", { concurrency: false }, async (t) => {
  const mock = jevMock();
  mock.choices.speakerCount = "2";
  const { chat } = await jevSetup(t, mock);
  const text = "Create two hosts, Ana and Beto. Use eleven_v4. Ana should use es-voice and Beto should use second-voice.";
  for (const names of [["Ana", "Beto"], ["Beto", "Ana"]]) {
    mock.generated = { message: "Two hosts", proposal: { speakerProfile: { value: { name: "Hosts", speakers: names.map((name) => ({ name, backstory: "Host", personality: "Calm", style: "Natural", voiceId: name === "Ana" ? "es-voice" : "second-voice" })) } } } };
    for (const [index, name] of names.entries()) mock.choices[`speakers.${index}.voiceId`] = name === "Ana" ? "second-voice" : "es-voice";
    let result = await chat(text);
    assert.equal(result.status, 200, JSON.stringify(result.value));
    assert.equal(result.value.message.proposal, null);
    assert.equal(result.value.message.decisionReceipt.status, "unavailable");
    for (const [index, name] of names.entries()) mock.choices[`speakers.${index}.voiceId`] = name === "Ana" ? "es-voice" : "second-voice";
    result = await chat(text);
    assert.equal(result.status, 200, JSON.stringify(result.value));
    assert.deepEqual(result.value.message.proposal.speakerProfile.value.speakers.map((speaker) => [speaker.name, speaker.voiceId]), names.map((name) => [name, name === "Ana" ? "es-voice" : "second-voice"]));
  }
});

test("named-host model overrides and voice negation stay scoped to their host", { concurrency: false }, async (t) => {
  const mock = jevMock();
  mock.choices.speakerCount = "2";
  Object.assign(mock.choices, { "speakers.0.ttsModelOverride": "eleven_v4", "speakers.1.ttsModelOverride": "eleven_flash_v2_5", "speakers.0.voiceId": "es-voice", "speakers.1.voiceId": "second-voice" });
  mock.generated = { message: "Two hosts", proposal: { speakerProfile: { value: { name: "Hosts", speakers: ["Ana", "Beto"].map((name) => ({ name, backstory: "Host", personality: "Calm", style: "Natural" })) } } } };
  const { chat } = await jevSetup(t, mock);
  const text = "Create two hosts, Ana and Beto. Use eleven_v4. Ana should use eleven_v4 with es-voice and Beto should use eleven_flash_v2_5 with second-voice; Beto should not use es-voice.";
  let result = await chat(text);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.deepEqual(result.value.message.proposal.speakerProfile.value.speakers.map((speaker) => [speaker.ttsModelOverride, speaker.voiceId]), [["eleven_v4", "es-voice"], ["eleven_flash_v2_5", "second-voice"]]);
  mock.choices["speakers.0.ttsModelOverride"] = "eleven_flash_v2_5";
  result = await chat(text);
  assert.equal(result.value.message.proposal, null);
  mock.choices["speakers.0.ttsModelOverride"] = "eleven_v4";
  mock.choices["speakers.1.voiceId"] = "es-voice";
  result = await chat(text);
  assert.equal(result.value.message.proposal, null);
});

test("episode-specific Jev steps stay pinned after the UI selects a different episode", { concurrency: false }, async (t) => {
  const mock = jevMock();
  const { api, rootDir, plan, chat } = await jevSetup(t, mock);
  await api(`/api/plans/${plan.id}`, { ...plan, audience: "Parents", goal: "Explain", episodes: [] }, "PUT");
  mock.generated = { episodes: [{ number: 1, title: "First" }, { number: 2, title: "Second" }] };
  const generated = await api(`/api/plans/${plan.id}/generate`, {});
  assert.equal(generated.status, 200);
  const created = await api(`/api/plans/${plan.id}/create-episodes`, { plannedEpisodeIds: generated.value.plan.episodes.map((item) => item.id) });
  assert.equal(created.status, 200);
  const [first, second] = created.value.episodes;
  const html = await readFile(join(process.cwd(), "public", "index.html"), "utf8");
  const source = html.match(/    async function runAssistantStep\([^]*?\n    }/)[0];
  let calls = [];
  const ui = {
    currentEpisode: { id: second.id }, activePlan: created.value.plan, location: { hash: "" },
    openAssistantTarget: () => true, $: (id) => ({ id }), lockWhile: async (_, action) => action(),
    selectEpisode: async (id) => { calls.push(["load", id]); ui.currentEpisode = { id }; return true; },
    generateTranscript: async () => calls.push(["script", ui.currentEpisode.id]),
    renderAudio: async () => calls.push(["tts", ui.currentEpisode.id]),
    selectPlayerEpisode: (id) => calls.push(["player", id]), generateActivePlan: async () => calls.push(["plan"]),
  };
  const run = runInNewContext(`(${source})`, ui);
  Object.assign(mock.choices, { route: "nextStep" });
  const path = join(rootDir, "data", "episodes", first.id, "episode.json");
  for (const [action, status, audioReady, expected] of [["generateTranscript", "draft", false, "script"], ["generateTts", "transcript_ready", false, "tts"], ["openPlayer", "ready", true, "player"]]) {
    const metadata = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...metadata, status, audioReady }));
    mock.choices.nextAction = action;
    mock.generated = { message: `Run ${action} for First`, nextStep: { target: "transcript", action, targetIds: [second.id], reason: "Incorrect generated target" } };
    const result = await chat(`Run ${action} for First.`, { activeContext: { view: "transcript", episodeId: first.id } });
    assert.equal(result.status, 200, JSON.stringify(result.value));
    assert.deepEqual(result.value.message.nextStep.targetIds, [first.id]);
    ui.currentEpisode = { id: second.id };
    calls = [];
    await run(result.value.message.nextStep);
    assert.deepEqual(calls, [["load", first.id], [expected, first.id]]);
    assert.equal(ui.currentEpisode.id, first.id);
  }
  const generationsBefore = mock.generations.length;
  mock.choices.nextAction = "generateTranscript";
  const missing = await chat("Generate an episode script.");
  assert.equal(missing.status, 200);
  assert.equal(missing.value.message.nextStep, null);
  assert.equal(missing.value.message.decisionReceipt.status, "unavailable");
  assert.equal(mock.generations.length, generationsBefore);
  mock.choices.nextAction = "generatePlan";
  const ordinary = await chat("Generate the plan.");
  assert.equal(ordinary.status, 200, JSON.stringify(ordinary.value));
  assert.deepEqual(ordinary.value.message.nextStep.targetIds, []);
  calls = [];
  await run(ordinary.value.message.nextStep);
  assert.deepEqual(calls, [["plan"]]);
});

test("voice-first for and para clauses bind each voice to its named host in either order", { concurrency: false }, async (t) => {
  const mock = jevMock();
  mock.choices.speakerCount = "2";
  const { chat } = await jevSetup(t, mock);
  for (const names of [["Ana", "Beto"], ["Beto", "Ana"]]) {
    mock.generated = { message: "Two hosts", proposal: { speakerProfile: { value: { name: "Hosts", speakers: names.map((name) => ({ name, backstory: "Host", personality: "Calm", style: "Natural", voiceId: name === "Ana" ? "es-voice" : "second-voice" })) } } } };
    for (const connector of ["for", "para"]) {
      const text = `Create two hosts, Ana and Beto. Use eleven_v4. Use es-voice ${connector} Ana and second-voice ${connector} Beto.`;
      for (const [index, name] of names.entries()) mock.choices[`speakers.${index}.voiceId`] = name === "Ana" ? "second-voice" : "es-voice";
      let result = await chat(text);
      assert.equal(result.status, 200, JSON.stringify(result.value));
      assert.equal(result.value.message.proposal, null);
      assert.equal(result.value.message.decisionReceipt.status, "unavailable");
      for (const [index, name] of names.entries()) mock.choices[`speakers.${index}.voiceId`] = name === "Ana" ? "es-voice" : "second-voice";
      result = await chat(text);
      assert.equal(result.status, 200, JSON.stringify(result.value));
      assert.deepEqual(result.value.message.proposal.speakerProfile.value.speakers.map((speaker) => [speaker.name, speaker.voiceId]), names.map((name) => [name, name === "Ana" ? "es-voice" : "second-voice"]));
    }
  }
});

test("voice-first model overrides honor for and para associations", { concurrency: false }, async (t) => {
  const mock = jevMock();
  mock.choices.speakerCount = "2";
  Object.assign(mock.choices, { "speakers.0.ttsModelOverride": "eleven_v4", "speakers.1.ttsModelOverride": "eleven_flash_v2_5", "speakers.0.voiceId": "es-voice", "speakers.1.voiceId": "second-voice" });
  mock.generated = { message: "Two hosts", proposal: { speakerProfile: { value: { name: "Hosts", speakers: ["Ana", "Beto"].map((name) => ({ name, backstory: "Host", personality: "Calm", style: "Natural" })) } } } };
  const { chat } = await jevSetup(t, mock);
  const text = "Create two hosts, Ana and Beto. Use eleven_v4. Use eleven_v4 for Ana and eleven_flash_v2_5 para Beto. Use es-voice for Ana and second-voice para Beto.";
  let result = await chat(text);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.deepEqual(result.value.message.proposal.speakerProfile.value.speakers.map((speaker) => [speaker.ttsModelOverride, speaker.voiceId]), [["eleven_v4", "es-voice"], ["eleven_flash_v2_5", "second-voice"]]);
  mock.choices["speakers.0.ttsModelOverride"] = "eleven_flash_v2_5";
  result = await chat(text);
  assert.equal(result.value.message.proposal, null);
});

test("unknown, ambiguous, or unassigned voice-first hosts cannot produce a configuration", { concurrency: false }, async (t) => {
  const mock = jevMock();
  mock.choices.speakerCount = "2";
  mock.generated = { message: "Two hosts", proposal: { speakerProfile: { value: { name: "Hosts", speakers: ["Ana", "Beto"].map((name) => ({ name, backstory: "Host", personality: "Calm", style: "Natural" })) } } } };
  const { chat } = await jevSetup(t, mock);
  for (const assignments of ["Use es-voice for Ghost and second-voice for Beto.", "Use es-voice for Ana and Beto.", "Use es-voice and second-voice."]) {
    const result = await chat(`Create two hosts, Ana and Beto. Use eleven_v4. ${assignments}`);
    assert.equal(result.status, 200, JSON.stringify(result.value));
    assert.equal(result.value.message.proposal, null);
    assert.notEqual(result.value.message.decisionReceipt.status, "ready");
  }
});

test("a stale Hosts draft cannot receive a current revision receipt or overwrite newer work", { concurrency: false }, async (t) => {
  const mock = decisionsMock();
  const { api, plan } = await decisionsSetup(t, mock);
  const profiles = (await api("/api/state")).value.profiles;
  const draft = structuredClone(profiles.speakerProfiles[0]);
  profiles.speakerProfiles[0].speakers[0].backstory = "New saved work from another tab.";
  const saved = await api("/api/profiles", profiles, "PUT");
  assert.equal(saved.status, 200);
  const result = await api("/api/plans/chat", { planId: plan.id, action: "suggestDeliverySetup", text: "Suggest delivery setup.", activeContext: { view: "speakers", speakerProfileId: draft.id }, workspaceDraft: draft });
  assert.equal(result.status, 409);
  assert.match(result.value.error, /saved Hosts profile changed.*Reload/);
  assert.equal(mock.requests.length, 0);
  assert.deepEqual((await api("/api/state")).value.profiles, saved.value.profiles);
  assert.deepEqual((await api(`/api/chats?planId=${plan.id}`)).value.chats, []);
});

test("renaming a Format preserves kept inactive models but cannot select a different inactive model", { concurrency: false }, async (t) => {
  const mock = jevMock();
  Object.assign(mock.choices, { route: "episodeFormat", profileAction: "update" });
  const { api, state, plan } = await jevSetup(t, mock);
  const config = (await api("/api/config")).value;
  config.providers.mimo.activeModels["mimo-v2.5-pro"] = { text: false };
  config.providers.mimo.activeModels["mimo-v2.5"] = { text: true };
  assert.equal((await api("/api/config", config, "PUT")).status, 200);
  mock.generated = { message: "Rename only", proposal: { episodeFormat: { value: { name: "Renamed Format" } } } };
  const result = await api("/api/plans/chat", { planId: plan.id, model: "mimo-v2.5", text: "Rename the Format only. Keep all model settings." });
  assert.equal(result.status, 200, JSON.stringify(result.value));
  for (const field of ["outlineModel", "transcriptModel"]) {
    assert.equal(result.value.message.decisionReceipt.selections[field].choice, "keep_current");
    assert.equal(result.value.message.proposal.episodeFormat.value[field], state.profiles.episodeProfiles[0][field]);
  }
  const applied = await api("/api/plans/chat/apply", { threadId: result.value.threadId, messageIndex: 1 });
  assert.equal(applied.status, 200, JSON.stringify(applied.value));
  const saved = (await api("/api/state")).value.profiles.episodeProfiles[0];
  assert.equal(saved.name, "Renamed Format");
  assert.equal(saved.outlineModel, "mimo-v2.5-pro");
  assert.equal(saved.transcriptModel, "mimo-v2.5-pro");
  mock.choices.outlineModel = "missing-inactive-model";
  const rejected = await api("/api/plans/chat", { planId: plan.id, model: "mimo-v2.5", text: "Change the outline model." });
  assert.equal(rejected.value.message.proposal, null);
  assert.equal((await api("/api/state")).value.profiles.episodeProfiles[0].outlineModel, "mimo-v2.5-pro");
});

test("reordered generated hosts keep their own voice, accent, overrides, and delivery tuning", { concurrency: false }, async (t) => {
  const mock = jevMock();
  Object.assign(mock.choices, { profileAction: "update", speakerCount: "2", voiceModel: "keep_current", "speakers.0.voiceId": "keep_current" });
  const { api, state, chat } = await jevSetup(t, mock);
  const hosts = state.profiles.speakerProfiles[0];
  Object.assign(hosts.speakers[0], { accent: "American", mimoTemperature: 0.2, elevenlabsStability: 0.31 });
  Object.assign(hosts.speakers[1], { accent: "British", mimoTemperature: 1.1, elevenlabsStability: 0.72, ttsModelOverride: "mimo-v2.5-tts" });
  const saved = await api("/api/profiles", state.profiles, "PUT");
  assert.equal(saved.status, 200);
  const original = saved.value.profiles.speakerProfiles[0];
  mock.generated = { message: "Reverse only", proposal: { speakerProfile: { value: { speakers: original.speakers.toReversed().map(({ name, backstory, personality, style }) => ({ name, backstory, personality, style })) } } } };
  const result = await chat("Reverse the host order. Keep each host's model, voice, accent, and delivery settings.");
  assert.equal(result.status, 200, JSON.stringify(result.value));
  const proposed = result.value.message.proposal.speakerProfile.value.speakers;
  for (const [index, host] of proposed.entries()) for (const [key, value] of Object.entries(original.speakers.toReversed()[index])) assert.equal(host[key], value, `${host.name}.${key}`);
  const applied = await api("/api/plans/chat/apply", { threadId: result.value.threadId, messageIndex: 1 });
  assert.equal(applied.status, 200, JSON.stringify(applied.value));
  const persisted = (await api("/api/state")).value.profiles.speakerProfiles[0].speakers;
  for (const [index, host] of persisted.entries()) for (const key of ["name", "voiceId", "accent", "mimoTemperature", "elevenlabsStability", "ttsModelOverride"]) assert.equal(host[key], original.speakers.toReversed()[index][key] ?? "");
});

test("Apply locks the thread during fresh voice discovery and releases it after success or failure", { concurrency: false }, async (t) => {
  const mock = jevMock();
  Object.assign(mock.choices, { route: "episodeFormat", profileAction: "update" });
  let release;
  let entered;
  let blocked;
  const originalFetch = mock.fetchImpl;
  mock.fetchImpl = async (url, options) => {
    if (String(url).includes("/v2/voices") && blocked) { entered(); await blocked; }
    return originalFetch(url, options);
  };
  const { api, chat, plan } = await jevSetup(t, mock);
  mock.generated = { message: "Rename", proposal: { episodeFormat: { value: { name: "Locked Format" } } } };
  const proposal = await chat("Rename the Format.");
  assert.equal(proposal.status, 200);
  blocked = new Promise((resolve) => { release = resolve; });
  const discovery = new Promise((resolve) => { entered = resolve; });
  t.after(() => release());
  const applying = api("/api/plans/chat/apply", { threadId: proposal.value.threadId, messageIndex: 1 });
  await discovery;
  const concurrent = await chat("Explain this change.", { threadId: proposal.value.threadId });
  assert.equal(concurrent.status, 409);
  assert.match(concurrent.value.error, /already in progress/);
  release();
  blocked = null;
  const applied = await applying;
  assert.equal(applied.status, 200, JSON.stringify(applied.value));
  const duplicate = await api("/api/plans/chat/apply", { threadId: proposal.value.threadId, messageIndex: 1 });
  assert.equal(duplicate.status, 409);
  mock.choices.route = "question";
  mock.generated = { message: "After Apply", proposal: null };
  const sent = await chat("Explain the Format.", { threadId: proposal.value.threadId });
  assert.equal(sent.status, 200, JSON.stringify(sent.value));
  const thread = (await api(`/api/chat?threadId=${proposal.value.threadId}`)).value;
  assert.equal(thread.lastPlanId, plan.id);
  assert.equal(thread.messages.length, 5);
});

test("legacy OpenAI TTS assistant choices include all nine owned voices for both models", { concurrency: false }, async (t) => {
  process.env.OPENAI_API_KEY = "test-openai-voices-key";
  t.after(() => { delete process.env.OPENAI_API_KEY; });
  const mock = jevMock();
  const originalFetch = mock.fetchImpl;
  mock.fetchImpl = (url, options) => String(url) === "https://api.openai.com/v1/models" ? Promise.resolve(Response.json({ data: [{ id: "tts-1" }, { id: "tts-1-hd" }] })) : originalFetch(url, options);
  Object.assign(mock.choices, { profileAction: "update", speakerCount: "2" });
  const { api, state, chat } = await jevSetup(t, mock);
  state.config.providers.openai.activeModels = { "tts-1": { tts: true }, "tts-1-hd": { tts: true } };
  assert.equal((await api("/api/config", state.config, "PUT")).status, 200);
  mock.generated = { message: "OpenAI voices", proposal: { speakerProfile: { value: { speakers: structuredClone(state.profiles.speakerProfiles[0].speakers) } } } };
  for (const model of ["tts-1", "tts-1-hd"]) for (const voice of ["ash", "coral", "sage"]) {
    Object.assign(mock.choices, { voiceModel: `compat:openai:${model}`, "speakers.0.voiceId": voice, "speakers.1.voiceId": "alloy" });
    const result = await chat("Change to the selected OpenAI speech model and voices.");
    assert.equal(result.status, 200, JSON.stringify(result.value));
    const proposal = result.value.message.proposal.speakerProfile.value;
    assert.equal(proposal.voiceModel, `compat:openai:${model}`);
    assert.equal(proposal.speakers[0].voiceId, voice);
    const question = mock.requests.toReversed().find((request) => request.questions["speakers.0.voiceId"])?.questions["speakers.0.voiceId"];
    for (const id of ["alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer"]) assert.ok(Object.hasOwn(question.criteria, hashId(id)), `${model}: ${id}`);
    for (const id of ["ballad", "verse", "marin", "cedar", "Chloe", "es-voice"]) assert.equal(Object.hasOwn(question.criteria, hashId(id)), false, `${model}: ${id} is not owned`);
  }
});

test("kept inactive Hosts and plan models survive unrelated assistant edits", { concurrency: false }, async (t) => {
  const mock = jevMock();
  Object.assign(mock.choices, { profileAction: "update", speakerCount: "2", voiceModel: "keep_current", "speakers.0.voiceId": "keep_current" });
  const { api, state, plan } = await jevSetup(t, mock);
  const config = (await api("/api/config")).value;
  config.providers.mimo.activeModels["mimo-v2.5-pro"] = { text: false };
  config.providers.mimo.activeModels["mimo-v2.5-tts"] = { tts: false };
  config.providers.mimo.activeModels["mimo-v2.5"] = { text: true };
  assert.equal((await api("/api/config", config, "PUT")).status, 200);
  mock.generated = { message: "Rename Hosts", proposal: { speakerProfile: { value: { name: "Renamed Hosts", speakers: structuredClone(state.profiles.speakerProfiles[0].speakers) } } } };
  let result = await api("/api/plans/chat", { planId: plan.id, model: "mimo-v2.5", text: "Rename Hosts only. Keep all models." });
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.message.proposal.speakerProfile.value.voiceModel, "mimo-v2.5-tts");
  let applied = await api("/api/plans/chat/apply", { threadId: result.value.threadId, messageIndex: 1 });
  assert.equal(applied.status, 200, JSON.stringify(applied.value));
  assert.equal((await api("/api/state")).value.profiles.speakerProfiles[0].voiceModel, "mimo-v2.5-tts");
  mock.choices.route = "planPatch";
  mock.generated = { message: "Rename plan", proposal: { planPatch: { name: "Renamed plan" } } };
  result = await api("/api/plans/chat", { planId: plan.id, model: "mimo-v2.5", text: "Rename the plan only. Keep the planning model." });
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.message.proposal.planPatch.planningModel, "mimo-v2.5-pro");
  applied = await api("/api/plans/chat/apply", { threadId: result.value.threadId, messageIndex: 1 });
  assert.equal(applied.status, 200, JSON.stringify(applied.value));
  assert.equal(applied.value.plan.planningModel, "mimo-v2.5-pro");
  assert.equal(applied.value.plan.name, "Renamed plan");
});

test("case-distinct host names keep exact voice and tuning matches when reordered", { concurrency: false }, async (t) => {
  const mock = jevMock();
  Object.assign(mock.choices, { profileAction: "update", speakerCount: "2", voiceModel: "keep_current", "speakers.0.voiceId": "keep_current" });
  const { api, state, chat } = await jevSetup(t, mock);
  Object.assign(state.profiles.speakerProfiles[0].speakers[0], { name: "Ana", mimoTemperature: 0.2 });
  Object.assign(state.profiles.speakerProfiles[0].speakers[1], { name: "ana", mimoTemperature: 1.1 });
  const saved = await api("/api/profiles", state.profiles, "PUT");
  assert.equal(saved.status, 200);
  const original = saved.value.profiles.speakerProfiles[0];
  mock.generated = { message: "Reorder", proposal: { speakerProfile: { value: { speakers: original.speakers.toReversed().map(({ name, backstory, personality, style }) => ({ name, backstory, personality, style })) } } } };
  const result = await chat("Reverse only. Keep each host's settings.");
  assert.equal(result.status, 200, JSON.stringify(result.value));
  const applied = await api("/api/plans/chat/apply", { threadId: result.value.threadId, messageIndex: 1 });
  assert.equal(applied.status, 200, JSON.stringify(applied.value));
  assert.deepEqual(applied.value.profiles.speakerProfiles[0].speakers.map(({ name, voiceId, mimoTemperature }) => ({ name, voiceId, mimoTemperature })), original.speakers.toReversed().map(({ name, voiceId, mimoTemperature }) => ({ name, voiceId, mimoTemperature })));
});

test("a rename chain cannot reuse one saved host as the source for two proposed hosts", { concurrency: false }, async (t) => {
  const mock = jevMock();
  Object.assign(mock.choices, { profileAction: "update", speakerCount: "2", voiceModel: "keep_current", "speakers.0.voiceId": "keep_current" });
  const { api, state, chat } = await jevSetup(t, mock);
  const original = structuredClone(state.profiles.speakerProfiles[0]);
  mock.generated = { message: "Rename chain", proposal: { speakerProfile: { value: { speakers: original.speakers.map((speaker, index) => ({ ...speaker, name: index === 0 ? "Carmen" : "Valeria" })) } } } };
  const blocked = await chat("Rename Valeria to Carmen and rename Diego to Valeria. Keep each host's settings.");
  assert.equal(blocked.status, 400);
  assert.match(blocked.value.error, /ambiguous source.*Rename one host at a time/);
  assert.deepEqual((await api("/api/state")).value.profiles.speakerProfiles[0], original);
  mock.generated = { message: "One rename", proposal: { speakerProfile: { value: { speakers: original.speakers.map((speaker, index) => ({ ...speaker, name: index === 0 ? "Carmen" : speaker.name })) } } } };
  const result = await chat("Rename Valeria to Carmen only. Keep all host settings.");
  assert.equal(result.status, 200, JSON.stringify(result.value));
  const value = result.value.message.proposal.speakerProfile.value;
  assert.deepEqual(value.speakers.map((speaker) => [speaker.name, speaker.voiceId]), [["Carmen", original.speakers[0].voiceId], [original.speakers[1].name, original.speakers[1].voiceId]]);
  mock.choices.speakerCount = "3";
  mock.generated = { message: "Add host", proposal: { speakerProfile: { value: { speakers: [{ ...original.speakers[0], name: "Charlie" }, ...original.speakers] } } } };
  const added = await chat("Add a new host Charlie first, keep Valeria and Diego.");
  assert.equal(added.status, 200, JSON.stringify(added.value));
  assert.deepEqual(added.value.message.proposal.speakerProfile.value.speakers.map((speaker) => speaker.name), ["Charlie", "Valeria", "Diego"]);
});
