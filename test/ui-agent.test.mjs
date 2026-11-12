import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { html, script, source } from "./helpers.mjs";

const install = (names, context) => runInNewContext(names.map(source).join("\n"), context);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const noop = () => {};

test("the page calls no removed embedded-AI endpoint and keeps no chat or generation UI", () => {
  for (const endpoint of ["/api/chat", "/api/plans/chat", "/generate", "/api/chatgpt", "/api/accounts"]) assert.equal(html.includes(endpoint), false, endpoint);
  for (const id of ["podcastAssistant", "plannerChatInput", "plannerChatMessages", "assistantChatToggle", "assistantNextGo", "generateTranscript", "autoGenerateTts", "transcriptEffort", "fmtOutlineModel", "fmtTranscriptModel", "suggestDeliverySetup", "customModelType", "notifyTranscript"]) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`), id);
  }
  assert.doesNotMatch(html, /data-start-episode|data-view="chat"|drawer-close/);
  // The Ask your agent panel and the Settings harness list name the harnesses (Claude Code, ChatGPT, OpenCode); nothing else may name a removed provider.
  assert.doesNotMatch(html.replace(/<section id="agentHint"[^]*?<\/section>/, "").replace(/<div class="harness-list">[^]*?<\/div>/, ""), /chatgpt|anthropic|opencode go|plannerChat|effort/i);
});

test("brand, nav, and the Ask your agent panel", () => {
  assert.match(html, /<title>apupod<\/title>/);
  assert.match(html, /<h1 class="sr-only">apupod<\/h1>/);
  assert.match(html, /<img class="brand-logo" src="\/icon.png" alt="apupod">/);
  assert.match(html, /<div class="workspace-brand">[^]*?<strong>apupod<\/strong>/);
  const nav = html.match(/<nav id="appNav"[^>]*aria-label="Workflow">([^]*?)<\/nav>/)[1];
  assert.deepEqual([...nav.matchAll(/<button[^>]*>(?:<svg[^]*?<\/svg>)?([^<]+)/g)].map((match) => match[1]), ["Production", "Player", "Activity", "Settings", "Retry workspace"]);
  const hint = html.match(/<section id="agentHint"[^>]*>([^]*?)<\/section>/);
  assert.match(hint[0], /tabindex="-1" aria-labelledby="agentHintTitle"/);
  assert.match(hint[1], /<h3 id="agentHintTitle">Ask your agent<\/h3>/);
  const prompts = [...hint[1].matchAll(/<li>([^<]+)<\/li>/g)].map((match) => match[1]);
  assert.ok(prompts.length >= 3 && prompts.length <= 4, prompts.join(" | "));
  assert.ok(prompts.includes("Create two hosts for a tech news show"));
  assert.ok(prompts.includes("Write the script for episode 1 and render it"));
  // The hint and the plan picker live in Production, the default view.
  assert.match(html, /<div id="view-episodes"[^]*?id="agentHint"[^]*?<select id="planSelect">[^]*?id="episodeList"/);
  const css = html.match(/<style[^>]*>([\s\S]*?)<\/style>/)[1];
  const mobile = [...css.matchAll(/@media \(max-width: 820px\) \{/g)].map((match) => css.slice(match.index, css.indexOf("\n    }\n", match.index)));
  assert.ok(mobile.some((block) => /\.app-nav \{[^}]*position: fixed;[^}]*grid-auto-flow: column; grid-auto-columns: minmax\(0, 1fr\);/.test(block)), "the bottom nav sizes itself to its visible buttons");
});

test("Production is the default view and every view alias resolves", () => {
  const views = ["config", "speakers", "format", "episodes", "transcript", "tts", "player"].map((name) => ({ id: `view-${name}`, hidden: true }));
  const context = {
    location: { hash: "" }, history: { replaceState: (_, __, url) => { context.location.hash = url; } },
    document: { querySelectorAll: (selector) => selector === ".view" ? views : [], querySelector: () => views.find((view) => !view.hidden) || null },
    configDirty: false, profilesDirty: false, syncConfigForm: noop, syncFormatForm: noop, syncSpeakerForm: noop,
    renderTranscriptSections: noop, renderTtsView: noop, renderPlayer: noop, renderConfigView: noop, loadSystem: noop, renderFormatView: noop, renderEpisodeList: noop, renderWorkspace: noop,
  };
  install(["activeViewName", "setView"], context);
  for (const [hash, expected] of [["", "episodes"], ["chat", "episodes"], ["planner", "episodes"], ["profiles", "speakers"], ["formats", "format"], ["config", "config"], ["player", "player"]]) {
    context.setView(hash);
    assert.deepEqual(views.filter((view) => !view.hidden).map((view) => view.id), [`view-${expected}`], hash);
  }
});

test("open_ui deep links select the view, the episode, and Activity", async () => {
  const mcp = await readFile(new URL("../src/mcp.mjs", import.meta.url), "utf8");
  const emitted = JSON.parse(mcp.match(/tool\("open_ui"[^]*?view: z\.enum\((\[[^\]]+\])\)/)[1]);
  assert.match(mcp, /\?view=episode&episode=\$\{encodeURIComponent\(episode\.id\)\}/);
  const context = { URLSearchParams };
  install(["deepLink"], context);
  const hashes = ["config", "speakers", "format", "episodes", "transcript", "tts", "player"];
  for (const view of emitted) assert.ok(hashes.includes(context.deepLink(`?view=${view}`).view), view);
  assert.deepEqual({ ...context.deepLink("?view=episode&episode=e%201") }, { view: "transcript", episodeId: "e 1", activity: false });
  assert.deepEqual({ ...context.deepLink("?episode=e1") }, { view: "transcript", episodeId: "e1", activity: false });
  assert.deepEqual({ ...context.deepLink("?view=activity") }, { view: "episodes", episodeId: "", activity: true });
  assert.deepEqual({ ...context.deepLink("?view=settings") }, { view: "config", episodeId: "", activity: false });
  assert.deepEqual({ ...context.deepLink("") }, { view: "", episodeId: "", activity: false });
  assert.deepEqual({ ...context.deepLink("?view=unknown") }, { view: "", episodeId: "", activity: false });
  // The page applies the link once on load: hash view, Activity, and the episode as the preferred selection.
  assert.match(script, /const link = deepLink\(location\.search\);\n\s+if \(link\.view\) history\.replaceState\(null, "", `\$\{location\.pathname\}#\$\{link\.view\}`\);\n\s+if \(link\.activity\) setRightbarOpen\(true, false\);/);
  assert.match(script, /refreshState\(link\.episodeId \|\| rememberedEpisodeId\)/);
});

