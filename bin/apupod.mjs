#!/usr/bin/env node
// apupod CLI: `serve` runs the daemon (UI + REST + /mcp), `mcp` is the stdio bridge a harness starts,
// `open` prints the UI URL, `--version` prints the version.
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createPodcastServer, loadEnvFile, resolveDirs } from "../src/app.mjs";

const HOST = "127.0.0.1";
const BIN = fileURLToPath(import.meta.url);
const START_TIMEOUT_MS = 30_000;
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

export async function serve() {
  const { configDir } = resolveDirs();
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
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, HOST, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    throw new Error(`Port ${port} is in use by another program. Set PORT in the environment or in ${join(configDir, ".env")} to a free port.`);
  }
  const file = join(configDir, "daemon.json");
  await writeFile(file, `${JSON.stringify({ pid: process.pid, port, url, version })}\n`, { mode: 0o600 });
  process.on("exit", () => {
    try {
      if (JSON.parse(readFileSync(file, "utf8")).pid === process.pid) rmSync(file, { force: true });
    } catch {}
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => process.exit(0));
  console.log(`apupod: ${url}`);
}

async function startDaemon(configDir, deadline) {
  const logPath = join(configDir, "daemon.log");
  const log = openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, [BIN, "serve"], { detached: true, stdio: ["ignore", log, log], env: process.env, windowsHide: true });
  closeSync(log);
  let exitCode = null;
  child.once("exit", (code) => { exitCode = code ?? 1; });
  child.unref();
  while (Date.now() < deadline) {
    const daemon = await liveDaemon(configDir);
    if (daemon) return daemon;
    if (exitCode !== null) throw new Error(`apupod daemon exited with code ${exitCode}. See ${logPath}.`);
    await sleep(100);
  }
  throw new Error(`apupod daemon did not start within ${START_TIMEOUT_MS / 1000} s. See ${logPath}.`);
}

// The start lock makes concurrent bridges start one daemon; a lock left by a dead process is taken over.
async function ensureDaemon(configDir) {
  const running = await liveDaemon(configDir);
  if (running) return running;
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
        return await liveDaemon(configDir) || await startDaemon(configDir, deadline);
      } finally {
        await rm(lock, { force: true });
      }
    }
    const daemon = await liveDaemon(configDir);
    if (daemon) return daemon;
    const holder = Number(await readFile(lock, "utf8").catch(() => ""));
    if (holder && !alive(holder)) await rm(lock, { force: true });
    await sleep(100);
  }
  throw new Error(`apupod daemon did not start within ${START_TIMEOUT_MS / 1000} s.`);
}

// Pass JSON-RPC messages unchanged between the harness (stdio) and the daemon's /mcp endpoint.
async function bridge() {
  const { configDir } = resolveDirs();
  const daemon = await ensureDaemon(configDir);
  const token = (await readFile(join(configDir, "mcp-token"), "utf8")).trim();
  const upstream = new StreamableHTTPClientTransport(new URL(`${daemon.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const local = new StdioServerTransport();
  local.onmessage = (message) => {
    upstream.send(message).catch((error) => {
      console.error(`apupod bridge: ${error.message || error}`);
      if (message.method && message.id !== undefined) void local.send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: `apupod daemon request failed: ${error.message || error}` } });
    });
  };
  upstream.onmessage = (message) => {
    if (message.result?.serverInfo && message.result.protocolVersion) upstream.setProtocolVersion(message.result.protocolVersion);
    void local.send(message);
  };
  upstream.onerror = (error) => console.error(`apupod bridge: ${error.message || error}`);
  local.onclose = () => void upstream.close().finally(() => process.exit(0));
  await upstream.start();
  await local.start();
}

async function printUrl() {
  const { configDir } = resolveDirs();
  const daemon = await liveDaemon(configDir);
  if (daemon) return console.log(`${daemon.url}/`);
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
