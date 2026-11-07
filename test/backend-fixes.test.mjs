import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeAudioAsWav } from "../src/app.mjs";
import { DEFAULT_DATA } from "../src/defaults.mjs";
import { silentWav, startTestServer, waitFor } from "./helpers.mjs";

for (const name of ["MIMO_API_KEY", "ELEVENLABS_API_KEY", "OPENAI_API_KEY", "CHATTERBOX_API_KEY", "TYPESAFE_API_KEY"]) process.env[name] = `backend-test-${name}`;

const start = (t, options = {}, prepare) => startTestServer(t, { fetchImpl: async () => Response.json({ data: [] }), ...options }, prepare);

test("plan write preconditions reject an old tab and all successful writes advance the stamp", async (t) => {
  const { api } = await start(t);
  const original = (await api("/api/plans", { name: "Original" })).value.plan;
  t.mock.method(Date, "now", () => Date.parse(original.updatedAt));
  const first = await api(`/api/plans/${original.id}`, { ...original, name: "New saved work", expectedUpdatedAt: original.updatedAt }, "PUT");
  assert.equal(first.status, 200);
  assert.equal(Date.parse(first.value.plan.updatedAt), Date.parse(original.updatedAt) + 1);
  const stale = await api(`/api/plans/${original.id}`, { ...original, name: "Old tab", expectedUpdatedAt: original.updatedAt }, "PUT");
  assert.equal(stale.status, 409);
  assert.match(stale.value.error, /another tab/);
  assert.equal((await api(`/api/plans/${original.id}`)).value.plan.name, "New saved work");
  const next = await api(`/api/plans/${original.id}`, { ...first.value.plan, name: "Next", expectedUpdatedAt: first.value.plan.updatedAt }, "PUT");
  assert.equal(next.status, 200);
  assert.equal(Date.parse(next.value.plan.updatedAt), Date.parse(first.value.plan.updatedAt) + 1);
  assert.equal((await api(`/api/plans/${original.id}`, { ...next.value.plan, name: "Old HTTP client" }, "PUT")).status, 200);
});

test("Hosts deletion returns pre-delete revision evidence for a safe own-tab Format rebase", async (t) => {
  const { api } = await start(t);
  const profiles = (await api("/api/state")).value.profiles;
  const deletedId = profiles.speakerProfiles[0].id;
  profiles.speakerProfiles.push({ ...structuredClone(profiles.speakerProfiles[0]), id: "fallback-hosts", name: "Fallback" });
  const saved = await api("/api/profiles", profiles, "PUT");
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  const before = saved.value.profiles;
  const result = await api(`/api/speaker-profiles/${deletedId}`, undefined, "DELETE");
  assert.equal(result.status, 200);
  assert.deepEqual(result.value.beforeRevisions, {
    speakerProfiles: Object.fromEntries(before.speakerProfiles.filter((profile) => profile.id !== deletedId).map((profile) => [profile.id, profile.revision ?? 0])),
    episodeProfiles: Object.fromEntries(before.episodeProfiles.map((profile) => [profile.id, profile.revision ?? 0])),
  });
  const format = result.value.profiles.episodeProfiles[0];
  assert.equal(format.speakerProfileId, "fallback-hosts");
  assert.equal(format.revision, (before.episodeProfiles[0].revision ?? 0) + 1);
  assert.equal(result.value.profiles.speakerProfiles[0].revision, before.speakerProfiles[1].revision ?? 0);
});

test("new reserved connection IDs are rejected", async (t) => {
  const { api } = await start(t);
  const config = (await api("/api/config")).value;
  for (const id of ["openai", "chatterbox"]) {
    const result = await api("/api/config", { ...config, compatibleConnections: [{ id, name: "Custom", baseUrl: "https://custom.invalid/v1", activeModels: {} }] }, "PUT");
    assert.equal(result.status, 400);
    assert.match(result.value.error, /reserved/);
  }
});

