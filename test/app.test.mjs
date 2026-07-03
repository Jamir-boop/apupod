import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  clipCacheKey,
  createPodcastServer,
  parseTranscript,
  transcriptSpeakerRule,
  transcriptToMarkdown,
  validateOutline,
  validateProfileData,
  validateTranscriptJson,
  writeAudioAsWav,
} from "../app.mjs";
import { DEFAULT_DATA } from "../defaults.mjs";

const speakers = DEFAULT_DATA.speakerProfiles[0].speakers;
const execFileAsync = promisify(execFile);

async function waitFor(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Condition not met within ${timeoutMs} ms.`);
}

function silentWav(sampleRate = 24_000, channels = 1, durationSeconds = 0.01) {
  const samples = Math.round(sampleRate * durationSeconds);
  const blockAlign = channels * 2;
  const buffer = Buffer.alloc(44 + samples * blockAlign);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVE", 8);
  buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * blockAlign, 28); buffer.writeUInt16LE(blockAlign, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(samples * blockAlign, 40);
  return buffer;
}

function longText(label, words = 225) {
  return `${label} ${"word ".repeat(words)}`.trim();
}

test("default profiles are valid", () => {
  assert.equal(validateProfileData(structuredClone(DEFAULT_DATA)), true);
});

test("speaker profiles accept 1 to 4 speakers", () => {
  const solo = structuredClone(DEFAULT_DATA);
  solo.speakerProfiles[0].speakers = [solo.speakerProfiles[0].speakers[0]];
  assert.equal(validateProfileData(solo), true);
  assert.equal(parseTranscript("## Segmento 1\nValeria: Hola.", solo.speakerProfiles[0].speakers, 1).segments[0].turns.length, 1);

  const panel = structuredClone(DEFAULT_DATA);
  panel.speakerProfiles[0].speakers = Array.from({ length: 4 }, (_, index) => ({
    ...panel.speakerProfiles[0].speakers[index % 2],
    name: `Speaker ${index + 1}`,
  }));
  assert.equal(validateProfileData(panel), true);

  const empty = structuredClone(DEFAULT_DATA);
  empty.speakerProfiles[0].speakers = [];
  assert.throws(() => validateProfileData(empty), /1 to 4 speakers/);
  panel.speakerProfiles[0].speakers.push({ ...panel.speakerProfiles[0].speakers[0], name: "Speaker 5" });
  assert.throws(() => validateProfileData(panel), /1 to 4 speakers/);

  const invalidLanguage = structuredClone(DEFAULT_DATA);
  invalidLanguage.episodeProfiles[0].language = "made-up";
  assert.throws(() => validateProfileData(invalidLanguage), /Unsupported language/);

  const invalidAccent = structuredClone(DEFAULT_DATA);
  invalidAccent.speakerProfiles[0].speakers[0].accent = "x".repeat(101);
  assert.throws(() => validateProfileData(invalidAccent), /accent must contain at most 100 characters/);

  const invalidChatterbox = structuredClone(DEFAULT_DATA);
  invalidChatterbox.speakerProfiles[0].speakers[0].chatterboxCfgWeight = 1.1;
  assert.throws(() => validateProfileData(invalidChatterbox), /Chatterbox CFG weight must be a number from 0 to 1/);

  const spacedName = structuredClone(DEFAULT_DATA);
  spacedName.speakerProfiles[0].speakers[0].name = "  Valeria  ";
  validateProfileData(spacedName);
  assert.equal(spacedName.speakerProfiles[0].speakers[0].name, "Valeria");
});

test("transcript leadership follows configured speaker count", () => {
  assert.match(transcriptSpeakerRule(["Ana"]), /Use only Ana/);
  assert.match(transcriptSpeakerRule(["Ana", "Luis", "Sara"]), /^Ana is the lead host/);
  assert.doesNotMatch(transcriptSpeakerRule(["Ana", "Luis"]), /Valeria/);
});

test("structured transcript converts to validated Markdown", () => {
  const value = {
    title: "Episode",
    segments: Array.from({ length: 5 }, (_, index) => ({
      number: index + 1,
      title: `Part ${index + 1}`,
      turns: [
        { speaker: "Valeria", delivery: "cálida ] [ natural", text: `Idea ${index + 1}` },
        { speaker: "Diego", delivery: "humor seco", text: `Reaction ${index + 1}` },
      ],
    })),
  };
  assert.equal(validateTranscriptJson(value, 5, ["Valeria", "Diego"]), true);
  const markdown = transcriptToMarkdown(value);
  const parsed = parseTranscript(markdown, speakers, 5);
  assert.equal(parsed.segments.length, 5);
  assert.deepEqual(parsed.segments[0].turns[0], { speaker: "Valeria", delivery: "cálida natural", text: "Idea 1" });
});

test("transcript rejects unknown syntax and wrong segment count", () => {
  assert.throws(() => parseTranscript("## Segmento 1\nNarrator: hello", speakers, 1), /Invalid transcript line 2/);
  assert.throws(() => parseTranscript("## Segmento 1\nValeria: hello", speakers, 5), /exactly 5 segments/);
});

test("outline validation enforces exact ordered segments", () => {
  const outline = { segments: Array.from({ length: 5 }, (_, index) => ({ number: index + 1, title: "Title", points: ["Point"] })) };
  assert.equal(validateOutline(outline, 5), true);
  outline.segments[2].number = 9;
  assert.throws(() => validateOutline(outline, 5), /segment 3 is invalid/);
});

test("clip cache changes when delivery changes", () => {
  const base = { model: "mimo-v2.5-tts", voice: "Chloe", style: "warm", cue: "calm", text: "Hola" };
  assert.equal(clipCacheKey(base), clipCacheKey({ ...base }));
  assert.notEqual(clipCacheKey(base), clipCacheKey({ ...base, cue: "excited" }));
  assert.notEqual(clipCacheKey(base), clipCacheKey({ ...base, model: "eleven_v3" }));
});

test("ElevenLabs MP3 clips normalize to 24 kHz mono WAV", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "podcast-audio-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source.mp3");
  const output = join(directory, "output.wav");
  await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-t", "0.05", "-codec:a", "libmp3lame", source,
  ], { windowsHide: true });
  await writeAudioAsWav({ bytes: await readFile(source), extension: "mp3", contentType: "audio/mpeg" }, output);
  const wav = await readFile(output);
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 24_000);

  const wavOutput = join(directory, "wav-output.wav");
  await writeAudioAsWav({ bytes: silentWav(44_100, 2), extension: "wav", contentType: "audio/wav" }, wavOutput);
  const normalized = await readFile(wavOutput);
  assert.equal(normalized.readUInt16LE(22), 1);
  assert.equal(normalized.readUInt32LE(24), 24_000);
});

test("ElevenLabs voices and preview use server-side key", { concurrency: false }, async (t) => {
  const oldKey = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = "test-eleven-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = oldKey;
  });

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/v1/models")) {
      return Response.json([{ model_id: "eleven_v3", name: "Eleven v3", can_do_text_to_speech: true }]);
    }
    if (String(url).includes("/v2/voices")) {
      return new Response(JSON.stringify({
        voices: [{
          voice_id: "voice-es", name: "Española", labels: { language: "es", accent: "Colombian" }, ignored: "secret",
          verified_languages: [{ language: "es", locale: "es-CO", accent: "Colombian", preview_url: "secret-url" }],
        }],
        has_more: false,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(Buffer.from("fake-mp3"), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  };

  const rootDir = await mkdtemp(join(tmpdir(), "podcast-builder-eleven-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const server = await createPodcastServer({ rootDir, fetchImpl });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const initialState = await (await fetch(`${baseUrl}/api/state`)).json();
  initialState.config.providers.elevenlabs.activeModels = { eleven_v3: { text: false, tts: true } };
  let response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(initialState.config) });
  assert.equal(response.status, 200);
  const profiles = initialState.profiles;
  profiles.speakerProfiles[0].voiceModel = "eleven_v3";
  profiles.speakerProfiles[0].speakers = [{
    ...profiles.speakerProfiles[0].speakers[0],
    voiceId: "voice-es",
  }];
  response = await fetch(`${baseUrl}/api/profiles`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profiles),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/tts/elevenlabs/voices`);
  const voices = await response.json();
  assert.deepEqual(voices, { voices: [{
    id: "voice-es", name: "Española", labels: { language: "es", accent: "Colombian" },
    verifiedLanguages: [{ language: "es", locale: "es-CO", accent: "Colombian" }],
  }], hasMore: false });

  response = await fetch(`${baseUrl}/api/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ episodeProfileId: "episode-chisme-crianza", speakerProfileId: "speaker-chisme-crianza", speakerIndex: 0, text: "Hola", cue: "warm" }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "fake-mp3");

  const ttsCall = calls.find((call) => call.url.includes("/text-to-speech/"));
  const request = JSON.parse(ttsCall.options.body);
  assert.equal(ttsCall.options.headers["xi-api-key"], "test-eleven-key");
  assert.deepEqual(request, { text: "[warm] Hola", model_id: "eleven_v3", language_code: "es" });
  assert.doesNotMatch(JSON.stringify(voices), /test-eleven-key/);
});

test("local API seeds data and saves knowledge plus episode", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "podcast-builder-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await mkdir(join(rootDir, "public"), { recursive: true });
  await writeFile(join(rootDir, "public", "index.html"), "<!doctype html><title>Test</title>");
  const server = await createPodcastServer({ rootDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  let response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'none'");

  response = await fetch(`${baseUrl}/api/state`);
  let state = await response.json();
  assert.equal(response.status, 200);
  assert.equal(state.profiles.episodeSeeds.length, 68);

  response = await fetch(`${baseUrl}/api/knowledge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ name: "blocked.md", content: "blocked" }),
  });
  assert.equal(response.status, 403);

  response = await fetch(`${baseUrl}/api/knowledge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "book.md", content: "# Chapter\nGrounded source." }),
  });
  const knowledge = await response.json();
  assert.equal(response.status, 201);

  response = await fetch(`${baseUrl}/api/episodes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Ep. 01 — Test",
      episodeProfileId: "episode-chisme-crianza",
      knowledgeBaseId: knowledge.id,
      additionalInstructions: "Stay focused.",
    }),
  });
  const episode = await response.json();
  assert.equal(response.status, 201);
  assert.equal(episode.status, "draft");
  assert.equal(episode.episodeProfile.id, "episode-chisme-crianza");
  assert.equal(episode.speakerProfile.speakers[0].name, "Valeria");

  state.profiles.speakerProfiles[0].speakers[0].name = "Changed later";
  response = await fetch(`${baseUrl}/api/profiles`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.profiles),
  });
  assert.equal(response.status, 200);

  const transcript = Array.from({ length: 5 }, (_, index) =>
    `## Segmento ${index + 1} — Test\nValeria [cálida]: Idea ${index + 1}.\nDiego: Reacción ${index + 1}.`
  ).join("\n\n");
  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/transcript`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript }),
  });
  const saved = await response.json();
  assert.equal(response.status, 200);
  assert.equal(saved.status, "transcript_ready");
  assert.equal(saved.speakerProfile.speakers[0].name, "Valeria");

  state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.episodes.length, 1);
});

test("transcript word counts use locale-aware segmentation", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "podcast-word-count-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const server = await createPodcastServer({ rootDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  state.profiles.episodeProfiles[0].language = "zh-CN";
  await fetch(`${baseUrl}/api/profiles`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.profiles) });
  let response = await fetch(`${baseUrl}/api/knowledge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "book.md", content: "# Source" }) });
  const knowledge = await response.json();
  response = await fetch(`${baseUrl}/api/episodes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Chinese", episodeProfileId: "episode-chisme-crianza", knowledgeBaseId: knowledge.id }) });
  const episode = await response.json();
  const transcript = Array.from({ length: 5 }, (_, index) => `## Segmento ${index + 1}\nValeria: ä»Šå¤©æˆ‘ä»¬è®¨è®ºå®¶åº­æ²Ÿé€šã€‚`).join("\n\n");
  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/transcript`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript }) });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).transcriptWords > 5);
});

test("saved episode explicitly applies latest profiles atomically", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "podcast-profile-refresh-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const server = await createPodcastServer({ rootDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  let state = await (await fetch(`${baseUrl}/api/state`)).json();
  let response = await fetch(`${baseUrl}/api/knowledge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "book.md", content: "# Source" }),
  });
  const knowledge = await response.json();
  response = await fetch(`${baseUrl}/api/episodes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Snapshot test", episodeProfileId: "episode-chisme-crianza", knowledgeBaseId: knowledge.id }),
  });
  const episode = await response.json();
  const transcript = Array.from({ length: 5 }, (_, index) =>
    `## Segmento ${index + 1} — Test\nValeria: Idea ${index + 1}.\nDiego: Reaction ${index + 1}.`
  ).join("\n\n");
  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/transcript`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript }),
  });
  assert.equal(response.status, 200);

  const episodeFile = join(rootDir, "data", "episodes", episode.id, "episode.json");
  const rendered = JSON.parse(await readFile(episodeFile, "utf8"));
  rendered.audioReady = true;
  rendered.status = "ready";
  await writeFile(episodeFile, JSON.stringify(rendered, null, 2));
  await writeFile(join(rootDir, "data", "episodes", episode.id, "episode.mp3"), "existing-audio");

  state.profiles.episodeProfiles[0].targetMinutes = 19;
  state.profiles.speakerProfiles[0].description = "Updated speaker profile";
  response = await fetch(`${baseUrl}/api/profiles`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.profiles),
  });
  assert.equal(response.status, 200);
  state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.profiles.episodeProfiles[0].targetMinutes, 19);
  assert.equal((await (await fetch(`${baseUrl}/api/episodes/${episode.id}`)).json()).episodeProfile.targetMinutes, 18);

  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/profiles`, { method: "PUT" });
  const applied = await response.json();
  assert.equal(response.status, 200);
  assert.equal(applied.changed, true);
  assert.equal(applied.episode.episodeProfile.targetMinutes, 19);
  assert.equal(applied.episode.speakerProfile.description, "Updated speaker profile");
  assert.equal(applied.episode.audioReady, true);
  assert.match(applied.episode.audioUrl, /episode\.mp3$/);
  assert.equal(applied.episode.status, "ready");
  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/profiles`, { method: "PUT" });
  assert.equal((await response.json()).changed, false);

  response = await fetch(`${baseUrl}/api/episodes`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: episode.id, name: "Snapshot test", episodeProfileId: "episode-chisme-crianza", knowledgeBaseId: knowledge.id, additionalInstructions: "New generation guidance" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).audioReady, true);

  state.profiles.speakerProfiles[0].speakers[0].style = "Updated TTS direction";
  response = await fetch(`${baseUrl}/api/profiles`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.profiles),
  });
  assert.equal(response.status, 200);
  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/profiles`, { method: "PUT" });
  const ttsChanged = await response.json();
  assert.equal(ttsChanged.episode.audioReady, false);
  assert.equal(ttsChanged.episode.status, "transcript_ready");
  assert.equal((await readFile(join(rootDir, "data", "episodes", episode.id, "episode.mp3"), "utf8")), "existing-audio");

  state.profiles.episodeProfiles[0].numSegments = 6;
  response = await fetch(`${baseUrl}/api/profiles`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.profiles),
  });
  assert.equal(response.status, 200);
  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/profiles`, { method: "PUT" });
  assert.equal(response.status, 400);
  assert.equal((await (await fetch(`${baseUrl}/api/episodes/${episode.id}`)).json()).episodeProfile.numSegments, 5);

  const busy = JSON.parse(await readFile(episodeFile, "utf8"));
  busy.job = { status: "running" };
  await writeFile(episodeFile, JSON.stringify(busy, null, 2));
  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/profiles`, { method: "PUT" });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /active episode job/);
});

