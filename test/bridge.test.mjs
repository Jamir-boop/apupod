import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
