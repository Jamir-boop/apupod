import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { ChatGptError } from "./chatgpt.mjs";
import { httpError, badRequest, conflict, serviceUnavailable, ID_RE, readJsonBody, readOptionalJsonBody, sendJson } from "./util.mjs";
import { MAX_AUDIO_RESPONSE_BYTES } from "./providers/transport.mjs";
import { LANGUAGE_OPTIONS, modelRuntimeSnapshot, chatGptCatalogAccount, parseCompatibleModelId, builtInConnectionId, resolveLanguage, modelLanguageError, assertTtsLanguageCompatibility } from "./providers/catalog.mjs";
import { turnClipDescriptor, spokenTextForModel, synthesizeTurn, assertWav } from "./providers/generate.mjs";
import { serializeMutation, isActiveJob, resolveEpisodeProfiles, listEpisodes, loadEpisode, updateEpisode, episodeDir, readJson, writeJsonAtomic, replaceTextThenCommit, exists } from "./store.mjs";
import { TRANSCRIPT_MINIMUM_WORDS_PER_MINUTE, validateTranscriptCues, generateOutline, generateTranscript, transcriptToMarkdown, parseTranscript, transcriptWordCount } from "./episodes.mjs";

const FFMPEG_TIMEOUT_MS = 900_000;
const PROCESS_KILL_SIGNAL = "SIGKILL";

export async function interruptStaleJobs(paths) {
  for (const episode of await listEpisodes(paths)) {
    if (!isActiveJob(episode.job) && !["queued", "generating", "rendering"].includes(episode.status)) continue;
    const message = "Generation was interrupted by a server restart.";
    await updateEpisode(paths, episode, {
      status: "failed",
      lastError: message,
      job: episode.job ? { ...episode.job, status: "interrupted", phase: "interrupted", message, error: message, finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } : undefined,
    });
  }
}

export async function cleanupInterruptedEpisodeDeletes(paths) {
  for (const entry of await readdir(paths.episodes, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".deleting")) continue;
    const id = entry.name.slice(0, -9);
    if (!ID_RE.test(id)) continue;
    await rm(join(paths.episodes, entry.name), { recursive: true, force: true })
      .catch((error) => console.warn(`[episode:${id}] deferred deletion cleanup failed: ${error.message || error}`));
  }
}

