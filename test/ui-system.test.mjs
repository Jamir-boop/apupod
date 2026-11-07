import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { html, source } from "./helpers.mjs";

const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const panel = html.match(/<section id="systemPanel"[^]*?\n {8}<\/section>/)[0];
const unescape = (text) => text.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

test("Settings opens with the System area: checklist, harnesses, port and token, and update", () => {
  assert.match(html, /<div id="view-config"[^]*?<section id="systemPanel" class="panel" aria-labelledby="systemTitle">[^]*?<div id="configProviders">/);
  for (const id of ["systemChecklist", "systemFacts", "mcpClients", "systemPort", "changePort", "rotateMcpToken", "updateSummary", "checkUpdate", "runUpdate", "updateLog"]) assert.match(panel, new RegExp(`id="${id}"`), id);
  assert.match(panel, /<p id="systemStatus" class="muted" role="status" aria-live="polite">/);
  assert.match(panel, /<input id="systemPort" type="number" min="1024" max="65535"[^>]*aria-describedby="systemPortHelp">/);
  assert.doesNotMatch(panel, /\son[a-z]+=|style=/i, "no inline handlers or styles (CSP)");
  // The harness commands are the ones the README documents.
  for (const id of ["harnessClaude", "harnessCodex"]) {
    const commands = unescape(panel.match(new RegExp(`<pre id="${id}"><code>([^<]+)</code></pre>`))[1]);
    assert.ok(readme.includes(`\`\`\`bash\n${commands}\n\`\`\``), `${id} matches the README`);
  }
  assert.match(panel, /claude plugin marketplace add Jamir-boop\/apupod\nclaude plugin install apupod@apupod/);
  assert.match(panel, /codex plugin marketplace add Jamir-boop\/apupod\ncodex plugin add apupod@apupod/);
  const opencode = JSON.parse(unescape(panel.match(/<pre id="harnessOpenCode"><code>([^<]+)<\/code><\/pre>/)[1]));
  assert.deepEqual(opencode.mcp.servers.apupod, { type: "local", command: ["npx", "-y", `github:Jamir-boop/apupod#v${version}`, "mcp"] });
  for (const id of ["harnessClaude", "harnessCodex", "harnessOpenCode"]) assert.match(panel, new RegExp(`<button type="button" data-copy="${id}">`));
});

function fakeDom() {
  const nodes = {};
  const $ = (id) => (nodes[id] ||= { id, innerHTML: "", textContent: "", value: "", hidden: false, disabled: false });
  return { $, nodes };
}

function install(context) {
  runInNewContext(["timeAgo", "renderSystem", "escapeHtml", "icon"].map(source).join("\n"), context);
  return context;
}

const sample = (overrides = {}) => ({
  version: "1.1.0",
  node: "24.1.0",
  dataDir: "/home/u/.local/share/apupod",
  configDir: "/home/u/.config/apupod",
  daemon: { pid: 42, port: 4173, url: "http://127.0.0.1:4173" },
  mcpClients: [{ name: "claude-code", version: "2.1.0", protocolVersion: "2025-06-18", at: new Date(Date.now() - 3 * 60_000).toISOString() }],
  checks: [
    { id: "ffmpeg", label: "FFmpeg not found", status: "missing", hint: "Install FFmpeg with Homebrew: brew install ffmpeg" },
    { id: "key:MIMO_API_KEY", label: "MIMO_API_KEY", status: "warning", hint: "Not set. Needed only for MiMo TTS: add it in its Settings card.", card: "provider:mimo" },
    { id: "key:ELEVENLABS_API_KEY", label: "ELEVENLABS_API_KEY", status: "ok", hint: "Saved for ElevenLabs.", card: "provider:elevenlabs" },
  ],
  update: { current: "1.1.0", latest: "1.2.0", status: "available", changesUrl: "https://github.com/Jamir-boop/apupod/compare/v1.1.0...v1.2.0" },
  updateJob: null,
  ...overrides,
});