test("model catalog uses provider APIs without exposing keys", { concurrency: false }, async (t) => {
  const oldMimo = process.env.MIMO_API_KEY;
  const oldEleven = process.env.ELEVENLABS_API_KEY;
  process.env.MIMO_API_KEY = "test-mimo-key";
  process.env.ELEVENLABS_API_KEY = "test-eleven-key";
  t.after(() => {
    if (oldMimo === undefined) delete process.env.MIMO_API_KEY; else process.env.MIMO_API_KEY = oldMimo;
    if (oldEleven === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = oldEleven;
  });

  const fetchImpl = async (url) => {
    if (String(url).includes("xiaomimimo.com")) return Response.json({ data: [
      { id: "mimo-v2.5-pro" }, { id: "mimo-v2.5" }, { id: "mimo-v2.5-asr" },
      { id: "mimo-v2.5-tts" }, { id: "mimo-v2.5-tts-voiceclone" },
    ] });
    if (String(url).endsWith("/v1/models")) return Response.json([
      { model_id: "eleven_v3", name: "Eleven v3", can_do_text_to_speech: true, requires_alpha_access: false, languages: [{ language_id: "es", name: "Spanish" }, { language_id: "afr", name: "Afrikaans" }] },
      { model_id: "scribe_v2", name: "Scribe", can_do_text_to_speech: false },
    ]);
    throw new Error(`Unexpected URL ${url}`);
  };
  const rootDir = await mkdtemp(join(tmpdir(), "podcast-models-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const server = await createPodcastServer({ rootDir, fetchImpl });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const catalog = await waitFor(async () => {
    const value = await (await fetch(`${baseUrl}/api/models`)).json();
    return value.status === "ready" ? value : null;
  });
  assert.deepEqual(catalog.providers.mimo.textModels.map((model) => model.id), ["mimo-v2.5-pro"]);
  assert.deepEqual(catalog.providers.mimo.ttsModels.map((model) => model.id), ["mimo-v2.5-tts"]);
  assert.ok(catalog.providers.mimo.discoveredModels.some((model) => model.id === "mimo-v2.5"));
  assert.deepEqual(catalog.providers.elevenlabs.ttsModels, []);
  assert.deepEqual(catalog.providers.elevenlabs.discoveredModels.map((model) => model.id), ["eleven_v3"]);
  assert.ok(catalog.languages.some((language) => language.id === "es-419" && language.apiCode === "es"));
  assert.ok(!catalog.languages.some((language) => language.id === "afr"));
  assert.doesNotMatch(JSON.stringify(catalog), /test-(mimo|eleven)-key/);
});

test("transcript jobs return 202 and run through one FIFO queue", { concurrency: false }, async (t) => {
  const oldMimo = process.env.MIMO_API_KEY;
  const oldEleven = process.env.ELEVENLABS_API_KEY;
  process.env.MIMO_API_KEY = "test-mimo-key";
  delete process.env.ELEVENLABS_API_KEY;
  t.after(() => {
    if (oldMimo === undefined) delete process.env.MIMO_API_KEY; else process.env.MIMO_API_KEY = oldMimo;
    if (oldEleven === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = oldEleven;
  });

  let releaseOutline;
  const outlineGate = new Promise((resolve) => { releaseOutline = resolve; });
  t.after(() => releaseOutline());
  let chatCalls = 0;
  const chatRequests = [];
  const outline = { segments: Array.from({ length: 5 }, (_, index) => ({ number: index + 1, title: `Part ${index + 1}`, points: ["Point"] })) };
  const transcript = {
    title: "Episode",
    segments: Array.from({ length: 5 }, (_, index) => ({
      number: index + 1,
      title: `Part ${index + 1}`,
      turns: [
        { speaker: "Valeria", delivery: "warm", text: longText(`Idea ${index + 1}`) },
        { speaker: "Diego", delivery: "dry", text: longText(`Reaction ${index + 1}`) },
      ],
    })),
  };
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "mimo-v2.5-pro" }, { id: "mimo-v2.5-tts" }] });
    if (String(url).endsWith("/chat/completions")) {
      chatCalls += 1;
      chatRequests.push(JSON.parse(options.body));
      if (chatCalls === 1) await outlineGate;
      const content = chatCalls % 2 === 1 ? outline : transcript;
      return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const rootDir = await mkdtemp(join(tmpdir(), "podcast-jobs-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const server = await createPodcastServer({ rootDir, fetchImpl });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const profileData = (await (await fetch(`${baseUrl}/api/state`)).json()).profiles;
  profileData.episodeProfiles[0].language = "fr-FR";
  profileData.speakerProfiles[0].speakers[0].accent = "Québécois";
  let response = await fetch(`${baseUrl}/api/profiles`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profileData),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/knowledge`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "book.md", content: "# Grounded" }),
  });
  const knowledge = await response.json();
  const createEpisode = async (name) => (await (await fetch(`${baseUrl}/api/episodes`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, episodeProfileId: "episode-chisme-crianza", knowledgeBaseId: knowledge.id }),
  })).json());
  const first = await createEpisode("First");
  const second = await createEpisode("Second");

  const duplicateResponses = await Promise.all([
    fetch(`${baseUrl}/api/episodes/${first.id}/generate`, { method: "POST" }),
    fetch(`${baseUrl}/api/episodes/${first.id}/generate`, { method: "POST" }),
  ]);
  assert.deepEqual(duplicateResponses.map((item) => item.status).sort(), [202, 409]);
  response = await fetch(`${baseUrl}/api/episodes/${second.id}/generate`, { method: "POST" });
  assert.equal(response.status, 202);

  const active = await (await fetch(`${baseUrl}/api/jobs`)).json();
  assert.equal(active.jobs.find((job) => job.episodeId === first.id).status, "running");
  assert.equal(active.jobs.find((job) => job.episodeId === second.id).status, "queued");
  releaseOutline();

  const finished = await waitFor(async () => {
    const value = await (await fetch(`${baseUrl}/api/jobs`)).json();
    return value.jobs.filter((job) => [first.id, second.id].includes(job.episodeId)).every((job) => job.status === "completed") ? value : null;
  });
  assert.equal(finished.activeJobId, null);
  assert.equal(chatCalls, 4);
  assert.match(chatRequests[1].messages[1].content, /Write a natural transcript in French \(France\)/);
  assert.match(chatRequests[1].messages[1].content, /Accent: Québécois/);
  assert.match(chatRequests[1].messages[1].content, /NON-NEGOTIABLE LANGUAGE OVERRIDE/);
  assert.doesNotMatch(chatRequests[1].messages[1].content, /Write a natural Spanish transcript/);
  const saved = await (await fetch(`${baseUrl}/api/episodes/${second.id}`)).json();
  assert.equal(saved.status, "transcript_ready");
  assert.match(saved.transcript, /Valeria \[warm\]: Idea 1/);
});

test("short generated transcripts fail and can be retried", { concurrency: false }, async (t) => {
  const oldKey = process.env.MIMO_API_KEY;
  process.env.MIMO_API_KEY = "test-mimo-key";
  t.after(() => { if (oldKey === undefined) delete process.env.MIMO_API_KEY; else process.env.MIMO_API_KEY = oldKey; });

  let chatCalls = 0;
  const outline = { segments: Array.from({ length: 5 }, (_, index) => ({ number: index + 1, title: `Part ${index + 1}`, points: ["Point"] })) };
  const transcript = (long) => ({
    title: "Episode",
    segments: Array.from({ length: 5 }, (_, index) => ({
      number: index + 1,
      title: `Part ${index + 1}`,
      turns: [
        { speaker: "Valeria", delivery: "warm", text: long ? longText(`Idea ${index + 1}`) : "Short idea" },
        { speaker: "Diego", delivery: "dry", text: long ? longText(`Reaction ${index + 1}`) : "Short reaction" },
      ],
    })),
  });
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "mimo-v2.5-pro" }, { id: "mimo-v2.5-tts" }] });
    if (String(url).endsWith("/chat/completions")) {
      chatCalls += 1;
      return Response.json({ choices: [{ message: { content: JSON.stringify(chatCalls % 2 ? outline : transcript(chatCalls >= 4)) } }] });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const rootDir = await mkdtemp(join(tmpdir(), "podcast-transcript-retry-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const server = await createPodcastServer({ rootDir, fetchImpl });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let response = await fetch(`${baseUrl}/api/knowledge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "book.md", content: "# Source" }) });
  const knowledge = await response.json();
  response = await fetch(`${baseUrl}/api/episodes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Retry", episodeProfileId: "episode-chisme-crianza", knowledgeBaseId: knowledge.id }) });
  const episode = await response.json();

  await fetch(`${baseUrl}/api/episodes/${episode.id}/generate`, { method: "POST" });
  let result = await waitFor(async () => {
    const value = await (await fetch(`${baseUrl}/api/jobs`)).json();
    return value.jobs.find((job) => job.episodeId === episode.id)?.status === "failed" ? value : null;
  });
  assert.match(result.jobs.find((job) => job.episodeId === episode.id).error, /Transcript too short: 20 words/);
  assert.equal((await (await fetch(`${baseUrl}/api/episodes/${episode.id}`)).json()).transcript, "");

  await fetch(`${baseUrl}/api/episodes/${episode.id}/generate`, { method: "POST" });
  result = await waitFor(async () => {
    const value = await (await fetch(`${baseUrl}/api/jobs`)).json();
    return value.jobs.find((job) => job.episodeId === episode.id)?.status === "completed" ? value : null;
  });
  assert.equal(result.jobs.find((job) => job.episodeId === episode.id).status, "completed");
  assert.ok((await (await fetch(`${baseUrl}/api/episodes/${episode.id}`)).json()).transcriptWords >= 2250);
});

test("TTS jobs report progress and publish MP3", { concurrency: false }, async (t) => {
  const oldMimo = process.env.MIMO_API_KEY;
  const oldEleven = process.env.ELEVENLABS_API_KEY;
  process.env.MIMO_API_KEY = "test-mimo-key";
  delete process.env.ELEVENLABS_API_KEY;
  t.after(() => {
    if (oldMimo === undefined) delete process.env.MIMO_API_KEY; else process.env.MIMO_API_KEY = oldMimo;
    if (oldEleven === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = oldEleven;
  });
  let ttsCalls = 0;
  const ttsRequests = [];
  let wav = silentWav(24_000, 1, 45).toString("base64");
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "mimo-v2.5-pro" }, { id: "mimo-v2.5-tts" }] });
    if (String(url).endsWith("/chat/completions")) {
      ttsCalls += 1;
      ttsRequests.push(JSON.parse(options.body));
      return Response.json({ choices: [{ message: { audio: { data: wav } } }] });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const rootDir = await mkdtemp(join(tmpdir(), "podcast-tts-job-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const server = await createPodcastServer({ rootDir, fetchImpl });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  let response = await fetch(`${baseUrl}/api/knowledge`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "book.md", content: "# Grounded" }),
  });
  const knowledge = await response.json();
  response = await fetch(`${baseUrl}/api/episodes`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "TTS", episodeProfileId: "episode-chisme-crianza", knowledgeBaseId: knowledge.id }),
  });
  const episode = await response.json();
  const transcript = Array.from({ length: 5 }, (_, index) => `## Segmento ${index + 1}\nValeria [${index === 0 ? "quick" : "warm"}]: Idea ${index + 1}.${index === 0 ? "\nDiego [warm]: Quick reaction." : ""}`).join("\n\n");
  await fetch(`${baseUrl}/api/episodes/${episode.id}/transcript`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript }),
  });

  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/render`, { method: "POST" });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /MiMo preset TTS does not support Spanish/);

  const profiles = (await (await fetch(`${baseUrl}/api/state`)).json()).profiles;
  profiles.episodeProfiles[0].language = "en-US";
  profiles.episodeProfiles[0].targetMinutes = 5;
  profiles.speakerProfiles[0].speakers[0].accent = "British";
  response = await fetch(`${baseUrl}/api/profiles`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profiles),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/episodes`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: episode.id, name: "TTS", episodeProfileId: "episode-chisme-crianza", knowledgeBaseId: knowledge.id }),
  });
  assert.equal(response.status, 200);

  const clipsDir = join(rootDir, "data", "episodes", episode.id, "clips");
  await mkdir(clipsDir, { recursive: true });
  const unusedClip = join(clipsDir, `${"f".repeat(64)}.wav`);
  await writeFile(unusedClip, silentWav());

  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/render`, { method: "POST" });
  assert.equal(response.status, 202);
  const finished = await waitFor(async () => {
    const value = await (await fetch(`${baseUrl}/api/jobs`)).json();
    return value.jobs.find((job) => job.episodeId === episode.id)?.status === "completed" ? value : null;
  }, 30_000);
  const job = finished.jobs.find((item) => item.episodeId === episode.id);
  assert.equal(job.completed, 6);
  assert.equal(ttsCalls, 6);
  assert.match(ttsRequests[0].messages[0].content, /Required spoken language: English \(United States\) \(en-US\)/);
  assert.match(ttsRequests[0].messages[0].content, /Required accent: British/);
  const saved = await (await fetch(`${baseUrl}/api/episodes/${episode.id}`)).json();
  assert.equal(saved.status, "ready");
  assert.equal(saved.audioUrl, `/artifacts/${episode.id}/episode.mp3`);
  await assert.rejects(readFile(unusedClip), { code: "ENOENT" });

  const audioPath = join(rootDir, "data", "episodes", episode.id, "episode.mp3");
  const previousAudio = await readFile(audioPath);
  const { stdout: durationOutput } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", audioPath], { windowsHide: true });
  assert.ok(Number(durationOutput.trim()) >= 274);

  await rm(clipsDir, { recursive: true, force: true });
  wav = silentWav().toString("base64");
  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/render`, { method: "POST" });
  assert.equal(response.status, 202);
  const failed = await waitFor(async () => {
    const value = await (await fetch(`${baseUrl}/api/jobs`)).json();
    return value.jobs.find((item) => item.episodeId === episode.id)?.status === "failed" ? value : null;
  }, 30_000);
  assert.match(failed.jobs.find((item) => item.episodeId === episode.id).error, /Rendered audio too short/);
  const afterFailure = await (await fetch(`${baseUrl}/api/episodes/${episode.id}`)).json();
  assert.equal(afterFailure.audioReady, true);
  assert.equal(afterFailure.audioUrl, saved.audioUrl);
  assert.deepEqual(await readFile(audioPath), previousAudio);

  response = await fetch(`${baseUrl}${saved.audioUrl}`, { headers: { Range: "bytes=0-3" } });
  assert.equal(response.status, 206);
  assert.match(response.headers.get("content-range"), /^bytes 0-3\//);
  assert.equal((await response.arrayBuffer()).byteLength, 4);
  response = await fetch(`${baseUrl}${saved.audioUrl}`, { headers: { Range: "bytes=999999999-" } });
  assert.equal(response.status, 416);
});

