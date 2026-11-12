import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runInNewContext, Script } from "node:vm";
import test from "node:test";
import {
  clipCacheKey,
  createPodcastServer,
  parseTranscript,
  runProcess,
  transcriptSpeakerRule,
  validateProfileData,
  writeAudioAsWav,
} from "../src/app.mjs";
import { DEFAULT_DATA } from "../src/defaults.mjs";
import { normalizeGeneratedPlan, normalizePlannedEpisode } from "../src/plans.mjs";
import { html, script, seedEpisode, sendJson, silentWav, source, startTestServer, waitFor, withEnv } from "./helpers.mjs";

const speakers = DEFAULT_DATA.speakerProfiles[0].speakers;
const execFileAsync = promisify(execFile);
const header = (options, name) => new Headers(options.headers).get(name);

// The browser re-assigns state.profiles from every PUT /api/profiles response; tests reusing one
// local copy across several saves must adopt the new revisions the same way or the save conflicts.
async function syncProfiles(response, profiles) {
  Object.assign(profiles, (await response.json()).profiles);
}

function silentFloatWav(sampleRate = 24_000, durationSeconds = 0.01) {
  const samples = Math.round(sampleRate * durationSeconds);
  const buffer = Buffer.alloc(44 + samples * 4);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVE", 8);
  buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(3, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 4, 28); buffer.writeUInt16LE(4, 32); buffer.writeUInt16LE(32, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(samples * 4, 40);
  return buffer;
}

function longText(label, words = 225) {
  return `${label} ${"word ".repeat(words)}`.trim();
}

test("default profiles are valid", () => {
  const profiles = structuredClone(DEFAULT_DATA);
  assert.equal(validateProfileData(profiles), true);
  assert.equal(profiles.episodeProfiles[0].numSegments, 3);
});

test("speaker profiles accept 1 to 4 speakers", () => {
  const solo = structuredClone(DEFAULT_DATA);
  solo.speakerProfiles[0].speakers = [solo.speakerProfiles[0].speakers[0]];
  assert.equal(validateProfileData(solo), true);
  assert.equal(parseTranscript("## Segmento 1\nAlex: Hola.", solo.speakerProfiles[0].speakers, 1).segments[0].turns.length, 1);

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

  const customMimoVoice = structuredClone(DEFAULT_DATA);
  customMimoVoice.speakerProfiles[0].speakers[0].voiceId = "custom-mimo-voice";
  assert.equal(validateProfileData(customMimoVoice), true);

  const invalidMimo = structuredClone(DEFAULT_DATA);
  invalidMimo.speakerProfiles[0].speakers[0].mimoTopP = 1.1;
  assert.throws(() => validateProfileData(invalidMimo), /MiMo top-p must be a number from 0 to 1/);

  const invalidElevenLabs = structuredClone(DEFAULT_DATA);
  invalidElevenLabs.speakerProfiles[0].speakers[0].elevenlabsSpeed = 2;
  assert.throws(() => validateProfileData(invalidElevenLabs), /ElevenLabs speed must be a number from 0.7 to 1.2/);

  const spacedName = structuredClone(DEFAULT_DATA);
  spacedName.speakerProfiles[0].speakers[0].name = "  Alex  ";
  validateProfileData(spacedName);
  assert.equal(spacedName.speakerProfiles[0].speakers[0].name, "Alex");
});

test("saving Episode Formats derives segment count from target duration", async (t) => {
  const { baseUrl } = await startTestServer(t);
  let profiles = (await (await fetch(`${baseUrl}/api/state`)).json()).profiles;
  for (const [targetMinutes, numSegments] of [[18, 5], [60, 17], [5, 3]]) {
    profiles.episodeProfiles[0].targetMinutes = targetMinutes;
    profiles.episodeProfiles[0].numSegments = 99;
    const response = await sendJson(`${baseUrl}/api/profiles`, profiles, "PUT");
    const saved = await response.json();
    assert.equal(response.status, 200, saved.error);
    profiles = saved.profiles;
    assert.equal(profiles.episodeProfiles[0].numSegments, numSegments);
  }
});

test("transcript leadership follows configured speaker count", () => {
  assert.match(transcriptSpeakerRule(["Ana"]), /Use only Ana/);
  assert.match(transcriptSpeakerRule(["Ana", "Luis", "Sara"]), /^Ana is the lead host/);
  assert.doesNotMatch(transcriptSpeakerRule(["Ana", "Luis"]), /Alex/);
});

test("transcript warns for fewer segments and rejects invalid counts", () => {
  assert.throws(() => parseTranscript("## Segmento 1\nNarrator: hello", speakers, 1), /Invalid transcript line 2/);
  const fewer = parseTranscript("## Segmento 1\nAlex: hello", speakers, 5);
  assert.match(fewer.warning, /1 of 5 configured segments/);
  assert.throws(() => parseTranscript("", speakers, 5), /at least 1 segment/);
  const excessive = Array.from({ length: 6 }, (_, index) => `## Segmento ${index + 1}\nAlex: hello`).join("\n");
  assert.throws(() => parseTranscript(excessive, speakers, 5), /at most 5 segments/);
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

test("ElevenLabs voices and preview use server-side key", async (t) => {
  withEnv(t, { ELEVENLABS_API_KEY: "test-eleven-key" });
  const audioDir = await mkdtemp(join(tmpdir(), "podcast-eleven-preview-"));
  t.after(() => rm(audioDir, { recursive: true, force: true }));
  const mp3Path = join(audioDir, "preview.mp3");
  await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-t", "0.1", "-codec:a", "libmp3lame", mp3Path,
  ], { windowsHide: true });
  const previewMp3 = await readFile(mp3Path);

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/v1/models")) {
      return Response.json([
        { model_id: "eleven_v3", name: "Eleven v3", can_do_text_to_speech: true },
        { model_id: "eleven_flash_v2_5", name: "Eleven Flash v2.5", can_do_text_to_speech: true },
      ]);
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
    return new Response(previewMp3, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  };

  const { baseUrl } = await startTestServer(t, { fetchImpl });

  const initialState = await (await fetch(`${baseUrl}/api/state`)).json();
  initialState.config.providers.elevenlabs.activeModels = {
    eleven_v3: { tts: true },
    eleven_flash_v2_5: { tts: true },
  };
  let response = await sendJson(`${baseUrl}/api/config`, initialState.config, "PUT");
  assert.equal(response.status, 200);
  const profiles = initialState.profiles;
  profiles.speakerProfiles[0].voiceModel = "eleven_v3";
  profiles.speakerProfiles[0].speakers = [{
    ...profiles.speakerProfiles[0].speakers[0],
    voiceId: "voice-es",
    elevenlabsStability: 0.6,
    elevenlabsSimilarityBoost: 0.7,
    elevenlabsStyle: 0.2,
    elevenlabsUseSpeakerBoost: false,
    elevenlabsSpeed: 1.1,
    elevenlabsSeed: 123,
    elevenlabsTextNormalization: "off",
  }];
  response = await sendJson(`${baseUrl}/api/profiles`, profiles, "PUT");
  assert.equal(response.status, 200);
  await syncProfiles(response, profiles);

  response = await sendJson(`${baseUrl}/api/transcript-prompt/resolve`, { episodeProfileId: "episode-example-format" });
  let prompt = await response.json();
  assert.match(prompt.lockedPrompt, /eleven_v3/);
  assert.match(prompt.lockedPrompt, /Do not use SSML break tags/);
  assert.equal(prompt.capabilities[0].cueMode, "tags");

  profiles.speakerProfiles[0].voiceModel = "eleven_flash_v2_5";
  response = await sendJson(`${baseUrl}/api/profiles`, profiles, "PUT");
  assert.equal(response.status, 200);
  await syncProfiles(response, profiles);
  response = await sendJson(`${baseUrl}/api/transcript-prompt/resolve`, { episodeProfileId: "episode-example-format" });
  prompt = await response.json();
  assert.match(prompt.lockedPrompt, /<break time="0\.5s" \/>/);
  assert.equal(prompt.capabilities[0].cueMode, "breaks");
  profiles.speakerProfiles[0].voiceModel = "eleven_v3";
  response = await sendJson(`${baseUrl}/api/profiles`, profiles, "PUT");
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/tts/elevenlabs/voices`);
  const voices = await response.json();
  assert.deepEqual(voices, { voices: [{
    id: "voice-es", name: "Española", labels: { language: "es", accent: "Colombian" },
    verifiedLanguages: [{ language: "es", locale: "es-CO", accent: "Colombian" }],
  }], hasMore: false });

  response = await sendJson(`${baseUrl}/api/preview`, { episodeProfileId: "episode-example-format", speakerProfileId: "speaker-example-hosts", speakerIndex: 0, text: "Hola", cue: "warm" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/wav");
  const previewWav = Buffer.from(await response.arrayBuffer());
  assert.equal(previewWav.readUInt16LE(20), 1);
  assert.equal(previewWav.readUInt16LE(22), 1);
  assert.equal(previewWav.readUInt32LE(24), 24_000);
  assert.equal(previewWav.readUInt16LE(34), 16);

  const ttsCall = calls.find((call) => call.url.includes("/text-to-speech/"));
  const request = JSON.parse(ttsCall.options.body);
  assert.equal(ttsCall.options.headers["xi-api-key"], "test-eleven-key");
  assert.deepEqual(request, {
    text: "[warm] Hola",
    model_id: "eleven_v3",
    language_code: "en",
    voice_settings: {
      stability: 0.6,
      similarity_boost: 0.7,
      style: 0.2,
      use_speaker_boost: false,
      speed: 1.1,
    },
    apply_text_normalization: "off",
    seed: 123,
  });
  assert.doesNotMatch(JSON.stringify(voices), /test-eleven-key/);
});

test("Eleven v4 discovers capabilities, preserves tags, splits turns, and reuses only effective settings", async (t) => {
  withEnv(t, { ELEVENLABS_API_KEY: "test-v4-key" });
  const requests = [];
  let maximum = 10_000;
  let advertiseV4 = true;
  let failRequest = 0;
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/v1/models")) return Response.json([
      { model_id: "eleven_v4", name: "Eleven v4", can_do_text_to_speech: true, can_use_style: false, can_use_speaker_boost: false, maximum_text_length_per_request: maximum, languages: [{ language_id: "spa", name: "Spanish" }, { language_id: "eng", name: "English" }] },
      { model_id: "eleven_v4_turbo", name: "Eleven v4 Turbo", can_do_text_to_speech: true },
      { model_id: "eleven_v3", name: "Eleven v3", can_do_text_to_speech: true },
    ].filter((model) => advertiseV4 || model.model_id !== "eleven_v4"));
    if (String(url).includes("/text-to-speech/")) {
      requests.push(JSON.parse(options.body));
      assert.equal(options.headers["xi-api-key"], "test-v4-key");
      if (failRequest && requests.length >= failRequest) return Response.json({ detail: "mock chunk failure" }, { status: 500 });
      return new Response(silentWav(44_100, 2), { headers: { "Content-Type": "audio/wav" } });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const { baseUrl, rootDir } = await startTestServer(t, { fetchImpl });
  const initial = await (await fetch(`${baseUrl}/api/state`)).json();
  const oldProfile = structuredClone(initial.profiles.speakerProfiles[0]);
  const config = initial.config;
  config.providers.elevenlabs.activeModels = { eleven_v4: { tts: true }, eleven_v4_turbo: { tts: true }, eleven_v3: { tts: true } };
  let response = await sendJson(`${baseUrl}/api/config`, config, "PUT");
  const configured = await response.json();
  assert.equal(response.status, 200, configured.error);
  const catalog = configured.modelCatalog.providers.elevenlabs;
  assert.deepEqual(catalog.ttsModels.map((model) => model.id), ["eleven_v4", "eleven_v3"]);
  const v4 = catalog.ttsModels[0];
  assert.equal(v4.maximumTextLengthPerRequest, 10_000);
  assert.equal(v4.canUseStyle, false);
  assert.equal(v4.canUseSpeakerBoost, false);
  assert.deepEqual(v4.ttsCapabilities.voiceSettings, ["stability", "similarityBoost"]);
  assert.deepEqual(v4.languages.map((language) => language.id), ["es", "en"]);
  assert.match(catalog.discoveredModels.find((model) => model.id === "eleven_v4_turbo").unsupportedReason, /realtime dialogue API/);
  const unchanged = (await (await fetch(`${baseUrl}/api/state`)).json()).profiles.speakerProfiles[0];
  assert.deepEqual(unchanged, oldProfile, "discovery must not migrate existing profiles");

  const profiles = initial.profiles;
  const profile = profiles.speakerProfiles[0];
  profile.voiceModel = "eleven_v4";
  profile.speakers = [{ ...profile.speakers[0], voiceId: "voice-v4", elevenlabsStability: 0.6, elevenlabsSimilarityBoost: 0.8, elevenlabsStyle: 0.4, elevenlabsSpeed: 1.1, elevenlabsUseSpeakerBoost: false, elevenlabsSeed: 9, elevenlabsTextNormalization: "off" }];
  async function saveProfiles() {
    const saved = await sendJson(`${baseUrl}/api/profiles`, profiles, "PUT");
    assert.equal(saved.status, 200, await saved.clone().text());
    await syncProfiles(saved, profiles);
  }
  await saveProfiles();
  response = await sendJson(`${baseUrl}/api/transcript-prompt/resolve`, { episodeProfileId: profiles.episodeProfiles[0].id });
  const prompt = await response.json();
  assert.match(prompt.lockedPrompt, /eleven_v4/);
  assert.doesNotMatch(prompt.lockedPrompt, /eleven_v3/);
  assert.equal(prompt.capabilities[0].cueMode, "tags");
  const previewBody = { episodeProfileId: profiles.episodeProfiles[0].id, speakerProfileId: profile.id, speakerIndex: 0, text: "[laughs] Hola.", cue: "warm and calm" };
  response = await sendJson(`${baseUrl}/api/preview`, previewBody);
  assert.equal(response.status, 200, await response.clone().text());
  const preview = Buffer.from(await response.arrayBuffer());
  assert.equal(preview.readUInt16LE(22), 1);
  assert.equal(preview.readUInt32LE(24), 24_000);
  assert.equal(preview.readUInt16LE(34), 16);
  assert.deepEqual(requests.at(-1), { text: "[warm and calm] [laughs] Hola.", model_id: "eleven_v4", language_code: "en", voice_settings: { stability: 0.6, similarity_boost: 0.8 }, apply_text_normalization: "off", seed: 9 });
  const beforeSsml = requests.length;
  for (const text of ['Hola <break time="0.5s" />.', '<prosody rate="slow">Hola.</prosody>']) {
    response = await sendJson(`${baseUrl}/api/preview`, { ...previewBody, text });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /does not support SSML/);
  }
  assert.equal(requests.length, beforeSsml);

  response = await sendJson(`${baseUrl}/api/episodes`, { name: "V4 chunks", episodeProfileId: profiles.episodeProfiles[0].id });
  const episode = await response.json();
  const spoken = `[whispers] ${"Una frase clara. ".repeat(680).trim()} [laughs] Fin.`;
  const transcript = `## Segmento 1\n${profile.speakers[0].name} [calm]: ${spoken}`;
  response = await sendJson(`${baseUrl}/api/episodes/${episode.id}/transcript`, { transcript }, "PUT");
  assert.equal(response.status, 200, await response.clone().text());
  async function render() {
    const queued = await fetch(`${baseUrl}/api/episodes/${episode.id}/render`, { method: "POST" });
    assert.equal(queued.status, 202, await queued.clone().text());
    const { job } = await queued.json();
    return waitFor(async () => {
      const jobs = (await (await fetch(`${baseUrl}/api/jobs`)).json()).jobs;
      return jobs.find((item) => item.id === job.id && ["completed", "failed"].includes(item.status));
    }, 30_000);
  }
  const beforeRender = requests.length;
  assert.equal((await render()).status, "completed");
  const turnRequests = requests.slice(beforeRender);
  assert.equal(turnRequests.length, 2);
  assert.ok(turnRequests.every((body) => body.text.length <= 10_000 && body.text.startsWith("[calm] ")));
  assert.equal(turnRequests.map((body) => body.text.slice("[calm] ".length)).join(" "), spoken);
  const clipsDir = join(rootDir, "data", "episodes", episode.id, "clips");
  const clips = (await readdir(clipsDir)).filter((name) => /^[a-f0-9]{64}\.wav$/.test(name));
  assert.equal(clips.length, 1, "split audio must become one cached turn before pauses");
  assert.ok((await readdir(clipsDir)).every((name) => !/chunk|source|concat|tmp/.test(name)));
  const normalized = await readFile(join(clipsDir, clips[0]));
  assert.equal(normalized.readUInt16LE(22), 1);
  assert.equal(normalized.readUInt32LE(24), 24_000);
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", join(clipsDir, clips[0])]);
  assert.ok(Math.abs(Number(stdout.trim()) - 0.02) < 0.005, "chunk combination must not insert inter-turn pauses");

  profiles.speakerProfiles[0].speakers[0].elevenlabsStyle = 0.9;
  profiles.speakerProfiles[0].speakers[0].elevenlabsSpeed = 0.8;
  profiles.speakerProfiles[0].speakers[0].elevenlabsUseSpeakerBoost = true;
  profiles.speakerProfiles[0].speakers[0].accent = "British";
  profiles.speakerProfiles[0].speakers[0].style = "An ignored TTS voice direction.";
  await saveProfiles();
  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/profiles`, { method: "PUT" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).episode.audioReady, true);
  const cachedCount = requests.length;
  assert.equal((await render()).status, "completed");
  assert.equal(requests.length, cachedCount, "ignored settings must not invalidate v4 cache");

  profiles.speakerProfiles[0].speakers[0].elevenlabsStability = 0.7;
  await saveProfiles();
  await fetch(`${baseUrl}/api/episodes/${episode.id}/profiles`, { method: "PUT" });
  assert.equal((await render()).status, "completed");
  assert.equal(requests.length, cachedCount + 2, "supported settings must invalidate cache");
  const audioPath = join(rootDir, "data", "episodes", episode.id, "episode.mp3");
  const previousAudio = await readFile(audioPath);
  for (const name of (await readdir(clipsDir)).filter((name) => /^[a-f0-9]{64}\.wav$/.test(name))) await rm(join(clipsDir, name));
  failRequest = requests.length + 2;
  const failed = await render();
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /mock chunk failure/);
  assert.deepEqual(await readFile(audioPath), previousAudio);
  assert.equal((await (await fetch(`${baseUrl}/api/episodes/${episode.id}`)).json()).audioReady, true);
  assert.ok((await readdir(clipsDir)).every((name) => !/chunk|source|concat|tmp/.test(name)));
  failRequest = 0;

  maximum = 60;
  response = await sendJson(`${baseUrl}/api/config`, config, "PUT");
  assert.equal(response.status, 200);
  const smallerStart = requests.length;
  response = await sendJson(`${baseUrl}/api/preview`, { ...previewBody, text: "[whispers] Uno dos tres cuatro. Cinco seis siete ocho. Nueve diez once doce.", cue: "calm" });
  assert.equal(response.status, 200, await response.clone().text());
  assert.ok(requests.slice(smallerStart).length > 1);
  assert.ok(requests.slice(smallerStart).every((body) => body.text.length <= maximum));
  const cjkStart = requests.length;
  const cjkText = "你好。".repeat(30);
  response = await sendJson(`${baseUrl}/api/preview`, { ...previewBody, text: cjkText, cue: "calm" });
  assert.equal(response.status, 200, await response.clone().text());
  assert.ok(requests.slice(cjkStart).every((body) => body.text.length <= maximum));
  assert.equal(requests.slice(cjkStart).map((body) => body.text.slice("[calm] ".length)).join(""), cjkText);
  const unsafeStart = requests.length;
  response = await sendJson(`${baseUrl}/api/preview`, { ...previewBody, text: "a".repeat(80), cue: "calm" });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /cannot split.*60-character.*without cutting a word or audio tag/);
  assert.equal(requests.length, unsafeStart);
  response = await sendJson(`${baseUrl}/api/preview`, { ...previewBody, text: `[${"a".repeat(80)}] Hola.`, cue: "calm" });
  assert.equal(response.status, 400);
  assert.equal(requests.length, unsafeStart);
  advertiseV4 = false;
  response = await sendJson(`${baseUrl}/api/config`, config, "PUT");
  assert.equal(response.status, 200);
  response = await sendJson(`${baseUrl}/api/preview`, previewBody);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /eleven_v4.*not active/);
  assert.equal(requests.length, unsafeStart, "unavailable v4 must not use another active model");
});

test("local API seeds data and saves knowledge plus episode", async (t) => {
  const inlineStyle = "body { color: red; }";
  const inlineScript = "globalThis.testLoaded = true;";
  const { baseUrl } = await startTestServer(t, {}, async (rootDir) => {
    await mkdir(join(rootDir, "public"), { recursive: true });
    await writeFile(join(rootDir, "public", "index.html"), `<!doctype html><style>${inlineStyle}</style><script>${inlineScript}</script>`);
    await copyFile(join(process.cwd(), "public", "icon.png"), join(rootDir, "public", "icon.png"));
  });

  let response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /media-src 'self' blob:/);
  assert.ok(csp.includes(`script-src 'sha256-${createHash("sha256").update(inlineScript).digest("base64")}'`));
  assert.ok(csp.includes(`style-src 'sha256-${createHash("sha256").update(inlineStyle).digest("base64")}'`));
  assert.doesNotMatch(csp, /unsafe-inline/);

  response = await fetch(`${baseUrl}/icon.png`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()).subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"));

  response = await fetch(`${baseUrl}/%ZZ`);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Request path is malformed.");

  response = await fetch(`${baseUrl}/api/state`);
  let state = await response.json();
  assert.equal(response.status, 200);
  response = await fetch(`${baseUrl}/api/knowledge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ name: "blocked.md", content: "blocked" }),
  });
  assert.equal(response.status, 403);
  response = await fetch(`${baseUrl}/api/models/refresh`, {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:1" },
  });
  assert.equal(response.status, 403);

  response = await sendJson(`${baseUrl}/api/knowledge`, { name: "book.md", content: "# Chapter\nGrounded source." });
  const knowledge = await response.json();
  assert.equal(response.status, 201);

  response = await sendJson(`${baseUrl}/api/episodes`, {
    name: "Ep. 01 — Test",
    episodeProfileId: "episode-example-format",
    knowledgeBaseId: knowledge.id,
    additionalInstructions: "Stay focused.",
  });
  const episode = await response.json();
  assert.equal(response.status, 201);
  assert.equal(episode.status, "draft");
  assert.equal(episode.episodeProfile.id, "episode-example-format");
  assert.equal(episode.speakerProfile.speakers[0].name, "Alex");

  state.profiles.speakerProfiles[0].speakers[0].name = "Changed later";
  response = await sendJson(`${baseUrl}/api/profiles`, state.profiles, "PUT");
  assert.equal(response.status, 200);

  const transcript = Array.from({ length: 2 }, (_, index) =>
    `## Segmento ${index + 1} — Test\nAlex [cálida]: Idea ${index + 1}.\nSam: Reacción ${index + 1}.`
  ).join("\n\n");
  response = await sendJson(`${baseUrl}/api/episodes/${episode.id}/transcript`, { transcript }, "PUT");
  const saved = await response.json();
  assert.equal(response.status, 200);
  assert.equal(saved.status, "transcript_ready");
  assert.match(saved.warning, /2 of 3 configured segments/);
  assert.equal(saved.speakerProfile.speakers[0].name, "Alex");

  response = await sendJson(`${baseUrl}/api/episodes/${episode.id}`, { name: "Renamed podcast" }, "PATCH");
  const renamed = await response.json();
  assert.equal(response.status, 200);
  assert.equal(renamed.name, "Renamed podcast");
  assert.equal(renamed.status, "transcript_ready");
  assert.equal(renamed.transcript, saved.transcript);
  assert.equal(Object.hasOwn(renamed, "warning"), false);

  state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.episodes.length, 1);
});