function pollContext(revisions) {
  const timers = [];
  const calls = [];
  const context = {
    signedOut: false, lastRevision: null, revisionTimer: null, activePlanId: "p",
    document: { visibilityState: "visible", activeElement: null, body: {} },
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeout: noop,
    api: async (path) => { calls.push(path); const next = revisions.shift(); if (next instanceof Error) throw next; return { revision: next }; },
    refreshState: async () => { calls.push("refreshState"); },
    refreshJobs: async () => { calls.push("refreshJobs"); },
    loadPlan: async (id) => { calls.push(`loadPlan:${id}`); },
  };
  install(["focusSelector", "pollRevision"], context);
  return { context, timers, calls };
}

test("revision polling refreshes state, jobs, and the active plan only when the revision changes", async () => {
  const { context, timers, calls } = pollContext([3, 3, 4, new Error("offline"), 5, 5]);
  await context.pollRevision();
  assert.deepEqual(calls, ["/api/revision"], "the first revision is the baseline");
  assert.equal(timers.at(-1).delay, 2000);
  await timers.at(-1).callback();
  assert.deepEqual(calls.slice(1), ["/api/revision"], "an unchanged revision does not refresh");
  await timers.at(-1).callback();
  assert.deepEqual(calls.slice(2), ["/api/revision", "refreshState", "refreshJobs", "loadPlan:p"]);
  assert.equal(context.lastRevision, 4);
  await timers.at(-1).callback();
  assert.equal(context.lastRevision, 4, "a failed poll keeps the old revision");
  assert.equal(timers.at(-1).delay, 2000, "a failed poll still schedules the next one");
  await timers.at(-1).callback();
  assert.deepEqual(calls.slice(-3), ["refreshState", "refreshJobs", "loadPlan:p"]);
  assert.equal(context.lastRevision, 5);
  const scheduled = timers.length;
  context.document.visibilityState = "hidden";
  await timers.at(-1).callback();
  assert.equal(timers.length, scheduled, "a hidden page stops polling");
  assert.equal(calls.filter((call) => call === "/api/revision").length, 5);
});