test("server restart marks active jobs interrupted", { concurrency: false }, async (t) => {
  const oldMimo = process.env.MIMO_API_KEY;
  const oldEleven = process.env.ELEVENLABS_API_KEY;
  delete process.env.MIMO_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  t.after(() => {
    if (oldMimo === undefined) delete process.env.MIMO_API_KEY; else process.env.MIMO_API_KEY = oldMimo;
    if (oldEleven === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = oldEleven;
  });
  const rootDir = await mkdtemp(join(tmpdir(), "podcast-restart-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const server = await createPodcastServer({ rootDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let response = await fetch(`${baseUrl}/api/knowledge`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "book.md", content: "# Grounded" }),
  });
  const knowledge = await response.json();
  response = await fetch(`${baseUrl}/api/episodes`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Interrupted", episodeProfileId: "episode-chisme-crianza", knowledgeBaseId: knowledge.id }),
  });
  const episode = await response.json();
  await new Promise((resolve) => server.close(resolve));

  const episodePath = join(rootDir, "data", "episodes", episode.id, "episode.json");
  const stored = JSON.parse(await readFile(episodePath, "utf8"));
  const now = new Date().toISOString();
  stored.status = "generating";
  stored.job = { id: "stale-job", episodeId: episode.id, type: "transcript", status: "running", phase: "outline", queuedAt: now, updatedAt: now };
  await writeFile(episodePath, JSON.stringify(stored, null, 2));

  const restarted = await createPodcastServer({ rootDir });
  await new Promise((resolve) => restarted.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => restarted.close(resolve)));
  const saved = await (await fetch(`http://127.0.0.1:${restarted.address().port}/api/episodes/${episode.id}`)).json();
  assert.equal(saved.status, "failed");
  assert.equal(saved.job.status, "interrupted");
  assert.match(saved.lastError, /server restart/);
});