test("knowledge deletion clears plans and episodes", async (t) => {
  const { rootDir, baseUrl } = await startTestServer(t);
  let response = await sendJson(`${baseUrl}/api/knowledge`, { name: "delete.md", content: "# Delete me" });
  const knowledge = await response.json();
  response = await sendJson(`${baseUrl}/api/plans`, { name: "Plan", knowledgeBaseId: knowledge.id });
  const plan = (await response.json()).plan;
  response = await sendJson(`${baseUrl}/api/episodes`, { name: "Episode", episodeProfileId: "episode-example-format", knowledgeBaseId: knowledge.id });
  const episode = await response.json();

  const episodePath = join(rootDir, "data", "episodes", episode.id, "episode.json");
  const activeEpisode = JSON.parse(await readFile(episodePath, "utf8"));
  activeEpisode.job = { id: "active", type: "tts", status: "running" };
  await writeFile(episodePath, JSON.stringify(activeEpisode, null, 2));
  response = await fetch(`${baseUrl}/api/knowledge/${knowledge.id}`, { method: "DELETE" });
  assert.equal(response.status, 409);
  activeEpisode.job = null;
  await writeFile(episodePath, JSON.stringify(activeEpisode, null, 2));

  response = await fetch(`${baseUrl}/api/knowledge/${knowledge.id}`, { method: "DELETE" });
  const deleted = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(deleted.cleared, { plans: 1, episodes: 1 });
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.knowledgeBases.some((item) => item.id === knowledge.id), false);
  assert.equal(state.plans.find((item) => item.id === plan.id).knowledgeBaseId, "");
  assert.equal(state.episodes.find((item) => item.id === episode.id).knowledgeBaseId, "");
  await assert.rejects(readFile(join(rootDir, "data", "knowledge", `${knowledge.id}.md`)), { code: "ENOENT" });
});

