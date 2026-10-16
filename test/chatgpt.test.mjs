import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import syncFilesystem from "node:fs";
import filesystem, { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatGptError, createChatGptClient } from "../src/chatgpt.mjs";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
const discovery = {
  issuer: ISSUER, authorization_endpoint: `${ISSUER}/api/accounts/authorize`, token_endpoint: `${ISSUER}/api/accounts/oauth/token`,
  jwks_uri: `${ISSUER}/.well-known/jwks.json`, revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke`,
};
const json = (value, options = {}) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...options.headers }, status: options.status || 200 });
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function pauseSignInWrite(t, stage) {
  const entered = deferred();
  const release = deferred();
  let directory;
  let paused = false;
  let failRestore = false;
  async function pause(path) {
    if (!directory || paused || !path.startsWith(`${directory}/`)) return;
    if (!(await readFile(path, "utf8")).includes('"accessToken":"access-final"')) return;
    paused = true;
    entered.resolve();
    const failure = await release.promise;
    if (failure) throw Object.assign(new Error("Test write failure"), { code: "EIO" });
  }
  const originalRename = filesystem.rename;
  const originalOpen = filesystem.open;
  const renameMock = t.mock.method(filesystem, "rename", async (from, to) => {
    if (paused && failRestore && to === join(directory, "accounts.json")) {
      throw Object.assign(new Error("Test restore failure"), { code: "EIO" });
    }
    if (stage === "rename") await pause(from);
    return originalRename(from, to);
  });
  const openMock = t.mock.method(filesystem, "open", async (path, ...options) => {
    const handle = await originalOpen(path, ...options);
    if ((stage === "file sync" && directory && path.startsWith(`${directory}/.write-`))
      || (stage === "directory sync" && path === directory)) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await pause(stage === "directory sync" ? join(path, "accounts.json") : path);
        return sync();
      };
    }
    if (stage === "commit close" && path === directory) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        const recovery = await stat(join(directory, "sign-in-recovery.json")).catch((error) => { if (error.code !== "ENOENT") throw error; });
        if (!recovery) await pause(join(directory, "accounts.json"));
        return close();
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => {
    release.resolve();
    renameMock.mock.restore();
    openMock.mock.restore();
    syncBuiltinESMExports();
  });
  return { entered: entered.promise, arm: (path) => { directory = path; }, release: (failure) => release.resolve(failure), failRestore: (value = true) => { failRestore = value; } };
}
function jwt(clientId, nonce, seconds, overrides = {}, header = {}) {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid, ...header })).toString("base64url");
  const encodedClaims = Buffer.from(JSON.stringify({ iss: ISSUER, aud: clientId, sub: "subject-a", iat: Math.floor(seconds), exp: Math.floor(seconds) + 3600, nonce,
    email: "same@example.com", ...overrides })).toString("base64url");
  const data = `${encodedHeader}.${encodedClaims}`;
  return `${data}.${sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url")}`;
}
function sse(events, { split = 0, crlf = false, requestId = "req-stream", raw } = {}) {
  const newline = crlf ? "\r\n" : "\n";
  const bytes = Buffer.from(raw ?? events.map((event) => `event: ${event.type}${newline}data: ${JSON.stringify(event)}${newline}${newline}`).join(""));
  return new Response(new ReadableStream({ start(controller) {
    if (split) for (let index = 0; index < bytes.length; index += split) controller.enqueue(bytes.subarray(index, index + split));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { "content-type": "text/event-stream", "x-request-id": requestId } });
}
const completed = (text) => ({ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }] } });

async function harness(t, options = {}) {
  const storageDir = options.storageDir || await mkdtemp(join(tmpdir(), "pod-god-chatgpt-"));
  let time = 1_800_000_000_000;
  const nonces = new Map();
  const requests = [];
  const handlers = {};
  const fetchImpl = async (url, init = {}) => {
    const fields = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : undefined;
    const request = { url, ...init, fields };
    requests.push(request);
    if (url === `${ISSUER}/.well-known/openid-configuration`) return handlers.discovery?.(request) ?? json(discovery);
    if (url === discovery.jwks_uri) return handlers.jwks?.(request) ?? json({ keys: [jwk] });
    if (url === discovery.token_endpoint) {
      if (fields.grant_type === "refresh_token") return handlers.refresh?.(request) ?? json({ access_token: "access-rotated", refresh_token: "refresh-rotated", expires_in: 3600, token_type: "Bearer" });
      const idToken = jwt(fields.client_id, nonces.get(fields.code), time / 1000);
      return handlers.code?.(request, idToken) ?? json({ access_token: `access-${fields.client_id}`, refresh_token: `refresh-${fields.client_id}`, id_token: idToken, expires_in: 3600, token_type: "Bearer", scope: SCOPE });
    }
    if (url === discovery.revocation_endpoint) return handlers.revoke?.(request) ?? new Response(null);
    if (url === `${RESOURCE}/models`) return handlers.models?.(request) ?? json({ models: [{ slug: "model-a", display_name: "Model A", visibility: "list" }] });
    if (url === `${RESOURCE}/responses`) return handlers.respond?.(request) ?? sse([completed("Hello")]);
    throw new Error("Unexpected URL");
  };
  const client = await createChatGptClient({ storageDir, fetchImpl, now: () => time, ...options.clientOptions });
  t.after(async () => { await client.close(); await rm(storageDir, { recursive: true, force: true }); });
  async function start(accountId) {
    const result = await client.signIn(accountId);
    const url = new URL(result.authorizeUrl);
    return { result, url, callback: new URL(url.searchParams.get("redirect_uri")) };
  }
  async function finish(attempt, { clientId = "oaiapp_a", code = randomUUID(), state = attempt.url.searchParams.get("state"), error } = {}) {
    nonces.set(code, attempt.url.searchParams.get("nonce"));
    const url = new URL(attempt.callback);
    url.searchParams.set("state", state);
    if (error) url.searchParams.set("error", error);
    else { url.searchParams.set("code", code); if (clientId !== null) url.searchParams.set("client_id", clientId); }
    return fetch(url);
  }
  async function login(clientId = "oaiapp_a", accountId) {
    const attempt = await start(accountId);
    const response = await finish(attempt, { clientId });
    assert.equal(response.status, 200, await response.text());
    return client.status().activeAccountId;
  }
  return { client, storageDir, handlers, requests, start, finish, login, setTime: (value) => { time = value; }, advance: (value) => { time += value; }, seconds: () => time / 1000, nonces };
}

