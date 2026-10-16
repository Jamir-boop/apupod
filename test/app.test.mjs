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
  sanitizeProposalEpisode,
  transcriptSpeakerRule,
  transcriptToMarkdown,
  validateOutline,
  validateProfileData,
  validateTranscriptJson,
  writeAudioAsWav,
} from "../app.mjs";
import { DEFAULT_DATA } from "../defaults.mjs";
import { applyWrites } from "../scripts/update-version.mjs";

const speakers = DEFAULT_DATA.speakerProfiles[0].speakers;
const execFileAsync = promisify(execFile);

test("version writes restore completed files when a later write fails", async () => {
  const files = new Map([["package.json", "old-package"], ["package-lock.json", "old-lock"]]);
  const writes = [
    { path: "package.json", content: "new-package", original: "old-package" },
    { path: "package-lock.json", content: "new-lock", original: "old-lock" },
  ];
  await assert.rejects(applyWrites(writes, async (path, content) => {
    if (path === "package-lock.json" && content === "new-lock") throw new Error("disk full");
    files.set(path, content);
  }), /disk full/);
  assert.equal(files.get("package.json"), "old-package");
  assert.equal(files.get("package-lock.json"), "old-lock");
});

async function waitFor(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Condition not met within ${timeoutMs} ms.`);
}

// The browser re-assigns state.profiles from every PUT /api/profiles response; tests reusing one
// local copy across several saves must adopt the new revisions the same way or the save conflicts.
async function syncProfiles(response, profiles) {
  Object.assign(profiles, (await response.json()).profiles);
}

async function startTestServer(t, prefix, options = {}, prepare) {
  const rootDir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await prepare?.(rootDir);
  const server = await createPodcastServer({ rootDir, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { rootDir, baseUrl: `http://127.0.0.1:${server.address().port}` };
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
  assert.equal(profiles.episodeProfiles[0].numSegments, 5);
  assert.equal(Object.hasOwn(profiles.episodeProfiles[0], "defaultBriefing"), false);
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
  spacedName.speakerProfiles[0].speakers[0].name = "  Valeria  ";
  validateProfileData(spacedName);
  assert.equal(spacedName.speakerProfiles[0].speakers[0].name, "Valeria");
});

test("assistant Episode Format proposal derives segments from target duration", () => {
  const current = { numSegments: 20, targetMinutes: 18, defaultBriefing: "Legacy" };
  assert.equal(sanitizeProposalEpisode({ numSegments: 99 }, current).numSegments, 5);
  assert.equal(sanitizeProposalEpisode({ targetMinutes: 60 }, current).numSegments, 17);
  assert.equal(sanitizeProposalEpisode({ targetMinutes: 5 }, current).numSegments, 3);
  assert.equal(Object.hasOwn(sanitizeProposalEpisode({}, current), "defaultBriefing"), false);
});

test("saving Episode Formats derives segment count from target duration", async (t) => {
  const { baseUrl } = await startTestServer(t, "podcast-derived-segments-");
  let profiles = (await (await fetch(`${baseUrl}/api/state`)).json()).profiles;
  for (const [targetMinutes, numSegments] of [[18, 5], [60, 17], [5, 3]]) {
    profiles.episodeProfiles[0].targetMinutes = targetMinutes;
    profiles.episodeProfiles[0].numSegments = 99;
    profiles.episodeProfiles[0].defaultBriefing = "Legacy";
    const response = await fetch(`${baseUrl}/api/profiles`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profiles) });
    const saved = await response.json();
    assert.equal(response.status, 200, saved.error);
    profiles = saved.profiles;
    assert.equal(profiles.episodeProfiles[0].numSegments, numSegments);
    assert.equal(Object.hasOwn(profiles.episodeProfiles[0], "defaultBriefing"), false);
  }
  profiles.episodeProfiles[0].outlineEffort = "max";
  profiles.episodeProfiles[0].transcriptEffort = "nope";
  const response = await fetch(`${baseUrl}/api/profiles`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profiles) });
  const saved = await response.json();
  assert.equal(response.status, 200, saved.error);
  assert.equal(saved.profiles.episodeProfiles[0].outlineEffort, "max");
  assert.equal(saved.profiles.episodeProfiles[0].transcriptEffort, "");
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
  assert.equal(validateTranscriptJson({ ...value, segments: value.segments.slice(0, 3) }, 5, ["Valeria", "Diego"]), true);
  assert.throws(() => validateTranscriptJson({ ...value, segments: [] }, 5, ["Valeria", "Diego"]), /at least 1 segment/);
  assert.throws(() => validateTranscriptJson({ ...value, segments: [...value.segments, { ...value.segments[0], number: 6 }] }, 5, ["Valeria", "Diego"]), /at most 5 segments/);
  const markdown = transcriptToMarkdown(value);
  const parsed = parseTranscript(markdown, speakers, 5);
  assert.equal(parsed.segments.length, 5);
  assert.equal(parsed.warning, "");
  assert.deepEqual(parsed.segments[0].turns[0], { speaker: "Valeria", delivery: "cálida natural", text: "Idea 1" });
});

test("transcript warns for fewer segments and rejects invalid counts", () => {
  assert.throws(() => parseTranscript("## Segmento 1\nNarrator: hello", speakers, 1), /Invalid transcript line 2/);
  const fewer = parseTranscript("## Segmento 1\nValeria: hello", speakers, 5);
  assert.match(fewer.warning, /1 of 5 configured segments/);
  assert.throws(() => parseTranscript("", speakers, 5), /at least 1 segment/);
  const excessive = Array.from({ length: 6 }, (_, index) => `## Segmento ${index + 1}\nValeria: hello`).join("\n");
  assert.throws(() => parseTranscript(excessive, speakers, 5), /at most 5 segments/);
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

  const { baseUrl } = await startTestServer(t, "podcast-builder-eleven-", { fetchImpl });

  const initialState = await (await fetch(`${baseUrl}/api/state`)).json();
  initialState.config.providers.elevenlabs.activeModels = {
    eleven_v3: { text: false, tts: true },
    eleven_flash_v2_5: { text: false, tts: true },
  };
  let response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(initialState.config) });
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
  response = await fetch(`${baseUrl}/api/profiles`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profiles),
  });
  assert.equal(response.status, 200);
  await syncProfiles(response, profiles);

  response = await fetch(`${baseUrl}/api/transcript-prompt/resolve`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ episodeProfileId: "episode-chisme-crianza" }),
  });
  let prompt = await response.json();
  assert.match(prompt.lockedPrompt, /eleven_v3/);
  assert.match(prompt.lockedPrompt, /Do not use SSML break tags/);
  assert.equal(prompt.capabilities[0].cueMode, "tags");

  profiles.speakerProfiles[0].voiceModel = "eleven_flash_v2_5";
  response = await fetch(`${baseUrl}/api/profiles`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profiles) });
  assert.equal(response.status, 200);
  await syncProfiles(response, profiles);
  response = await fetch(`${baseUrl}/api/transcript-prompt/resolve`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ episodeProfileId: "episode-chisme-crianza" }),
  });
  prompt = await response.json();
  assert.match(prompt.lockedPrompt, /<break time="0\.5s" \/>/);
  assert.equal(prompt.capabilities[0].cueMode, "breaks");
  profiles.speakerProfiles[0].voiceModel = "eleven_v3";
  response = await fetch(`${baseUrl}/api/profiles`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profiles) });
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
    language_code: "es",
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

test("Eleven v4 discovers capabilities, preserves tags, splits turns, and reuses only effective settings", { concurrency: false }, async (t) => {
  const oldKey = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = "test-v4-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = oldKey;
  });
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
      if (failRequest === requests.length) return Response.json({ detail: "mock chunk failure" }, { status: 500 });
      return new Response(silentWav(44_100, 2), { headers: { "Content-Type": "audio/wav" } });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const { baseUrl, rootDir } = await startTestServer(t, "podcast-v4-", { fetchImpl });
  const initial = await (await fetch(`${baseUrl}/api/state`)).json();
  const oldProfile = structuredClone(initial.profiles.speakerProfiles[0]);
  const config = initial.config;
  config.providers.elevenlabs.activeModels = { eleven_v4: { tts: true }, eleven_v4_turbo: { tts: true }, eleven_v3: { tts: true } };
  let response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) });
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
    const saved = await fetch(`${baseUrl}/api/profiles`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profiles) });
    assert.equal(saved.status, 200, await saved.clone().text());
    await syncProfiles(saved, profiles);
  }
  await saveProfiles();
  response = await fetch(`${baseUrl}/api/transcript-prompt/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ episodeProfileId: profiles.episodeProfiles[0].id }) });
  const prompt = await response.json();
  assert.match(prompt.lockedPrompt, /eleven_v4/);
  assert.doesNotMatch(prompt.lockedPrompt, /eleven_v3/);
  assert.equal(prompt.capabilities[0].cueMode, "tags");
  const previewBody = { episodeProfileId: profiles.episodeProfiles[0].id, speakerProfileId: profile.id, speakerIndex: 0, text: "[laughs] Hola.", cue: "warm and calm" };
  response = await fetch(`${baseUrl}/api/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(previewBody) });
  assert.equal(response.status, 200, await response.clone().text());
  const preview = Buffer.from(await response.arrayBuffer());
  assert.equal(preview.readUInt16LE(22), 1);
  assert.equal(preview.readUInt32LE(24), 24_000);
  assert.equal(preview.readUInt16LE(34), 16);
  assert.deepEqual(requests.at(-1), { text: "[warm and calm] [laughs] Hola.", model_id: "eleven_v4", language_code: "es", voice_settings: { stability: 0.6, similarity_boost: 0.8 }, apply_text_normalization: "off", seed: 9 });
  const beforeSsml = requests.length;
  for (const text of ['Hola <break time="0.5s" />.', '<prosody rate="slow">Hola.</prosody>']) {
    response = await fetch(`${baseUrl}/api/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...previewBody, text }) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /does not support SSML/);
  }
  assert.equal(requests.length, beforeSsml);

  response = await fetch(`${baseUrl}/api/episodes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "V4 chunks", episodeProfileId: profiles.episodeProfiles[0].id }) });
  const episode = await response.json();
  const spoken = `[whispers] ${"Una frase clara. ".repeat(680).trim()} [laughs] Fin.`;
  const transcript = `## Segmento 1\n${profile.speakers[0].name} [calm]: ${spoken}`;
  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/transcript`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript }) });
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
  response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) });
  assert.equal(response.status, 200);
  const smallerStart = requests.length;
  response = await fetch(`${baseUrl}/api/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...previewBody, text: "[whispers] Uno dos tres cuatro. Cinco seis siete ocho. Nueve diez once doce.", cue: "calm" }) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.ok(requests.slice(smallerStart).length > 1);
  assert.ok(requests.slice(smallerStart).every((body) => body.text.length <= maximum));
  const cjkStart = requests.length;
  const cjkText = "你好。".repeat(30);
  response = await fetch(`${baseUrl}/api/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...previewBody, text: cjkText, cue: "calm" }) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.ok(requests.slice(cjkStart).every((body) => body.text.length <= maximum));
  assert.equal(requests.slice(cjkStart).map((body) => body.text.slice("[calm] ".length)).join(""), cjkText);
  const unsafeStart = requests.length;
  response = await fetch(`${baseUrl}/api/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...previewBody, text: "a".repeat(80), cue: "calm" }) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /cannot split.*60-character.*without cutting a word or audio tag/);
  assert.equal(requests.length, unsafeStart);
  response = await fetch(`${baseUrl}/api/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...previewBody, text: `[${"a".repeat(80)}] Hola.`, cue: "calm" }) });
  assert.equal(response.status, 400);
  assert.equal(requests.length, unsafeStart);
  advertiseV4 = false;
  response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) });
  assert.equal(response.status, 200);
  response = await fetch(`${baseUrl}/api/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(previewBody) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /eleven_v4.*not active/);
  assert.equal(requests.length, unsafeStart, "unavailable v4 must not use another active model");
});