test("transcript word counts use locale-aware segmentation", async (t) => {
  const { baseUrl } = await startTestServer(t);
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  state.profiles.episodeProfiles[0].language = "zh-CN";
  await sendJson(`${baseUrl}/api/profiles`, state.profiles, "PUT");
  let response = await sendJson(`${baseUrl}/api/knowledge`, { name: "book.md", content: "# Source" });
  const knowledge = await response.json();
  response = await sendJson(`${baseUrl}/api/episodes`, { name: "Chinese", episodeProfileId: "episode-example-format", knowledgeBaseId: knowledge.id });
  const episode = await response.json();
  const transcript = Array.from({ length: 3 }, (_, index) => `## Segmento ${index + 1}\nAlex: ä»Šå¤©æˆ‘ä»¬è®¨è®ºå®¶åº­æ²Ÿé€šã€‚`).join("\n\n");
  response = await sendJson(`${baseUrl}/api/episodes/${episode.id}/transcript`, { transcript }, "PUT");
  assert.equal(response.status, 200);
  assert.ok((await response.json()).transcriptWords > 5);
});

test("saved episode explicitly applies latest profiles atomically", async (t) => {
  const { rootDir, baseUrl } = await startTestServer(t);

  let state = await (await fetch(`${baseUrl}/api/state`)).json();
  let response = await sendJson(`${baseUrl}/api/knowledge`, { name: "book.md", content: "# Source" });
  const knowledge = await response.json();
  response = await sendJson(`${baseUrl}/api/episodes`, { name: "Snapshot test", episodeProfileId: "episode-example-format", knowledgeBaseId: knowledge.id });
  const episode = await response.json();
  const transcript = Array.from({ length: 3 }, (_, index) =>
    `## Segmento ${index + 1} — Test\nAlex: Idea ${index + 1}.\nSam: Reaction ${index + 1}.`
  ).join("\n\n");
  response = await sendJson(`${baseUrl}/api/episodes/${episode.id}/transcript`, { transcript }, "PUT");
  assert.equal(response.status, 200);

  const episodeFile = join(rootDir, "data", "episodes", episode.id, "episode.json");
  const rendered = JSON.parse(await readFile(episodeFile, "utf8"));
  rendered.audioReady = true;
  rendered.status = "ready";
  await writeFile(episodeFile, JSON.stringify(rendered, null, 2));
  await writeFile(join(rootDir, "data", "episodes", episode.id, "episode.mp3"), "existing-audio");

  state.profiles.episodeProfiles[0].targetMinutes = 19;
  state.profiles.speakerProfiles[0].description = "Updated speaker profile";
  response = await sendJson(`${baseUrl}/api/profiles`, state.profiles, "PUT");
  assert.equal(response.status, 200);
  state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.profiles.episodeProfiles[0].targetMinutes, 19);
  assert.equal((await (await fetch(`${baseUrl}/api/episodes/${episode.id}`)).json()).episodeProfile.targetMinutes, 10);

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

  response = await sendJson(`${baseUrl}/api/episodes`, { id: episode.id, name: "Snapshot test", episodeProfileId: "episode-example-format", knowledgeBaseId: knowledge.id, additionalInstructions: "New generation guidance" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).audioReady, true);

  state.profiles.speakerProfiles[0].speakers[0].style = "Updated TTS direction";
  response = await sendJson(`${baseUrl}/api/profiles`, state.profiles, "PUT");
  assert.equal(response.status, 200);
  await syncProfiles(response, state.profiles);
  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/profiles`, { method: "PUT" });
  const ttsChanged = await response.json();
  assert.equal(ttsChanged.episode.audioReady, false);
  assert.equal(ttsChanged.episode.status, "transcript_ready");
  assert.equal((await readFile(join(rootDir, "data", "episodes", episode.id, "episode.mp3"), "utf8")), "existing-audio");

  state.profiles.episodeProfiles[0].targetMinutes = 21;
  response = await sendJson(`${baseUrl}/api/profiles`, state.profiles, "PUT");
  assert.equal(response.status, 200);
  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/profiles`, { method: "PUT" });
  assert.equal(response.status, 200);
  const expanded = await response.json();
  assert.equal(expanded.episode.episodeProfile.numSegments, 6);
  assert.match(expanded.warning, /3 of 6 configured segments/);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(episodeFile, "utf8")), "warning"), false);

  const busy = JSON.parse(await readFile(episodeFile, "utf8"));
  busy.job = { status: "running" };
  await writeFile(episodeFile, JSON.stringify(busy, null, 2));
  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/profiles`, { method: "PUT" });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /active episode job/);
});

test("model catalog uses provider APIs without exposing keys", async (t) => {
  withEnv(t, { MIMO_API_KEY: "test-mimo-key", ELEVENLABS_API_KEY: "test-eleven-key" });

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
  const { baseUrl } = await startTestServer(t, { fetchImpl });

  const catalog = await waitFor(async () => {
    const value = await (await fetch(`${baseUrl}/api/models`)).json();
    return value.status === "ready" ? value : null;
  });
  assert.equal(Object.hasOwn(catalog.providers.mimo, "textModels"), false);
  assert.deepEqual(catalog.providers.mimo.ttsModels.map((model) => model.id), ["mimo-v2.5-tts"]);
  assert.deepEqual(catalog.providers.mimo.discoveredModels.map((model) => model.id), ["mimo-v2.5-tts", "mimo-v2.5-tts-voiceclone"]);
  assert.deepEqual(catalog.providers.elevenlabs.ttsModels, []);
  assert.deepEqual(catalog.providers.elevenlabs.discoveredModels.map((model) => model.id), ["eleven_v3"]);
  assert.ok(catalog.languages.some((language) => language.id === "es-419" && language.apiCode === "es"));
  assert.ok(!catalog.languages.some((language) => language.id === "afr"));
  assert.doesNotMatch(JSON.stringify(catalog), /test-(mimo|eleven)-key/);
});

test("provider responses are rejected before exceeding memory limits", async (t) => {
  withEnv(t, { MIMO_API_KEY: "test-mimo-key", ELEVENLABS_API_KEY: null });
  let oversizedError = false;
  const fetchImpl = async () => oversizedError
    ? new Response("x".repeat(70 * 1024), { status: 502 })
    : new Response("{}", { headers: { "Content-Length": String(9 * 1024 * 1024) } });
  const { baseUrl } = await startTestServer(t, { fetchImpl });
  const catalog = await waitFor(async () => {
    const value = await (await fetch(`${baseUrl}/api/models`)).json();
    return value.status === "error" ? value : null;
  });
  assert.match(catalog.providers.mimo.error, /response exceeds 8388608 byte limit/);
  oversizedError = true;
  assert.equal((await fetch(`${baseUrl}/api/models/refresh`, { method: "POST" })).status, 202);
  const refreshed = await waitFor(async () => {
    const value = await (await fetch(`${baseUrl}/api/models`)).json();
    return value.providers.mimo.error?.includes("65536") ? value : null;
  });
  assert.match(refreshed.providers.mimo.error, /response exceeds 65536 byte limit/);
});

test("MiMo TTS accepts base64 audio responses larger than the ordinary JSON limit", async (t) => {
  withEnv(t, { MIMO_API_KEY: "test-mimo-key", ELEVENLABS_API_KEY: null });
  const wav = silentWav(24_000, 1, 140);
  const fetchImpl = async (url) => String(url).endsWith("/models")
    ? Response.json({ data: [{ id: "mimo-v2.5-tts" }] })
    : Response.json({ choices: [{ message: { audio: { data: wav.toString("base64") } } }] });
  const { baseUrl } = await startTestServer(t, { fetchImpl });
  await waitFor(async () => (await (await fetch(`${baseUrl}/api/models`)).json()).status === "ready");
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  state.profiles.episodeProfiles[0].language = "en-US";
  await sendJson(`${baseUrl}/api/profiles`, state.profiles, "PUT");
  let response = await sendJson(`${baseUrl}/api/preview`, {
    speakerProfileId: state.profiles.speakerProfiles[0].id,
    episodeProfileId: state.profiles.episodeProfiles[0].id,
    speakerIndex: 0,
    text: "Large response test.",
  });
  assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
  const preview = Buffer.from(await response.arrayBuffer());
  assert.equal(Number(response.headers.get("content-length")), preview.length);
  assert.ok(preview.length > 6 * 1024 * 1024);
  assert.equal(preview.readUInt16LE(20), 1);
  assert.equal(preview.readUInt16LE(34), 16);
});

test("concurrent config saves receive matching nonblocking catalog snapshots", async (t) => {
  withEnv(t, { MIMO_API_KEY: null, ELEVENLABS_API_KEY: null, CHATTERBOX_API_KEY: null, OPENAI_API_KEY: "test-openai-key" });
  let blockModels = false;
  let releaseModels;
  const modelGate = new Promise((resolve) => { releaseModels = resolve; });
  t.after(() => releaseModels());
  const fetchImpl = async (url) => {
    const value = String(url);
    if (blockModels && value.endsWith("/models")) await modelGate;
    const source = value.includes("provider-a.test") ? "a" : value.includes("provider-b.test") ? "b" : "initial";
    return Response.json({ data: [{ id: `model-${source}` }] });
  };
  const { baseUrl } = await startTestServer(t, { fetchImpl });
  await waitFor(async () => (await (await fetch(`${baseUrl}/api/models`)).json()).status === "ready");
  const config = await (await fetch(`${baseUrl}/api/config`)).json();
  const hold = request(`${baseUrl}/api/knowledge`, { method: "POST", headers: { "Content-Type": "application/json" } });
  const holdDone = new Promise((resolve, reject) => {
    hold.on("response", (response) => { response.resume(); response.on("end", resolve); });
    hold.on("error", reject);
  });
  hold.write('{"name":"hold.md","content":"');
  await new Promise((resolve) => setTimeout(resolve, 30));
  blockModels = true;
  const configA = structuredClone(config);
  const configB = structuredClone(config);
  configA.providers.openai.baseUrl = "http://provider-a.test/v1";
  configA.providers.openai.apiKey = "test-openai-key";
  configB.providers.openai.baseUrl = "http://provider-b.test/v1";
  configB.providers.openai.apiKey = "test-openai-key";
  const save = (body) => sendJson(`${baseUrl}/api/config`, body, "PUT").then((response) => response.json());
  const pendingA = save(configA);
  const pendingB = save(configB);
  await new Promise((resolve) => setTimeout(resolve, 30));
  hold.end('x"}');
  await holdDone;
  await waitFor(async () => (await (await fetch(`${baseUrl}/api/config`)).json()).providers.openai.baseUrl === configB.providers.openai.baseUrl);
  const unrelated = sendJson(`${baseUrl}/api/knowledge`, { name: "concurrent.md", content: "# Concurrent" });
  assert.equal(await Promise.race([unrelated.then((response) => response.status), new Promise((resolve) => setTimeout(() => resolve("timeout"), 1_000))]), 201);
  releaseModels();
  const [resultA, resultB] = await Promise.all([pendingA, pendingB]);
  assert.equal(resultA.config.providers.openai.baseUrl, configA.providers.openai.baseUrl);
  assert.equal(resultA.modelCatalog.providers.openai.discoveredModels[0].rawId, "model-a");
  assert.equal(resultB.config.providers.openai.baseUrl, configB.providers.openai.baseUrl);
  assert.equal(resultB.modelCatalog.providers.openai.discoveredModels[0].rawId, "model-b");
  assert.equal((await (await fetch(`${baseUrl}/api/models`)).json()).providers.openai.discoveredModels[0].rawId, "model-b");
});

test("repeated manual model refreshes coalesce while config saves still force a refresh", async (t) => {
  withEnv(t, { OPENAI_API_KEY: "refresh-test-key" });
  let modelCalls = 0;
  let blockModels = false;
  let releaseModels;
  let markModelsStarted;
  const modelGate = new Promise((resolve) => { releaseModels = resolve; });
  const modelsStarted = new Promise((resolve) => { markModelsStarted = resolve; });
  t.after(() => releaseModels());
  const fetchImpl = async (url) => {
    if ((String(url).includes("api.openai.com") || String(url).includes("forced-refresh.test")) && String(url).endsWith("/models")) {
      modelCalls += 1;
      if (blockModels) { markModelsStarted(); await modelGate; }
    }
    return Response.json({ data: [{ id: "gpt-4o-mini" }] });
  };
  const { baseUrl } = await startTestServer(t, { fetchImpl });
  await waitFor(async () => (await (await fetch(`${baseUrl}/api/models`)).json()).status === "ready");
  const initialCalls = modelCalls;
  blockModels = true;
  assert.equal((await fetch(`${baseUrl}/api/models/refresh`, { method: "POST" })).status, 202);
  await modelsStarted;
  assert.equal((await fetch(`${baseUrl}/api/models/refresh`, { method: "POST" })).status, 202);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(modelCalls, initialCalls + 1);

  const config = await (await fetch(`${baseUrl}/api/config`)).json();
  config.providers.openai.baseUrl = "http://forced-refresh.test/v1";
  config.providers.openai.apiKey = "refresh-test-key";
  const save = sendJson(`${baseUrl}/api/config`, config, "PUT");
  releaseModels();
  const saved = await save;
  assert.equal(saved.status, 200, await saved.text());
  assert.ok(modelCalls >= initialCalls + 2);
});

test("failed transcript replacement restores episode metadata", async (t) => {
  const { rootDir, baseUrl } = await startTestServer(t);
  let response = await sendJson(`${baseUrl}/api/episodes`, { name: "Rollback", episodeProfileId: "episode-example-format" });
  const episode = await response.json();
  const directory = join(rootDir, "data", "episodes", episode.id);
  const metadataPath = join(directory, "episode.json");
  const before = await readFile(metadataPath, "utf8");
  await mkdir(join(directory, "transcript.md"));
  const transcript = Array.from({ length: 3 }, (_, index) => `## Segmento ${index + 1}\nAlex: Idea ${index + 1}.`).join("\n\n");
  response = await sendJson(`${baseUrl}/api/episodes/${episode.id}/transcript`, { transcript }, "PUT");
  assert.equal(response.status, 500);
  assert.equal(await readFile(metadataPath, "utf8"), before);
});