function rawCallback(attempt, path, host = attempt.callback.host) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: attempt.callback.port, path, headers: { host } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

test("PKCE sign-in uses one stable host and a listening loopback callback", async (t) => {
  const h = await harness(t);
  const attempt = await h.start();
  const params = attempt.url.searchParams;
  assert.equal(attempt.url.origin, ISSUER);
  assert.equal(params.get("client_id"), "dynamic_agent_client");
  assert.equal(params.get("agent_name_hint"), "pod-god");
  assert.equal(params.get("scope"), SCOPE);
  assert.equal(params.get("resource"), RESOURCE);
  assert.equal(params.get("code_challenge_method"), "S256");
  assert.match(params.get("ext_agent_host_id"), /^urn:uuid:/);
  assert.equal(attempt.callback.hostname, "127.0.0.1");
  assert.equal(attempt.callback.pathname, "/auth/callback");
  assert.equal((await fetch(new URL("/wrong-path", attempt.callback))).status, 404);
  const result = await h.finish(attempt);
  assert.equal(result.status, 200);
  const exchange = h.requests.find((item) => item.fields?.grant_type === "authorization_code");
  assert.equal(exchange.fields.client_id, "oaiapp_a");
  assert.equal(exchange.fields.redirect_uri, attempt.callback.href);
  assert.equal(exchange.fields.resource, RESOURCE);
  assert.equal(createHash("sha256").update(exchange.fields.code_verifier).digest("base64url"), params.get("code_challenge"));
  assert.equal(exchange.fields.client_secret, undefined);
  assert.equal(exchange.redirect, "error");
  const id = h.client.status().activeAccountId;
  const returning = await h.start(id);
  assert.equal(returning.url.searchParams.get("client_id"), "oaiapp_a");
  assert.equal(returning.url.searchParams.has("agent_name_hint"), false);
  assert.match(returning.url.searchParams.get("id_token_hint"), /^ey/);
  assert.equal(returning.url.searchParams.get("ext_agent_host_id"), params.get("ext_agent_host_id"));
  assert.notEqual(returning.url.searchParams.get("state"), params.get("state"));
  assert.equal((await h.finish(returning, { clientId: null })).status, 200);
});

test("state mismatch, declined consent, and callback replay never redeem another code", async (t) => {
  const h = await harness(t);
  const bad = await h.start();
  assert.equal((await h.finish(bad, { state: "wrong-state" })).status, 401);
  assert.equal(h.client.status().pending.status, "waiting");
  assert.equal(h.requests.some((item) => item.fields?.grant_type === "authorization_code"), false);
  const denied = await h.start();
  assert.equal((await h.finish(denied, { error: "access_denied" })).status, 401);
  assert.equal(h.client.status().lastSignIn.error.code, "access_denied");
  const replay = await h.start();
  const entered = deferred();
  const release = deferred();
  h.handlers.code = async (request, token) => {
    entered.resolve();
    await release.promise;
    return json({ access_token: "access", refresh_token: "refresh", id_token: token, expires_in: 3600, token_type: "Bearer", scope: SCOPE });
  };
  const first = h.finish(replay);
  await entered.promise;
  assert.equal((await h.finish(replay)).status, 409);
  release.resolve();
  assert.equal((await first).status, 200);
  assert.equal(h.requests.filter((item) => item.fields?.grant_type === "authorization_code").length, 1);
});

test("malformed callback URLs and untrusted Host headers cannot crash or cancel sign-in", async (t) => {
  const h = await harness(t);
  const attempt = await h.start();
  assert.equal(await rawCallback(attempt, "http://["), 400);
  assert.equal(await rawCallback(attempt, "/auth/callback", "attacker.invalid"), 400);
  assert.equal(await rawCallback(attempt, "http://attacker.invalid/auth/callback"), 400);
  assert.equal((await h.finish(attempt, { state: "é".repeat(attempt.url.searchParams.get("state").length) })).status, 401);
  assert.equal(h.client.status().pending.status, "waiting");
  assert.equal((await h.finish(attempt)).status, 200);
});

for (const [name, claims, header, mutate] of [
  ["issuer", { iss: "https://attacker.invalid" }], ["audience", { aud: "oaiapp_wrong" }],
  ["expiry", { exp: 1 }], ["nonce", { nonce: "wrong-nonce" }], ["subject", { sub: "" }],
  ["issued-at", { iat: 9_999_999_999 }], ["not-before", { nbf: 9_999_999_999 }],
  ["authorized party", { aud: ["oaiapp_a", "other"], azp: "other" }], ["algorithm", {}, { alg: "HS256" }],
  ["signature", {}, {}, (value) => `${value.slice(0, -6)}AAAAAA`],
]) test(`ID token with invalid ${name} is rejected`, async (t) => {
  const h = await harness(t);
  const attempt = await h.start();
  h.handlers.code = (request) => {
    let token = jwt(request.fields.client_id, attempt.url.searchParams.get("nonce"), h.seconds(), claims, header);
    if (mutate) token = mutate(token);
    return json({ id_token: token, access_token: "access", refresh_token: "refresh", expires_in: 3600, token_type: "Bearer", scope: SCOPE });
  };
  assert.equal((await h.finish(attempt)).status, 401);
  assert.equal(h.client.status().activeAccountId, null);
  assert.equal(h.client.status().lastSignIn.error.code, "chatgpt_invalid_id_token");
  assert.equal(h.client.status().accounts[0].status, "needs_sign_in");
});

