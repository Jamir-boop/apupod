import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { html, script, source } from "./helpers.mjs";

const install = (names, context) => runInNewContext(names.map(source).join("\n"), context);
const handler = (id, event) => script.match(new RegExp(`\\$\\("${id}"\\)\\.addEventListener\\("${event}", guard\\((async \\((?:event)?\\) => \\{[^]*?\\n    })\\)\\);`))[1];
const tick = () => new Promise((resolve) => setImmediate(resolve));
const noop = () => {};
const renders = Object.fromEntries(["renderModelStatus", "renderProfileOptions", "renderChatControls", "renderFormatView", "renderConfigView", "renderTtsView", "renderJobIndicators", "renderPlayer", "renderEpisodeList", "updateWordCount", "renderPodcastAssistant", "updateSaveButtons", "rememberViewSelection", "renderTranscriptPrompt"].map((name) => [name, noop]));

class Control {
  value = "";
  hidden = false;
  _html = "";
  set innerHTML(value) {
    this._html = value;
    const options = [...value.matchAll(/<option value="([^"]*)"([^>]*)>/g)];
    this.value = (options.find((item) => item[2].includes("selected")) || options[0])?.[1] || "";
  }
  get innerHTML() { return this._html; }
}

function episodeContext() {
  const controls = new Map();
  const context = {
    ...renders, uiRequests: { state: 0, episode: 0, prompt: 0, planLoad: 0, chat: 0, chatSelection: 0 }, structuredClone,
    activePlan: null,
    currentEpisode: { id: "a", name: "Episode A", episodeProfileId: "f", speakerProfileId: "s", knowledgeBaseId: "kb", transcript: "Host: saved" },
    state: { profiles: { speakerProfiles: [{ id: "s", name: "Hosts" }], episodeProfiles: [{ id: "f", name: "Format" }] }, knowledgeBases: [{ id: "kb", name: "Source", characters: 10 }], episodes: [], plans: [] },
    configState: {}, configDirty: false, profilesDirty: false, episodeDraftDirty: false, transcriptDirty: false, transcriptPromptDirty: false,
    chatGptPollTimer: null, TRANSCRIPT_DRAFT_PREFIX: "draft.", activeViewName: () => "transcript", validateControls: () => true,
    syncSpeakerForm: noop, syncFormatForm: noop, syncConfigForm: noop, notify: noop,
    effortOptions: () => "", effortLevelsForModel: () => [], resolveTranscriptPrompt: async () => {}, confirm: () => true,
    $: (id) => { if (!controls.has(id)) controls.set(id, new Control()); return controls.get(id); },
    controls,
  };
  install(["option", "escapeHtml", "icon", "notifyError", "saveEditor", "renderBuildOptions", "renderEpisodeSettingsFields", "storeTranscriptDraft", "restoreTranscriptDraft", "captureEpisodeDraft", "restoreEpisodeDraft", "hasUnsavedEpisodeChanges", "selectEpisode", "refreshState", "saveEpisode", "saveTranscript"], context);
  Object.assign(context.state, { episodes: [context.currentEpisode] });
  for (const [id, value] of Object.entries({ episodeName: "Episode A", buildEpisodeProfile: "f", episodeHosts: "s", buildKnowledge: "kb", transcriptText: "Host: saved" })) context.$(id).value = value;
  return context;
}

test("option refresh retains saved and unsaved format, source, and Hosts selections", () => {
  const context = episodeContext();
  context.state.profiles.episodeProfiles.push({ id: "other", name: "Other format" });
  context.state.profiles.speakerProfiles.push({ id: "other-hosts", name: "Other Hosts" });
  context.renderBuildOptions();
  assert.equal(context.$("buildEpisodeProfile").value, "f");
  assert.equal(context.$("buildKnowledge").value, "kb");
  context.$("buildEpisodeProfile").value = "other";
  context.$("buildKnowledge").value = "";
  context.$("episodeHosts").value = "other-hosts";
  context.renderBuildOptions();
  context.renderEpisodeSettingsFields();
  assert.equal(context.$("buildEpisodeProfile").value, "other");
  assert.equal(context.$("buildKnowledge").value, "");
  assert.equal(context.$("episodeHosts").value, "other-hosts");
  context.renderBuildOptions({ episodeProfileId: "missing-format", knowledgeBaseId: "missing-source" });
  assert.equal(context.$("buildEpisodeProfile").value, "missing-format");
  assert.equal(context.$("buildKnowledge").value, "missing-source");
  assert.match(context.$("buildEpisodeProfile").innerHTML, /selected disabled>missing-format · unavailable/);
  assert.equal(context.episodeDraftDirty, false);
});

test("profile save keeps later Hosts and Format edits and the new saved revisions", async () => {
  const context = episodeContext();
  const request = Promise.withResolvers();
  const input = { value: "First host edit" };
  context.state.profiles.speakerProfiles[0].revision = 1;
  context.state.profiles.episodeProfiles[0].revision = 1;
  context.profilesDirty = true;
  context.syncSpeakerForm = () => { context.state.profiles.speakerProfiles[0].name = input.value; };
  let submitted;
  context.api = async (_, options) => { submitted = JSON.parse(options.body); return request.promise; };
  context.renderProfileOptions = () => { input.value = context.state.profiles.speakerProfiles[0].name; };
  install(["saveProfiles"], context);
  const saving = context.saveProfiles();
  await tick();
  input.value = "Later host edit";
  context.state.profiles.episodeProfiles[0].description = "Later format edit";
  // The server consumes expectedUpdatedAt and never stores or returns it.
  const { expectedUpdatedAt, ...saved } = structuredClone(submitted);
  for (const profiles of Object.values(saved)) for (const profile of profiles) profile.revision = 2;
  request.resolve({ profiles: saved });
  await saving;
  assert.equal(input.value, "Later host edit");
  assert.equal(context.state.profiles.episodeProfiles[0].description, "Later format edit");
  assert.equal(context.state.profiles.speakerProfiles[0].revision, 2);
  assert.equal(context.profilesDirty, true);
});

test("config save keeps input typed during discovery and leaves it dirty", async () => {
  const context = episodeContext();
  const request = Promise.withResolvers();
  const input = { value: "https://first.example/v1" };
  context.configState = { providers: { openai: { baseUrl: input.value } } };
  context.configDirty = true;
  context.syncConfigForm = () => { context.configState.providers.openai.baseUrl = input.value; };
  context.elevenVoices = [];
  context.chatterboxVoices = [];
  context.chatterboxVoicesLoaded = false;
  context.voiceRequests = {};
  context.renderModelSelectors = () => { input.value = context.configState.providers.openai.baseUrl; };
  context.renderSettingsAfterAsync = (render) => render();
  let submitted;
  context.api = async (_, options) => { submitted = JSON.parse(options.body); return request.promise; };
  install(["saveConfig"], context);
  const saving = context.saveConfig();
  await tick();
  input.value = "https://later.example/v1";
  request.resolve({ config: submitted, modelCatalog: {} });
  await saving;
  assert.equal(input.value, "https://later.example/v1");
  assert.equal(context.configDirty, true);
  assert.equal(context.state.config.providers.openai.baseUrl, "https://first.example/v1");
});

test("transcript and settings saves keep edits made during the request", async () => {
  for (const kind of ["transcript", "settings"]) {
    const context = episodeContext();
    const request = Promise.withResolvers();
    const field = kind === "transcript" ? "transcriptText" : "episodeName";
    context.$(field).value = "First edit";
    context.transcriptDirty = kind === "transcript";
    context.episodeDraftDirty = kind === "settings";
    context.refreshState = async () => {};
    context.transcriptLengthMessage = () => "";
    context.api = () => request.promise;
    const saving = kind === "transcript" ? context.saveTranscript() : context.saveEpisode();
    await tick();
    context.$(field).value = "Later edit";
    request.resolve({ ...context.currentEpisode, transcript: "First edit", name: "First edit" });
    await saving;
    assert.equal(context.$(field).value, "Later edit");
    assert.equal(kind === "transcript" ? context.transcriptDirty : context.episodeDraftDirty, true);
  }
});

