// The System area of Settings: setup checklist, MCP client signal, port and MCP token changes, and the one-click update.
// These endpoints stay UI-only (no MCP tools) and never accept or return key values.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { availableModelIds } from "./providers/catalog.mjs";
import { redactConfig, updateEnvFile } from "./config.mjs";
import { runProcess } from "./jobs.mjs";
import { serializeMutation, writeTextAtomic } from "./store.mjs";
import { badRequest, conflict, environmentWithoutEnvFile, oneLine, httpError, readJsonBody, sendJson } from "./util.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
export const OWN_BIN = join(ROOT, "bin", "apupod.mjs");
export const TAGS_URL = "https://api.github.com/repos/Jamir-boop/apupod/tags?per_page=100";
const REPO_URL = "https://github.com/Jamir-boop/apupod";
const UPDATE_CACHE_MS = 60 * 60 * 1000;
const TAGS_TIMEOUT_MS = 5_000;
const NPM_TIMEOUT_MS = 5 * 60 * 1000;
const TOOL_TIMEOUT_MS = 5_000;
const MAX_MCP_CLIENTS = 10;
const HOST = "127.0.0.1";

const KEYS = [
  ["ELEVENLABS_API_KEY", "ElevenLabs", "provider:elevenlabs"],
  ["MIMO_API_KEY", "MiMo TTS", "provider:mimo"],
  ["OPENAI_API_KEY", "OpenAI TTS", "provider:openai"],
  ["CHATTERBOX_API_KEY", "Chatterbox", "provider:chatterbox"],
];
const FFMPEG_HINTS = {
  darwin: "Install FFmpeg with Homebrew: brew install ffmpeg",
  win32: "Install FFmpeg: winget install Gyan.FFmpeg, then restart apupod",
  linux: "Install FFmpeg with your package manager, for example: sudo apt install ffmpeg",
};

// shortcut: prerelease tags compare as whole strings, not per dot part; enough for x.y.z releases.
export function compareVersions(a, b) {
  const parse = (value) => String(value ?? "").match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let index = 1; index <= 3; index += 1) if (Number(left[index]) !== Number(right[index])) return Math.sign(Number(left[index]) - Number(right[index]));
  if (left[4] === right[4]) return 0;
  if (!left[4]) return 1;
  if (!right[4]) return -1;
  return Math.sign(left[4].localeCompare(right[4], "en", { numeric: true }));
}

export const runtimeDir = (dataDir) => join(dataDir, "runtime");
const runtimePackage = (dataDir) => join(runtimeDir(dataDir), "node_modules", "apupod");

function packageVersion(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

// The bin to start a daemon from: the update runtime when it holds a newer apupod than this code, else this code.
export function newestBin(dataDir) {
  const dir = runtimePackage(dataDir);
  const version = packageVersion(dir);
  const bin = join(dir, "bin", "apupod.mjs");
  return version && compareVersions(version, VERSION) > 0 && existsSync(bin) ? { bin, version } : { bin: OWN_BIN, version: VERSION };
}

export async function writeMcpToken(path) {
  const token = randomBytes(32).toString("base64url");
  await writeTextAtomic(path, `${token}\n`, 0o600);
  return token;
}

export function signInLink(context, origin, query = "") {
  const now = Date.now();
  for (const [code, expiry] of context.signInCodes) if (expiry <= now) context.signInCodes.delete(code);
  while (context.signInCodes.size >= 20) context.signInCodes.delete(context.signInCodes.keys().next().value);
  const code = randomBytes(32).toString("base64url");
  context.signInCodes.set(code, now + 10 * 60 * 1000);
  return `${origin}/${query ? `?${query}` : ""}#login=${code}`;
}

export function redeemSignInCode(context, code) {
  const expiry = context.signInCodes.get(code);
  context.signInCodes.delete(code);
  if (!expiry || expiry <= Date.now()) throw httpError(401, "This sign-in link is used or expired. Ask for a new one.");
  return context.mcpToken;
}

// Each MCP initialize: the most recent per client name, at most MAX_MCP_CLIENTS names.
export function recordMcpClients(context, body) {
  const text = (value) => typeof value === "string" ? oneLine(value).slice(0, 100) : "";
  for (const message of Array.isArray(body) ? body : [body]) {
    if (message?.method !== "initialize") continue;
    const name = text(message.params?.clientInfo?.name) || "unknown";
    context.mcpClients.delete(name);
    context.mcpClients.set(name, { name, version: text(message.params?.clientInfo?.version), protocolVersion: text(message.params?.protocolVersion), at: new Date().toISOString() });
    if (context.mcpClients.size > MAX_MCP_CLIENTS) context.mcpClients.delete(context.mcpClients.keys().next().value);
  }
}

export const mcpClientList = (context) => [...context.mcpClients.values()].reverse();

export async function checkForUpdate(context, { force = false } = {}) {
  if (!force && context.updateCheck && Date.now() - context.updateCheck.at < UPDATE_CACHE_MS) return context.updateCheck.value;
  let found;
  try {
    const response = await context.fetchImpl(TAGS_URL, { headers: { Accept: "application/vnd.github+json", "User-Agent": "apupod" }, signal: AbortSignal.timeout(TAGS_TIMEOUT_MS) });
    if (!response.ok) found = { status: "error", latest: null, error: `GitHub answered ${response.status}.` };
    else {
      const tags = await response.json();
      const versions = (Array.isArray(tags) ? tags : []).filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag?.name)).map((tag) => tag.name.slice(1));
      const latest = versions.sort((a, b) => compareVersions(b, a))[0];
      found = latest ? { status: compareVersions(latest, VERSION) > 0 ? "available" : "current", latest } : { status: "error", latest: null, error: "GitHub returned no valid release tag." };
    }
  } catch (error) {
    found = { status: "offline", latest: null, error: oneLine(error.message || error).slice(0, 200) };
  }
  const value = {
    current: VERSION,
    ...found,
    checkedAt: new Date().toISOString(),
    changesUrl: found.status === "available" ? `${REPO_URL}/compare/v${VERSION}...v${found.latest}` : `${REPO_URL}/releases`,
  };
  context.updateCheck = { at: Date.now(), value };
  return value;
}