test("local API seeds data and saves knowledge plus episode", async (t) => {
  const inlineStyle = "body { color: red; }";
  const inlineScript = "globalThis.testLoaded = true;";
  const { baseUrl } = await startTestServer(t, "podcast-builder-", {}, async (rootDir) => {
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

  const transcript = Array.from({ length: 3 }, (_, index) =>
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
  assert.match(saved.warning, /3 of 5 configured segments/);
  assert.equal(saved.speakerProfile.speakers[0].name, "Valeria");

  response = await fetch(`${baseUrl}/api/episodes/${episode.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Renamed podcast" }) });
  const renamed = await response.json();
  assert.equal(response.status, 200);
  assert.equal(renamed.name, "Renamed podcast");
  assert.equal(renamed.status, "transcript_ready");
  assert.equal(renamed.transcript, saved.transcript);
  assert.equal(Object.hasOwn(renamed, "warning"), false);

  state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.episodes.length, 1);
});

test("knowledge deletion clears plans, episodes, and chats", async (t) => {
  const { rootDir, baseUrl } = await startTestServer(t, "podcast-delete-knowledge-");
  let response = await fetch(`${baseUrl}/api/knowledge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "delete.md", content: "# Delete me" }) });
  const knowledge = await response.json();
  response = await fetch(`${baseUrl}/api/plans`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Plan", knowledgeBaseId: knowledge.id }) });
  const plan = (await response.json()).plan;
  response = await fetch(`${baseUrl}/api/episodes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Episode", episodeProfileId: "episode-chisme-crianza", knowledgeBaseId: knowledge.id }) });
  const episode = await response.json();
  const chatPath = join(rootDir, "data", "chat", "kb-delete-chat.json");
  await writeFile(chatPath, JSON.stringify({ threadId: "kb-delete-chat", kind: "profile", title: "KB", kbId: knowledge.id, messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));

  const episodePath = join(rootDir, "data", "episodes", episode.id, "episode.json");
  const activeEpisode = JSON.parse(await readFile(episodePath, "utf8"));
  activeEpisode.job = { id: "active", type: "transcript", status: "running" };
  await writeFile(episodePath, JSON.stringify(activeEpisode, null, 2));
  response = await fetch(`${baseUrl}/api/knowledge/${knowledge.id}`, { method: "DELETE" });
  assert.equal(response.status, 409);
  activeEpisode.job = null;
  await writeFile(episodePath, JSON.stringify(activeEpisode, null, 2));

  response = await fetch(`${baseUrl}/api/knowledge/${knowledge.id}`, { method: "DELETE" });
  const deleted = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(deleted.cleared, { plans: 1, episodes: 1, chats: 1 });
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.knowledgeBases.some((item) => item.id === knowledge.id), false);
  assert.equal(state.plans.find((item) => item.id === plan.id).knowledgeBaseId, "");
  assert.equal(state.episodes.find((item) => item.id === episode.id).knowledgeBaseId, "");
  assert.equal(JSON.parse(await readFile(chatPath, "utf8")).kbId, "");
  await assert.rejects(readFile(join(rootDir, "data", "knowledge", `${knowledge.id}.md`)), { code: "ENOENT" });
});

test("transcript word counts use locale-aware segmentation", async (t) => {
  const { baseUrl } = await startTestServer(t, "podcast-word-count-");
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
  const { rootDir, baseUrl } = await startTestServer(t, "podcast-profile-refresh-");

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
  await syncProfiles(response, state.profiles);
  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/profiles`, { method: "PUT" });
  const ttsChanged = await response.json();
  assert.equal(ttsChanged.episode.audioReady, false);
  assert.equal(ttsChanged.episode.status, "transcript_ready");
  assert.equal((await readFile(join(rootDir, "data", "episodes", episode.id, "episode.mp3"), "utf8")), "existing-audio");

  state.profiles.episodeProfiles[0].targetMinutes = 21;
  response = await fetch(`${baseUrl}/api/profiles`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.profiles),
  });
  assert.equal(response.status, 200);
  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/profiles`, { method: "PUT" });
  assert.equal(response.status, 200);
  const expanded = await response.json();
  assert.equal(expanded.episode.episodeProfile.numSegments, 6);
  assert.match(expanded.warning, /5 of 6 configured segments/);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(episodeFile, "utf8")), "warning"), false);

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
  const { baseUrl } = await startTestServer(t, "podcast-models-", { fetchImpl });

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

test("provider responses are rejected before exceeding memory limits", { concurrency: false }, async (t) => {
  const oldMimo = process.env.MIMO_API_KEY;
  const oldEleven = process.env.ELEVENLABS_API_KEY;
  process.env.MIMO_API_KEY = "test-mimo-key";
  delete process.env.ELEVENLABS_API_KEY;
  t.after(() => {
    if (oldMimo === undefined) delete process.env.MIMO_API_KEY; else process.env.MIMO_API_KEY = oldMimo;
    if (oldEleven === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = oldEleven;
  });
  let oversizedError = false;
  const fetchImpl = async () => oversizedError
    ? new Response("x".repeat(70 * 1024), { status: 502 })
    : new Response("{}", { headers: { "Content-Length": String(9 * 1024 * 1024) } });
  const { baseUrl } = await startTestServer(t, "podcast-response-limit-", { fetchImpl });
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

test("MiMo TTS accepts base64 audio responses larger than the ordinary JSON limit", { concurrency: false }, async (t) => {
  const oldMimo = process.env.MIMO_API_KEY;
  const oldEleven = process.env.ELEVENLABS_API_KEY;
  process.env.MIMO_API_KEY = "test-mimo-key";
  delete process.env.ELEVENLABS_API_KEY;
  t.after(() => {
    if (oldMimo === undefined) delete process.env.MIMO_API_KEY; else process.env.MIMO_API_KEY = oldMimo;
    if (oldEleven === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = oldEleven;
  });
  const wav = silentWav(24_000, 1, 140);
  const fetchImpl = async (url) => String(url).endsWith("/models")
    ? Response.json({ data: [{ id: "mimo-v2.5-tts" }] })
    : Response.json({ choices: [{ message: { audio: { data: wav.toString("base64") } } }] });
  const { baseUrl } = await startTestServer(t, "podcast-mimo-large-response-", { fetchImpl });
  await waitFor(async () => (await (await fetch(`${baseUrl}/api/models`)).json()).status === "ready");
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  state.profiles.episodeProfiles[0].language = "en-US";
  await fetch(`${baseUrl}/api/profiles`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.profiles) });
  let response = await fetch(`${baseUrl}/api/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      speakerProfileId: state.profiles.speakerProfiles[0].id,
      episodeProfileId: state.profiles.episodeProfiles[0].id,
      speakerIndex: 0,
      languageOverride: "es-419",
      text: "Large response test.",
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /TTS language is defined by the Episode Format/);
  response = await fetch(`${baseUrl}/api/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      speakerProfileId: state.profiles.speakerProfiles[0].id,
      episodeProfileId: state.profiles.episodeProfiles[0].id,
      speakerIndex: 0,
      text: "Large response test.",
    }),
  });
  assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
  const preview = Buffer.from(await response.arrayBuffer());
  assert.equal(Number(response.headers.get("content-length")), preview.length);
  assert.ok(preview.length > 6 * 1024 * 1024);
  assert.equal(preview.readUInt16LE(20), 1);
  assert.equal(preview.readUInt16LE(34), 16);
});

test("concurrent config saves receive matching nonblocking catalog snapshots", { concurrency: false }, async (t) => {
  const previousKeys = Object.fromEntries(["MIMO_API_KEY", "ELEVENLABS_API_KEY", "OPENAI_API_KEY", "CHATTERBOX_API_KEY"].map((key) => [key, process.env[key]]));
  delete process.env.MIMO_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.CHATTERBOX_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  t.after(() => {
    for (const [key, value] of Object.entries(previousKeys)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
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
  const { baseUrl } = await startTestServer(t, "podcast-config-revisions-", { fetchImpl });
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
  configB.providers.openai.baseUrl = "http://provider-b.test/v1";
  const save = (body) => fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((response) => response.json());
  const pendingA = save(configA);
  const pendingB = save(configB);
  await new Promise((resolve) => setTimeout(resolve, 30));
  hold.end('x"}');
  await holdDone;
  await waitFor(async () => (await (await fetch(`${baseUrl}/api/config`)).json()).providers.openai.baseUrl === configB.providers.openai.baseUrl);
  const unrelated = fetch(`${baseUrl}/api/knowledge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "concurrent.md", content: "# Concurrent" }) });
  assert.equal(await Promise.race([unrelated.then((response) => response.status), new Promise((resolve) => setTimeout(() => resolve("timeout"), 1_000))]), 201);
  releaseModels();
  const [resultA, resultB] = await Promise.all([pendingA, pendingB]);
  assert.equal(resultA.config.providers.openai.baseUrl, configA.providers.openai.baseUrl);
  assert.equal(resultA.modelCatalog.providers.openai.discoveredModels[0].rawId, "model-a");
  assert.equal(resultB.config.providers.openai.baseUrl, configB.providers.openai.baseUrl);
  assert.equal(resultB.modelCatalog.providers.openai.discoveredModels[0].rawId, "model-b");
  assert.equal((await (await fetch(`${baseUrl}/api/models`)).json()).providers.openai.discoveredModels[0].rawId, "model-b");
});

test("repeated manual model refreshes coalesce while config saves still force a refresh", { concurrency: false }, async (t) => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "refresh-test-key";
  t.after(() => { if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey; });
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
  const { baseUrl } = await startTestServer(t, "podcast-refresh-coalesce-", { fetchImpl });
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
  const save = fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) });
  releaseModels();
  const saved = await save;
  assert.equal(saved.status, 200, await saved.text());
  assert.ok(modelCalls >= initialCalls + 2);
});

test("failed transcript replacement restores episode metadata", async (t) => {
  const { rootDir, baseUrl } = await startTestServer(t, "podcast-transcript-rollback-");
  let response = await fetch(`${baseUrl}/api/episodes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Rollback", episodeProfileId: "episode-chisme-crianza" }) });
  const episode = await response.json();
  const directory = join(rootDir, "data", "episodes", episode.id);
  const metadataPath = join(directory, "episode.json");
  const before = await readFile(metadataPath, "utf8");
  await mkdir(join(directory, "transcript.md"));
  const transcript = Array.from({ length: 5 }, (_, index) => `## Segmento ${index + 1}\nValeria: Idea ${index + 1}.`).join("\n\n");
  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/transcript`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript }) });
  assert.equal(response.status, 500);
  assert.equal(await readFile(metadataPath, "utf8"), before);
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
  const { baseUrl } = await startTestServer(t, "podcast-jobs-", { fetchImpl });

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

test("short generated transcripts save with warning and can be retried", { concurrency: false }, async (t) => {
  const oldKey = process.env.MIMO_API_KEY;
  process.env.MIMO_API_KEY = "test-mimo-key";
  t.after(() => { if (oldKey === undefined) delete process.env.MIMO_API_KEY; else process.env.MIMO_API_KEY = oldKey; });

  let chatCalls = 0;
  const outline = { segments: Array.from({ length: 5 }, (_, index) => ({ number: index + 1, title: `Part ${index + 1}`, points: ["Point"] })) };
  const transcript = (long, segments = 5) => ({
    title: "Episode",
    segments: Array.from({ length: segments }, (_, index) => ({
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
      return Response.json({ choices: [{ message: { content: JSON.stringify(chatCalls % 2 ? outline : transcript(chatCalls >= 4, chatCalls >= 4 ? 5 : 3)) } }] });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const { baseUrl } = await startTestServer(t, "podcast-transcript-retry-", { fetchImpl });
  let response = await fetch(`${baseUrl}/api/knowledge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "book.md", content: "# Source" }) });
  const knowledge = await response.json();
  response = await fetch(`${baseUrl}/api/episodes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Retry", episodeProfileId: "episode-chisme-crianza", knowledgeBaseId: knowledge.id }) });
  const episode = await response.json();

  await fetch(`${baseUrl}/api/episodes/${episode.id}/generate`, { method: "POST" });
  let result = await waitFor(async () => {
    const value = await (await fetch(`${baseUrl}/api/jobs`)).json();
    return value.jobs.find((job) => job.episodeId === episode.id)?.status === "completed" ? value : null;
  });
  const shortJob = result.jobs.find((job) => job.episodeId === episode.id);
  assert.equal(shortJob.status, "completed");
  assert.match(shortJob.message, /3 of 5 configured segments/);
  assert.match(shortJob.message, /Transcript is too short: 12 words/);
  const savedShort = await (await fetch(`${baseUrl}/api/episodes/${episode.id}`)).json();
  assert.equal(savedShort.status, "transcript_ready");
  assert.ok(savedShort.transcriptWords > 0);

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
  const oldMimoBase = process.env.MIMO_BASE_URL;
  const oldEleven = process.env.ELEVENLABS_API_KEY;
  process.env.MIMO_API_KEY = "test-mimo-key";
  delete process.env.ELEVENLABS_API_KEY;
  t.after(() => {
    if (oldMimo === undefined) delete process.env.MIMO_API_KEY; else process.env.MIMO_API_KEY = oldMimo;
    if (oldMimoBase === undefined) delete process.env.MIMO_BASE_URL; else process.env.MIMO_BASE_URL = oldMimoBase;
    if (oldEleven === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = oldEleven;
  });
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
  const { rootDir, baseUrl } = await startTestServer(t, "podcast-tts-job-", { fetchImpl });

  let response = await fetch(`${baseUrl}/api/knowledge`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "book.md", content: "# Grounded" }),
  });
  const knowledge = await response.json();
  const profiles = (await (await fetch(`${baseUrl}/api/state`)).json()).profiles;
  profiles.episodeProfiles[0].targetMinutes = 5;
  response = await fetch(`${baseUrl}/api/profiles`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profiles),
  });
  assert.equal(response.status, 200);
  await syncProfiles(response, profiles);
  response = await fetch(`${baseUrl}/api/episodes`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "TTS", episodeProfileId: "episode-chisme-crianza", knowledgeBaseId: knowledge.id }),
  });
  const episode = await response.json();
  const transcript = Array.from({ length: 3 }, (_, index) => `## Segmento ${index + 1}\nValeria [${index === 0 ? "quick" : "warm"}]: Idea ${index + 1}.${index === 0 ? "[pause]\nDiego [warm]: Quick reaction." : ""}`).join("\n\n");
  await fetch(`${baseUrl}/api/episodes/${episode.id}/transcript`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript }),
  });

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
  response = await fetch(`${baseUrl}/api/profiles`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profiles),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/render`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ languageOverride: "es-419" }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /TTS language is defined by the Episode Format/);

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
  response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) });
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

test("transcript prompt adds cues, supports no KB, and renames placeholder", { concurrency: false }, async (t) => {
  const oldMimo = process.env.MIMO_API_KEY;
  process.env.MIMO_API_KEY = "test-mimo-key";
  t.after(() => { if (oldMimo === undefined) delete process.env.MIMO_API_KEY; else process.env.MIMO_API_KEY = oldMimo; });
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "mimo-v2.5-pro" }, { id: "mimo-v2.5-tts" }] });
    if (String(url).endsWith("/chat/completions")) {
      const request = JSON.parse(options.body);
      requests.push(request);
      if (request.audio) return Response.json({ choices: [{ message: { audio: { data: silentWav().toString("base64") } } }] });
      const system = request.messages[0].content;
      if (system.includes("create grounded podcast outlines")) {
        return Response.json({ choices: [{ message: { content: JSON.stringify({ segments: Array.from({ length: 3 }, (_, index) => ({ number: index + 1, title: `Segment ${index + 1}`, purpose: "Discuss", points: ["Point"], closingBeat: "Close" })) }) } }] });
      }
      const words = Array.from({ length: 130 }, (_, index) => `word${index}`).join(" ");
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        title: "Generated Title",
        segments: Array.from({ length: 3 }, (_, index) => ({
          number: index + 1,
          title: `Segment ${index + 1}`,
          turns: [{ speaker: "Valeria", delivery: "warm", text: `${words}${index === 0 ? " [pause]" : ""}` }],
        })),
      }) } }] });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const { baseUrl } = await startTestServer(t, "podcast-transcript-prompt-", { fetchImpl });

  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  state.profiles.episodeProfiles[0].language = "en-US";
  state.profiles.episodeProfiles[0].targetMinutes = 5;
  let response = await fetch(`${baseUrl}/api/profiles`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.profiles),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/episodes`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "New episode",
      episodeProfileId: "episode-chisme-crianza",
      knowledgeBaseId: "",
      transcriptPromptGuidance: "Keep reactions restrained.",
    }),
  });
  assert.equal(response.status, 201);
  const episode = await response.json();
  assert.equal(episode.knowledgeBaseId, "");

  response = await fetch(`${baseUrl}/api/transcript-prompt/resolve`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ episodeProfileId: episode.episodeProfileId, guidance: episode.transcriptPromptGuidance }),
  });
  const prompt = await response.json();
  assert.equal(response.status, 200);
  assert.match(prompt.lockedPrompt, /MiMo/);
  assert.match(prompt.effectivePrompt, /Keep reactions restrained/);
  assert.equal(prompt.capabilities[0].cueMode, "tags");

  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/generate`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ autoTts: true }),
  });
  assert.equal(response.status, 202);
  const finishedJobs = await waitFor(async () => {
    const jobs = await (await fetch(`${baseUrl}/api/jobs`)).json();
    const job = jobs.jobs.find((item) => item.episodeId === episode.id);
    return job?.type === "tts" && job.status === "completed" ? jobs : null;
  }, 30_000);
  assert.deepEqual(finishedJobs.jobs.filter((job) => job.episodeId === episode.id).map((job) => job.type).sort(), ["transcript", "tts"]);
  const generated = await (await fetch(`${baseUrl}/api/episodes/${episode.id}`)).json();
  assert.equal(generated.name, "Generated Title");
  assert.match(generated.transcript, /\[pause\]/);
  assert.equal(generated.audioReady, true);
  const transcriptRequest = requests.find((request) => request.messages[0].content.includes("write grounded"));
  assert.match(transcriptRequest.messages[1].content, /TTS-AWARE DIALOGUE RULES/);
  assert.match(transcriptRequest.messages[1].content, /Keep reactions restrained/);
  assert.match(transcriptRequest.messages[1].content, /No knowledge base was supplied/);

  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/transcript`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript: generated.transcript.replace("[pause]", '<break time="1s" />') }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /does not support SSML break tags/);

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