test("saved reserved connection IDs use their custom endpoints and activation maps", async (t) => {
  for (const [id, ttsModel] of [["openai", "tts-1"], ["chatterbox", "chatterbox-turbo"]]) {
    const calls = [];
    const { api } = await start(t, { fetchImpl: async (url, options = {}) => {
      const target = String(url);
      if (target === "https://custom.invalid/v1/models") return Response.json({ data: [{ id: ttsModel, capabilities: { tts: true } }] });
      if (target === "https://custom.invalid/v1/audio/speech") { calls.push(target); const body = JSON.parse(options.body); assert.equal(body.response_format, "mp3"); assert.equal(body.exaggeration, undefined); return new Response(silentWav(), { headers: { "Content-Type": "audio/wav" } }); }
      return Response.json({ data: [] });
    } }, async (root) => {
      await mkdir(join(root, "data"), { recursive: true });
      const profiles = structuredClone(DEFAULT_DATA);
      profiles.speakerProfiles[0].voiceModel = `compat:${id}:${ttsModel}`;
      for (const speaker of profiles.speakerProfiles[0].speakers) speaker.voiceId = "custom-voice";
      await writeFile(join(root, "data", "profiles.json"), JSON.stringify(profiles));
      await writeFile(join(root, "config.json"), JSON.stringify({ compatibleConnections: [{ id, name: "Legacy", baseUrl: "https://custom.invalid/v1", activeModels: {} }] }));
    });
    const state = (await api("/api/state")).value;
    assert.equal(state.config.compatibleConnections[0].activeModels[ttsModel].tts, true);
    const provider = (await api("/api/models")).value.providers[id];
    assert.equal(provider.status, "error");
    assert.match(provider.error, /reserved ID/);
    const preview = await api("/api/preview", { episodeProfileId: state.profiles.episodeProfiles[0].id, speakerProfileId: state.profiles.speakerProfiles[0].id, speakerIndex: 0, text: "Custom speech." });
    assert.equal(preview.status, 200, JSON.stringify(preview.value));
    assert.deepEqual(calls, ["https://custom.invalid/v1/audio/speech"]);
  }
});

test("ElevenLabs honors discovered legacy limits without cutting tags or SSML breaks", async (t) => {
  const requests = [];
  const { api } = await start(t, { fetchImpl: async (url, options = {}) => {
    if (String(url) === "https://api.elevenlabs.io/v1/models") return Response.json(["eleven_v4", "eleven_v3", "eleven_multilingual_v2", "eleven_flash_v2_5"].map((model_id) => ({ model_id, can_do_text_to_speech: true, maximum_text_length_per_request: 60, languages: [{ language_id: "es", name: "Spanish" }] })));
    if (String(url).includes("/text-to-speech/")) { const body = JSON.parse(options.body); requests.push(body); assert.ok(body.text.length <= 60); return new Response(silentWav(), { headers: { "Content-Type": "audio/wav" } }); }
    return Response.json({ data: [] });
  } });
  const state = (await api("/api/state")).value;
  state.config.providers.elevenlabs.activeModels = Object.fromEntries(["eleven_v4", "eleven_v3", "eleven_multilingual_v2", "eleven_flash_v2_5"].map((id) => [id, { tts: true }]));
  assert.equal((await api("/api/config", state.config, "PUT")).status, 200);
  let profiles = state.profiles;
  for (const model of ["eleven_v4", "eleven_v3", "eleven_multilingual_v2", "eleven_flash_v2_5"]) {
    profiles.speakerProfiles[0].voiceModel = model;
    profiles.speakerProfiles[0].speakers[0].voiceId = "test-voice";
    const saved = await api("/api/profiles", profiles, "PUT");
    assert.equal(saved.status, 200);
    profiles = saved.value.profiles;
    const squareTags = ["eleven_v3", "eleven_v4"].includes(model);
    const text = squareTags ? "One [quietly and naturally] complete sentence. ".repeat(5).trim() : 'One sentence. <break time="0.5s" /> Next sentence. '.repeat(5).trim();
    const before = requests.length;
    const result = await api("/api/preview", { episodeProfileId: profiles.episodeProfiles[0].id, speakerProfileId: profiles.speakerProfiles[0].id, speakerIndex: 0, text, cue: "calm" });
    assert.equal(result.status, 200, JSON.stringify(result.value));
    const chunks = requests.slice(before);
    assert.ok(chunks.length > 1);
    assert.equal(chunks.map((chunk) => squareTags ? chunk.text.replace(/^\[calm\] /, "") : chunk.text).join(" "), text);
    for (const chunk of chunks) assert.equal((chunk.text.match(/\[/g) || []).length, (chunk.text.match(/\]/g) || []).length);
    for (const sentence of ["1 < 2, and this comparison is true. ", squareTags ? "1 < 2, and 3 > 1. " : '1 < 2. <break time="0.5s" /> 3 > 1. ']) {
      const comparison = sentence.repeat(5).trim();
      const comparisonStart = requests.length;
      const literal = await api("/api/preview", { episodeProfileId: profiles.episodeProfiles[0].id, speakerProfileId: profiles.speakerProfiles[0].id, speakerIndex: 0, text: comparison, cue: "calm" });
      assert.equal(literal.status, 200, JSON.stringify(literal.value));
      assert.equal(requests.slice(comparisonStart).map((chunk) => squareTags ? chunk.text.replace(/^\[calm\] /, "") : chunk.text).join(" "), comparison);
    }
  }
  const before = requests.length;
  const unsafe = await api("/api/preview", { episodeProfileId: profiles.episodeProfiles[0].id, speakerProfileId: profiles.speakerProfiles[0].id, speakerIndex: 0, text: `<prosody rate="slow">${"Word ".repeat(30)}</prosody>` });
  assert.equal(unsafe.status, 400);
  assert.match(unsafe.value.error, /cannot safely split SSML/);
  assert.equal(requests.length, before);
  const unsplittable = await api("/api/preview", { episodeProfileId: profiles.episodeProfiles[0].id, speakerProfileId: profiles.speakerProfiles[0].id, speakerIndex: 0, text: "x".repeat(61) });
  assert.equal(unsplittable.status, 400);
  assert.equal(requests.length, before);
});

