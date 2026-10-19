import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { source } from "./helpers.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("settings provider switches preserve the typed TypeSafe key, checkbox, and separate OpenAI key", () => {
  const configState = { providers: { openai: { apiKey: "old-openai", enabled: true } }, assistantDecision: { provider: "typesafe", apiKey: "old-typesafe", enabled: false }, compatibleConnections: [] };
  let provider = "openai";
  let keyVisible = true;
  const decisionRow = { querySelector: (selector) => selector.includes('"enabled"') ? { checked: true } : selector.includes('"provider"') ? { value: provider } : keyVisible ? { value: "typed-typesafe-key" } : null };
  const openaiRow = { querySelector: (selector) => selector.includes('"enabled"') ? { checked: true } : selector.includes('"apiKey"') ? { value: "typed-openai-key" } : null };
  const context = { configState, document: { querySelector: (selector) => selector === "[data-assistant-decision]" ? decisionRow : selector === '[data-provider-id="openai"]' ? openaiRow : null, querySelectorAll: () => [] } };
  runInNewContext(source("syncConfigForm"), context);
  context.syncConfigForm();
  assert.equal(configState.assistantDecision.provider, "openai");
  assert.equal(configState.assistantDecision.enabled, true);
  assert.equal(configState.assistantDecision.apiKey, "typed-typesafe-key");
  assert.equal(configState.providers.openai.apiKey, "typed-openai-key");
  keyVisible = false;
  context.syncConfigForm();
  assert.equal(configState.assistantDecision.apiKey, "typed-typesafe-key");
  provider = "typesafe";
  context.syncConfigForm();
  assert.equal(configState.assistantDecision.provider, "typesafe");
  assert.equal(configState.assistantDecision.apiKey, "typed-typesafe-key");
  assert.match(source("assistantDecisionCard"), /<label class="full">Provider<select/);
});

test("native delivery action preserves composed chat text and sends the current draft with no text model", async () => {
  const elements = new Map();
  for (const id of ["plannerChatInput", "plannerChatModel", "plannerChatKb", "plannerChatBusyText", "plannerChatBusy", "plannerChatSend"]) elements.set(id, { value: id === "plannerChatInput" ? "Unsent composed request" : "", disabled: false, hidden: true });
  const draft = { id: "hosts", speakers: [{ backstory: "Current draft backstory" }] };
  const requests = [];
  const context = { plannerChatBusy: false, plannerChatThreadId: "", uiRequests: { chat: 0, chatSelection: 0 }, activePlan: { id: "podcast" }, $: (id) => elements.get(id),
    api: async (path, options) => { requests.push([path, JSON.parse(options.body)]); return { threadId: "new-thread" }; },
    capturePlanDraft: () => ({}), assistantContext: () => ({ view: "speakers", speakerProfileId: "hosts" }), assistantWorkspaceDraft: () => draft, loadPlannerChatThread: async () => {} };
  runInNewContext(source("sendPlannerChat"), context);
  await context.sendPlannerChat({ action: "suggestDeliverySetup", text: "Suggest delivery setup." });
  assert.equal(elements.get("plannerChatInput").value, "Unsent composed request");
  assert.equal(elements.get("plannerChatInput").disabled, false);
  assert.equal(context.plannerChatBusy, false);
  assert.equal(requests[0][1].model, "");
  assert.equal(requests[0][1].action, "suggestDeliverySetup");
  assert.deepEqual(requests[0][1].workspaceDraft, draft);
});

