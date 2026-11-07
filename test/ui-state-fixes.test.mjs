import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { html, script, source } from "./helpers.mjs";

const install = (names, context) => runInNewContext(names.map(source).join("\n"), context);
const handler = (id, event) => script.match(new RegExp(`\\$\\("${id}"\\)\\.addEventListener\\("${event}", guard\\((async \\((?:event)?\\) => \\{[^]*?\\n    })\\)\\);`))[1];
const tick = () => new Promise((resolve) => setImmediate(resolve));
const noop = () => {};
const renders = Object.fromEntries(["renderModelStatus", "renderProfileOptions", "renderPlanControls", "renderFormatView", "renderConfigView", "renderTtsView", "renderJobIndicators", "renderPlayer", "renderEpisodeList", "updateWordCount", "renderWorkspace", "updateSaveButtons", "rememberViewSelection", "renderTranscriptPrompt"].map((name) => [name, noop]));

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
  querySelectorAll(selector) { return selector === "details.speaker-advanced[open]" ? this.openDetails || [] : []; }
}

function episodeContext() {
  const controls = new Map();
  const context = {
    ...renders, uiRequests: { state: 0, episode: 0, prompt: 0, planLoad: 0 }, structuredClone,
    activePlan: null,
    currentEpisode: { id: "a", name: "Episode A", episodeProfileId: "f", speakerProfileId: "s", knowledgeBaseId: "kb", transcript: "Host: saved" },
    state: { profiles: { speakerProfiles: [{ id: "s", name: "Hosts" }], episodeProfiles: [{ id: "f", name: "Format" }] }, knowledgeBases: [{ id: "kb", name: "Source", characters: 10 }], episodes: [], plans: [] },
    configState: {}, configDirty: false, profilesDirty: false, episodeDraftDirty: false, transcriptDirty: false, transcriptPromptDirty: false,
    TRANSCRIPT_DRAFT_PREFIX: "draft.", activeViewName: () => "transcript", validateControls: () => true,
    syncSpeakerForm: noop, syncFormatForm: noop, syncConfigForm: noop, notify: noop,
    resolveTranscriptPrompt: async () => {}, confirm: () => true,
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
  context.api = async (path) => path === "/api/state" ? request.promise : saved;
  const refreshing = context.refreshState("a");
  context.$("episodeName").value = "During refresh";
  request.resolve({ ...context.state, config: {} });
  await refreshing;
  assert.equal(context.$("episodeName").value, "During refresh");
  assert.equal(context.episodeDraftDirty, true);
  const later = Promise.withResolvers();
  context.api = async () => later.promise;
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
  const context = { fetch: async () => ({ ok: false, headers: { get: () => "application/json" }, json: async () => ({ error: "Provider rejected parameter voice_settings.speed. Select a supported speed before trying again.", param: "voice_settings.speed", bodyShape: { voice_settings: { speed: "number" } } }) }) };
  install(["api"], context);
  await assert.rejects(context.api("/api/preview"), /voice_settings\.speed.*Select a supported speed/);
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
  const snapshot = Promise.withResolvers();
  const input = { value: "Old name" };
  context.syncSpeakerForm = () => { context.state.profiles.speakerProfiles[0].name = input.value; };
  context.renderProfileOptions = () => { input.value = context.state.profiles.speakerProfiles[0].name; };
  context.api = async (path, options) => {
    if (path === "/api/state") return snapshot.promise;
    const { expectedUpdatedAt, ...profiles } = JSON.parse(options.body);
    profiles.speakerProfiles[0].revision = 2;
    return { profiles };
  };
  install(["saveProfiles"], context);
  const refreshing = context.refreshState();
  input.value = "New saved name";
  context.profilesDirty = true;
  await context.saveProfiles();
  snapshot.resolve(oldState);
  await refreshing;
  assert.equal(input.value, "New saved name");
  assert.equal(context.state.profiles.speakerProfiles[0].revision, 2);
  assert.equal(context.profilesDirty, false);
});