test("empty normalized WAV frames fail conversion, preview, and a multi-turn job without publishing", async (t) => {
  let returnEmpty = true;
  const calls = [];
  const { api, rootDir } = await start(t, { fetchImpl: async (url, options = {}) => {
    if (String(url) === "https://api.elevenlabs.io/v1/models") return Response.json([{ model_id: "eleven_v3", can_do_text_to_speech: true, languages: [{ language_id: "es", name: "Spanish" }] }]);
    if (String(url).includes("/text-to-speech/")) { const text = JSON.parse(options.body).text; calls.push(text); return new Response(silentWav(24_000, 1, returnEmpty && text.includes("EMPTY") ? 0 : 0.01), { headers: { "Content-Type": "audio/wav" } }); }
    return Response.json({ data: [] });
  } });
  await assert.rejects(writeAudioAsWav({ bytes: silentWav(24_000, 1, 0), extension: "wav" }, join(rootDir, "empty.wav")), /empty WAV audio.*audio frame/);
  await assert.rejects(readFile(join(rootDir, "empty.wav")), { code: "ENOENT" });
  const state = (await api("/api/state")).value;
  state.config.providers.elevenlabs.activeModels = { eleven_v3: { tts: true } };
  assert.equal((await api("/api/config", state.config, "PUT")).status, 200);
  state.profiles.speakerProfiles[0].voiceModel = "eleven_v3";
  state.profiles.speakerProfiles[0].speakers = [{ ...state.profiles.speakerProfiles[0].speakers[0], voiceId: "test-voice" }];
  assert.equal((await api("/api/profiles", state.profiles, "PUT")).status, 200);
  const preview = await api("/api/preview", { episodeProfileId: state.profiles.episodeProfiles[0].id, speakerProfileId: state.profiles.speakerProfiles[0].id, speakerIndex: 0, text: "EMPTY turn." });
  assert.equal(preview.status, 502);
  assert.match(preview.value.error, /unsupported or invalid audio/);
  const episode = (await api("/api/episodes", { name: "Empty turn", episodeProfileId: state.profiles.episodeProfiles[0].id })).value;
  const speaker = state.profiles.speakerProfiles[0].speakers[0].name;
  assert.equal((await api(`/api/episodes/${episode.id}/transcript`, { transcript: `## Segmento 1\n${speaker}: EMPTY first turn.\n${speaker}: Valid second turn.` }, "PUT")).status, 200);
  const queued = await api(`/api/episodes/${episode.id}/render`, {});
  assert.equal(queued.status, 202);
  const job = await waitFor(async () => { const current = (await api("/api/jobs")).value.jobs.find((item) => item.id === queued.value.job.id); return current?.status === "failed" && current; });
  assert.match(job.error, /empty WAV audio/);
  assert.equal((await api(`/api/episodes/${episode.id}`)).value.audioReady, false);
  await assert.rejects(readFile(join(rootDir, "data", "episodes", episode.id, "episode.mp3")), { code: "ENOENT" });
  returnEmpty = false;
  const valid = await api(`/api/episodes/${episode.id}/render`, {});
  const completed = await waitFor(async () => { const current = (await api("/api/jobs")).value.jobs.find((item) => item.id === valid.value.job.id); return ["failed", "completed"].includes(current?.status) && current; });
  assert.equal(completed.status, "completed", completed.error);
  const mp3Path = join(rootDir, "data", "episodes", episode.id, "episode.mp3");
  const previousMp3 = await readFile(mp3Path);
  const clips = join(rootDir, "data", "episodes", episode.id, "clips");
  const turnClips = (await readdir(clips)).filter((name) => /^[a-f0-9]+\.wav$/.test(name));
  assert.equal(turnClips.length, 2);
  for (const name of turnClips) await writeFile(join(clips, name), silentWav(24_000, 1, 0));
  returnEmpty = true;
  const before = calls.length;
  const retry = await api(`/api/episodes/${episode.id}/render`, {});
  await waitFor(async () => (await api("/api/jobs")).value.jobs.find((item) => item.id === retry.value.job.id)?.status === "failed");
  assert.equal(calls.length, before + 1, "an empty cached clip must be synthesized again");
  assert.deepEqual(await readFile(mp3Path), previousMp3, "a failed retry must not replace an existing render");
  assert.equal((await api(`/api/episodes/${episode.id}`)).value.audioReady, true);
});