test("TTS jobs report progress and publish MP3", async (t) => {
  withEnv(t, { MIMO_API_KEY: "test-mimo-key", ELEVENLABS_API_KEY: null, MIMO_BASE_URL: process.env.MIMO_BASE_URL });
  let ttsCalls = 0;
  const ttsRequests = [];
  let wav = silentWav(24_000, 1, 70).toString("base64");
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "mimo-v2.5-pro" }, { id: "mimo-v2.5-tts" }] });
    if (String(url).endsWith("/chat/completions")) {
      const request = JSON.parse(options.body);
      ttsCalls += 1;
      ttsRequests.push(request);
      return Response.json({ choices: [{ message: { audio: { data: wav } } }] });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const { rootDir, baseUrl } = await startTestServer(t, { fetchImpl });

  let response = await sendJson(`${baseUrl}/api/knowledge`, { name: "book.md", content: "# Grounded" });
  const knowledge = await response.json();
  const profiles = (await (await fetch(`${baseUrl}/api/state`)).json()).profiles;
  profiles.episodeProfiles[0].targetMinutes = 5;
  profiles.episodeProfiles[0].language = "es-419";
  response = await sendJson(`${baseUrl}/api/profiles`, profiles, "PUT");
  assert.equal(response.status, 200);
  await syncProfiles(response, profiles);
  response = await sendJson(`${baseUrl}/api/episodes`, { name: "TTS", episodeProfileId: "episode-example-format", knowledgeBaseId: knowledge.id });
  const episode = await response.json();
  const transcript = Array.from({ length: 3 }, (_, index) => `## Segmento ${index + 1}\nAlex [${index === 0 ? "quick" : "warm"}]: Idea ${index + 1}.${index === 0 ? "[pause]\nSam [warm]: Quick reaction." : ""}`).join("\n\n");
  await sendJson(`${baseUrl}/api/episodes/${episode.id}/transcript`, { transcript }, "PUT");

  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/render`, { method: "POST" });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /MiMo preset TTS does not support Spanish/);

  profiles.episodeProfiles[0].language = "en-US";
  profiles.speakerProfiles[0].speakers[0].voiceId = "custom-mimo";
  profiles.speakerProfiles[0].speakers[0].accent = "British";
  profiles.speakerProfiles[0].speakers[0].mimoTemperature = 0.4;
  profiles.speakerProfiles[0].speakers[0].mimoTopP = 0.8;
  profiles.speakerProfiles[0].speakers[0].mimoInstructionPreset = "expressive";
  profiles.speakerProfiles[0].speakers[0].mimoInstructionText = "Keep the read intimate.";
  response = await sendJson(`${baseUrl}/api/profiles`, profiles, "PUT");
  assert.equal(response.status, 200);

  response = await sendJson(`${baseUrl}/api/episodes`, { id: episode.id, name: "TTS", episodeProfileId: "episode-example-format", knowledgeBaseId: knowledge.id });
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
  assert.equal(job.completed, 4);
  assert.deepEqual(job.options, {});
  assert.equal(ttsCalls, 4);
  assert.match(ttsRequests[0].messages[0].content, /Required spoken language: English \(United States\) \(en-US\)/);
  assert.match(ttsRequests[0].messages[0].content, /Required accent: British/);
  assert.match(ttsRequests[0].messages[0].content, /more expressive delivery/);
  assert.match(ttsRequests[0].messages[0].content, /Keep the read intimate/);
  assert.match(ttsRequests[0].messages[1].content, /\[pause\]/);
  assert.equal(ttsRequests[0].audio.voice, "custom-mimo");
  assert.equal(ttsRequests[0].temperature, 0.4);
  assert.equal(ttsRequests[0].top_p, 0.8);
  const saved = await (await fetch(`${baseUrl}/api/episodes/${episode.id}`)).json();
  assert.equal(saved.status, "ready");
  assert.equal(saved.audioUrl, `/artifacts/${episode.id}/episode.mp3`);
  await assert.rejects(readFile(unusedClip), { code: "ENOENT" });

  const config = (await (await fetch(`${baseUrl}/api/state`)).json()).config;
  config.providers.mimo.baseUrl = "https://replacement.example/v1";
  config.providers.mimo.apiKey = "test-mimo-key";
  response = await sendJson(`${baseUrl}/api/config`, config, "PUT");
  assert.equal(response.status, 200);
  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/render`, { method: "POST" });
  const providerChangeJob = (await response.json()).job;
  assert.equal(response.status, 202);
  await waitFor(async () => {
    const value = await (await fetch(`${baseUrl}/api/jobs`)).json();
    return value.jobs.find((item) => item.id === providerChangeJob.id)?.status === "completed";
  }, 30_000);
  assert.equal(ttsCalls, 8);

  const audioPath = join(rootDir, "data", "episodes", episode.id, "episode.mp3");
  const previousAudio = await readFile(audioPath);
  const { stdout: durationOutput } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", audioPath], { windowsHide: true });
  assert.ok(Number(durationOutput.trim()) >= 274);

  await rm(clipsDir, { recursive: true, force: true });
  wav = silentWav().toString("base64");
  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/render`, { method: "POST" });
  assert.equal(response.status, 202);
  const shortRender = await waitFor(async () => {
    const value = await (await fetch(`${baseUrl}/api/jobs`)).json();
    return value.jobs.find((item) => item.episodeId === episode.id)?.status === "completed" ? value : null;
  }, 30_000);
  assert.match(shortRender.jobs.find((item) => item.episodeId === episode.id).message, /Rendered audio too short/);
  const afterShort = await (await fetch(`${baseUrl}/api/episodes/${episode.id}`)).json();
  assert.equal(afterShort.audioReady, true);
  assert.equal(afterShort.audioUrl, saved.audioUrl);

  response = await fetch(`${baseUrl}${saved.audioUrl}`, { headers: { Range: "bytes=0-3" } });
  assert.equal(response.status, 206);
  assert.match(response.headers.get("content-range"), /^bytes 0-3\//);
  assert.equal((await response.arrayBuffer()).byteLength, 4);
  response = await fetch(`${baseUrl}${saved.audioUrl}`, { headers: { Range: "bytes=999999999-" } });
  assert.equal(response.status, 416);
});

test("transcript prompt adds cues, supports no KB, and manual transcripts keep supported cues", async (t) => {
  withEnv(t, { MIMO_API_KEY: "test-mimo-key" });
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "mimo-v2.5-tts" }] });
    throw new Error(`Unexpected URL ${url}`);
  };
  const { baseUrl } = await startTestServer(t, { fetchImpl });

  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  state.profiles.episodeProfiles[0].language = "en-US";
  state.profiles.episodeProfiles[0].targetMinutes = 5;
  let response = await sendJson(`${baseUrl}/api/profiles`, state.profiles, "PUT");
  assert.equal(response.status, 200);

  response = await sendJson(`${baseUrl}/api/episodes`, {
    name: "New episode",
    episodeProfileId: "episode-example-format",
    knowledgeBaseId: "",
    transcriptPromptGuidance: "Keep reactions restrained.",
  });
  assert.equal(response.status, 201);
  const episode = await response.json();
  assert.equal(episode.knowledgeBaseId, "");

  response = await sendJson(`${baseUrl}/api/transcript-prompt/resolve`, { episodeProfileId: episode.episodeProfileId, guidance: episode.transcriptPromptGuidance });
  const prompt = await response.json();
  assert.equal(response.status, 200);
  assert.match(prompt.lockedPrompt, /MiMo/);
  assert.match(prompt.effectivePrompt, /Keep reactions restrained/);
  assert.equal(prompt.capabilities[0].cueMode, "tags");

  const transcript = Array.from({ length: 3 }, (_, index) => `## Segmento ${index + 1}\nAlex: Idea ${index + 1}${index === 0 ? " [pause]" : ""}.`).join("\n\n");
  response = await sendJson(`${baseUrl}/api/episodes/${episode.id}/transcript`, { transcript }, "PUT");
  assert.equal(response.status, 200, (await response.clone().json()).error);
  const saved = await (await fetch(`${baseUrl}/api/episodes/${episode.id}`)).json();
  assert.match(saved.transcript, /\[pause\]/);

  response = await sendJson(`${baseUrl}/api/episodes/${episode.id}/transcript`, { transcript: transcript.replace("[pause]", '<break time="1s" />') }, "PUT");
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /does not support SSML break tags/);
});