test("a failed refresh keeps the old revision so the next poll retries it", async () => {
  const { context, timers, calls } = pollContext([1, 2, 2]);
  await context.pollRevision();
  let failures = 1;
  context.refreshState = async () => { calls.push("refreshState"); if (failures-- > 0) throw new Error("state failed"); };
  await timers.at(-1).callback();
  assert.equal(context.lastRevision, 1);
  await timers.at(-1).callback();
  assert.equal(context.lastRevision, 2);
  assert.equal(calls.filter((call) => call === "refreshState").length, 2);
});

test("an auto-refresh keeps focus and the caret in a rebuilt speaker field", async () => {
  const { context, timers } = pollContext([1, 2]);
  const scope = { hasAttribute: (name) => name === "data-speaker-index", getAttribute: () => "1" };
  const before = { id: "", dataset: { field: "backstory" }, selectionStart: 2, selectionEnd: 4, selectionDirection: "forward", closest: () => scope };
  let focused = null;
  let range = null;
  const after = { focus: () => { focused = after; }, setSelectionRange: (...value) => { range = value; } };
  context.CSS = { escape: (value) => value };
  context.document.activeElement = before;
  context.document.querySelector = (selector) => selector === '[data-speaker-index="1"] [data-field="backstory"]' ? after : null;
  context.refreshState = async () => { context.document.activeElement = context.document.body; };
  await context.pollRevision();
  await timers.at(-1).callback();
  assert.equal(focused, after);
  assert.deepEqual(range, [2, 4, "forward"]);
});

