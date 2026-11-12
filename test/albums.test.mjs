import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { runProcess } from "../src/jobs.mjs";
import { fetch, silentWav, startTestServer, waitFor, withEnv } from "./helpers.mjs";

async function connect(t, options) {
  const server = await startTestServer(t, options);
  const token = (await readFile(join(server.rootDir, "mcp-token"), "utf8")).trim();
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => client.close());
  const ok = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.ok(!response.isError, `${name}: ${response.content?.[0]?.text}`);
    return response.structuredContent;
  };
  const fails = async (name, args, pattern) => {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(response.isError, true, `${name} should fail`);
    assert.match(response.content[0].text, pattern);
  };
  return { ...server, ok, fails };
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

async function episodes(ok, count, episodeProfileId = "episode-example-format") {
  const ids = [];
  for (let index = 0; index < count; index += 1) ids.push((await ok("create_episodes", { name: `Episode ${index + 1}`, episodeProfileId })).episodes[0].id);
  return ids;
}

// A real MP3 marked ready, without a TTS render.
async function fakeAudio(rootDir, episodeId) {
  const directory = join(rootDir, "data", "episodes", episodeId);
  await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", "0.3", "-codec:a", "libmp3lame", "-b:a", "64k", join(directory, "episode.mp3")]);
  const file = join(directory, "episode.json");
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), audioReady: true, status: "ready" }));
}

async function tags(rootDir, episodeId) {
  const output = await runProcess("ffprobe", ["-v", "error", "-show_entries", "format_tags:stream=codec_type", "-of", "json", join(rootDir, "data", "episodes", episodeId, "episode.mp3")]);
  const value = JSON.parse(output);
  return { ...(value.format?.tags || {}), streams: value.streams.map((stream) => stream.codec_type) };
}

test("save_album creates editions per language, validates membership, and reorders tracks", async (t) => {
  const { ok, fails, api } = await connect(t);
  const english = await episodes(ok, 3);
  await ok("save_episode_format", { name: "Formato", speakerProfileId: "speaker-example-hosts", language: "es-419", targetMinutes: 10 });
  const spanishFormat = (await ok("get_workspace")).formats.find((format) => format.language === "es-419").id;
  const spanish = await episodes(ok, 2, spanishFormat);

  const saved = await ok("save_album", { title: "Spill the Prompt", description: "A series.", editions: [{ language: "en-US", episodeIds: english }] });
  const albumId = saved.album.id;
  assert.equal(saved.album.revision, 0);
  assert.deepEqual(saved.album.editions[0].tracks.map((track) => [track.track, track.episodeId, track.name]), english.map((id, index) => [index + 1, id, `Episode ${index + 1}`]));
  assert.equal(saved.album.editions[0].displayTitle, "Spill the Prompt");

  await fails("save_album", { id: albumId, editions: [{ language: "es-419", episodeIds: [english[0]] }] }, /is in en-US, not es-419/);
  await fails("save_album", { id: albumId, editions: [{ language: "en-US", episodeIds: [english[0]] }, { language: "en-US", episodeIds: [english[1]] }] }, /more than one en-US edition/);
  await fails("save_album", { id: albumId, editions: [{ language: "en-US", episodeIds: ["missing"] }] }, /Episode missing does not exist/);
  await fails("save_album", { id: albumId, editions: [{ language: "xx", episodeIds: [] }] }, /Unsupported language/);
  await fails("save_album", { title: "Other", editions: [{ language: "en-US", episodeIds: [english[0]] }] }, /already in album "Spill the Prompt"/);
  await fails("save_album", { id: albumId, expectedRevision: 5, title: "Stale" }, /changed after you read it/);
  await fails("save_album", { editions: [] }, /Album title is required/);
  const conflict = await api("/api/albums", { title: "Other", editions: [{ language: "en-US", episodeIds: [english[0]] }] });
  assert.equal(conflict.status, 409);
  assert.equal((await api("/api/albums", { title: "Other", editions: [{ language: "en-US", episodeIds: ["missing"] }] })).status, 400);

  const updated = await ok("save_album", { id: albumId, expectedRevision: 0, editions: [
    { language: "en-US", episodeIds: [english[2], english[0], english[1]] },
    { language: "es-419", title: "Spill the Prompt (Español)", episodeIds: spanish },
  ] });
  assert.equal(updated.album.revision, 1);
  assert.equal(updated.album.title, "Spill the Prompt", "omitted fields keep their saved values");
  assert.deepEqual(updated.album.editions[0].episodeIds, [english[2], english[0], english[1]]);
  assert.equal(updated.album.editions[1].displayTitle, "Spill the Prompt (Español)");

  const workspace = await ok("get_workspace");
  assert.deepEqual(workspace.albums, [{ id: albumId, title: "Spill the Prompt", revision: 1, hasCover: false, editions: [{ language: "en-US", title: "Spill the Prompt", tracks: 3 }, { language: "es-419", title: "Spill the Prompt (Español)", tracks: 2 }] }]);
  assert.deepEqual((await ok("get_episode", { id: english[0] })).album, { id: albumId, title: "Spill the Prompt", language: "en-US", track: 2 });
  assert.equal((await api(`/api/albums/${albumId}`)).value.album.editions.length, 2);
  assert.equal((await api("/api/state")).value.albums.length, 1);

  await ok("delete_episode", { id: english[0] });
  assert.deepEqual((await ok("get_album", { id: albumId })).album.editions[0].episodeIds, [english[2], english[1]]);

  const deleted = await ok("delete_album", { id: albumId });
  assert.equal(deleted.deleted, true);
  await fails("get_album", { id: albumId }, /Album not found/);
  const kept = await ok("get_episode", { id: english[1] });
  assert.equal(kept.episode.id, english[1], "deleting an album keeps its episodes");
  assert.equal(kept.album, undefined);
});