test("refresh captures the live draft after fetch and does not replace newer episode navigation", async () => {
  const context = episodeContext();
  const request = Promise.withResolvers();
  const saved = structuredClone(context.currentEpisode);
  context.episodeDraftDirty = true;
  context.$("episodeName").value = "Before refresh";
  context.api = async (path) => path === "/api/state" ? request.promise : path === "/api/chatgpt/status" ? { accounts: [], pending: null } : saved;
  const refreshing = context.refreshState("a");
  context.$("episodeName").value = "During refresh";
  request.resolve({ ...context.state, config: {} });
  await refreshing;
  assert.equal(context.$("episodeName").value, "During refresh");
  assert.equal(context.episodeDraftDirty, true);
  const later = Promise.withResolvers();
  context.api = async (path) => path === "/api/state" ? later.promise : { accounts: [], pending: null };
  const nextRefresh = context.refreshState("a");
  context.currentEpisode = { id: "b", name: "B" };
  ++context.uiRequests.episode;
  context.$("episodeName").value = "B draft";
  later.resolve({ ...context.state, config: {} });
  await nextRefresh;
  assert.equal(context.currentEpisode.id, "b");
  assert.equal(context.$("episodeName").value, "B draft");
});

test("old selection cannot replace a newer episode or its later transcript edit", async () => {
  const context = episodeContext();
  context.currentEpisode = null;
  const requests = { a: Promise.withResolvers(), b: Promise.withResolvers() };
  context.api = (path) => requests[path.split("/").at(-1)].promise;
  const choosingA = context.selectEpisode("a");
  const choosingB = context.selectEpisode("b");
  requests.b.resolve({ id: "b", name: "B", transcript: "Host: B", episodeProfileId: "f" });
  await choosingB;
  context.$("transcriptText").value = "Host: B draft";
  context.transcriptDirty = true;
  requests.a.resolve({ id: "a", name: "A", episodeProfileId: "f" });
  assert.equal(await choosingA, false);
  assert.equal(context.currentEpisode.id, "b");
  assert.equal(context.$("transcriptText").value, "Host: B draft");
  assert.equal(context.transcriptDirty, true);
});

test("an episode response from an old state refresh cannot replace the current draft", async () => {
  const context = episodeContext();
  const request = Promise.withResolvers();
  context.api = () => request.promise;
  const selecting = context.selectEpisode("a", null, context.uiRequests.state);
  ++context.uiRequests.state;
  context.$("transcriptText").value = "Host: current draft";
  context.transcriptDirty = true;
  request.resolve({ id: "a", transcript: "Host: old server value" });
  assert.equal(await selecting, false);
  assert.equal(context.$("transcriptText").value, "Host: current draft");
});

test("editing the current episode during a different episode load stops the selection", async () => {
  const context = episodeContext();
  const request = Promise.withResolvers();
  context.api = () => request.promise;
  const selecting = context.selectEpisode("b");
  context.$("episodeName").value = "New A draft";
  context.episodeDraftDirty = true;
  request.resolve({ id: "b", name: "B" });
  assert.equal(await selecting, false);
  assert.equal(context.currentEpisode.id, "a");
  assert.equal(context.$("episodeName").value, "New A draft");
});

test("queued episode saves keep their original target and payload after navigation", async () => {
  const context = episodeContext();
  const first = Promise.withResolvers();
  const submitted = [];
  context.api = async (_, options) => { const body = JSON.parse(options.body); submitted.push(body); return submitted.length === 1 ? first.promise : body; };
  context.refreshState = async () => {};
  const savingFirst = context.saveEpisode();
  await tick();
  context.$("episodeName").value = "Second A save";
  const savingSecond = context.saveEpisode();
  context.currentEpisode = { id: "b", name: "B" };
  ++context.uiRequests.episode;
  context.$("episodeName").value = "B draft";
  first.resolve({ id: "a", name: "First A save" });
  await Promise.all([savingFirst, savingSecond]);
  assert.deepEqual(submitted.map((item) => item.id), ["a", "a"]);
  assert.equal(submitted[1].name, "Second A save");
  assert.equal(context.currentEpisode.id, "b");
  assert.equal(context.$("episodeName").value, "B draft");
});

test("Generate pins the saved episode and auto-TTS choice before waiting", async () => {
  const context = episodeContext();
  const request = Promise.withResolvers();
  context.$("autoGenerateTts").checked = true;
  context.saveEpisode = () => request.promise;
  context.trackJob = noop;
  let submitted;
  context.api = async (path, options) => { submitted = [path, JSON.parse(options.body)]; return { job: {} }; };
  install(["generateTranscript"], context);
  const generating = context.generateTranscript();
  context.currentEpisode = { id: "b" };
  context.$("autoGenerateTts").checked = false;
  request.resolve({ id: "a" });
  await generating;
  assert.equal(submitted[0], "/api/episodes/a/generate");
  assert.equal(submitted[1].autoTts, true);
});

test("Script effort survives hidden Format sync, including a different active Format", async () => {
  for (const sameFormat of [true, false]) {
    const context = episodeContext();
    context.formatFormId = sameFormat ? "f" : "other";
    context.state.profiles.episodeProfiles.push({ id: "other", name: "Other" });
    context.$("fmtTranscriptEffort").value = "medium";
    context.$("transcriptEffort").value = "high";
    context.syncFormatForm = () => { context.state.profiles.episodeProfiles.find((item) => item.id === context.formatFormId).transcriptEffort = context.$("fmtTranscriptEffort").value; };
    let submitted;
    context.api = async (_, options) => { submitted = JSON.parse(options.body); return { profiles: submitted }; };
    install(["saveProfiles"], context);
    await runInNewContext(`(${handler("transcriptEffort", "change")})()`, context);
    assert.equal(submitted.episodeProfiles.find((item) => item.id === "f").transcriptEffort, "high");
    if (!sameFormat) assert.equal(submitted.episodeProfiles.find((item) => item.id === "other").transcriptEffort, "medium");
  }
});

test("Hosts navigation synchronizes the current profile before loading podcast Hosts", () => {
  const context = episodeContext();
  context.activePlan = { speakerProfileId: "s" };
  context.activeSpeakerProfileId = "other";
  context.location = { hash: "" };
  const calls = [];
  context.syncSpeakerForm = () => calls.push(["sync", context.activeSpeakerProfileId]);
  context.loadSpeakerForm = (id) => { calls.push(["load", id]); context.activeSpeakerProfileId = id; };
  install(["openAssistantTarget"], context);
  context.openAssistantTarget("speakers");
  assert.deepEqual(calls, [["sync", "other"], ["load", "s"]]);
});

test("deleting Hosts without pre-delete revision evidence keeps draft revisions unchanged", async () => {
  const context = episodeContext();
  context.activeSpeakerProfileId = "s";
  context.activePlanId = "";
  context.state.profiles.speakerProfiles.push({ id: "other", name: "Other Hosts", revision: 1 });
  context.state.profiles.episodeProfiles[0] = { id: "f", name: "Format", description: "Unsaved format", speakerProfileId: "s", revision: 1 };
  context.profilesDirty = true;
  const saved = { speakerProfiles: [{ id: "other", name: "Other Hosts", revision: 1 }], episodeProfiles: [{ id: "f", name: "Format", description: "Saved format", speakerProfileId: "other", revision: 2 }] };
  context.api = async () => ({ fallbackId: "other", profiles: saved });
  context.refreshState = async () => { if (!context.profilesDirty) context.state.profiles = saved; };
  context.refreshPlanIndex = async () => {};
  await runInNewContext(`(${handler("deleteSpeakerProfile", "click")})()`, context);
  assert.equal(context.profilesDirty, true);
  assert.equal(context.state.profiles.speakerProfiles.some((item) => item.id === "s"), false);
  assert.equal(context.state.profiles.episodeProfiles[0].description, "Unsaved format");
  assert.equal(context.state.profiles.episodeProfiles[0].speakerProfileId, "other");
  assert.equal(context.state.profiles.episodeProfiles[0].revision, 1);
});

