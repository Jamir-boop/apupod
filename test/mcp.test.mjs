import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { silentWav, startTestServer, waitFor, withEnv } from "./helpers.mjs";

const TOOLS = ["get_workspace", "open_ui", "list_tts_options", "set_tts_models", "list_voices", "save_host_profile", "delete_host_profile", "save_episode_format", "delete_episode_format", "add_knowledge", "get_knowledge", "delete_knowledge", "save_plan", "get_plan", "delete_plan", "create_episodes", "get_episode", "get_script_rules", "save_script", "render_audio", "get_job", "list_jobs", "preview_voice", "rename_episode", "apply_latest_profiles", "delete_episode", "save_album", "get_album", "delete_album", "set_album_cover", "jev_decide"];
const INITIALIZE = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } };

// A test server plus an MCP client that sends the daemon's bearer token.
async function connect(t, options) {
  const server = await startTestServer(t, options);
  const token = (await readFile(join(server.rootDir, "mcp-token"), "utf8")).trim();
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => client.close());
  const ok = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.ok(!response.isError, `${name}: ${response.content?.[0]?.text}`);
    assert.equal(response.content[0].type, "text");
    assert.ok(response.structuredContent && typeof response.structuredContent === "object");
    return response.structuredContent;
  };
  const fails = async (name, args, pattern) => {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(response.isError, true, `${name} should fail`);
    assert.match(response.content[0].text, pattern);
  };
  const revision = async () => (await server.api("/api/revision")).value.revision;
  return { ...server, token, client, ok, fails, revision };
}

const speaker = (name, extra = {}) => ({ name, backstory: `${name} backstory`, personality: "Curious", style: "Warm", voiceId: "Chloe", ...extra });

test("tools/list has every tool with annotations, and the widgets are self-contained ui:// resources", async (t) => {
  const { client, baseUrl } = await connect(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOLS].sort());
  for (const tool of tools) {
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) assert.equal(typeof tool.annotations?.[hint], "boolean", `${tool.name} ${hint}`);
    assert.equal(tool.inputSchema.type, "object");
  }
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  for (const name of ["get_workspace", "open_ui"]) assert.equal(byName[name]._meta.ui.resourceUri, "ui://apupod/workspace");
  for (const name of ["get_episode", "save_script", "render_audio", "apply_latest_profiles"]) assert.equal(byName[name]._meta.ui.resourceUri, "ui://apupod/episode");
  assert.equal(byName.get_workspace.annotations.readOnlyHint, true);
  assert.equal(byName.delete_episode.annotations.destructiveHint, true);
  assert.doesNotMatch(JSON.stringify(tools), /apiKey"|API_KEY"/, "no tool accepts key values");

  const { resources } = await client.listResources();
  assert.deepEqual(resources.map((item) => [item.uri, item.mimeType]).sort(), [["ui://apupod/episode", "text/html;profile=mcp-app"], ["ui://apupod/workspace", "text/html;profile=mcp-app"]]);
  for (const { uri } of resources) {
    const [content] = (await client.readResource({ uri })).contents;
    assert.equal(content.mimeType, "text/html;profile=mcp-app");
    assert.match(content.text, /^<!DOCTYPE html>/);
    assert.match(content.text, /ui\/initialize/);
    assert.doesNotMatch(content.text, /<script[^>]+src=|<link\b|https?:\/\/(?!127)/, "no external resources");
    assert.deepEqual(content._meta.ui.csp, { connectDomains: [baseUrl], resourceDomains: [baseUrl] });
  }
});

test("/mcp rejects a missing or wrong token and a foreign Origin, and answers only POST", async (t) => {
  const { baseUrl, token } = await connect(t);
  const post = (headers) => fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(INITIALIZE) });
  let response = await post({});
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate"), /^Bearer/);
  assert.equal((await post({ Authorization: "Bearer wrong" })).status, 401);
  assert.equal((await post({ Authorization: `Bearer ${token}x` })).status, 401);
  assert.equal((await post({ Authorization: `Bearer ${token}`, Origin: "https://evil.example" })).status, 403);
  assert.equal((await fetch(`${baseUrl}/mcp`, { headers: { Authorization: `Bearer ${token}`, Origin: "https://evil.example" } })).status, 403);
  assert.equal((await fetch(`${baseUrl}/mcp`, { headers: { Authorization: `Bearer ${token}` } })).status, 405);
  response = await post({ Authorization: `Bearer ${token}`, Origin: baseUrl });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.serverInfo.name, "apupod");
});