export async function cleanupStoredArtifacts(context) {
  const { paths } = context;
  const profiles = await readJson(paths.profiles);
  let removed = 0;
  for (const entry of await readdir(paths.episodes, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
    const directory = join(paths.episodes, entry.name);
    try {
      let episode = await readJson(join(directory, "episode.json"));
      const transcriptPath = join(directory, "transcript.md");
      const transcript = await exists(transcriptPath) ? await readFile(transcriptPath, "utf8") : "";
      for (const name of ["tts-script.md", "tts-script.draft.md"]) {
        const path = join(directory, name);
        if (await exists(path)) {
          await rm(path, { force: true });
          removed += 1;
        }
      }
      if (episode.ttsPreparation || episode.job?.type === "tts_prepare") {
        const { ttsPreparation: ignored, ...cleaned } = episode;
        if (cleaned.job?.type === "tts_prepare") {
          delete cleaned.job;
          cleaned.lastError = null;
          cleaned.status = transcript.trim() ? cleaned.audioReady ? "ready" : "transcript_ready" : "draft";
        }
        episode = cleaned;
        await writeJsonAtomic(join(directory, "episode.json"), episode);
        removed += 1;
      }
      const episodeProfile = episode.episodeProfile || profiles.episodeProfiles.find((profile) => profile.id === episode.episodeProfileId);
      const speakerProfile = episode.speakerProfile || profiles.speakerProfiles.find((profile) => profile.id === episodeProfile?.speakerProfileId);
      const usedKeys = new Set();
      if (transcript.trim()) {
        if (!episodeProfile || !speakerProfile) throw new Error("Saved profile snapshot is unavailable.");
        const languageId = episodeProfile.language;
        const language = LANGUAGE_OPTIONS.find((item) => item.id === languageId);
        if (!language) throw new Error(`Unsupported saved language "${languageId}".`);
        const turns = parseTranscript(transcript, speakerProfile.speakers, episodeProfile.numSegments).segments.flatMap((segment) =>
          segment.turns.map((turn, index) => ({ turn, segmentEnd: index === segment.turns.length - 1 })));
        for (let index = 0; index < turns.length; index += 1) {
          const { turn } = turns[index];
          const speaker = speakerProfile.speakers.find((item) => item.name === turn.speaker);
          if (!speaker) throw new Error(`Speaker "${turn.speaker}" is unavailable.`);
          const model = speaker.ttsModelOverride || speakerProfile.voiceModel;
          const textVariants = new Set([turn.text]);
          try { textVariants.add(spokenTextForModel(context, model, turn.text, language)); } catch {}
          for (const text of textVariants) usedKeys.add(clipCacheKey(turnClipDescriptor(context, speakerProfile, speaker, { ...turn, text }, language)));
          const gap = pauseAfterTurnSeconds(turns, index);
          if (gap > 0) usedKeys.add(`silence-${Math.round(gap * 1000)}ms`);
        }
      }
      for (const name of ["outline.json", "transcript.json", "concat.txt"]) {
        const path = join(directory, name);
        if (await exists(path)) {
          await rm(path, { force: true });
          removed += 1;
        }
      }
      removed += await pruneClipCache(join(directory, "clips"), usedKeys);
    } catch (error) {
      console.warn(`[episode:${entry.name}] cleanup skipped: ${error.message || error}`);
    }
  }
  for (const entry of await readdir(paths.chat, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(paths.chat, entry.name);
    try {
      if ((await readJson(path)).kind === "tts") {
        await rm(path, { force: true });
        removed += 1;
      }
    } catch {}
  }
  if (removed) console.log(`[cleanup] removed ${removed} obsolete episode artifacts.`);
}

async function pruneClipCache(directory, usedKeys) {
  if (!(await exists(directory))) return 0;
  let removed = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const key = entry.name.endsWith(".wav") ? entry.name.slice(0, -4) : "";
    if (key && usedKeys.has(key) && !entry.name.endsWith(".tmp.wav") && await isNormalizedWav(join(directory, entry.name))) continue;
    if (!key && !entry.name.includes(".source.") && !entry.name.endsWith(".concat.txt")) continue;
    await rm(join(directory, entry.name), { force: true });
    removed += 1;
  }
  return removed;
}

async function isNormalizedWav(path) {
  let file;
  try {
    file = await open(path, "r");
    const { size: fileSize } = await file.stat();
    const header = Buffer.alloc(12);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    assertWav(header.subarray(0, bytesRead));
    let normalized = false;
    for (let offset = 12; offset + 8 <= fileSize;) {
      const chunk = Buffer.alloc(24);
      const { bytesRead: chunkBytes } = await file.read(chunk, 0, Math.min(chunk.length, fileSize - offset), offset);
      if (chunkBytes < 8) return false;
      const id = chunk.subarray(0, 4).toString("ascii");
      const size = chunk.readUInt32LE(4);
      if (offset + 8 + size > fileSize) return false;
      if (id === "fmt " && size >= 16 && chunkBytes >= 24) {
        normalized = chunk.readUInt16LE(8) === 1
          && chunk.readUInt16LE(10) === 1
          && chunk.readUInt32LE(12) === 24_000
          && chunk.readUInt16LE(20) === 2
          && chunk.readUInt16LE(22) === 16;
      }
      if (id === "data") return normalized && size >= 2 && size % 2 === 0;
      offset += 8 + size + size % 2;
    }
  } catch {
  } finally {
    await file?.close();
  }
  return false;
}

export async function listJobsResponse(res, context) {
  const episodes = await listEpisodes(context.paths);
  const names = new Map(episodes.map((episode) => [episode.id, episode.name]));
  for (const episode of episodes.toReversed()) if (episode.job) rememberJob(context, episode.job);
  const jobs = [...context.recentJobs.values()]
    .filter((job) => names.has(job.episodeId))
    .map((job) => ({ ...job, episodeName: names.get(job.episodeId) || job.episodeId }))
    .sort((a, b) => String(b.queuedAt || b.updatedAt).localeCompare(String(a.queuedAt || a.updatedAt)));
  sendJson(res, 200, { activeJobId: context.activeJobId, jobs });
}

export function rememberJob(context, job) {
  if (!job?.id) return;
  context.recentJobs.delete(job.id);
  context.recentJobs.set(job.id, structuredClone(job));
  while (context.recentJobs.size > 30) context.recentJobs.delete(context.recentJobs.keys().next().value);
}

async function enqueueJob(res, context, id, type, options = {}) {
  const chatgptAccountId = chatGptCatalogAccount(context);
  const episode = await loadEpisode(context.paths, id, true);
  if (isActiveJob(episode.job)) throw conflict("Episode already has an active job.");
  const { episodeProfile, speakerProfile } = await resolveEpisodeProfiles(context.paths, episode);
  const language = resolveLanguage(context, episodeProfile.language);
  let total = 3;
  if (type === "transcript") {
    if (episode.knowledgeBaseId && !(await exists(join(context.paths.knowledge, `${episode.knowledgeBaseId}.md`)))) throw badRequest("Knowledge base does not exist.");
  } else {
    if (!episode.transcript) throw badRequest("Save or generate transcript before rendering.");
    assertTtsLanguageCompatibility(context, speakerProfile, language);
    total = parseTranscript(episode.transcript, speakerProfile.speakers, episodeProfile.numSegments)
      .segments.flatMap((segment) => segment.turns).length;
  }

  const now = new Date().toISOString();
  const job = {
    id: randomUUID(), episodeId: id, type, status: "queued", phase: "queued", completed: 0, total,
    message: `${type === "transcript" ? "Transcript" : "TTS"} job queued.`, error: null,
    queuedAt: now, startedAt: null, finishedAt: null, updatedAt: now,
    options: type === "transcript" && options.autoTts ? { autoTts: true } : {},
  };
  await updateEpisode(context.paths, episode, {
    status: "queued",
    lastError: null,
    job,
  });
  rememberJob(context, job);
  context.queue.push({
    id: job.id,
    episodeId: id,
    type,
    ...(type === "transcript" && [episodeProfile.outlineModel, episodeProfile.transcriptModel].some((model) => builtInConnectionId(context.config, parseCompatibleModelId(model)?.connectionId) === "chatgpt") ? { chatgptAccountId } : {}),
    previousAudioReady: type === "tts" && episode.audioReady === true && await exists(join(episodeDir(context.paths, id), "episode.mp3")),
    autoTts: type === "transcript" && options.autoTts === true,
  });
  if (res) sendJson(res, 202, { job });
  console.log(`[job:${job.id}] queued ${type} for ${id}`);
  queueMicrotask(() => void drainQueue(context));
}

export async function enqueueTranscriptJob(req, res, context, id) {
  const body = await readOptionalJsonBody(req);
  return enqueueJob(res, context, id, "transcript", { autoTts: body.autoTts === true });
}

export async function enqueueTtsJob(req, res, context, id) {
  const body = await readOptionalJsonBody(req);
  if (String(body.languageOverride || "").trim()) throw badRequest("TTS language is defined by the Episode Format.");
  return enqueueJob(res, context, id, "tts");
}

export async function ensureFfmpeg(context) {
  if (!context.ffmpegCheck) {
    context.ffmpegCheck = Promise.all([
      runProcess("ffmpeg", ["-version"]),
      runProcess("ffprobe", ["-version"]),
    ]).catch((error) => {
      context.ffmpegCheck = null;
      throw serviceUnavailable(`FFmpeg or FFprobe is unavailable: ${error.message || error}`);
    });
  }
  await context.ffmpegCheck;
}

async function drainQueue(context) {
  if (context.activeJobId || context.queue.length === 0) return;
  const queued = context.queue.shift();
  context.activeJobId = queued.id;
  try {
    const startMessage = queued.type === "transcript" ? "Starting transcript generation." : "Starting TTS generation.";
    await updateJob(context, queued, {
      status: "running", phase: "starting", message: startMessage,
      startedAt: new Date().toISOString(),
    }, { status: queued.type === "transcript" ? "generating" : "rendering", lastError: null });
    console.log(`[job:${queued.id}] started ${queued.type}`);
    const runtime = await modelRuntimeSnapshot(context);
    if (Object.hasOwn(queued, "chatgptAccountId") && queued.chatgptAccountId !== runtime.chatgptAccountId) throw new ChatGptError("chatgpt_account_changed", { status: 409 });
    const result = queued.type === "transcript" ? await runTranscriptJob(context, queued, runtime) : await runTtsJob(context, queued, runtime);
    const episode = await updateJob(context, queued, {
      status: "completed", phase: "complete",
      message: result?.warning || (queued.type === "transcript" ? "Transcript ready." : "MP3 ready."), error: null,
      finishedAt: new Date().toISOString(),
    });
    console.log(`[job:${queued.id}] completed ${queued.type} for ${episode.id}`);
    if (queued.type === "transcript" && queued.autoTts) {
      try {
        await ensureFfmpeg(context);
        await serializeMutation(context, () => enqueueJob(null, context, queued.episodeId, "tts"));
      } catch (error) {
        try {
          await updateJob(context, queued, {
            message: `Transcript ready, but automatic TTS could not start: ${error.message || String(error)}`,
            error: error.message || String(error),
          });
        } catch (saveError) {
          console.error(`[job:${queued.id}] failed to persist automatic TTS warning: ${saveError.message || saveError}`);
        }
      }
    }
  } catch (error) {
    const message = error.message || String(error);
    try {
      const episodeChanges = { status: "failed", lastError: message };
      if (queued.type === "tts") episodeChanges.audioReady = queued.previousAudioReady === true;
      await updateJob(context, queued, {
        status: "failed", phase: "failed", message, error: message, finishedAt: new Date().toISOString(),
      }, episodeChanges);
    } catch (saveError) {
      console.error(`[job:${queued.id}] failed to persist error: ${saveError.message || saveError}`);
    }
    console.error(`[job:${queued.id}] failed ${queued.type}: ${message}`);
  } finally {
    context.activeJobId = null;
    if (context.queue.length > 0) queueMicrotask(() => void drainQueue(context));
  }
}

async function updateJob(context, queued, jobChanges, episodeChanges = {}) {
  return serializeMutation(context, async () => {
    const episode = await loadEpisode(context.paths, queued.episodeId, false);
    if (episode.job?.id !== queued.id) throw new Error("Episode job state changed unexpectedly.");
    const updated = await updateEpisode(context.paths, episode, {
      ...(typeof episodeChanges === "function" ? episodeChanges(episode) : episodeChanges),
      job: { ...episode.job, ...jobChanges, updatedAt: new Date().toISOString() },
    });
    rememberJob(context, updated.job);
    return updated;
  });
}

async function runTranscriptJob(context, queued, runtime) {
  const episode = await loadEpisode(context.paths, queued.episodeId, false);
  const { episodeProfile, speakerProfile } = await resolveEpisodeProfiles(context.paths, episode);
  const language = resolveLanguage(runtime, episodeProfile.language);
  const knowledge = episode.knowledgeBaseId ? await readFile(join(context.paths.knowledge, `${episode.knowledgeBaseId}.md`), "utf8") : "";

  await updateJob(context, queued, { phase: "outline", completed: 0, message: "Generating outline…" });
  const outline = await generateOutline(runtime, knowledge, episode, episodeProfile, speakerProfile, language);
  await updateJob(context, queued, { phase: "transcript", completed: 1, message: "Writing transcript…" });
  const transcriptJson = await generateTranscript(runtime, knowledge, outline, episode, episodeProfile, speakerProfile, language);
  const transcript = transcriptToMarkdown(transcriptJson);
  const parsed = parseTranscript(transcript, speakerProfile.speakers, episodeProfile.numSegments);
  validateTranscriptCues(runtime, parsed.segments, speakerProfile, language);
  const transcriptWords = transcriptWordCount(parsed.segments, language.id);
  const minimumWords = Math.round(episodeProfile.targetMinutes * TRANSCRIPT_MINIMUM_WORDS_PER_MINUTE);
  const lengthWarning = transcriptWords < minimumWords
    ? `Transcript is too short: ${transcriptWords} words. Recommended minimum is ${minimumWords} words for ${episodeProfile.targetMinutes} minutes. Rendering may fail duration validation.`
    : "";
  const warning = [parsed.warning, lengthWarning].filter(Boolean).join(" ");

  await updateJob(context, queued, { phase: "saving", completed: 2, message: "Saving transcript…" });
  await replaceTextThenCommit(join(episodeDir(context.paths, episode.id), "transcript.md"), transcript, () =>
    updateJob(context, queued, { completed: 3 }, (current) => ({
      ...(current.name.trim() === "New episode" ? { name: transcriptJson.title.trim() } : {}),
      status: "transcript_ready", audioReady: false,
      transcriptWords,
      lastError: null,
    })));
  return { warning };
}

export async function previewVoice(req, res, context) {
  const runtime = await modelRuntimeSnapshot(context);
  const body = await readJsonBody(req);
  let episodeProfile;
  let profile;
  if (body.episodeId) {
    ({ episodeProfile, speakerProfile: profile } = await resolveEpisodeProfiles(context.paths, await loadEpisode(context.paths, String(body.episodeId), false)));
  } else {
    const profiles = await readJson(context.paths.profiles);
    profile = profiles.speakerProfiles.find((item) => item.id === body.speakerProfileId);
    episodeProfile = profiles.episodeProfiles.find((item) => item.id === body.episodeProfileId);
  }
  if (!profile) throw badRequest("Speaker profile does not exist.");
  if (!episodeProfile) throw badRequest("Episode Format does not exist.");
  if (String(body.languageOverride || "").trim()) throw badRequest("TTS language is defined by the Episode Format.");
  const language = resolveLanguage(runtime, episodeProfile.language);
  const speaker = profile.speakers[Number(body.speakerIndex)];
  if (!speaker) throw badRequest("Speaker does not exist.");
  const model = speaker.ttsModelOverride || profile.voiceModel;
  const languageError = modelLanguageError(runtime, model, language);
  if (languageError) throw badRequest(`${speaker.name}: ${languageError}`);
  const text = String(body.text || "").trim();
  if (!text || text.length > 600) throw badRequest("Preview text must contain 1 to 600 characters.");
  await ensureFfmpeg(context);
  const audio = await synthesizeTurn(runtime, profile, speaker, text, String(body.cue || "warm and conversational"), language);
  const bytes = await normalizePreviewAudio(audio, speaker.name, model);
  res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": bytes.length, "Cache-Control": "no-store" });
  res.end(bytes);
}

async function runTtsJob(context, queued, runtime) {
  const episode = await loadEpisode(context.paths, queued.episodeId, true);
  const { episodeProfile, speakerProfile } = await resolveEpisodeProfiles(context.paths, episode);
  const language = resolveLanguage(runtime, episodeProfile.language);
  if (!episode.transcript) throw badRequest("Save or generate transcript before rendering.");
  const parsed = parseTranscript(episode.transcript, speakerProfile.speakers, episodeProfile.numSegments);
  const turns = parsed.segments.flatMap((segment, segmentIndex) => segment.turns.map((turn, turnIndex) => ({
    turn,
    segmentIndex,
    segmentEnd: turnIndex === segment.turns.length - 1,
  })));
  const clipsDir = join(episodeDir(context.paths, episode.id), "clips");
  await mkdir(clipsDir, { recursive: true });

  const clipPaths = [];
  const usedKeys = new Set();
  for (let index = 0; index < turns.length; index += 1) {
    const { turn } = turns[index];
    const speaker = speakerProfile.speakers.find((item) => item.name === turn.speaker);
    const model = speaker.ttsModelOverride || speakerProfile.voiceModel;
    const spokenText = spokenTextForModel(runtime, model, turn.text, language);
    const key = clipCacheKey(turnClipDescriptor(runtime, speakerProfile, speaker, { ...turn, text: spokenText }, language));
    usedKeys.add(key);
    const clipPath = join(clipsDir, `${key}.wav`);
    let cached = true;
    if (!(await isNormalizedWav(clipPath))) {
      cached = false;
      const audio = await synthesizeTurn(runtime, speakerProfile, speaker, spokenText, turn.delivery, language);
      await writeAudioAsWav(audio, clipPath);
    }
    clipPaths.push(clipPath);
    const gap = pauseAfterTurnSeconds(turns, index);
    if (gap > 0) {
      const silence = await ensureSilenceWav(clipsDir, gap);
      usedKeys.add(silence.key);
      clipPaths.push(silence.path);
    }
    await updateJob(context, queued, {
      phase: "synthesizing",
      completed: index + 1,
      message: `${index + 1}/${turns.length} — ${turn.speaker}${cached ? " (cached)" : ""}`,
    });
  }

  await updateJob(context, queued, { phase: "combining", message: "Combining MP3…" });
  const targetSeconds = episodeProfile.targetMinutes * 60;
  const mp3Result = await assembleMp3(clipPaths, episodeDir(context.paths, episode.id), targetSeconds * 0.9, episodeProfile.targetMinutes);
  await pruneClipCache(clipsDir, usedKeys);
  await updateJob(context, queued, {}, {
    status: "ready",
    audioReady: true,
    lastError: null,
  });
  return { warning: mp3Result?.warning || "" };
}

export function clipCacheKey(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pauseAfterTurnSeconds(turns, index) {
  if (index === turns.length - 1) return 0;
  if (turns[index].segmentEnd) return 1.2;
  const cue = String(turns[index].turn.delivery || "").toLowerCase();
  if (cue.includes("immediate") || cue.includes("quick interruption")) return 0.05;
  if (cue.includes("overlap") || cue.includes("interrupt")) return 0.1;
  if (cue.includes("quick")) return 0.25;
  if (cue.includes("beat") || cue.includes("pause")) return 0.7;
  if (cue.includes("reflective") || cue.includes("emotional")) return 0.9;
  return 0.45;
}

export async function writeAudioAsWav(audio, outputPath) {
  if (audio.chunks) {
    const chunkPaths = audio.chunks.map((_, index) => `${outputPath}.chunk-${index}.wav`);
    const listPath = `${outputPath}.concat.txt`;
    const temporaryWav = `${outputPath}.tmp.wav`;
    try {
      for (let index = 0; index < audio.chunks.length; index += 1) await writeAudioAsWav(audio.chunks[index], chunkPaths[index]);
      const list = chunkPaths.map((path) => `file '${resolve(path).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n") + "\n";
      await writeFile(listPath, list, "utf8");
      await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c:a", "pcm_s16le", temporaryWav]);
      if (!(await isNormalizedWav(temporaryWav))) throw new Error("Combined TTS chunks are not normalized WAV audio.");
      if ((await stat(temporaryWav)).size > MAX_AUDIO_RESPONSE_BYTES) throw new Error(`Combined TTS turn exceeds ${MAX_AUDIO_RESPONSE_BYTES} byte limit.`);
      await rename(temporaryWav, outputPath);
    } finally {
      for (const path of [...chunkPaths, listPath, temporaryWav]) await rm(path, { force: true });
    }
    return;
  }
  const temporaryWav = `${outputPath}.tmp.wav`;
  const source = `${outputPath}.source.${audio.extension}`;
  await rm(temporaryWav, { force: true });
  if (audio.extension === "wav") assertWav(audio.bytes);
  await writeFile(source, audio.bytes);
  try {
    await runProcess("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-i", source,
      "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", temporaryWav,
    ]);
    if (!(await isNormalizedWav(temporaryWav))) throw new Error("TTS returned invalid or empty WAV audio. At least one complete audio frame is required.");
    if ((await stat(temporaryWav)).size > MAX_AUDIO_RESPONSE_BYTES) throw new Error(`Normalized TTS turn exceeds ${MAX_AUDIO_RESPONSE_BYTES} byte limit.`);
    await rename(temporaryWav, outputPath);
  } catch (error) {
    await rm(temporaryWav, { force: true });
    throw error;
  } finally {
    await rm(source, { force: true });
  }
}

async function normalizePreviewAudio(audio, speakerName, model) {
  const outputPath = join(tmpdir(), `.pod-god-preview-${randomUUID()}.wav`);
  try {
    await writeAudioAsWav(audio, outputPath);
    const { size } = await stat(outputPath);
    if (size > MAX_AUDIO_RESPONSE_BYTES) throw new Error(`normalized audio exceeds ${MAX_AUDIO_RESPONSE_BYTES} byte limit`);
    return await readFile(outputPath);
  } catch (error) {
    console.error(`[preview:${model}] audio normalization failed: ${error.message || error}`);
    throw httpError(502, `${speakerName}: TTS model "${model}" returned unsupported or invalid audio (${audio.contentType || "unknown content type"}). Check the provider response format.`);
  } finally {
    await rm(outputPath, { force: true });
  }
}

async function ensureSilenceWav(directory, seconds) {
  const milliseconds = Math.round(seconds * 1000);
  const key = `silence-${milliseconds}ms`;
  const path = join(directory, `${key}.wav`);
  if (await isNormalizedWav(path)) return { key, path };
  await runProcess("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
    "-t", String(seconds), "-c:a", "pcm_s16le", path,
  ]);
  return { key, path };
}

async function mediaDurationSeconds(path) {
  const output = await runProcess("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path,
  ]);
  const seconds = Number(output.trim());
  if (!Number.isFinite(seconds)) throw new Error(`Cannot read audio duration for ${path}.`);
  return seconds;
}

async function assembleMp3(clipPaths, directory, minimumSeconds, targetMinutes) {
  if (clipPaths.length === 0) throw new Error("Transcript has no audio turns.");
  const listPath = join(directory, "concat.txt");
  const output = join(directory, "episode.mp3");
  const temporary = join(directory, "episode.tmp.mp3");
  const list = clipPaths.map((path) => `file '${resolve(path).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n") + "\n";
  await writeFile(listPath, list, "utf8");
  await rm(temporary, { force: true });
  try {
    await runProcess("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-codec:a", "libmp3lame", "-b:a", "128k", temporary]);
    const actualSeconds = await mediaDurationSeconds(temporary);
    await rename(temporary, output);
    if (actualSeconds < minimumSeconds) {
      return { warning: `Rendered audio too short: ${(actualSeconds / 60).toFixed(1)} min. Target: ${targetMinutes} min. Regenerate a longer transcript.` };
    }
    return {};
  } finally {
    await rm(listPath, { force: true });
    await rm(temporary, { force: true });
  }
}

export async function runProcess(command, args, timeoutMs = FFMPEG_TIMEOUT_MS) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // Not spawn({ timeout }): a spawn that fails with ENOENT never emits "exit", so Node keeps its
    // own timer armed for the whole timeout and pins the event loop.
    const timer = setTimeout(() => { timedOut = true; child.kill(PROCESS_KILL_SIGNAL); }, timeoutMs).unref();
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(stdout);
      else if (timedOut) reject(new Error(`${command} timed out after ${timeoutMs} ms and was stopped with ${signal || PROCESS_KILL_SIGNAL}: ${stderr.trim()}`));
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}