test("old voice success and error do not alter new provider requests or catalogs", async () => {
  for (const provider of ["elevenlabs", "chatterbox"]) for (const outcome of ["resolve", "reject"]) {
    const old = Promise.withResolvers(), next = Promise.withResolvers();
    const context = episodeContext();
    context.voiceRequests = {};
    context.voiceProvider = () => provider;
    context.activeSpeakerProfileId = "";
    context.elevenVoices = [];
    context.chatterboxVoices = [];
    context.chatterboxVoicesLoaded = false;
    const errors = [];
    context.notify = (message) => errors.push(message);
    let calls = 0;
    context.api = () => ++calls === 1 ? old.promise : next.promise;
    install(["ensureProviderVoices"], context);
    context.ensureProviderVoices("model");
    const oldRequest = context.voiceRequests[provider];
    delete context.voiceRequests[provider];
    context.ensureProviderVoices("model");
    const nextRequest = context.voiceRequests[provider];
    old[outcome](outcome === "resolve" ? { voices: [{ id: "old" }] } : new Error("Old server error"));
    await oldRequest;
    assert.equal(context.voiceRequests[provider], nextRequest);
    assert.equal(errors.length, 0);
    next.resolve({ voices: [{ id: "new" }] });
    await nextRequest;
    assert.equal((provider === "elevenlabs" ? context.elevenVoices : context.chatterboxVoices)[0].id, "new");
  }
});

test("plan save sends the loaded version, retains later edits, and preserves a conflict draft", async () => {
  const context = episodeContext();
  context.activePlan = { id: "p", name: "Plan", updatedAt: "v1", planningModel: "model", planningEffort: "medium" };
  context.$("plannerChatModel").value = "model";
  context.$("plannerChatEffort").value = "medium";
  context.refreshPlanIndex = async () => {};
  context.loadPlanForm = (plan) => { context.activePlan = plan; };
  const request = Promise.withResolvers();
  let submitted;
  context.api = async (_, options) => { submitted = JSON.parse(options.body); return request.promise; };
  install(["capturePlanDraft", "saveActivePlan"], context);
  const saving = context.saveActivePlan();
  await tick();
  assert.equal(submitted.expectedUpdatedAt, "v1");
  context.$("plannerChatEffort").value = "high";
  request.resolve({ plan: { ...context.activePlan, updatedAt: "v2" } });
  await saving;
  assert.equal(context.activePlan.planningEffort, "high");
  assert.equal(context.activePlan.updatedAt, "v2");
  context.api = async (_, options) => { assert.equal(JSON.parse(options.body).expectedUpdatedAt, "v2"); throw new Error("Content plan changed in another tab. Reload the plan before saving your changes."); };
  await assert.rejects(context.saveActivePlan(), /changed in another tab/);
  assert.equal(context.activePlan.planningEffort, "high");
  assert.equal(context.activePlan.updatedAt, "v2");
});