test("job history keeps the newest 30 persisted jobs", async (t) => {
  const { baseUrl } = await startTestServer(t, "podcast-job-history-", {}, async (rootDir) => {
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
function transcriptJobFetch({ outlineContent, transcriptGate }) {
  const outline = { segments: Array.from({ length: 5 }, (_, index) => ({ number: index + 1, title: `Part ${index + 1}`, points: ["Point"] })) };
  const transcript = {
    title: "Model chosen title",
    segments: Array.from({ length: 5 }, (_, index) => ({
      number: index + 1,
      title: `Part ${index + 1}`,
      turns: [
        { speaker: "Valeria", delivery: "warm", text: longText(`Idea ${index + 1}`) },
        { speaker: "Diego", delivery: "dry", text: longText(`Reaction ${index + 1}`) },
      ],
    })),
  };
  return async (url, init) => {
    if (!String(url).endsWith("/chat/completions")) return Response.json({ data: [{ id: "mimo-v2.5-pro" }, { id: "mimo-v2.5-tts" }] });
    // Only the transcript prompt carries the approved outline, so a retry cannot desync the stub.
    if (!String(init?.body).includes("Approved outline:")) return Response.json({ choices: [{ message: { content: outlineContent ?? JSON.stringify(outline) } }] });
    if (transcriptGate) await transcriptGate();
    return Response.json({ choices: [{ message: { content: JSON.stringify(transcript) } }] });
  };
}

async function seedRenderedEpisode(baseUrl, rootDir, name) {
  let response = await fetch(`${baseUrl}/api/knowledge`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "book.md", content: "# Grounded" }),
  });
  const knowledge = await response.json();
  response = await fetch(`${baseUrl}/api/episodes`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, episodeProfileId: "episode-chisme-crianza", knowledgeBaseId: knowledge.id }),
  });
  const episode = await response.json();
  const transcript = Array.from({ length: 5 }, (_, index) =>
    `## Segmento ${index + 1} — Test\nValeria: Idea ${index + 1}.\nDiego: Reaction ${index + 1}.`
  ).join("\n\n");
  await fetch(`${baseUrl}/api/episodes/${episode.id}/transcript`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript }),
  });
  const episodeFile = join(rootDir, "data", "episodes", episode.id, "episode.json");
  const stored = JSON.parse(await readFile(episodeFile, "utf8"));
  await writeFile(episodeFile, JSON.stringify({ ...stored, audioReady: true, status: "ready" }, null, 2));
  await writeFile(join(rootDir, "data", "episodes", episode.id, "episode.mp3"), "existing-audio");
  return episode;
}

function withMimoKey(t) {
  const previous = process.env.MIMO_API_KEY;
  process.env.MIMO_API_KEY = "test-mimo-key";
  t.after(() => { if (previous === undefined) delete process.env.MIMO_API_KEY; else process.env.MIMO_API_KEY = previous; });
}

test("a failed transcript job keeps the existing render playable", { concurrency: false }, async (t) => {
  withMimoKey(t);
  const fetchImpl = transcriptJobFetch({ outlineContent: "not json at all" });
  const { rootDir, baseUrl } = await startTestServer(t, "podcast-transcript-failure-audio-", { fetchImpl });
  const episode = await seedRenderedEpisode(baseUrl, rootDir, "Rendered episode");

  assert.equal((await fetch(`${baseUrl}/api/episodes/${episode.id}/generate`, { method: "POST" })).status, 202);
  await waitFor(async () => {
    const jobs = await (await fetch(`${baseUrl}/api/jobs`)).json();
    return jobs.jobs.find((job) => job.episodeId === episode.id)?.status === "failed";
  });

  const saved = await (await fetch(`${baseUrl}/api/episodes/${episode.id}`)).json();
  assert.equal(saved.status, "failed");
  assert.ok(saved.lastError);
  assert.equal(saved.audioReady, true);
  assert.match(saved.audioUrl, /episode\.mp3$/);
  assert.equal(await readFile(join(rootDir, "data", "episodes", episode.id, "episode.mp3"), "utf8"), "existing-audio");
});

test("the existing render stays playable until a new transcript replaces it", { concurrency: false }, async (t) => {
  withMimoKey(t);
  let releaseTranscript;
  let transcriptStarted = false;
  const transcriptGate = new Promise((resolve) => { releaseTranscript = resolve; });
  t.after(() => releaseTranscript());
  const fetchImpl = transcriptJobFetch({ transcriptGate: async () => { transcriptStarted = true; await transcriptGate; } });
  const { rootDir, baseUrl } = await startTestServer(t, "podcast-transcript-audio-lifetime-", { fetchImpl });
  const episode = await seedRenderedEpisode(baseUrl, rootDir, "Rendered episode");

  assert.equal((await fetch(`${baseUrl}/api/episodes/${episode.id}/generate`, { method: "POST" })).status, 202);
  await waitFor(() => transcriptStarted);
  const during = await (await fetch(`${baseUrl}/api/episodes/${episode.id}`)).json();
  assert.equal(during.audioReady, true);
  assert.match(during.audioUrl, /episode\.mp3$/);

  releaseTranscript();
  await waitFor(async () => {
    const jobs = await (await fetch(`${baseUrl}/api/jobs`)).json();
    return jobs.jobs.find((job) => job.episodeId === episode.id)?.status === "completed";
  });
  const after = await (await fetch(`${baseUrl}/api/episodes/${episode.id}`)).json();
  assert.equal(after.audioReady, false);
  assert.equal(after.audioUrl, null);
});

test("a rename during transcript generation outranks the model title", { concurrency: false }, async (t) => {
  withMimoKey(t);
  let releaseTranscript;
  let transcriptStarted = false;
  const transcriptGate = new Promise((resolve) => { releaseTranscript = resolve; });
  t.after(() => releaseTranscript());
  let gateArmed = true;
  const fetchImpl = transcriptJobFetch({
    transcriptGate: async () => { if (!gateArmed) return; transcriptStarted = true; await transcriptGate; },
  });
  const { baseUrl } = await startTestServer(t, "podcast-rename-during-job-", { fetchImpl });
  let response = await fetch(`${baseUrl}/api/knowledge`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "book.md", content: "# Grounded" }),
  });
  const knowledge = await response.json();
  const createEpisode = async () => (await (await fetch(`${baseUrl}/api/episodes`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "New episode", episodeProfileId: "episode-chisme-crianza", knowledgeBaseId: knowledge.id }),
  })).json());

  const renamed = await createEpisode();
  assert.equal((await fetch(`${baseUrl}/api/episodes/${renamed.id}/generate`, { method: "POST" })).status, 202);
  await waitFor(() => transcriptStarted);
  response = await fetch(`${baseUrl}/api/episodes/${renamed.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "User chosen name" }),
  });
  assert.equal(response.status, 200);
  releaseTranscript();
  await waitFor(async () => {
    const jobs = await (await fetch(`${baseUrl}/api/jobs`)).json();
    return jobs.jobs.find((job) => job.episodeId === renamed.id)?.status === "completed";
  });
  assert.equal((await (await fetch(`${baseUrl}/api/episodes/${renamed.id}`)).json()).name, "User chosen name");

  // The placeholder name is still replaced by the model title when nobody renames the episode.
  gateArmed = false;
  const untouched = await createEpisode();
  assert.equal((await fetch(`${baseUrl}/api/episodes/${untouched.id}/generate`, { method: "POST" })).status, 202);
  await waitFor(async () => {
    const jobs = await (await fetch(`${baseUrl}/api/jobs`)).json();
    return jobs.jobs.find((job) => job.episodeId === untouched.id)?.status === "completed";
  });
  assert.equal((await (await fetch(`${baseUrl}/api/episodes/${untouched.id}`)).json()).name, "Model chosen title");
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
  const { baseUrl } = await startTestServer(t, "podcast-profile-lost-update-");
  const put = (profiles) => fetch(`${baseUrl}/api/profiles`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profiles),
  });
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
  assert.equal(stored.episodeProfiles[0].targetMinutes, 18);

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
  response = await fetch(`${baseUrl}/api/episodes`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Pinned episode", episodeProfileId: "episode-extra" }),
  });
  assert.equal(response.status, 201);

  response = await put(staleTab);
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /Reload the page/);
});

test("a failed config save restores the previous .env with owner-only permissions", { concurrency: false }, async (t) => {
  withMimoKey(t);
  const { rootDir, baseUrl } = await startTestServer(t, "podcast-env-rollback-", {
    fetchImpl: async () => Response.json({ data: [{ id: "mimo-v2.5-pro" }, { id: "mimo-v2.5-tts" }] }),
  });
  const providers = { mimo: { baseUrl: "https://api.xiaomimimo.com/v1" }, elevenlabs: {} };
  const saveConfig = (apiKey) => fetch(`${baseUrl}/api/config`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providers: { ...providers, mimo: { ...providers.mimo, apiKey } }, compatibleConnections: [] }),
  });

  assert.equal((await saveConfig("first-key")).status, 200);
  // A directory in place of config.json fails the write that follows the .env update.
  await rm(join(rootDir, "data", "config.json"));
  await mkdir(join(rootDir, "data", "config.json"));
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
  for (const file of ["config.json", "profiles.json"]) {
    const { rootDir, baseUrl } = await startTestServer(t, `podcast-corrupt-${file}-`, {}, async (root) => {
      await mkdir(join(root, "data"), { recursive: true });
      await writeFile(join(root, "data", file), '{"truncated":');
    });
    const state = await (await fetch(`${baseUrl}/api/state`)).json();
    assert.ok(state.profiles.speakerProfiles.length >= 1);
    assert.ok(state.config.providers.mimo);
    const quarantined = (await readdir(join(rootDir, "data"))).filter((name) => name.startsWith(`${file}.corrupt-`));
    assert.equal(quarantined.length, 1, `expected one quarantined copy of ${file}`);
    assert.equal(await readFile(join(rootDir, "data", quarantined[0]), "utf8"), '{"truncated":');
  }

  const { baseUrl } = await startTestServer(t, "podcast-corrupt-index-", {}, async (root) => {
    await mkdir(join(root, "data", "knowledge"), { recursive: true });
    await writeFile(join(root, "data", "knowledge", "index.json"), "{");
  });
  const response = await fetch(`${baseUrl}/api/state`);
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /knowledge[/\\]index\.json is not valid JSON/);
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
  for (const name of ["tts-script.md", "tts-script.draft.md"]) await writeFile(join(healthyDir, name), "obsolete TTS script");
  const episodePath = join(healthyDir, "episode.json");
  const storedEpisode = JSON.parse(await readFile(episodePath, "utf8"));
  storedEpisode.ttsPreparation = { prompt: "obsolete" };
  storedEpisode.job = { id: "obsolete-preparation", type: "tts_prepare", status: "completed" };
  await writeFile(episodePath, JSON.stringify(storedEpisode, null, 2));
  const legacyChatPath = join(rootDir, "data", "chat", "legacy-tts.json");
  await writeFile(legacyChatPath, JSON.stringify({ threadId: "legacy-tts", kind: "tts", messages: [] }));
  await writeFile(join(clipsDir, `${"e".repeat(64)}.wav`), silentWav());
  const cachedSilence = join(clipsDir, "silence-1200ms.wav");
  await writeFile(cachedSilence, silentWav());
  const corruptDir = join(rootDir, "data", "episodes", "corrupt-episode");
  await mkdir(corruptDir, { recursive: true });
  await writeFile(join(corruptDir, "episode.json"), "{bad json");
  await writeFile(join(corruptDir, "outline.json"), "preserve");
  const deletingDir = join(rootDir, "data", "episodes", "pending-delete.deleting");
  await mkdir(deletingDir, { recursive: true });
  await writeFile(join(deletingDir, "partial-audio.wav"), "partial");

  server = await createPodcastServer({ rootDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  const corrupt = state.episodes.find((item) => item.id === "corrupt-episode");
  const cleanedEpisode = await (await fetch(`${baseUrl}/api/episodes/${episode.id}`)).json();
  assert.equal(corrupt.status, "corrupt");
  assert.equal(corrupt.corrupt, true);
  assert.equal(cleanedEpisode.ttsPreparation, undefined);
  assert.equal(cleanedEpisode.job, undefined);
  for (const name of ["outline.json", "transcript.json", "concat.txt"]) await assert.rejects(readFile(join(healthyDir, name)), { code: "ENOENT" });
  for (const name of ["tts-script.md", "tts-script.draft.md"]) await assert.rejects(readFile(join(healthyDir, name)), { code: "ENOENT" });
  await assert.rejects(readFile(legacyChatPath), { code: "ENOENT" });
  await assert.rejects(readFile(join(clipsDir, `${"e".repeat(64)}.wav`)), { code: "ENOENT" });
  assert.ok((await readFile(cachedSilence)).length > 0);
  assert.equal(await readFile(join(corruptDir, "outline.json"), "utf8"), "preserve");
  await assert.rejects(readFile(join(deletingDir, "partial-audio.wav")), { code: "ENOENT" });

  state.config.providers.mimo.enabled = false;
  response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.config) });
  assert.equal(response.status, 200);
  assert.match((await response.json()).warnings.join(" "), /corrupt episodes/);
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
  let providerCalls = 0;
  const { baseUrl } = await startTestServer(t, "podcast-ffmpeg-check-", {
    fetchImpl: async () => { providerCalls += 1; return Response.json({ data: [] }); },
  });
  let response = await fetch(`${baseUrl}/api/knowledge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "book.md", content: "# Source" }) });
  const knowledge = await response.json();
  response = await fetch(`${baseUrl}/api/episodes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "No FFmpeg", episodeProfileId: "episode-chisme-crianza", knowledgeBaseId: knowledge.id }) });
  const episode = await response.json();
  const transcript = Array.from({ length: 5 }, (_, index) => `## Segmento ${index + 1}\nValeria: Idea ${index + 1}.`).join("\n\n");
  await fetch(`${baseUrl}/api/episodes/${episode.id}/transcript`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript }) });
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