test("startup cleanup prunes obsolete artifacts and surfaces corrupt episodes", { concurrency: false }, async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "podcast-cleanup-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let server = await createPodcastServer({ rootDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let baseUrl = `http://127.0.0.1:${server.address().port}`;
  let response = await fetch(`${baseUrl}/api/knowledge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "book.md", content: "# Source" }) });
  const knowledge = await response.json();
  response = await fetch(`${baseUrl}/api/episodes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Healthy", episodeProfileId: "episode-chisme-crianza", knowledgeBaseId: knowledge.id }) });
  const episode = await response.json();
  const transcript = Array.from({ length: 5 }, (_, index) => `## Segmento ${index + 1}\nValeria: Idea ${index + 1}.`).join("\n\n");
  await fetch(`${baseUrl}/api/episodes/${episode.id}/transcript`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript }) });
  await new Promise((resolve) => server.close(resolve));

  const healthyDir = join(rootDir, "data", "episodes", episode.id);
  const clipsDir = join(healthyDir, "clips");
  await mkdir(clipsDir, { recursive: true });
  for (const name of ["outline.json", "transcript.json", "concat.txt"]) await writeFile(join(healthyDir, name), "obsolete");
  await writeFile(join(clipsDir, `${"e".repeat(64)}.wav`), silentWav());
  const corruptDir = join(rootDir, "data", "episodes", "corrupt-episode");
  await mkdir(corruptDir, { recursive: true });
  await writeFile(join(corruptDir, "episode.json"), "{bad json");
  await writeFile(join(corruptDir, "outline.json"), "preserve");

  server = await createPodcastServer({ rootDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  const corrupt = state.episodes.find((item) => item.id === "corrupt-episode");
  assert.equal(corrupt.status, "corrupt");
  assert.equal(corrupt.corrupt, true);
  for (const name of ["outline.json", "transcript.json", "concat.txt"]) await assert.rejects(readFile(join(healthyDir, name)), { code: "ENOENT" });
  await assert.rejects(readFile(join(clipsDir, `${"e".repeat(64)}.wav`)), { code: "ENOENT" });
  assert.equal(await readFile(join(corruptDir, "outline.json"), "utf8"), "preserve");

  state.config.providers.mimo.enabled = false;
  response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.config) });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /corrupt episode/);
});