test("playlist mutations from two stale tabs preserve additions and do not restore deletions", async () => {
  let stored = "[]";
  const storage = { getItem: () => stored, setItem: (_, value) => { stored = value; } };
  let previous = Promise.resolve();
  const locks = { request: (_, action) => { const next = previous.then(action); previous = next.catch(noop); return next; } };
  const tab = (id) => {
    const context = { PLAYER_PLAYLISTS_KEY: "playlists", localStorage: storage, navigator: { locks }, crypto: { randomUUID: () => id }, playerPlaylists: [], activePlayerPlaylistId: "", currentPlayerOrder: () => [id], prompt: () => id, confirm: () => true, renderPlayer: noop, notify: noop };
    install(["loadPlayerPlaylists", "savePlayerPlaylists", "requestedPlaylistName", "saveNewPlayerPlaylist", "updatePlayerPlaylist", "renamePlayerPlaylist", "deletePlayerPlaylist"], context);
    return context;
  };
  const a = tab("A"), b = tab("B");
  await Promise.all([a.saveNewPlayerPlaylist(), b.saveNewPlayerPlaylist()]);
  assert.deepEqual(JSON.parse(stored).map((item) => item.id), ["A", "B"]);
  a.activePlayerPlaylistId = "A";
  b.activePlayerPlaylistId = "A";
  await a.deletePlayerPlaylist();
  await assert.rejects(b.updatePlayerPlaylist(), /deleted in another tab/);
  assert.deepEqual(JSON.parse(stored).map((item) => item.id), ["B"]);
  b.activePlayerPlaylistId = "B";
  b.prompt = () => "Renamed B";
  await b.renamePlayerPlaylist();
  assert.equal(JSON.parse(stored)[0].name, "Renamed B");
  const unsupported = tab("C");
  unsupported.navigator = {};
  await assert.rejects(unsupported.saveNewPlayerPlaylist(), /Web Locks support/);
  assert.deepEqual(JSON.parse(stored).map((item) => item.id), ["B"]);
  assert.match(script, /window\.addEventListener\("storage", \(event\) => \{/);
});

test("API errors retain the backend recovery message and safe parameter name", async () => {
  const context = { fetch: async () => ({ ok: false, headers: { get: () => "application/json" }, json: async () => ({ error: "ChatGPT plan rejected parameter reasoning.effort. Select a supported effort before trying again.", param: "reasoning.effort", bodyShape: { reasoning: { effort: "string" } } }) }) };
  install(["api"], context);
  await assert.rejects(context.api("/api/plans/chat"), /reasoning\.effort.*Select a supported effort/);
});

test("deleting another Hosts profile cannot give a stale profile the server's newer revision", async () => {
  const context = episodeContext();
  context.activeSpeakerProfileId = "s";
  context.activePlanId = "";
  context.activePlan = null;
  context.state.profiles.speakerProfiles.push({ id: "keep", name: "Old saved name", revision: 1 });
  const saved = { speakerProfiles: [{ id: "keep", name: "Other-tab saved name", revision: 2 }], episodeProfiles: structuredClone(context.state.profiles.episodeProfiles) };
  context.refreshState = async () => {};
  context.refreshPlanIndex = async () => {};
  context.api = async (path, options) => {
    if (path.startsWith("/api/speaker-profiles/")) return { fallbackId: "keep", profiles: saved, beforeRevisions: { speakerProfiles: { keep: 2 }, episodeProfiles: {} } };
    const submitted = JSON.parse(options.body);
    if (submitted.speakerProfiles[0].revision !== saved.speakerProfiles[0].revision) throw new Error("Host profile changed. Reload before saving.");
    throw new Error("Stale profile reached the write");
  };
  install(["saveProfiles"], context);
  await runInNewContext(`(${handler("deleteSpeakerProfile", "click")})()`, context);
  assert.equal(context.state.profiles.speakerProfiles[0].revision, 1);
  await assert.rejects(context.saveProfiles(), /changed. Reload/);
  assert.equal(saved.speakerProfiles[0].name, "Other-tab saved name");
});

test("same-tab Hosts deletion advances a current Format draft base and lets it save", async () => {
  const context = episodeContext();
  context.activeSpeakerProfileId = "s";
  context.activePlanId = "";
  context.state.profiles.speakerProfiles.push({ id: "keep", name: "Keep", revision: 1 });
  context.state.profiles.episodeProfiles[0] = { id: "f", name: "Format", description: "Unsaved Format edit", speakerProfileId: "s", revision: 1 };
  context.profilesDirty = true;
  const saved = { speakerProfiles: [{ id: "keep", name: "Keep", revision: 1 }], episodeProfiles: [{ id: "f", name: "Format", description: "Saved Format", speakerProfileId: "keep", revision: 2 }] };
  context.refreshState = async () => {};
  context.refreshPlanIndex = async () => {};
  let submitted;
  context.api = async (path, options) => {
    if (path.startsWith("/api/speaker-profiles/")) return { fallbackId: "keep", profiles: saved, beforeRevisions: { speakerProfiles: { keep: 1 }, episodeProfiles: { f: 1 } } };
    submitted = JSON.parse(options.body);
    delete submitted.expectedUpdatedAt;
    assert.equal(submitted.episodeProfiles[0].revision, 2);
    return { profiles: submitted };
  };
  install(["saveProfiles"], context);
  await runInNewContext(`(${handler("deleteSpeakerProfile", "click")})()`, context);
  assert.equal(context.state.profiles.episodeProfiles[0].description, "Unsaved Format edit");
  assert.equal(context.state.profiles.episodeProfiles[0].speakerProfileId, "keep");
  assert.equal(context.state.profiles.episodeProfiles[0].revision, 2);
  await context.saveProfiles();
  assert.equal(submitted.episodeProfiles[0].description, "Unsaved Format edit");
  assert.equal(context.profilesDirty, false);
});

test("a state snapshot from before a successful Hosts save cannot restore the old revision", async () => {
  const context = episodeContext();
  context.currentEpisode = null;
  context.state.profiles.speakerProfiles[0] = { id: "s", name: "Old name", revision: 1 };
  const oldState = structuredClone({ ...context.state, config: {} });
  const status = Promise.withResolvers();
  const input = { value: "Old name" };
  context.syncSpeakerForm = () => { context.state.profiles.speakerProfiles[0].name = input.value; };
  context.renderProfileOptions = () => { input.value = context.state.profiles.speakerProfiles[0].name; };
  context.api = async (path, options) => {
    if (path === "/api/state") return oldState;
    if (path === "/api/chatgpt/status") return status.promise;
    const { expectedUpdatedAt, ...profiles } = JSON.parse(options.body);
    profiles.speakerProfiles[0].revision = 2;
    return { profiles };
  };
  install(["saveProfiles"], context);
  const refreshing = context.refreshState();
  input.value = "New saved name";
  context.profilesDirty = true;
  await context.saveProfiles();
  status.resolve({ accounts: [], pending: null });
  await refreshing;
  assert.equal(input.value, "New saved name");
  assert.equal(context.state.profiles.speakerProfiles[0].revision, 2);
  assert.equal(context.profilesDirty, false);
});

function chatContext() {
  const context = episodeContext();
  Object.assign(context, {
    activePlanId: "p", activePlan: { id: "p" }, plannerChatThreadId: "a", plannerChatThread: null, plannerChatThreads: [],
    setChatHistoryOpen: noop, renderPlannerChatHistory: noop, renderPlannerChatMessages: noop,
    document: { querySelectorAll: () => [] }, refreshPlanIndex: async () => {}, refreshState: async () => {},
  });
  install(["loadPlannerChatThread", "applyAssistantProposal"], context);
  return context;
}

const proposalThread = (id, name = id) => ({ threadId: id, messages: [{ role: "assistant", content: JSON.stringify({ proposal: { planPatch: { name } } }) }] });

test("chat loads guard the selected thread at both history and message response boundaries", async () => {
  const context = chatContext();
  const a = Promise.withResolvers(), b = Promise.withResolvers();
  context.api = async (path) => path.startsWith("/api/chats?") ? { chats: [{ threadId: "a" }, { threadId: "b" }] } : path.endsWith("=a") ? a.promise : b.promise;
  const loadingA = context.loadPlannerChatThread();
  await tick();
  context.plannerChatThreadId = "b";
  const loadingB = context.loadPlannerChatThread();
  await tick();
  b.resolve(proposalThread("b"));
  await loadingB;
  a.resolve(proposalThread("a"));
  await loadingA;
  assert.equal(context.plannerChatThreadId, "b");
  assert.equal(context.plannerChatThread.threadId, "b");
  const history = Promise.withResolvers();
  context.api = () => history.promise;
  const oldPlanLoad = context.loadPlannerChatThread();
  context.activePlanId = "q";
  context.activePlan = { id: "q" };
  history.resolve({ chats: [{ threadId: "old-plan-thread" }] });
  await oldPlanLoad;
  assert.equal(context.plannerChatThreadId, "b");
  assert.equal(context.plannerChatThreads.some((item) => item.threadId === "old-plan-thread"), false);
});

test("Apply rejects a mismatched rendered thread, changed message, or navigation during pre-save", async () => {
  const context = chatContext();
  context.plannerChatThread = proposalThread("a");
  context.plannerChatThreadId = "b";
  let calls = 0;
  context.api = async () => { calls++; };
  await assert.rejects(context.applyAssistantProposal(0, false), /proposal changed/);
  context.plannerChatThreadId = "a";
  const oldContent = context.plannerChatThread.messages[0].content;
  context.plannerChatThread = proposalThread("a", "New proposal");
  await assert.rejects(context.applyAssistantProposal(0, false, "a", oldContent), /proposal changed/);
  const preSave = Promise.withResolvers();
  context.profilesDirty = true;
  context.plannerChatThread.messages[0].content = JSON.stringify({ proposal: { speakerProfile: { value: { name: "Hosts" } } } });
  context.saveProfiles = () => preSave.promise;
  const applying = context.applyAssistantProposal(0, false);
  context.plannerChatThreadId = "b";
  context.plannerChatThread = proposalThread("b");
  preSave.resolve({});
  await assert.rejects(applying, /proposal changed/);
  assert.equal(calls, 0);
  assert.match(source("renderPlannerChatMessages"), /data-chat-thread=/);
  assert.match(source("renderPlannerChatMessages"), /data-message-content=/);
});

test("a reply to an old chat cannot change the current selected thread", async () => {
  const context = chatContext();
  const reply = Promise.withResolvers();
  context.plannerChatBusy = false;
  context.$("plannerChatInput").value = "Composed request";
  context.$("plannerChatModel").value = "model";
  context.capturePlanDraft = () => ({});
  context.assistantContext = () => ({});
  context.assistantWorkspaceDraft = () => null;
  let loads = 0;
  context.loadPlannerChatThread = async () => { loads++; };
  context.api = () => reply.promise;
  install(["sendPlannerChat"], context);
  const sending = context.sendPlannerChat();
  context.plannerChatThreadId = "b";
  context.plannerChatThread = proposalThread("b");
  reply.resolve({ threadId: "a" });
  await sending;
  assert.equal(context.plannerChatThreadId, "b");
  assert.equal(context.plannerChatThread.threadId, "b");
  assert.equal(context.$("plannerChatInput").value, "Composed request");
  assert.equal(loads, 0);
});

test("new-chat replies survive a history refresh but not explicit chat or plan selection", async () => {
  for (const change of ["refresh", "new", "thread", "plan"]) {
    const context = chatContext();
    const reply = Promise.withResolvers();
    context.plannerChatThreadId = "";
    context.plannerChatBusy = false;
    context.$("plannerChatInput").value = "New chat request";
    context.$("plannerChatModel").value = "model";
    context.capturePlanDraft = () => ({});
    context.assistantContext = () => ({});
    context.assistantWorkspaceDraft = () => null;
    let replied = false;
    context.api = async (path) => {
      if (path === "/api/plans/chat") return reply.promise;
      if (path === "/api/plans/q") return { plan: { id: "q" } };
      if (path.startsWith("/api/chats?")) return { chats: replied ? [{ threadId: "new-thread" }, { threadId: "b" }] : change === "thread" ? [{ threadId: "b" }] : [] };
      return proposalThread(path.endsWith("=b") ? "b" : "new-thread");
    };
    install(["sendPlannerChat", "loadPlan", "loadPlanForm"], context);
    const sending = context.sendPlannerChat();
    if (change === "refresh") await context.loadPlannerChatThread();
    if (change === "new") {
      const reset = script.match(/\$\("chatHistoryNew"\)\.addEventListener\("click", (\(\) => \{[^]*?\n    })\);/)[1];
      runInNewContext(`(${reset})()`, context);
    }
    if (change === "thread") {
      context.event = { target: { closest: (selector) => selector === "[data-chat-open]" ? { dataset: { chatOpen: "b" } } : null } };
      await runInNewContext(`(${handler("chatHistoryList", "click")})(event)`, context);
    }
    if (change === "plan") await context.loadPlan("q");
    replied = true;
    reply.resolve({ threadId: "new-thread" });
    await sending;
    if (change === "refresh") {
      assert.equal(context.plannerChatThreadId, "new-thread");
      assert.equal(context.plannerChatThread.threadId, "new-thread");
      assert.equal(context.$("plannerChatInput").value, "");
    } else {
      assert.notEqual(context.plannerChatThreadId, "new-thread");
      assert.equal(context.$("plannerChatInput").value, "New chat request");
    }
  }
});

test("KB deletion refreshes only its plan version and retains later local plan edits", async () => {
  const context = episodeContext();
  context.activePlanId = "p";
  context.activePlan = { id: "p", name: "Plan", knowledgeBaseId: "kb", planningModel: "model", planningEffort: "medium", updatedAt: "v1" };
  context.plannerChatThread = null;
  context.$("plannerChatModel").value = "model";
  context.$("plannerChatEffort").value = "medium";
  const savedPlan = { ...context.activePlan, knowledgeBaseId: "", updatedAt: "v2" };
  const getPlan = Promise.withResolvers();
  let submitted;
  context.api = async (path, options) => {
    if (path === "/api/knowledge/kb") return { cleared: { plans: 1, episodes: 0, chats: 0 } };
    if (!options) return getPlan.promise;
    submitted = JSON.parse(options.body);
    if (submitted.expectedUpdatedAt !== "v2") throw new Error("Content plan changed");
    return { plan: { ...submitted, updatedAt: "v3" } };
  };
  context.refreshState = async () => {};
  context.refreshPlanIndex = async () => {};
  context.loadPlanForm = (plan) => { context.activePlan = plan; };
  install(["deleteKnowledgeBase", "refreshPlanVersionAfterRepoint", "capturePlanDraft", "saveActivePlan"], context);
  const deleting = context.deleteKnowledgeBase("kb");
  await tick();
  context.activePlan.name = "Later local name";
  context.$("plannerChatEffort").value = "high";
  getPlan.resolve({ plan: savedPlan });
  await deleting;
  assert.equal(context.activePlan.updatedAt, "v2");
  assert.equal(context.activePlan.name, "Later local name");
  assert.equal(context.$("plannerChatEffort").value, "high");
  await context.saveActivePlan();
  assert.equal(submitted.expectedUpdatedAt, "v2");
  assert.equal(submitted.name, "Later local name");
  assert.equal(submitted.planningEffort, "high");
  context.activePlan = { ...savedPlan, updatedAt: "v1" };
  context.api = async () => ({ plan: { ...savedPlan, name: "Other-tab change" } });
  await context.refreshPlanVersionAfterRepoint({ ...savedPlan, updatedAt: "v1" }, { knowledgeBaseId: "" });
  assert.equal(context.activePlan.updatedAt, "v1", "a different remote plan change must still produce a save conflict");
});

test("a late transcript import cannot replace another episode or a later local edit", async () => {
  for (const change of ["episode", "text"]) {
    const context = episodeContext();
    const request = Promise.withResolvers();
    context.event = { target: { files: [{ name: "A.txt", text: () => request.promise }], value: "A.txt" } };
    const importing = runInNewContext(`(${handler("transcriptFile", "change")})(event)`, context);
    if (change === "episode") { context.currentEpisode = { id: "b" }; ++context.uiRequests.episode; }
    context.$("transcriptText").value = "Host: later draft";
    context.transcriptDirty = true;
    request.resolve("Host: imported A text");
    await importing;
    assert.equal(context.$("transcriptText").value, "Host: later draft");
    assert.equal(context.transcriptDirty, true);
    assert.equal(context.event.target.value, "");
  }
});

test("Undo key clear synchronizes Config edits before its rerender", () => {
  const context = episodeContext();
  const input = { value: "Later endpoint edit" };
  context.configState = { providers: { openai: { baseUrl: "Saved endpoint", clearApiKey: true } } };
  context.syncConfigForm = () => { context.configState.providers.openai.baseUrl = input.value; };
  context.renderConfigView = () => { input.value = context.configState.providers.openai.baseUrl; };
  context.event = { target: { closest: (selector) => selector === "button[data-undo-clear-key]" ? { dataset: { undoClearKey: "provider:openai" } } : null } };
  install(["configKeyTarget"], context);
  const click = script.match(/\$\("configProviders"\)\.addEventListener\("click", (\(event\) => \{[^]*?\n    })\);/)[1];
  runInNewContext(`(${click})(event)`, context);
  assert.equal(input.value, "Later endpoint edit");
  assert.equal(context.configState.providers.openai.clearApiKey, false);
  assert.equal(context.configDirty, true);
});

test("chat refresh keeps unsent effort, including default, and an explicit plan load resets it", () => {
  const context = episodeContext();
  context.activePlanId = "p";
  context.activePlan = { id: "p", planningModel: "model", planningEffort: "medium" };
  context.state.plans = [{ id: "p" }];
  context.plannerChatThread = { lastModel: "older-model" };
  context.renderPlannerChatHistory = noop;
  context.updateChatPills = noop;
  context.textModelOptions = (value) => `<option value="${value}" selected>${value}</option>`;
  context.effortLevelsForModel = () => ["medium", "high"];
  install(["effortOptions", "renderChatControls", "loadPlanForm"], context);
  context.$("plannerChatModel").value = "model";
  context.$("plannerChatEffort").value = "high";
  context.renderChatControls();
  assert.equal(context.$("plannerChatModel").value, "model");
  assert.equal(context.$("plannerChatEffort").value, "high");
  context.$("plannerChatEffort").value = "";
  context.renderChatControls();
  assert.equal(context.$("plannerChatEffort").value, "");
  context.loadPlanForm({ id: "p", planningModel: "model", planningEffort: "medium" });
  assert.equal(context.$("plannerChatEffort").value, "medium");
});

test("Apply keeps an updatedAt that a same-tab save adopted during the request, and a plan-only Apply leaves it alone", async () => {
  const context = chatContext();
  install(["saveProfiles"], context);
  context.plannerChatThread = proposalThread("a");
  context.state.profiles.updatedAt = "v1";
  let server = "v1";
  let apply;
  context.api = async (path, options) => {
    if (path === "/api/plans/chat/apply") return (apply = Promise.withResolvers()).promise;
    if (path === "/api/profiles") {
      const { expectedUpdatedAt, ...profiles } = JSON.parse(options.body);
      assert.equal(expectedUpdatedAt, server);
      server = `${server}+`;
      return { previousProfilesUpdatedAt: expectedUpdatedAt, profiles: { ...profiles, updatedAt: server } };
    }
    return path.startsWith("/api/chats?") ? { chats: [{ threadId: "a" }] } : proposalThread("a");
  };
  const applyWith = async (profiles) => {
    const applying = context.applyAssistantProposal(0, false);
    await tick();
    context.profilesDirty = true;
    await context.saveProfiles();
    const previousProfilesUpdatedAt = server;
    if (profiles) server = `${server}+`;
    apply.resolve({ previousProfilesUpdatedAt, profiles: profiles && { ...structuredClone(context.state.profiles), updatedAt: server }, appliedType: "planPatch", plan: null, warnings: [] });
    await applying;
  };
  await applyWith(true);
  assert.equal(context.state.profiles.updatedAt, "v1++");
  await applyWith(false);
  assert.equal(context.state.profiles.updatedAt, "v1+++");
  context.profilesDirty = true;
  await context.saveProfiles();
  assert.equal(context.state.profiles.updatedAt, "v1++++");
});

const statusHelper = script.match(/    const setStatus = [^\n]*/)[0];

function listStub() {
  const list = { writes: 0, inserted: [], _html: "", contains: () => false, querySelectorAll: () => [], querySelector: () => null,
    insertAdjacentHTML(position, value) { this.inserted.push([position, value]); this._html = position === "beforeend" ? this._html + value : value + this._html; } };
  Object.defineProperty(list, "innerHTML", { get() { return this._html; }, set(value) { this.writes++; this._html = value; } });
  return list;
}

test("the job poll does not rebuild an unchanged episode list or Activity panel and keeps job focus", () => {
  const list = listStub();
  const activity = listStub();
  const episode = { id: "e1", name: "One", transcriptWords: 0, episodeProfileId: "f" };
  const context = { state: { episodes: [episode], profiles: { episodeProfiles: [{ id: "f" }], speakerProfiles: [{ id: "s", name: "Hosts" }] } }, activePlan: null,
    jobsState: { jobs: [{ id: "j1", episodeId: "e1", type: "transcript", status: "running", message: "1%" }] }, startingEpisodeIds: new Set(), lastEpisodeListHtml: "", lastServerActivityHtml: "",
    document: { activeElement: null, querySelectorAll: () => [] }, CSS: { escape: (value) => value }, $: (id) => id === "serverActivity" ? activity : list };
  install(["option", "escapeHtml", "icon", "planEpisodeRows", "episodeRowHtml", "renderEpisodeList", "activeJobs", "renderServerActivity"], context);
  context.renderEpisodeList();
  context.jobsState.jobs[0].message = "2%";
  context.renderEpisodeList();
  assert.equal(list.writes, 1, "progress-only polls must not replace the rows");
  context.jobsState.jobs[0].type = "tts";
  context.renderEpisodeList();
  assert.equal(list.writes, 2);
  let focused = "";
  context.document.activeElement = { closest: () => ({ dataset: { jobId: "j1" } }) };
  activity.contains = () => true;
  activity.querySelector = (selector) => ({ focus: () => { focused = selector; } });
  context.renderServerActivity();
  assert.equal(focused, '.job-item[data-job-id="j1"] summary');
  focused = "";
  context.renderServerActivity();
  assert.equal(activity.writes, 1, "an identical poll must keep the focused node");
  assert.equal(focused, "");
  context.jobsState.jobs[0].message = "3%";
  context.renderServerActivity();
  assert.equal(activity.writes, 2);
  assert.equal(focused, '.job-item[data-job-id="j1"] summary');
  // Opening a job only changes the DOM, so the next poll keeps the nodes, and a real change reopens it.
  const item = { open: true, dataset: { jobId: "j1" } };
  context.document.querySelectorAll = () => [item];
  context.renderServerActivity();
  assert.equal(activity.writes, 2, "opening a job disclosure must not rebuild the Activity panel");
  assert.doesNotMatch(activity.innerHTML, / open/);
  const rebuilt = { open: false, dataset: { jobId: "j1" } };
  activity.querySelectorAll = () => [rebuilt];
  context.jobsState.jobs[0].message = "4%";
  context.renderServerActivity();
  assert.equal(activity.writes, 3);
  assert.equal(rebuilt.open, true);
});

test("a failed job poll shows its error until a later poll succeeds with the same jobs", async () => {
  const activity = listStub();
  const retry = { hidden: true };
  const jobs = { jobs: [{ id: "j1", episodeId: "e1", type: "transcript", status: "running", message: "1%" }] };
  let fail = false;
  const context = { jobsState: { jobs: [] }, lastServerActivityHtml: "", jobsInitialized: false, notifiedJobIds: new Set(), jobPollTimer: null, currentEpisode: null,
    clearTimeout: noop, setTimeout: noop, renderJobIndicators: noop, notifyJobResult: noop, notify: noop, CSS: { escape: (value) => value },
    document: { activeElement: null, querySelectorAll: () => [] }, api: async () => { if (fail) throw new Error("down"); return structuredClone(jobs); },
    $: (id) => id === "retryJobs" ? retry : activity };
  install(["escapeHtml", "icon", "activeJobs", "renderServerActivity", "refreshJobs"], context);
  await context.refreshJobs();
  const ok = activity.innerHTML;
  fail = true;
  await assert.rejects(context.refreshJobs(), /down/);
  assert.match(activity.innerHTML, /Could not load jobs/);
  assert.equal(retry.hidden, false);
  fail = false;
  await context.refreshJobs();
  assert.equal(activity.innerHTML, ok);
  assert.equal(retry.hidden, true);
});

test("a real episode list change keeps open row menus and refocuses the same row control", () => {
  const list = listStub();
  const episode = { id: "e1", name: "One", transcriptWords: 0, episodeProfileId: "f" };
  const opened = [];
  let focused = "";
  const control = { matches: () => false, attributes: [{ name: "data-start-episode" }, { name: "class" }], closest: () => ({ dataset: { episodeRow: "e1" } }) };
  const menu = { closest: () => ({ dataset: { episodeRow: "e1" } }) };
  const context = { state: { episodes: [episode], profiles: { episodeProfiles: [{ id: "f" }], speakerProfiles: [] } }, activePlan: null,
    jobsState: { jobs: [] }, startingEpisodeIds: new Set(), lastEpisodeListHtml: "stale", document: { activeElement: control }, CSS: { escape: (value) => value }, $: () => list };
  list.contains = (node) => node === control;
  list.querySelectorAll = (selector) => selector === "details.episode-more[open]" ? [menu] : [];
  list.querySelector = (selector) => {
    if (selector.endsWith("details.episode-more")) return { setAttribute: (name) => opened.push([selector, name]) };
    return { disabled: false, focus: () => { focused = selector; } };
  };
  install(["option", "escapeHtml", "icon", "planEpisodeRows", "episodeRowHtml", "renderEpisodeList"], context);
  context.renderEpisodeList();
  assert.equal(list.writes, 1);
  assert.deepEqual(opened, [['[data-episode-row="e1"] details.episode-more', "open"]]);
  assert.equal(focused, '[data-episode-row="e1"] [data-start-episode]');
});

test("Start stays disabled while its POST runs, across list re-renders, and re-enables after", async () => {
  for (const outcome of ["resolve", "reject"]) {
    const request = Promise.withResolvers();
    const rendered = [];
    let calls = 0;
    const episode = { id: "e1", transcriptWords: 0, episodeProfileId: "f" };
    const context = { state: { profiles: { episodeProfiles: [], speakerProfiles: [] } }, jobsState: { jobs: [] }, startingEpisodeIds: new Set(),
      api: () => { calls++; return request.promise; }, trackJob: noop, notify: noop };
    context.renderEpisodeList = () => rendered.push(context.episodeRowHtml(episode, "One"));
    install(["option", "escapeHtml", "icon", "episodeRowHtml", "startEpisode"], context);
    const starting = context.startEpisode("e1");
    // Not awaited: without the re-entry guard this second call would wait on the same pending request.
    const second = context.startEpisode("e1");
    assert.equal(calls, 1);
    context.renderEpisodeList();
    assert.match(rendered.at(-1), /data-start-episode="e1" disabled>/);
    if (outcome === "resolve") request.resolve({ job: {} }); else request.reject(new Error("Server error"));
    await (outcome === "resolve" ? starting : assert.rejects(starting, /Server error/));
    await second;
    assert.equal(context.startingEpisodeIds.size, 0);
    assert.match(rendered.at(-1), /data-start-episode="e1">/);
  }
});

test("status regions are written only when their text changes", () => {
  const writes = {};
  class Counted extends Control {
    constructor(id) { super(); this.id = id; this._text = ""; this.childNodes = []; this.parentElement = { dataset: {} }; }
    get textContent() { return this._text; }
    set textContent(value) { writes[this.id] = (writes[this.id] || 0) + 1; this._text = value; }
  }
  const controls = new Map();
  const job = { id: "j", episodeId: "a", type: "tts", status: "running", message: "Rendering 1/3", total: 3, completed: 1 };
  const context = { jobsState: { jobs: [job] }, currentEpisode: { id: "a", transcript: "Host: hi" }, configDirty: false, profilesDirty: false, episodeDraftDirty: false, transcriptDirty: false, transcriptPromptDirty: false,
    Node: { TEXT_NODE: 3 }, episodeProfilesAreCurrent: () => true, ttsCompatibilityErrors: () => [], renderEpisodeList: noop, renderTranscriptPrompt: noop,
    $: (id) => { if (!controls.has(id)) controls.set(id, new Counted(id)); return controls.get(id); } };
  runInNewContext([statusHelper, ...["currentJob", "episodeIsBusy", "updateSaveButtons", "renderJobIndicators"].map(source)].join("\n"), context);
  context.renderJobIndicators();
  context.renderJobIndicators();
  assert.deepEqual([writes.renderStatus, writes.workspaceStatusValue, writes.transcriptSaveStatus, writes.transcriptJobStatus], [1, 1, 1, undefined]);
  assert.equal(context.$("workspaceStatusValue").textContent, "1 active");
  assert.equal(context.$("workspaceStatusValue").parentElement.dataset.state, "active");
  job.status = "completed";
  context.renderJobIndicators();
  assert.equal(context.$("workspaceStatusValue").textContent, "Ready");
});

test("a hand-edited transcript draft is restored only over its own saved base and cleared after save", async () => {
  const stored = new Map();
  const storage = { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) };
  const context = episodeContext();
  const notices = [];
  Object.assign(context, { localStorage: storage, notify: (message, type) => notices.push(type) });
  context.$("transcriptText").value = "Host: unsaved edit";
  context.transcriptDirty = true;
  context.storeTranscriptDraft();
  assert.deepEqual(JSON.parse(stored.get("draft.a")), { base: "Host: saved", text: "Host: unsaved edit" });
  context.$("transcriptText").value = "Host: saved";
  context.transcriptDirty = false;
  context.restoreTranscriptDraft();
  assert.equal(context.$("transcriptText").value, "Host: unsaved edit");
  assert.equal(context.transcriptDirty, true);
  assert.deepEqual(notices, ["warning"]);
  const asked = [];
  context.confirm = (question) => { asked.push(question); return false; };
  for (const [base, text] of [["Host: regenerated", "Host: unsaved edit"], ["Host: saved", "Host: saved"]]) {
    stored.set("draft.a", JSON.stringify({ base, text }));
    context.$("transcriptText").value = "Host: saved";
    context.transcriptDirty = false;
    context.restoreTranscriptDraft();
    assert.equal(context.$("transcriptText").value, "Host: saved");
    assert.equal(context.transcriptDirty, false);
    assert.equal(stored.has("draft.a"), false, "a draft that is not restored must not stay in storage");
  }
  assert.equal(asked.length, 1, "only a draft of an older transcript asks before it replaces the current one");
  assert.match(asked[0], /older version/);
  assert.equal(notices.length, 1);
  context.confirm = () => true;
  stored.set("draft.a", JSON.stringify({ base: "Host: older", text: "Host: unsaved edit" }));
  context.restoreTranscriptDraft();
  assert.equal(context.$("transcriptText").value, "Host: unsaved edit");
  assert.equal(context.transcriptDirty, true);
  assert.deepEqual(JSON.parse(stored.get("draft.a")), { base: "Host: saved", text: "Host: unsaved edit" }, "an accepted old draft is kept against the current base");
  assert.equal(notices.length, 2);
  stored.set("draft.a", JSON.stringify({ base: "Host: saved", text: "Host: unsaved edit" }));
  context.$("transcriptText").value = "Host: unsaved edit";
  context.transcriptDirty = true;
  context.refreshState = async () => {};
  context.transcriptLengthMessage = () => "";
  context.api = async () => ({ ...context.currentEpisode, transcript: "Host: unsaved edit" });
  await context.saveTranscript();
  assert.equal(stored.has("draft.a"), false);
  Object.defineProperty(context, "localStorage", { get() { throw new Error("blocked"); } });
  context.transcriptDirty = true;
  context.storeTranscriptDraft();
  context.restoreTranscriptDraft();
});

test("selecting an episode restores its draft, and a confirmed discard removes it", async () => {
  assert.match(script, /\$\("transcriptText"\)\.addEventListener\("input", \(\) => \{ transcriptDirty = true; storeTranscriptDraft\(\);/);
  const stored = new Map();
  const context = episodeContext();
  const episodes = { a: { ...context.currentEpisode }, b: { ...context.currentEpisode, id: "b", name: "Episode B", transcript: "Host: b" } };
  const notices = [];
  Object.assign(context, { localStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) },
    notify: (message, type) => notices.push(type), api: async (path) => structuredClone(episodes[path.split("/").pop()]) });
  context.state.episodes = Object.values(episodes);
  stored.set("draft.a", JSON.stringify({ base: "Host: saved", text: "Host: unsaved edit" }));
  assert.equal(await context.selectEpisode("a"), true);
  assert.equal(context.$("transcriptText").value, "Host: unsaved edit");
  assert.equal(context.transcriptDirty, true);
  assert.deepEqual(notices, ["warning"]);
  context.confirm = () => false;
  assert.equal(await context.selectEpisode("b"), false);
  assert.equal(stored.has("draft.a"), true, "a cancelled discard keeps the draft");
  context.confirm = () => true;
  assert.equal(await context.selectEpisode("b"), true);
  assert.equal(stored.has("draft.a"), false);
  assert.equal(await context.selectEpisode("a"), true);
  assert.equal(context.$("transcriptText").value, "Host: saved");
  assert.equal(context.transcriptDirty, false);
  assert.deepEqual(notices, ["warning"]);
});

test("a new chat keeps the model and effort selected for its first message", async () => {
  const context = episodeContext();
  let created;
  context.state.plans = [];
  context.state.knowledgeBases = [];
  Object.assign(context, { activePlanId: "", activePlan: null, plannerChatThread: null, renderPlannerChatHistory: noop, updateChatPills: noop, loadPlan: async () => {}, queueMicrotask,
    textModelOptions: (value) => `<option value="${value}" selected>${value}</option>`, effortLevelsForModel: () => ["medium", "high"],
    api: async (path, options) => {
      if (options?.method === "POST") { created = JSON.parse(options.body); return { plan: { id: "p", episodes: [], planningModel: created.planningModel || "default-model", planningEffort: created.planningEffort || "" } }; }
      return { plans: [{ id: "p" }] };
    } });
  install(["effortOptions", "renderChatControls", "loadPlanForm", "capturePlanDraft", "refreshPlanIndex", "createNewPlan"], context);
  context.$("plannerChatModel").value = "chosen-model";
  context.$("plannerChatEffort").value = "high";
  await context.createNewPlan();
  assert.deepEqual(created, { planningModel: "chosen-model", planningEffort: "high" });
  assert.equal(context.$("plannerChatEffort").value, "high");
  assert.equal(context.capturePlanDraft().planningEffort, "high");
  assert.equal(context.capturePlanDraft().planningModel, "chosen-model");

  // The reply gives the new chat its first thread id; the controls must keep the chosen effort, not the plan's saved one.
  for (const effort of ["high", "medium"]) {
    Object.assign(context, { activePlan: { id: "p", episodes: [], planningModel: "chosen-model", planningEffort: "" }, plannerChatThread: null, plannerChatThreadId: "", plannerChatBusy: false, plannerChatThreads: [], setChatHistoryOpen: noop, renderPlannerChatMessages: noop,
      assistantContext: () => ({}), assistantWorkspaceDraft: () => ({}) });
    context.$("plannerChatEffort").value = effort;
    context.$("plannerChatInput").value = "Make a show";
    let sent;
    context.api = async (path, options) => {
      if (path === "/api/plans/chat") { sent = JSON.parse(options.body); return { threadId: "t" }; }
      if (path.startsWith("/api/chats")) return { chats: [{ threadId: "t" }] };
      return { threadId: "t", lastModel: "chosen-model", messages: [{ role: "user", content: "Make a show" }] };
    };
    install(["loadPlannerChatThread", "sendPlannerChat"], context);
    await context.sendPlannerChat();
    assert.equal(sent.planDraft.planningEffort, effort);
    assert.equal(context.plannerChatThread.threadId, "t");
    assert.equal(context.$("plannerChatEffort").value, effort);
  }
});

test("the chat log appends new messages with author labels instead of rebuilding the thread", () => {
  const log = listStub();
  const thread = { threadId: "t", messages: [{ role: "user", content: "Hello" }, { role: "assistant", content: "not json" }] };
  const context = { plannerChatThread: thread, renderedChat: { threadId: "", items: [] }, $: () => log };
  install(["escapeHtml", "icon", "renderPlannerChatMessages"], context);
  context.renderPlannerChatMessages();
  thread.messages.push({ role: "user", content: "More" });
  context.renderPlannerChatMessages();
  context.renderPlannerChatMessages();
  assert.equal(log.writes, 1);
  assert.deepEqual(log.inserted.map(([position]) => position), ["beforeend", "beforeend"]);
  assert.match(log.inserted[0][1], /sr-only">You: <\/span>More/);
  assert.match(log.innerHTML, /sr-only">You: <\/span>Hello/);
  assert.match(log.innerHTML, /sr-only">Assistant: <\/span>not json/);
  context.plannerChatThread = { threadId: "other", messages: [{ role: "user", content: "Other" }] };
  context.renderPlannerChatMessages();
  assert.equal(log.writes, 2);
  Object.assign(context, { plannerChatThread: null, activePlan: null, planEpisodeRows: () => [] });
  context.renderPlannerChatMessages();
  context.renderPlannerChatMessages();
  assert.equal(log.writes, 3, "the same empty-chat prompt must not be written again");
  assert.match(log.innerHTML, /Describe the podcast you want/);
});

test("notifications and toasts add and remove single nodes in their live regions", () => {
  const region = () => {
    const node = { children: [], writes: 0,
      get lastElementChild() { return this.children.at(-1); },
      set textContent(value) { this.writes++; this.children = []; },
      insertAdjacentHTML(position, html) {
        const child = { html, dataset: { toastId: html.match(/data-toast-id="([^"]*)"/)?.[1] }, remove: () => { node.children = node.children.filter((item) => item !== child); } };
        if (position === "afterbegin") this.children.unshift(child); else this.children.push(child);
      },
      querySelector: (selector) => selector === ".notice-item" ? node.children.find((item) => item.html.includes("notice-item")) || null : null,
      querySelectorAll: () => node.children.filter((item) => item.dataset.toastId) };
    return node;
  };
  const nodes = { notificationFeed: region(), toasts: region(), rightbarBadge: new Control() };
  let id = 0;
  const context = { notifications: [], toastEntries: [], toastOverflow: 0, rightbarOpen: false, crypto: { randomUUID: () => `n${++id}` }, setTimeout: noop,
    TOAST_ICONS: {}, TOAST_LABELS: {}, $: (name) => nodes[name] };
  install(["escapeHtml", "icon", "notify", "renderNotificationBadge", "showToast", "removeToastNode", "dismissToast", "renderToastOverflow"], context);
  context.notify("first", "ok");
  const [firstNotice] = nodes.notificationFeed.children;
  const [firstToast] = nodes.toasts.children;
  context.notify("second", "warning");
  assert.equal(nodes.notificationFeed.writes, 1, "only the empty-feed placeholder is cleared");
  assert.equal(nodes.notificationFeed.children.length, 2);
  assert.equal(nodes.notificationFeed.children[1], firstNotice);
  assert.match(nodes.notificationFeed.children[0].html, /second/);
  assert.deepEqual(nodes.toasts.children.map((item) => item.dataset.toastId), ["n1", "n2"]);
  context.dismissToast("n1");
  assert.equal(nodes.toasts.writes, 0);
  assert.deepEqual(nodes.toasts.children.map((item) => item.dataset.toastId), ["n2"]);
  assert.notEqual(nodes.toasts.children[0], firstToast);
});

test("episode chips, removal confirms, and the shared accent list", () => {
  const context = { state: { profiles: { episodeProfiles: [], speakerProfiles: [] } }, jobsState: { jobs: [] }, startingEpisodeIds: new Set() };
  install(["option", "escapeHtml", "icon", "episodeRowHtml"], context);
  assert.match(context.episodeRowHtml({ id: "e", transcriptWords: 0 }, "E"), /Script<svg[^]*?<\/svg><span class="sr-only"> not ready<\/span>/);
  assert.match(context.episodeRowHtml({ id: "e", transcriptWords: 9, audioReady: true }, "E"), /Script<svg[^]*?<\/svg><span class="sr-only"> ready<\/span>[^]*Audio<svg[^]*?<\/svg><span class="sr-only"> ready<\/span>/);

  const profile = { id: "s", speakers: [{ name: "Ana" }, { name: "Ben" }] };
  const speakers = { activeSpeakerProfileId: "s", activeSpeakerIndex: 0, state: { profiles: { speakerProfiles: [profile] } }, syncSpeakerForm: noop, confirm: () => false };
  install(["removeSpeaker"], speakers);
  speakers.removeSpeaker(0);
  assert.equal(profile.speakers.length, 2);
  assert.match(script, /\$\("clearPlayerQueue"\)\.addEventListener\("click", \(\) => \{\n\s+if \(!confirm\(/);
  assert.match(script, /if \(!confirm\(`Remove "\$\{connection\?\.name[^\n]*\n\s+configState\.compatibleConnections = configState\.compatibleConnections\.filter/);

  let accentCalls = 0;
  const cards = { $: (id) => (cards[id] ||= new Control()), activeSpeakerIndex: 0, accentOptions: () => { accentCalls++; return '<option value="x"></option>'; },
    modelLabel: (id) => id, voiceSelector: () => "", providerTtsFields: () => "", modelOptions: () => "", ensureProviderVoices: noop, document: { querySelectorAll: () => [] } };
  install(["escapeHtml", "icon", "renderSpeakerCards"], cards);
  cards.renderSpeakerCards({ voiceModel: "m", speakers: [{ name: "A" }, { name: "B" }, { name: "C" }] });
  assert.equal(accentCalls, 1);
  assert.equal(cards.$("speakerCards").innerHTML.split('<datalist id="accent-list">').length - 1, 1);
  assert.equal(cards.$("speakerCards").innerHTML.split('list="accent-list"').length - 1, 3);
  assert.match(cards.$("speakerSidebar").innerHTML, /data-speaker-nav="0" class="active" aria-current="true"/);
});

test("page markup and CSS keep the accessibility and layout fixes", () => {
  assert.match(html, /<dialog id="modelDialog"[^>]*aria-labelledby="modelDialogTitle"/);
  assert.match(html, /<textarea id="transcriptText"[^>]*aria-describedby="transcriptLengthWarning"/);
  assert.match(html, /<select id="savedEpisodeSelect" aria-describedby="savedEpisodeHint">/);
  assert.match(html, /id="savedEpisodeHint"/);
  assert.doesNotMatch(script, /label\.title = label\.dataset\.help/);
  assert.match(html, /<div id="speakerSidebar"[^>]*role="group"/);
  assert.doesNotMatch(html, /role="navigation"/);
  assert.doesNotMatch(html, /id="chatHistoryPanel"[^>]*aria-modal/);
  assert.match(source("setChatHistoryOpen"), /parentElement\.children\) if \(node\.id !== "chatHistoryPanel"\) node\.inert = open/);
  assert.match(source("visibleFocusable"), /!node\.closest\("\[inert\]"\)/, "the mobile chat Tab trap must skip controls that chat history made inert");
  assert.doesNotMatch(source("activeModal"), /chatHistoryPanel/, "chat history uses inert, not the modal Tab trap");
  assert.match(source("removeSpeaker"), /updateSaveButtons\(\);\n\s+\$\("addSpeaker"\)\.focus\(\);/);
  assert.match(script, /configState\.compatibleConnections = configState\.compatibleConnections\.filter[^\n]*\n\s+configDirty = true;\n\s+renderConfigView\(\);\n\s+return \$\("addCompatibleConnection"\)\.focus\(\);/);
  assert.match(source("deleteEpisode"), /localStorage\.removeItem\(TRANSCRIPT_DRAFT_PREFIX \+ id\)/);
  const leave = script.match(/window\.addEventListener\("beforeunload", \(event\) => \{[^]*?\n    \}\);/)[0];
  assert.match(leave, /!transcriptDirty/);
  assert.match(leave, /if \(navigator\.userActivation && !navigator\.userActivation\.hasBeenActive\) return;\n\s+event\.preventDefault\(\);/);
  assert.match(script, /changeEpisodeHosts\(select\.dataset\.episodeHost, select\.value\)\.catch\(\(error\) => \{[^]*?lastEpisodeListHtml = "";\s+renderEpisodeList\(\);\s+throw error;/);
  assert.match(html, /<div class="workspace-status" role="status">/);
  assert.doesNotMatch(source("renderPodcastAssistant").match(/\$\("workspaceProgress"\)\.innerHTML = [^\n]*/)[0], /aria-pressed/);
  assert.match(source("renderPodcastAssistant"), /' class="active" aria-current="page"'/);
  assert.doesNotMatch(source("renderSpeakerCards"), /aria-pressed/);
  assert.equal(script.split('notify(error.message || String(error), "error")').length - 1, 1);
  assert.equal(script.split("if (open) setChatControlsOpen(false); else { setChatControlsOpen(true);").length - 1, 1);
  const css = html.match(/<style[^>]*>([\s\S]*?)<\/style>/)[1];
  const mobileChat = Number(script.match(/const mobileChatQuery = matchMedia\("\(max-width: (\d+)px\)"\)/)[1]);
  assert.equal(mobileChat, 1024, "the chat becomes a mobile overlay at 1024 px, so 1025-1200 px keeps the sidebar chat");
  // Brace-depth scan, so blocks with nested @keyframes are checked too.
  const mediaBlocks = [];
  for (const match of css.matchAll(/@media ([^{]+)\{/g)) {
    let depth = 1, end = match.index + match[0].length;
    while (depth) depth += { "{": 1, "}": -1 }[css[end++]] || 0;
    mediaBlocks.push([match[1], css.slice(match.index + match[0].length, end - 1)]);
  }
  assert.ok(mediaBlocks.filter(([query]) => /max-width: 820px/.test(query)).some(([, body]) => /\.workspace-counter \{/.test(body)), "the 820 px block with the counter rule is scanned");
  for (const [query, body] of mediaBlocks) {
    if (/\.assistant-chat \{ display: none; \}/.test(body)) assert.ok(Number(query.match(/max-width: (\d+)px/)?.[1]) <= mobileChat && !/min-width/.test(query), query);
    if (/max-width: (?:1024|820)px/.test(query)) {
      assert.doesNotMatch(body, /\.workspace-(?:status|counter) \{[^}]*display: none/, query);
      assert.doesNotMatch(body, /\.workspace-(?:status|counter) \{[^}]*visibility: hidden/, query);
    }
  }
  assert.match(css, /\.workspace-progress button:focus-visible \{ outline-offset: -4px; \}/);
});
