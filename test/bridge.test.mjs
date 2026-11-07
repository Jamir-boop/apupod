import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { waitFor } from "./helpers.mjs";

const BIN = fileURLToPath(new URL("../bin/apupod.mjs", import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test("two concurrent `apupod mcp` bridges start one daemon and proxy MCP over stdio", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "apupod-bridge-"));
  const configDir = join(root, "config");
  const port = await freePort();
  // Only the SDK's safe default variables plus ours: no provider keys reach the daemon.
  const env = { ...getDefaultEnvironment(), APUPOD_DATA_DIR: join(root, "data"), APUPOD_CONFIG_DIR: configDir, PORT: String(port) };
  let daemonPid = null;
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    if (daemonPid && alive(daemonPid)) {
      process.kill(daemonPid, "SIGTERM");
      await waitFor(() => !alive(daemonPid), 5_000).catch(() => process.kill(daemonPid, "SIGKILL"));
    }
    await rm(root, { recursive: true, force: true });
  });

  const connect = async () => {
    const client = new Client({ name: "bridge-test", version: "0" });
    clients.push(client);
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"], env, stderr: "pipe" });
    await client.connect(transport);
    return { client, transport };
  };
  const bridges = await Promise.all([connect(), connect()]);
  const daemon = JSON.parse(await readFile(join(configDir, "daemon.json"), "utf8"));
  daemonPid = daemon.pid;
  assert.equal(daemon.port, port);
  assert.equal(daemon.url, `http://127.0.0.1:${port}`);
  assert.ok(bridges.every(({ transport }) => transport.pid && transport.pid !== daemon.pid));

  for (const { client } of bridges) {
    assert.equal(client.getServerVersion().name, "apupod");
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "get_workspace"));
    const result = await client.callTool({ name: "get_workspace", arguments: {} });
    assert.ok(!result.isError, result.content?.[0]?.text);
    assert.equal(result.structuredContent.uiUrl, `${daemon.url}/`);
  }
  // Each started `apupod serve` logs one line; the start lock lets only one bridge start it.
  const log = (await readFile(join(configDir, "daemon.log"), "utf8")).trim().split("\n").filter(Boolean);
  assert.deepEqual(log, [`apupod: ${daemon.url}`]);

  assert.equal((await fetch(`${daemon.url}/`)).status, 200);
  assert.equal((await fetch(`${daemon.url}/api/revision`)).status, 200);
  assert.equal((await fetch(`${daemon.url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);

  // A later bridge reuses the running daemon.
  const third = await connect();
  assert.equal((await third.client.callTool({ name: "get_workspace", arguments: {} })).structuredContent.uiUrl, `${daemon.url}/`);
  assert.equal((await readFile(join(configDir, "daemon.log"), "utf8")).trim().split("\n").length, 1);

  process.kill(daemonPid, "SIGTERM");
  await waitFor(() => !alive(daemonPid), 5_000);
  await assert.rejects(readFile(join(configDir, "daemon.json")), { code: "ENOENT" }, "serve removes daemon.json on exit");
});

test("`apupod serve` fails clearly when another program owns the port, and --version prints the version", async (t) => {
  const { execFile } = await import("node:child_process");
  const run = (args, env) => new Promise((resolve) => execFile(process.execPath, [BIN, ...args], { env, timeout: 20_000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal((await run(["--version"], getDefaultEnvironment())).stdout.trim(), version);

  const root = await mkdtemp(join(tmpdir(), "apupod-port-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Not an HTTP server: it drops every connection, so the probe for a running apupod fails.
  const blocker = createServer((socket) => socket.destroy());
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const result = await run(["serve"], { ...getDefaultEnvironment(), APUPOD_DATA_DIR: join(root, "data"), APUPOD_CONFIG_DIR: join(root, "config"), PORT: String(blocker.address().port) });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Port \d+ is in use by another program/);
});

// Stop each daemon this test saw; daemons are detached, so the test kills them by PID.
async function stopDaemons(pids) {
  for (const pid of pids) {
    if (!alive(pid)) continue;
    process.kill(pid, "SIGTERM");
    await waitFor(() => !alive(pid), 5_000).catch(() => process.kill(pid, "SIGKILL"));
  }
}

test("a running `apupod mcp` bridge keeps working after the MCP token rotates and the daemon restarts on a new port", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "apupod-restart-"));
  const configDir = join(root, "config");
  const [port, nextPort] = [await freePort(), await freePort()];
  const env = { ...getDefaultEnvironment(), APUPOD_DATA_DIR: join(root, "data"), APUPOD_CONFIG_DIR: configDir, PORT: String(port) };
  const pids = new Set();
  const client = new Client({ name: "restart-test", version: "1" });
  t.after(async () => {
    await client.close().catch(() => {});
    await stopDaemons(pids);
    await rm(root, { recursive: true, force: true });
  });
  const daemonFile = () => readFile(join(configDir, "daemon.json"), "utf8").then(JSON.parse).catch(() => null);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"], env, stderr: "pipe" }));
  const first = await daemonFile();
  pids.add(first.pid);
  assert.ok((await client.listTools()).tools.length > 0);
  const system = await (await fetch(`${first.url}/api/system`)).json();
  assert.equal(system.mcpClients[0].name, "restart-test", "the daemon records the harness initialize sent through the bridge");

  const oldToken = await readFile(join(configDir, "mcp-token"), "utf8");
  assert.equal((await fetch(`${first.url}/api/system/mcp-token`, { method: "POST" })).status, 200);
  assert.notEqual(await readFile(join(configDir, "mcp-token"), "utf8"), oldToken);
  assert.ok((await client.listTools()).tools.length > 0, "the bridge re-reads the token after a 401");

  const changed = await fetch(`${first.url}/api/system/port`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ port: nextPort }) });
  assert.equal(changed.status, 202);
  // Sent while the old daemon stops: the bridge waits for the replacement and sends again.
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "get_workspace"));
  const second = await waitFor(async () => { const daemon = await daemonFile(); return daemon?.port === nextPort && daemon; }, 20_000);
  pids.add(second.pid);
  assert.notEqual(second.pid, first.pid);
  assert.equal(second.url, `http://127.0.0.1:${nextPort}`);
  await waitFor(() => !alive(first.pid), 10_000);
  assert.equal((await client.callTool({ name: "get_workspace", arguments: {} })).structuredContent.uiUrl, `${second.url}/`);
  assert.match(await readFile(join(configDir, ".env"), "utf8"), new RegExp(`^PORT=${nextPort}$`, "m"));
  await assert.rejects(readFile(join(configDir, "daemon.lock")), { code: "ENOENT" }, "the replacement releases the start lock");
  // One start by the bridge and one replacement: no second daemon raced for the port.
  const started = (await readFile(join(configDir, "daemon.log"), "utf8")).split("\n").filter((line) => line.startsWith("apupod: "));
  assert.deepEqual(started, [`apupod: ${first.url}`, `apupod: ${second.url}`]);
});

test("the bridge starts the newest apupod: a newer one in the data-dir runtime wins over its own bin", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "apupod-newest-"));
  const dataDir = join(root, "data");
  const configDir = join(root, "config");
  const runtime = join(dataDir, "runtime", "node_modules", "apupod");
  await mkdir(join(runtime, "bin"), { recursive: true });
  await writeFile(join(runtime, "package.json"), JSON.stringify({ name: "apupod", version: "99.0.0" }));
  // A stand-in for the installed package: it marks that it ran, then serves with this checkout's code.
  await writeFile(join(runtime, "bin", "apupod.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./started", import.meta.url), String(process.pid));\nconst { serve } = await import(${JSON.stringify(new URL("../bin/apupod.mjs", import.meta.url).href)});\nawait serve();\n`);
  const env = { ...getDefaultEnvironment(), APUPOD_DATA_DIR: dataDir, APUPOD_CONFIG_DIR: configDir, PORT: String(await freePort()) };
  const pids = new Set();
  const client = new Client({ name: "newest-test", version: "1" });
  t.after(async () => {
    await client.close().catch(() => {});
    await stopDaemons(pids);
    await rm(root, { recursive: true, force: true });
  });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"], env, stderr: "pipe" }));
  const daemon = JSON.parse(await readFile(join(configDir, "daemon.json"), "utf8"));
  pids.add(daemon.pid);
  assert.equal(Number(await readFile(join(runtime, "bin", "started"), "utf8")), daemon.pid);
  assert.ok((await client.listTools()).tools.length > 0);
});

test("concurrent bridges replace an older idle daemon with one daemon on the current version", async (t) => {
  const { spawn } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "apupod-upgrade-"));
  const configDir = join(root, "config");
  const env = { ...getDefaultEnvironment(), APUPOD_DATA_DIR: join(root, "data"), APUPOD_CONFIG_DIR: configDir, PORT: String(await freePort()) };
  const pids = new Set();
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    await stopDaemons(pids);
    await rm(root, { recursive: true, force: true });
  });
  const daemonFile = () => readFile(join(configDir, "daemon.json"), "utf8").then(JSON.parse).catch(() => null);
  // The old daemon logs to a pipe, so daemon.log holds only the daemons that bridges start.
  const old = spawn(process.execPath, [BIN, "serve"], { env, stdio: "ignore" });
  pids.add(old.pid);
  const first = await waitFor(async () => { const daemon = await daemonFile(); return daemon?.pid === old.pid && daemon; }, 20_000);
  await writeFile(join(configDir, "daemon.json"), JSON.stringify({ ...first, version: "0.0.1" }));

  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const connect = async () => {
    const client = new Client({ name: "upgrade-test", version: "1" });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"], env, stderr: "pipe" }));
    return client;
  };
  const bridges = await Promise.all([connect(), connect()]);
  const daemon = await daemonFile();
  pids.add(daemon.pid);
  assert.notEqual(daemon.pid, old.pid);
  assert.equal(daemon.version, version);
  await waitFor(() => !alive(old.pid), 10_000);
  for (const client of bridges) assert.ok((await client.listTools()).tools.some((tool) => tool.name === "get_workspace"));
  const started = (await readFile(join(configDir, "daemon.log"), "utf8")).split("\n").filter((line) => line.startsWith("apupod: "));
  assert.deepEqual(started, [`apupod: ${daemon.url}`], "the start lock lets only one bridge start the replacement");
});

test("the bridge keeps a busy older daemon and a newer daemon", async (t) => {
  const { spawn } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "apupod-keep-"));
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "mcp-token"), "test-token\n");
  const env = { ...getDefaultEnvironment(), APUPOD_DATA_DIR: join(root, "data"), APUPOD_CONFIG_DIR: configDir, PORT: String(await freePort()) };
  const children = [];
  t.after(async () => {
    for (const child of children) if (alive(child.pid)) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });
  // A stand-in daemon: it answers the probes, prints each request, and fails /mcp so the bridge returns an error.
  const standIn = `const jobs = JSON.parse(process.argv[1]);