async function toolVersion(name) {
  try {
    const output = await runProcess(name, ["-version"], TOOL_TIMEOUT_MS);
    return { found: true, version: output.match(/version (\S+)/)?.[1] || "unknown" };
  } catch {
    return { found: false, version: null };
  }
}

// A found FFmpeg is cached; a missing one is checked again on the next request, after the user installs it.
async function mediaTools(context) {
  if (context.mediaTools) return context.mediaTools;
  const [ffmpeg, ffprobe] = await Promise.all([toolVersion("ffmpeg"), toolVersion("ffprobe")]);
  if (ffmpeg.found && ffprobe.found) context.mediaTools = { ffmpeg, ffprobe };
  return { ffmpeg, ffprobe };
}

const hasActiveJob = (context) => Boolean(context.activeJobId || context.queue.length);

function assertNoActiveJob(context) {
  if (hasActiveJob(context)) throw conflict("A TTS job is queued or running. Wait until it finishes, then try again.");
}

const currentPort = (context) => context.server?.address()?.port ?? null;

export async function systemStatus(context, { refresh = false } = {}) {
  const [update, tools] = await Promise.all([checkForUpdate(context, { force: refresh }), mediaTools(context)]);
  const config = redactConfig(context.config);
  const keys = [
    ...KEYS.map(([name, label, card]) => ({ name, label, card, configured: Boolean(process.env[name]?.trim()) })),
    ...config.compatibleConnections.map((connection) => ({ name: connection.apiKeyEnv, label: connection.name || "Compatible TTS", card: `compatible:${connection.id}`, configured: connection.hasApiKey })),
  ];
  const typesafe = { name: "TYPESAFE_API_KEY", label: "TypeSafe Jev", card: "decision", configured: config.assistantDecision.hasApiKey };
  const activeModels = availableModelIds(context).ttsModels.size;
  const mcpToken = existsSync(context.paths.mcpToken);
  const port = currentPort(context);
  const ffmpegHint = FFMPEG_HINTS[process.platform] || FFMPEG_HINTS.linux;
  const updateHint = { available: `Version ${update.latest} is available. Click Update apupod.`, current: "apupod is up to date.", offline: `Could not reach GitHub: ${update.error}`, error: update.error }[update.status];
  const checks = [
    { id: "version", label: `apupod ${VERSION}`, status: update.status === "available" ? "warning" : "ok", hint: updateHint },
    { id: "node", label: `Node.js ${process.versions.node}`, status: Number(process.versions.node.split(".")[0]) >= 24 ? "ok" : "warning", hint: "apupod needs Node.js 24 or later." },
    ...[["ffmpeg", "FFmpeg"], ["ffprobe", "FFprobe"]].map(([id, label]) => ({ id, label: tools[id].found ? `${label} ${tools[id].version}` : `${label} not found`, status: tools[id].found ? "ok" : "missing", hint: tools[id].found ? `${label} is on PATH.` : ffmpegHint })),
    { id: "tts-key", label: "TTS provider key", status: keys.some((key) => key.configured) || config.providers.chatterbox.enabled ? "ok" : "missing", hint: "Add a key for at least one TTS provider in the TTS connections below.", card: "provider:elevenlabs" },
    ...keys.map((key) => ({ id: `key:${key.name}`, label: key.name, status: key.configured ? "ok" : "warning", hint: key.configured ? `Saved for ${key.label}.` : `Not set. Needed only for ${key.label}: add it in its Settings card.`, card: key.card })),
    { id: `key:${typesafe.name}`, label: typesafe.name, status: typesafe.configured ? "ok" : "warning", hint: typesafe.configured ? "Saved. The jev_decide check is on." : "Optional. Add it in the TypeSafe Jev card to turn on jev_decide.", card: typesafe.card },
    { id: "models", label: `${activeModels} active TTS model${activeModels === 1 ? "" : "s"}`, status: activeModels > 0 ? "ok" : "missing", hint: activeModels > 0 ? "Your hosts can use these models." : "Save a key, then activate a model with the Models button of its connection.", card: "provider:elevenlabs" },
    { id: "mcp-token", label: "MCP token", status: mcpToken ? "ok" : "missing", hint: mcpToken ? "The stdio bridge reads it from the config dir." : "Click New MCP token to create it." },
  ];
  return {
    version: VERSION,
    update,
    updateJob: context.updateJob,
    node: process.versions.node,
    platform: process.platform,
    ffmpeg: tools.ffmpeg,
    ffprobe: tools.ffprobe,
    dataDir: context.paths.data,
    configDir: dirname(context.paths.config),
    daemon: { pid: process.pid, port, url: port ? `http://${HOST}:${port}` : null },
    keys: [...keys, typesafe].map(({ name, label, card, configured }) => ({ name, label, card, configured })),
    activeModels,
    mcpToken,
    mcpClients: mcpClientList(context),
    checks,
  };
}