test("draft Apply does not pre-save, keeps unrelated profile edits, and rejects a later changed draft", async () => {
  const sourceProfile = { id: "hosts", revision: 1, name: "Unsaved hosts", speakers: [{ name: "Host", style: "Current draft" }] };
  const local = { speakerProfiles: [structuredClone(sourceProfile), { id: "other", revision: 1, name: "Other unsaved hosts" }], episodeProfiles: [{ id: "format", revision: 1, description: "Unsaved format" }] };
  const saved = { speakerProfiles: [{ ...sourceProfile, revision: 2, speakers: [{ name: "Host", style: "Compiled direction" }] }, { id: "other", revision: 1, name: "Other saved hosts" }], episodeProfiles: [{ id: "format", revision: 1, description: "Saved format" }] };
  const receipt = { draftSource: { profileId: "hosts", hash: hash(sourceProfile) } };
  const message = { role: "assistant", content: JSON.stringify({ proposal: { speakerProfile: { targetId: "hosts", value: sourceProfile } }, decisionReceipt: receipt }) };
  const hostsView = { inert: false };
  const formatView = { inert: false };
  const button = { disabled: false };
  let saveCalls = 0;
  let applyCalls = 0;
  const { promise: pendingApply, resolve: resolveApply } = Promise.withResolvers();
  const context = { state: { profiles: local }, uiRequests: { state: 0 }, profilesDirty: true, activeSpeakerProfileId: "hosts", activeEpisodeProfileId: "format", plannerChatThread: { threadId: "thread", messages: [message] }, plannerChatThreadId: "thread", activePlanId: "",
    currentEpisode: null, activePlan: null, structuredClone, TextEncoder, crypto: webcrypto, Uint8Array,
    $: (id) => id === "view-speakers" ? hostsView : formatView,
    document: { querySelectorAll: () => [button] }, syncSpeakerForm() {}, syncFormatForm() {},
    saveProfiles: async () => { saveCalls++; }, api: async (_, options) => { applyCalls++; const body = JSON.parse(options.body); assert.equal(body.workspaceDraft.name, "Unsaved hosts"); return pendingApply; },
    renderProfileOptions() {}, renderBuildOptions() {}, renderFormatView() {}, refreshState: async () => {}, refreshPlanIndex: async () => {}, loadPlannerChatThread: async () => {}, loadSpeakerForm() {}, notify() {},
  };
  runInNewContext(["assistantSpeakerDraft", "assistantDraftHash", "mergeAppliedHostsDraft", "applyAssistantProposal"].map(source).join("\n"), context);
  const applying = context.applyAssistantProposal(0, false);
  while (!applyCalls) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saveCalls, 0);
  assert.equal(hostsView.inert, true);
  assert.equal(formatView.inert, true);
  resolveApply({ appliedType: "speakerProfile", appliedId: "hosts", profiles: saved, updatedEpisodes: 0, warnings: [] });
  await applying;
  assert.equal(context.state.profiles.speakerProfiles[0].revision, 2);
  assert.equal(context.state.profiles.speakerProfiles[0].speakers[0].style, "Compiled direction");
  assert.equal(context.state.profiles.speakerProfiles[1].name, "Other unsaved hosts");
  assert.equal(context.state.profiles.episodeProfiles[0].description, "Unsaved format");
  assert.equal(context.profilesDirty, true);
  assert.equal(hostsView.inert, false);
  assert.equal(formatView.inert, false);
  assert.equal(button.disabled, false);
  context.state.profiles.speakerProfiles[0] = { ...sourceProfile, name: "Later local edit" };
  await assert.rejects(context.applyAssistantProposal(0, false), /Hosts draft changed/);
  assert.equal(applyCalls, 1);
  assert.equal(saveCalls, 0);
  assert.equal(context.state.profiles.speakerProfiles[0].name, "Later local edit");
  assert.equal(button.disabled, false);
  context.state.profiles = { speakerProfiles: [structuredClone(sourceProfile), structuredClone(saved.speakerProfiles[1])], episodeProfiles: structuredClone(saved.episodeProfiles) };
  context.profilesDirty = true;
  await context.applyAssistantProposal(0, false);
  assert.equal(context.profilesDirty, false, "Apply leaves the form clean when no unrelated edits remain");
});

test("syncing untouched default Format effort does not create false dirty fields", () => {
  const format = { id: "format", name: "Format", description: "Saved format", targetMinutes: 18, language: "es-419", outlineModel: "model", transcriptModel: "model" };
  const values = { fmtName: "Format", fmtDescription: "Saved format", fmtMinutes: "18", fmtLanguage: "es-419", fmtOutlineModel: "model", fmtTranscriptModel: "model", fmtOutlineEffort: "", fmtTranscriptEffort: "" };
  const context = { state: { profiles: { episodeProfiles: [format] } }, formatFormId: "format", $: (id) => ({ value: values[id] }) };
  runInNewContext(source("syncFormatForm"), context);
  const before = JSON.stringify(format);
  context.syncFormatForm();
  assert.equal(JSON.stringify(format), before);
  values.fmtOutlineEffort = "high";
  context.syncFormatForm();
  assert.equal(format.outlineEffort, "high");
  values.fmtOutlineEffort = "";
  context.syncFormatForm();
  assert.equal(format.outlineEffort, "");
});
