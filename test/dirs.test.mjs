import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPodcastServer, loadEnvFile, resolveDirs } from "../src/app.mjs";
import { JEV_MODEL } from "../src/jev.mjs";
import { createApi, withEnv } from "./helpers.mjs";

async function tempDir(t, name) {
  const dir = await mkdtemp(join(tmpdir(), `apupod-${name}-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function startServer(t, options) {
  const server = await createPodcastServer({ fetchImpl: async () => Response.json({ data: [] }), ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return createApi(`http://127.0.0.1:${server.address().port}`);
}

test("resolveDirs prefers APUPOD_* dirs, then XDG dirs, then the home fallbacks", () => {
  assert.deepEqual(resolveDirs({ APUPOD_DATA_DIR: "/d", APUPOD_CONFIG_DIR: "/c", XDG_DATA_HOME: "/xd", XDG_CONFIG_HOME: "/xc" }), { dataDir: "/d", configDir: "/c" });
  assert.deepEqual(resolveDirs({ XDG_DATA_HOME: "/xd", XDG_CONFIG_HOME: "/xc" }), { dataDir: "/xd/apupod", configDir: "/xc/apupod" });
  assert.deepEqual(resolveDirs({}), { dataDir: join(homedir(), ".local", "share", "apupod"), configDir: join(homedir(), ".config", "apupod") });
  assert.deepEqual(resolveDirs({ APUPOD_DATA_DIR: "", XDG_DATA_HOME: "" }).dataDir, join(homedir(), ".local", "share", "apupod"));
});

test("loadEnvFile sets only missing variables and ignores a missing file", async (t) => {
  const dir = await tempDir(t, "env");
  withEnv(t, { APUPOD_PROBE_FILE: null, APUPOD_PROBE_PROCESS: "from-process" });
  await writeFile(join(dir, ".env"), "APUPOD_PROBE_FILE=from-file\nAPUPOD_PROBE_PROCESS=from-file\n");
  await loadEnvFile(join(dir, ".env"));
  assert.equal(process.env.APUPOD_PROBE_FILE, "from-file");
  assert.equal(process.env.APUPOD_PROBE_PROCESS, "from-process");
  await loadEnvFile(join(dir, "missing.env"));
});

test("the server keeps data and config in separate dirs and loads the config-dir .env at startup", async (t) => {
  const dataDir = await tempDir(t, "data");
  const configParent = await tempDir(t, "config");
  const configDir = join(configParent, "apupod");
  withEnv(t, { APUPOD_PROBE_FILE: null, APUPOD_PROBE_PROCESS: "from-process", TYPESAFE_API_KEY: null });
  const api = await startServer(t, { dataDir, configDir });
  assert.equal((await stat(configDir)).mode & 0o777, 0o700);
  await stat(join(configDir, "config.json"));
  await stat(join(dataDir, "profiles.json"));
  await assert.rejects(stat(join(dataDir, "config.json")), { code: "ENOENT" });
  assert.equal((await api("/api/state")).status, 200);

  // A restart reads the .env that sits in the config dir; the process environment wins.
  await writeFile(join(configDir, ".env"), "APUPOD_PROBE_FILE=from-file\nAPUPOD_PROBE_PROCESS=from-file\n", { mode: 0o600 });
  await startServer(t, { dataDir, configDir });
  assert.equal(process.env.APUPOD_PROBE_FILE, "from-file");
  assert.equal(process.env.APUPOD_PROBE_PROCESS, "from-process");
});

test("the TypeSafe key saves to the config-dir .env, clears, and never returns; the Jev model stays pinned", async (t) => {
  const dataDir = await tempDir(t, "data");
  const configDir = await tempDir(t, "config");
  withEnv(t, { TYPESAFE_API_KEY: null });
  const api = await startServer(t, { dataDir, configDir });
  const { config } = (await api("/api/state")).value;
  let response = await api("/api/config", { ...config, assistantDecision: { enabled: true, model: "other-model", apiKey: "ts-secret-key" } }, "PUT");
  assert.equal(response.status, 200, response.value.error);
  assert.deepEqual(response.value.config.assistantDecision, { enabled: true, model: JEV_MODEL, hasApiKey: true });
  assert.doesNotMatch(JSON.stringify(response.value), /ts-secret-key/);
  assert.match(await readFile(join(configDir, ".env"), "utf8"), /^TYPESAFE_API_KEY=/m);
  assert.equal((await stat(join(configDir, ".env"))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(join(configDir, "config.json"), "utf8")).assistantDecision.model, JEV_MODEL);

  response = await api("/api/config", { ...response.value.config, assistantDecision: { clearApiKey: true } }, "PUT");
  assert.equal(response.status, 200, response.value.error);
  assert.equal(response.value.config.assistantDecision.hasApiKey, false);
  assert.doesNotMatch(await readFile(join(configDir, ".env"), "utf8"), /TYPESAFE_API_KEY/);
});
