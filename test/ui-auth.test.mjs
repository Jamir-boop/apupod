import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { html, script, source } from "./helpers.mjs";

const install = (names, context) => runInNewContext(names.map(source).join("\n"), context);

function signInContext(hash, token = "") {
  const storage = new Map(token ? [["apupod-token", token]] : []);
  const replacements = [];
  const context = {
    URLSearchParams, apiToken: token,
    location: { pathname: "/", search: "?view=settings&episode=fake", hash },
    history: { replaceState: (_, __, url) => replacements.push(url) },
    localStorage: { setItem: (key, value) => storage.set(key, value) },
  };
  install(["initializeSignIn"], context);
  return { context, storage, replacements };
}

test("the page exchanges a sign-in code without a bearer header and removes only credentials", async () => {
  const { context, storage, replacements } = signInContext("#login=fake-code");
  context.fetch = async (path, options) => {
    assert.equal(path, "/api/login");
    assert.equal(options.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(options.body), { code: "fake-code" });
    return { ok: true, json: async () => ({ token: "fake-token" }) };
  };
  await context.initializeSignIn();
  assert.equal(context.apiToken, "fake-token");
  assert.equal(storage.get("apupod-token"), "fake-token");
  assert.deepEqual(replacements, ["/?view=settings&episode=fake"]);
});

test("the page keeps its stored token after a used link or a failed exchange", async () => {
  for (const fetch of [async () => ({ ok: false }), async () => { throw new Error("offline"); }]) {
    const { context, storage, replacements } = signInContext("#config&login=used-code", "fake-stored-token");
    context.fetch = fetch;
    await context.initializeSignIn();
    assert.equal(context.apiToken, "fake-stored-token");
    assert.equal(storage.get("apupod-token"), "fake-stored-token");
    assert.deepEqual(replacements, ["/?view=settings&episode=fake#config"]);
  }
});

test("port-change credentials keep the Settings hash route and deep-link query", async () => {
  const { context, storage, replacements } = signInContext("#config&token=fake%2Btoken");
  context.fetch = () => assert.fail("a token fragment needs no API exchange");
  await context.initializeSignIn();
  assert.equal(storage.get("apupod-token"), "fake+token");
  assert.deepEqual(replacements, ["/?view=settings&episode=fake#config"]);
  const plain = signInContext("#config", "fake-stored-token");
  await plain.context.initializeSignIn();
  assert.deepEqual(plain.replacements, []);
});

test("an API 401 shows one sign-in panel, stops polls, and blocks further API requests", async () => {
  const panel = { hidden: true };
  const classes = new Set();
  const cleared = [];
  let requests = 0;
  const context = {
    apiToken: "fake-token", signedOut: false, modelPollTimer: 1, jobPollTimer: 2, revisionTimer: 3,
    $: (id) => { assert.equal(id, "signInPanel"); return panel; },
    document: { body: { classList: { add: (name) => classes.add(name) } }, visibilityState: "visible" },
    clearTimeout: (timer) => cleared.push(timer),
    setTimeout: () => assert.fail("signed-out polling must not restart"),
    fetch: async (path, options) => {
      requests += 1;
      assert.equal(options.headers.Authorization, "Bearer fake-token");
      return { status: 401 };
    },
  };
  install(["api", "requireSignIn", "pollRevision"], context);
  await assert.rejects(context.api("/api/state"), /This browser is not signed in to apupod/);
  assert.equal(panel.hidden, false);
  assert.equal(classes.has("signed-out"), true);
  assert.deepEqual(cleared.slice(0, 3), [1, 2, 3]);
  await assert.rejects(context.api("/api/jobs"), /This browser is not signed in to apupod/);
  await context.pollRevision();
  assert.equal(requests, 1);
  assert.match(html, /id="signInPanel"[^>]*role="alert"/);
  assert.match(html, /This browser is not signed in to apupod\. Run apupod open in a terminal, or ask your agent to open the apupod UI, then open the link it gives you\./);
});

test("token rotation stores the new token and port changes carry it to Settings", async () => {
  const stored = new Map();
  const context = {
    apiToken: "fake-old-token", confirm: () => true, notify: () => {}, loadSystem: async () => {},
    localStorage: { setItem: (key, value) => stored.set(key, value) },
    api: async () => ({ token: "fake-new-token" }),
  };
  install(["rotateMcpToken"], context);
  await context.rotateMcpToken();
  assert.equal(context.apiToken, "fake-new-token");
  assert.equal(stored.get("apupod-token"), "fake-new-token");
  context.$ = (id) => id === "systemPort" ? { value: "5000" } : {};
  context.location = {};
  context.setTimeout = (callback) => callback();
  context.api = async (path) => {
    if (path === "/api/system/port") return { url: "http://127.0.0.1:5000/" };
    throw new Error("old daemon stopped");
  };
  install(["changePort"], context);
  await context.changePort();
  assert.equal(context.location.href, "http://127.0.0.1:5000/#config&token=fake-new-token");
});

test("a sign-in fragment opened in an open tab reloads the page instead of routing to a view", () => {
  assert.match(script, /window\.addEventListener\("hashchange", \(\) => \/\(\^#\|&\)\(login\|token\)=\/\.test\(location\.hash\) \? location\.reload\(\) : setView\(location\.hash\.slice\(1\)\)\);/);
  const route = new RegExp(script.match(/\/\(\^#\|&\)\(login\|token\)=\//)[0].slice(1, -1));
  for (const hash of ["#login=abc", "#config&token=abc"]) assert.ok(route.test(hash), hash);
  for (const hash of ["#config", "#episodes", "#tokens"]) assert.ok(!route.test(hash), hash);
});