test("gpt-5.5/5.6 on the built-in OpenAI connection use the Responses API", { concurrency: false }, async (t) => {
  const oldOpenAi = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    if (oldOpenAi === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAi;
  });

  const generated = { episodeFormat: { name: "Interview", description: "Focused" }, episodes: [{ number: 1, title: "Only" }] };
  const responsesCalls = [];
  const chatCalls = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "gpt-5.6" }, { id: "gpt-5.5-pro" }, { id: "gpt-4o-mini" }] });
    if (String(url).endsWith("/responses")) {
      responsesCalls.push({ url: String(url), options });
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(generated) }] }] });
    }
    if (String(url).endsWith("/chat/completions")) {
      chatCalls.push({ url: String(url), options });
      return Response.json({ choices: [{ message: { content: JSON.stringify(generated) } }] });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const { baseUrl } = await startTestServer(t, "podcast-responses-", { fetchImpl });

  let response = await fetch(`${baseUrl}/api/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      providers: {
        mimo: {},
        elevenlabs: {},
        openai: {
          baseUrl: "https://api.openai.com/v1",
          llmBaseUrl: "https://llm.example/v1",
          enabled: true,
          apiKey: "sk-openai-test",
          activeModels: { "gpt-5.6": { text: true, tts: false }, "gpt-5.5-pro": { text: true, tts: false }, "gpt-4o-mini": { text: true, tts: false } },
        },
      },
      compatibleConnections: [],
    }),
  });
  assert.equal(response.status, 200);

  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  response = await fetch(`${baseUrl}/api/plans`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Responses plan", speakerProfileId: state.profiles.speakerProfiles[0].id, planningModel: "compat:openai:gpt-5.6", planningEffort: "high", theme: "Reasoning", audience: "Devs", goal: "Test", episodeCount: 1 }) });
  let plan = (await response.json()).plan;
  assert.equal(response.status, 201);
  assert.equal(plan.planningEffort, "high");
  response = await fetch(`${baseUrl}/api/plans/${plan.id}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  const generatedBody = await response.json();
  assert.equal(response.status, 200, generatedBody.error);
  assert.equal(responsesCalls.length, 1);
  assert.equal(responsesCalls[0].url, "https://llm.example/v1/responses");
  assert.equal(responsesCalls[0].options.headers.Authorization, "Bearer sk-openai-test");
  const responsesRequest = JSON.parse(responsesCalls[0].options.body);
  assert.equal(responsesRequest.model, "gpt-5.6");
  assert.equal(typeof responsesRequest.max_output_tokens, "number");
  assert.equal(responsesRequest.reasoning.effort, "high");
  assert.equal(responsesRequest.text.format.type, "json_object");
  assert.equal(responsesRequest.temperature, undefined);
  assert.equal(responsesRequest.top_p, undefined);
  assert.equal(typeof responsesRequest.instructions, "string");
  assert.match(responsesRequest.input, /Reasoning/);
  assert.equal(chatCalls.filter((call) => call.url.includes("llm.example")).length, 0);

  response = await fetch(`${baseUrl}/api/plans/${plan.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...generatedBody.plan, planningModel: "compat:openai:gpt-5.5-pro", planningEffort: "low" }) });
  plan = (await response.json()).plan;
  response = await fetch(`${baseUrl}/api/plans/${plan.id}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ replaceExisting: true }) });
  plan = (await response.json()).plan;
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(responsesCalls.at(-1).options.body).reasoning, undefined);

  response = await fetch(`${baseUrl}/api/plans/${plan.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...plan, planningModel: "compat:openai:gpt-4o-mini", planningEffort: "bogus" }) });
  plan = (await response.json()).plan;
  assert.equal(response.status, 200);
  assert.equal(plan.planningEffort, "");
  response = await fetch(`${baseUrl}/api/plans/${plan.id}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ replaceExisting: true }) });
  assert.equal(response.status, 200);
  assert.equal(responsesCalls.length, 2);
  assert.equal(chatCalls.filter((call) => call.url === "https://llm.example/v1/chat/completions").length, 1);
});