test("the page polls on load and on becoming visible", () => {
  assert.match(script, /document\.addEventListener\("visibilitychange", \(\) => \{\n\s+if \(document\.visibilityState === "visible"\) pollRevision\(\);\n\s+else clearTimeout\(revisionTimer\);/);
  assert.match(script, /\.finally\(pollRevision\);/);
});

function settingsContext(decision = {}) {
  const nodes = {};
  const context = {
    configState: {
      providers: { elevenlabs: { hasApiKey: true }, mimo: {}, openai: {}, chatterbox: {} },
      compatibleConnections: [{ id: "c1", name: "Local TTS", baseUrl: "http://127.0.0.1:8000/v1" }],
      assistantDecision: decision,
    },
    modelCatalog: { providers: {} }, state: null,
    document: { querySelectorAll: () => [], querySelector: () => null },
    $: (id) => (nodes[id] ||= {}), renderModelStatus: noop, updateSaveButtons: noop, CSS: { escape: (value) => value },
  };
  install(["escapeHtml", "option", "icon", "providerStatus", "providerStatusPill", "keyClearControl", "usedProfileModels", "modelIdForProvider", "activeModelPills", "compatibleProvider", "providerCard", "compatibleRows", "typesafeCard", "renderConfigView"], context);
  return { context, nodes };
}

test("Settings shows only the TTS connections and the TypeSafe card", () => {
  const { context, nodes } = settingsContext();
  context.renderConfigView();
  const markup = nodes.configProviders.innerHTML;
  const titles = [...markup.matchAll(/<strong>([^<]+)<\/strong>|<h3>([^<]+)<\/h3>/g)].map((match) => match[1] || match[2]);
  assert.deepEqual(titles, ["ElevenLabs", "MiMo TTS", "OpenAI TTS", "Chatterbox", "Compatible TTS", "Local TTS", "TypeSafe Jev"]);
  assert.doesNotMatch(markup, /LLM|Text generation|llmBaseUrl|ChatGPT|Anthropic|OpenCode|effort/i);
  const view = html.match(/<div id="view-config"[^]*?<dialog/)[0];
  assert.match(view, /<h3>Knowledge Bases<\/h3>[^]*?<button id="uploadKnowledge" type="button">[^]*?<input id="knowledgeFile" type="file"[^>]*aria-label="Knowledge base Markdown file" hidden>/);
});

test("the TypeSafe card offers an optional key with save and clear, and no provider choice", () => {
  const empty = settingsContext({ hasApiKey: false }).context.typesafeCard();
  assert.match(empty, /Jev checks, optional/);
  assert.match(empty, /<input readonly value="jev-1\.14\.0">/);
  assert.match(empty, /<input data-field="apiKey" type="password" value="" placeholder="Paste key">/);
  assert.match(empty, /status-pill unconfigured">No key</);
  assert.doesNotMatch(empty, /data-clear-key|data-field="provider"|data-field="enabled"|OpenAI/);
  const saved = settingsContext({ hasApiKey: true }).context.typesafeCard();
  assert.match(saved, /placeholder="Key saved on server"/);
  assert.match(saved, /data-clear-key="decision:jev"/);
  assert.match(settingsContext({ hasApiKey: true, clearApiKey: true }).context.typesafeCard(), /data-undo-clear-key="decision:jev"[^]*Key will be cleared on save/);

  const keyInput = { value: " typed-key " };
  const context = { configState: { providers: {}, compatibleConnections: [], assistantDecision: { hasApiKey: false } },
    document: { querySelector: (selector) => selector === '[data-assistant-decision] [data-field="apiKey"]' ? keyInput : null, querySelectorAll: () => [] } };
  install(["syncConfigForm"], context);
  context.syncConfigForm();
  assert.equal(context.configState.assistantDecision.apiKey, " typed-key ");
  install(["configKeyTarget"], context);
  assert.equal(context.configKeyTarget("decision:jev"), context.configState.assistantDecision);
});

test("the model dialog activates TTS models only", () => {
  const context = { escapeHtml: (value) => String(value) };
  install(["modelSelectionRow"], context);
  assert.match(context.modelSelectionRow("eleven_v4", {}, { tts: true }), /data-model-active aria-label="Activate eleven_v4" checked>/);
  assert.doesNotMatch(context.modelSelectionRow("eleven_v4", {}, { tts: true }), /<select/);
  const checkbox = (checked) => ({ disabled: false, checked });
  const rows = [{ dataset: { modelId: "a" }, querySelector: () => checkbox(true) }, { dataset: { modelId: "b" }, querySelector: () => checkbox(false) }];
  const target = { connection: { activeModels: { b: { tts: true } } } };
  const apply = { modelDialogTarget: { kind: "provider", id: "elevenlabs" }, configDirty: false, state: { profiles: { speakerProfiles: [] } },
    selectedModelTarget: () => target, renderConfigView: noop, alert: noop, $: (id) => id === "modelSelectionList" ? { querySelectorAll: () => rows } : { close: noop } };
  install(["usedProfileModels", "modelIdForProvider", "applyModelSelection"], apply);
  apply.applyModelSelection();
  assert.equal(JSON.stringify(target.connection.activeModels), '{"a":{"tts":true}}');
  assert.equal(apply.configDirty, true);
});

test("plan controls load the most recent plan and list every plan", async () => {
  const nodes = {};
  const loaded = [];
  const context = { state: { plans: [{ id: "new", name: "Newest" }, { id: "old", name: "" }] }, activePlanId: "", activePlan: null,
    $: (id) => (nodes[id] ||= {}), rememberViewSelection: noop, renderWorkspace: noop, notifyError: noop,
    loadPlan: async (id) => { loaded.push(id); }, queueMicrotask };
  install(["escapeHtml", "option", "renderPlanControls"], context);
  context.renderPlanControls();
  await tick();
  assert.deepEqual(loaded, ["new"]);
  assert.match(nodes.planSelect.innerHTML, /<option value="new" selected>Newest<\/option><option value="old">Untitled plan<\/option>/);
  assert.equal(nodes.planSelect.disabled, false);
  context.state.plans = [];
  context.renderPlanControls();
  assert.equal(context.activePlanId, "");
  assert.equal(nodes.planSelect.disabled, true);
  assert.match(script, /\$\("planSelect"\)\.addEventListener\("change", guard\(\(event\) => loadPlan\(event\.target\.value\)\)\);/);
});