require("node:http").createServer((req, res) => {
  console.log(req.method + " " + req.url);
  const body = req.url === "/api/revision" ? { revision: 1 } : req.url === "/api/jobs" ? jobs : null;
  res.writeHead(body ? 200 : 500, { "Content-Type": "application/json" }).end(JSON.stringify(body || {}));
}).listen(0, "127.0.0.1", function () { console.log("port " + this.address().port); });`;
  const cases = [
    { version: "0.0.1", jobs: { activeJobId: "job-1", jobs: [{ id: "job-1", status: "running" }] }, warns: true },
    { version: "99.0.0", jobs: { activeJobId: null, jobs: [] }, warns: false },
  ];
  for (const { version, jobs, warns } of cases) {
    const daemon = spawn(process.execPath, ["-e", standIn, JSON.stringify(jobs)], { stdio: ["ignore", "pipe", "inherit"] });
    children.push(daemon);
    let requests = "";
    daemon.stdout.on("data", (chunk) => { requests += chunk; });
    const port = Number((await waitFor(() => requests.match(/^port (\d+)$/m), 10_000))[1]);
    await writeFile(join(configDir, "daemon.json"), JSON.stringify({ pid: daemon.pid, port, url: `http://127.0.0.1:${port}`, version }));

    const bridge = spawn(process.execPath, [BIN, "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
    children.push(bridge);
    let stderr = "";
    bridge.stderr.on("data", (chunk) => { stderr += chunk; });
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "keep-test", version: "1" } } })}\n`);
    // The bridge forwards to /mcp only after ensureDaemon chose this daemon.
    await waitFor(() => requests.includes("POST /mcp"), 10_000);
    bridge.kill("SIGKILL");
    assert.ok(alive(daemon.pid), `the ${version} daemon is not stopped`);
    await assert.rejects(readFile(join(configDir, "daemon.log")), { code: "ENOENT" }, "no other daemon is started");
    assert.equal(JSON.parse(await readFile(join(configDir, "daemon.json"), "utf8")).pid, daemon.pid);
    if (warns) assert.match(stderr, /daemon 0\.0\.1 is older than \S+; it is busy, the upgrade waits for the next connect\./);
    else assert.ok(!requests.includes("GET /api/jobs"), "a newer daemon gets no idle check");
    daemon.kill("SIGKILL");
  }
});