test("OpenCode Go reuses login credentials and routes both model protocols", { concurrency: false }, async (t) => {
  const previous = Object.fromEntries(["MIMO_API_KEY", "ELEVENLABS_API_KEY", "OPENAI_API_KEY", "CHATTERBOX_API_KEY", "OPENCODE_GO_API_KEY", "XDG_DATA_HOME"].map((name) => [name, process.env[name]]));
  for (const name of ["MIMO_API_KEY", "ELEVENLABS_API_KEY", "OPENAI_API_KEY", "CHATTERBOX_API_KEY", "OPENCODE_GO_API_KEY"]) delete process.env[name];
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  const calls = [];
  const chatModels = ["grok-4.5", "glm-5.2", "glm-5.1", "glm-5", "kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5", "deepseek-v4-pro", "deepseek-v4-flash", "mimo-v2.5", "mimo-v2.5-pro", "mimo-v2-pro", "mimo-v2-omni", "hy3", "hy3-preview"];
  const messagesModels = ["minimax-m3", "minimax-m2.7", "minimax-m2.5", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.5-plus"];
  const returnedModels = [...chatModels, ...messagesModels, "future-unknown"];
  const generatedPlan = { episodeFormat: { name: "OpenCode format", description: "Protocol test" }, episodes: [{ number: 1, title: "Only" }] };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/models")) return Response.json({ data: returnedModels.map((id) => ({ id })) });
    if (String(url).endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: JSON.stringify(generatedPlan) } }] });
    if (String(url).endsWith("/messages")) return Response.json({ content: [{ type: "text", text: JSON.stringify(generatedPlan) }] });
    throw new Error(`Unexpected URL ${url}`);
  };
  let authPath;
  const { rootDir, baseUrl } = await startTestServer(t, "podcast-opencode-go-", { fetchImpl }, async (directory) => {
    const dataHome = join(directory, "xdg");
    authPath = join(dataHome, "opencode", "auth.json");
    await mkdir(join(dataHome, "opencode"), { recursive: true });
    await writeFile(authPath, JSON.stringify({ "opencode-go": { type: "api", key: "go-login-secret" } }), { mode: 0o600 });
    process.env.XDG_DATA_HOME = dataHome;
  });

  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.config.providers.opencodeGo.hasApiKey, true);
  assert.equal(state.config.providers.opencodeGo.credentialSource, "opencode-login");
  assert.deepEqual(state.config.providers.opencodeGo.activeModels, {});
  let catalog = await waitFor(async () => {
    const value = await (await fetch(`${baseUrl}/api/models`)).json();
    return value.providers.opencodeGo.status === "ready" ? value : null;
  });
  const discoveredById = new Map(catalog.providers.opencodeGo.discoveredModels.map((model) => [model.rawId, model]));
  for (const id of chatModels) assert.deepEqual({ protocol: discoveredById.get(id)?.protocol, supported: discoveredById.get(id)?.supported }, { protocol: "chat", supported: true });
  for (const id of messagesModels) assert.deepEqual({ protocol: discoveredById.get(id)?.protocol, supported: discoveredById.get(id)?.supported }, { protocol: "messages", supported: true });
  assert.deepEqual({ protocol: discoveredById.get("future-unknown")?.protocol, supported: discoveredById.get("future-unknown")?.supported }, { protocol: null, supported: false });
  assert.deepEqual(catalog.providers.opencodeGo.textModels, []);
  assert.equal(calls.find((call) => call.url.endsWith("/models")).options.headers.Authorization, "Bearer go-login-secret");

  state.config.providers.opencodeGo.activeModels = {
    "kimi-k3": { text: true, tts: true },
    "minimax-m3": { text: true, tts: false },
    "future-unknown": { text: true, tts: false },
  };
  let response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.config) });
  const configured = await response.json();
  assert.equal(response.status, 200, configured.error);
  assert.deepEqual(configured.config.providers.opencodeGo.activeModels["kimi-k3"], { text: true, tts: false });
  assert.equal(configured.config.providers.opencodeGo.activeModels["future-unknown"], undefined);
  assert.deepEqual(configured.modelCatalog.providers.opencodeGo.textModels.map((model) => model.id), ["compat:opencode-go:kimi-k3", "compat:opencode-go:minimax-m3"]);
  assert.doesNotMatch(JSON.stringify(configured), /go-login-secret/);
  assert.doesNotMatch(await readFile(join(rootDir, "data", "config.json"), "utf8"), /go-login-secret/);
  assert.doesNotMatch(await readFile(join(rootDir, ".env"), "utf8"), /go-login-secret/);

  const generationCalls = () => calls.filter((call) => call.url.endsWith("/chat/completions") || call.url.endsWith("/messages")).length;
  const callsBeforeUnsupported = generationCalls();
  response = await fetch(`${baseUrl}/api/plans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Unsupported Go plan", speakerProfileId: state.profiles.speakerProfiles[0].id, planningModel: "compat:opencode-go:future-unknown", theme: "Routing", audience: "Developers", goal: "Reject unknown", episodeCount: 1 }),
  });
  const unsupportedPlan = (await response.json()).plan;
  assert.equal(response.status, 201);
  response = await fetch(`${baseUrl}/api/plans/${unsupportedPlan.id}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Unsupported or inactive text model/i);
  assert.equal(generationCalls(), callsBeforeUnsupported);

  response = await fetch(`${baseUrl}/api/plans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "OpenCode Go plan", speakerProfileId: state.profiles.speakerProfiles[0].id, planningModel: "compat:opencode-go:kimi-k3", theme: "Routing", audience: "Developers", goal: "Verify Go", episodeCount: 1 }),
  });
  let plan = (await response.json()).plan;
  assert.equal(response.status, 201);
  response = await fetch(`${baseUrl}/api/plans/${plan.id}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  const generated = await response.json();
  plan = generated.plan;
  assert.equal(response.status, 200, generated.error);
  const chatCall = calls.find((call) => call.url.endsWith("/chat/completions"));
  assert.equal(chatCall.url, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.equal(chatCall.options.headers.Authorization, "Bearer go-login-secret");
  assert.equal(JSON.parse(chatCall.options.body).model, "kimi-k3");

  process.env.OPENCODE_GO_API_KEY = "go-env-secret";
  response = await fetch(`${baseUrl}/api/models/refresh`, { method: "POST" });
  assert.equal(response.status, 202);
  await waitFor(async () => {
    const value = await (await fetch(`${baseUrl}/api/models`)).json();
    return value.providers.opencodeGo.status === "ready" && calls.filter((call) => call.url.endsWith("/models")).at(-1)?.options.headers.Authorization === "Bearer go-env-secret" ? value : null;
  });
  assert.equal((await (await fetch(`${baseUrl}/api/config`)).json()).providers.opencodeGo.credentialSource, "environment");

  response = await fetch(`${baseUrl}/api/plans/${plan.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...plan, planningModel: "compat:opencode-go:minimax-m3" }) });
  plan = (await response.json()).plan;
  response = await fetch(`${baseUrl}/api/plans/${plan.id}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ replaceExisting: true }) });
  assert.equal(response.status, 200);
  const messagesCall = calls.find((call) => call.url.endsWith("/messages"));
  assert.equal(messagesCall.url, "https://opencode.ai/zen/go/v1/messages");
  assert.equal(messagesCall.options.headers["x-api-key"], "go-env-secret");
  assert.equal(messagesCall.options.headers["anthropic-version"], "2023-06-01");
  const messagesBody = JSON.parse(messagesCall.options.body);
  assert.equal(messagesBody.model, "minimax-m3");
  assert.equal(messagesBody.messages[0].role, "user");
  assert.equal(typeof messagesBody.max_tokens, "number");

  delete process.env.OPENCODE_GO_API_KEY;
  await writeFile(authPath, '{"opencode-go":{"type":"api","key":"malformed-secret"', { mode: 0o600 });
  response = await fetch(`${baseUrl}/api/models/refresh`, { method: "POST" });
  assert.equal(response.status, 202);
  catalog = await waitFor(async () => {
    const value = await (await fetch(`${baseUrl}/api/models`)).json();
    return value.providers.opencodeGo.status === "unconfigured" ? value : null;
  });
  assert.match(catalog.providers.opencodeGo.error, /auth file contains invalid JSON/);
  assert.doesNotMatch(JSON.stringify(catalog), /malformed-secret/);
  const redacted = await (await fetch(`${baseUrl}/api/config`)).json();
  assert.equal(redacted.providers.opencodeGo.hasApiKey, false);
  assert.equal(redacted.providers.opencodeGo.credentialSource, null);
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
      return new Response(silentWav(24_000, 1, 0.1), { status: 200, headers: { "Content-Type": "audio/wav" } });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const { rootDir, baseUrl } = await startTestServer(t, "podcast-compat-", { fetchImpl });

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
  assert.equal(response.headers.get("content-type"), "audio/wav");
  const preview = Buffer.from(await response.arrayBuffer());
  assert.equal(preview.readUInt16LE(20), 1);
  assert.equal(preview.readUInt16LE(22), 1);
  assert.equal(preview.readUInt32LE(24), 24_000);
  assert.equal(preview.readUInt16LE(34), 16);

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
  const { rootDir, baseUrl } = await startTestServer(t, "podcast-config-safety-", {
    fetchImpl: async (url) => {
      if (String(url).includes("xiaomimimo.com")) return Response.json({ data: [{ id: "mimo-v2.5-pro" }, { id: "mimo-v2.5-tts" }] });
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "custom-tts" }] });
      throw new Error(`Unexpected URL ${url}`);
    },
  });
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
  await syncProfiles(response, state.profiles);

  const connection = { id: "safe_connection", name: "Safe", baseUrl: "https://safe.example/v1", enabled: true, activeModels: { "custom-tts": { text: false, tts: true } } };
  response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providers, compatibleConnections: [{ ...connection, activeModels: {} }] }) });
  const deactivated = await response.json();
  assert.equal(response.status, 200);
  assert.match(deactivated.warnings.join(" "), /speaker profile/);
  assert.equal(deactivated.modelCatalog.providers.compatible[0].ttsModels.length, 0);
  response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providers, compatibleConnections: [connection] }) });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providers, compatibleConnections: [{ ...connection, apiKey: "replacement", clearApiKey: true }] }) });
  assert.equal(response.status, 400);
  response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providers, compatibleConnections: [{ ...connection, clearApiKey: true }] }) });
  assert.equal(response.status, 200);
  assert.doesNotMatch(await readFile(join(rootDir, ".env"), "utf8"), /compat-secret/);
  assert.equal((await stat(join(rootDir, ".env"))).mode & 0o777, 0o600);
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
  let chatterboxOnline = true;
  let invalidAudio = false;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (!chatterboxOnline) throw new Error("fetch failed");
    if (String(url).endsWith("/models")) return Response.json({ data: [
      { id: "chatterbox-turbo", capabilities: { text: false, tts: true } },
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
  const { rootDir, baseUrl } = await startTestServer(t, "podcast-chatterbox-", { fetchImpl });
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  state.config.providers.chatterbox = { baseUrl: "http://127.0.0.1:8100/v1", modelsUrl: "", enabled: true, activeModels: { "chatterbox-turbo": { text: false, tts: true } } };
  let response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.config) });
  const configured = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(configured.modelCatalog.providers.chatterbox.ttsModels.map((model) => model.id), ["compat:chatterbox:chatterbox-turbo"]);
  assert.deepEqual(configured.modelCatalog.providers.chatterbox.discoveredModels.map((model) => model.suggested), [
    { text: false, tts: true },
    { text: false, tts: true },
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
  response = await fetch(`${baseUrl}/api/profiles`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.profiles) });
  assert.equal(response.status, 200);
  await syncProfiles(response, state.profiles);
  response = await fetch(`${baseUrl}/api/transcript-prompt/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ episodeProfileId: "episode-chisme-crianza" }) });
  let transcriptPrompt = await response.json();
  assert.match(transcriptPrompt.lockedPrompt, /does not support inline tags/);
  assert.equal(transcriptPrompt.capabilities[0].cueMode, "delivery");
  response = await fetch(`${baseUrl}/api/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ episodeProfileId: "episode-chisme-crianza", speakerProfileId: "speaker-chisme-crianza", speakerIndex: 0, text: "[laugh] Hola", cue: "warm" }) });
  assert.equal(response.status, 200);
  const preview = Buffer.from(await response.arrayBuffer());
  assert.equal(response.headers.get("content-type"), "audio/wav");
  assert.equal(preview.readUInt16LE(20), 1);
  assert.equal(preview.readUInt16LE(22), 1);
  assert.equal(preview.readUInt32LE(24), 24_000);
  assert.equal(preview.readUInt16LE(34), 16);
  const ttsCall = calls.find((call) => call.url.endsWith("/audio/speech"));
  assert.equal(ttsCall.options.headers.Authorization, undefined);
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
  response = await fetch(`${baseUrl}/api/profiles`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.profiles) });
  assert.equal(response.status, 200);
  await syncProfiles(response, state.profiles);
  response = await fetch(`${baseUrl}/api/transcript-prompt/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ episodeProfileId: "episode-chisme-crianza" }) });
  transcriptPrompt = await response.json();
  assert.match(transcriptPrompt.lockedPrompt, /English Turbo/);
  assert.match(transcriptPrompt.lockedPrompt, /\[laugh\]/);
  assert.equal(transcriptPrompt.capabilities[0].cueMode, "tags");
  response = await fetch(`${baseUrl}/api/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ episodeProfileId: "episode-chisme-crianza", speakerProfileId: "speaker-chisme-crianza", speakerIndex: 0, text: "[laugh] Hello", cue: "warm" }) });
  assert.equal(response.status, 200);
  const ttsCalls = calls.filter((call) => call.url.endsWith("/audio/speech"));
  assert.equal(JSON.parse(ttsCalls.at(-1).options.body).input, "[laugh] Hello");
  assert.equal(JSON.parse(ttsCalls.at(-1).options.body).language, "en");

  const charlieProfile = structuredClone(state.profiles.speakerProfiles[0]);
  charlieProfile.id = "speaker-charlie";
  charlieProfile.name = "Charlie";
  charlieProfile.speakers = [{ ...charlieProfile.speakers[0], name: "Charlie", voiceId: "charlie_EN" }];
  state.profiles.speakerProfiles.push(charlieProfile);
  response = await fetch(`${baseUrl}/api/profiles`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.profiles) });
  assert.equal(response.status, 200);
  response = await fetch(`${baseUrl}/api/episodes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Charlie override", episodeProfileId: "episode-chisme-crianza", speakerProfileId: "speaker-charlie" }) });
  const overrideEpisode = await response.json();
  assert.equal(response.status, 201, overrideEpisode.error);
  response = await fetch(`${baseUrl}/api/transcript-prompt/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ episodeId: overrideEpisode.id }) });
  transcriptPrompt = await response.json();
  assert.equal(response.status, 200, transcriptPrompt.error);
  assert.deepEqual(transcriptPrompt.capabilities.map((item) => item.speaker), ["Charlie"]);
  assert.match(transcriptPrompt.lockedPrompt, /Chatterbox \(Charlie/);
  response = await fetch(`${baseUrl}/api/transcript-prompt/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ episodeProfileId: "episode-chisme-crianza", speakerProfileId: "speaker-charlie" }) });
  assert.deepEqual((await response.json()).capabilities.map((item) => item.speaker), ["Charlie"]);
  response = await fetch(`${baseUrl}/api/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ episodeId: overrideEpisode.id, speakerIndex: 0, text: "Hello", cue: "warm" }) });
  assert.equal(response.status, 200);
  const legacyPath = join(rootDir, "data", "episodes", overrideEpisode.id, "episode.json");
  const legacyEpisode = JSON.parse(await readFile(legacyPath, "utf8"));
  delete legacyEpisode.episodeProfile;
  delete legacyEpisode.speakerProfile;
  await writeFile(legacyPath, JSON.stringify(legacyEpisode, null, 2));
  response = await fetch(`${baseUrl}/api/transcript-prompt/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ episodeId: overrideEpisode.id }) });
  assert.deepEqual((await response.json()).capabilities.map((item) => item.speaker), ["Charlie"]);

  invalidAudio = true;
  response = await fetch(`${baseUrl}/api/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ episodeId: overrideEpisode.id, speakerIndex: 0, text: "Hello", cue: "warm" }) });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /Charlie: TTS model .* returned unsupported or invalid audio \(audio\/wav\)/);
  assert.ok(!(await readdir(join(rootDir, "data"))).some((name) => name.startsWith(".preview-")));
  invalidAudio = false;

  chatterboxOnline = false;
  response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.config) });
  assert.equal((await response.json()).modelCatalog.providers.chatterbox.status, "error");
  response = await fetch(`${baseUrl}/api/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ episodeId: overrideEpisode.id, speakerIndex: 0, text: "Hello", cue: "warm" }) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Charlie: Chatterbox is unavailable at http:\/\/127\.0\.0\.1:8100\/v1: .*fetch failed/);
});

test("Podcast Assistant sees Chatterbox voices and tolerates offline discovery", { concurrency: false }, async (t) => {
  const previousMimoKey = process.env.MIMO_API_KEY;
  process.env.MIMO_API_KEY = "assistant-voices-test-key";
  t.after(() => { if (previousMimoKey === undefined) delete process.env.MIMO_API_KEY; else process.env.MIMO_API_KEY = previousMimoKey; });
  let voicesOnline = true;
  let voiceCalls = 0;
  let blockVoices = false;
  let releaseVoices;
  let markVoicesStarted;
  const voiceGate = new Promise((resolve) => { releaseVoices = resolve; });
  const voicesStarted = new Promise((resolve) => { markVoicesStarted = resolve; });
  t.after(() => releaseVoices());
  const prompts = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/voices")) {
      voiceCalls += 1;
      if (blockVoices) { markVoicesStarted(); await voiceGate; }
      if (!voicesOnline) throw new Error("offline");
      return Response.json({ data: [{ id: "charlie_EN", name: "Charlie", builtin: false }] });
    }
    if (String(url).endsWith("/chat/completions")) {
      const request = JSON.parse(options.body);
      const prompt = request.messages[1].content;
      prompts.push({ url: String(url), system: request.messages[0].content, prompt });
      const exact = prompt.includes("Use exact voice ID charlie_EN");
      const content = exact
        ? JSON.stringify({ message: "Create Charlie.", questions: [], proposal: { speakerProfile: { mode: "create", value: { name: "Charlie", voiceModel: "compat:chatterbox:chatterbox-multilingual-v3", speakers: [{ name: "Charlie", voiceId: "charlie_EN" }] } } } })
        : JSON.stringify({ message: voicesOnline ? "Which Chatterbox voice should Charlie use?" : "Chatterbox voice discovery is unavailable.", questions: ["Choose an exact voice ID."], proposal: null });
      return Response.json({ choices: [{ message: { content } }] });
    }
    return Response.json({ data: [{ id: "mimo-v2.5-pro" }, { id: "mimo-v2.5-tts" }, { id: "chatterbox-multilingual-v3", capabilities: { text: false, tts: true } }] });
  };
  const { baseUrl } = await startTestServer(t, "podcast-assistant-chatterbox-voices-", { fetchImpl });
  await waitFor(async () => (await (await fetch(`${baseUrl}/api/models`)).json()).providers.mimo.textModels.some((item) => item.id === "mimo-v2.5-pro"));
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  state.config.providers.chatterbox = { baseUrl: "http://127.0.0.1:8100/v1", modelsUrl: "", enabled: true, activeModels: { "chatterbox-multilingual-v3": { text: false, tts: true } } };
  let response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.config) });
  assert.equal(response.status, 200);
  const originalMimoBaseUrl = state.config.providers.mimo.baseUrl;
  const planningModel = state.profiles.episodeProfiles[0].outlineModel;
  response = await fetch(`${baseUrl}/api/plans`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Charlie plan", speakerProfileId: state.profiles.speakerProfiles[0].id, planningModel, theme: "Testing", audience: "Developers", goal: "Teach" }) });
  const plan = (await response.json()).plan;
  blockVoices = true;
  const firstChat = fetch(`${baseUrl}/api/plans/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: plan.id, text: "Use Chatterbox for Charlie", model: planningModel }) });
  await voicesStarted;
  const changedConfig = structuredClone(state.config);
  changedConfig.providers.mimo.baseUrl = "http://new-mimo.test/v1";
  response = await fetch(`${baseUrl}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changedConfig) });
  assert.equal(response.status, 200);
  releaseVoices();
  response = await firstChat;
  let chat = await response.json();
  assert.equal(response.status, 200, chat.error);
  assert.equal(chat.message.proposal, null);
  assert.match(prompts[0].system, /ask them to choose before proposing/);
  assert.match(prompts[0].prompt, /"chatterboxVoices":\[\{"id":"charlie_EN","name":"Charlie","builtin":false\}\]/);
  assert.match(prompts[0].url, new RegExp(`^${originalMimoBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(voiceCalls, 1);
  response = await fetch(`${baseUrl}/api/plans/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: plan.id, text: "Use exact voice ID charlie_EN", model: planningModel }) });
  chat = await response.json();
  assert.equal(response.status, 200, chat.error);
  assert.equal(chat.message.proposal.speakerProfile.value.speakers[0].voiceId, "charlie_EN");
  assert.equal(voiceCalls, 2);
  // B3: the apply path must allow the same discovered Chatterbox voices as the propose path.
  const chatterboxThread = await (await fetch(`${baseUrl}/api/chat?threadId=${chat.threadId}`)).json();
  response = await fetch(`${baseUrl}/api/plans/chat/apply`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId: chat.threadId, messageIndex: chatterboxThread.messages.findLastIndex((message) => message.role === "assistant") }),
  });
  const applied = await response.json();
  assert.equal(response.status, 200, applied.error);
  assert.deepEqual(applied.warnings, []);
  assert.equal(applied.profiles.speakerProfiles.find((item) => item.name === "Charlie").speakers[0].voiceId, "charlie_EN");
  voicesOnline = false;
  response = await fetch(`${baseUrl}/api/plans/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: plan.id, text: "Check voices again", model: planningModel }) });
  assert.equal(response.status, 200, (await response.clone().json()).error);
  assert.equal(voiceCalls, 2);
  assert.equal((await fetch(`${baseUrl}/api/models/refresh`, { method: "POST" })).status, 202);
  await waitFor(async () => (await (await fetch(`${baseUrl}/api/models`)).json()).status === "ready");
  response = await fetch(`${baseUrl}/api/plans/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: plan.id, text: "Refresh voices", model: planningModel }) });
  assert.equal(response.status, 200, (await response.clone().json()).error);
  assert.equal(voiceCalls, 3);
});

test("profile saves warn for existing unavailable saved models", { concurrency: false }, async (t) => {
  const previousKeys = {
    MIMO_API_KEY: process.env.MIMO_API_KEY,
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CHATTERBOX_API_KEY: process.env.CHATTERBOX_API_KEY,
  };
  delete process.env.MIMO_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CHATTERBOX_API_KEY;
  t.after(() => {
    for (const [name, value] of Object.entries(previousKeys)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const seeded = structuredClone(DEFAULT_DATA);
  seeded.speakerProfiles[0].voiceModel = "compat:chatterbox:chatterbox-multilingual-v3";
  seeded.speakerProfiles[0].speakers = seeded.speakerProfiles[0].speakers.map((speaker) => ({ ...speaker, voiceId: "female" }));
  const { baseUrl } = await startTestServer(t, "podcast-unavailable-model-", {
    fetchImpl: async () => { throw new Error("No provider calls expected."); },
  }, async (rootDir) => {
    await mkdir(join(rootDir, "data"), { recursive: true });
    await writeFile(join(rootDir, "data", "profiles.json"), JSON.stringify(seeded, null, 2));
  });

  let state = await (await fetch(`${baseUrl}/api/state`)).json();
  let response = await fetch(`${baseUrl}/api/profiles`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.profiles) });
  let saved = await response.json();
  assert.equal(response.status, 200);
  assert.match(saved.warnings.join(" "), /compat:chatterbox:chatterbox-multilingual-v3/);

  const invalid = structuredClone(state.profiles);
  invalid.speakerProfiles[0].voiceModel = "compat:chatterbox:brand-new-unknown";
  response = await fetch(`${baseUrl}/api/profiles`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(invalid) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Unsupported TTS model/);

});

test("content plans support CRUD and appear in state", async (t) => {
  const { rootDir, baseUrl } = await startTestServer(t, "podcast-plans-crud-");
  let state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.deepEqual(state.plans, []);
  assert.deepEqual(JSON.parse(await readFile(join(rootDir, "data", "plans", "index.json"), "utf8")), []);

  let response = await fetch(`${baseUrl}/api/plans`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "../../escape", name: "Series", theme: "Initial", episodeCount: 3, episodes: [{ id: "client-owned" }] }) });
  assert.equal(response.status, 201);
  let plan = (await response.json()).plan;
  assert.notEqual(plan.id, "../../escape");
  assert.deepEqual(plan.episodes, []);
  assert.equal(plan.status, "draft");
  assert.equal(plan.episodeFormatId, "");
  assert.equal(plan.language, "es-419");
  assert.equal(plan.targetMinutes, 18);
  assert.equal(Object.hasOwn(plan, "formatDrafts"), false);
  const storedPlanPath = join(rootDir, "data", "plans", `${plan.id}.json`);
  const legacyPlan = JSON.parse(await readFile(storedPlanPath, "utf8"));
  legacyPlan.formatDrafts = [{ id: "legacy-format" }];
  legacyPlan.episodeSeeds = [{ title: "Legacy seed" }];
  legacyPlan.episodes = [{ id: "planned-one", number: 1, title: "One" }, { id: "planned-two", number: 2, title: "Two", createdEpisodeId: "created-two" }];
  await writeFile(storedPlanPath, JSON.stringify(legacyPlan, null, 2));
  plan = (await (await fetch(`${baseUrl}/api/plans/${plan.id}`)).json()).plan;
  assert.equal(Object.hasOwn(plan, "formatDrafts"), false);
  assert.equal(Object.hasOwn(plan, "episodeSeeds"), false);
  response = await fetch(`${baseUrl}/api/plans/${plan.id}/episodes/planned-one`, { method: "DELETE" });
  plan = (await response.json()).plan;
  assert.equal(response.status, 200);
  assert.deepEqual(plan.episodes.map((item) => item.id), ["planned-two"]);
  response = await fetch(`${baseUrl}/api/plans/${plan.id}/episodes/planned-two`, { method: "DELETE" });
  assert.equal(response.status, 409);
  response = await fetch(`${baseUrl}/api/plans/${plan.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...plan, theme: "Updated" }) });
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