test("album covers check magic bytes and size, and serve the image", async (t) => {
  const { ok, fails, api, baseUrl } = await connect(t);
  const { album } = await ok("save_album", { title: "Covers" });
  const put = (body, type) => fetch(`${baseUrl}/api/albums/${album.id}/cover`, { method: "PUT", headers: { "Content-Type": type }, body });

  await fails("set_album_cover", { albumId: album.id, imageBase64: Buffer.from("not a png at all").toString("base64"), mimeType: "image/png" }, /not a valid PNG/);
  await fails("set_album_cover", { albumId: album.id, imageBase64: PNG.toString("base64"), mimeType: "image/jpeg" }, /not a valid JPEG/);
  await fails("set_album_cover", { albumId: album.id, imageBase64: Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]).toString("base64"), mimeType: "image/png" }, /Too big: expected string/);
  await fails("set_album_cover", { albumId: album.id }, /Give imageBase64 and mimeType/);
  const tooLarge = await put(Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]), "image/png");
  assert.equal(tooLarge.status, 400);
  assert.match((await tooLarge.json()).error, /exceeds 2 MB/);
  assert.equal((await put(PNG, "image/gif")).status, 400);

  const set = await ok("set_album_cover", { albumId: album.id, imageBase64: PNG.toString("base64"), mimeType: "image/png" });
  assert.deepEqual(set.album.cover, { file: "cover.png", mimeType: "image/png" });
  assert.doesNotMatch(JSON.stringify(set), new RegExp(PNG.toString("base64").slice(0, 12)), "the image data is never echoed");
  assert.equal(set.album.coverUrl, `/covers/${album.id}`);
  assert.equal((await api(`/api/albums/${album.id}/cover`)).status, 404, "GET moved to the capability URL");
  const image = await globalThis.fetch(`${baseUrl}${set.album.coverUrl}`);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  assert.equal((await put(jpeg, "image/jpeg")).status, 200);
  assert.deepEqual(Buffer.from(await (await fetch(`${baseUrl}${set.album.coverUrl}`)).arrayBuffer()), jpeg);

  assert.equal((await ok("set_album_cover", { albumId: album.id, remove: true })).album.cover, null);
  assert.equal((await api(`/covers/${album.id}`)).status, 404);
});