test("server restart marks active jobs interrupted", async (t) => {
  withEnv(t, { MIMO_API_KEY: null, ELEVENLABS_API_KEY: null });
  const { rootDir, baseUrl, close } = await startTestServer(t);
  const episode = await seedEpisode(baseUrl, "Interrupted", { knowledge: "# Grounded" });
  await close();

  const episodePath = join(rootDir, "data", "episodes", episode.id, "episode.json");
  const stored = JSON.parse(await readFile(episodePath, "utf8"));
  const now = new Date().toISOString();
  stored.status = "generating";
  stored.job = { id: "stale-job", episodeId: episode.id, type: "transcript", status: "running", phase: "outline", queuedAt: now, updatedAt: now };
  await writeFile(episodePath, JSON.stringify(stored, null, 2));

  const restarted = await startTestServer(t, { rootDir });
  const saved = await (await fetch(`${restarted.baseUrl}/api/episodes/${episode.id}`)).json();
  assert.equal(saved.status, "failed");
  assert.equal(saved.job.status, "interrupted");
  assert.match(saved.lastError, /server restart/);
});

test("job history keeps the newest 30 persisted jobs", async (t) => {
  const { baseUrl } = await startTestServer(t, {}, async (rootDir) => {
    const episodesDir = join(rootDir, "data", "episodes");
    await mkdir(episodesDir, { recursive: true });
    for (let index = 0; index < 35; index += 1) {
      const id = `episode-${String(index).padStart(2, "0")}`;
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
      await mkdir(join(episodesDir, id));
      await writeFile(join(episodesDir, id, "episode.json"), JSON.stringify({
        id,
        name: `Episode ${index}`,
        status: "transcript_ready",
        audioReady: false,
        updatedAt: timestamp,
        job: { id: `job-${String(index).padStart(2, "0")}`, episodeId: id, type: "transcript", status: "completed", phase: "complete", queuedAt: timestamp, updatedAt: timestamp },
      }));
    }
  });
  const jobs = (await (await fetch(`${baseUrl}/api/jobs`)).json()).jobs;
  assert.equal(jobs.length, 30);
  assert.equal(jobs[0].id, "job-34");
  assert.equal(jobs.at(-1).id, "job-05");
  assert.ok(!jobs.some((job) => job.id === "job-04"));
});

// B1/B5 share one stubbed transcript-generation harness.
async function seedRenderedEpisode(baseUrl, rootDir, name) {
  const transcript = Array.from({ length: 3 }, (_, index) =>
    `## Segmento ${index + 1} — Test\nAlex: Idea ${index + 1}.\nSam: Reaction ${index + 1}.`
  ).join("\n\n");
  const episode = await seedEpisode(baseUrl, name, { knowledge: "# Grounded", transcript });
  const episodeFile = join(rootDir, "data", "episodes", episode.id, "episode.json");
  const stored = JSON.parse(await readFile(episodeFile, "utf8"));
  await writeFile(episodeFile, JSON.stringify({ ...stored, audioReady: true, status: "ready" }, null, 2));
  await writeFile(join(rootDir, "data", "episodes", episode.id, "episode.mp3"), "existing-audio");
  return episode;
}

test("the existing render stays playable until a new transcript replaces it", async (t) => {
  const { rootDir, baseUrl } = await startTestServer(t);
  const episode = await seedRenderedEpisode(baseUrl, rootDir, "Rendered episode");
  const before = await (await fetch(`${baseUrl}/api/episodes/${episode.id}`)).json();
  assert.equal(before.audioReady, true);
  assert.match(before.audioUrl, /episode\.mp3$/);

  const response = await sendJson(`${baseUrl}/api/episodes/${episode.id}/transcript`, { transcript: before.transcript.replace("Idea 1.", "New idea 1.") }, "PUT");
  assert.equal(response.status, 200);
  const after = await (await fetch(`${baseUrl}/api/episodes/${episode.id}`)).json();
  assert.equal(after.audioReady, false);
  assert.equal(after.audioUrl, null);
});

test("runProcess stops and reports a command that outlives its timeout", async () => {
  // The child exits by itself: without the timeout this test fails in under a second instead of hanging.
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setTimeout(() => process.exit(3), 500)"], 50),
    (error) => error.message.includes(process.execPath) && /timed out after 50 ms and was stopped with SIGKILL/.test(error.message),
  );
  assert.equal(await runProcess(process.execPath, ["-e", "process.stdout.write('ok')"]), "ok");
});

test("profile saves reject a stale revision instead of overwriting another tab", async (t) => {
  const { baseUrl } = await startTestServer(t);
  const put = (profiles) => sendJson(`${baseUrl}/api/profiles`, profiles, "PUT");
  const tabA = (await (await fetch(`${baseUrl}/api/state`)).json()).profiles;
  const tabB = structuredClone(tabA);

  tabA.speakerProfiles[0].description = "Tab A edit";
  let response = await put(tabA);
  assert.equal(response.status, 200);
  await syncProfiles(response, tabA);

  tabB.episodeProfiles[0].targetMinutes = 21;
  response = await put(tabB);
  const rejected = await response.json();
  assert.equal(response.status, 409);
  assert.match(rejected.error, /Reload the page/);

  const stored = (await (await fetch(`${baseUrl}/api/state`)).json()).profiles;
  assert.equal(stored.speakerProfiles[0].description, "Tab A edit");
  assert.equal(stored.episodeProfiles[0].targetMinutes, 10);

  // The ordinary single-tab flow, which adopts the revisions from each response, still saves.
  tabA.episodeProfiles[0].targetMinutes = 21;
  response = await put(tabA);
  assert.equal(response.status, 200);
  await syncProfiles(response, tabA);

  // A stale tab whose change also removes a format in use is told to reload, not that the format is used.
  const staleTab = structuredClone(tabA);
  tabA.episodeProfiles.push({ ...tabA.episodeProfiles[0], id: "episode-extra", name: "Extra format" });
  tabA.speakerProfiles[0].description = "Tab A later edit";
  response = await put(tabA);
  assert.equal(response.status, 200);
  await syncProfiles(response, tabA);
  response = await sendJson(`${baseUrl}/api/episodes`, { name: "Pinned episode", episodeProfileId: "episode-extra" });
  assert.equal(response.status, 201);

  response = await put(staleTab);
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /Reload the page/);
});

test("a failed config save restores the previous .env with owner-only permissions", async (t) => {
  withEnv(t, { MIMO_API_KEY: "test-mimo-key" });
  const { rootDir, baseUrl } = await startTestServer(t, {
    fetchImpl: async () => Response.json({ data: [{ id: "mimo-v2.5-pro" }, { id: "mimo-v2.5-tts" }] }),
  });
  const providers = { mimo: { baseUrl: "https://api.xiaomimimo.com/v1" }, elevenlabs: {} };
  const saveConfig = (apiKey) => sendJson(`${baseUrl}/api/config`, { providers: { ...providers, mimo: { ...providers.mimo, apiKey } }, compatibleConnections: [] }, "PUT");

  assert.equal((await saveConfig("first-key")).status, 200);
  // A directory in place of config.json fails the write that follows the .env update.
  await rm(join(rootDir, "config.json"));
  await mkdir(join(rootDir, "config.json"));
  assert.equal((await saveConfig("second-key")).status, 500);

  const env = await readFile(join(rootDir, ".env"), "utf8");
  assert.match(env, /first-key/);
  assert.doesNotMatch(env, /second-key/);
  assert.equal((await stat(join(rootDir, ".env"))).mode & 0o777, 0o600);
});

test("an unreadable data file is reported instead of quarantined", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "podcast-unreadable-profiles-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await mkdir(join(rootDir, "data", "profiles.json"), { recursive: true });

  await assert.rejects(createPodcastServer({ rootDir }), /EISDIR/);
  assert.deepEqual((await readdir(join(rootDir, "data"))).filter((name) => name.includes(".corrupt-")), []);
});

test("corrupt config and profiles are quarantined at boot and JSON errors name the file", async (t) => {
  // config.json lives in the config dir (rootDir in tests); profiles.json lives in the data dir.
  for (const [dir, file] of [[[], "config.json"], [["data"], "profiles.json"]]) {
    const { rootDir, baseUrl } = await startTestServer(t, {}, async (root) => {
      await mkdir(join(root, ...dir), { recursive: true });
      await writeFile(join(root, ...dir, file), '{"truncated":');
    });
    const state = await (await fetch(`${baseUrl}/api/state`)).json();
    assert.ok(state.profiles.speakerProfiles.length >= 1);
    assert.ok(state.config.providers.mimo);
    const quarantined = (await readdir(join(rootDir, ...dir))).filter((name) => name.startsWith(`${file}.corrupt-`));
    assert.equal(quarantined.length, 1, `expected one quarantined copy of ${file}`);
    assert.equal(await readFile(join(rootDir, ...dir, quarantined[0]), "utf8"), '{"truncated":');
  }

  const { rootDir: indexRoot, baseUrl } = await startTestServer(t, {}, async (root) => {
    await mkdir(join(root, "data", "knowledge"), { recursive: true });
    await writeFile(join(root, "data", "knowledge", "index.json"), "{");
  });
  const response = await fetch(`${baseUrl}/api/state`);
  assert.equal(response.status, 200);
  const quarantinedIndex = (await readdir(join(indexRoot, "data", "knowledge"))).filter((name) => name.startsWith("index.json.corrupt-"));
  assert.equal(quarantinedIndex.length, 1);
  assert.equal(await readFile(join(indexRoot, "data", "knowledge", quarantinedIndex[0]), "utf8"), "{");
});

