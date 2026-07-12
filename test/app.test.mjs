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
  sanitizeProposalEpisode,
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
    return new Response(Buffer.from("fake-mp3"), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
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
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "fake-mp3");

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

test("local API seeds data and saves knowledge plus episode", async (t) => {
  const { baseUrl } = await startTestServer(t, "podcast-builder-", {}, async (rootDir) => {
    await mkdir(join(rootDir, "public"), { recursive: true });
    await writeFile(join(rootDir, "public", "index.html"), "<!doctype html><title>Test</title>");
  });

  let response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'none'");

  response = await fetch(`${baseUrl}/api/state`);
  let state = await response.json();
  assert.equal(response.status, 200);
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

  response = await fetch(`${baseUrl}/api/episodes/${episode.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Renamed podcast" }) });
  const renamed = await response.json();
  assert.equal(response.status, 200);
  assert.equal(renamed.name, "Renamed podcast");
  assert.equal(renamed.status, "transcript_ready");
  assert.equal(renamed.transcript, saved.transcript);

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
  assert.match(shortJob.message, /Transcript is too short: 20 words/);
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
  const oldEleven = process.env.ELEVENLABS_API_KEY;
  process.env.MIMO_API_KEY = "test-mimo-key";
  delete process.env.ELEVENLABS_API_KEY;
  t.after(() => {
    if (oldMimo === undefined) delete process.env.MIMO_API_KEY; else process.env.MIMO_API_KEY = oldMimo;
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

  response = await fetch(`${baseUrl}/api/episodes/${episode.id}/generate`, { method: "POST" });
  assert.equal(response.status, 202);
  await waitFor(async () => {
    const jobs = await (await fetch(`${baseUrl}/api/jobs`)).json();
    return jobs.jobs.find((job) => job.episodeId === episode.id)?.status === "completed" ? jobs : null;
  });
  const generated = await (await fetch(`${baseUrl}/api/episodes/${episode.id}`)).json();
  assert.equal(generated.name, "Generated Title");
  assert.match(generated.transcript, /\[pause\]/);
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
  const cleanedEpisode = await (await fetch(`${baseUrl}/api/episodes/${episode.id}`)).json();
  assert.equal(corrupt.status, "corrupt");
  assert.equal(corrupt.corrupt, true);
  assert.equal(cleanedEpisode.ttsPreparation, undefined);
  assert.equal(cleanedEpisode.job, undefined);
  for (const name of ["outline.json", "transcript.json", "concat.txt"]) await assert.rejects(readFile(join(healthyDir, name)), { code: "ENOENT" });
  for (const name of ["tts-script.md", "tts-script.draft.md"]) await assert.rejects(readFile(join(healthyDir, name)), { code: "ENOENT" });
  await assert.rejects(readFile(legacyChatPath), { code: "ENOENT" });
  await assert.rejects(readFile(join(clipsDir, `${"e".repeat(64)}.wav`)), { code: "ENOENT" });
  assert.equal(await readFile(join(corruptDir, "outline.json"), "utf8"), "preserve");

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
  const { baseUrl } = await startTestServer(t, "podcast-chatterbox-", { fetchImpl });
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
  response = await fetch(`${baseUrl}/api/transcript-prompt/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ episodeProfileId: "episode-chisme-crianza" }) });
  let transcriptPrompt = await response.json();
  assert.match(transcriptPrompt.lockedPrompt, /does not support inline tags/);
  assert.equal(transcriptPrompt.capabilities[0].cueMode, "delivery");
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
  await writeFile(storedPlanPath, JSON.stringify(legacyPlan, null, 2));
  plan = (await (await fetch(`${baseUrl}/api/plans/${plan.id}`)).json()).plan;
  assert.equal(Object.hasOwn(plan, "formatDrafts"), false);
  assert.equal(Object.hasOwn(plan, "episodeSeeds"), false);
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
  response = await fetch(`${baseUrl}/api/plans/chat/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId: speakerChat.threadId, messageIndex: speakerProposalIndex }) });
  const appliedSpeaker = await response.json();
  assert.equal(response.status, 200, appliedSpeaker.error);
  const createdSpeaker = appliedSpeaker.profiles.speakerProfiles.find((item) => item.name === "Assistant Speaker");
  assert.ok(createdSpeaker);
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

test("browser model fields and loading surfaces are present", async () => {
  const html = await readFile(join(process.cwd(), "public", "index.html"), "utf8");
  const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(process.cwd(), "package-lock.json"), "utf8"));
  assert.equal(manifest.version, "0.13.3");
  assert.equal(lock.version, "0.13.3");
  assert.equal(lock.packages[""].version, "0.13.3");
  assert.match(html, /<select id="epOutlineModel"><\/select>/);
  assert.match(html, /<select id="epTranscriptModel"><\/select>/);
  assert.match(html, /<select id="epLanguage"><\/select>/);
  assert.doesNotMatch(html, /id="epSegments"|id="epBriefing"|data-draft-field="numSegments"|data-draft-field="defaultBriefing"/);
  assert.match(html, /<label class="full" data-help="Grounds this episode in uploaded source material\.">Knowledge Base<select id="buildKnowledge"><\/select><\/label>/);
  assert.match(html, /id="serverActivity"/);
  assert.match(html, /id="notificationFeed"/);
  assert.match(html, /<details class="notice-item"/);
  assert.match(html, /<details class="job-item"/);
  assert.match(html, /\.job-item\[open\]\[data-job-id\]/);
  assert.match(html, /openJobs\.has\(job\.id\) \? " open" : ""/);
  assert.match(html, /<summary>\[\$\{label\} - \$\{escapeHtml\(item\.message\)\}\]<\/summary>/);
  assert.match(html, /data-job-player=/);
  assert.match(html, /function openJobInPlayer\(id\)/);
  assert.match(html, /grid-auto-rows: max-content/);
  assert.match(html, /\.notice-item summary, \.job-item summary \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
  assert.match(html, /class="notice-detail"/);
  assert.match(html, /class="job-detail"/);
  assert.doesNotMatch(html, /id="chatPane"|id="chatHistory"|id="chatMode"|id="chatDelete"|id="chatTargetLabel"/);
  assert.doesNotMatch(html, /id="status" class="status"/);
  assert.match(html, /id="transcriptJob"/);
  assert.match(html, /<button id="generateTranscript" class="primary">.*Generate transcript<\/button>\s*<label class="bulk-check"[^>]*><input id="autoGenerateTts"/);
  assert.doesNotMatch(html, /grid-template-columns: 240px|min-width: 240px|<h1>Podcast Builder<\/h1>/);
  assert.match(html, /class="assistant-sidebar"/);
  assert.match(html, /class="assistant-chat"/);
  assert.match(html, /<nav class="assistant-workflow" aria-label="Workflow">/);
  assert.doesNotMatch(html, /assistant-nav/);
  assert.match(html, /class="assistant-util" data-view="config"/);
  assert.match(html, /class="assistant-util" data-view="player"/);
  assert.match(html, /id="assistantTitle"/);
  assert.doesNotMatch(html, /plan-control|assistantPlanSelect/);
  assert.match(html, /classList\.toggle\("nav-only", navOnly\)/);
  assert.match(html, /const autoNavOnly = \["transcript", "tts", "player", "config"\]\.includes\(view\)/);
  assert.match(html, /const navOnly = autoNavOnly \|\| chatFolded;/);
  assert.match(html, /#podcastAssistant\.nav-only \.assistant-chat \{[^}]*position: absolute/);
  assert.match(html, /id="chatFoldToggle"/);
  assert.match(html, /<symbol id="i-chevron-right"/);
  assert.match(html, /\$\("chatFoldToggle"\)\.hidden = autoNavOnly/);
  assert.match(html, /chatFolded = !chatFolded; renderPodcastAssistant\(\)/);
  assert.match(html, /chatFolded = false;[\s\S]*\$\(.*plannerChatInput"\)\.focus\(\)/);
  assert.match(html, /\.chat-fold-toggle \{[^}]*position: absolute/);
  assert.match(html, /#podcastAssistant\.nav-only \.chat-fold-toggle \.icon \{ transform: rotate\(180deg\)/);
  assert.match(html, /\.assistant-chat \{[^}]*display: flex; flex-direction: column; \}/);
  assert.match(html, /#podcastAssistant\.animate-fold \.assistant-chat \{[^}]*transition: opacity \.18s ease, transform \.18s ease/);
  assert.match(html, /#podcastAssistant\.chat-open \.assistant-chat \{[^}]*opacity: 1; transform: none/);
  assert.match(html, /main\.assistant-active \{[^}]*width: 100%;[^}]*margin: 0;[^}]*padding: 0;/);
  assert.match(html, /main\.assistant-active\.nav-only \{ grid-template-columns: 300px minmax\(0, 1fr\); \}/);
  assert.match(html, /\.loading-line\[hidden\] \{ display: none; \}/);
  assert.match(html, /data-field="accent"/);
  assert.match(html, /--accent: #FFB900/);
  assert.match(html, /id="view-speakers" class="view" hidden/);
  assert.match(html, /id="view-episodes" class="view" hidden/);
  assert.doesNotMatch(html, /id="view-planner"|id="view-formats"/);
  assert.doesNotMatch(html, /data-view="speakers"|data-view="formats"|data-view="planner"|data-view="episodes"/);
  assert.match(html, /"Describe idea", hasEpisodes, "chat"/);
  assert.match(html, /"Hosts", hasEpisodes, "speakers"/);
  assert.doesNotMatch(html, /data-planner-panel/);
  assert.match(html, /id="episodeList"/);
  assert.match(html, /data-start-episode/);
  assert.match(html, /data-episode-host/);
  assert.match(html, /data-create-planned/);
  assert.match(html, /function renderEpisodeList\(\)/);
  assert.match(html, /async function startEpisode\(id\)/);
  assert.match(html, /async function changeEpisodeHosts\(id, speakerProfileId\)/);
  assert.match(html, /id="episodeSettings"/);
  assert.match(html, /id="episodeHosts"/);
  assert.match(html, /id="saveEpisodeSettings"/);
  assert.doesNotMatch(html, /id="planSelect"|id="generatePlan"|id="planEpisodeFormat"|id="planLanguage"|id="planMinutes"|id="planName"|id="planTheme"|id="planAudience"|id="planGoal"|id="planModel"|id="planEpisodeCount"|id="planKnowledge"|id="savePlan"|id="newPlan"|id="duplicatePlan"|id="deletePlan"|id="planGenerateBusy"/);
  assert.doesNotMatch(html, /id="planGenerateFormats"|id="planFormatCount"|id="planFormatDrafts"/);
  assert.match(html, /id="podcastAssistant" class="chat-pane" hidden/);
  assert.match(html, /<h3 id="assistantTitle">pod-god<\/h3>/);
  assert.match(html, /id="assistantContext"/);
  assert.match(html, /id="assistantProgress"/);
  assert.match(html, /main\.assistant-active \{[^}]*grid-template-columns: minmax\(680px, 760px\) minmax\(0, 1fr\)/);
  assert.match(html, /\.chat-pane \{[^}]*grid-template-columns: 280px minmax\(0, 1fr\)/);
  assert.match(html, /class="view-body"/);
  assert.match(html, /body \{[^}]*overflow: hidden/);
  assert.match(html, /id="assistantChatToggle"/);
  assert.match(html, /id="assistantChatClose"/);
  assert.match(html, /textarea\.transcript \{[^}]*flex: 1 1 auto/);
  assert.doesNotMatch(html, /#0A1520|#1A3040/);
  assert.doesNotMatch(html, /planner-layout/);
  assert.match(html, /label\[data-help\]::after/);
  assert.doesNotMatch(html, /data-planner-section/);
  assert.match(html, /id="saveProfiles" class="primary" disabled>.*Save hosts/);
  assert.doesNotMatch(html, /continueSpeakerProfile|continueEpisodeFormat|Save &amp; Continue/);
  assert.match(html, /Press Start on an episode to generate its script and audio/);
  assert.doesNotMatch(html, /id="selectAllUnsavedFormats"|id="saveAllUnsavedFormats"|id="newEpisode"/);
  assert.doesNotMatch(html, /data-detail-episode|id="plannedEpisodeSidebar"|id="plannedEpisodes"|id="createSelectedEpisodes"|data-planned-episode-id/);
  assert.match(html, /id="speakerSidebar"/);
  assert.match(html, /id="uploadKnowledge"/);
  assert.match(html, /id="knowledgeFile" type="file" accept="\.md,text\/markdown,text\/plain" hidden/);
  assert.match(html, /id="chatControlsPanel" class="chat-controls-panel closed"/);
  assert.match(html, /id="chatPillModel"/);
  assert.match(html, /id="chatPillKb"/);
  assert.match(html, /id="chatControlsToggle"/);
  assert.match(html, /\.chat-controls-panel\.closed \{[^}]*max-height: 0;[^}]*opacity: 0;[^}]*transform: translateY\(-12px\)/);
  assert.match(html, /\.chat-input-actions \.chat-pill \{[^}]*border-radius: 999px/);
  assert.match(html, /function updateChatPills\(\)/);
  assert.match(html, /function setChatControlsOpen\(open\)/);
  assert.match(html, /setChatControlsOpen\(\$\("chatControlsPanel"\)\.classList\.contains\("closed"\)\)/);
  assert.match(html, /chatPillModel.*open.*setChatControlsOpen\(false\).*setChatControlsOpen\(true\).*plannerChatModel.*focus/);
  assert.match(html, /chatPillKb.*open.*setChatControlsOpen\(false\).*setChatControlsOpen\(true\).*plannerChatKb.*focus/);
  assert.match(html, /\$\("plannerChatModel"\)\.addEventListener\("change", updateChatPills\)/);
  assert.doesNotMatch(html, /\.chat-controls \{/);
  assert.doesNotMatch(html, /class="chat-controls"/);
  assert.match(html, /min-height: 56px/);
  assert.match(html, /#playerLibrary \{[^}]*max-height: 60vh;[^}]*overflow-y: auto/);
  assert.match(html, /id="playerPlaylistSelect"/);
  assert.match(html, /pod-god\.playlists\.v1/);
  assert.match(html, /function saveNewPlayerPlaylist\(\)/);
  assert.match(html, /function loadPlayerPlaylist\(\)/);
  assert.match(html, /data-rename-episode=/);
  assert.match(html, /method: "PATCH"/);
  assert.match(html, /Episode Format/);
  assert.match(html, /id="ttsLanguageOverride"/);
  assert.match(html, /id="applyLatestProfiles">.*Apply latest profiles/);
  assert.match(html, /function episodeIsBusy\(\)/);
  assert.match(html, /renderAudio"\)\.disabled = episodeBusy \|\| errors\.length > 0/);
  assert.match(html, /id="transcriptPromptTab"/);
  assert.match(html, /id="transcriptLockedPrompt" readonly/);
  assert.match(html, /id="transcriptPromptGuidance"/);
  assert.match(html, /id="autoGenerateTts" type="checkbox"> Generate TTS after transcript/);
  assert.doesNotMatch(html, /saveTranscriptAndTts|saveTranscriptAndGoToTts/);
  assert.match(html, /autoTtsTranscriptJobs\.add\(job\.id\)/);
  assert.match(html, /await queueTts\(job\.episodeId\)/);
  assert.match(html, /if \(job\.status !== "completed"\) continue/);
  assert.match(html, /api\(`\/api\/episodes\/\$\{episodeId\}\/render`/);
  assert.doesNotMatch(html, /id="transcriptChatPane"|id="transcriptChatHistory"|id="transcriptChatModel"/);
  assert.match(html, /None — use LLM knowledge/);
  assert.doesNotMatch(html, /id="episodeSeed"|Suggested episode/);
  assert.doesNotMatch(html, /id="ttsPromptTab"/);
  assert.doesNotMatch(html, /ttsPreparation/);
  assert.doesNotMatch(html, /prepareTtsScript|approveTtsScript/);
  assert.match(html, /data-view="player"/);
  assert.match(html, /id="view-player"/);
  assert.match(html, /id="playerAudio" preload="metadata" hidden/);
  assert.match(html, /id="playerBottom" class="player-bottom"[^>]* hidden/);
  assert.match(html, /id="bottomPlayerSeek" class="player-bottom-seek"/);
  assert.match(html, /id="bottomPlayerElapsed"/);
  assert.match(html, /id="bottomPlayerDuration"/);
  assert.match(html, /\.player-bottom-title:hover:not\(:disabled\) \{[^}]*color: var\(--text\);[^}]*border-color: transparent;[^}]*background: transparent;/);
  assert.match(html, /id="playerLibrary"/);
  assert.match(html, /id="playerQueue"/);
  assert.match(html, /id="playerSpeed"/);
  assert.match(html, /id="bottomPlayerSpeed"/);
  assert.match(html, /function playEpisode\(id\)/);
  assert.match(html, /function queueEpisode\(id\)/);
  assert.match(html, /function playNextEpisode\(\)/);
  assert.match(html, /Skipping to next episode/);
  assert.match(html, /data-episode-player="play"/);
  assert.doesNotMatch(html, /id="episodeAudio"/);
  assert.match(html, /id="view-config"/);
  assert.doesNotMatch(html, /id="saveEpisodeFormats"/);
  assert.match(html, /id="speakerProfilePills"/);
  assert.doesNotMatch(html, /id="episodeProfilePills"|Save Episode Formats|id="episodeProfileSelect"/);
  assert.match(html, /id="modelDialog"/);
  assert.match(html, /Add OpenAI compatible connection</);
  assert.match(html, /const openaiVoices/);
  assert.match(html, /function voiceSelector\(model, selected, index\)/);
  assert.match(html, /data-field="chatterboxExaggeration"/);
  assert.match(html, /data-field="mimoTemperature"/);
  assert.match(html, /data-field="mimoTopP"/);
  assert.match(html, /data-field="elevenlabsStability"/);
  assert.match(html, /data-field="elevenlabsTextNormalization"/);
  assert.match(html, /class="model-refresh-row"/);
  assert.match(html, /overflow-y: auto/);
  assert.doesNotMatch(html, /event\.target\.closest\("#chatPane"\)|function renderProposalDiff|version !== chatLoadVersion|Save profile changes before using the assistant/);
  assert.doesNotMatch(html, /const lastAssistant/);
  assert.match(html, /id="transcriptLengthWarning"/);
  assert.doesNotMatch(html, /Render anyway\?/);
  assert.match(html, /TTS job queued anyway/);
  assert.match(html, /<input data-field="voiceId" list="voice-options-\$\{index\}"/);
  assert.match(html, /function ensureProviderVoices\(model\)/);
  assert.doesNotMatch(html, /refreshElevenVoices/);
  assert.match(html, /id="configModelStatus" class="model-status"/);
  assert.match(html, /id="modelSelectedOnly" type="checkbox"> Selected only/);
  assert.match(html, /const selectedOnly = \$\("modelSelectedOnly"\)\.checked/);
  assert.match(html, /Config saved with warnings/);
  assert.match(html, /<details class="connection-row"/);
  assert.match(html, /\.connection-row > summary::before/);
  assert.match(html, /input\[type="checkbox"\]:checked/);
  assert.match(html, /class="connection-title"/);
  assert.match(html, /modalityPills\(\["text", "tts"\], connection\.activeModels\)/);
  assert.match(html, /class="status-pill \$\{status\}"/);
  assert.match(html, /used\.text\.has\(profileId\)/);
  assert.doesNotMatch(html, /const ttsModels/);
  assert.match(html, /Clear saved key/);
  assert.match(html, /function captureEpisodeDraft\(\)/);
  assert.match(html, /beforeunload/);
  assert.match(html, /item\.corrupt/);
  assert.match(html, /data-delete-knowledge=/);
  assert.match(html, /function deleteKnowledgeBase\(id\)/);
  assert.match(html, /activeContext: assistantContext\(\)/);
  assert.match(html, /workspaceDraft: assistantWorkspaceDraft\(\)/);
  assert.match(html, /function applyAssistantProposal\(index, continueWorkflow\)/);
  assert.doesNotMatch(html, /data-create-new|Apply to new profile|Update shared profile|createNew\b/);
  assert.match(html, /function summarizeProposal\(type, proposal\)/);
  assert.match(html, /message\.appliedAt/);
  assert.match(html, /<span>Applied<\/span>/);
  assert.match(html, /<link rel="icon" type="image\/png" href="\/icon\.png">/);
  assert.match(html, /<img class="brand-logo" src="\/icon\.png" alt="">/);
  const iconBytes = await readFile(join(process.cwd(), "public", "icon.png"));
  assert.ok(iconBytes.length > 0);
  assert.equal(iconBytes.subarray(1, 4).toString("latin1"), "PNG");
  const serverSource = await readFile(join(process.cwd(), "src", "app.mjs"), "utf8");
  assert.match(serverSource, /path === "\/icon\.png"\) \{\s*return sendFile\(req, res, context\.paths\.publicIcon, "image\/png"\);/);
  assert.match(html, /<symbol id="i-send"/);
  assert.match(html, /function icon\(name, extraClass = ""\)/);
  assert.match(html, /id="chatHistoryToggle"/);
  assert.match(html, /id="chatHistoryPanel"/);
  assert.match(html, /id="chatHistoryList"/);
  assert.match(html, /data-chat-open=/);
  assert.match(html, /data-chat-delete=/);
  assert.doesNotMatch(html, /id="plannerChatHistory"|id="plannerChatReset"|id="plannerChatDelete"/);
  assert.match(html, /class="internal-nav-row"/);
  assert.doesNotMatch(html, /grid-template-columns: 210px/);
  assert.match(html, /button\.innerHTML = icon\(audio\.paused \? "play" : "pause"\)/);
  assert.match(html, /<a class="icon-btn" download href="\$\{escapeHtml\(episode\.audioUrl\)\}"/);
  assert.match(html, /Updates hosts on \$\{proposal\.impact\.episodes\} episode\(s\) of this podcast/);
  assert.match(html, /data-delete-episode/);
  assert.match(html, /data-delete-planned/);
  assert.match(html, /async function deleteEpisode\(id\)/);
  assert.match(html, /async function deletePlannedEpisode\(plannedId\)/);
  assert.match(html, /\/api\/speaker-profiles\//);
  assert.match(html, /At least one host profile must remain\./);
  assert.match(html, /\/api\/plans\/chat\/apply/);
  assert.match(html, /if \(!activePlan\) await createNewPlan\(\)/);
  assert.match(html, /\? candidate : "episodes"/);
  assert.match(html, /\$\("podcastAssistant"\)\.hidden = false/);
  assert.match(html, /class="assistant-steps"/);
  assert.match(html, /data-state="\$\{stepState\}"/);
  assert.match(html, /id="rightbar" class="rightbar"/);
  assert.match(html, /id="rightbarToggle"/);
  assert.match(html, /id="rightbarBadge"/);
  assert.match(html, /id="toasts" class="toasts"/);
  assert.match(html, /pod-god\.rightbar\.v1/);
  assert.match(html, /function updateSaveButtons\(\)/);
  assert.match(html, /function showToast\(entry\)/);
  assert.match(html, /data-assistant-target=/);
  assert.match(html, /pod-god\.view-selections\.v1/);
  assert.match(html, /sessionStorage\.getItem\(VIEW_SELECTIONS_KEY\)/);
  assert.match(html, /sessionStorage\.setItem\(VIEW_SELECTIONS_KEY, JSON\.stringify\(viewSelections\)\)/);
  assert.match(html, /refreshState\(rememberedEpisodeId\)/);
  assert.match(html, /rememberViewSelection\("speakerProfileId", id\)/);
  assert.match(html, /rememberViewSelection\("planId", plan\.id\)/);
  assert.match(html, /rememberViewSelection\("episodeId", id\)/);
  assert.match(html, /rememberViewSelection\("transcriptSection", "prompt"\)/);
  assert.match(html, /<title>pod-god<\/title>/);
  assert.match(html, /id="assistantNextStep"/);
  assert.match(html, /id="assistantNextGo"/);
  assert.match(html, /cta-pulse/);
  assert.match(html, /id="plannerChatBusyText"/);
  assert.match(html, /chatThreadId: plannerChatThreadId/);
  assert.doesNotMatch(html, /assistantPrompts|assistant-prompts|data-assistant-prompt/);
  assert.doesNotMatch(html, /id="generateTranscriptFromPrompt"/);
  assert.match(html, /title="Resolved TTS model">TTS: /);
});