test("TTS rejects missing FFmpeg before provider calls", { concurrency: false }, async (t) => {
  const oldMimo = process.env.MIMO_API_KEY;
  const oldEleven = process.env.ELEVENLABS_API_KEY;
  const oldOpenAi = process.env.OPENAI_API_KEY;
  delete process.env.MIMO_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    if (oldMimo === undefined) delete process.env.MIMO_API_KEY; else process.env.MIMO_API_KEY = oldMimo;
    if (oldEleven === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = oldEleven;
    if (oldOpenAi === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAi;
  });
  const rootDir = await mkdtemp(join(tmpdir(), "podcast-ffmpeg-check-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let providerCalls = 0;
  const server = await createPodcastServer({ rootDir, fetchImpl: async () => { providerCalls += 1; return Response.json({ data: [] }); } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let response = await fetch(`${baseUrl}/api/knowledge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "book.md", content: "# Source" }) });
  const knowledge = await response.json();
  response = await fetch(`${baseUrl}/api/episodes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "No FFmpeg", episodeProfileId: "episode-chisme-crianza", knowledgeBaseId: knowledge.id }) });
  const episode = await response.json();
  const transcript = Array.from({ length: 5 }, (_, index) => `## Segmento ${index + 1}\nValeria: Idea ${index + 1}.`).join("\n\n");
  await fetch(`${baseUrl}/api/episodes/${episode.id}/transcript`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript }) });
  const callsBeforeRender = providerCalls;
  const oldPath = process.env.Path;
  process.env.Path = "";
  try {
    response = await fetch(`${baseUrl}/api/episodes/${episode.id}/render`, { method: "POST" });
  } finally {
    if (oldPath === undefined) delete process.env.Path; else process.env.Path = oldPath;
  }
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /FFmpeg or FFprobe is unavailable/);
  assert.equal(providerCalls, callsBeforeRender);
});