test("startup cleanup prunes obsolete artifacts and surfaces corrupt episodes", async (t) => {
  const first = await startTestServer(t);
  const { rootDir } = first;
  const transcript = Array.from({ length: 3 }, (_, index) => `## Segmento ${index + 1}\nAlex: Idea ${index + 1}.`).join("\n\n");
  const episode = await seedEpisode(first.baseUrl, "Healthy", { transcript });
  await first.close();

  const healthyDir = join(rootDir, "data", "episodes", episode.id);
  const clipsDir = join(healthyDir, "clips");
  await mkdir(clipsDir, { recursive: true });
  await writeFile(join(healthyDir, "concat.txt"), "obsolete");
  await writeFile(join(clipsDir, `${"e".repeat(64)}.wav`), silentWav());
  const cachedSilence = join(clipsDir, "silence-1200ms.wav");
  await writeFile(cachedSilence, silentWav());
  const corruptDir = join(rootDir, "data", "episodes", "corrupt-episode");
  await mkdir(corruptDir, { recursive: true });
  await writeFile(join(corruptDir, "episode.json"), "{bad json");
  await writeFile(join(corruptDir, "concat.txt"), "preserve");
  const deletingDir = join(rootDir, "data", "episodes", "pending-delete.deleting");
  await mkdir(deletingDir, { recursive: true });
  await writeFile(join(deletingDir, "partial-audio.wav"), "partial");

  const { baseUrl } = await startTestServer(t, { rootDir });
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  const corrupt = state.episodes.find((item) => item.id === "corrupt-episode");
  assert.equal(corrupt.status, "corrupt");
  assert.equal(corrupt.corrupt, true);
  await assert.rejects(readFile(join(healthyDir, "concat.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(join(clipsDir, `${"e".repeat(64)}.wav`)), { code: "ENOENT" });
  assert.ok((await readFile(cachedSilence)).length > 0);
  assert.equal(await readFile(join(corruptDir, "concat.txt"), "utf8"), "preserve");
  await assert.rejects(readFile(join(deletingDir, "partial-audio.wav")), { code: "ENOENT" });

  state.config.providers.mimo.enabled = false;
  const response = await sendJson(`${baseUrl}/api/config`, state.config, "PUT");
  assert.equal(response.status, 200);
  assert.match((await response.json()).warnings.join(" "), /corrupt episodes/);
});

test("TTS rejects missing FFmpeg before provider calls", async (t) => {
  withEnv(t, { MIMO_API_KEY: null, ELEVENLABS_API_KEY: null, OPENAI_API_KEY: null });
  let providerCalls = 0;
  const { baseUrl } = await startTestServer(t, {
    fetchImpl: async () => { providerCalls += 1; return Response.json({ data: [] }); },
  });
  const transcript = Array.from({ length: 5 }, (_, index) => `## Segmento ${index + 1}\nAlex: Idea ${index + 1}.`).join("\n\n");
  const episode = await seedEpisode(baseUrl, "No FFmpeg", { transcript });
  let response;
  const callsBeforeRender = providerCalls;
  const oldPath = process.env.PATH;
  process.env.PATH = "";
  try {
    response = await fetch(`${baseUrl}/api/episodes/${episode.id}/render`, { method: "POST" });
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  }
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /FFmpeg or FFprobe is unavailable/);
  assert.equal(providerCalls, callsBeforeRender);
});

test("built-in OpenAI discovers models and uses the TTS endpoint", async (t) => {
  withEnv(t, { MIMO_API_KEY: null, ELEVENLABS_API_KEY: null, OPENAI_API_KEY: null });

  const compatCalls = [];
  const fetchImpl = async (url, options = {}) => {
    compatCalls.push({ url: String(url), options });
    if (String(url).endsWith("/models")) {
      return Response.json({ data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o-mini-tts" }, { id: "whisper-1" }] });
    }
    if (String(url).endsWith("/audio/speech")) {
      return new Response(silentWav(24_000, 1, 0.1), { status: 200, headers: { "Content-Type": "audio/wav" } });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const { rootDir, baseUrl } = await startTestServer(t, { fetchImpl });

  let response = await sendJson(`${baseUrl}/api/config`, {
    providers: {
      mimo: { baseUrl: "https://api.xiaomimimo.com/v1" },
      elevenlabs: {},
      openai: {
        baseUrl: "https://api.openai.com/v1",
        ttsBaseUrl: "https://tts.example/v1",
        modelsUrl: "https://catalog.example/v1/models",
        enabled: true,
        apiKey: "sk-openai-test",
        activeModels: { "gpt-4o-mini-tts": { tts: true } },
      },
    },
    compatibleConnections: [],
  }, "PUT");
  const savedConfig = await response.json();
  assert.equal(response.status, 200);
  assert.equal(savedConfig.config.providers.mimo.hasApiKey, false);
  assert.equal(savedConfig.config.providers.openai.hasApiKey, true);
  assert.doesNotMatch(JSON.stringify(savedConfig), /sk-openai-test/);
  assert.equal(Object.hasOwn(savedConfig.modelCatalog.providers.openai, "textModels"), false);
  assert.deepEqual(savedConfig.modelCatalog.providers.openai.ttsModels.map((model) => model.id), ["compat:openai:gpt-4o-mini-tts"]);

  const envFile = await readFile(join(rootDir, ".env"), "utf8");
  assert.match(envFile, /OPENAI_API_KEY=sk-openai-test/);

  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  state.profiles.episodeProfiles[0].language = "en-US";
  state.profiles.speakerProfiles[0].voiceModel = "compat:openai:gpt-4o-mini-tts";
  state.profiles.speakerProfiles[0].speakers[0].voiceId = "alloy";
  state.profiles.speakerProfiles[0].speakers[1].voiceId = "alloy";
  response = await sendJson(`${baseUrl}/api/profiles`, state.profiles, "PUT");
  assert.equal(response.status, 200);

  response = await sendJson(`${baseUrl}/api/preview`, { episodeProfileId: "episode-example-format", speakerProfileId: "speaker-example-hosts", speakerIndex: 0, text: "Hello there", cue: "warm" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/wav");
  const preview = Buffer.from(await response.arrayBuffer());
  assert.equal(preview.readUInt16LE(20), 1);
  assert.equal(preview.readUInt16LE(22), 1);
  assert.equal(preview.readUInt32LE(24), 24_000);
  assert.equal(preview.readUInt16LE(34), 16);

  assert.equal(compatCalls.some((call) => call.url.endsWith("/chat/completions")), false);
  const ttsRequest = compatCalls.find((call) => call.url.endsWith("/audio/speech"));
  const ttsBody = JSON.parse(ttsRequest.options.body);
  assert.equal(ttsRequest.url, "https://tts.example/v1/audio/speech");
  assert.equal(header(ttsRequest.options, "authorization"), "Bearer sk-openai-test");
  assert.equal(ttsBody.model, "gpt-4o-mini-tts");
  assert.equal(ttsBody.voice, "alloy");
  assert.equal(ttsBody.input, "Hello there");
  assert.match(ttsBody.instructions, /Required spoken language: English \(United States\) \(en-US\)/);
});

test("compatible config owns env names and blocks referenced connection removal", async (t) => {
  withEnv(t, { MIMO_API_KEY: "test-mimo-key", OPENAI_API_KEY: null });
  const { rootDir, baseUrl } = await startTestServer(t, {
    fetchImpl: async (url) => {
      if (String(url).includes("xiaomimimo.com")) return Response.json({ data: [{ id: "mimo-v2.5-pro" }, { id: "mimo-v2.5-tts" }] });
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "custom-tts" }] });
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  const providers = { mimo: { baseUrl: "https://api.xiaomimimo.com/v1" }, elevenlabs: {}, openai: { baseUrl: "https://api.openai.com/v1", enabled: false } };

  let response = await sendJson(`${baseUrl}/api/config`, { providers, compatibleConnections: [{ id: "safe_connection", name: "Safe", baseUrl: "https://safe.example/v1", enabled: true, apiKeyEnv: "MIMO_API_KEY", apiKey: "compat-secret", activeModels: { "custom-tts": { tts: true } } }] }, "PUT");
  const configured = await response.json();
  assert.equal(response.status, 200);
  assert.match(configured.config.compatibleConnections[0].apiKeyEnv, /^OPENAI_COMPAT_SAFE_[A-F0-9]{12}_API_KEY$/);
  assert.notEqual(process.env.MIMO_API_KEY, "compat-secret");

  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  state.profiles.speakerProfiles[0].voiceModel = "compat:safe_connection:custom-tts";
  response = await sendJson(`${baseUrl}/api/profiles`, state.profiles, "PUT");
  assert.equal(response.status, 200);
  await syncProfiles(response, state.profiles);

  const connection = { id: "safe_connection", name: "Safe", baseUrl: "https://safe.example/v1", enabled: true, activeModels: { "custom-tts": { tts: true } } };
  response = await sendJson(`${baseUrl}/api/config`, { providers, compatibleConnections: [{ ...connection, activeModels: {} }] }, "PUT");
  const deactivated = await response.json();
  assert.equal(response.status, 200);
  assert.match(deactivated.warnings.join(" "), /speaker profile/);
  assert.equal(deactivated.modelCatalog.providers.compatible[0].ttsModels.length, 0);
  response = await sendJson(`${baseUrl}/api/config`, { providers, compatibleConnections: [connection] }, "PUT");
  assert.equal(response.status, 200);

  response = await sendJson(`${baseUrl}/api/config`, { providers, compatibleConnections: [{ ...connection, apiKey: "replacement", clearApiKey: true }] }, "PUT");
  assert.equal(response.status, 400);
  response = await sendJson(`${baseUrl}/api/config`, { providers, compatibleConnections: [{ ...connection, clearApiKey: true }] }, "PUT");
  assert.equal(response.status, 200);
  assert.doesNotMatch(await readFile(join(rootDir, ".env"), "utf8"), /compat-secret/);
  assert.equal((await stat(join(rootDir, ".env"))).mode & 0o777, 0o600);
  response = await sendJson(`${baseUrl}/api/config`, { providers, compatibleConnections: [{ ...connection, apiKey: "compat-secret" }] }, "PUT");
  assert.equal(response.status, 200);

  response = await sendJson(`${baseUrl}/api/config`, { providers, compatibleConnections: [] }, "PUT");
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /speaker profile/);

  const episode = await seedEpisode(baseUrl, "Saved dependency");

  state.profiles.speakerProfiles[0].voiceModel = "mimo-v2.5-tts";
  response = await sendJson(`${baseUrl}/api/profiles`, state.profiles, "PUT");
  assert.equal(response.status, 200);
  response = await sendJson(`${baseUrl}/api/config`, { providers, compatibleConnections: [] }, "PUT");
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /saved episode "Saved dependency"/);
  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/profiles`, { method: "PUT" });
  assert.equal(response.status, 200);
  response = await sendJson(`${baseUrl}/api/config`, { providers, compatibleConnections: [] }, "PUT");
  assert.equal(response.status, 200);
  assert.doesNotMatch(await readFile(join(rootDir, ".env"), "utf8"), /compat-secret/);
});

test("Chatterbox discovers and renders active TTS models without an API key", async (t) => {
  withEnv(t, { MIMO_API_KEY: null, ELEVENLABS_API_KEY: null, OPENAI_API_KEY: null, CHATTERBOX_API_KEY: null });
  const calls = [];
  let chatterboxOnline = true;
  let invalidAudio = false;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (!chatterboxOnline) throw new Error("fetch failed");
    if (String(url).endsWith("/models")) return Response.json({ data: [
      { id: "chatterbox-turbo", capabilities: { tts: true } },
      { id: "fallback-tts" },
    ] });
    if (String(url).endsWith("/voices")) {
      const voices = [
        { id: "female", name: "Female", builtin: true, file: "voices/female.wav" },
        { id: "custom", name: "Custom", builtin: false, file: "voices/custom.wav" },
        { id: "charlie_EN", name: "Charlie", builtin: false, file: "voices/charlie_EN.wav" },
        { name: "Missing ID", file: "voices/invalid.wav" },
      ];
      return Response.json(calls.filter((call) => call.url.endsWith("/voices")).length === 1 ? { object: "list", data: voices } : voices);
    }
    if (String(url).endsWith("/audio/speech")) return new Response(invalidAudio ? Buffer.from("not audio") : silentFloatWav(24_000, 0.1), { headers: { "Content-Type": "audio/wav" } });
    throw new Error(`Unexpected URL ${url}`);
  };
  const { rootDir, baseUrl } = await startTestServer(t, { fetchImpl });
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  state.config.providers.chatterbox = { baseUrl: "http://127.0.0.1:8100/v1", modelsUrl: "", enabled: true, activeModels: { "chatterbox-turbo": { tts: true } } };
  let response = await sendJson(`${baseUrl}/api/config`, state.config, "PUT");
  const configured = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(configured.modelCatalog.providers.chatterbox.ttsModels.map((model) => model.id), ["compat:chatterbox:chatterbox-turbo"]);
  assert.deepEqual(configured.modelCatalog.providers.chatterbox.discoveredModels.map((model) => model.suggested), [
    { tts: true },
    { tts: true },
  ]);
  assert.ok(calls.some((call) => call.url === "http://127.0.0.1:8100/v1/models"));
  response = await fetch(`${baseUrl}/api/tts/chatterbox/voices`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { voices: [
    { id: "female", name: "Female", builtin: true },
    { id: "custom", name: "Custom", builtin: false },
    { id: "charlie_EN", name: "Charlie", builtin: false },
  ] });
  const voiceCall = calls.find((call) => call.url.endsWith("/voices"));
  assert.equal(voiceCall.options.headers.Authorization, undefined);
  process.env.CHATTERBOX_API_KEY = "test-chatterbox-key";
  response = await fetch(`${baseUrl}/api/tts/chatterbox/voices`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).voices.map((voice) => voice.id), ["female", "custom", "charlie_EN"]);
  assert.equal(calls.filter((call) => call.url.endsWith("/voices"))[1].options.headers.Authorization, "Bearer test-chatterbox-key");
  delete process.env.CHATTERBOX_API_KEY;
  state.profiles.speakerProfiles[0].voiceModel = "compat:chatterbox:chatterbox-turbo";
  state.profiles.speakerProfiles[0].speakers[0].voiceId = "female";
  state.profiles.speakerProfiles[0].speakers[0].chatterboxExaggeration = 0.8;
  state.profiles.speakerProfiles[0].speakers[0].chatterboxCfgWeight = 0.25;
  state.profiles.speakerProfiles[0].speakers[0].chatterboxTemperature = 0.65;
  state.profiles.episodeProfiles[0].language = "es-419";
  response = await sendJson(`${baseUrl}/api/profiles`, state.profiles, "PUT");
  assert.equal(response.status, 200);
  await syncProfiles(response, state.profiles);
  response = await sendJson(`${baseUrl}/api/transcript-prompt/resolve`, { episodeProfileId: "episode-example-format" });
  let transcriptPrompt = await response.json();
  assert.match(transcriptPrompt.lockedPrompt, /does not support inline tags/);
  assert.equal(transcriptPrompt.capabilities[0].cueMode, "delivery");
  response = await sendJson(`${baseUrl}/api/preview`, { episodeProfileId: "episode-example-format", speakerProfileId: "speaker-example-hosts", speakerIndex: 0, text: "[laugh] Hola", cue: "warm" });
  assert.equal(response.status, 200);
  const preview = Buffer.from(await response.arrayBuffer());
  assert.equal(response.headers.get("content-type"), "audio/wav");
  assert.equal(preview.readUInt16LE(20), 1);
  assert.equal(preview.readUInt16LE(22), 1);
  assert.equal(preview.readUInt32LE(24), 24_000);
  assert.equal(preview.readUInt16LE(34), 16);
  const ttsCall = calls.find((call) => call.url.endsWith("/audio/speech"));
  assert.equal(header(ttsCall.options, "authorization"), null);
  assert.deepEqual(JSON.parse(ttsCall.options.body), {
    model: "chatterbox-turbo",
    voice: "female",
    input: "Hola",
    response_format: "wav",
    instructions: JSON.parse(ttsCall.options.body).instructions,
    exaggeration: 0.8,
    cfg_weight: 0.25,
    temperature: 0.65,
    language: "es",
  });

  state.profiles.episodeProfiles[0].language = "en-US";
  response = await sendJson(`${baseUrl}/api/profiles`, state.profiles, "PUT");
  assert.equal(response.status, 200);
  await syncProfiles(response, state.profiles);
  response = await sendJson(`${baseUrl}/api/transcript-prompt/resolve`, { episodeProfileId: "episode-example-format" });
  transcriptPrompt = await response.json();
  assert.match(transcriptPrompt.lockedPrompt, /English Turbo/);
  assert.match(transcriptPrompt.lockedPrompt, /\[laugh\]/);
  assert.equal(transcriptPrompt.capabilities[0].cueMode, "tags");
  response = await sendJson(`${baseUrl}/api/preview`, { episodeProfileId: "episode-example-format", speakerProfileId: "speaker-example-hosts", speakerIndex: 0, text: "[laugh] Hello", cue: "warm" });
  assert.equal(response.status, 200);
  const ttsCalls = calls.filter((call) => call.url.endsWith("/audio/speech"));
  assert.equal(JSON.parse(ttsCalls.at(-1).options.body).input, "[laugh] Hello");
  assert.equal(JSON.parse(ttsCalls.at(-1).options.body).language, "en");

  const charlieProfile = structuredClone(state.profiles.speakerProfiles[0]);
  charlieProfile.id = "speaker-charlie";
  charlieProfile.name = "Charlie";
  charlieProfile.speakers = [{ ...charlieProfile.speakers[0], name: "Charlie", voiceId: "charlie_EN" }];
  state.profiles.speakerProfiles.push(charlieProfile);
  response = await sendJson(`${baseUrl}/api/profiles`, state.profiles, "PUT");
  assert.equal(response.status, 200);
  response = await sendJson(`${baseUrl}/api/episodes`, { name: "Charlie override", episodeProfileId: "episode-example-format", speakerProfileId: "speaker-charlie" });
  const overrideEpisode = await response.json();
  assert.equal(response.status, 201, overrideEpisode.error);
  response = await sendJson(`${baseUrl}/api/transcript-prompt/resolve`, { episodeId: overrideEpisode.id });
  transcriptPrompt = await response.json();
  assert.equal(response.status, 200, transcriptPrompt.error);
  assert.deepEqual(transcriptPrompt.capabilities.map((item) => item.speaker), ["Charlie"]);
  assert.match(transcriptPrompt.lockedPrompt, /Chatterbox \(Charlie/);
  response = await sendJson(`${baseUrl}/api/transcript-prompt/resolve`, { episodeProfileId: "episode-example-format", speakerProfileId: "speaker-charlie" });
  assert.deepEqual((await response.json()).capabilities.map((item) => item.speaker), ["Charlie"]);
  response = await sendJson(`${baseUrl}/api/preview`, { episodeId: overrideEpisode.id, speakerIndex: 0, text: "Hello", cue: "warm" });
  assert.equal(response.status, 200);
  const legacyPath = join(rootDir, "data", "episodes", overrideEpisode.id, "episode.json");
  const legacyEpisode = JSON.parse(await readFile(legacyPath, "utf8"));
  delete legacyEpisode.episodeProfile;
  delete legacyEpisode.speakerProfile;
  await writeFile(legacyPath, JSON.stringify(legacyEpisode, null, 2));
  response = await sendJson(`${baseUrl}/api/transcript-prompt/resolve`, { episodeId: overrideEpisode.id });
  assert.deepEqual((await response.json()).capabilities.map((item) => item.speaker), ["Charlie"]);

  invalidAudio = true;
  response = await sendJson(`${baseUrl}/api/preview`, { episodeId: overrideEpisode.id, speakerIndex: 0, text: "Hello", cue: "warm" });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /Charlie: TTS model .* returned unsupported or invalid audio \(audio\/wav\)/);
  assert.ok(!(await readdir(join(rootDir, "data"))).some((name) => name.startsWith(".preview-")));
  invalidAudio = false;

  chatterboxOnline = false;
  response = await sendJson(`${baseUrl}/api/config`, state.config, "PUT");
  assert.equal((await response.json()).modelCatalog.providers.chatterbox.status, "error");
  response = await sendJson(`${baseUrl}/api/preview`, { episodeId: overrideEpisode.id, speakerIndex: 0, text: "Hello", cue: "warm" });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Charlie: Chatterbox is unavailable at http:\/\/127\.0\.0\.1:8100\/v1: .*fetch failed/);
});

test("profile saves warn for existing unavailable saved models", async (t) => {
  withEnv(t, { MIMO_API_KEY: null, ELEVENLABS_API_KEY: null, OPENAI_API_KEY: null, CHATTERBOX_API_KEY: null });

  const seeded = structuredClone(DEFAULT_DATA);
  seeded.speakerProfiles[0].voiceModel = "compat:chatterbox:chatterbox-multilingual-v3";
  seeded.speakerProfiles[0].speakers = seeded.speakerProfiles[0].speakers.map((speaker) => ({ ...speaker, voiceId: "female" }));
  const { baseUrl } = await startTestServer(t, {
    fetchImpl: async () => { throw new Error("No provider calls expected."); },
  }, async (rootDir) => {
    await mkdir(join(rootDir, "data"), { recursive: true });
    await writeFile(join(rootDir, "data", "profiles.json"), JSON.stringify(seeded, null, 2));
  });

  let state = await (await fetch(`${baseUrl}/api/state`)).json();
  let response = await sendJson(`${baseUrl}/api/profiles`, state.profiles, "PUT");
  let saved = await response.json();
  assert.equal(response.status, 200);
  assert.match(saved.warnings.join(" "), /compat:chatterbox:chatterbox-multilingual-v3/);

  const invalid = structuredClone(state.profiles);
  invalid.speakerProfiles[0].voiceModel = "compat:chatterbox:brand-new-unknown";
  response = await sendJson(`${baseUrl}/api/profiles`, invalid, "PUT");
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Unsupported TTS model/);

});

test("content plans support CRUD and appear in state", async (t) => {
  const { rootDir, baseUrl } = await startTestServer(t);
  let state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.deepEqual(state.plans, []);
  assert.deepEqual(JSON.parse(await readFile(join(rootDir, "data", "plans", "index.json"), "utf8")), []);

  let response = await sendJson(`${baseUrl}/api/plans`, { id: "../../escape", name: "Series", theme: "Initial", episodeCount: 3, episodes: [{ id: "client-owned" }] });
  assert.equal(response.status, 201);
  let plan = (await response.json()).plan;
  assert.notEqual(plan.id, "../../escape");
  assert.deepEqual(plan.episodes, []);
  assert.equal(plan.status, "draft");
  assert.equal(plan.episodeFormatId, "");
  assert.equal(plan.language, state.profiles.episodeProfiles[0].language);
  assert.equal(plan.targetMinutes, state.profiles.episodeProfiles[0].targetMinutes);
  const storedPlanPath = join(rootDir, "data", "plans", `${plan.id}.json`);
  const storedPlan = JSON.parse(await readFile(storedPlanPath, "utf8"));
  storedPlan.episodes = [{ id: "planned-one", number: 1, title: "One" }, { id: "planned-two", number: 2, title: "Two", createdEpisodeId: "created-two" }];
  await writeFile(storedPlanPath, JSON.stringify(storedPlan, null, 2));
  plan = (await (await fetch(`${baseUrl}/api/plans/${plan.id}`)).json()).plan;
  response = await fetch(`${baseUrl}/api/plans/${plan.id}/episodes/planned-one`, { method: "DELETE" });
  plan = (await response.json()).plan;
  assert.equal(response.status, 200);
  assert.deepEqual(plan.episodes.map((item) => item.id), ["planned-two"]);
  response = await fetch(`${baseUrl}/api/plans/${plan.id}/episodes/planned-two`, { method: "DELETE" });
  assert.equal(response.status, 409);
  response = await sendJson(`${baseUrl}/api/plans/${plan.id}`, { ...plan, theme: "Updated" }, "PUT");
  assert.equal(response.status, 200);
  plan = (await response.json()).plan;
  assert.equal(plan.theme, "Updated");
  assert.equal((await (await fetch(`${baseUrl}/api/plans`)).json()).plans[0].id, plan.id);
  assert.equal((await (await fetch(`${baseUrl}/api/plans/${plan.id}`)).json()).plan.theme, "Updated");
  state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.plans[0].id, plan.id);
  response = await fetch(`${baseUrl}/api/plans/${plan.id}`, { method: "DELETE" });
  assert.equal(response.status, 200);
  assert.deepEqual((await (await fetch(`${baseUrl}/api/plans`)).json()).plans, []);
});

test("content plans validate references and save without planning-model fields", async (t) => {
  const { baseUrl, rootDir } = await startTestServer(t);
  let response = await sendJson(`${baseUrl}/api/plans`, { name: "Plan", planningModel: "mimo-v2.5-pro", planningEffort: "max" });
  assert.equal(response.status, 201);
  let plan = (await response.json()).plan;
  for (const key of ["planningModel", "planningEffort"]) assert.equal(Object.hasOwn(plan, key), false, key);
  response = await sendJson(`${baseUrl}/api/plans/${plan.id}`, { ...plan, theme: "Theme", planningModel: "mimo-v2.5-pro", expectedUpdatedAt: plan.updatedAt }, "PUT");
  assert.equal(response.status, 200);
  plan = (await response.json()).plan;
  assert.equal(plan.theme, "Theme");
  assert.equal(Object.hasOwn(plan, "planningModel"), false);
  const stored = JSON.parse(await readFile(join(rootDir, "data", "plans", `${plan.id}.json`), "utf8"));
  assert.equal(Object.hasOwn(stored, "planningModel"), false);
  assert.equal((await sendJson(`${baseUrl}/api/plans/${plan.id}/generate`, {})).status, 404);
  response = await sendJson(`${baseUrl}/api/plans/${plan.id}`, { ...plan, knowledgeBaseId: "missing" }, "PUT");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Knowledge base does not exist.");
});

test("plans create episode drafts, and episode and Hosts deletes update plan references", async (t) => {
  const { rootDir, baseUrl } = await startTestServer(t);
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  const speakerProfileId = state.profiles.speakerProfiles[0].id;
  // Planned episodes come from the agent in phase 2; until then a test writes them into the stored plan.
  const createPlan = async (body, episodes) => {
    const created = (await (await sendJson(`${baseUrl}/api/plans`, body)).json()).plan;
    const path = join(rootDir, "data", "plans", `${created.id}.json`);
    const stored = { ...JSON.parse(await readFile(path, "utf8")), episodes: episodes.map((item, index) => normalizePlannedEpisode({ number: index + 1, ...item })) };
    await writeFile(path, JSON.stringify(stored, null, 2));
    return stored;
  };
  const noFormat = await createPlan({ name: "No format", speakerProfileId, theme: "Theme" }, [{ title: "Only" }]);
  let response = await sendJson(`${baseUrl}/api/plans/${noFormat.id}/create-episodes`, { plannedEpisodeIds: [noFormat.episodes[0].id] });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Pick an Episode Format for the plan before creating episode drafts.");

  const plan = await createPlan({ name: "Kept name", speakerProfileId, episodeFormatId: "episode-example-format", theme: "Build reliable software", audience: "Engineers", goal: "Teach" }, [
    { title: "First", premise: "First premise", keyPoints: ["Point A"], transcriptPromptGuidance: "Use a concise opening." },
    { title: "Second" },
  ]);
  response = await sendJson(`${baseUrl}/api/plans/${plan.id}/create-episodes`, { plannedEpisodeIds: plan.episodes.map((item) => item.id) });
  const created = await response.json();
  assert.equal(response.status, 200, created.error);
  assert.equal(created.episodes.length, 2);
  assert.match(created.episodes[0].additionalInstructions, /Point A/);
  assert.match(created.episodes[1].additionalInstructions, /Planned episode:\nNone\./);
  assert.equal(created.episodes[0].transcriptPromptGuidance, "Use a concise opening.");
  assert.equal(created.episodes[0].speakerProfileId, speakerProfileId);
  assert.ok(created.plan.episodes.every((item) => item.createdEpisodeId));
  assert.ok(await readFile(join(rootDir, "data", "episodes", created.episodes[0].id, "episode.json"), "utf8"));

  const deleteTarget = created.episodes[1];
  response = await fetch(`${baseUrl}/api/episodes/${deleteTarget.id}`, { method: "DELETE" });
  assert.equal(response.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/episodes/${deleteTarget.id}`)).status, 404);
  const planAfterDelete = (await (await fetch(`${baseUrl}/api/plans/${plan.id}`)).json()).plan;
  assert.equal(planAfterDelete.episodes.length, 1);
  assert.ok(planAfterDelete.episodes.every((item) => item.createdEpisodeId !== deleteTarget.id));
  assert.equal((await fetch(`${baseUrl}/api/episodes/${deleteTarget.id}`, { method: "DELETE" })).status, 404);

  assert.equal((await fetch(`${baseUrl}/api/speaker-profiles/unknown-profile`, { method: "DELETE" })).status, 404);
  const profiles = structuredClone(state.profiles);
  profiles.speakerProfiles.push({ ...structuredClone(profiles.speakerProfiles[0]), id: "fallback-hosts", name: "Fallback" });
  assert.equal((await sendJson(`${baseUrl}/api/profiles`, profiles, "PUT")).status, 200);
  response = await fetch(`${baseUrl}/api/speaker-profiles/${speakerProfileId}`, { method: "DELETE" });
  const profileDelete = await response.json();
  assert.equal(response.status, 200, profileDelete.error);
  assert.equal(profileDelete.repointedPlans, 2);
  assert.equal((await (await fetch(`${baseUrl}/api/plans/${plan.id}`)).json()).plan.speakerProfileId, profileDelete.fallbackId);
  const remaining = (await (await fetch(`${baseUrl}/api/state`)).json()).profiles.speakerProfiles;
  assert.equal(remaining.length, 1);
  assert.equal((await fetch(`${baseUrl}/api/speaker-profiles/${remaining[0].id}`, { method: "DELETE" })).status, 400);

  assert.equal((await fetch(`${baseUrl}/api/plans/${plan.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/plans/${plan.id}`)).status, 404);
});

test("normalizeGeneratedPlan keeps the plan JSON contract for agent-written plans", () => {
  const raw = { episodeFormat: { name: "Interview", description: "Focused" }, episodes: [{ number: 1, title: "First" }, { number: 2, title: "Second" }], detailedEpisode: { number: 1, premise: "First premise" } };
  const result = normalizeGeneratedPlan(raw, { episodeCount: null, episodeFormatId: "" });
  assert.deepEqual(result.episodeFormat, { name: "Interview", description: "Focused" });
  assert.equal(result.episodeCount, 2);
  assert.deepEqual(result.episodes.map((item) => [item.title, item.premise]), [["First", "First premise"], ["Second", ""]]);
  assert.equal(normalizeGeneratedPlan(raw, { episodeCount: 2, episodeFormatId: "f" }).episodeFormat, null);
  assert.throws(() => normalizeGeneratedPlan(raw, { episodeCount: 3, episodeFormatId: "f" }), /exactly 3 episodes/);
  assert.throws(() => normalizeGeneratedPlan({ episodes: [{ number: 2, title: "x" }] }, { episodeCount: null, episodeFormatId: "f" }), /invalid numbering/);
});

test("index.html stays CSP-safe: no inline style or event-handler attributes", async () => {
  assert.doesNotMatch(html, /\sstyle=/);
  assert.doesNotMatch(html, /\son[a-z]+=/);
  assert.doesNotMatch(html, /javascript:/);
  assert.equal(html.match(/<script/g).length, 1);
  assert.equal(html.match(/<style/g).length, 1);
});

test("v4 controls preserve hidden legacy settings and select only active v4 for new profiles", async () => {
  new Script(script);
  const fields = runInNewContext(`(${source("providerTtsFields")})`, {
    ttsProvider: () => "elevenlabs", option: () => "", escapeHtml: (value) => String(value),
  });
  const v4Fields = fields({}, "eleven_v4");
  assert.match(v4Fields, /data-field="elevenlabsStability"/);
  assert.match(v4Fields, /data-field="elevenlabsSimilarityBoost"/);
  assert.doesNotMatch(v4Fields, /data-field="elevenlabs(?:Style|Speed|UseSpeakerBoost)"/);
  assert.match(v4Fields, /not SSML/);
  assert.match(fields({}, "eleven_v3"), /data-field="elevenlabsSpeed"/, "legacy model controls must remain available");

  const speaker = { name: "Host", voiceId: "voice", backstory: "Story", personality: "Calm", style: "Natural", accent: "", ttsModelOverride: "", elevenlabsStyle: 0.6, elevenlabsSpeed: 1.1, elevenlabsUseSpeakerBoost: false, elevenlabsSeed: 42, elevenlabsTextNormalization: "off" };
  const profile = { id: "host-profile", name: "Hosts", voiceModel: "eleven_v4", speakers: [speaker] };
  const values = { spName: "Hosts", spDescription: "", spVoiceModel: "eleven_v4", spInstructions: "" };
  const card = { querySelector(selector) {
    const field = selector.match(/data-field="([^"]+)"/)[1];
    return ["name", "voiceId", "backstory", "personality", "style", "accent", "ttsModelOverride"].includes(field) ? { value: speaker[field] } : null;
  } };
  const context = {
    state: { profiles: { speakerProfiles: [profile] } }, activeSpeakerProfileId: profile.id,
    $: (id) => ({ value: values[id] }), document: { querySelectorAll: () => [card] },
    optionalNumberField: (_, __, fallback) => fallback ?? null,
  };
  runInNewContext(`(${source("syncSpeakerForm")})()`, context);
  const synced = profile.speakers[0];
  for (const field of ["elevenlabsStyle", "elevenlabsSpeed", "elevenlabsUseSpeakerBoost", "elevenlabsSeed", "elevenlabsTextNormalization"]) assert.equal(synced[field], speaker[field]);

  for (const models of [[{ id: "eleven_v3" }, { id: "eleven_v4" }], [{ id: "eleven_v3" }], []]) {
    const createContext = {
      state: { profiles: { speakerProfiles: [profile] } }, activeSpeakerProfileId: profile.id,
      syncSpeakerForm() {}, discoveredModels: () => models, defaultVoiceId: () => "voice", renderProfileOptions() {},
      crypto: { randomUUID: () => "new-profile" }, structuredClone,
    };
    runInNewContext(`(${source("addSpeakerProfile")})(false)`, createContext);
    assert.equal(createContext.state.profiles.speakerProfiles[1].voiceModel, models.some((model) => model.id === "eleven_v4") ? "eleven_v4" : models[0]?.id || "");
    assert.equal(profile.voiceModel, "eleven_v4");
  }
});

test("index.html guards every long job behind the shared button lock", async () => {
  assert.match(html, /\$\("renderAudio"\)\.addEventListener\("click", guard\(\(\) => lockWhile\(\$\("renderAudio"\), renderAudio\)\)\)/);
  // The button is re-enabled before the render, so a throwing render cannot leave it disabled forever.
  assert.match(html, /finally \{ delete button\.dataset\.busy; button\.disabled = false; renderJobIndicators\(\); \}/);
});

test("package-lock version agrees with package.json", async () => {
  const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(process.cwd(), "package-lock.json"), "utf8"));
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
});

