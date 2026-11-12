#!/usr/bin/env node
// apupod CLI: `serve` runs the daemon (UI + REST + /mcp), `mcp` is the stdio bridge a harness starts,
// `open` prints a UI sign-in link, `--version` prints the version.
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createPodcastServer, loadEnvFile, resolveDirs } from "../src/app.mjs";
import { compareVersions, newestBin } from "../src/system.mjs";

const HOST = "127.0.0.1";
const START_TIMEOUT_MS = 30_000;
const REPLACE_TIMEOUT_MS = 15_000;
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function configuredPort() {
  const port = Number(process.env.PORT || "4173");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be an integer from 1 to 65535.");
  return port;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// An apupod daemon answers GET /api/revision with {revision: <integer>}.
async function isApupod(url) {
  try {
    const response = await fetch(`${url}/api/revision`, { signal: AbortSignal.timeout(1_000) });
    return response.ok && Number.isInteger((await response.json()).revision);
  } catch {
    return false;
  }
}

async function liveDaemon(configDir) {
  let daemon;
  try {
    daemon = JSON.parse(await readFile(join(configDir, "daemon.json"), "utf8"));
  } catch {
    return null;
  }
  return Number.isInteger(daemon?.pid) && alive(daemon.pid) && typeof daemon.url === "string" && await isApupod(daemon.url) ? daemon : null;
}

// A missing or invalid daemon version counts as older.
const older = (daemon, target) => !(compareVersions(daemon.version, target) >= 0);

// Idle means no queued or running job; a failed request counts as busy.
async function isIdle(url, configDir) {
  try {
    const token = (await readFile(join(configDir, "mcp-token"), "utf8")).trim();
    const response = await fetch(`${url}/api/jobs`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2_000) });
    const { activeJobId, jobs } = await response.json();
    return response.ok && !activeJobId && Array.isArray(jobs) && !jobs.some((job) => ["queued", "running"].includes(job.status));
  } catch {
    return false;
  }
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function serve() {
  const { configDir } = resolveDirs();
  // A restart (port change or update) starts this process with the PID of the daemon it replaces.
  const replaces = Number(process.env.APUPOD_REPLACES_PID) || 0;
  delete process.env.APUPOD_REPLACES_PID;
  const replaceDeadline = Date.now() + REPLACE_TIMEOUT_MS;
  while (replaces && alive(replaces) && Date.now() < replaceDeadline) await sleep(100);
  // The config-dir .env may set PORT; createPodcastServer loads it too.
  await loadEnvFile(join(configDir, ".env"));
  const port = configuredPort();
  const url = `http://${HOST}:${port}`;
  // Check before createPodcastServer: its startup marks unfinished jobs as interrupted, which would break a running daemon.
  const running = await liveDaemon(configDir) || (await isApupod(url) ? { url } : null);
  if (running) {
    console.log(`apupod is already running at ${running.url}`);
    return;
  }
  const server = await createPodcastServer();
  for (;;) {
    try {
      await listen(server, port);
      break;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      // The replaced daemon can hold the port for a moment after it exits.
      if (replaces && Date.now() < replaceDeadline) {
        await sleep(100);
        continue;
      }
      throw new Error(`Port ${port} is in use by another program. Set PORT in the environment or in ${join(configDir, ".env")} to a free port.`);
    }
  }
  const file = join(configDir, "daemon.json");
  await writeFile(file, `${JSON.stringify({ pid: process.pid, port, url, version })}\n`, { mode: 0o600 });
  // The replaced daemon wrote this PID into the start lock; release it now that daemon.json names this process.
  const lock = join(configDir, "daemon.lock");
  if (replaces && Number(await readFile(lock, "utf8").catch(() => "")) === process.pid) await rm(lock, { force: true });
  process.on("exit", () => {
    try {
      if (JSON.parse(readFileSync(file, "utf8")).pid === process.pid) rmSync(file, { force: true });
    } catch {}
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => process.exit(0));
  console.log(`apupod: ${url}`);
}

// Start the newest apupod: this code or a newer one that an update installed into the data-dir runtime.
// With `replaced`, the new daemon waits for that one to exit, and the old daemon (still alive for a moment) is not returned.
async function startDaemon({ dataDir, configDir }, deadline, replaced = null) {
  const logPath = join(configDir, "daemon.log");
  const log = openSync(logPath, "a", 0o600);
  const { bin, version: target } = newestBin(dataDir);
  const env = replaced ? { ...process.env, APUPOD_REPLACES_PID: String(replaced.pid) } : process.env;
  const child = spawn(process.execPath, [bin, "serve"], { detached: true, stdio: ["ignore", log, log], env, windowsHide: true });
  closeSync(log);
  let exitCode = null;
  child.once("exit", (code) => { exitCode = code ?? 1; });
  child.unref();
  // shortcut: a job queued between the idle check and this SIGTERM is interrupted (interruptStaleJobs keeps cached turns), add a daemon-side drain if that happens in practice.
  if (replaced) try { process.kill(replaced.pid, "SIGTERM"); } catch {}
  while (Date.now() < deadline) {
    const daemon = await liveDaemon(configDir);
    if (daemon && (!replaced || daemon.pid === child.pid || !older(daemon, target))) return daemon;
    if (exitCode !== null) throw new Error(`apupod daemon exited with code ${exitCode}. See ${logPath}.`);
    await sleep(100);
  }
  throw new Error(`apupod daemon did not start within ${START_TIMEOUT_MS / 1000} s. See ${logPath}.`);
}

// The start lock makes concurrent bridges start one daemon; a lock left by a dead process is taken over.
// A daemon older than the newest apupod is replaced when it is idle (never downgraded); a busy one is used until a later connect.
async function ensureDaemon(dirs) {
  const { dataDir, configDir } = dirs;
  const target = newestBin(dataDir).version;
  const replace = async (daemon) => {
    if (!older(daemon, target)) return false;
    if (await isIdle(daemon.url, configDir)) return true;
    console.error(`apupod bridge: daemon ${daemon.version || "(unknown version)"} is older than ${target}; it is busy, the upgrade waits for the next connect.`);
    return false;
  };
  const running = await liveDaemon(configDir);
  if (running && !await replace(running)) return running;
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const lock = join(configDir, "daemon.lock");
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let handle = null;
    try {
      handle = await open(lock, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (handle) {
      try {
        await handle.writeFile(String(process.pid));
        await handle.close();
        // Re-read: another bridge may have started or upgraded the daemon meanwhile.
        const current = await liveDaemon(configDir);
        if (current && !await replace(current)) return current;
        return await startDaemon(dirs, deadline, current);
      } finally {
        await rm(lock, { force: true });
      }
    }
    const daemon = await liveDaemon(configDir);
    if (daemon && !older(daemon, target)) return daemon;
    const holder = Number(await readFile(lock, "utf8").catch(() => ""));
    if (holder && !alive(holder)) await rm(lock, { force: true });
    await sleep(100);
  }
  throw new Error(`apupod daemon did not start within ${START_TIMEOUT_MS / 1000} s.`);
}

// Pass JSON-RPC messages unchanged between the harness (stdio) and the daemon's /mcp endpoint.
// A 401 (the token was rotated) or a connection error (the daemon restarted on a new port or new code) reconnects once:
// re-read daemon.json and mcp-token, start a daemon if none answers (or replace an idle older one), and send the message again.
async function bridge() {
  const dirs = resolveDirs();
  const { configDir } = dirs;
  const local = new StdioServerTransport();
  let upstream = null;
  let protocolVersion = null;
  let reconnecting = null;
  const connect = async () => {
    const daemon = await ensureDaemon(dirs);
    const token = (await readFile(join(configDir, "mcp-token"), "utf8")).trim();
    const next = new StreamableHTTPClientTransport(new URL(`${daemon.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    next.onmessage = (message) => {
      if (message.result?.serverInfo && message.result.protocolVersion) {
        protocolVersion = message.result.protocolVersion;
        next.setProtocolVersion(protocolVersion);
      }
      void local.send(message);
    };
    next.onerror = (error) => console.error(`apupod bridge: ${error.message || error}`);
    await next.start();
    if (protocolVersion) next.setProtocolVersion(protocolVersion);
    const previous = upstream;
    upstream = next;
    void previous?.close().catch(() => {});
  };
  const forward = async (message) => {
    const current = upstream;
    try {
      return await current.send(message);
    } catch (error) {
      // StreamableHTTPError carries the HTTP status; a fetch that never reached a server has no numeric code.
      if (error.code !== 401 && Number.isInteger(error.code)) throw error;
      if (upstream === current) {
        reconnecting ||= connect().finally(() => { reconnecting = null; });
        await reconnecting;
      }
      return upstream.send(message);
    }
  };
  local.onmessage = (message) => {
    forward(message).catch((error) => {
      console.error(`apupod bridge: ${error.message || error}`);
      if (message.method && message.id !== undefined) void local.send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: `apupod daemon request failed: ${error.message || error}` } });
    });
  };
  local.onclose = () => void upstream.close().finally(() => process.exit(0));
  await connect();
  await local.start();
}

async function printUrl() {
  const { configDir } = resolveDirs();
  const daemon = await liveDaemon(configDir);
  if (daemon) {
    try {
      const token = (await readFile(join(configDir, "mcp-token"), "utf8")).trim();
      const response = await fetch(`${daemon.url}/api/sign-in-link`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2_000) });
      if (response.ok) return console.log((await response.json()).url);
    } catch {}
    return console.log(`${daemon.url}/`);
  }
  await loadEnvFile(join(configDir, ".env"));
  console.log(`http://${HOST}:${configuredPort()}/ (not running; start it with: apupod serve)`);
}

if (import.meta.main) {
  const command = process.argv[2];
  const commands = { serve, mcp: bridge, open: printUrl };
  try {
    if (command === "--version" || command === "-v") console.log(version);
    else if (Object.hasOwn(commands, command)) await commands[command]();
    else {
      console.error("Usage: apupod <serve|mcp|open|--version>");
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`apupod: ${error.message || error}`);
    process.exit(1);
  }
}