test("built-in OpenAI discovers models and uses chat plus TTS endpoints", { concurrency: false }, async (t) => {
  const oldMimo = process.env.MIMO_API_KEY;
  const oldEleven = process.env.ELEVENLABS_API_KEY;
  const oldOpenAi = process.env.OPENAI_API_KEY;
  delete process.env.MIMO_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    if (oldMimo === undefined) delete process.env.MIMO_API_KEY; else process.env.MIMO_API_KEY = oldMimo;
    if (oldEleven === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = oldEleven;
    if (oldOpenAi === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAi;
  });

  const compatCalls = [];
  let chatCount = 0;
  const outline = { segments: Array.from({ length: 5 }, (_, index) => ({ number: index + 1, title: `Part ${index + 1}`, points: ["Point"] })) };
  const transcript = {
    title: "Compatible Episode",
    segments: Array.from({ length: 5 }, (_, index) => ({
      number: index + 1,
      title: `Part ${index + 1}`,
      turns: [
        { speaker: "Valeria", delivery: "warm", text: longText(`Idea ${index + 1}`) },
        { speaker: "Diego", delivery: "dry", text: longText(`Reaction ${index + 1}`) },
      ],
    })),
  };
  const fetchImpl = async (url, options = {}) => {
    compatCalls.push({ url: String(url), options });
    if (String(url).endsWith("/models")) {
      return Response.json({ data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o-mini-tts" }, { id: "whisper-1" }] });
    }
    if (String(url).endsWith("/chat/completions")) {
      chatCount += 1;
      return Response.json({ choices: [{ message: { content: JSON.stringify(chatCount === 1 ? outline : transcript) } }] });
    }
    if (String(url).endsWith("/audio/speech")) {
      return new Response(Buffer.from("compat-mp3"), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const rootDir = await mkdtemp(join(tmpdir(), "podcast-compat-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const server = await createPodcastServer({ rootDir, fetchImpl });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  let response = await fetch(`${baseUrl}/api/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      providers: {
        mimo: { baseUrl: "https://api.xiaomimimo.com/v1" },
        elevenlabs: {},
        openai: {
          baseUrl: "https://api.openai.com/v1",
          llmBaseUrl: "https://llm.example/v1",
          ttsBaseUrl: "https://tts.example/v1",
          modelsUrl: "https://catalog.example/v1/models",
          enabled: true,
          apiKey: "sk-openai-test",
          activeModels: {
            "gpt-4o-mini": { text: true, tts: false },
            "gpt-4o-mini-tts": { text: false, tts: true },
          },
        },
      },
      compatibleConnections: [],
    }),
  });
  const savedConfig = await response.json();
  assert.equal(response.status, 200);
  assert.equal(savedConfig.config.providers.mimo.hasApiKey, false);
  assert.equal(savedConfig.config.providers.openai.hasApiKey, true);
  assert.doesNotMatch(JSON.stringify(savedConfig), /sk-openai-test/);
  assert.ok(savedConfig.modelCatalog.providers.openai.textModels.some((model) => model.id === "compat:openai:gpt-4o-mini"));
  assert.ok(savedConfig.modelCatalog.providers.openai.ttsModels.some((model) => model.id === "compat:openai:gpt-4o-mini-tts"));

  const envFile = await readFile(join(rootDir, ".env"), "utf8");
  assert.match(envFile, /OPENAI_API_KEY=sk-openai-test/);

  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  state.profiles.episodeProfiles[0].outlineModel = "compat:openai:gpt-4o-mini";
  state.profiles.episodeProfiles[0].transcriptModel = "compat:openai:gpt-4o-mini";
  state.profiles.episodeProfiles[0].language = "en-US";
  state.profiles.speakerProfiles[0].voiceModel = "compat:openai:gpt-4o-mini-tts";
  state.profiles.speakerProfiles[0].speakers[0].voiceId = "alloy";
  state.profiles.speakerProfiles[0].speakers[1].voiceId = "alloy";
  response = await fetch(`${baseUrl}/api/profiles`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.profiles),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/knowledge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "book.md", content: "# Grounded" }),
  });
  const knowledge = await response.json();
  response = await fetch(`${baseUrl}/api/episodes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Compatible", episodeProfileId: "episode-chisme-crianza", knowledgeBaseId: knowledge.id }),
  });
  const episode = await response.json();

  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/generate`, { method: "POST" });
  assert.equal(response.status, 202);
  await waitFor(async () => {
    const value = await (await fetch(`${baseUrl}/api/jobs`)).json();
    return value.jobs.find((job) => job.episodeId === episode.id)?.status === "completed" ? value : null;
  });

  response = await fetch(`${baseUrl}/api/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ episodeProfileId: "episode-chisme-crianza", speakerProfileId: "speaker-chisme-crianza", speakerIndex: 0, text: "Hello there", cue: "warm" }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "compat-mp3");

  const chatRequest = compatCalls.find((call) => call.url.endsWith("/chat/completions"));
  assert.equal(chatRequest.url, "https://llm.example/v1/chat/completions");
  assert.equal(chatRequest.options.headers.Authorization, "Bearer sk-openai-test");
  assert.equal(JSON.parse(chatRequest.options.body).max_tokens, undefined);
  assert.equal(typeof JSON.parse(chatRequest.options.body).max_completion_tokens, "number");
  assert.match(JSON.parse(chatRequest.options.body).messages[1].content, /NON-NEGOTIABLE LANGUAGE OVERRIDE/);
  const ttsRequest = compatCalls.find((call) => call.url.endsWith("/audio/speech"));
  const ttsBody = JSON.parse(ttsRequest.options.body);
  assert.equal(ttsRequest.url, "https://tts.example/v1/audio/speech");
  assert.equal(ttsRequest.options.headers.Authorization, "Bearer sk-openai-test");
  assert.equal(ttsBody.model, "gpt-4o-mini-tts");
  assert.equal(ttsBody.voice, "alloy");
  assert.equal(ttsBody.input, "Hello there");
  assert.match(ttsBody.instructions, /Required spoken language: English \(United States\) \(en-US\)/);
});

test("compatible config owns env names and blocks referenced connection removal", { concurrency: false }, async (t) => {
  const oldMimo = process.env.MIMO_API_KEY;
  const oldOpenAi = process.env.OPENAI_API_KEY;
  process.env.MIMO_API_KEY = "test-mimo-key";
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    if (oldMimo === undefined) delete process.env.MIMO_API_KEY; else process.env.MIMO_API_KEY = oldMimo;
    if (oldOpenAi === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAi;
  });
  const rootDir = await mkdtemp(join(tmpdir(), "podcast-config-safety-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const server = await createPodcastServer({ rootDir, fetchImpl: async (url) => {
    if (String(url).includes("xiaomimimo.com")) return Response.json({ data: [{ id: "mimo-v2.5-pro" }, { id: "mimo-v2.5-tts" }] });
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "custom-tts" }] });
    throw new Error(`Unexpected URL ${url}`);
  } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const providers = { mimo: { baseUrl: "https://api.xiaomimimo.com/v1" }, elevenlabs: {}, openai: { baseUrl: "https://api.openai.com/v1", enabled: false } };

  let response = await fetch(`${baseUrl}/api/config`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providers, compatibleConnections: [{ id: "safe_connection", name: "Safe", baseUrl: "https://safe.example/v1", enabled: true, apiKeyEnv: "MIMO_API_KEY", apiKey: "compat-secret", activeModels: { "custom-tts": { text: false, tts: true } } }] }),
  });
  const configured = await response.json();
  assert.equal(response.status, 200);
  assert.match(configured.config.compatibleConnections[0].apiKeyEnv, /^OPENAI_COMPAT_SAFE_[A-F0-9]{12}_API_KEY$/);
  assert.notEqual(process.env.MIMO_API_KEY, "compat-secret");

  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  state.profiles.speakerProfiles[0].voiceModel = "compat:safe_connection:custom-tts";
  response = await fetch(`${baseUrl}/api/profiles`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.profiles) });
  assert.equal(response.status, 200);

  const connection = { id: "safe_connection", name: "Safe", baseUrl: "https://safe.example/v1", enabled: true, activeModels: { "custom-tts": { text: false, tts: true } } };
  response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providers, compatibleConnections: [{ ...connection, apiKey: "replacement", clearApiKey: true }] }) });
  assert.equal(response.status, 400);
  response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providers, compatibleConnections: [{ ...connection, clearApiKey: true }] }) });
  assert.equal(response.status, 200);
  assert.doesNotMatch(await readFile(join(rootDir, ".env"), "utf8"), /compat-secret/);
  response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providers, compatibleConnections: [{ ...connection, apiKey: "compat-secret" }] }) });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providers, compatibleConnections: [] }) });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /speaker profile/);

  response = await fetch(`${baseUrl}/api/knowledge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "book.md", content: "# Source" }) });
  const knowledge = await response.json();
  response = await fetch(`${baseUrl}/api/episodes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Saved dependency", episodeProfileId: "episode-chisme-crianza", knowledgeBaseId: knowledge.id }) });
  const episode = await response.json();

  state.profiles.speakerProfiles[0].voiceModel = "mimo-v2.5-tts";
  response = await fetch(`${baseUrl}/api/profiles`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.profiles) });
  assert.equal(response.status, 200);
  response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providers, compatibleConnections: [] }) });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /saved episode "Saved dependency"/);
  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/profiles`, { method: "PUT" });
  assert.equal(response.status, 200);
  response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providers, compatibleConnections: [] }) });
  assert.equal(response.status, 200);
  assert.doesNotMatch(await readFile(join(rootDir, ".env"), "utf8"), /compat-secret/);
});