function assertPortFree(port) {
  return new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(conflict(`Port ${port} is in use. Choose another port.`)));
    probe.listen(port, HOST, () => probe.close(() => resolvePromise()));
  });
}

async function changePort(context, value) {
  const port = Number(value?.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw badRequest("Port must be an integer from 1024 to 65535.");
  if (port === currentPort(context)) throw badRequest(`apupod already uses port ${port}.`);
  assertNoActiveJob(context);
  await assertPortFree(port);
  await updateEnvFile(context.paths.env, { PORT: String(port) });
  process.env.PORT = String(port);
  return port;
}

async function startUpdate(context) {
  if (["running", "restarting"].includes(context.updateJob?.status)) throw conflict("An update is already running.");
  assertNoActiveJob(context);
  const check = await checkForUpdate(context, { force: true });
  if (check.status !== "available") {
    throw conflict(check.status === "current" ? `apupod ${VERSION} is the latest version.` : `Could not check for updates: ${check.error}`);
  }
  const job = { status: "running", version: check.latest, startedAt: new Date().toISOString(), log: "", error: null };
  context.updateJob = job;
  void (async () => {
    try {
      // A runtime that already holds this version (an earlier update that could not restart) needs no new install.
      if (packageVersion(runtimePackage(context.paths.data)) !== check.latest) {
        const runtime = runtimeDir(context.paths.data);
        await mkdir(runtime, { recursive: true });
        const args = ["install", "--prefix", runtime, "--no-audit", "--no-fund", "--omit=dev", `github:${new URL(REPO_URL).pathname.slice(1)}#v${check.latest}`];
        job.log = `$ npm ${args.join(" ")}\n`;
        console.log(`[update] npm ${args.join(" ")}`);
        job.log = `${job.log}${await context.runCommand("npm", args, NPM_TIMEOUT_MS)}`.slice(-8_000);
      }
      if (newestBin(context.paths.data).version !== check.latest) throw new Error(`The runtime dir does not hold apupod ${check.latest} after npm install.`);
      if (hasActiveJob(context)) {
        job.status = "installed";
        job.message = `apupod ${check.latest} is installed. A TTS job started during the install: click Update apupod again after it finishes to restart.`;
        return;
      }
      job.status = "restarting";
      console.log(`[update] installed apupod ${check.latest}; restarting`);
      context.restart(currentPort(context));
    } catch (error) {
      job.status = "failed";
      job.error = oneLine(error.message || error).slice(0, 2_000);
      console.error(`[update] failed: ${job.error}`);
    }
  })();
  return job;
}

// Start a detached replacement daemon, then close this server and exit so the replacement can bind the port.
export function restartDaemon(context, port) {
  const configDir = dirname(context.paths.config);
  const log = openSync(join(configDir, "daemon.log"), "a", 0o600);
  const child = spawn(process.execPath, [newestBin(context.paths.data).bin, "serve"], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...environmentWithoutEnvFile(), PORT: String(port), APUPOD_REPLACES_PID: String(process.pid) },
    windowsHide: true,
  });
  closeSync(log);
  // Bridges that lose this daemon wait on the start lock while its holder lives, instead of starting a second daemon.
  writeFileSync(join(configDir, "daemon.lock"), String(child.pid), { mode: 0o600 });
  child.unref();
  context.server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}

function sendRestart(res, context, port) {
  sendJson(res, 202, { restarting: true, port, url: `http://${HOST}:${port}/` });
  res.once("finish", () => context.restart(port));
}

export async function handleSystemRequest(req, res, context, method, path, url) {
  if (method === "GET" && path === "/api/system") return sendJson(res, 200, await systemStatus(context, { refresh: url.searchParams.get("refresh") === "1" }));
  if (method === "PUT" && path === "/api/system/port") {
    const body = await readJsonBody(req);
    return sendRestart(res, context, await serializeMutation(context, () => changePort(context, body)));
  }
  if (method === "POST" && path === "/api/system/mcp-token") {
    await serializeMutation(context, async () => { context.mcpToken = await writeMcpToken(context.paths.mcpToken); });
    return sendJson(res, 200, { mcpToken: true, token: context.mcpToken });
  }
  if (method === "POST" && path === "/api/system/update") return sendJson(res, 202, { updateJob: await startUpdate(context) });
  return sendJson(res, 404, { error: "Not found." });
}
