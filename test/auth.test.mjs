import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { signInLink, redeemSignInCode } from "../src/system.mjs";
import { startTestServer, silentWav } from "./helpers.mjs";

const stubFetch = async () => Response.json({ data: [] });
const login = (baseUrl, code) => fetch(`${baseUrl}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });

test("API reads, writes, deletes, token rotation, and sign-in links need the bearer token", async (t) => {
  const { baseUrl } = await startTestServer(t, { fetchImpl: stubFetch });
  for (const authorization of [undefined, "Bearer wrong"]) {
    for (const [method, path] of [["GET", "/api/state"], ["PUT", "/api/config"], ["DELETE", "/api/episodes/missing"], ["POST", "/api/system/mcp-token"], ["POST", "/api/sign-in-link"]]) {
      const response = await fetch(baseUrl + path, { method, headers: authorization ? { Authorization: authorization } : {} });
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.equal(response.headers.get("www-authenticate"), 'Bearer realm="apupod"');
      assert.deepEqual(await response.json(), { error: "Sign in to apupod: run `apupod open`, or ask your agent to open the apupod UI." });
    }
  }
});

test("the page, icon, revision and random-ID media URLs stay open without a token", async (t) => {
  const { baseUrl, rootDir, api } = await startTestServer(t, { fetchImpl: stubFetch }, async (rootDir) => {
    await mkdir(join(rootDir, "public"), { recursive: true });
    for (const name of ["index.html", "icon.png"]) await copyFile(new URL(`../public/${name}`, import.meta.url), join(rootDir, "public", name));
  });
  const episodeId = randomUUID();
  const previewId = randomUUID();
  await mkdir(join(rootDir, "data", "episodes", episodeId));
  await writeFile(join(rootDir, "data", "episodes", episodeId, "episode.mp3"), "fake-mp3");
  await mkdir(join(rootDir, "data", "previews"), { recursive: true });
  await writeFile(join(rootDir, "data", "previews", `${previewId}.wav`), silentWav());
  const { album } = (await api("/api/albums", { title: "Open cover" })).value;
  const token = (await readFile(join(rootDir, "mcp-token"), "utf8")).trim();
  const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
  assert.equal((await fetch(`${baseUrl}/api/albums/${album.id}/cover`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/png" }, body: png })).status, 200);
  for (const path of ["/", "/icon.png", "/api/revision", `/artifacts/${episodeId}/episode.mp3`, `/previews/${previewId}.wav`, `/covers/${album.id}`]) assert.equal((await fetch(baseUrl + path)).status, 200, path);
  assert.equal((await fetch(`${baseUrl}/api/revision`, { headers: { Authorization: "Bearer wrong" } })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/albums/${album.id}/cover`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
});

test("sign-in codes exchange once, reject unknown and expired codes, and return only the token", async (t) => {
  const { baseUrl, rootDir, api } = await startTestServer(t, { fetchImpl: stubFetch });
  const issued = await api("/api/sign-in-link", {}, "POST");
  assert.equal(issued.status, 200);
  const url = new URL(issued.value.url);
  assert.equal(url.origin, baseUrl);
  assert.match(url.hash, /^#login=[A-Za-z0-9_-]{43}$/);
  const code = new URLSearchParams(url.hash.slice(1)).get("login");
  const response = await login(baseUrl, code);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { token: (await readFile(join(rootDir, "mcp-token"), "utf8")).trim() });
  for (const invalid of [code, "unknown-code", null, {}, 42]) {
    const rejected = await login(baseUrl, invalid);
    assert.equal(rejected.status, 401);
    assert.deepEqual(await rejected.json(), { error: "This sign-in link is used or expired. Ask for a new one." });
  }
  const expiring = new URL((await api("/api/sign-in-link", {}, "POST")).value.url).hash.slice("#login=".length);
  const future = Date.now() + 10 * 60 * 1000;
  t.mock.method(Date, "now", () => future);
  assert.equal((await login(baseUrl, expiring)).status, 401);
});

test("sign-in links expire at ten minutes, prune expired codes, and keep at most twenty", (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  const context = { signInCodes: new Map(), mcpToken: "fake-persistent-token" };
  const codeFrom = (url) => new URL(url).hash.slice("#login=".length);
  const first = codeFrom(signInLink(context, "http://127.0.0.1:4173", "view=tts&episode=fake"));
  for (let index = 0; index < 20; index += 1) signInLink(context, "http://127.0.0.1:4173");
  assert.equal(context.signInCodes.size, 20);
  assert.equal(context.signInCodes.has(first), false);
  now += 10 * 60 * 1000;
  const fresh = codeFrom(signInLink(context, "http://127.0.0.1:4173"));
  assert.equal(context.signInCodes.size, 1);
  assert.equal(redeemSignInCode(context, fresh), "fake-persistent-token");
  assert.equal(context.signInCodes.size, 0);
});
