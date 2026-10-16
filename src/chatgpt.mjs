import { constants, fsyncSync, unlinkSync } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from "node:crypto";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { openAiClient } from "./providers/transport.mjs";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const TERMINAL_REFRESH = new Set([
  "invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
  "refresh_token_invalidated", "refresh_token_reused",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeField = (value, limit = 160) => typeof value === "string" && value.length <= limit
  && /^[A-Za-z0-9_.:/\[\]-]+$/.test(value) ? value : undefined;

export class ChatGptError extends Error {
  constructor(code, { status = 400, requestId, param, bodyShape } = {}) {
    super(`ChatGPT: ${code}.`);
    this.name = "ChatGptError";
    this.code = code;
    this.status = status;
    if (requestId) this.requestId = requestId;
    if (param) this.param = param;
    if (bodyShape) this.bodyShape = bodyShape;
  }
}

function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function officialUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin === ISSUER && !url.username && !url.password && !url.hash) return url.href;
  } catch {}
  throw new ChatGptError("chatgpt_invalid_discovery", { status: 502 });
}

function profileText(value) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 256) : "";
}

async function protectedFile(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid())) throw new Error("unsafe file");
    await handle.chmod(0o600);
    return { text: await handle.readFile("utf8"), info };
  } finally {
    await handle.close();
  }
}