test("untrusted discovery endpoints cannot receive codes or tokens", async (t) => {
  const h = await harness(t);
  h.handlers.discovery = () => json({ ...discovery, jwks_uri: "https://attacker.invalid/jwks" });
  await assert.rejects(h.client.signIn(), { code: "chatgpt_invalid_discovery" });
  assert.equal(h.requests.length, 1);
  assert.equal(h.client.status().pending, null);
});

test("unfamiliar signing keys cause one JWKS reload", async (t) => {
  const h = await harness(t);
  let reads = 0;
  h.handlers.jwks = () => json({ keys: ++reads === 1 ? [{ ...jwk, kid: "old-key" }] : [jwk] });
  await h.login();
  assert.equal(reads, 2);
});

test("registrations are retained after code failure and before identity validation", async (t) => {
  const h = await harness(t);
  h.handlers.code = () => json({ error: "invalid_grant", error_description: "SECRET-code" }, { status: 400 });
  const attempt = await h.start();
  assert.equal((await h.finish(attempt)).status, 400);
  const record = JSON.parse(await readFile(join(h.storageDir, "accounts.json"), "utf8"));
  assert.equal(record.registrations[0].clientId, "oaiapp_a");
  assert.deepEqual(record.accounts, []);
  assert.equal(record.activeAccountId, null);
  const retry = await h.start(record.registrations[0].id);
  assert.equal(retry.url.searchParams.get("client_id"), "oaiapp_a");
  assert.equal(retry.url.searchParams.has("id_token_hint"), false);
  assert.equal(JSON.stringify(h.client.status()).includes("SECRET"), false);
});

test("returning sign-in keeps old credentials if client or identity changes", async (t) => {
  const h = await harness(t);
  const id = await h.login();
  const oldFile = await readFile(join(h.storageDir, "accounts.json"), "utf8");
  const wrongClient = await h.start(id);
  assert.equal((await h.finish(wrongClient, { clientId: "oaiapp_other" })).status, 401);
  const wrongIdentity = await h.start(id);
  h.handlers.code = (request) => json({ access_token: "new-access", refresh_token: "new-refresh", id_token: jwt("oaiapp_a", wrongIdentity.url.searchParams.get("nonce"), h.seconds(), { sub: "other" }), token_type: "Bearer", expires_in: 3600, scope: SCOPE });
  assert.equal((await h.finish(wrongIdentity)).status, 401);
  assert.equal(await readFile(join(h.storageDir, "accounts.json"), "utf8"), oldFile);
});

test("valid identity without a plan grant remains signed in and cannot infer", async (t) => {
  const h = await harness(t);
  h.handlers.code = (request, idToken) => json({ id_token: idToken, scope: "openid profile email" });
  const id = await h.login();
  assert.equal(h.client.status().accounts[0].status, "plan_disabled");
  assert.equal(h.client.status().accounts[0].grant, false);
  await assert.rejects(h.client.models(), { code: "chatgpt_plan_usage_disabled" });
  await assert.rejects(h.client.respond({ model: "model-a", prompt: "Hello" }), { code: "chatgpt_plan_usage_disabled" });
  const retry = await h.start(id);
  assert.equal(retry.url.searchParams.get("prompt"), "consent");
});