test("single-clip normalization checks the normalized byte limit before publishing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "podcast-normalized-size-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "oversized.wav");
  const originalStat = fs.stat;
  t.mock.method(fs, "stat", (path, ...options) => String(path) === `${output}.tmp.wav` ? Promise.resolve({ size: 128 * 1024 * 1024 + 1 }) : originalStat(path, ...options));
  syncBuiltinESMExports();
  try {
    await assert.rejects(writeAudioAsWav({ bytes: silentWav(), extension: "wav" }, output), /Normalized TTS turn exceeds 134217728 byte limit/);
    await assert.rejects(readFile(output), { code: "ENOENT" });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("legacy ElevenLabs models use their documented request limits when discovery omits them", async (t) => {
  const limits = { eleven_v3: 5_000, eleven_multilingual_v2: 10_000, eleven_flash_v2_5: 40_000 };
  const requests = [];
  const { api } = await start(t, { fetchImpl: async (url, options = {}) => {
    if (String(url) === "https://api.elevenlabs.io/v1/models") return Response.json(Object.keys(limits).map((model_id) => ({ model_id, can_do_text_to_speech: true, languages: [{ language_id: "es", name: "Spanish" }] })));
    if (String(url).includes("/text-to-speech/")) { const body = JSON.parse(options.body); requests.push(body); assert.ok(body.text.length <= limits[body.model_id]); return new Response(silentWav(), { headers: { "Content-Type": "audio/wav" } }); }
    return Response.json({ data: [] });
  } });
  const state = (await api("/api/state")).value;
  state.config.providers.elevenlabs.activeModels = Object.fromEntries(Object.keys(limits).map((id) => [id, { tts: true }]));
  assert.equal((await api("/api/config", state.config, "PUT")).status, 200);
  let profiles = state.profiles;
  for (const [model, maximum] of Object.entries(limits)) {
    profiles.speakerProfiles[0].voiceModel = model;
    profiles.speakerProfiles[0].speakers[0].voiceId = "test-voice";
    profiles = (await api("/api/profiles", profiles, "PUT")).value.profiles;
    const episode = (await api("/api/episodes", { name: model, episodeProfileId: profiles.episodeProfiles[0].id })).value;
    const text = "Short sentence. ".repeat(Math.ceil((maximum + 100) / 16)).trim();
    assert.ok(text.length > maximum);
    assert.equal((await api(`/api/episodes/${episode.id}/transcript`, { transcript: `## Segmento 1\n${profiles.speakerProfiles[0].speakers[0].name} [calm]: ${text}` }, "PUT")).status, 200);
    const before = requests.length;
    const queued = await api(`/api/episodes/${episode.id}/render`, {});
    assert.equal(queued.status, 202);
    const job = await waitFor(async () => { const current = (await api("/api/jobs")).value.jobs.find((item) => item.id === queued.value.job.id); return ["failed", "completed"].includes(current?.status) && current; });
    assert.equal(job.status, "completed", job.error);
    const chunks = requests.slice(before);
    assert.ok(chunks.length > 1);
    assert.equal(chunks.map((chunk) => model === "eleven_v3" ? chunk.text.replace(/^\[calm\] /, "") : chunk.text).join(" "), text);
  }
});