test("KB deletion reloads the repointed active plan and clears local references", async () => {
  const context = episodeContext();
  context.activePlanId = "p";
  context.activePlan = { id: "p", name: "Plan", knowledgeBaseId: "kb", updatedAt: "v1" };
  const savedPlan = { ...context.activePlan, knowledgeBaseId: "", updatedAt: "v2" };
  const paths = [];
  context.api = async (path, options) => {
    paths.push(`${options?.method || "GET"} ${path}`);
    return path === "/api/knowledge/kb" ? { cleared: { plans: 1, episodes: 1 } } : { plan: savedPlan };
  };
  context.refreshState = async () => {};
  context.loadPlanForm = (plan) => { context.activePlan = plan; };
  const notices = [];
  context.notify = (message) => notices.push(message);
  install(["deleteKnowledgeBase", "refreshPlanVersionAfterRepoint", "loadPlan"], context);
  await context.deleteKnowledgeBase("kb");
  assert.deepEqual(paths, ["DELETE /api/knowledge/kb", "GET /api/plans/p"]);
  assert.equal(context.activePlan.updatedAt, "v2");
  assert.equal(context.currentEpisode.knowledgeBaseId, "");
  assert.match(notices.at(-1), /Cleared 1 plan\(s\) and 1 episode\(s\)\.$/);
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

const statusHelper = script.match(/    const statusHtml = [^]*?\n    };/)[0];

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
  list.querySelectorAll = (selector) => selector === "details.episode-more[open]" ? [menu] : [list.querySelector(selector)];
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

test("a rebuilt episode list refocuses the same control when several in the row share its data attribute", () => {
  const list = listStub();
  const episode = { id: "e1", name: "One", transcriptWords: 1, transcript: "Host: hi", episodeProfileId: "f" };
  const row = () => ({ dataset: { episodeRow: "e1" } });
  const node = (name) => ({ name, disabled: false, matches: () => false, attributes: [{ name: "data-open-episode" }], closest: row, focus() { focused = name; } });
  let focused = "";
  const before = [node("primary"), node("more-open")];
  const after = [node("new primary"), node("new more-open")];
  const context = { state: { episodes: [episode], profiles: { episodeProfiles: [{ id: "f" }], speakerProfiles: [] } }, activePlan: null,
    jobsState: { jobs: [] }, startingEpisodeIds: new Set(), lastEpisodeListHtml: "stale", document: { activeElement: before[1] }, CSS: { escape: (value) => value }, $: () => list };
  list.contains = () => true;
  list.querySelectorAll = (selector) => selector === '[data-episode-row="e1"] [data-open-episode]' ? (list.writes ? after : before) : [];
  list.querySelector = () => null;
  install(["option", "escapeHtml", "icon", "planEpisodeRows", "episodeRowHtml", "renderEpisodeList"], context);
  context.renderEpisodeList();
  assert.equal(list.writes, 1);
  assert.equal(focused, "new more-open");
});

test("setStatus compares markup with the last string written, not the browser's serialization", () => {
  let writes = 0;
  let html = "";
  // A browser reads escapeHtml's &#39; back as an apostrophe.
  const element = { get innerHTML() { return html.replaceAll("&#39;", "'"); }, set innerHTML(value) { writes++; html = value; } };
  const context = { $: () => element };
  runInNewContext(statusHelper, context);
  runInNewContext('setStatus("modelStatus", "Can&#39;t load models", "innerHTML"); setStatus("modelStatus", "Can&#39;t load models", "innerHTML");', context);
  assert.equal(writes, 1, "an unchanged status must not be rewritten and announced again");
});

test("a transcript edit keeps its draft base, so a restore after a regeneration still asks", async () => {
  const stored = new Map();
  const context = episodeContext();
  const asked = [];
  Object.assign(context, { localStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) },
    confirm: (question) => { asked.push(question); return false; } });
  context.transcriptDirty = true;
  context.$("transcriptText").value = "Host: edit 1";
  context.storeTranscriptDraft();
  context.currentEpisode.transcript = "Host: regenerated";
  context.$("transcriptText").value = "Host: edit 2";
  context.storeTranscriptDraft();
  assert.deepEqual(JSON.parse(stored.get("draft.a")), { base: "Host: saved", text: "Host: edit 2" });
  context.$("transcriptText").value = "Host: regenerated";
  context.restoreTranscriptDraft();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /older version/);
  // A successful save moves the base to the saved transcript, even when later edits keep the draft.
  stored.set("draft.a", JSON.stringify({ base: "Host: old", text: "Host: edit 3" }));
  context.$("transcriptText").value = "Host: edit 3";
  context.transcriptDirty = true;
  context.refreshState = async () => {};
  context.transcriptLengthMessage = () => "";
  context.api = async () => { context.$("transcriptText").value = "Host: edit 4"; return { ...context.currentEpisode, transcript: "Host: edit 3" }; };
  await context.saveTranscript();
  assert.deepEqual(JSON.parse(stored.get("draft.a")), { base: "Host: edit 3", text: "Host: edit 4" });
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
  assert.deepEqual([writes.renderStatus, writes.workspaceStatusValue, writes.transcriptSaveStatus], [1, 1, 1]);
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
  cards.$("speakerCards").openDetails = [{ closest: () => ({ dataset: { speakerIndex: "1" } }) }];
  cards.renderSpeakerCards({ voiceModel: "m", speakers: [{ name: "A" }, { name: "B" }] });
  assert.deepEqual(cards.$("speakerCards").innerHTML.match(/<details class="speaker-advanced"[^>]*>/g), ['<details class="speaker-advanced">', '<details class="speaker-advanced" open>'], "a rebuild keeps an open disclosure open");
});

