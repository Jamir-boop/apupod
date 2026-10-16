import { randomUUID } from "node:crypto";
import {
  mkdir,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { badRequest, conflict, notFound, oneLine, normalizeDelivery, validateId, requireText, validateNumber, validateOptionalNumber, validateOptionalInteger, assertSafeId, readJsonBody, sendJson } from "./util.mjs";
import { TTS_MODELS, TEXT_MODELS, LANGUAGE_OPTIONS, normalizeEffort, resolveLanguage } from "./providers/catalog.mjs";
import { CHATTERBOX_DEFAULTS, ELEVENLABS_DEFAULTS, MIMO_INSTRUCTION_PRESETS, CHATTERBOX_TAGS, TTS_CUE_RE, ELEVEN_BREAK_RE, ELEVEN_BREAK_ANY_RE, TTS_DOCS, speakerAccent, ttsCueCapability, callTextModel, chatterboxSettings, mimoTtsSettings, assertElevenLabsMarkup, elevenLabsSettings, parseChatJson } from "./providers/generate.mjs";
import { isActiveJob, planPath, planIndexItem, listPlans, loadPlan, savePlan, nextUpdatedAt, profileRevision, resolveEpisodeProfiles, listEpisodes, loadEpisode, updateEpisode, episodeDir, readJson, writeJsonAtomic, writeTextAtomic, exists } from "./store.mjs";
import { collectModelReferences } from "./config.mjs";

const TRANSCRIPT_TARGET_WORDS_PER_MINUTE = 140;
export const TRANSCRIPT_MINIMUM_WORDS_PER_MINUTE = 125;

export async function deleteEpisodeRequest(res, context, id) {
  const episode = await loadEpisode(context.paths, id, false);
  if (isActiveJob(episode.job)) throw conflict("Wait for the episode's active job to finish before deleting it.");
  // ponytail: linear scan over all plans, index it if plans ever number in the hundreds
  const updates = [];
  for (const entry of await listPlans(context.paths)) {
    const plan = await loadPlan(context.paths, entry.id);
    if (!plan.episodes.some((item) => item.createdEpisodeId === id)) continue;
    updates.push({ before: plan, after: { ...plan, episodes: plan.episodes.filter((item) => item.createdEpisodeId !== id), updatedAt: new Date().toISOString() } });
  }
  const directory = episodeDir(context.paths, id);
  const staged = `${directory}.deleting`;
  if (await exists(staged)) throw conflict("An interrupted deletion must be cleaned up by restarting the server.");
  // ponytail: no cross-file journal; a crash before staging leaves the intact episode retryable but may detach plan links.
  const applied = [];
  try {
    for (const update of updates) {
      await savePlan(context.paths, update.after);
      applied.push(update);
    }
    await rename(directory, staged);
  } catch (error) {
    const rollbackErrors = [];
    for (const update of applied.reverse()) await savePlan(context.paths, update.before, { restore: true }).catch((rollbackError) => rollbackErrors.push(rollbackError));
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "Episode deletion failed and could not be fully rolled back.");
    throw error;
  }
  try {
    await rm(staged, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[episode:${id}] deletion committed; deferred cleanup failed: ${error.message || error}`);
  }
  sendJson(res, 200, { id, deleted: true });
}

export async function deleteSpeakerProfileRequest(res, context, id) {
  const { paths } = context;
  const profiles = await readJson(paths.profiles);
  const target = profiles.speakerProfiles.find((item) => item.id === id);
  if (!target) throw notFound("Host profile not found.");
  if (profiles.speakerProfiles.length === 1) throw badRequest("At least one host profile must remain.");
  const fallback = profiles.speakerProfiles.find((item) => item.id !== id);
  const beforeRevisions = {
    speakerProfiles: Object.fromEntries(profiles.speakerProfiles.filter((item) => item.id !== id).map((item) => [item.id, profileRevision(item)])),
    episodeProfiles: Object.fromEntries(profiles.episodeProfiles.map((item) => [item.id, profileRevision(item)])),
  };
  const nextProfiles = {
    ...profiles,
    speakerProfiles: profiles.speakerProfiles.filter((item) => item.id !== id),
    episodeProfiles: profiles.episodeProfiles.map((item) => item.speakerProfileId === id ? { ...item, speakerProfileId: fallback.id } : item),
    updatedAt: nextUpdatedAt(profiles.updatedAt),
  };
  applyProfileRevisions(nextProfiles, profiles);
  const planIndex = await readJson(paths.plansIndex);
  const plans = [];
  for (const entry of planIndex.filter((item) => item.speakerProfileId === id)) plans.push(await loadPlan(paths, entry.id));
  const changedPlans = plans.map((plan) => ({ ...plan, speakerProfileId: fallback.id, updatedAt: nextUpdatedAt(plan.updatedAt) }));
  const nextPlanIndex = planIndex.map((item) => item.speakerProfileId === id ? planIndexItem(changedPlans.find((plan) => plan.id === item.id)) : item);
  const writes = [
    { path: paths.profiles, before: profiles, after: nextProfiles },
    { path: paths.plansIndex, before: planIndex, after: nextPlanIndex },
    ...plans.map((plan, index) => ({ path: planPath(paths, plan.id), before: plan, after: changedPlans[index] })),
  ];
  const applied = [];
  try {
    for (const write of writes) {
      await writeJsonAtomic(write.path, write.after);
      applied.push(write);
    }
  } catch (error) {
    for (const write of applied.reverse()) await writeJsonAtomic(write.path, write.before).catch(() => {});
    throw error;
  }
  sendJson(res, 200, { id, deleted: true, fallbackId: fallback.id, repointedPlans: plans.length, profiles: nextProfiles, previousProfilesUpdatedAt: profiles.updatedAt ?? null, beforeRevisions });
}

export function derivedNumSegments(targetMinutes) {
  return Math.min(20, Math.max(3, Math.round(targetMinutes / 3.5)));
}

export async function saveEpisodeRequest(req, res, paths) {
  const body = await readJsonBody(req);
  const result = await saveEpisodeFromBody(paths, body);
  sendJson(res, result.statusCode, { ...result.episode, warning: result.warning });
}

export async function saveEpisodeFromBody(paths, body) {
  const profiles = await readJson(paths.profiles);
  const knowledge = await readJson(paths.knowledgeIndex);
  const name = String(body.name || "").trim();
  const episodeProfileId = String(body.episodeProfileId || "").trim();
  const knowledgeBaseId = String(body.knowledgeBaseId || "").trim();
  const transcriptPromptGuidance = body.transcriptPromptGuidance == null ? null : String(body.transcriptPromptGuidance);
  if (!name) throw badRequest("Episode name is required.");
  if (transcriptPromptGuidance != null && transcriptPromptGuidance.length > 50_000) throw badRequest("Transcript prompt guidance must contain at most 50000 characters.");
  const episodeProfile = profiles.episodeProfiles.find((item) => item.id === episodeProfileId);
  if (!episodeProfile) throw badRequest("Episode Format does not exist.");
  if (knowledgeBaseId && !knowledge.some((item) => item.id === knowledgeBaseId)) throw badRequest("Knowledge base does not exist.");

  const id = body.id ? String(body.id) : randomUUID();
  assertSafeId(id);
  const current = body.id ? await loadEpisode(paths, id, true) : {};
  if (isActiveJob(current.job)) throw conflict("Wait for the active episode job to finish.");
  const speakerProfileId = String((body.speakerProfileId === undefined ? current.speakerProfileId : body.speakerProfileId) || "").trim();
  const speakerProfile = profiles.speakerProfiles.find((item) => item.id === (speakerProfileId || episodeProfile.speakerProfileId));
  if (!speakerProfile) throw badRequest("Speaker profile does not exist.");
  const derived = await reconcileEpisodeContent(paths, current, episodeProfile, speakerProfile);
  const now = new Date().toISOString();
  const episode = {
    id,
    name,
    episodeProfileId,
    speakerProfileId,
    episodeProfile: structuredClone(episodeProfile),
    speakerProfile: structuredClone(speakerProfile),
    knowledgeBaseId,
    additionalInstructions: String(body.additionalInstructions || ""),
    transcriptPromptGuidance: transcriptPromptGuidance ?? current.transcriptPromptGuidance ?? "",
    status: derived.status,
    createdAt: current.createdAt || now,
    updatedAt: now,
    audioReady: derived.audioReady,
    transcriptWords: derived.transcriptWords,
    job: current.job,
    lastError: null,
  };
  await mkdir(episodeDir(paths, id), { recursive: true });
  await writeJsonAtomic(join(episodeDir(paths, id), "episode.json"), episode);
  return { statusCode: current.id ? 200 : 201, episode, warning: derived.warning };
}

export async function getEpisodeResponse(res, paths, id) {
  const episode = await loadEpisode(paths, id, true);
  sendJson(res, 200, episode);
}

export async function renameEpisodeRequest(req, res, paths, id) {
  const episode = await loadEpisode(paths, id, true);
  const body = await readJsonBody(req);
  const name = oneLine(body.name || "");
  if (!name) throw badRequest("Episode name is required.");
  await updateEpisode(paths, episode, { name });
  sendJson(res, 200, await loadEpisode(paths, id, true));
}

export async function applyLatestProfilesRequest(res, paths, id) {
  const episode = await loadEpisode(paths, id, true);
  if (isActiveJob(episode.job)) throw conflict("Wait for the active episode job to finish.");

  const profiles = await readJson(paths.profiles);
  const episodeProfile = profiles.episodeProfiles.find((item) => item.id === episode.episodeProfileId);
  if (!episodeProfile) throw badRequest("Episode Format does not exist.");
  const speakerProfile = profiles.speakerProfiles.find((item) => item.id === (episode.speakerProfileId || episodeProfile.speakerProfileId));
  if (!speakerProfile) throw badRequest("Speaker profile does not exist.");

  const changed = JSON.stringify(episode.episodeProfile) !== JSON.stringify(episodeProfile)
    || JSON.stringify(episode.speakerProfile) !== JSON.stringify(speakerProfile);
  if (!changed) return sendJson(res, 200, { changed: false, episode, warning: "" });

  const { warning, ...derived } = await reconcileEpisodeContent(paths, episode, episodeProfile, speakerProfile, { strictTranscript: true });
  await updateEpisode(paths, episode, {
    episodeProfile: structuredClone(episodeProfile),
    speakerProfile: structuredClone(speakerProfile),
    ...derived,
    lastError: null,
  });
  return sendJson(res, 200, { changed: true, episode: await loadEpisode(paths, id, true), warning });
}

async function reconcileEpisodeContent(paths, episode, episodeProfile, speakerProfile, { strictTranscript = false } = {}) {
  const transcript = String(episode.transcript || "");
  let parsed = null;
  if (transcript.trim()) {
    // ponytail: on host changes a transcript written for the previous hosts no longer parses — treat it
    // as a stale script (episode reverts to draft, file stays on disk); "Apply latest profiles" stays strict.
    try { parsed = parseTranscript(transcript, speakerProfile.speakers, episodeProfile.numSegments); }
    catch (error) { if (strictTranscript) throw error; parsed = null; }
  }
  const ttsChanged = Boolean(episode.episodeProfile && episode.speakerProfile)
    && ttsProfileSignature(episode.episodeProfile, episode.speakerProfile) !== ttsProfileSignature(episodeProfile, speakerProfile);
  const audioReady = Boolean(episode.audioReady && !ttsChanged && await exists(join(episodeDir(paths, episode.id), "episode.mp3")));
  return {
    status: parsed ? audioReady ? "ready" : "transcript_ready" : "draft",
    audioReady,
    transcriptWords: parsed ? transcriptWordCount(parsed.segments, episodeProfile.language) : undefined,
    warning: parsed?.warning || "",
  };
}

function ttsProfileSignature(episodeProfile, speakerProfile) {
  return JSON.stringify({
    language: episodeProfile.language,
    voiceModel: speakerProfile.voiceModel,
    speakers: speakerProfile.speakers.map((speaker) => {
      const model = speaker.ttsModelOverride || speakerProfile.voiceModel;
      return {
        name: speaker.name,
        voiceId: speaker.voiceId,
        ...(model === "eleven_v4" ? {} : { style: speaker.style, accent: speaker.accent || "" }),
        ttsModelOverride: speaker.ttsModelOverride || "",
        ...(model.startsWith("compat:chatterbox:") ? chatterboxSettings(speaker) : {}),
        ...(model === "mimo-v2.5-tts" ? { mimo: mimoTtsSettings(speaker) } : {}),
        ...(model.startsWith("eleven") ? { elevenlabs: elevenLabsSettings(speaker, model) } : {}),
      };
    }),
  });
}

function transcriptPromptRules(context, speakerProfile, episodeProfile, language) {
  const groups = new Map();
  for (const speaker of speakerProfile.speakers) {
    const model = speaker.ttsModelOverride || speakerProfile.voiceModel;
    const capability = ttsCueCapability(context, model, language);
    const key = `${capability.provider}:${model}:${capability.cueMode}`;
    if (!groups.has(key)) groups.set(key, { ...capability, model, speakers: [] });
    groups.get(key).speakers.push(speaker.name);
  }

  const sections = [...groups.values()].map((group) => {
    const names = group.speakers.join(", ");
    if (group.provider === "mimo") {
      return `MiMo (${names}, ${group.model}): delivery is a concise natural-language instruction. Spoken text may use sparse custom square-bracket audio/style cues such as [sigh], [pause], [chuckle], or [whisper].`;
    }
    if (group.provider === "elevenlabs" && group.cueMode === "tags") {
      return `ElevenLabs (${names}, ${group.model}): delivery is a short natural-language performance direction. Spoken text may use sparse audio tags such as [laughs], [sighs], [whispers], [curious], or [excited]. Do not use SSML break tags or other SSML markup; use punctuation for pauses.`;
    }
    if (group.provider === "elevenlabs") {
      return `ElevenLabs (${names}, ${group.model}): do not use square-bracket audio tags. For an intentional pause, use sparse <break time="0.5s" /> markup with a duration no longer than 3 seconds.`;
    }
    if (group.provider === "chatterbox" && group.cueMode === "tags") {
      return `Chatterbox (${names}, ${group.model}, English Turbo): spoken text may use only these supported tags: ${CHATTERBOX_TAGS.map((tag) => `[${tag}]`).join(", ")}.`;
    }
    if (group.provider === "chatterbox") {
      return `Chatterbox (${names}, ${group.model}): this model/language does not support inline tags. Use delivery metadata and profile tuning only.`;
    }
    return `Generic TTS (${names}, ${group.model}): do not insert inline cue markup. Use delivery metadata only.`;
  });

  const directions = speakerProfile.speakers
    .map((speaker) => `- ${speaker.name}: style=${speaker.style}; personality=${speaker.personality}`)
    .join("\n");
  return `TTS-AWARE DIALOGUE RULES:
Follow each speaker profile and the episode profile when deciding cue frequency and intensity. If profiles do not call for expressiveness, keep cues restrained. Most turns need no inline cue. Delivery is non-spoken metadata.

${sections.join("\n\n")}

Episode direction:
${episodeProfile.description}

Speaker direction:
${directions}`;
}

function transcriptPromptState(context, speakerProfile, episodeProfile, language, guidance = "") {
  const lockedPrompt = transcriptPromptRules(context, speakerProfile, episodeProfile, language);
  const customGuidance = String(guidance || "").trim();
  return {
    lockedPrompt,
    customGuidance,
    effectivePrompt: customGuidance ? `${lockedPrompt}\n\nEPISODE-SPECIFIC TRANSCRIPT GUIDANCE:\n${customGuidance}` : lockedPrompt,
    capabilities: speakerProfile.speakers.map((speaker) => {
      const model = speaker.ttsModelOverride || speakerProfile.voiceModel;
      const capability = ttsCueCapability(context, model, language);
      return { speaker: speaker.name, model, provider: capability.provider, cueMode: capability.cueMode };
    }),
    docs: TTS_DOCS,
  };
}

function cueNames(value) {
  return [...String(value).matchAll(new RegExp(TTS_CUE_RE.source, "g"))]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

export function validateTranscriptCues(context, segments, speakerProfile, language) {
  for (const segment of segments) {
    for (const turn of segment.turns) {
      if (turn.delivery.length > 200) throw badRequest(`Transcript delivery cue for ${turn.speaker} must contain at most 200 characters.`);
      const speaker = speakerProfile.speakers.find((item) => item.name === turn.speaker);
      const model = speaker.ttsModelOverride || speakerProfile.voiceModel;
      const capability = ttsCueCapability(context, model, language);
      assertElevenLabsMarkup(model, turn.text);
      const cues = cueNames(turn.text);
      const breaks = [...String(turn.text).matchAll(new RegExp(ELEVEN_BREAK_RE.source, "gi"))];
      const breakMarkup = String(turn.text).match(new RegExp(ELEVEN_BREAK_ANY_RE.source, "gi")) || [];

      if (cues.length && !capability.squareTags) {
        throw badRequest(`${turn.speaker} uses ${model}, which does not support square-bracket TTS cues.`);
      }
      if (capability.provider === "chatterbox") {
        const invalid = cues.find((cue) => !CHATTERBOX_TAGS.includes(cue.toLowerCase()));
        if (invalid) throw badRequest(`${turn.speaker} uses unsupported Chatterbox cue "[${invalid}]".`);
      }
      if (breakMarkup.length && !capability.breaks) {
        throw badRequest(`${turn.speaker} uses ${model}, which does not support SSML break tags.`);
      }
      if (capability.breaks && (breakMarkup.length !== breaks.length || breaks.some((match) => Number(match[1]) > 3))) {
        throw badRequest(`${turn.speaker} uses an invalid ElevenLabs break tag; use <break time="0.5s" /> with at most 3 seconds.`);
      }
    }
  }
  return true;
}

export async function resolveTranscriptPromptRequest(req, res, context) {
  const body = await readJsonBody(req);
  const episodeId = String(body.episodeId || "").trim();
  const episodeProfileId = String(body.episodeProfileId || "").trim();
  const speakerProfileId = String(body.speakerProfileId || "").trim();
  const guidance = String(body.guidance || "");
  if (!episodeId && !episodeProfileId) throw badRequest("episodeId or episodeProfileId is required.");
  if (guidance.length > 50_000) throw badRequest("Transcript prompt guidance must contain at most 50000 characters.");
  let episodeProfile;
  let speakerProfile;
  if (episodeId) {
    assertSafeId(episodeId);
    ({ episodeProfile, speakerProfile } = await resolveEpisodeProfiles(context.paths, await loadEpisode(context.paths, episodeId, false)));
  } else {
    const profiles = await readJson(context.paths.profiles);
    episodeProfile = profiles.episodeProfiles.find((item) => item.id === episodeProfileId);
    if (!episodeProfile) throw badRequest("Episode Format does not exist.");
    speakerProfile = profiles.speakerProfiles.find((item) => item.id === (speakerProfileId || episodeProfile.speakerProfileId));
    if (!speakerProfile) throw badRequest("Speaker profile does not exist.");
  }
  const language = resolveLanguage(context, episodeProfile.language);
  sendJson(res, 200, transcriptPromptState(context, speakerProfile, episodeProfile, language, guidance));
}

export async function saveTranscriptRequest(req, res, context, id) {
  const { paths } = context;
  const episode = await loadEpisode(paths, id, false);
  if (isActiveJob(episode.job)) throw conflict("Wait for the active episode job to finish.");
  const body = await readJsonBody(req);
  const transcript = String(body.transcript || "");
  const { episodeProfile, speakerProfile } = await resolveEpisodeProfiles(paths, episode);
  const parsed = parseTranscript(transcript, speakerProfile.speakers, episodeProfile.numSegments);
  validateTranscriptCues(context, parsed.segments, speakerProfile, resolveLanguage(context, episodeProfile.language));
  const updated = {
    ...episode,
    status: "transcript_ready",
    audioReady: false,
    transcriptWords: transcriptWordCount(parsed.segments, episodeProfile.language),
    updatedAt: new Date().toISOString(),
    lastError: null,
  };
  const metadataPath = join(episodeDir(paths, id), "episode.json");
  // ponytail: metadata first hides stale audio; a crash may leave the previous transcript visible until the user retries.
  await writeJsonAtomic(metadataPath, updated);
  try {
    await writeTextAtomic(join(episodeDir(paths, id), "transcript.md"), transcript.trim() + "\n");
  } catch (error) {
    try {
      await writeJsonAtomic(metadataPath, episode);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Transcript save failed and episode metadata could not be restored.");
    }
    throw error;
  }
  sendJson(res, 200, { ...updated, transcript: transcript.trim() + "\n", warning: parsed.warning });
}

export async function generateOutline(context, knowledge, episode, profile, speakers, language) {
  const schema = `{"segments":[{"number":1,"title":"string","purpose":"string","points":["string"],"closingBeat":"string"}]}`;
  const source = knowledge
    ? `KNOWLEDGE BASE START\n${knowledge}\nKNOWLEDGE BASE END`
    : "No knowledge base was supplied. Use broadly established model knowledge, avoid unsupported precision, and never invent quotations.";
  const prompt = `${generationContext(episode, profile, speakers, language)}

Create exactly ${profile.numSegments} segments for a ${profile.targetMinutes}-minute podcast in ${language.name}. Return JSON only using this shape: ${schema}

${source}`;
  const data = await callTextModel({
    context,
    model: profile.outlineModel,
    effort: profile.outlineEffort,
    system: `You create grounded podcast outlines in ${language.name}. Return JSON only. Never invent quotations. ${knowledge ? "Use only the supplied knowledge base for factual claims." : "Use reliable general knowledge and avoid unsupported precision."}`,
    prompt,
    maxTokens: 4_000,
    temperature: 0.8,
    topP: 0.95,
  });
  const value = parseChatJson(data, "outline");
  validateOutline(value, profile.numSegments);
  return value;
}

export async function generateTranscript(context, knowledge, outline, episode, profile, speakerProfile, language) {
  const speakerNames = speakerProfile.speakers.map((speaker) => speaker.name);
  const formatRule = transcriptSpeakerRule(speakerNames);
  const schema = `{"title":"string","segments":[{"number":1,"title":"string","turns":[{"speaker":"${speakerNames.join("|")}","delivery":"short acting direction","text":"spoken ${language.name} text"}]}]}`;
  const targetWords = Math.round(profile.targetMinutes * TRANSCRIPT_TARGET_WORDS_PER_MINUTE);
  const minimumWords = Math.round(profile.targetMinutes * TRANSCRIPT_MINIMUM_WORDS_PER_MINUTE);
  const promptState = transcriptPromptState(context, speakerProfile, profile, language, episode.transcriptPromptGuidance);
  const source = knowledge
    ? `KNOWLEDGE BASE START\n${knowledge}\nKNOWLEDGE BASE END`
    : "No knowledge base was supplied. Use broadly established model knowledge, avoid unsupported precision, and never invent quotations.";
  const prompt = `${generationContext(episode, profile, speakerProfile, language)}

Approved outline:
${JSON.stringify(outline)}

Write a natural transcript in ${language.name} of about ${targetWords} words and never fewer than ${minimumWords} spoken words. Return JSON only using this shape: ${schema}
Use exactly ${profile.numSegments} segments. Every turn must use one configured speaker name. ${formatRule} Keep each turn concise enough for spoken dialogue. End with exactly three practical lessons. Paraphrase source. Never invent or reproduce long quotations.

${promptState.effectivePrompt}

${source}`;
  const data = await callTextModel({
    context,
    model: profile.transcriptModel,
    effort: profile.transcriptEffort,
    system: `You write grounded, emotionally intelligent podcast dialogue in natural ${language.name}. Return JSON only.`,
    prompt,
    maxTokens: 16_000,
    temperature: 0.9,
    topP: 0.95,
  });
  const value = parseChatJson(data, "transcript");
  validateTranscriptJson(value, profile.numSegments, speakerNames);
  return value;
}

function generationContext(episode, episodeProfile, speakerProfile, language) {
  const speakerText = speakerProfile.speakers.map((speaker) =>
    `${speaker.name}\nBackstory: ${speaker.backstory}\nPersonality: ${speaker.personality}\nAccent: ${speakerAccent(speaker, language) || "language default"}`
  ).join("\n\n");
  return `Language: ${language.name} (${language.id}). Episode: ${episode.name}
Target duration: ${episodeProfile.targetMinutes} minutes.

Episode Format:
${episodeProfile.description}

Additional episode instructions:
${episode.additionalInstructions || "None."}

Speaker profile rules:
${speakerProfile.instructions}

Speakers:
${speakerText}

NON-NEGOTIABLE LANGUAGE OVERRIDE:
Write every title, heading, narration, and spoken turn in ${language.name}. Ignore any conflicting language instruction in the knowledge base, briefing, speaker profile, or additional instructions. Keep each speaker's vocabulary and register natural for the requested accent without caricature.`;
}

export function validateProfileData(value, models = {
  ttsModels: new Set(TTS_MODELS), textModels: new Set(TEXT_MODELS), languages: new Set(LANGUAGE_OPTIONS.map((language) => language.id)),
}, { allowIncomplete = false } = {}) {
  if (!value || !Array.isArray(value.speakerProfiles) || !Array.isArray(value.episodeProfiles)) {
    throw badRequest("Profile data is invalid.");
  }
  if (value.speakerProfiles.length === 0 || value.episodeProfiles.length === 0) {
    throw badRequest("At least one speaker profile and one episode profile are required.");
  }
  const ids = new Set();
  for (const profile of value.speakerProfiles) {
    validateId(profile.id, "Speaker profile");
    if (ids.has(profile.id)) throw badRequest(`Duplicate profile ID "${profile.id}".`);
    ids.add(profile.id);
    if (!allowIncomplete || profile.name?.trim()) requireText(profile.name, "Speaker profile name");
    if ((!allowIncomplete || profile.voiceModel) && !models.ttsModels.has(profile.voiceModel)) throw badRequest(`Unsupported TTS model "${profile.voiceModel}".`);
    if (!Array.isArray(profile.speakers) || profile.speakers.length < 1 || profile.speakers.length > 4) throw badRequest("Each speaker profile must contain 1 to 4 speakers.");
    const names = new Set();
    for (const speaker of profile.speakers) {
      if (!allowIncomplete || speaker.name?.trim()) requireText(speaker.name, "Speaker name");
      speaker.name = oneLine(speaker.name);
      if (/[:\[\]\r\n]/.test(speaker.name)) throw badRequest(`Speaker name "${speaker.name}" contains reserved characters.`);
      if (speaker.name && names.has(speaker.name)) throw badRequest(`Duplicate speaker name "${speaker.name}".`);
      if (speaker.name) names.add(speaker.name);
      if (!allowIncomplete || speaker.backstory?.trim()) requireText(speaker.backstory, `${speaker.name} backstory`);
      if (!allowIncomplete || speaker.personality?.trim()) requireText(speaker.personality, `${speaker.name} personality`);
      if (!allowIncomplete || speaker.style?.trim()) requireText(speaker.style, `${speaker.name} style`);
      if (speaker.accent != null && (typeof speaker.accent !== "string" || speaker.accent.length > 100)) throw badRequest(`${speaker.name} accent must contain at most 100 characters.`);
      speaker.chatterboxExaggeration = validateNumber(speaker.chatterboxExaggeration, CHATTERBOX_DEFAULTS.exaggeration, 0.25, 2, `${speaker.name} Chatterbox exaggeration`);
      speaker.chatterboxCfgWeight = validateNumber(speaker.chatterboxCfgWeight, CHATTERBOX_DEFAULTS.cfgWeight, 0, 1, `${speaker.name} Chatterbox CFG weight`);
      speaker.chatterboxTemperature = validateNumber(speaker.chatterboxTemperature, CHATTERBOX_DEFAULTS.temperature, 0.05, 5, `${speaker.name} Chatterbox temperature`);
      speaker.mimoTemperature = validateOptionalNumber(speaker.mimoTemperature, 0, 2, `${speaker.name} MiMo temperature`);
      speaker.mimoTopP = validateOptionalNumber(speaker.mimoTopP, 0, 1, `${speaker.name} MiMo top-p`);
      speaker.mimoInstructionPreset = typeof speaker.mimoInstructionPreset === "string" ? speaker.mimoInstructionPreset : "";
      if (speaker.mimoInstructionPreset && !Object.hasOwn(MIMO_INSTRUCTION_PRESETS, speaker.mimoInstructionPreset)) throw badRequest(`${speaker.name} MiMo preset is invalid.`);
      speaker.mimoInstructionText = speaker.mimoInstructionText == null ? "" : String(speaker.mimoInstructionText);
      if (speaker.mimoInstructionText.length > 500) throw badRequest(`${speaker.name} MiMo instruction text must contain at most 500 characters.`);
      speaker.elevenlabsStability = validateNumber(speaker.elevenlabsStability, ELEVENLABS_DEFAULTS.stability, 0, 1, `${speaker.name} ElevenLabs stability`);
      speaker.elevenlabsSimilarityBoost = validateNumber(speaker.elevenlabsSimilarityBoost, ELEVENLABS_DEFAULTS.similarityBoost, 0, 1, `${speaker.name} ElevenLabs similarity boost`);
      speaker.elevenlabsStyle = validateNumber(speaker.elevenlabsStyle, ELEVENLABS_DEFAULTS.style, 0, 1, `${speaker.name} ElevenLabs style`);
      speaker.elevenlabsUseSpeakerBoost = speaker.elevenlabsUseSpeakerBoost !== false;
      speaker.elevenlabsSpeed = validateNumber(speaker.elevenlabsSpeed, ELEVENLABS_DEFAULTS.speed, 0.7, 1.2, `${speaker.name} ElevenLabs speed`);
      speaker.elevenlabsSeed = validateOptionalInteger(speaker.elevenlabsSeed, 0, 4294967295, `${speaker.name} ElevenLabs seed`);
      speaker.elevenlabsTextNormalization = speaker.elevenlabsTextNormalization || ELEVENLABS_DEFAULTS.textNormalization;
      if (!["auto", "on", "off"].includes(speaker.elevenlabsTextNormalization)) throw badRequest(`${speaker.name} ElevenLabs text normalization is invalid.`);
      const resolvedModel = speaker.ttsModelOverride || profile.voiceModel;
      if ((!allowIncomplete || resolvedModel) && !models.ttsModels.has(resolvedModel)) throw badRequest(`Unsupported TTS model "${resolvedModel}".`);
      if (!allowIncomplete || speaker.voiceId?.trim()) requireText(speaker.voiceId, `${speaker.name} voice ID`);
    }
  }
  const episodeIds = new Set();
  for (const profile of value.episodeProfiles) {
    validateId(profile.id, "Episode Format");
    if (episodeIds.has(profile.id)) throw badRequest(`Duplicate episode profile ID "${profile.id}".`);
    episodeIds.add(profile.id);
    if (!allowIncomplete || profile.name?.trim()) requireText(profile.name, "Episode Format name");
    if ((!allowIncomplete || profile.speakerProfileId) && !ids.has(profile.speakerProfileId)) throw badRequest(`Speaker profile "${profile.speakerProfileId}" does not exist.`);
    if ((!allowIncomplete || profile.targetMinutes != null && profile.targetMinutes !== "") && (!Number.isInteger(profile.targetMinutes) || profile.targetMinutes < 5 || profile.targetMinutes > 60)) throw badRequest("Target duration must be an integer from 5 to 60 minutes.");
    if (profile.targetMinutes != null && profile.targetMinutes !== "") profile.numSegments = derivedNumSegments(profile.targetMinutes);
    delete profile.defaultBriefing;
    if ((!allowIncomplete || profile.outlineModel) && !models.textModels.has(profile.outlineModel)) throw badRequest(`Unsupported outline model "${profile.outlineModel}".`);
    if ((!allowIncomplete || profile.transcriptModel) && !models.textModels.has(profile.transcriptModel)) throw badRequest(`Unsupported transcript model "${profile.transcriptModel}".`);
    // ponytail: lenient — model-specific validity enforced at call time by effortLevelsForModel
    profile.outlineEffort = normalizeEffort(profile.outlineEffort);
    profile.transcriptEffort = normalizeEffort(profile.transcriptEffort);
    if ((!allowIncomplete || profile.language) && !models.languages.has(profile.language)) throw badRequest(`Unsupported language "${profile.language}".`);
  }
  return true;
}

export function assertProfileRevisionsCurrent(nextProfiles, currentProfiles) {
  for (const key of ["speakerProfiles", "episodeProfiles"]) {
    const currentById = new Map((currentProfiles[key] || []).map((profile) => [profile.id, profile]));
    for (const profile of nextProfiles[key] || []) {
      const current = currentById.get(profile.id);
      if (!current || profileRevision(profile) === profileRevision(current)) continue;
      throw conflict(`"${current.name || current.id}" was changed somewhere else after this page loaded. Reload the page, then apply the change again.`);
    }
  }
}

export function applyProfileRevisions(nextProfiles, currentProfiles) {
  for (const key of ["speakerProfiles", "episodeProfiles"]) {
    const currentById = new Map((currentProfiles[key] || []).map((profile) => [profile.id, profile]));
    for (const profile of nextProfiles[key] || []) {
      const current = currentById.get(profile.id);
      if (!current) {
        profile.revision = 1;
        continue;
      }
      const nextValue = { ...profile };
      const currentValue = { ...current };
      delete nextValue.revision;
      delete currentValue.revision;
      profile.revision = isDeepStrictEqual(nextValue, currentValue) ? profileRevision(current) : profileRevision(current) + 1;
    }
  }
}

export function mergeSavedProfileSelections(models, profiles) {
  for (const profile of profiles.speakerProfiles || []) {
    if (profile.voiceModel) models.ttsModels.add(profile.voiceModel);
    for (const speaker of profile.speakers || []) {
      if (speaker.ttsModelOverride) models.ttsModels.add(speaker.ttsModelOverride);
    }
  }
  for (const profile of profiles.episodeProfiles || []) {
    if (profile.outlineModel) models.textModels.add(profile.outlineModel);
    if (profile.transcriptModel) models.textModels.add(profile.transcriptModel);
    if (profile.language) models.languages.add(profile.language);
  }
}

export function modelReferenceWarnings(profiles, strictModels) {
  const references = [];
  collectModelReferences(profiles, (kind, name) => `${kind} profile "${name}"`, references);
  const seen = new Set();
  const warnings = [];
  for (const reference of references) {
    const available = reference.type === "text" ? strictModels.textModels : strictModels.ttsModels;
    if (available.has(reference.modelId)) continue;
    const key = `${reference.owner}:${reference.type}:${reference.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    warnings.push(`${reference.owner} uses unavailable saved ${reference.type === "text" ? "text" : "TTS"} model "${reference.modelId}". Restore or refresh the provider before generation, preview, or rendering.`);
  }
  return warnings;
}

export async function assertProfilesCompatibleWithEpisodes(paths, profiles, current) {
  const allowedEpisodes = new Set((profiles.episodeProfiles || []).map((profile) => profile.id));
  const allowedSpeakers = new Set((profiles.speakerProfiles || []).map((profile) => profile.id));
  const removed = new Set((current.episodeProfiles || []).map((profile) => profile.id).filter((id) => !allowedEpisodes.has(id)));
  const removedSpeakers = new Set((current.speakerProfiles || []).map((profile) => profile.id).filter((id) => !allowedSpeakers.has(id)));
  if (!removed.size && !removedSpeakers.size) return;
  for (const episode of await listEpisodes(paths)) {
    if (episode.corrupt) throw conflict("Cannot remove episode profiles while a corrupt episode may reference them.");
    if (removed.has(episode.episodeProfileId)) {
      throw conflict(`Episode Format "${episode.episodeProfileId}" is used by saved episode "${episode.name}".`);
    }
  }
  for (const item of await listPlans(paths)) {
    const plan = await loadPlan(paths, item.id);
    if (removedSpeakers.has(plan.speakerProfileId)) {
      throw conflict(`Speaker profile is used by content plan "${plan.name}".`);
    }
    if (removed.has(plan.episodeFormatId) || plan.episodes.some((episode) => removed.has(episode.episodeProfileId))) {
      throw conflict(`Episode Format is used by content plan "${plan.name}".`);
    }
  }
}

export function transcriptSpeakerRule(speakerNames) {
  return speakerNames.length === 1
    ? `This is a solo podcast. Use only ${speakerNames[0]} and never invent a cohost.`
    : `${speakerNames[0]} is the lead host and handles transitions. Use every configured speaker naturally without forcing equal turn counts.`;
}

export function validateOutline(value, numSegments) {
  if (!value || !Array.isArray(value.segments) || value.segments.length !== numSegments) throw new Error(`Outline must contain exactly ${numSegments} segments.`);
  value.segments.forEach((segment, index) => {
    if (segment.number !== index + 1 || typeof segment.title !== "string" || !segment.title.trim()) throw new Error(`Outline segment ${index + 1} is invalid.`);
    if (!Array.isArray(segment.points) || segment.points.length === 0) throw new Error(`Outline segment ${index + 1} needs points.`);
  });
  return true;
}

export function validateTranscriptJson(value, numSegments, speakerNames) {
  if (!value || typeof value.title !== "string" || !value.title.trim()) throw new Error("Transcript title is required.");
  if (!Array.isArray(value.segments) || value.segments.length === 0) throw new Error("Transcript must contain at least 1 segment.");
  if (value.segments.length > numSegments) throw new Error(`Transcript may contain at most ${numSegments} segments.`);
  const allowed = new Set(speakerNames);
  value.segments.forEach((segment, index) => {
    if (segment.number !== index + 1 || typeof segment.title !== "string" || !segment.title.trim()) throw new Error(`Transcript segment ${index + 1} is invalid.`);
    if (!Array.isArray(segment.turns) || segment.turns.length === 0) throw new Error(`Transcript segment ${index + 1} needs turns.`);
    segment.turns.forEach((turn) => {
      if (!allowed.has(turn.speaker)) throw new Error(`Unknown transcript speaker "${turn.speaker}".`);
      if (typeof turn.text !== "string" || !turn.text.trim()) throw new Error(`Transcript turn for ${turn.speaker} is empty.`);
      if (turn.delivery != null && typeof turn.delivery !== "string") throw new Error(`Transcript delivery for ${turn.speaker} must be text.`);
    });
  });
  return true;
}

export function transcriptToMarkdown(value) {
  const lines = [`# ${oneLine(value.title)}`, ""];
  for (const segment of value.segments) {
    lines.push(`## Segmento ${segment.number} — ${oneLine(segment.title)}`, "");
    for (const turn of segment.turns) {
      const delivery = normalizeDelivery(turn.delivery || "");
      lines.push(`${turn.speaker}${delivery ? ` [${delivery}]` : ""}: ${oneLine(turn.text)}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}

export function parseTranscript(markdown, speakers, expectedSegments) {
  const speakerNames = speakers.map((speaker) => speaker.name).sort((a, b) => b.length - a.length);
  const speakerPattern = speakerNames.map(RegExp.escape).join("|");
  const turnRe = new RegExp(`^(${speakerPattern})(?:\\s*\\[(.*)\\])?:\\s*(.+)$`);
  const segments = [];
  let current = null;

  for (const [index, raw] of String(markdown).split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || /^#\s+/.test(line)) continue;
    if (/^##\s+/.test(line)) {
      current = { title: line.replace(/^##\s+/, ""), turns: [] };
      segments.push(current);
      continue;
    }
    const match = line.match(turnRe);
    if (!match) throw badRequest(`Invalid transcript line ${index + 1}: ${line}`);
    if (!current) throw badRequest(`Transcript turn appears before first segment on line ${index + 1}.`);
    current.turns.push({ speaker: match[1], delivery: normalizeDelivery(match[2] || ""), text: match[3].trim() });
  }

  if (segments.length === 0) throw badRequest("Transcript must contain at least 1 segment.");
  if (segments.length > expectedSegments) throw badRequest(`Transcript may contain at most ${expectedSegments} segments; found ${segments.length}.`);
  segments.forEach((segment, index) => {
    if (segment.turns.length === 0) throw badRequest(`Segment ${index + 1} contains no turns.`);
  });
  return {
    segments,
    warning: segments.length < expectedSegments
      ? `Transcript contains ${segments.length} of ${expectedSegments} configured segments. It was saved and remains renderable.`
      : "",
  };
}

function stripTtsCues(value) {
  return String(value).replace(TTS_CUE_RE, " ").replace(ELEVEN_BREAK_ANY_RE, " ").replace(/\s+/g, " ").trim();
}

function countWords(value, locale = "en") {
  const text = stripTtsCues(value);
  if (!text) return 0;
  return [...new Intl.Segmenter(locale, { granularity: "word" }).segment(text)].filter((part) => part.isWordLike).length;
}

export function transcriptWordCount(segments, locale) {
  return countWords(segments.flatMap((segment) => segment.turns.map((turn) => turn.text)).join(" "), locale);
}