test("startup removes replaced assistant histories and keeps Podcast Assistant chats", async (t) => {
  const now = new Date().toISOString();
  const thread = (id, kind) => ({ threadId: id, kind, title: id, messages: [], createdAt: now, updatedAt: now, lastPlanId: kind === "planner" ? "missing-plan" : "" });
  const { rootDir } = await startTestServer(t, "podcast-chat-migration-", {}, async (root) => {
    const chatDir = join(root, "data", "chat");
    await mkdir(chatDir, { recursive: true });
    await writeFile(join(chatDir, "legacy-profile.json"), JSON.stringify(thread("legacy-profile", "profile")));
    await writeFile(join(chatDir, "legacy-transcript.json"), JSON.stringify(thread("legacy-transcript", "transcript")));
    await writeFile(join(chatDir, "podcast-assistant.json"), JSON.stringify(thread("podcast-assistant", "planner")));
  });
  await assert.rejects(readFile(join(rootDir, "data", "chat", "legacy-profile.json"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(join(rootDir, "data", "chat", "legacy-transcript.json"), "utf8"), /ENOENT/);
  assert.match(await readFile(join(rootDir, "data", "chat", "podcast-assistant.json"), "utf8"), /podcast-assistant/);
});

test("content planner validates generation inputs", async (t) => {
  const { baseUrl } = await startTestServer(t, "podcast-plans-validation-");
  let response = await fetch(`${baseUrl}/api/plans`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Invalid" }) });
  let plan = (await response.json()).plan;
  response = await fetch(`${baseUrl}/api/plans/${plan.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...plan, theme: "Theme", planningModel: "" }) });
  plan = (await response.json()).plan;
  response = await fetch(`${baseUrl}/api/plans/${plan.id}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Planning model is required.");
  response = await fetch(`${baseUrl}/api/plans/${plan.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...plan, planningModel: "inactive-model" }) });
  plan = (await response.json()).plan;
  response = await fetch(`${baseUrl}/api/plans/${plan.id}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Unsupported or inactive text model/);
  response = await fetch(`${baseUrl}/api/plans/${plan.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...plan, knowledgeBaseId: "missing" }) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Knowledge base does not exist.");
});

test("plan generation does not block unrelated writes while waiting for the model", { concurrency: false }, async (t) => {
  const oldMimo = process.env.MIMO_API_KEY;
  process.env.MIMO_API_KEY = "test-mimo-key";
  t.after(() => { if (oldMimo === undefined) delete process.env.MIMO_API_KEY; else process.env.MIMO_API_KEY = oldMimo; });
  let releaseModel;
  let markModelStarted;
  const modelGate = new Promise((resolve) => { releaseModel = resolve; });
  const modelStarted = new Promise((resolve) => { markModelStarted = resolve; });
  t.after(() => releaseModel());
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "mimo-v2.5-pro" }] });
    if (String(url).endsWith("/chat/completions")) {
      markModelStarted();
      await modelGate;
      return Response.json({ choices: [{ message: { content: JSON.stringify({ episodes: [{ number: 1, title: "Episode" }] }) } }] });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const { baseUrl } = await startTestServer(t, "podcast-unlocked-generation-", { fetchImpl });
  await waitFor(async () => (await (await fetch(`${baseUrl}/api/models`)).json()).status === "ready");
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  let response = await fetch(`${baseUrl}/api/plans`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Unlocked", speakerProfileId: state.profiles.speakerProfiles[0].id, episodeFormatId: state.profiles.episodeProfiles[0].id, planningModel: "mimo-v2.5-pro", theme: "Theme", audience: "Audience", goal: "Goal", episodeCount: 1 }) });
  const plan = (await response.json()).plan;
  const generation = fetch(`${baseUrl}/api/plans/${plan.id}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  await modelStarted;
  const mutation = fetch(`${baseUrl}/api/knowledge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "concurrent.md", content: "# Concurrent" }) });
  const mutationStatus = await Promise.race([mutation.then((result) => result.status), new Promise((resolve) => setTimeout(() => resolve("timeout"), 1_000))]);
  releaseModel();
  assert.equal(mutationStatus, 201);
  response = await generation;
  assert.equal(response.status, 200);
});

test("plan generation detects edits even when updatedAt is unchanged", { concurrency: false }, async (t) => {
  const oldMimo = process.env.MIMO_API_KEY;
  process.env.MIMO_API_KEY = "test-mimo-key";
  t.after(() => { if (oldMimo === undefined) delete process.env.MIMO_API_KEY; else process.env.MIMO_API_KEY = oldMimo; });
  let releaseModel;
  let markModelStarted;
  const modelGate = new Promise((resolve) => { releaseModel = resolve; });
  const modelStarted = new Promise((resolve) => { markModelStarted = resolve; });
  t.after(() => releaseModel());
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "mimo-v2.5-pro" }] });
    markModelStarted();
    await modelGate;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ episodes: [{ number: 1, title: "Generated" }] }) } }] });
  };
  const { rootDir, baseUrl } = await startTestServer(t, "podcast-plan-snapshot-conflict-", { fetchImpl });
  await waitFor(async () => (await (await fetch(`${baseUrl}/api/models`)).json()).status === "ready");
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  let response = await fetch(`${baseUrl}/api/plans`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Conflict", speakerProfileId: state.profiles.speakerProfiles[0].id, episodeFormatId: state.profiles.episodeProfiles[0].id, planningModel: "mimo-v2.5-pro", theme: "Original", audience: "Audience", goal: "Goal", episodeCount: 1 }) });
  const plan = (await response.json()).plan;
  const generation = fetch(`${baseUrl}/api/plans/${plan.id}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  await modelStarted;
  const path = join(rootDir, "data", "plans", `${plan.id}.json`);
  const edited = JSON.parse(await readFile(path, "utf8"));
  edited.theme = "Edited without changing timestamp";
  await writeFile(path, JSON.stringify(edited, null, 2) + "\n");
  releaseModel();
  response = await generation;
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /changed while content was being generated/);
  assert.equal(JSON.parse(await readFile(path, "utf8")).theme, edited.theme);
});

test("plan generation derives intent from chat when setup fields are empty", { concurrency: false }, async (t) => {
  const oldKey = process.env.MIMO_API_KEY;
  process.env.MIMO_API_KEY = "chat-intent-test-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.MIMO_API_KEY;
    else process.env.MIMO_API_KEY = oldKey;
  });
  const prompts = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/chat/completions")) {
      const request = JSON.parse(options.body);
      const system = request.messages?.[0]?.content || "";
      const prompt = request.messages?.[1]?.content || "";
      prompts.push({ system, prompt });
      const content = system.includes("content planning assistant")
        ? JSON.stringify({ message: "Noted, urban beekeeping it is.", questions: [] })
        : JSON.stringify({ seriesTitle: "Bees", episodeFormat: { name: "Chat Format", description: "Derived from chat" }, episodes: [{ number: 1, title: "Only episode" }], detailedEpisode: { number: 1, premise: "Bee premise", knowledgeScope: "Hives", keyPoints: ["Point"], listenerOutcome: "Learn bees", additionalInstructions: "", transcriptPromptGuidance: "" } });
      return Response.json({ choices: [{ message: { content } }] });
    }
    return Response.json({ data: [{ id: "mimo-v2.5-pro" }, { id: "mimo-v2.5-tts" }] });
  };
  const { baseUrl } = await startTestServer(t, "podcast-plans-chat-intent-", { fetchImpl });
  await waitFor(async () => (await (await fetch(`${baseUrl}/api/models`)).json()).providers.mimo.textModels.some((item) => item.id === "mimo-v2.5-pro"));
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  const speakerProfileId = state.profiles.speakerProfiles[0].id;
  const planningModel = state.profiles.episodeProfiles[0].outlineModel;
  let response = await fetch(`${baseUrl}/api/plans`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Empty setup", speakerProfileId, planningModel, episodeCount: 1 }) });
  const plan = (await response.json()).plan;
  response = await fetch(`${baseUrl}/api/plans/${plan.id}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Fill Theme, Audience, and Goal, or describe the podcast in the assistant chat first.");
  response = await fetch(`${baseUrl}/api/plans/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: plan.id, text: "A show about urban beekeeping for beginners", model: planningModel }) });
  assert.equal(response.status, 200, (await response.clone().json()).error);
  const threadId = (await response.json()).threadId;
  response = await fetch(`${baseUrl}/api/plans/${plan.id}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatThreadId: threadId }) });
  const generatedBody = await response.json();
  assert.equal(response.status, 200, generatedBody.error);
  assert.equal(generatedBody.plan.episodes.length, 1);
  const generationPrompt = prompts.at(-1).prompt;
  assert.match(generationPrompt, /USER CONVERSATION/);
  assert.match(generationPrompt, /urban beekeeping/);
});

test("planner generates plans, creates formats and drafts, and chats", { concurrency: false }, async (t) => {
  const oldKey = process.env.MIMO_API_KEY;
  process.env.MIMO_API_KEY = "planner-test-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.MIMO_API_KEY;
    else process.env.MIMO_API_KEY = oldKey;
  });
  const generated = {
    seriesTitle: "Ignored title",
    episodeFormat: { name: "Interview", description: "Focused format" },
    episodes: [
      { number: 1, title: "First" },
      { number: 2, title: "Second" },
    ],
    detailedEpisode: { number: 1, premise: "First premise", knowledgeScope: "Chapter one", keyPoints: ["Point A"], listenerOutcome: "Learn A", additionalInstructions: "Stay focused", transcriptPromptGuidance: "Use a concise opening." },
  };
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/chat/completions")) {
      const request = JSON.parse(options.body);
      const system = request.messages?.[0]?.content || "";
      const prompt = request.messages?.[1]?.content || "";
      const content = system.includes("content planning assistant")
        ? prompt.includes("Broken speaker JSON")
          ? prompt.includes("YOUR PREVIOUS RESPONSE WAS REJECTED")
            ? JSON.stringify({ message: "Recovered.", questions: [], proposal: { speakerProfile: { mode: "create", value: { name: "Recovered Speaker" } } } })
            : '{"message":"Bad "quote" inside"}'
          : prompt.includes("Fenced reply")
          ? '```json\n{"message":"Fenced ok.","questions":[]}\n```'
          : prompt.includes("Improve shared speaker")
          ? JSON.stringify({ message: "Improve the shared host profile.", questions: [], proposal: { speakerProfile: { mode: "update", targetId: "speaker-chisme-crianza", value: { description: "Revised without changing existing references." } } } })
          : prompt.includes("Create partial speaker")
          ? JSON.stringify({ message: "Create a partial host profile.", questions: [], proposal: { speakerProfile: { mode: "create", value: { name: "Partial Speaker", description: "Valid sibling field", voiceModel: "mimo-v2-tts" } } } })
          : prompt.includes("Create partial format")
          ? JSON.stringify({ message: "Create a partial episode format.", questions: [], proposal: { episodeFormat: { mode: "create", value: { name: "Partial Format", description: "Valid format field", outlineModel: "missing-model" } } } })
          : prompt.includes("Apply partial plan")
          ? JSON.stringify({ message: "Apply a partial plan patch.", questions: [], proposal: { planPatch: { audience: "Partial audience", planningModel: "missing-model" } } })
          : prompt.includes("Create a speaker")
          ? JSON.stringify({ message: "Create a focused host profile.", questions: [], proposal: { speakerProfile: { mode: "create", value: { name: "Assistant Speaker" } } } })
          : prompt.includes("Improve shared format")
          ? JSON.stringify({ message: "Improve the shared format.", questions: [], proposal: { episodeFormat: { mode: "update", targetId: "episode-chisme-crianza", value: { description: "Shared format revised.", language: "en-US" } } } })
          : prompt.includes("Improve this format")
          ? JSON.stringify({ message: "Make this format more focused.", questions: [], proposal: { episodeFormat: { mode: "update", targetId: "episode-chisme-crianza", value: { name: "Assistant Format", description: "Focused by the Podcast Assistant", targetMinutes: 21 } } }, nextStep: { target: "planner:episodes", action: "none", targetIds: [], reason: "Continue to planned episodes." } })
          : JSON.stringify({ message: "Narrow audience.", questions: [], proposal: { planPatch: { audience: "Developers", episodeCount: 2 } } })
        : JSON.stringify(generated);
      return Response.json({ choices: [{ message: { content } }] });
    }
    return Response.json({ data: [{ id: "mimo-v2.5-pro" }, { id: "mimo-v2.5-tts" }] });
  };
  const { rootDir, baseUrl } = await startTestServer(t, "podcast-plans-generate-", { fetchImpl });
  await waitFor(async () => (await (await fetch(`${baseUrl}/api/models`)).json()).providers.mimo.textModels.some((item) => item.id === "mimo-v2.5-pro"));
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  const speakerProfileId = state.profiles.speakerProfiles[0].id;
  const planningModel = state.profiles.episodeProfiles[0].outlineModel;
  let response = await fetch(`${baseUrl}/api/plans`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Kept name", speakerProfileId, planningModel, theme: "Build reliable software", audience: "Engineers", goal: "Teach", episodeCount: 2 }) });
  let plan = (await response.json()).plan;
  response = await fetch(`${baseUrl}/api/plans/${plan.id}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  const generatedBody = await response.json();
  assert.equal(response.status, 200, generatedBody.error);
  plan = generatedBody.plan;
  assert.equal(plan.name, "Kept name");
  assert.ok(plan.episodeFormatId);
  assert.equal(plan.episodes.length, 2);
  assert.equal(plan.episodes[0].title, "First");
  assert.equal(plan.episodes[0].premise, "First premise");
  assert.equal(plan.episodes[1].premise, "");
  assert.ok(plan.episodes.every((item) => item.episodeProfileId === plan.episodeFormatId));
  const autoFormat = generatedBody.profiles.episodeProfiles.find((item) => item.id === plan.episodeFormatId);
  assert.equal(autoFormat.name, "Interview");
  assert.equal(autoFormat.language, "es-419");
  assert.equal(autoFormat.targetMinutes, 18);
  assert.equal(autoFormat.numSegments, 5);
  assert.equal(autoFormat.revision, 1);
  assert.equal(plan.workflowReviews, undefined);

  response = await fetch(`${baseUrl}/api/plans/${plan.id}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage: "speakerProfile" }) });
  assert.equal(response.status, 404);
  response = await fetch(`${baseUrl}/api/plans/${plan.id}/detail-episode`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plannedEpisodeId: plan.episodes[1].id }) });
  assert.equal(response.status, 404);

  const revisedProfiles = structuredClone(generatedBody.profiles);
  revisedProfiles.speakerProfiles.find((item) => item.id === speakerProfileId).description += " Revised.";
  response = await fetch(`${baseUrl}/api/profiles`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(revisedProfiles) });
  const savedProfiles = (await response.json()).profiles;
  assert.equal(response.status, 200);
  assert.equal(savedProfiles.speakerProfiles.find((item) => item.id === speakerProfileId).revision, 1);

  response = await fetch(`${baseUrl}/api/plans/${plan.id}/create-episodes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plannedEpisodeIds: plan.episodes.map((item) => item.id) }) });
  assert.equal(response.status, 200);
  const created = await response.json();
  assert.equal(created.episodes.length, 2);
  assert.match(created.episodes[0].additionalInstructions, /Point A/);
  assert.equal(created.episodes[0].transcriptPromptGuidance, "Use a concise opening.");
  assert.ok(created.plan.episodes.every((item) => item.createdEpisodeId));
  assert.equal(created.episodes[0].speakerProfileId, speakerProfileId);
  assert.ok(await readFile(join(rootDir, "data", "episodes", created.episodes[0].id, "episode.json"), "utf8"));

  response = await fetch(`${baseUrl}/api/plans/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: plan.id, text: "Improve setup", model: planningModel, planDraft: { audience: "Current draft", episodeCount: null } }) });
  const chat = await response.json();
  assert.equal(response.status, 200, chat.error);
  assert.equal(chat.message.proposal.planPatch.audience, "Developers");
  const assistantThread = await (await fetch(`${baseUrl}/api/chat?threadId=${chat.threadId}`)).json();
  const proposalIndex = assistantThread.messages.findIndex((message) => message.role === "assistant");
  response = await fetch(`${baseUrl}/api/plans/chat/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId: chat.threadId, messageIndex: proposalIndex }) });
  const appliedProposal = await response.json();
  assert.equal(response.status, 200, appliedProposal.error);
  assert.equal(appliedProposal.appliedType, "plan");
  assert.equal(appliedProposal.plan.audience, "Developers");
  response = await fetch(`${baseUrl}/api/plans/chat/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId: chat.threadId, messageIndex: proposalIndex }) });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "Proposal already applied.");
  response = await fetch(`${baseUrl}/api/plans/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: plan.id, text: "Improve this format", model: planningModel, activeContext: { view: "planner", plannerSection: "plan", episodeProfileId: "episode-chisme-crianza" }, workspaceDraft: { name: "Current unsaved format" } }) });
  const formatChat = await response.json();
  assert.equal(response.status, 200, formatChat.error);
  assert.equal(formatChat.message.proposal.episodeFormat.value.name, "Assistant Format");
  assert.equal(formatChat.message.nextStep.target, "episodes");
  const formatThread = await (await fetch(`${baseUrl}/api/chat?threadId=${formatChat.threadId}`)).json();
  const formatProposalIndex = formatThread.messages.findIndex((message) => message.role === "assistant");
  response = await fetch(`${baseUrl}/api/plans/chat/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId: formatChat.threadId, messageIndex: formatProposalIndex }) });
  const appliedFormat = await response.json();
  assert.equal(response.status, 200, appliedFormat.error);
  assert.equal(appliedFormat.appliedType, "episodeFormat");
  assert.equal(appliedFormat.profiles.episodeProfiles.find((item) => item.id === "episode-chisme-crianza").name, "Assistant Format");
  assert.equal(appliedFormat.profiles.episodeProfiles.find((item) => item.id === "episode-chisme-crianza").numSegments, 6);
  assert.equal(appliedFormat.plan.episodeFormatId, "episode-chisme-crianza");
  assert.ok(appliedFormat.plan.episodes.every((item) => item.episodeProfileId === "episode-chisme-crianza"));
  assert.equal(appliedFormat.updatedEpisodes, 2);
  assert.equal(JSON.parse(await readFile(join(rootDir, "data", "episodes", created.episodes[0].id, "episode.json"), "utf8")).episodeProfile.id, "episode-chisme-crianza");
  response = await fetch(`${baseUrl}/api/plans`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Other holder", speakerProfileId, episodeFormatId: "episode-chisme-crianza", planningModel, theme: "Hold the shared profile" }) });
  const holderPlan = (await response.json()).plan;
  assert.equal(response.status, 201);
  response = await fetch(`${baseUrl}/api/plans/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: plan.id, text: "Improve shared speaker", model: planningModel, activeContext: { view: "speakers" } }) });
  const sharedSpeakerChat = await response.json();
  assert.equal(response.status, 200, sharedSpeakerChat.error);
  assert.equal(sharedSpeakerChat.message.proposal.speakerProfile.impact.episodes, 2);
  const sharedSpeakerThread = await (await fetch(`${baseUrl}/api/chat?threadId=${sharedSpeakerChat.threadId}`)).json();
  const sharedSpeakerProposalIndex = sharedSpeakerThread.messages.findIndex((message) => message.role === "assistant");
  response = await fetch(`${baseUrl}/api/plans/chat/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId: sharedSpeakerChat.threadId, messageIndex: sharedSpeakerProposalIndex }) });
  const appliedSharedSpeaker = await response.json();
  assert.equal(response.status, 200, appliedSharedSpeaker.error);
  const revisedSpeaker = appliedSharedSpeaker.profiles.speakerProfiles.find((item) => item.name === `${state.profiles.speakerProfiles[0].name} — Copy`);
  assert.ok(revisedSpeaker);
  assert.equal(revisedSpeaker.description, "Revised without changing existing references.");
  assert.notEqual(revisedSpeaker.id, speakerProfileId);
  assert.equal(appliedSharedSpeaker.profiles.speakerProfiles.find((item) => item.id === speakerProfileId).name, state.profiles.speakerProfiles[0].name);
  assert.equal(appliedSharedSpeaker.plan.speakerProfileId, revisedSpeaker.id);
  assert.equal(appliedSharedSpeaker.updatedEpisodes, 2);
  const propagatedEpisode = JSON.parse(await readFile(join(rootDir, "data", "episodes", created.episodes[0].id, "episode.json"), "utf8"));
  assert.equal(propagatedEpisode.speakerProfileId, revisedSpeaker.id);
  assert.equal(propagatedEpisode.speakerProfile.id, revisedSpeaker.id);
  assert.equal((await (await fetch(`${baseUrl}/api/plans/${holderPlan.id}`)).json()).plan.speakerProfileId, speakerProfileId);
  const appliedThread = await (await fetch(`${baseUrl}/api/chat?threadId=${sharedSpeakerChat.threadId}`)).json();
  assert.ok(appliedThread.messages[sharedSpeakerProposalIndex].appliedAt);
  response = await fetch(`${baseUrl}/api/plans/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: plan.id, text: "Improve shared format", model: planningModel, activeContext: { view: "format" } }) });
  const sharedFormatChat = await response.json();
  assert.equal(response.status, 200, sharedFormatChat.error);
  const sharedFormatThread = await (await fetch(`${baseUrl}/api/chat?threadId=${sharedFormatChat.threadId}`)).json();
  const sharedFormatProposalIndex = sharedFormatThread.messages.findIndex((message) => message.role === "assistant");
  response = await fetch(`${baseUrl}/api/plans/chat/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId: sharedFormatChat.threadId, messageIndex: sharedFormatProposalIndex }) });
  const appliedSharedFormat = await response.json();
  assert.equal(response.status, 200, appliedSharedFormat.error);
  assert.equal(appliedSharedFormat.appliedType, "episodeFormat");
  const formatCopy = appliedSharedFormat.profiles.episodeProfiles.find((item) => item.name === "Assistant Format — Copy");
  assert.ok(formatCopy);
  assert.equal(formatCopy.description, "Shared format revised.");
  assert.equal(formatCopy.language, "en-US");
  assert.notEqual(formatCopy.id, "episode-chisme-crianza");
  assert.equal(appliedSharedFormat.profiles.episodeProfiles.find((item) => item.id === "episode-chisme-crianza").description, "Focused by the Podcast Assistant");
  assert.equal(appliedSharedFormat.plan.episodeFormatId, formatCopy.id);
  assert.ok(appliedSharedFormat.plan.episodes.every((item) => item.episodeProfileId === formatCopy.id));
  assert.equal(appliedSharedFormat.updatedEpisodes, 2);
  const formatPropagated = JSON.parse(await readFile(join(rootDir, "data", "episodes", created.episodes[0].id, "episode.json"), "utf8"));
  assert.equal(formatPropagated.episodeProfileId, formatCopy.id);
  assert.equal(formatPropagated.episodeProfile.id, formatCopy.id);
  assert.equal((await (await fetch(`${baseUrl}/api/plans/${holderPlan.id}`)).json()).plan.episodeFormatId, "episode-chisme-crianza");
  assert.ok((await (await fetch(`${baseUrl}/api/chat?threadId=${sharedFormatChat.threadId}`)).json()).messages[sharedFormatProposalIndex].appliedAt);
  await fetch(`${baseUrl}/api/plans/${holderPlan.id}`, { method: "DELETE" });
  response = await fetch(`${baseUrl}/api/plans/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: plan.id, text: "Improve shared speaker", model: planningModel, activeContext: { view: "speakers" } }) });
  const unsharedSpeakerChat = await response.json();
  const unsharedThread = await (await fetch(`${baseUrl}/api/chat?threadId=${unsharedSpeakerChat.threadId}`)).json();
  response = await fetch(`${baseUrl}/api/plans/chat/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId: unsharedSpeakerChat.threadId, messageIndex: unsharedThread.messages.findIndex((message) => message.role === "assistant") }) });
  const appliedUnshared = await response.json();
  assert.equal(response.status, 200, appliedUnshared.error);
  assert.equal(appliedUnshared.profiles.speakerProfiles.filter((item) => item.name.endsWith("— Copy")).length, 1);
  assert.equal(appliedUnshared.profiles.speakerProfiles.find((item) => item.id === speakerProfileId).description, "Revised without changing existing references.");
  assert.equal(appliedUnshared.plan.speakerProfileId, speakerProfileId);
  assert.equal(appliedUnshared.updatedEpisodes, 2);
  assert.equal(JSON.parse(await readFile(join(rootDir, "data", "episodes", created.episodes[0].id, "episode.json"), "utf8")).speakerProfile.id, speakerProfileId);
  response = await fetch(`${baseUrl}/api/plans/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: plan.id, text: "Create a speaker", model: planningModel, activeContext: { view: "planner", plannerSection: "plan" } }) });
  const speakerChat = await response.json();
  assert.equal(response.status, 200, speakerChat.error);
  const speakerThread = await (await fetch(`${baseUrl}/api/chat?threadId=${speakerChat.threadId}`)).json();
  const speakerProposalIndex = speakerThread.messages.findIndex((message) => message.role === "assistant");
  const blockedEpisodePath = join(rootDir, "data", "episodes", created.episodes[0].id, "episode.json");
  const blockedEpisode = JSON.parse(await readFile(blockedEpisodePath, "utf8"));
  const profilesPath = join(rootDir, "data", "profiles.json");
  const profilesWithUnrelatedWarning = JSON.parse(await readFile(profilesPath, "utf8"));
  const unrelatedSpeaker = structuredClone(profilesWithUnrelatedWarning.speakerProfiles[0]);
  unrelatedSpeaker.id = "unrelated-stale-speaker";
  unrelatedSpeaker.name = "Unrelated stale speaker";
  unrelatedSpeaker.voiceModel = "unrelated-stale-tts";
  unrelatedSpeaker.speakers = unrelatedSpeaker.speakers.map((speaker) => ({ ...speaker, ttsModelOverride: "" }));
  profilesWithUnrelatedWarning.speakerProfiles.push(unrelatedSpeaker);
  await writeFile(profilesPath, JSON.stringify(profilesWithUnrelatedWarning, null, 2));
  const beforeFailedApply = await (await fetch(`${baseUrl}/api/state`)).json();
  const beforeFailedPlan = (await (await fetch(`${baseUrl}/api/plans/${plan.id}`)).json()).plan;
  await writeFile(blockedEpisodePath, JSON.stringify({ ...blockedEpisode, job: { id: "blocked", type: "tts", status: "running" } }, null, 2));
  response = await fetch(`${baseUrl}/api/plans/chat/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId: speakerChat.threadId, messageIndex: speakerProposalIndex }) });
  assert.equal(response.status, 409);
  const afterFailedApply = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.deepEqual(afterFailedApply.profiles, beforeFailedApply.profiles);
  assert.deepEqual((await (await fetch(`${baseUrl}/api/plans/${plan.id}`)).json()).plan, beforeFailedPlan);
  assert.equal((await (await fetch(`${baseUrl}/api/chat?threadId=${speakerChat.threadId}`)).json()).messages[speakerProposalIndex].appliedAt, undefined);
  await writeFile(blockedEpisodePath, JSON.stringify(blockedEpisode, null, 2));
  response = await fetch(`${baseUrl}/api/plans/chat/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId: speakerChat.threadId, messageIndex: speakerProposalIndex }) });
  const appliedSpeaker = await response.json();
  assert.equal(response.status, 200, appliedSpeaker.error);
  const createdSpeaker = appliedSpeaker.profiles.speakerProfiles.find((item) => item.name === "Assistant Speaker");
  assert.ok(createdSpeaker);
  assert.doesNotMatch(appliedSpeaker.warnings.join(" "), /unrelated-stale-tts/);
  assert.equal(appliedSpeaker.plan.speakerProfileId, createdSpeaker.id);
  const stateAfterSpeakerApply = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.ok(stateAfterSpeakerApply.profiles.speakerProfiles.some((item) => item.id === createdSpeaker.id));
  assert.equal(stateAfterSpeakerApply.plans.find((item) => item.id === plan.id).speakerProfileId, createdSpeaker.id);

  const overrideTarget = created.episodes[0];
  response = await fetch(`${baseUrl}/api/episodes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: overrideTarget.id, name: overrideTarget.name, episodeProfileId: overrideTarget.episodeProfileId, speakerProfileId: createdSpeaker.id, knowledgeBaseId: "", additionalInstructions: overrideTarget.additionalInstructions, transcriptPromptGuidance: overrideTarget.transcriptPromptGuidance }) });
  const overriddenEpisode = await response.json();
  assert.equal(response.status, 200, overriddenEpisode.error);
  assert.equal(overriddenEpisode.speakerProfileId, createdSpeaker.id);
  assert.equal(overriddenEpisode.speakerProfile.id, createdSpeaker.id);
  const persistedOverride = JSON.parse(await readFile(join(rootDir, "data", "episodes", overrideTarget.id, "episode.json"), "utf8"));
  assert.equal(persistedOverride.speakerProfile.id, createdSpeaker.id);
  response = await fetch(`${baseUrl}/api/episodes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: overrideTarget.id, name: overrideTarget.name, episodeProfileId: overrideTarget.episodeProfileId, speakerProfileId: "", knowledgeBaseId: "", additionalInstructions: overrideTarget.additionalInstructions, transcriptPromptGuidance: overrideTarget.transcriptPromptGuidance }) });
  const clearedOverride = await response.json();
  assert.equal(response.status, 200, clearedOverride.error);
  assert.equal(clearedOverride.speakerProfileId, "");
  assert.equal(clearedOverride.speakerProfile.id, speakerProfileId);
  response = await fetch(`${baseUrl}/api/plans/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: plan.id, text: "Create partial speaker", model: planningModel, activeContext: { view: "speakers" } }) });
  const partialChat = await response.json();
  assert.equal(response.status, 200, partialChat.error);
  assert.equal(partialChat.message.proposal.speakerProfile.value.voiceModel, "");
  const partialThread = await (await fetch(`${baseUrl}/api/chat?threadId=${partialChat.threadId}`)).json();
  const partialProposalIndex = partialThread.messages.findIndex((message) => message.role === "assistant");
  response = await fetch(`${baseUrl}/api/plans/chat/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId: partialChat.threadId, messageIndex: partialProposalIndex }) });
  const partialApply = await response.json();
  assert.equal(response.status, 200, partialApply.error);
  const partialSpeaker = partialApply.profiles.speakerProfiles.find((item) => item.name === "Partial Speaker");
  assert.equal(partialSpeaker.description, "Valid sibling field");
  assert.equal(partialSpeaker.voiceModel, "");
  assert.match(partialApply.warnings.join(" "), /mimo-v2-tts/);
  response = await fetch(`${baseUrl}/api/plans/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: plan.id, text: "Create partial format", model: planningModel, activeContext: { view: "formats" } }) });
  const partialFormatChat = await response.json();
  const partialFormatThread = await (await fetch(`${baseUrl}/api/chat?threadId=${partialFormatChat.threadId}`)).json();
  response = await fetch(`${baseUrl}/api/plans/chat/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId: partialFormatChat.threadId, messageIndex: partialFormatThread.messages.findIndex((message) => message.role === "assistant") }) });
  const partialFormatApply = await response.json();
  assert.equal(response.status, 200, partialFormatApply.error);
  const partialFormat = partialFormatApply.profiles.episodeProfiles.find((item) => item.name === "Partial Format");
  assert.equal(partialFormat.description, "Valid format field");
  assert.equal(partialFormat.outlineModel, "");
  response = await fetch(`${baseUrl}/api/plans/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: plan.id, text: "Apply partial plan", model: planningModel }) });
  const partialPlanChat = await response.json();
  const partialPlanThread = await (await fetch(`${baseUrl}/api/chat?threadId=${partialPlanChat.threadId}`)).json();
  response = await fetch(`${baseUrl}/api/plans/chat/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId: partialPlanChat.threadId, messageIndex: partialPlanThread.messages.findIndex((message) => message.role === "assistant") }) });
  const partialPlanApply = await response.json();
  assert.equal(response.status, 200, partialPlanApply.error);
  assert.equal(partialPlanApply.plan.audience, "Partial audience");
  assert.equal(partialPlanApply.plan.planningModel, "");
  response = await fetch(`${baseUrl}/api/plans/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: plan.id, text: "Fenced reply", model: planningModel }) });
  const fencedChat = await response.json();
  assert.equal(response.status, 200, fencedChat.error);
  assert.equal(fencedChat.message.message, "Fenced ok.");
  response = await fetch(`${baseUrl}/api/plans/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: plan.id, text: "Broken speaker JSON", model: planningModel }) });
  const recoveredChat = await response.json();
  assert.equal(response.status, 200, recoveredChat.error);
  assert.equal(recoveredChat.message.message, "Recovered.");
  assert.equal(recoveredChat.message.proposal.speakerProfile.value.name, "Recovered Speaker");
  const chats = await (await fetch(`${baseUrl}/api/chats?kind=planner&planId=${plan.id}`)).json();
  assert.equal(chats.chats[0].kind, "planner");
  assert.equal(chats.chats[0].lastPlanId, plan.id);

  const savedEpisodeFormatId = state.profiles.episodeProfiles[0].id;
  response = await fetch(`${baseUrl}/api/plans`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Auto count", speakerProfileId, episodeFormatId: savedEpisodeFormatId, planningModel, theme: "Choose a useful series length", audience: "Engineers", goal: "Teach" }) });
  let autoPlan = (await response.json()).plan;
  assert.equal(response.status, 201);
  assert.equal(autoPlan.episodeCount, null);
  response = await fetch(`${baseUrl}/api/plans/${autoPlan.id}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  autoPlan = (await response.json()).plan;
  assert.equal(response.status, 200);
  assert.equal(autoPlan.episodeCount, 2);
  assert.equal(autoPlan.episodes.length, 2);
  assert.equal(autoPlan.episodeFormatId, savedEpisodeFormatId);
  assert.equal(autoPlan.episodes[1].premise, "");
  response = await fetch(`${baseUrl}/api/plans/${autoPlan.id}/create-episodes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plannedEpisodeIds: [autoPlan.episodes[1].id] }) });
  const titleOnlyDraft = await response.json();
  assert.equal(response.status, 200, titleOnlyDraft.error);
  assert.match(titleOnlyDraft.episodes[0].additionalInstructions, /Planned episode:\nNone\./);
  await fetch(`${baseUrl}/api/plans/${autoPlan.id}`, { method: "DELETE" });

  const deleteTarget = created.episodes[1];
  response = await fetch(`${baseUrl}/api/episodes/${deleteTarget.id}`, { method: "DELETE" });
  assert.equal(response.status, 200);
  response = await fetch(`${baseUrl}/api/episodes/${deleteTarget.id}`);
  assert.equal(response.status, 404);
  const planAfterDelete = (await (await fetch(`${baseUrl}/api/plans/${plan.id}`)).json()).plan;
  assert.equal(planAfterDelete.episodes.length, 1);
  assert.ok(planAfterDelete.episodes.every((item) => item.createdEpisodeId !== deleteTarget.id));
  response = await fetch(`${baseUrl}/api/episodes/${deleteTarget.id}`, { method: "DELETE" });
  assert.equal(response.status, 404);

  response = await fetch(`${baseUrl}/api/speaker-profiles/unknown-profile`, { method: "DELETE" });
  assert.equal(response.status, 404);
  const stateBeforeProfileDelete = await (await fetch(`${baseUrl}/api/state`)).json();
  const planSpeakerId = stateBeforeProfileDelete.plans.find((item) => item.id === plan.id).speakerProfileId;
  response = await fetch(`${baseUrl}/api/speaker-profiles/${planSpeakerId}`, { method: "DELETE" });
  const profileDelete = await response.json();
  assert.equal(response.status, 200, profileDelete.error);
  assert.equal(profileDelete.repointedPlans, 1);
  const repointedPlan = (await (await fetch(`${baseUrl}/api/plans/${plan.id}`)).json()).plan;
  assert.equal(repointedPlan.speakerProfileId, profileDelete.fallbackId);
  let remainingProfiles = (await (await fetch(`${baseUrl}/api/state`)).json()).profiles.speakerProfiles;
  while (remainingProfiles.length > 1) {
    response = await fetch(`${baseUrl}/api/speaker-profiles/${remainingProfiles[0].id}`, { method: "DELETE" });
    assert.equal(response.status, 200);
    remainingProfiles = (await (await fetch(`${baseUrl}/api/state`)).json()).profiles.speakerProfiles;
  }
  response = await fetch(`${baseUrl}/api/speaker-profiles/${remainingProfiles[0].id}`, { method: "DELETE" });
  assert.equal(response.status, 400);

  response = await fetch(`${baseUrl}/api/plans/${plan.id}`, { method: "DELETE" });
  assert.equal(response.status, 200);
  assert.deepEqual((await (await fetch(`${baseUrl}/api/chats?kind=planner&planId=${plan.id}`)).json()).chats, []);
});