test("album changes re-tag rendered MP3s with a stream copy, and leaving the album drops the album tags", async (t) => {
  const { ok, rootDir } = await connect(t);
  const [first, second] = await episodes(ok, 2);
  await fakeAudio(rootDir, first);
  await fakeAudio(rootDir, second);
  const before = await runProcess("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", join(rootDir, "data", "episodes", second, "episode.mp3")]);

  const { album } = await ok("save_album", { title: "Tagged", editions: [{ language: "en-US", title: "Tagged (English)", episodeIds: [first, second] }] });
  let value = await tags(rootDir, second);
  assert.equal(value.album, "Tagged (English)");
  assert.equal(value.track, "2/2");
  assert.equal(value.title, "Episode 2");
  assert.equal(value.genre, "Podcast");
  assert.equal(value.language, "eng");
  assert.ok(value.artist);
  assert.equal(await runProcess("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", join(rootDir, "data", "episodes", second, "episode.mp3")]), before, "the audio is copied, not re-encoded");

  // A tiny real PNG, so ffmpeg can attach it.
  const png = join(rootDir, "cover.png");
  await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=8x8", "-frames:v", "1", png]);
  await ok("set_album_cover", { albumId: album.id, imageBase64: (await readFile(png)).toString("base64"), mimeType: "image/png" });
  assert.deepEqual((await tags(rootDir, first)).streams.sort(), ["audio", "video"]);

  await ok("save_album", { id: album.id, editions: [{ language: "en-US", episodeIds: [second] }] });
  value = await tags(rootDir, first);
  assert.equal(value.album, undefined);
  assert.equal(value.track, undefined);
  assert.equal(value.title, "Episode 1");
  assert.deepEqual(value.streams, ["audio"]);
  assert.equal((await tags(rootDir, second)).track, "1/1");
});

test("a render of an album episode writes the album tags", async (t) => {
  withEnv(t, { ELEVENLABS_API_KEY: "test-eleven-key" });
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/v1/models")) return Response.json([{ model_id: "eleven_v3", name: "Eleven v3", can_do_text_to_speech: true }]);
    if (String(url).includes("/v2/voices")) return Response.json({ voices: [{ voice_id: "voice-en", name: "Voice" }], has_more: false });
    if (String(url).includes("/text-to-speech/")) return new Response(silentWav(24_000, 1, 0.3), { headers: { "Content-Type": "audio/wav" } });
    throw new Error(`Unexpected URL ${url}`);
  };
  const { ok, api, rootDir } = await connect(t, { fetchImpl });
  const state = (await api("/api/state")).value;
  state.config.providers.elevenlabs.activeModels = { eleven_v3: { tts: true } };
  assert.equal((await api("/api/config", state.config, "PUT")).status, 200);
  await ok("save_host_profile", { id: "speaker-example-hosts", voiceModel: "eleven_v3", speakers: [{ name: "Alex", voiceId: "voice-en" }, { name: "Sam", voiceId: "voice-en" }] });
  const [episodeId] = await episodes(ok, 1);
  await ok("save_album", { title: "Rendered", editions: [{ language: "en-US", episodeIds: [episodeId] }] });
  const { job } = await ok("save_script", { episodeId, script: "## One\nAlex: Hello.\nSam: Hi.", render: true });
  const done = await waitFor(async () => {
    const { job: current } = await ok("get_job", { jobId: job.id });
    return ["completed", "failed"].includes(current.status) && current;
  }, 30_000);
  assert.equal(done.status, "completed", done.error);
  const value = await tags(rootDir, episodeId);
  assert.equal(value.album, "Rendered");
  assert.equal(value.track, "1/1");
});