test("Chatterbox discovers and renders active TTS models without an API key", { concurrency: false }, async (t) => {
  const previous = { mimo: process.env.MIMO_API_KEY, eleven: process.env.ELEVENLABS_API_KEY, openai: process.env.OPENAI_API_KEY, chatterbox: process.env.CHATTERBOX_API_KEY };
  delete process.env.MIMO_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CHATTERBOX_API_KEY;
  t.after(() => {
    for (const [name, key] of [["MIMO_API_KEY", previous.mimo], ["ELEVENLABS_API_KEY", previous.eleven], ["OPENAI_API_KEY", previous.openai], ["CHATTERBOX_API_KEY", previous.chatterbox]]) {
      if (key === undefined) delete process.env[name]; else process.env[name] = key;
    }
  });
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "chatterbox-turbo" }] });
    if (String(url).endsWith("/voices")) {
      const voices = [
        { id: "female", name: "Female", builtin: true, file: "voices/female.wav" },
        { id: "custom", name: "Custom", builtin: false, file: "voices/custom.wav" },
        { name: "Missing ID", file: "voices/invalid.wav" },
      ];
      return Response.json(calls.filter((call) => call.url.endsWith("/voices")).length === 1 ? { object: "list", data: voices } : voices);
    }
    if (String(url).endsWith("/audio/speech")) return new Response(Buffer.from("chatterbox-audio"), { headers: { "Content-Type": "audio/mpeg" } });
    throw new Error(`Unexpected URL ${url}`);
  };
  const rootDir = await mkdtemp(join(tmpdir(), "podcast-chatterbox-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const server = await createPodcastServer({ rootDir, fetchImpl });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  state.config.providers.chatterbox = { baseUrl: "http://127.0.0.1:8100/v1", modelsUrl: "", enabled: true, activeModels: { "chatterbox-turbo": { text: false, tts: true } } };
  let response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.config) });
  const configured = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(configured.modelCatalog.providers.chatterbox.ttsModels.map((model) => model.id), ["compat:chatterbox:chatterbox-turbo"]);
  response = await fetch(`${baseUrl}/api/tts/chatterbox/voices`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { voices: [
    { id: "female", name: "Female", builtin: true },
    { id: "custom", name: "Custom", builtin: false },
  ] });
  const voiceCall = calls.find((call) => call.url.endsWith("/voices"));
  assert.equal(voiceCall.options.headers.Authorization, undefined);
  process.env.CHATTERBOX_API_KEY = "test-chatterbox-key";
  response = await fetch(`${baseUrl}/api/tts/chatterbox/voices`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).voices.map((voice) => voice.id), ["female", "custom"]);
  assert.equal(calls.filter((call) => call.url.endsWith("/voices"))[1].options.headers.Authorization, "Bearer test-chatterbox-key");
  delete process.env.CHATTERBOX_API_KEY;
  state.profiles.speakerProfiles[0].voiceModel = "compat:chatterbox:chatterbox-turbo";
  state.profiles.speakerProfiles[0].speakers[0].voiceId = "female";
  state.profiles.speakerProfiles[0].speakers[0].chatterboxExaggeration = 0.8;
  state.profiles.speakerProfiles[0].speakers[0].chatterboxCfgWeight = 0.25;
  state.profiles.speakerProfiles[0].speakers[0].chatterboxTemperature = 0.65;
  response = await fetch(`${baseUrl}/api/profiles`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.profiles) });
  assert.equal(response.status, 200);
  response = await fetch(`${baseUrl}/api/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ episodeProfileId: "episode-chisme-crianza", speakerProfileId: "speaker-chisme-crianza", speakerIndex: 0, text: "[laugh] Hola", cue: "warm" }) });
  assert.equal(response.status, 200);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "chatterbox-audio");
  const ttsCall = calls.find((call) => call.url.endsWith("/audio/speech"));
  assert.equal(ttsCall.options.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(ttsCall.options.body), {
    model: "chatterbox-turbo",
    voice: "female",
    input: "Hola",
    response_format: "mp3",
    instructions: JSON.parse(ttsCall.options.body).instructions,
    exaggeration: 0.8,
    cfg_weight: 0.25,
    temperature: 0.65,
    language: "es",
  });

  state.profiles.episodeProfiles[0].language = "en-US";
  response = await fetch(`${baseUrl}/api/profiles`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.profiles) });
  assert.equal(response.status, 200);
  response = await fetch(`${baseUrl}/api/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ episodeProfileId: "episode-chisme-crianza", speakerProfileId: "speaker-chisme-crianza", speakerIndex: 0, text: "[laugh] Hello", cue: "warm" }) });
  assert.equal(response.status, 200);
  const ttsCalls = calls.filter((call) => call.url.endsWith("/audio/speech"));
  assert.equal(JSON.parse(ttsCalls.at(-1).options.body).input, "[laugh] Hello");
  assert.equal(JSON.parse(ttsCalls.at(-1).options.body).language, "en");
});