test("the MCP token is created once with mode 0600 and survives a restart", async (t) => {
  const first = await startTestServer(t);
  const path = join(first.rootDir, "mcp-token");
  const token = await readFile(path, "utf8");
  assert.ok(token.trim().length >= 32);
  const { stat } = await import("node:fs/promises");
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  await first.close();
  await startTestServer(t, { rootDir: first.rootDir });
  assert.equal(await readFile(path, "utf8"), token);
});

test("the revision counter increments on REST and MCP writes, not on reads or failed writes", async (t) => {
  const { api, ok, fails, revision } = await connect(t);
  const start = await revision();
  await ok("get_workspace");
  assert.equal(await revision(), start);
  assert.equal((await api("/api/knowledge", { name: "a.txt", content: "# A" })).status, 400);
  assert.equal(await revision(), start);
  const rest = await api("/api/knowledge", { name: "a.md", content: "# A" });
  assert.equal(rest.status, 201);
  assert.equal(await revision(), start + 1);
  await ok("add_knowledge", { name: "b.md", content: "# B" });
  assert.equal(await revision(), start + 2);
  await fails("add_knowledge", { name: "b.txt", content: "# B" }, /\.md file/);
  assert.equal(await revision(), start + 2);
});

test("host profile and Episode Format tools validate, check revisions, and keep omitted speaker settings", async (t) => {
  const { ok, fails } = await connect(t);
  const workspace = await ok("get_workspace");
  assert.equal(workspace.hosts.length, 1);
  assert.equal(workspace.tts.ready, false);
  assert.equal(workspace.jev.model, "jev-1.14.0");
  assert.match(workspace.uiUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  const created = await ok("save_host_profile", { name: "Duo", voiceModel: "mimo-v2.5-tts", speakers: [speaker("Ana", { elevenlabsSpeed: 1.1 }), speaker("Ben")] });
  const hostId = created.profile.id;
  assert.equal(created.profile.revision, 1);
  assert.equal(created.profile.speakers[1].chatterboxExaggeration, 0.7, "defaults fill omitted tuning");
  await fails("save_host_profile", { name: "Bad", voiceModel: "mimo-v2.5-tts", speakers: [speaker("A: B")] }, /reserved characters/);
  await fails("save_host_profile", { name: "Bad", voiceModel: "mimo-v2.5-tts", speakers: [speaker("Ana", { voiceId: "" })] }, /voice ID is required/);
  await fails("save_host_profile", { name: "Bad", voiceModel: "no-such-model", speakers: [speaker("Ana")] }, /Unsupported TTS model/);
  await fails("save_host_profile", { name: "No model", speakers: [speaker("Ana")] }, /needs voiceModel/);
  await fails("save_host_profile", { id: "missing", name: "X" }, /Host profile not found/);
  await fails("save_host_profile", { name: "Five", voiceModel: "mimo-v2.5-tts", speakers: ["A", "B", "C", "D", "E"].map((name) => speaker(name)) }, /4/);

  const updated = await ok("save_host_profile", { id: hostId, expectedRevision: 1, speakers: [{ name: "Ana", voiceId: "Mia" }, { name: "Ben" }] });
  assert.equal(updated.profile.revision, 2);
  assert.equal(updated.profile.speakers[0].voiceId, "Mia");
  assert.equal(updated.profile.speakers[0].elevenlabsSpeed, 1.1, "a speaker keeps settings the update omits");
  assert.equal(updated.profile.speakers[0].backstory, "Ana backstory");
  await fails("save_host_profile", { id: hostId, expectedRevision: 1, name: "Stale" }, /changed somewhere else/);

  const format = await ok("save_episode_format", { name: "Short", description: "Quick", speakerProfileId: hostId, language: "en-US", targetMinutes: 10 });
  assert.equal(format.format.numSegments, 3);
  await fails("save_episode_format", { name: "Tiny", speakerProfileId: hostId, language: "en-US", targetMinutes: 3 }, /Target duration/);
  await fails("save_episode_format", { name: "Unknown", speakerProfileId: hostId, language: "xx", targetMinutes: 10 }, /Unsupported language/);
  const renamed = await ok("save_episode_format", { id: format.format.id, name: "Short show" });
  assert.equal(renamed.format.name, "Short show");
  assert.equal(renamed.format.targetMinutes, 10);

  await ok("create_episodes", { name: "Uses format", episodeProfileId: format.format.id });
  await fails("delete_episode_format", { id: format.format.id }, /is used by saved episode/);
  await fails("delete_episode_format", { id: "missing" }, /Episode Format not found/);
  const extra = await ok("save_episode_format", { name: "Spare", speakerProfileId: hostId, language: "en-US", targetMinutes: 20 });
  const deletedFormat = await ok("delete_episode_format", { id: extra.format.id });
  assert.equal(deletedFormat.deleted, true);
  assert.ok(!(await ok("get_workspace")).formats.some((item) => item.id === extra.format.id));

  const removed = await ok("delete_host_profile", { id: hostId });
  assert.equal(removed.deleted, true);
  await fails("delete_host_profile", { id: hostId }, /Host profile not found/);
  await fails("delete_host_profile", { id: "../x" }, /invalid/);
  const opened = await ok("open_ui", { view: "tts" });
  assert.match(opened.url, /\/\?view=tts$/);
});

test("apply_latest_profiles refreshes an episode's host snapshot and keeps the script", async (t) => {
  const { ok, fails, rootDir } = await connect(t);
  const host = (await ok("save_host_profile", { name: "Duo", voiceModel: "mimo-v2.5-tts", speakers: [speaker("Ana"), speaker("Ben")] })).profile;
  const format = (await ok("save_episode_format", { name: "Short", speakerProfileId: host.id, language: "en-US", targetMinutes: 10 })).format;
  const { episodes: [episode] } = await ok("create_episodes", { name: "Snapshot", episodeProfileId: format.id });
  const { transcript } = (await ok("save_script", { episodeId: episode.id, script: "## One\nAna: Hi.\nBen: Hello." })).episode;
  await ok("save_host_profile", { id: host.id, speakers: [{ name: "Ana", voiceId: "Mia" }, { name: "Ben" }] });
  assert.equal((await ok("get_episode", { id: episode.id })).episode.speakerProfile.speakers[0].voiceId, "Chloe", "the snapshot stays until applied");

  const episodePath = join(rootDir, "data", "episodes", episode.id, "episode.json");
  const stored = JSON.parse(await readFile(episodePath, "utf8"));
  await writeFile(episodePath, JSON.stringify({ ...stored, job: { id: "active", type: "tts", status: "running" } }));
  await fails("apply_latest_profiles", { episodeId: episode.id }, /active episode job/);
  await writeFile(episodePath, JSON.stringify(stored));

  const applied = await ok("apply_latest_profiles", { episodeId: episode.id });
  assert.equal(applied.changed, true);
  assert.equal(applied.episode.speakerProfile.speakers[0].voiceId, "Mia");
  assert.equal(applied.episode.speakerProfile.voiceModel, "mimo-v2.5-tts");
  assert.equal(applied.episode.transcript, transcript);
  assert.equal(applied.episode.status, "transcript_ready");
  assert.equal((await ok("get_episode", { id: episode.id })).episode.speakerProfile.speakers[0].voiceId, "Mia");
  assert.equal((await ok("apply_latest_profiles", { episodeId: episode.id })).changed, false);
});

test("knowledge, plan, episode, and script tools share the REST rules", async (t) => {
  const { ok, fails, api } = await connect(t);
  const { knowledgeBase } = await ok("add_knowledge", { name: "book.md", content: "# Book\n" + "x".repeat(50) });
  const page = await ok("get_knowledge", { id: knowledgeBase.id, offset: 0, limit: 10 });
  assert.equal(page.content, "# Book\nxxx");
  assert.equal(page.nextOffset, 10);
  assert.equal((await ok("get_knowledge", { id: knowledgeBase.id, offset: 50 })).nextOffset, null);
  await fails("get_knowledge", { id: "missing" }, /Knowledge base not found/);
  await fails("add_knowledge", { name: "empty.md", content: "  " }, /empty/);

  await fails("save_plan", { name: "Bad", episodes: [{ number: 2, title: "Two" }] }, /invalid numbering/);
  await fails("save_plan", { name: "No format", episodes: [{ number: 1, title: "One" }] }, /Pick an Episode Format/);
  await fails("save_plan", { name: "Bad language", language: "xx" }, /Unsupported language/);
  const withFormat = await ok("save_plan", { name: "New format", knowledgeBaseId: knowledgeBase.id, episodeFormat: { name: "Agent format", description: "Two hosts" }, episodes: [{ number: 1, title: "One" }] });
  assert.ok(withFormat.createdEpisodeFormatId);
  assert.equal(withFormat.plan.episodeFormatId, withFormat.createdEpisodeFormatId);
  assert.ok((await ok("get_workspace")).formats.some((format) => format.id === withFormat.createdEpisodeFormatId && format.name === "Agent format"));

  const saved = await ok("save_plan", {
    name: "Series", knowledgeBaseId: knowledgeBase.id, episodeFormatId: "episode-example-format", theme: "Parenting",
    episodes: [{ number: 1, title: "First", premise: "Opening", keyPoints: ["a", "b"] }, { number: 2, title: "Second" }],
  });
  const plan = saved.plan;
  assert.equal(plan.episodeCount, 2);
  assert.deepEqual(plan.episodes.map((item) => [item.number, item.title, item.premise]), [[1, "First", "Opening"], [2, "Second", ""]]);
  await fails("save_plan", { id: plan.id, expectedUpdatedAt: "2000-01-01T00:00:00.000Z", name: "Stale" }, /changed in another tab/);
  assert.equal((await ok("get_plan", { id: plan.id })).plan.name, "Series");
  assert.equal((await api(`/api/plans/${plan.id}`)).value.plan.episodes.length, 2, "REST reads the MCP plan");

  const created = await ok("create_episodes", { planId: plan.id, plannedEpisodeIds: [plan.episodes[0].id] });
  assert.equal(created.episodes.length, 1);
  await fails("create_episodes", { planId: plan.id, plannedEpisodeIds: [] }, /Select at least one planned episode/);
  await fails("save_plan", { id: plan.id, episodes: [{ number: 1, title: "Only second", id: plan.episodes[1].id }] }, /already has a created episode/);
  const reordered = await ok("save_plan", { id: plan.id, episodes: [{ id: plan.episodes[0].id, number: 1, title: "First, revised" }, { number: 2, title: "Brand new" }] });
  assert.equal(reordered.plan.episodes[0].id, plan.episodes[0].id);
  assert.equal(reordered.plan.episodes[0].createdEpisodeId, created.episodes[0].id);
  assert.equal(reordered.plan.theme, "Parenting", "omitted fields keep their values");

  const { episodes: [episode] } = await ok("create_episodes", { name: "New episode", episodeProfileId: "episode-example-format", knowledgeBaseId: knowledgeBase.id });
  await fails("create_episodes", { name: "", episodeProfileId: "episode-example-format" }, /Episode name is required/);
  await fails("create_episodes", { name: "X", episodeProfileId: "missing" }, /Episode Format does not exist/);

  const rules = await ok("get_script_rules", { episodeId: episode.id });
  assert.deepEqual(rules.speakerNames, ["Alex", "Sam"]);
  assert.equal(rules.maxSegments, 3);
  assert.deepEqual(rules.words, { target: 10 * 140, minimum: 10 * 125, perMinute: { target: 140, minimum: 125 } });
  assert.equal(rules.language.id, "en-US");
  assert.match(rules.speakerRule, /Alex is the lead host/);
  assert.match(rules.lockedPrompt, /TTS-AWARE DIALOGUE RULES/);
  assert.equal(rules.speakers[0].provider, "mimo");
  assert.equal(rules.knowledgeBase.id, knowledgeBase.id);
  assert.match(rules.markdownFormat, /## Segment title/);

  await fails("save_script", { episodeId: episode.id, script: "## One\nNobody: Hola." }, /Invalid transcript line/);
  await fails("save_script", { episodeId: episode.id, script: Array.from({ length: 4 }, (_, index) => `## S${index}\nAlex: Hola.`).join("\n") }, /at most 3 segments/);
  const script = await ok("save_script", { episodeId: episode.id, script: "# Charla corta\n## Uno\nAlex [cálida]: Hola, Sam.\nSam: Hola, Alex." });
  assert.equal(script.episode.name, "Charla corta", "a \"New episode\" takes the script title");
  assert.equal(script.episode.status, "transcript_ready");
  assert.equal(script.stats.segments, 1);
  assert.ok(script.warnings.some((warning) => /Transcript contains 1 of 3/.test(warning)));
  assert.ok(script.warnings.some((warning) => /too short: 4 words. Recommended minimum is 1250 words/.test(warning)));
  const again = await ok("save_script", { episodeId: episode.id, script: "# Otro título\n## Uno\nAlex: Hola." });
  assert.equal(again.episode.name, "Charla corta", "only \"New episode\" is renamed");
  assert.equal((await api(`/api/episodes/${episode.id}`)).value.transcript, "# Otro título\n## Uno\nAlex: Hola.\n");

  const fetched = await ok("get_episode", { id: episode.id });
  assert.equal(fetched.audioUrl, null);
  assert.match(fetched.episode.transcript, /Alex: Hola/);
  assert.equal((await ok("rename_episode", { id: episode.id, name: "  Final\nname " })).episode.name, "Final name");
  await fails("rename_episode", { id: episode.id, name: " " }, /Episode name is required/);
  await fails("get_episode", { id: "missing" }, /Episode does not exist/);
  await fails("get_job", { jobId: "missing" }, /Job not found/);
  assert.deepEqual((await ok("list_jobs")).jobs, []);
  await fails("render_audio", { episodeId: created.episodes[0].id }, /Save a transcript before rendering/);

  assert.equal((await ok("delete_knowledge", { id: knowledgeBase.id })).cleared.plans, 2);
  assert.equal((await ok("delete_plan", { id: plan.id })).deleted, true);
  await fails("get_plan", { id: plan.id }, /Content plan not found/);
  assert.equal((await ok("delete_episode", { id: episode.id })).deleted, true);
  await fails("delete_episode", { id: episode.id }, /Episode does not exist/);
});

test("TTS tools list options and voices, save a preview WAV, and render audio with a stubbed provider", async (t) => {
  withEnv(t, { ELEVENLABS_API_KEY: "test-eleven-key" });
  const ttsRequests = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/v1/models")) return Response.json([{ model_id: "eleven_v3", name: "Eleven v3", can_do_text_to_speech: true }]);
    if (String(url).includes("/v2/voices")) return Response.json({ voices: [{ voice_id: "voice-es", name: "Española" }], has_more: false });
    if (String(url).includes("/text-to-speech/")) {
      ttsRequests.push(JSON.parse(options.body));
      return new Response(silentWav(24_000, 1, 0.5), { headers: { "Content-Type": "audio/wav" } });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const { ok, fails, api, baseUrl, revision } = await connect(t, { fetchImpl });
  const state = (await api("/api/state")).value;
  state.config.providers.elevenlabs.activeModels = { eleven_v3: { tts: true } };
  assert.equal((await api("/api/config", state.config, "PUT")).status, 200);

  const options = await ok("list_tts_options", { language: "es-419" });
  const v3 = options.models.find((model) => model.id === "eleven_v3");
  assert.deepEqual(v3.cue, { cueMode: "tags", squareTags: true, breaks: false });
  assert.ok(v3.languages.includes("es-419"));
  assert.equal(options.tts.providers.elevenlabs.hasApiKey, true);
  assert.equal(options.settings.elevenlabs.elevenlabsSpeed.max, 1.2);
  assert.doesNotMatch(JSON.stringify(options), /test-eleven-key/);
  await fails("list_tts_options", { language: "xx" }, /Unsupported language/);

  assert.deepEqual((await ok("list_voices", { provider: "elevenlabs" })).voices.map((voice) => voice.id), ["voice-es"]);
  assert.deepEqual((await ok("list_voices", { model: "eleven_v3" })).voices.map((voice) => voice.id), ["voice-es"]);
  assert.ok((await ok("list_voices", { provider: "mimo" })).voices.some((voice) => voice.id === "Chloe"));
  await fails("list_voices", { model: "no-model" }, /is not active/);
  await fails("list_voices", {}, /Give a provider or a model/);

  await ok("save_host_profile", { id: "speaker-example-hosts", voiceModel: "eleven_v3", speakers: [{ name: "Alex", voiceId: "voice-es" }, { name: "Sam", voiceId: "voice-es" }] });
  const preview = await ok("preview_voice", { speakerProfileId: "speaker-example-hosts", episodeProfileId: "episode-example-format", speakerIndex: 0, text: "Hola" });
  assert.match(preview.url, new RegExp(`^${baseUrl}/previews/[0-9a-f-]{36}\\.wav$`));
  assert.equal(preview.durationSeconds, 0.5);
  const wav = await fetch(preview.url);
  assert.equal(wav.status, 200);
  assert.equal(wav.headers.get("content-type"), "audio/wav");
  assert.equal(wav.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.equal(Buffer.from(await wav.arrayBuffer()).length, preview.bytes);
  await fails("preview_voice", { speakerProfileId: "speaker-example-hosts", episodeProfileId: "episode-example-format", text: "x".repeat(601) }, /1 to 600 characters/);
  await fails("preview_voice", { speakerProfileId: "missing", episodeProfileId: "episode-example-format", text: "Hola" }, /Speaker profile does not exist/);

  const { episodes: [episode] } = await ok("create_episodes", { name: "Render me", episodeProfileId: "episode-example-format" });
  const beforeRender = await revision();
  const saved = await ok("save_script", { episodeId: episode.id, script: "## Uno\nAlex: Hola.\nSam: Hola.", render: true });
  assert.ok(saved.job?.id);
  const done = await waitFor(async () => {
    const { job } = await ok("get_job", { jobId: saved.job.id });
    return ["completed", "failed"].includes(job.status) && job;
  }, 30_000);
  assert.equal(done.status, "completed", done.error);
  // Script save + queue, then running, two synthesized turns, combining, ready, and completed.
  assert.ok(await revision() >= beforeRender + 7, "job progress writes increment the revision");
  const rendered = await ok("get_episode", { id: episode.id });
  assert.equal(rendered.episode.audioReady, true);
  assert.equal(rendered.audioUrl, `${baseUrl}/artifacts/${episode.id}/episode.mp3`);
  assert.equal((await fetch(rendered.audioUrl)).status, 200);
  assert.ok((await ok("list_jobs")).jobs.some((job) => job.id === saved.job.id));

  const again = await ok("render_audio", { episodeId: episode.id });
  assert.equal(again.job.status, "queued");
  await fails("render_audio", { episodeId: episode.id }, /already has an active job/);
  await waitFor(async () => (await ok("get_job", { jobId: again.job.id })).job.status === "completed", 30_000);
  assert.ok(ttsRequests.length >= 3);
});

const hashId = (id) => ["keep_current", "not_requested", "clarify"].includes(id) ? id : `option_${createHash("sha256").update(id).digest("hex")}`;

test("jev_decide reports unavailable without a key and decides with a stubbed Jev", async (t) => {
  withEnv(t, { TYPESAFE_API_KEY: undefined });
  const requests = [];
  const choices = { route: "episodeFormat", profileAction: "update", language: "en-US" };
  const fetchImpl = async (url, options = {}) => {
    if (!String(url).includes("typesafe.ai")) throw new Error(`Unexpected URL ${url}`);
    const body = JSON.parse(options.body);
    requests.push({ authorization: options.headers.Authorization, body });
    return Response.json({ model: "jev-1.14.0", answers: Object.fromEntries(Object.entries(body.questions).map(([questionId, question]) => {
      if (question.type === "noul") return [questionId, { type: "noul", noul: 1 }];
      const selected = hashId(choices[questionId] || "keep_current");
      return [questionId, { type: "choice", choice: selected, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === selected ? 1 : 0])) }];
    })) });
  };
  const keyless = await connect(t, { fetchImpl });
  const unavailable = await keyless.ok("jev_decide", { request: "Switch the format to English." });
  assert.equal(unavailable.status, "unavailable");
  assert.match(unavailable.reason, /TYPESAFE_API_KEY/);
  assert.equal(requests.length, 0);

  // The key is read when the model catalog refreshes (startup or a Settings save), like the TTS keys.
  withEnv(t, { TYPESAFE_API_KEY: "test-typesafe-key" });
  const { ok } = await connect(t, { fetchImpl });
  const decided = await ok("jev_decide", { request: "Switch the format to English.", fields: ["language"], focus: { view: "format", episodeProfileId: "episode-example-format" } });
  assert.equal(decided.status, "ready", JSON.stringify(decided.error));
  assert.equal(decided.decisions.route, "episodeFormat");
  assert.equal(decided.selections.language.value, "en-US");
  assert.equal(decided.selections.speakerProfileId.choice, "keep_current", "fields outside the list keep their values");
  assert.ok(requests.every((request) => request.authorization === "Bearer test-typesafe-key"));
  assert.doesNotMatch(JSON.stringify(decided), /test-typesafe-key/);

  choices.route = "speakerProfile";
  choices.profileAction = "create";
  choices.speakerCount = "1";
  const needsProposal = await ok("jev_decide", { request: "Create a solo host." });
  assert.equal(needsProposal.status, "needs_proposal");
  assert.match(needsProposal.reason, /exactly 1 speakers/);

  requests.length = 0;
  const failing = async () => Response.json({}, { status: 503 });
  const down = await connect(t, { fetchImpl: failing });
  const result = await down.ok("jev_decide", { request: "Switch the format to English." });
  assert.equal(result.status, "unavailable");
  assert.equal(result.error.code, "upstream_error");
});

const elevenCatalog = async (url) => {
  if (String(url).endsWith("/v1/models")) return Response.json([
    { model_id: "eleven_v3", name: "Eleven v3", can_do_text_to_speech: true, languages: [{ language_id: "eng", name: "English" }] },
    { model_id: "eleven_flash_v2_5", name: "Eleven Flash v2.5", can_do_text_to_speech: true },
    { model_id: "eleven_v4_turbo", name: "Eleven v4 Turbo", can_do_text_to_speech: true },
  ]);
  if (String(url).includes("/v2/voices")) return Response.json({ voices: [{ voice_id: "voice-a", name: "A" }], has_more: false });
  throw new Error(`Unexpected URL ${url}`);
};

test("set_tts_models activates discovered models through the config save and refuses to deactivate a model in use", async (t) => {
  withEnv(t, { ELEVENLABS_API_KEY: "test-eleven-key", MIMO_API_KEY: null, OPENAI_API_KEY: null });
  const { ok, fails } = await connect(t, { fetchImpl: elevenCatalog });
  const before = await ok("list_tts_options", { language: "en-US" });
  assert.deepEqual(before.models, []);
  assert.deepEqual(before.available.map((model) => model.id).sort(), ["eleven_flash_v2_5", "eleven_v3"], "unsupported realtime models are not offered");
  const v3 = before.available.find((model) => model.id === "eleven_v3");
  assert.deepEqual({ ...v3, languages: undefined }, { id: "eleven_v3", name: "Eleven v3", provider: "elevenlabs", capabilities: { cueMode: "tags", squareTags: true, breaks: false }, languages: undefined });
  assert.ok(v3.languages.includes("en-US"));
  assert.match(before.tts.hint, /set_tts_models/);
  assert.doesNotMatch(before.tts.hint, /add a TTS key/i);
  const workspace = await ok("get_workspace");
  assert.equal(workspace.tts.ready, false);
  assert.match(workspace.tts.hint, /set_tts_models/);

  await fails("set_tts_models", { models: ["eleven_made_up"], active: true }, /is not available/);
  const activated = await ok("set_tts_models", { models: ["eleven_v3"], active: true });
  assert.deepEqual(activated.models, ["eleven_v3"]);
  const after = await ok("list_tts_options", { language: "en-US" });
  assert.deepEqual(after.models.map((model) => model.id), ["eleven_v3"]);
  assert.deepEqual(after.available.map((model) => model.id), ["eleven_flash_v2_5"]);
  assert.equal(after.tts.hint, null);
  await ok("save_host_profile", { name: "Duo", voiceModel: "eleven_v3", speakers: [speaker("Ana", { voiceId: "voice-a" }), speaker("Ben", { voiceId: "voice-a" })] });

  await fails("set_tts_models", { models: ["eleven_v3"], active: false }, /Cannot deactivate a TTS model in use\. TTS model "eleven_v3" is inactive but used by speaker profile "Duo"\./);
  assert.deepEqual((await ok("list_tts_options")).models.map((model) => model.id), ["eleven_v3"]);
  await ok("set_tts_models", { models: ["eleven_flash_v2_5"], active: true });
  assert.deepEqual((await ok("set_tts_models", { models: ["eleven_flash_v2_5"], active: false })).models, ["eleven_v3"]);
});

test("set_tts_models and PUT /api/config save the same config", async (t) => {
  withEnv(t, { ELEVENLABS_API_KEY: "test-eleven-key", MIMO_API_KEY: null, OPENAI_API_KEY: null });
  const viaTool = await connect(t, { fetchImpl: elevenCatalog });
  await viaTool.ok("set_tts_models", { models: ["eleven_v3"], active: true });
  const viaRest = await connect(t, { fetchImpl: elevenCatalog });
  const state = (await viaRest.api("/api/state")).value;
  state.config.providers.elevenlabs.activeModels = { eleven_v3: { tts: true } };
  assert.equal((await viaRest.api("/api/config", state.config, "PUT")).status, 200);
  const read = async (server) => JSON.parse(await readFile(join(server.rootDir, "config.json"), "utf8"));
  assert.deepEqual(await read(viaTool), await read(viaRest));
  assert.deepEqual((await viaTool.api("/api/config")).value, (await viaRest.api("/api/config")).value);
});

test("provider errors never carry key-like text into the state, the catalog, or the tools", async (t) => {
  withEnv(t, { OPENAI_API_KEY: "sk-proj-realsecretvalue0123456789", ELEVENLABS_API_KEY: null, MIMO_API_KEY: null });
  const fetchImpl = async (url) => {
    if (String(url).startsWith("https://api.openai.com/")) return Response.json({ error: { message: "Incorrect API key provided: sk-proj-****abcd. You can find your API key at https://platform.openai.com/account/api-keys.", type: "invalid_request_error", code: "invalid_api_key" } }, { status: 401 });
    throw new Error(`Unexpected URL ${url}`);
  };
  const { ok, api } = await connect(t, { fetchImpl });
  const options = await ok("list_tts_options");
  assert.match(options.tts.providers.openai.error, /The provider rejected OPENAI_API_KEY\. Check the key\./);
  assert.match(options.tts.providers.openai.error, /\[redacted\]/);
  const leaks = /\bsk-(?!SK")|\*{3}|realsecret/;
  for (const [label, value] of [
    ["list_tts_options", options], ["get_workspace", await ok("get_workspace")],
    ["/api/state", (await api("/api/state")).value], ["/api/models", (await api("/api/models")).value],
  ]) assert.doesNotMatch(JSON.stringify(value), leaks, label);
});

test("new plans inherit format language and duration while explicit values win", async (t) => {
  const { ok, api } = await connect(t);
  const initial = (await api("/api/state")).value.profiles.episodeProfiles[0];
  const format = (await ok("save_episode_format", { name: "French", speakerProfileId: initial.speakerProfileId, language: "fr-FR", targetMinutes: 12 })).format;
  const inherited = (await ok("save_plan", { name: "Inherited", episodeFormatId: format.id })).plan;
  assert.equal(inherited.language, "fr-FR");
  assert.equal(inherited.targetMinutes, 12);
  const created = await ok("save_plan", { name: "New format", episodeFormat: { name: "New", description: "Inherited defaults" }, episodes: [{ number: 1, title: "One" }] });
  const savedFormat = (await api("/api/state")).value.profiles.episodeProfiles.find((item) => item.id === created.createdEpisodeFormatId);
  assert.equal(created.plan.language, initial.language);
  assert.equal(savedFormat.language, initial.language);
  assert.equal(savedFormat.targetMinutes, initial.targetMinutes);
  const explicit = (await ok("save_plan", { name: "Explicit", episodeFormatId: format.id, language: "en-US", targetMinutes: 9 })).plan;
  assert.equal(explicit.language, "en-US");
  assert.equal(explicit.targetMinutes, 9);
  const updated = (await ok("save_plan", { id: inherited.id, name: "Updated" })).plan;
  assert.equal(updated.language, "fr-FR");
  assert.equal(updated.targetMinutes, 12);
  const rest = await api("/api/plans", { name: "REST inherited", episodeFormatId: format.id });
  assert.equal(rest.status, 201);
  assert.equal(rest.value.plan.language, "fr-FR");
  assert.equal(rest.value.plan.targetMinutes, 12);
});