test("owner-only atomic storage and public status contain no credential references", async (t) => {
  const h = await harness(t);
  await chmod(h.storageDir, 0o755);
  await h.client.close();
  const reopened = await createChatGptClient({ storageDir: h.storageDir, fetchImpl: async () => { throw new Error("No network"); } });
  assert.equal((await stat(h.storageDir)).mode & 0o777, 0o700);
  await reopened.close();
  const active = await createChatGptClient({ storageDir: h.storageDir, fetchImpl: async () => { throw new Error("No network"); } });
  await active.close();
  assert.equal((await stat(join(h.storageDir, "accounts.json"))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(h.storageDir), ["accounts.json"]);
  const h2 = await harness(t);
  await h2.login();
  const publicState = h2.client.status();
  const printed = JSON.stringify(publicState);
  assert.equal(printed.includes("access-oaiapp_a"), false);
  assert.equal(printed.includes("refresh-oaiapp_a"), false);
  assert.equal(printed.includes("eyJ"), false);
  assert.equal(printed.includes("subject-a"), false);
  publicState.accounts[0].label = "changed";
  publicState.lastSignIn.status = "changed";
  assert.notEqual(h2.client.status().accounts[0].label, "changed");
  assert.equal(h2.client.status().lastSignIn.status, "complete");
});

test("storage excludes simultaneous owners, recovers dead owners, and rejects symlinks", async (t) => {
  const h = await harness(t);
  await assert.rejects(createChatGptClient({ storageDir: h.storageDir }), { code: "chatgpt_storage_in_use" });
  await h.client.close();
  await writeFile(join(h.storageDir, "lock.json"), JSON.stringify({ pid: 2_147_483_647 }), { mode: 0o600 });
  const recovered = await createChatGptClient({ storageDir: h.storageDir });
  await recovered.close();
  const target = join(h.storageDir, "target.json");
  await writeFile(target, "do not change");
  await rm(join(h.storageDir, "accounts.json"));
  await symlink(target, join(h.storageDir, "accounts.json"));
  await assert.rejects(createChatGptClient({ storageDir: h.storageDir }), { code: "chatgpt_storage_unavailable" });
  assert.equal(await readFile(target, "utf8"), "do not change");
});

test("multiple same-email accounts keep separate identities and stable labels", async (t) => {
  const h = await harness(t);
  const first = await h.login();
  const second = await h.login("oaiapp_b");
  assert.notEqual(first, second);
  assert.equal(h.client.status().accounts.length, 2);
  assert.notEqual(h.client.status().accounts[0].label, h.client.status().accounts[1].label);
  await h.client.select(first);
  assert.equal(h.client.status().activeAccountId, first);
  await assert.rejects(h.client.models(second), { code: "chatgpt_account_changed" });
  assert.equal((await h.client.models(first))[0].slug, "model-a");
  assert.equal(h.requests.at(-1).headers.authorization, "Bearer access-oaiapp_a");
});

test("refresh is singleflight, rotates atomically, and omits scopes", async (t) => {
  const h = await harness(t);
  await h.login();
  h.advance(3_550_000);
  const entered = deferred();
  const release = deferred();
  h.handlers.refresh = async () => { entered.resolve(); await release.promise; return json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600, token_type: "Bearer" }); };
  const first = h.client.models();
  await entered.promise;
  const second = h.client.models();
  release.resolve();
  await Promise.all([first, second]);
  const calls = h.requests.filter((item) => item.fields?.grant_type === "refresh_token");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].fields, { grant_type: "refresh_token", client_id: "oaiapp_a", refresh_token: "refresh-oaiapp_a", resource: RESOURCE });
  const record = JSON.parse(await readFile(join(h.storageDir, "accounts.json"), "utf8"));
  assert.equal(record.accounts[0].tokens.accessToken, "rotated-access");
  assert.equal(record.accounts[0].tokens.refreshToken, "rotated-refresh");
  assert.equal(record.accounts[0].tokens.scopes.includes("chatgpt.tokens.use.direct"), true);
});

test("temporary refresh failures preserve credentials and terminal refresh failures clear only tokens", async (t) => {
  const h = await harness(t);
  await h.login();
  h.advance(3_550_000);
  const original = await readFile(join(h.storageDir, "accounts.json"), "utf8");
  h.handlers.refresh = () => json({ error: "temporarily_unavailable", error_description: "refresh-oaiapp_a" }, { status: 503, headers: { "x-request-id": "req-refresh" } });
  await assert.rejects(h.client.models(), { code: "temporarily_unavailable", requestId: "req-refresh" });
  assert.equal(await readFile(join(h.storageDir, "accounts.json"), "utf8"), original);
  h.handlers.refresh = () => json({ error: "invalid_grant" }, { status: 400 });
  await assert.rejects(h.client.models(), { code: "invalid_grant" });
  const record = JSON.parse(await readFile(join(h.storageDir, "accounts.json"), "utf8"));
  assert.equal(record.registrations[0].clientId, "oaiapp_a");
  assert.equal(record.accounts[0].subject, "subject-a");
  assert.equal(record.accounts[0].tokens, null);
});

test("account switch during refresh cannot infer or replace the new selection", async (t) => {
  const h = await harness(t);
  const first = await h.login();
  const second = await h.login("oaiapp_b");
  await h.client.select(first);
  h.advance(3_550_000);
  const entered = deferred();
  const release = deferred();
  h.handlers.refresh = async () => { entered.resolve(); await release.promise; return json({ access_token: "new-a", refresh_token: "refresh-a-new", token_type: "Bearer", expires_in: 3600 }); };
  const generation = h.client.respond({ accountId: first, model: "model-a", prompt: "Hello" });
  const rejected = assert.rejects(generation, { code: "chatgpt_account_changed" });
  await entered.promise;
  await h.client.select(second);
  release.resolve();
  await rejected;
  assert.equal(h.client.status().activeAccountId, second);
  assert.equal(h.requests.some((item) => item.url.endsWith("/responses")), false);
  const record = JSON.parse(await readFile(join(h.storageDir, "accounts.json"), "utf8"));
  assert.equal(record.accounts.find((item) => item.id === first).tokens.accessToken, "new-a");
  assert.equal(record.accounts.find((item) => item.id === second).tokens.accessToken, "access-oaiapp_b");
});

test("requests cannot dispatch against the old account during a selection write", async (t) => {
  const h = await harness(t);
  const first = await h.login();
  const second = await h.login("oaiapp_b");
  await h.client.select(first);
  const changing = h.client.select(second);
  await assert.rejects(h.client.respond({ accountId: first, model: "model-a", prompt: "Hello" }), { code: "chatgpt_account_changed" });
  await changing;
  assert.equal(h.client.status().activeAccountId, second);
  assert.equal(h.requests.some((item) => item.url.endsWith("/responses")), false);
});

test("sign-out waits for refresh, revokes the latest rotation, and cannot resurrect tokens", async (t) => {
  const h = await harness(t);
  const id = await h.login();
  h.advance(3_550_000);
  const entered = deferred();
  const release = deferred();
  h.handlers.refresh = async () => { entered.resolve(); await release.promise; return json({ access_token: "new-access", refresh_token: "new-refresh", token_type: "Bearer", expires_in: 3600 }); };
  const models = h.client.models();
  const rejected = assert.rejects(models, { code: "chatgpt_account_changed" });
  await entered.promise;
  const signOut = h.client.signOut(id);
  release.resolve();
  const result = await signOut;
  await rejected;
  assert.equal(result.revoked, true);
  assert.deepEqual(h.requests.find((item) => item.url === discovery.revocation_endpoint).fields, { token: "new-refresh", token_type_hint: "refresh_token", client_id: "oaiapp_a" });
  const record = JSON.parse(await readFile(join(h.storageDir, "accounts.json"), "utf8"));
  assert.equal(record.accounts[0].tokens, null);
  assert.equal(record.activeAccountId, null);
  const attempt = await h.start(id);
  assert.equal(attempt.url.searchParams.get("client_id"), "oaiapp_a");
  assert.equal(attempt.url.searchParams.has("id_token_hint"), false);
});