async function atomicJson(directory, path, data, check) {
  const temporary = join(directory, `.write-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(data)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    check?.();
    await rename(temporary, path);
    const dir = await open(directory, "r");
    try { await dir.sync(); } finally { await dir.close(); }
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

async function lockStorage(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) {
    throw new Error("unsafe directory");
  }
  await chmod(directory, 0o700);
  const path = join(directory, "lock.json");
  const candidate = join(directory, `.lock-${randomUUID()}.tmp`);
  const handle = await open(candidate, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    await handle.sync();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await link(candidate, path);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const previous = await protectedFile(path);
        const owner = JSON.parse(previous.text);
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new ChatGptError("chatgpt_storage_in_use", { status: 409 });
        try {
          process.kill(owner.pid, 0);
          throw new ChatGptError("chatgpt_storage_in_use", { status: 409 });
        } catch (failure) {
          if (failure.code !== "ESRCH") throw failure;
        }
        const current = await lstat(path);
        if (current.ino === previous.info.ino && current.dev === previous.info.dev) await unlink(path);
        continue;
      }
      const owned = await handle.stat();
      await unlink(candidate);
      return async () => {
        await handle.close();
        const current = await lstat(path).catch((error) => { if (error.code !== "ENOENT") throw error; });
        if (current?.ino === owned.ino && current.dev === owned.dev) await unlink(path);
      };
    }
    throw new ChatGptError("chatgpt_storage_in_use", { status: 409 });
  } catch (error) {
    await handle.close();
    await unlink(candidate).catch((failure) => { if (failure.code !== "ENOENT") throw failure; });
    throw error;
  }
}

function validateState(state) {
  if (state?.version !== 1 || typeof state.hostId !== "string" || !UUID.test(state.hostId.slice(9))
    || !state.hostId.startsWith("urn:uuid:") || !Array.isArray(state.registrations) || !Array.isArray(state.accounts)) throw new Error("invalid state");
  const ids = new Set();
  const clients = new Set();
  for (const registration of state.registrations) {
    if (!UUID.test(registration.id) || !safeField(registration.clientId, 256) || registration.clientId === "dynamic_agent_client"
      || ids.has(registration.id) || clients.has(registration.clientId) || typeof registration.label !== "string") throw new Error("invalid registration");
    ids.add(registration.id);
    clients.add(registration.clientId);
  }
  const accounts = new Set();
  for (const account of state.accounts) {
    if (!ids.has(account.id) || accounts.has(account.id) || account.issuer !== ISSUER || typeof account.subject !== "string" || !account.subject) throw new Error("invalid account");
    accounts.add(account.id);
    if (account.tokens && (typeof account.tokens.accessToken !== "string" || !Array.isArray(account.tokens.scopes)
      || !Number.isFinite(account.tokens.expiresAt) || (account.tokens.refreshToken && typeof account.tokens.refreshToken !== "string"))) throw new Error("invalid tokens");
  }
  if (state.activeAccountId !== null && !accounts.has(state.activeAccountId)) throw new Error("invalid active account");
}

// One instance owns the credential directory. This also serializes rotating tokens across processes.
export async function createChatGptClient({
  fetchImpl = globalThis.fetch,
  storageDir = join(isAbsolute(process.env.XDG_CONFIG_HOME || "") ? process.env.XDG_CONFIG_HOME : join(homedir(), ".config"), "pod-god", "chatgpt"),
  now = Date.now,
  callbackTimeoutMs = 10 * 60_000,
  requestTimeoutMs = 30_000,
  streamTimeoutMs = 10 * 60_000,
  maxStreamBytes = 32 * 1024 * 1024,
} = {}) {
  const path = join(storageDir, "accounts.json");
  const recoveryPath = join(storageDir, "sign-in-recovery.json");
  async function clearRecovery() {
    await unlink(recoveryPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
    const directory = await open(storageDir, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  let unlock;
  let state;
  try {
    unlock = await lockStorage(storageDir);
    let recovery;
    try { recovery = JSON.parse((await protectedFile(recoveryPath)).text); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (recovery !== undefined) {
      validateState(recovery);
      await atomicJson(storageDir, path, recovery);
      await clearRecovery();
    }
    try { state = JSON.parse((await protectedFile(path)).text); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (state) validateState(state);
    else {
      state = { version: 1, hostId: `urn:uuid:${randomUUID()}`, activeAccountId: null, registrations: [], accounts: [] };
      await atomicJson(storageDir, path, state);
    }
  } catch (error) {
    await unlock?.();
    if (error instanceof ChatGptError) throw error;
    throw new ChatGptError("chatgpt_storage_unavailable", { status: 500 });
  }
  let closed = false;
  let selectionVersion = 0;
  let selectionWrites = 0;
  let pending = null;
  let lastSignIn = { status: "idle" };
  let writes = Promise.resolve();
  let recoveryPending = false;
  let discovery;
  let jwks;
  let jwksSavedAt = 0;
  const lifetime = new AbortController();
  const refreshes = new Map();
  const signingOut = new Set();
  const operations = new Set();
  const listenerClosures = new Set();

  function ensureOpen() {
    if (closed) throw new ChatGptError("chatgpt_closed", { status: 503 });
  }
  function registration(id) {
    const result = state.registrations.find((item) => item.id === id);
    if (!result) throw new ChatGptError("chatgpt_account_not_found", { status: 404 });
    return result;
  }
  function account(id) { return state.accounts.find((item) => item.id === id); }
  function errorFields(error) {
    return Object.fromEntries(["code", "status", "requestId", "param", "bodyShape"].filter((key) => error[key] !== undefined).map((key) => [key, error[key]]));
  }
  function sanitizedField(value, secrets, limit) {
    const field = safeField(value, limit);
    return field && !secrets.some((secret) => secret && field.includes(secret)) ? field : undefined;
  }
  function responseError(data, response, fallback, secrets = []) {
    const detail = typeof data?.error === "object" ? data.error : data;
    const code = sanitizedField(detail?.code ?? (typeof data?.error === "string" ? data.error : undefined), secrets) || fallback;
    return new ChatGptError(code, {
      status: response.status || 502,
      requestId: sanitizedField(response.headers.get("openai-request-id") || response.headers.get("x-request-id"), secrets, 160),
      param: sanitizedField(detail?.param, secrets, 160),
      bodyShape: data?.error !== undefined ? "error" : data?.detail !== undefined ? "detail" : "other",
    });
  }
  function commit(change, allowClosed = false, attempt) {
    if (!allowClosed) ensureOpen();
    const work = writes.then(async () => {
      if (!allowClosed) ensureOpen();
      if (recoveryPending) {
        try {
          await atomicJson(storageDir, path, state);
          await clearRecovery();
          recoveryPending = false;
        } catch { throw new ChatGptError("chatgpt_storage_unavailable", { status: 500 }); }
      }
      const next = structuredClone(state);
      change(next);
      let committed = false;
      try {
        if (attempt) {
          recoveryPending = true;
          await atomicJson(storageDir, recoveryPath, state);
        }
        await atomicJson(storageDir, path, next, attempt ? () => assertAttempt(attempt) : undefined);
        if (attempt) {
          const directory = await open(storageDir, "r");
          try {
            assertAttempt(attempt);
            // Removal and publication share one JS turn; cancel cannot enter this commit boundary.
            unlinkSync(recoveryPath);
            recoveryPending = false;
            state = next;
            pending = null;
            clearTimeout(attempt.timer);
            lastSignIn = { status: "complete", accountId: attempt.accountId };
            committed = true;
            closeListener(attempt);
            fsyncSync(directory.fd);
          } finally { await directory.close(); }
        } else state = next;
      } catch (error) {
        if (attempt && !committed) {
          // Restore within the write queue so later account changes are not undone.
          try {
            await atomicJson(storageDir, path, state);
            await clearRecovery();
            recoveryPending = false;
          } catch {
            const failure = new ChatGptError("chatgpt_storage_unavailable", { status: 500 });
            if (!pending && lastSignIn.status === "cancelled" && lastSignIn.accountId === attempt.accountId) lastSignIn.error = errorFields(failure);
            throw failure;
          }
        }
        const failure = error instanceof ChatGptError ? error : new ChatGptError("chatgpt_storage_unavailable", { status: 500 });
        if (committed && lastSignIn.status === "complete" && lastSignIn.accountId === attempt.accountId) lastSignIn.error = errorFields(failure);
        throw failure;
      }
    });
    writes = work.catch(() => {});
    return work;
  }
  async function request(url, options = {}, signal, timeout = requestTimeoutMs) {
    const timed = AbortSignal.timeout(timeout);
    try {
      return await fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.any([lifetime.signal, timed, ...(signal ? [signal] : [])]) });
    } catch (error) {
      if (error instanceof ChatGptError) throw error;
      throw new ChatGptError(closed || signal?.aborted ? "chatgpt_request_cancelled" : timed.aborted ? "chatgpt_request_timeout" : "chatgpt_network_error", { status: 503 });
    }
  }
  async function json(response) {
    if (!response.body) throw new ChatGptError("chatgpt_invalid_response", { status: 502 });
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 1024 * 1024) throw new ChatGptError("chatgpt_response_too_large", { status: 502 });
        chunks.push(value);
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch (error) {
      if (error instanceof ChatGptError) throw error;
      throw new ChatGptError("chatgpt_invalid_response", { status: 502 });
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async function configuration() {
    if (!discovery) discovery = (async () => {
      const response = await request(`${ISSUER}/.well-known/openid-configuration`);
      const data = await json(response);
      if (!response.ok) throw responseError(data, response, "chatgpt_discovery_failed");
      if (data.issuer !== ISSUER || data.authorization_endpoint !== `${ISSUER}/api/accounts/authorize`
        || data.token_endpoint !== `${ISSUER}/api/accounts/oauth/token`) throw new ChatGptError("chatgpt_invalid_discovery", { status: 502 });
      return { issuer: ISSUER, authorize: officialUrl(data.authorization_endpoint), token: officialUrl(data.token_endpoint),
        jwks: officialUrl(data.jwks_uri), revoke: officialUrl(data.revocation_endpoint) };
    })().catch((error) => { discovery = undefined; throw error; });
    return discovery;
  }
  async function keys(force = false) {
    if (force || !jwks || now() - jwksSavedAt > 5 * 60_000) {
      const config = await configuration();
      const response = await request(config.jwks);
      const data = await json(response);
      if (!response.ok || !Array.isArray(data.keys)) throw new ChatGptError("chatgpt_invalid_jwks", { status: 502 });
      jwks = data.keys;
      jwksSavedAt = now();
    }
    return jwks;
  }
  async function identity(token, clientId, nonce) {
    try {
      if (typeof token !== "string" || token.length > 32_768) throw new Error("invalid JWT");
      const parts = token.split(".");
      if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error("invalid JWT");
      const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      if (header.alg !== "RS256" || typeof header.kid !== "string" || header.crit) throw new Error("invalid algorithm");
      const matches = (list) => list.filter((key) => key.kid === header.kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256")
        && (!key.use || key.use === "sig") && (!key.key_ops || key.key_ops.includes("verify")));
      let matching = matches(await keys());
      if (!matching.length) matching = matches(await keys(true));
      if (matching.length !== 1 || !verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: matching[0], format: "jwk" }), Buffer.from(parts[2], "base64url"))) throw new Error("invalid signature");
      const seconds = now() / 1000;
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (claims.iss !== ISSUER || !audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId)
        || (claims.azp !== undefined && claims.azp !== clientId) || !Number.isInteger(claims.exp) || claims.exp <= seconds - 5
        || !Number.isInteger(claims.iat) || claims.iat > seconds + 5 || (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > seconds + 5))
        || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 512 || (nonce !== undefined && !same(claims.nonce, nonce))) throw new Error("invalid claims");
      return { issuer: ISSUER, subject: claims.sub, email: profileText(claims.email), name: profileText(claims.name) };
    } catch (error) {
      if (error instanceof ChatGptError) throw error;
      throw new ChatGptError("chatgpt_invalid_id_token", { status: 401 });
    }
  }
  function tokenSet(data, old) {
    if ((!old && typeof data.scope !== "string") || (data.scope !== undefined && typeof data.scope !== "string")) throw new ChatGptError("chatgpt_invalid_token_response", { status: 502 });
    const scopes = data.scope === undefined ? old.scopes : data.scope.split(/\s+/).filter(Boolean);
    if ((data.access_token !== undefined && (typeof data.access_token !== "string" || !data.access_token || data.access_token.length > 32_768))
      || (data.refresh_token !== undefined && (typeof data.refresh_token !== "string" || !data.refresh_token || data.refresh_token.length > 32_768))
      || ((old || scopes.includes(DIRECT_SCOPE)) && (!data.access_token || String(data.token_type).toLowerCase() !== "bearer" || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 86_400))
      || (old && !data.refresh_token)) throw new ChatGptError("chatgpt_invalid_token_response", { status: 502 });
    return { accessToken: data.access_token || "", refreshToken: data.refresh_token || null, idToken: data.id_token ?? old?.idToken ?? null,
      expiresAt: Number.isFinite(data.expires_in) ? now() + data.expires_in * 1000 : 0,
      earliestRefreshAt: Number.isFinite(data.earliest_refresh_at) ? data.earliest_refresh_at * 1000 : 0, scopes };
  }
  async function tokenRequest(fields, signal) {
    const config = await configuration();
    const response = await request(config.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(fields) }, signal);
    const data = await json(response);
    if (!response.ok) throw responseError(data, response, "chatgpt_token_request_failed", Object.values(fields));
    return data;
  }
  function stopOperations() {
    selectionVersion++;
    for (const controller of operations) controller.abort();
  }
  function closeListener(attempt) {
    if (!attempt.server || attempt.listenerClose) return;
    const closing = new Promise((resolve) => attempt.server.close(resolve));
    attempt.listenerClose = closing;
    listenerClosures.add(closing);
    closing.finally(() => listenerClosures.delete(closing));
  }
  function cancelPending() {
    if (!pending) return;
    const attempt = pending;
    pending = null;
    clearTimeout(attempt.timer);
    attempt.controller.abort();
    closeListener(attempt);
    lastSignIn = { status: "cancelled", accountId: attempt.accountId };
  }
  function assertAttempt(attempt) {
    ensureOpen();
    if (pending !== attempt || attempt.controller.signal.aborted) throw new ChatGptError("chatgpt_sign_in_cancelled", { status: 409 });
  }
  function snapshot(accountId = state.activeAccountId) {
    ensureOpen();
    if (!accountId) throw new ChatGptError("chatgpt_sign_in_required", { status: 401 });
    if (state.activeAccountId !== accountId) throw new ChatGptError("chatgpt_account_changed", { status: 409 });
    const result = { accountId, version: selectionVersion };
    assertSnapshot(result);
    return result;
  }
  function assertSnapshot(selected) {
    assertSelection(selected);
    const saved = account(selected.accountId);
    if (!saved?.tokens) throw new ChatGptError("chatgpt_sign_in_required", { status: 401 });
    if (!saved.tokens.scopes.includes(DIRECT_SCOPE)) throw new ChatGptError("chatgpt_plan_usage_disabled", { status: 403 });
  }
  function assertSelection(selected) {
    ensureOpen();
    if (selectionWrites || selected.version !== selectionVersion || state.activeAccountId !== selected.accountId || signingOut.has(selected.accountId)) throw new ChatGptError("chatgpt_account_changed", { status: 409 });
  }
  async function refresh(id) {
    if (!refreshes.has(id)) {
      const work = (async () => {
        const saved = account(id);
        const previous = saved.tokens;
        const client = registration(id);
        try {
          const data = await tokenRequest({ grant_type: "refresh_token", client_id: client.clientId, refresh_token: previous.refreshToken, resource: RESOURCE });
          if (data.id_token !== undefined) {
            const verified = await identity(data.id_token, client.clientId);
            if (verified.subject !== saved.subject || verified.issuer !== saved.issuer) throw new ChatGptError("chatgpt_account_mismatch", { status: 401 });
          }
          const tokens = tokenSet(data, previous);
          await commit((next) => { next.accounts.find((item) => item.id === id).tokens = tokens; }, true);
        } catch (error) {
          if (TERMINAL_REFRESH.has(error.code)) await commit((next) => { next.accounts.find((item) => item.id === id).tokens = null; }, true);
          throw error;
        }
      })();
      refreshes.set(id, work);
      work.finally(() => { if (refreshes.get(id) === work) refreshes.delete(id); }).catch(() => {});
    }
    return refreshes.get(id);
  }
  async function access(selected) {
    assertSnapshot(selected);
    const tokens = account(selected.accountId).tokens;
    if (tokens.expiresAt - now() < 60_000 && tokens.earliestRefreshAt <= now() && tokens.refreshToken) {
      await refresh(selected.accountId);
    }
    assertSnapshot(selected);
    const latest = account(selected.accountId).tokens;
    if (latest.expiresAt <= now()) throw new ChatGptError("chatgpt_sign_in_required", { status: 401 });
    return latest.accessToken;
  }
  async function authorized(selected, work) {
    const controller = new AbortController();
    operations.add(controller);
    try {
      const token = await access(selected);
      const result = await work(token, controller.signal);
      assertSnapshot(selected);
      return result;
    } catch (error) {
      assertSelection(selected);
      if (error instanceof ChatGptError) throw error;
      throw new ChatGptError("chatgpt_request_failed", { status: 502 });
    } finally { operations.delete(controller); }
  }
  function status() {
    return {
      activeAccountId: state.activeAccountId,
      accounts: state.registrations.map((item) => {
        const saved = account(item.id);
        const grant = Boolean(saved?.tokens?.scopes.includes(DIRECT_SCOPE));
        return { id: item.id, label: `${saved?.email || saved?.name || "ChatGPT"} (${item.label})`, active: state.activeAccountId === item.id,
          grant, status: signingOut.has(item.id) ? "signing_out" : !saved?.tokens ? "needs_sign_in" : grant ? "connected" : "plan_disabled" };
      }),
      pending: pending ? { accountId: pending.accountId, status: pending.status, startedAt: pending.startedAt } : null,
      lastSignIn: structuredClone(lastSignIn),
    };
  }
  async function signIn(accountId) {
    ensureOpen();
    const savedClient = accountId ? registration(accountId) : null;
    if (accountId && signingOut.has(accountId)) throw new ChatGptError("chatgpt_account_changed", { status: 409 });
    cancelPending();
    const attempt = { accountId: accountId || null, clientId: savedClient?.clientId, status: "preparing", startedAt: now(), state: randomBytes(32).toString("base64url"),
      nonce: randomBytes(32).toString("base64url"), verifier: randomBytes(64).toString("base64url"), controller: new AbortController() };
    pending = attempt;
    lastSignIn = { status: "preparing", accountId: attempt.accountId };
    async function finishCallback(url) {
      assertAttempt(attempt);
      if (attempt.consumed || url.searchParams.getAll("state").length !== 1 || !same(url.searchParams.get("state"), attempt.state)) throw new ChatGptError("chatgpt_invalid_state", { status: 401 });
      attempt.consumed = true;
      attempt.status = "exchanging";
      if (url.searchParams.has("error")) throw new ChatGptError(safeField(url.searchParams.get("error")) === "access_denied" ? "access_denied" : "chatgpt_authorization_failed", { status: 401 });
      const code = url.searchParams.get("code");
      const issued = url.searchParams.get("client_id");
      if (!code || code.length > 4096 || url.searchParams.getAll("code").length !== 1 || url.searchParams.getAll("client_id").length > 1) throw new ChatGptError("chatgpt_invalid_callback", { status: 401 });
      if (savedClient && issued && issued !== savedClient.clientId) throw new ChatGptError("chatgpt_account_mismatch", { status: 401 });
      if (!savedClient) {
        if (!safeField(issued, 256) || issued === "dynamic_agent_client") throw new ChatGptError("chatgpt_registration_incomplete", { status: 401 });
        const existing = state.registrations.find((item) => item.clientId === issued);
        attempt.accountId = existing?.id || randomUUID();
        attempt.clientId = issued;
        await commit((next) => {
          assertAttempt(attempt);
          if (!existing) next.registrations.push({ id: attempt.accountId, clientId: issued, label: `Connection ${next.registrations.length + 1}` });
        });
      }
      assertAttempt(attempt);
      const data = await tokenRequest({ grant_type: "authorization_code", client_id: attempt.clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: RESOURCE }, attempt.controller.signal);
      const verified = await identity(data.id_token, attempt.clientId, attempt.nonce);
      const previous = account(attempt.accountId);
      if (previous && (previous.subject !== verified.subject || previous.issuer !== verified.issuer)) throw new ChatGptError("chatgpt_account_mismatch", { status: 401 });
      const tokens = tokenSet(data);
      await refreshes.get(attempt.accountId)?.catch(() => {});
      assertAttempt(attempt);
      selectionWrites++;
      stopOperations();
      try {
        await commit((next) => {
          assertAttempt(attempt);
          const entry = { id: attempt.accountId, ...verified, tokens };
          const index = next.accounts.findIndex((item) => item.id === attempt.accountId);
          if (index < 0) next.accounts.push(entry); else next.accounts[index] = entry;
          next.activeAccountId = attempt.accountId;
        }, false, attempt);
      } finally { selectionWrites--; }
    }
    try {
      const config = await configuration();
      assertAttempt(attempt);
      attempt.server = createServer((req, res) => {
        res.setHeader("cache-control", "no-store");
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.setHeader("content-security-policy", "default-src 'none'");
        res.setHeader("connection", "close");
        let url;
        try { url = new URL(req.url, attempt.redirectUri); }
        catch { res.writeHead(400); res.end("Invalid request."); return; }
        if (url.origin !== new URL(attempt.redirectUri).origin || req.headers.host !== new URL(attempt.redirectUri).host) { res.writeHead(400); res.end("Invalid request."); return; }
        if (req.method !== "GET" || url.pathname !== "/auth/callback") { res.writeHead(404); res.end("Not found."); return; }
        if (attempt.consumed || pending !== attempt) { res.writeHead(409); res.end("This sign-in attempt has ended."); return; }
        if (url.searchParams.getAll("state").length !== 1 || !same(url.searchParams.get("state"), attempt.state)) {
          res.writeHead(401); res.end("This callback could not be verified."); return;
        }
        finishCallback(url).then(() => {
          res.end("ChatGPT sign-in is complete. You can close this tab.");
        }).catch((error) => {
          if (pending === attempt) lastSignIn = { status: "error", accountId: attempt.accountId, error: errorFields(error instanceof ChatGptError ? error : new ChatGptError("chatgpt_sign_in_failed", { status: 502 })) };
          res.writeHead(error instanceof ChatGptError ? error.status : 502);
          res.end("ChatGPT sign-in failed. Return to pod-god and try again.");
        }).finally(() => {
          clearTimeout(attempt.timer);
          if (pending === attempt) pending = null;
          closeListener(attempt);
        });
      });
      attempt.server.requestTimeout = 10_000;
      attempt.server.headersTimeout = 10_000;
      await new Promise((resolve, reject) => {
        attempt.server.once("error", reject);
        attempt.server.listen(0, "127.0.0.1", resolve);
      });
      assertAttempt(attempt);
      attempt.redirectUri = `http://127.0.0.1:${attempt.server.address().port}/auth/callback`;
      attempt.status = "waiting";
      attempt.timer = setTimeout(() => {
        if (pending !== attempt) return;
        cancelPending();
        lastSignIn = { status: "error", accountId: attempt.accountId, error: errorFields(new ChatGptError("chatgpt_sign_in_timeout", { status: 408 })) };
      }, callbackTimeoutMs);
      attempt.timer.unref();
      const authorize = new URL(config.authorize);
      authorize.search = new URLSearchParams({ client_id: savedClient?.clientId || "dynamic_agent_client", ext_agent_host_id: state.hostId, response_type: "code",
        redirect_uri: attempt.redirectUri, scope: SCOPES, resource: RESOURCE, state: attempt.state, nonce: attempt.nonce,
        code_challenge_method: "S256", code_challenge: createHash("sha256").update(attempt.verifier).digest("base64url") }).toString();
      if (!savedClient) authorize.searchParams.set("agent_name_hint", "pod-god");
      else {
        const saved = account(accountId);
        if (saved?.tokens?.idToken) authorize.searchParams.set("id_token_hint", saved.tokens.idToken);
        if (saved?.email) authorize.searchParams.set("login_hint", saved.email);
        if (saved?.tokens && !saved.tokens.scopes.includes(DIRECT_SCOPE)) authorize.searchParams.set("prompt", "consent");
      }
      return { authorizeUrl: authorize.href };
    } catch (error) {
      if (pending === attempt) {
        cancelPending();
        lastSignIn = { status: "error", accountId: attempt.accountId, error: errorFields(error) };
      }
      throw error;
    }
  }
  async function select(accountId) {
    ensureOpen();
    registration(accountId);
    if (!account(accountId) || signingOut.has(accountId)) throw new ChatGptError("chatgpt_sign_in_required", { status: 401 });
    cancelPending();
    stopOperations();
    selectionWrites++;
    try { await commit((next) => { next.activeAccountId = accountId; }); }
    finally { selectionWrites--; }
    return status();
  }
  function cancelSignIn() {
    ensureOpen();
    cancelPending();
    return status();
  }
  async function signOut(accountId = state.activeAccountId) {
    ensureOpen();
    registration(accountId);
    if (signingOut.has(accountId)) throw new ChatGptError("chatgpt_account_changed", { status: 409 });
    signingOut.add(accountId);
    cancelPending();
    stopOperations();
    let revoked = false;
    try {
      await refreshes.get(accountId)?.catch(() => {});
      const tokens = account(accountId)?.tokens;
      if (!tokens?.refreshToken) revoked = true;
      else {
        try {
          const config = await configuration();
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const response = await request(config.revoke, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ token: tokens.refreshToken, token_type_hint: "refresh_token", client_id: registration(accountId).clientId }) });
              await response.body?.cancel().catch(() => {});
              if (response.status === 200) { revoked = true; break; }
              if (response.status < 500) break;
            } catch (error) {
              if (closed || error.code === "chatgpt_request_cancelled") break;
            }
            if (!attempt) await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } catch {}
      }
      await commit((next) => {
        const entry = next.accounts.find((item) => item.id === accountId);
        if (entry) entry.tokens = null;
        if (next.activeAccountId === accountId) next.activeAccountId = null;
      });
    } finally { signingOut.delete(accountId); }
    return { ...status(), revoked, ...(revoked ? {} : { warning: "Remote revocation was not confirmed. Disconnect the app in ChatGPT Settings." }) };
  }
  async function models(accountId) {
    const selected = snapshot(accountId);
    return authorized(selected, async (token, signal) => {
      const response = await request(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } }, signal);
      const data = await json(response);
      if (!response.ok) throw responseError(data, response, "chatgpt_models_failed", [token]);
      if (!Array.isArray(data.models)) throw new ChatGptError("chatgpt_invalid_model_catalog", { status: 502 });
      return data.models.filter((item) => item.visibility === "list" && typeof item.slug === "string" && item.slug && typeof item.display_name === "string")
        .map((item) => ({ slug: item.slug, display_name: item.display_name, visibility: item.visibility }));
    });
  }
  async function streamText(response, token, signal) {
    const requestId = sanitizedField(response.headers.get("openai-request-id") || response.headers.get("x-request-id"), [token], 160);
    const failure = (code) => new ChatGptError(code, { status: 502, requestId });
    if (!response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) throw failure("chatgpt_invalid_stream");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    let data = [];
    let eventName = "";
    let frameSize = 0;
    let text = "";
    let total = 0;
    function frame() {
      if (!data.length) { eventName = ""; return; }
      const source = data.join("\n");
      data = [];
      frameSize = 0;
      if (source === "[DONE]") { eventName = ""; return; }
      let event;
      try { event = JSON.parse(source); } catch { throw failure("chatgpt_invalid_stream"); }
      const type = event.type || eventName;
      eventName = "";
      if (type === "response.failed" || type === "error" || type === "response.incomplete") {
        const code = sanitizedField(event.response?.error?.code || event.error?.code || event.code || event.response?.incomplete_details?.reason, [token])
          || (type === "response.incomplete" ? "chatgpt_response_incomplete" : "chatgpt_response_failed");
        throw new ChatGptError(code, { status: type === "response.failed" || type === "error" ? 502 : 422, requestId,
          param: sanitizedField(event.response?.error?.param || event.error?.param || event.param, [token], 160), bodyShape: "error" });
      }
      if (type === "response.output_text.delta") {
        if (typeof event.delta !== "string") throw failure("chatgpt_invalid_stream");
        text += event.delta;
      }
      if (type === "response.completed") {
        if (event.response?.status && event.response.status !== "completed") throw failure("chatgpt_invalid_stream");
        if (Array.isArray(event.response?.output)) {
          const completed = event.response.output.flatMap((item) => item.type === "message" && Array.isArray(item.content) ? item.content : [])
            .filter((item) => item.type === "output_text" && typeof item.text === "string").map((item) => item.text).join("");
          if (completed) text = completed;
        }
        return { choices: [{ message: { content: text } }] };
      }
    }
    const abort = () => { reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        if (signal.aborted || closed) throw failure("chatgpt_request_cancelled");
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxStreamBytes) throw failure("chatgpt_response_too_large");
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (!line) {
            const result = frame();
            if (result) return result;
          } else if (line.startsWith("data:")) {
            const part = line.slice(5).replace(/^ /, "");
            data.push(part);
            frameSize += part.length;
          }
          else if (line.startsWith("event:")) eventName = line.slice(6).trim();
          if (frameSize > 1024 * 1024) throw failure("chatgpt_response_too_large");
        }
        if (buffer.length > 1024 * 1024) throw failure("chatgpt_response_too_large");
      }
      decoder.decode();
      if (signal.aborted || closed) throw failure("chatgpt_request_cancelled");
      throw failure("chatgpt_stream_interrupted");
    } catch (error) {
      if (error instanceof ChatGptError) throw error;
      throw failure("chatgpt_stream_interrupted");
    } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async function respond({ accountId, model, system = "", prompt, effort } = {}) {
    if (typeof model !== "string" || !model.trim() || typeof prompt !== "string" || !prompt.trim() || typeof system !== "string"
      || (effort !== undefined && !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort))) throw new ChatGptError("chatgpt_invalid_input");
    const selected = snapshot(accountId);
    return authorized(selected, async (token, signal) => {
      const payload = { model, input: [{ role: "user", content: prompt }], store: false, stream: true };
      if (system) payload.instructions = system;
      if (effort) payload.reasoning = { effort };
      const streamSignal = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(streamTimeoutMs)]);
      const client = openAiClient({ baseURL: RESOURCE, apiKey: token, fetch: async (url, init) => {
        const response = await request(url, init, signal, streamTimeoutMs);
        if (!response.ok) throw responseError(await json(response), response, "chatgpt_responses_failed", [token]);
        return response;
      } });
      let response;
      try { response = await client.responses.create(payload, { headers: { accept: "text/event-stream" }, timeout: streamTimeoutMs }).asResponse(); }
      catch (error) { throw error?.cause instanceof ChatGptError ? error.cause : error; }
      return streamText(response, token, streamSignal);
    });
  }
  async function close() {
    if (closed) return;
    closed = true;
    cancelPending();
    stopOperations();
    lifetime.abort();
    await Promise.allSettled([...refreshes.values()]);
    await Promise.allSettled([...listenerClosures]);
    await writes;
    await unlock();
  }
  return { status, signIn, cancelSignIn, cancel: cancelSignIn, select, signOut, models, respond, close };
}