test("renderSystem shows statuses with words, card links for missing keys, the last connections, and the update state", () => {
  const { $, nodes } = fakeDom();
  const context = install({ $, document: { activeElement: null }, systemState: null });
  context.renderSystem(sample());
  assert.equal(nodes.systemStatus.textContent, "1 setup item is missing.");
  const items = nodes.systemChecklist.innerHTML.split("</li>").filter(Boolean);
  assert.equal(items.length, 3);
  assert.match(items[0], /<span class="status-pill error">Missing<\/span><span><strong>FFmpeg not found<\/strong><small>Install FFmpeg with Homebrew: brew install ffmpeg<\/small>/);
  assert.match(items[1], /<span class="status-pill warning">Check<\/span>[^]*<button type="button" data-settings-card="provider:mimo">[^]*Open card<\/button>/);
  assert.match(items[2], /<span class="status-pill ready">OK<\/span>/);
  assert.doesNotMatch(items[2], /data-settings-card/, "a configured key needs no fix link");
  assert.match(nodes.systemFacts.innerHTML, /<dt>Data dir<\/dt><dd>\/home\/u\/.local\/share\/apupod<\/dd>[^]*<dt>Daemon<\/dt><dd>PID 42, port 4173, http:\/\/127.0.0.1:4173<\/dd>/);
  assert.match(nodes.mcpClients.innerHTML, /Last connected: claude-code 2\.1\.0, 3 min ago[^]*MCP protocol 2025-06-18/);
  assert.equal(nodes.systemPort.value, 4173);
  assert.match(nodes.updateSummary.innerHTML, /apupod 1\.1\.0 is running\. Version 1\.2\.0 is available\. <a href="https:\/\/github.com\/Jamir-boop\/apupod\/compare\/v1\.1\.0\.\.\.v1\.2\.0" target="_blank" rel="noopener noreferrer">What changed<\/a>/);
  assert.equal(nodes.runUpdate.disabled, false);
  assert.equal(nodes.updateLog.hidden, true);
  assert.equal(context.systemState.version, "1.1.0");

  context.renderSystem(sample({ checks: [], mcpClients: [], update: { current: "1.1.0", latest: null, status: "offline", error: "fetch failed", changesUrl: "https://github.com/Jamir-boop/apupod/releases" }, updateJob: { status: "failed", version: "1.2.0", error: "npm exited with code 1: <E404>", log: "$ npm install\nnpm error 404\n" } }));
  assert.equal(nodes.systemStatus.textContent, "Setup is complete.");
  assert.match(nodes.mcpClients.innerHTML, /No harness has connected since apupod started\./);
  assert.match(nodes.updateSummary.innerHTML, /Could not reach the npm registry\. <a [^>]+>Releases<\/a><br><span class="error">[^]*Error: Update failed: npm exited with code 1: &lt;E404&gt;<\/span>/);
  assert.equal(nodes.runUpdate.disabled, true);
  assert.deepEqual([nodes.updateLog.hidden, nodes.updateLog.textContent], [false, "$ npm install\nnpm error 404\n"]);

  // The port field keeps what the user is typing.
  nodes.systemPort.value = "5000";
  context.document.activeElement = nodes.systemPort;
  context.renderSystem(sample({ updateJob: { status: "running", version: "1.2.0", log: "" } }));
  assert.equal(nodes.systemPort.value, "5000");
  assert.match(nodes.updateSummary.innerHTML, /<br>Installing apupod 1\.2\.0…/);
  assert.equal(nodes.runUpdate.disabled, true, "no second update while one runs");
});

test("timeAgo gives short relative times", () => {
  const { timeAgo } = install({});
  const now = Date.parse("2026-11-07T12:00:00Z");
  assert.equal(timeAgo("2026-11-07T11:59:30Z", now), "just now");
  assert.equal(timeAgo("2026-11-07T11:45:00Z", now), "15 min ago");
  assert.equal(timeAgo("2026-11-07T09:00:00Z", now), "3 h ago");
  assert.equal(timeAgo("2026-11-05T12:00:00Z", now), "2 d ago");
  assert.equal(timeAgo("not a date", now), "");
});