test("index.html stays CSP-safe: no inline style or event-handler attributes", async () => {
  const html = await readFile(join(process.cwd(), "public", "index.html"), "utf8");
  assert.doesNotMatch(html, /\sstyle=/);
  assert.doesNotMatch(html, /\son[a-z]+=/);
  assert.doesNotMatch(html, /javascript:/);
  assert.equal(html.match(/<script/g).length, 1);
  assert.equal(html.match(/<style/g).length, 1);
});

test("v4 controls preserve hidden legacy settings and select only active v4 for new profiles", async () => {
  const html = await readFile(join(process.cwd(), "public", "index.html"), "utf8");
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  new Script(script);
  const source = (name) => script.match(new RegExp(`    function ${name}\\([^]*?\\n    }`))[0];
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
  const html = await readFile(join(process.cwd(), "public", "index.html"), "utf8");
  assert.match(html, /step\.action === "generateTranscript"\) return lockWhile\(\$\("generateTranscript"\), generateTranscript\)/);
  assert.match(html, /step\.action === "generateTts"\) return lockWhile\(\$\("renderAudio"\), renderAudio\)/);
  // The button is re-enabled before the render, so a throwing render cannot leave it disabled forever.
  assert.match(html, /finally \{ delete button\.dataset\.busy; button\.disabled = false; renderJobIndicators\(\); \}/);
});

test("package-lock version agrees with package.json", async () => {
  const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(process.cwd(), "package-lock.json"), "utf8"));
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
});