test("provider-only config saves keep compatible connections and keys", async (t) => {
  const { baseUrl } = await startTestServer(t, { fetchImpl: async () => Response.json({ data: [] }) });
  let response = await sendJson(`${baseUrl}/api/config`, { compatibleConnections: [{ id: "unused", name: "Unused", baseUrl: "https://unused.example/v1", apiKey: "test-connection-key" }] }, "PUT");
  assert.equal(response.status, 200);
  const connection = (await response.json()).config.compatibleConnections[0];
  assert.equal(connection.hasApiKey, true);
  for (const compatibleConnections of [undefined, null, {}]) {
    response = await sendJson(`${baseUrl}/api/config`, { providers: {}, compatibleConnections }, "PUT");
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).config.compatibleConnections, [connection]);
  }
  response = await sendJson(`${baseUrl}/api/config`, { compatibleConnections: [] }, "PUT");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).config.compatibleConnections, []);
});

test("startup removes only old audio-ready clip caches", async (t) => {
  const first = await startTestServer(t);
  const episodes = [];
  for (const name of ["Old ready", "Recent ready", "Old not ready"]) episodes.push(await seedEpisode(first.baseUrl, name, { transcript: "## Segment 1\nAlex: First.\n\n## Segment 2\nAlex: Second.\n\n## Segment 3\nAlex: Third." }));
  await first.close();
  for (const [index, episode] of episodes.entries()) {
    const directory = join(first.rootDir, "data", "episodes", episode.id);
    const path = join(directory, "episode.json");
    const stored = JSON.parse(await readFile(path, "utf8"));
    stored.audioReady = index !== 2;
    stored.updatedAt = new Date(Date.now() - (index === 1 ? 1 : 31) * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(path, JSON.stringify(stored));
    await mkdir(join(directory, "clips"));
    await writeFile(join(directory, "clips", "silence-1200ms.wav"), silentWav());
    await writeFile(join(directory, "episode.mp3"), "saved audio");
  }
  await startTestServer(t, { rootDir: first.rootDir });
  for (const [index, episode] of episodes.entries()) {
    const directory = join(first.rootDir, "data", "episodes", episode.id);
    assert.equal(await readFile(join(directory, "episode.mp3"), "utf8"), "saved audio");
    if (index === 0) await assert.rejects(stat(join(directory, "clips")), { code: "ENOENT" });
    else assert.ok((await readFile(join(directory, "clips", "silence-1200ms.wav"))).length > 0);
  }
});

for (const failure of ["network", "401", "429", "500", "timeout", "repeated network"]) test(`TTS turn retry handles ${failure}`, async (t) => {
  withEnv(t, { MIMO_API_KEY: "test-mimo-key", ELEVENLABS_API_KEY: null });
  let requests = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "mimo-v2.5-tts" }] });
    requests += 1;
    if (failure === "repeated network" || requests === 1 && failure === "network") throw new TypeError("fetch failed");
    if (requests === 1 && failure === "timeout") throw new Error("MiMo request timed out after 120 seconds.");
    if (requests === 1 && ["401", "429", "500"].includes(failure)) return Response.json({ error: { message: "test rejection" } }, { status: Number(failure) });
    return Response.json({ choices: [{ message: { audio: { data: silentWav(24_000, 1, 70).toString("base64") } } }] });
  };
  const { baseUrl } = await startTestServer(t, { fetchImpl });
  await waitFor(async () => (await (await fetch(`${baseUrl}/api/models`)).json()).status === "ready");
  const episode = await seedEpisode(baseUrl, "Retry", { transcript: "## Segment 1\nAlex: Retry this turn." });
  const response = await sendJson(`${baseUrl}/api/episodes/${episode.id}/render`, {});
  assert.equal(response.status, 202);
  const { job } = await response.json();
  const terminal = await waitFor(async () => {
    const current = (await (await fetch(`${baseUrl}/api/jobs`)).json()).jobs.find((item) => item.id === job.id);
    return ["completed", "failed"].includes(current.status) && current;
  }, 15_000);
  const fails = ["401", "timeout", "repeated network"].includes(failure);
  assert.equal(terminal.status, fails ? "failed" : "completed", terminal.error);
  assert.equal(requests, ["401", "timeout"].includes(failure) ? 1 : 2);
  if (failure === "401") assert.equal(terminal.error, "MiMo request failed: HTTP 401. The provider rejected MIMO_API_KEY. Check the key. test rejection");
});