test("profile assistant validates context and persists structured turns", { concurrency: false }, async (t) => {
  const previousKeys = {
    MIMO_API_KEY: process.env.MIMO_API_KEY,
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CHATTERBOX_API_KEY: process.env.CHATTERBOX_API_KEY,
  };
  process.env.MIMO_API_KEY = "test-mimo-key";
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CHATTERBOX_API_KEY;
  t.after(() => {
    for (const [name, value] of Object.entries(previousKeys)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const chatRequests = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/models")) {
      return Response.json({ data: [
        { id: "mimo-v2.5-pro" },
        { id: "mimo-v2.5-tts" },
      ] });
    }
    if (String(url).endsWith("/chat/completions")) {
      chatRequests.push(JSON.parse(options.body));
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        message: "Proposal ready.",
        questions: [],
        proposal: { speaker: { name: "Updated profile", speakers: [{ voiceId: "custom-voice" }] } },
      }) } }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const rootDir = await mkdtemp(join(tmpdir(), "podcast-chat-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const server = await createPodcastServer({ rootDir, fetchImpl });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await waitFor(async () => (await (await fetch(`${baseUrl}/api/models`)).json()).status === "ready");

  const kbContent = `# Context\n${"x".repeat(50_100)}\nFULL_CONTEXT_END`;
  let response = await fetch(`${baseUrl}/api/knowledge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "assistant.md", content: kbContent }),
  });
  const kb = await response.json();
  assert.equal(response.status, 201);

  const requestBody = {
    speakerProfileId: "speaker-chisme-crianza",
    episodeProfileId: "episode-chisme-crianza",
    text: "Make the host warmer.",
    model: "mimo-v2.5-pro",
    kbId: kb.id,
    voiceIds: ["custom-voice"],
  };
  response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...requestBody, kbId: "../../README" }),
  });
  assert.equal(response.status, 400);
  assert.equal(chatRequests.length, 0);

  response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...requestBody, model: "inactive-model" }),
  });
  assert.equal(response.status, 400);
  assert.equal(chatRequests.length, 0);

  response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  assert.equal(response.status, 200);
  const prompt = chatRequests[0].messages[1].content;
  assert.match(prompt, /AVAILABLE ACTIVE TEXT MODELS/);
  assert.match(prompt, /custom-voice/);
  assert.match(prompt, /FULL_CONTEXT_END/);

  response = await fetch(`${baseUrl}/api/chat?speakerProfileId=speaker-chisme-crianza&episodeProfileId=episode-chisme-crianza`);
  const thread = await response.json();
  assert.equal(response.status, 200);
  assert.equal(thread.messages.length, 2);
  assert.equal(JSON.parse(thread.messages[1].content).proposal.speaker.speakers[0].voiceId, "custom-voice");
});

test("browser model fields and loading surfaces are present", async () => {
  const html = await readFile(join(process.cwd(), "public", "index.html"), "utf8");
  assert.match(html, /<select id="epOutlineModel"><\/select>/);
  assert.match(html, /<select id="epTranscriptModel"><\/select>/);
  assert.match(html, /<select id="epLanguage"><\/select>/);
  assert.match(html, /<label class="full">Knowledge Base<select id="buildKnowledge"><\/select><\/label>/);
  assert.match(html, /id="serverActivity"/);
  assert.match(html, /id="transcriptJob"/);
  assert.match(html, /grid-template-columns: 320px minmax\(0, 1fr\)/);
  assert.match(html, /\.loading-line\[hidden\] \{ display: none; \}/);
  assert.match(html, /data-field="accent"/);
  assert.match(html, /--accent: #FFB900/);
  assert.match(html, /id="profilesSpeakersTab"/);
  assert.match(html, /id="ttsLanguageOverride"/);
  assert.match(html, /id="applyLatestProfiles">Apply latest profiles/);
  assert.match(html, /id="view-config"/);
  assert.match(html, /id="saveProfiles" class="primary">Save all profiles/);
  assert.match(html, /id="speakerProfilePills"/);
  assert.match(html, /id="episodeProfilePills" class="profile-pills" aria-label="Selected episode profile details"/);
  assert.match(html, /const selectedEpisode = episodes\.find/);
  assert.match(html, /Outline: \$\{escapeHtml\(textModelLabel\(selectedEpisode\.outlineModel\)\)\}/);
  assert.match(html, /Save episode profiles/);
  assert.match(html, /id="modelDialog"/);
  assert.match(html, />Add OpenAI compatible connection</);
  assert.match(html, /const openaiVoices/);
  assert.match(html, /function voiceSelector\(model, selected\)/);
  assert.match(html, /data-field="chatterboxExaggeration"/);
  assert.match(html, /data-message-index/);
  assert.match(html, /event\.target\.closest\("#chatPane"\)/);
  assert.match(html, /speakerProfileSelect"\)\.addEventListener\("change"[^\n]+loadChatThread/);
  assert.match(html, /chatThread\.messages\[messageIndex\]/);
  assert.match(html, /version !== chatPairVersion/);
  assert.match(html, /Save profile changes before using the assistant/);
  assert.match(html, /function renderProposalDiff/);
  assert.doesNotMatch(html, /const lastAssistant/);
  assert.match(html, /id="transcriptLengthWarning"/);
  assert.match(html, /Render anyway\?/);
  assert.match(html, /<select data-field="voiceId">/);
  assert.match(html, /function ensureProviderVoices\(model\)/);
  assert.doesNotMatch(html, /refreshElevenVoices/);
  assert.match(html, /id="configModelStatus" class="model-status"/);
  assert.match(html, /<details class="connection-row"/);
  assert.match(html, /class="status-pill \$\{status\}"/);
  assert.match(html, /used\.text\.has\(profileId\)/);
  assert.doesNotMatch(html, /const ttsModels/);
  assert.match(html, /Clear saved key/);
  assert.match(html, /function captureEpisodeDraft\(\)/);
  assert.match(html, /beforeunload/);
  assert.match(html, /item\.corrupt/);
});
