// MCP Apps views (SEP-1865, protocol 2026-01-26). Self-contained HTML: no external scripts, styles, or fonts.
// Each view renders only from the tool result's structuredContent; the tool's text content is the fallback.
export const WIDGET_MIME_TYPE = "text/html;profile=mcp-app";
export const WORKSPACE_WIDGET_URI = "ui://apupod/workspace";
export const EPISODE_WIDGET_URI = "ui://apupod/episode";

const STYLE = `
:root { color-scheme: light dark; --bg: #faf7f2; --card: #ffffff; --text: #22201c; --muted: #6b655c; --line: #e4ddd1; --accent: #c98a1b; }
@media (prefers-color-scheme: dark) { :root { --bg: #1b1a18; --card: #24221f; --text: #ece7df; --muted: #a39c90; --line: #3a3631; --accent: #e0a63a; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 12px; font: 14px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--text); }
h1 { font-size: 16px; margin: 0 0 8px; }
h2 { font-size: 13px; margin: 12px 0 6px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
.num { font-size: 20px; font-weight: 600; }
.muted { color: var(--muted); }
ul { list-style: none; margin: 0; padding: 0; }
li { display: flex; justify-content: space-between; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--line); }
.tag { font-size: 12px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--line); white-space: nowrap; }
.ok { border-color: var(--accent); color: var(--accent); }
button { font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--accent); background: transparent; color: var(--accent); cursor: pointer; }
audio { width: 100%; margin-top: 8px; }
progress { width: 100%; }
`;

// JSON-RPC over postMessage with the host: ui/initialize, then ui/notifications/initialized.
const BRIDGE = `
const pending = new Map();
let nextId = 1;
function request(method, params) {
  const id = nextId++;
  window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
function notify(method, params) { window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*"); }
function el(tag, text, className) { const node = document.createElement(tag); if (text != null) node.textContent = String(text); if (className) node.className = className; return node; }
window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (!message || message.jsonrpc !== "2.0") return;
  if (message.id != null && !message.method) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || "Request failed."));
    else waiter.resolve(message.result);
    return;
  }
  if (message.method === "ui/notifications/tool-result" && message.params?.structuredContent) render(message.params.structuredContent);
  else if (message.id != null) window.parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*");
});
new ResizeObserver(() => notify("ui/notifications/size-changed", { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })).observe(document.body);
request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "apupod", version: "1.0.0" }, appCapabilities: {} })
  .then(() => notify("ui/notifications/initialized", {}))
  .catch(() => {});
function openButton(url, label) {
  const button = el("button", label);
  button.addEventListener("click", () => request("ui/open-link", { url }).catch(() => {}));
  return button;
}
`;

const WORKSPACE_SCRIPT = `
function render(data) {
  const root = document.getElementById("root");
  root.replaceChildren();
  const head = el("div"); head.className = "card";
  head.append(el("h1", "apupod"), el("div", data.tts?.ready ? "TTS ready" : "TTS not ready: add a TTS key in Settings", "muted"));
  if (data.url || data.uiUrl) head.append(openButton(data.url || data.uiUrl, "Open apupod"));
  root.append(head);
  const counts = el("div"); counts.className = "grid";
  for (const [label, items] of [["Hosts", data.hosts], ["Formats", data.formats], ["Knowledge", data.knowledgeBases], ["Plans", data.plans], ["Episodes", data.episodes]]) {
    const card = el("div", null, "card");
    card.append(el("div", (items || []).length, "num"), el("div", label, "muted"));
    counts.append(card);
  }
  root.append(el("h2", "Overview"), counts);
  if (data.episodes?.length) {
    const list = el("ul");
    for (const episode of data.episodes.slice(0, 12)) {
      const row = el("li");
      row.append(el("span", episode.name), el("span", episode.audioReady ? "audio ready" : episode.status, episode.audioReady ? "tag ok" : "tag"));
      list.append(row);
    }
    root.append(el("h2", "Episodes"), list);
  }
}
`;

const EPISODE_SCRIPT = `
let timer = null;
function render(data) {
  const root = document.getElementById("root");
  const episode = data.episode || {};
  root.replaceChildren();
  const card = el("div", null, "card");
  card.append(el("h1", episode.name || "Episode"), el("span", episode.audioReady ? "audio ready" : episode.status, episode.audioReady ? "tag ok" : "tag"));
  const stats = data.stats || {};
  card.append(el("div", [stats.segments != null ? stats.segments + " segments" : "", stats.words != null ? stats.words + " words" : "", stats.targetMinutes ? "target " + stats.targetMinutes + " min" : ""].filter(Boolean).join(" · "), "muted"));
  const job = episode.job;
  if (job && ["queued", "running"].includes(job.status)) {
    const bar = el("progress"); bar.max = job.total || 1; bar.value = job.completed || 0;
    card.append(el("div", job.message || job.phase, "muted"), bar);
  } else if (job?.status === "failed") card.append(el("div", job.error || "Rendering failed.", "muted"));
  if (data.audioUrl) {
    const audio = el("audio"); audio.controls = true; audio.preload = "metadata"; audio.src = data.audioUrl;
    card.append(audio);
  }
  if (data.uiUrl) card.append(openButton(data.uiUrl, "Open in apupod"));
  root.append(card);
  clearTimeout(timer);
  if (job && ["queued", "running"].includes(job.status) && episode.id) {
    timer = setTimeout(() => request("tools/call", { name: "get_episode", arguments: { id: episode.id } })
      .then((result) => result?.structuredContent && render(result.structuredContent))
      .catch(() => {}), 3000);
  }
}
`;

const page = (title, script) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${STYLE}</style></head>
<body><div id="root"><p class="muted">Loading…</p></div><script>${BRIDGE}${script}</script></body></html>
`;

export const WORKSPACE_WIDGET_HTML = page("apupod workspace", WORKSPACE_SCRIPT);
export const EPISODE_WIDGET_HTML = page("apupod episode", EPISODE_SCRIPT);