test("unconfirmed remote revocation clears local tokens with a warning", async (t) => {
  const h = await harness(t);
  const id = await h.login();
  h.handlers.revoke = () => new Response(null, { status: 503 });
  const result = await h.client.signOut(id);
  assert.equal(result.revoked, false);
  assert.match(result.warning, /not confirmed/);
  assert.equal(result.accounts[0].status, "needs_sign_in");
  assert.equal(h.requests.filter((item) => item.url === discovery.revocation_endpoint).length, 2);
});

test("account changes cancel pending sign-in and an in-flight stream", async (t) => {
  const h = await harness(t);
  const first = await h.login();
  const second = await h.login("oaiapp_b");
  const attempt = await h.start();
  await h.client.select(first);
  await assert.rejects(h.finish(attempt));
  assert.equal(h.client.status().pending, null);
  assert.equal(h.client.status().lastSignIn.status, "cancelled");
  const entered = deferred();
  let cancelled = false;
  h.handlers.respond = () => new Response(new ReadableStream({ start() { entered.resolve(); }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
  const generation = h.client.respond({ model: "model-a", prompt: "Hello", accountId: first });
  const rejected = assert.rejects(generation, { code: "chatgpt_account_changed" });
  await entered.promise;
  await h.client.select(second);
  await rejected;
  assert.equal(cancelled, true);
});

test("explicit cancel during code exchange cannot replace existing credentials", async (t) => {
  const h = await harness(t);
  const id = await h.login();
  const original = await readFile(join(h.storageDir, "accounts.json"), "utf8");
  const attempt = await h.start(id);
  const entered = deferred();
  const release = deferred();
  h.handlers.code = async (req, idToken) => {
    entered.resolve();
    await release.promise;
    return json({ access_token: "new-access", refresh_token: "new-refresh", id_token: idToken, expires_in: 3600, token_type: "Bearer", scope: SCOPE });
  };
  const callback = h.finish(attempt);
  await entered.promise;
  assert.equal(h.client.cancel().pending, null);
  assert.equal(h.client.cancelSignIn().lastSignIn.status, "cancelled");
  release.resolve();
  assert.equal((await callback).status, 409);
  assert.equal(await readFile(join(h.storageDir, "accounts.json"), "utf8"), original);
  assert.equal(h.client.status().lastSignIn.status, "cancelled");
});

for (const stage of ["file sync", "rename", "directory sync"]) {
  test(`cancel during final sign-in ${stage} cannot replace credentials or select a new account`, async (t) => {
    const gate = pauseSignInWrite(t, stage);
    const h = await harness(t);
    const id = await h.login();
    const attempt = await h.start();
    h.handlers.code = (request, idToken) => json({ access_token: "access-final", refresh_token: "refresh-final", id_token: idToken, expires_in: 3600, token_type: "Bearer", scope: SCOPE });
    gate.arm(h.storageDir);
    const callback = h.finish(attempt, { clientId: "oaiapp_b" });
    await gate.entered;
    assert.equal(h.client.status().activeAccountId, id);
    const cancelled = h.client.cancel();
    assert.equal(cancelled.pending, null);
    assert.equal(cancelled.lastSignIn.status, "cancelled");
    assert.equal(cancelled.accounts.find((item) => item.id === cancelled.lastSignIn.accountId).status, "needs_sign_in");
    gate.release();
    assert.equal((await callback).status, 409);
    const record = JSON.parse(await readFile(join(h.storageDir, "accounts.json"), "utf8"));
    assert.equal(record.activeAccountId, id);
    assert.equal(record.accounts.length, 1);
    assert.equal(record.accounts[0].tokens.accessToken, "access-oaiapp_a");
    assert.equal(h.client.status().activeAccountId, id);
    assert.equal(h.client.status().lastSignIn.status, "cancelled");
    assert.equal((await readdir(h.storageDir)).some((name) => name.startsWith(".write-")), false);
  });
}

test("cancelled sign-in restores before queued selection, sign-out, and refresh writes", async (t) => {
  const gate = pauseSignInWrite(t, "directory sync");
  const h = await harness(t);
  const first = await h.login();
  const second = await h.login("oaiapp_b");
  await h.client.select(first);
  h.advance(3_550_000);
  const refreshEntered = deferred();
  const refreshRelease = deferred();
  h.handlers.refresh = async () => {
    refreshEntered.resolve();
    await refreshRelease.promise;
    return json({ access_token: "access-rotated", refresh_token: "refresh-rotated", expires_in: 3600, token_type: "Bearer" });
  };
  const refreshed = assert.rejects(h.client.models(first), { code: "chatgpt_account_changed" });
  await refreshEntered.promise;
  const attempt = await h.start(second);
  h.handlers.code = (request, idToken) => json({ access_token: "access-final", refresh_token: "refresh-final", id_token: idToken, expires_in: 3600, token_type: "Bearer", scope: SCOPE });
  gate.arm(h.storageDir);
  const callback = h.finish(attempt, { clientId: "oaiapp_b" });
  await gate.entered;
  const selecting = h.client.select(second);
  const signingOut = h.client.signOut(second);
  refreshRelease.resolve();
  gate.release();
  assert.equal((await callback).status, 409);
  await Promise.all([selecting, signingOut, refreshed]);
  const record = JSON.parse(await readFile(join(h.storageDir, "accounts.json"), "utf8"));
  assert.equal(record.activeAccountId, null);
  assert.equal(record.accounts.find((item) => item.id === first).tokens.refreshToken, "refresh-rotated");
  assert.equal(record.accounts.find((item) => item.id === second).tokens, null);
  assert.equal(h.client.status().lastSignIn.status, "cancelled");
});

test("callback timeout during final sign-in write cannot persist new tokens", async (t) => {
  const gate = pauseSignInWrite(t, "rename");
  const h = await harness(t, { clientOptions: { callbackTimeoutMs: 1000 } });
  const id = await h.login();
  const original = await readFile(join(h.storageDir, "accounts.json"), "utf8");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const attempt = await h.start(id);
  h.handlers.code = (request, idToken) => json({ access_token: "access-final", refresh_token: "refresh-final", id_token: idToken, expires_in: 3600, token_type: "Bearer", scope: SCOPE });
  gate.arm(h.storageDir);
  const callback = h.finish(attempt);
  await gate.entered;
  t.mock.timers.tick(1000);
  assert.equal(h.client.status().lastSignIn.error.code, "chatgpt_sign_in_timeout");
  gate.release();
  assert.equal((await callback).status, 409);
  assert.equal(await readFile(join(h.storageDir, "accounts.json"), "utf8"), original);
  assert.equal(h.client.status().lastSignIn.error.code, "chatgpt_sign_in_timeout");
  t.mock.timers.reset();
});

test("shutdown during final sign-in write restores credentials before releasing storage", async (t) => {
  const gate = pauseSignInWrite(t, "directory sync");
  const h = await harness(t);
  const id = await h.login();
  const original = await readFile(join(h.storageDir, "accounts.json"), "utf8");
  const attempt = await h.start(id);
  h.handlers.code = (request, idToken) => json({ access_token: "access-final", refresh_token: "refresh-final", id_token: idToken, expires_in: 3600, token_type: "Bearer", scope: SCOPE });
  gate.arm(h.storageDir);
  const callback = h.finish(attempt);
  await gate.entered;
  const closing = h.client.close();
  assert.equal(h.client.status().lastSignIn.status, "cancelled");
  gate.release();
  assert.equal((await callback).status, 503);
  await closing;
  assert.equal(await readFile(join(h.storageDir, "accounts.json"), "utf8"), original);
  assert.equal((await readdir(h.storageDir)).includes("lock.json"), false);
});

test("final sign-in write failure preserves old credentials and does not report success", async (t) => {
  const gate = pauseSignInWrite(t, "directory sync");
  const h = await harness(t);
  const id = await h.login();
  const original = await readFile(join(h.storageDir, "accounts.json"), "utf8");
  const attempt = await h.start(id);
  h.handlers.code = (request, idToken) => json({ access_token: "access-final", refresh_token: "refresh-final", id_token: idToken, expires_in: 3600, token_type: "Bearer", scope: SCOPE });
  gate.arm(h.storageDir);
  const callback = h.finish(attempt);
  await gate.entered;
  gate.release(true);
  assert.equal((await callback).status, 500);
  assert.equal(await readFile(join(h.storageDir, "accounts.json"), "utf8"), original);
  assert.equal(h.client.status().activeAccountId, id);
  assert.equal(h.client.status().lastSignIn.error.code, "chatgpt_storage_unavailable");
});

test("cancelled sign-in with failed restore is not trusted after restart", async (t) => {
  const gate = pauseSignInWrite(t, "directory sync");
  const h = await harness(t);
  const id = await h.login();
  const attempt = await h.start();
  h.handlers.code = (request, idToken) => json({ access_token: "access-final", refresh_token: "refresh-final", id_token: idToken, expires_in: 3600, token_type: "Bearer", scope: SCOPE });
  gate.arm(h.storageDir);
  const callback = h.finish(attempt, { clientId: "oaiapp_b" });
  await gate.entered;
  h.client.cancel();
  gate.failRestore();
  gate.release();
  assert.equal((await callback).status, 500);
  assert.equal(h.client.status().lastSignIn.status, "cancelled");
  assert.equal(h.client.status().activeAccountId, id);
  assert.equal(h.client.status().lastSignIn.error.code, "chatgpt_storage_unavailable");
  assert.equal((await stat(join(h.storageDir, "sign-in-recovery.json"))).mode & 0o777, 0o600);
  await h.client.close();
  const options = { storageDir: h.storageDir, fetchImpl: async () => { throw new Error("No network"); } };
  await assert.rejects(createChatGptClient(options), { code: "chatgpt_storage_unavailable" });
  gate.failRestore(false);
  const reopened = await createChatGptClient(options);
  try {
    assert.equal(reopened.status().activeAccountId, id);
    assert.equal(reopened.status().accounts.find((item) => item.id !== id).status, "needs_sign_in");
    const record = JSON.parse(await readFile(join(h.storageDir, "accounts.json"), "utf8"));
    assert.equal(record.accounts.length, 1);
    assert.equal(record.accounts[0].tokens.accessToken, "access-oaiapp_a");
  } finally { await reopened.close(); }
});

test("later account writes recover a cancelled sign-in before changing saved state", async (t) => {
  const gate = pauseSignInWrite(t, "directory sync");
  const h = await harness(t);
  const first = await h.login();
  const second = await h.login("oaiapp_b");
  const attempt = await h.start();
  h.handlers.code = (request, idToken) => json({ access_token: "access-final", refresh_token: "refresh-final", id_token: idToken, expires_in: 3600, token_type: "Bearer", scope: SCOPE });
  gate.arm(h.storageDir);
  const callback = h.finish(attempt, { clientId: "oaiapp_c" });
  await gate.entered;
  h.client.cancel();
  gate.failRestore();
  gate.release();
  assert.equal((await callback).status, 500);
  gate.failRestore(false);
  await h.client.select(first);
  await h.client.signOut(second);
  h.advance(3_550_000);
  await h.client.models(first);
  assert.equal((await readdir(h.storageDir)).includes("sign-in-recovery.json"), false);
  await h.client.close();
  const reopened = await createChatGptClient({ storageDir: h.storageDir, fetchImpl: async () => { throw new Error("No network"); } });
  try {
    assert.equal(reopened.status().activeAccountId, first);
    const record = JSON.parse(await readFile(join(h.storageDir, "accounts.json"), "utf8"));
    assert.equal(record.accounts.find((item) => item.id === first).tokens.refreshToken, "refresh-rotated");
    assert.equal(record.accounts.find((item) => item.id === second).tokens, null);
    assert.equal(record.accounts.length, 2);
  } finally { await reopened.close(); }
});

test("cancel after the marker-removal boundary reports complete during final cleanup", async (t) => {
  const gate = pauseSignInWrite(t, "commit close");
  const h = await harness(t);
  await h.login();
  const attempt = await h.start();
  h.handlers.code = (request, idToken) => json({ access_token: "access-final", refresh_token: "refresh-final", id_token: idToken, expires_in: 3600, token_type: "Bearer", scope: SCOPE });
  gate.arm(h.storageDir);
  const callback = h.finish(attempt, { clientId: "oaiapp_b" });
  await gate.entered;
  const result = h.client.cancel();
  assert.equal(result.pending, null);
  assert.equal(result.lastSignIn.status, "complete");
  assert.equal(result.activeAccountId, result.lastSignIn.accountId);
  assert.equal(result.accounts.find((item) => item.active).status, "connected");
  gate.release();
  assert.equal((await callback).status, 200);
});

test("marker-removal failure restores old credentials and reports storage failure", async (t) => {
  const h = await harness(t);
  const id = await h.login();
  const original = await readFile(join(h.storageDir, "accounts.json"), "utf8");
  const unlinkMock = t.mock.method(syncFilesystem, "unlinkSync", () => { throw Object.assign(new Error("Test marker removal failure"), { code: "EIO" }); });
  syncBuiltinESMExports();
  t.after(() => { unlinkMock.mock.restore(); syncBuiltinESMExports(); });
  const attempt = await h.start(id);
  h.handlers.code = (request, idToken) => json({ access_token: "access-final", refresh_token: "refresh-final", id_token: idToken, expires_in: 3600, token_type: "Bearer", scope: SCOPE });
  assert.equal((await h.finish(attempt)).status, 500);
  assert.equal(await readFile(join(h.storageDir, "accounts.json"), "utf8"), original);
  assert.equal(h.client.status().lastSignIn.error.code, "chatgpt_storage_unavailable");
  assert.equal(h.client.status().lastSignIn.status, "error");
  assert.equal(h.client.status().activeAccountId, id);
  assert.equal((await readdir(h.storageDir)).includes("sign-in-recovery.json"), false);
});

test("post-boundary directory-sync failure reports truthful committed state", async (t) => {
  const h = await harness(t);
  const id = await h.login();
  const syncMock = t.mock.method(syncFilesystem, "fsyncSync", () => { throw Object.assign(new Error("Test final directory sync failure"), { code: "EIO" }); });
  syncBuiltinESMExports();
  t.after(() => { syncMock.mock.restore(); syncBuiltinESMExports(); });
  const attempt = await h.start(id);
  h.handlers.code = (request, idToken) => json({ access_token: "access-final", refresh_token: "refresh-final", id_token: idToken, expires_in: 3600, token_type: "Bearer", scope: SCOPE });
  assert.equal((await h.finish(attempt)).status, 500);
  const result = h.client.cancel();
  assert.equal(result.lastSignIn.status, "complete");
  assert.equal(result.lastSignIn.error.code, "chatgpt_storage_unavailable");
  assert.equal(result.activeAccountId, id);
  assert.equal((await readdir(h.storageDir)).includes("sign-in-recovery.json"), false);
  await h.client.close();
  const reopened = await createChatGptClient({ storageDir: h.storageDir, fetchImpl: async () => { throw new Error("No network"); } });
  try {
    assert.equal(reopened.status().activeAccountId, id);
    assert.equal(reopened.status().accounts.find((item) => item.active).status, "connected");
    const record = JSON.parse(await readFile(join(h.storageDir, "accounts.json"), "utf8"));
    assert.equal(record.accounts[0].tokens.accessToken, "access-final");
  } finally { await reopened.close(); }
});

test("cancel after a successful sign-in commit reports complete", async (t) => {
  const h = await harness(t);
  const id = await h.login();
  const result = h.client.cancel();
  assert.equal(result.lastSignIn.status, "complete");
  assert.equal(result.activeAccountId, id);
});

test("shutdown saves an already successful refresh before releasing storage", async (t) => {
  const h = await harness(t);
  await h.login();
  h.advance(3_550_000);
  const entered = deferred();
  const release = deferred();
  h.handlers.refresh = async () => {
    entered.resolve();
    await release.promise;
    return json({ access_token: "closing-access", refresh_token: "closing-refresh", expires_in: 3600, token_type: "Bearer" });
  };
  const models = h.client.models();
  const rejected = assert.rejects(models, { code: "chatgpt_closed" });
  await entered.promise;
  const closing = h.client.close();
  release.resolve();
  await closing;
  await rejected;
  const record = JSON.parse(await readFile(join(h.storageDir, "accounts.json"), "utf8"));
  assert.equal(record.accounts[0].tokens.refreshToken, "closing-refresh");
  assert.equal((await readdir(h.storageDir)).includes("lock.json"), false);
});

test("model catalog uses the account token and filters visibility without reordering", async (t) => {
  const h = await harness(t);
  await h.login();
  h.handlers.models = () => json({ models: [
    { slug: "z", display_name: "Z", visibility: "list" }, { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
    { slug: "a", display_name: "A", visibility: "list" }, { id: "paid-api-shape" },
  ] });
  assert.deepEqual(await h.client.models(), [{ slug: "z", display_name: "Z", visibility: "list" }, { slug: "a", display_name: "A", visibility: "list" }]);
  assert.equal(h.requests.at(-1).url, `${RESOURCE}/models`);
  h.handlers.models = () => json({ data: [{ id: "wrong-catalog" }] });
  await assert.rejects(h.client.models(), { code: "chatgpt_invalid_model_catalog" });
});

test("Responses payload has only supported fields and accepts split UTF-8/CRLF frames", async (t) => {
  const h = await harness(t);
  await h.login();
  h.handlers.respond = () => sse([{ type: "response.output_text.delta", delta: "Héllo 🌎" }, completed("Héllo 🌎")], { split: 1, crlf: true });
  const result = await h.client.respond({ model: "model-a", system: "System instructions", prompt: "User input", effort: "xhigh", maxTokens: 100, temperature: 0.5 });
  assert.deepEqual(result, { choices: [{ message: { content: "Héllo 🌎" } }] });
  assert.deepEqual(JSON.parse(h.requests.at(-1).body), { model: "model-a", input: [{ role: "user", content: "User input" }], store: false, stream: true, instructions: "System instructions", reasoning: { effort: "xhigh" } });
  assert.equal(h.requests.at(-1).headers.authorization, "Bearer access-oaiapp_a");
  assert.equal(h.requests.at(-1).url, `${RESOURCE}/responses`);
});

test("late usage failures retain exact code/request ID but never return partial text", async (t) => {
  const h = await harness(t);
  await h.login();
  h.handlers.respond = () => sse([{ type: "response.output_text.delta", delta: "partial-secret-text" }, { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", param: "model", message: "access-oaiapp_a" } } }]);
  await assert.rejects(h.client.respond({ model: "model-a", prompt: "Hello" }), (error) => {
    assert.equal(error.code, "subscription_sharing_usage_limit_exceeded");
    assert.equal(error.requestId, "req-stream");
    assert.equal(error.param, "model");
    assert.equal(JSON.stringify(error).includes("access-oaiapp_a"), false);
    assert.equal(error.message.includes("partial-secret-text"), false);
    return true;
  });
  assert.equal(h.client.status().accounts[0].status, "connected");
});

for (const [name, events, code] of [
  ["incomplete", [{ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }], "max_output_tokens"],
  ["interrupted", [{ type: "response.output_text.delta", delta: "partial" }], "chatgpt_stream_interrupted"],
  ["explicit error", [{ type: "error", code: "subscription_sharing_usage_unavailable" }], "subscription_sharing_usage_unavailable"],
  ["done without completion", [], "chatgpt_stream_interrupted"],
]) test(`${name} stream does not count as completed inference`, async (t) => {
  const h = await harness(t);
  await h.login();
  h.handlers.respond = () => sse(events, name === "done without completion" ? { raw: "data: [DONE]\n\n" } : {});
  await assert.rejects(h.client.respond({ model: "model-a", prompt: "Hello" }), { code, requestId: "req-stream" });
});

test("stream byte limits and invalid frames fail without partial output", async (t) => {
  const h = await harness(t, { clientOptions: { maxStreamBytes: 50 } });
  await h.login();
  h.handlers.respond = () => sse([completed("x".repeat(100))]);
  await assert.rejects(h.client.respond({ model: "model-a", prompt: "Hello" }), { code: "chatgpt_response_too_large" });
  h.handlers.respond = () => sse([], { raw: "data: NOT JSON\n\n" });
  await assert.rejects(h.client.respond({ model: "model-a", prompt: "Hello" }), { code: "chatgpt_invalid_stream" });
});

test("admission and eligibility errors preserve safe diagnostics and never change billing", async (t) => {
  const h = await harness(t);
  await h.login();
  h.handlers.respond = () => json({ detail: "access-oaiapp_a should not leak" }, { status: 503, headers: { "openai-request-id": "req-admission" } });
  await assert.rejects(h.client.respond({ model: "model-a", prompt: "Hello" }), { code: "chatgpt_responses_failed", status: 503, bodyShape: "detail", requestId: "req-admission" });
  h.handlers.respond = () => json({ error: { code: "subscription_sharing_user_not_eligible", param: "model", message: "private diagnosis" } }, { status: 403 });
  await assert.rejects(h.client.respond({ model: "model-a", prompt: "Hello" }), { code: "subscription_sharing_user_not_eligible", status: 403, param: "model" });
  assert.equal(h.client.status().accounts[0].status, "connected");
  assert.equal(h.requests.filter((item) => item.url.endsWith("/responses")).length, 2);
  assert.equal(h.requests.every((item) => item.url.startsWith(ISSUER) || item.url.startsWith(RESOURCE)), true);
});

test("shutdown is idempotent, closes callback listener, and prevents future network use", async (t) => {
  const h = await harness(t);
  const attempt = await h.start();
  await h.client.close();
  await h.client.close();
  await assert.rejects(h.finish(attempt));
  await assert.rejects(h.client.signIn(), { code: "chatgpt_closed" });
  assert.equal(h.client.status().pending, null);
  assert.equal((await readdir(h.storageDir)).includes("lock.json"), false);
  assert.equal(ChatGptError.prototype instanceof Error, true);
});