test("page markup and CSS keep the accessibility and layout fixes", () => {
  assert.match(html, /<dialog id="modelDialog"[^>]*aria-labelledby="modelDialogTitle"/);
  assert.match(html, /<textarea id="transcriptText"[^>]*aria-describedby="transcriptLengthWarning"/);
  assert.match(html, /<select id="savedEpisodeSelect" aria-describedby="savedEpisodeHint">/);
  assert.match(html, /id="savedEpisodeHint"/);
  assert.doesNotMatch(script, /label\.title = label\.dataset\.help/);
  assert.match(html, /<div id="speakerSidebar"[^>]*role="group"/);
  assert.doesNotMatch(html, /role="navigation"/);
  assert.match(source("visibleFocusable"), /!node\.closest\("\[inert\]"\)/, "the Activity Tab trap must skip inert controls");
  assert.match(source("removeSpeaker"), /updateSaveButtons\(\);\n\s+\$\("addSpeaker"\)\.focus\(\);/);
  assert.match(script, /configState\.compatibleConnections = configState\.compatibleConnections\.filter[^\n]*\n\s+configDirty = true;\n\s+renderConfigView\(\);\n\s+return \$\("addCompatibleConnection"\)\.focus\(\);/);
  assert.match(source("deleteEpisode"), /localStorage\.removeItem\(TRANSCRIPT_DRAFT_PREFIX \+ id\)/);
  const leave = script.match(/window\.addEventListener\("beforeunload", \(event\) => \{[^]*?\n    \}\);/)[0];
  assert.match(leave, /!transcriptDirty/);
  assert.match(leave, /if \(navigator\.userActivation && !navigator\.userActivation\.hasBeenActive\) return;\n\s+event\.preventDefault\(\);/);
  assert.match(script, /changeEpisodeHosts\(select\.dataset\.episodeHost, select\.value\)\.catch\(\(error\) => \{[^]*?lastEpisodeListHtml = "";\s+renderEpisodeList\(\);\s+throw error;/);
  assert.match(html, /<div class="workspace-status" role="status">/);
  assert.doesNotMatch(source("renderWorkspace").match(/\$\("workspaceProgress"\)\.innerHTML = [^\n]*/)[0], /aria-pressed/);
  assert.match(source("renderWorkspace"), /' class="active" aria-current="page"'/);
  assert.doesNotMatch(source("renderSpeakerCards"), /aria-pressed/);
  assert.equal(script.split('notify(error.message || String(error), "error")').length - 1, 1);
  const css = html.match(/<style[^>]*>([\s\S]*?)<\/style>/)[1];
  // Brace-depth scan, so blocks with nested @keyframes are checked too.
  const mediaBlocks = [];
  for (const match of css.matchAll(/@media ([^{]+)\{/g)) {
    let depth = 1, end = match.index + match[0].length;
    while (depth) depth += { "{": 1, "}": -1 }[css[end++]] || 0;
    mediaBlocks.push([match[1], css.slice(match.index + match[0].length, end - 1)]);
  }
  assert.ok(mediaBlocks.filter(([query]) => /max-width: 820px/.test(query)).some(([, body]) => /\.workspace-counter \{/.test(body)), "the 820 px block with the counter rule is scanned");
  for (const [query, body] of mediaBlocks) {
    if (/max-width: (?:1024|820)px/.test(query)) {
      assert.doesNotMatch(body, /\.workspace-(?:status|counter) \{[^}]*display: none/, query);
      assert.doesNotMatch(body, /\.workspace-(?:status|counter) \{[^}]*visibility: hidden/, query);
    }
  }
  assert.match(css, /\.workspace-progress button:focus-visible \{ outline-offset: -4px; \}/);
});
