import { randomUUID } from "node:crypto";
import {
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { badRequest, conflict, notFound, readJsonBody, sendJson } from "./util.mjs";
import { LANGUAGE_OPTIONS } from "./providers/catalog.mjs";
import { isActiveJob, planPath, planIndexItem, loadPlan, savePlan, nextUpdatedAt, listEpisodes, episodeDir, readJson, writeJsonAtomic } from "./store.mjs";
import { saveEpisodeFromBody } from "./episodes.mjs";

const PLAN_MAX_THEME_CHARS = 20_000;
export const PLAN_MAX_TEXT_CHARS = 50_000;
export const PLAN_MAX_EPISODES = 100;
const PLAN_MAX_KEY_POINTS = 20;

export async function createKnowledgeBase(req, res, paths) {
  const body = await readJsonBody(req);
  const name = String(body.name || "").trim();
  const content = String(body.content || "");
  if (!name || extname(name).toLowerCase() !== ".md") throw badRequest("Knowledge base must be a .md file.");
  if (!content.trim()) throw badRequest("Knowledge base is empty.");
  if (Buffer.byteLength(content, "utf8") > 3 * 1024 * 1024) throw badRequest("Knowledge base exceeds 3 MiB limit.");

  const id = randomUUID();
  await writeFile(join(paths.knowledge, `${id}.md`), content, "utf8");
  const index = await readJson(paths.knowledgeIndex);
  const item = {
    id,
    name: basename(name),
    characters: content.length,
    createdAt: new Date().toISOString(),
  };
  index.push(item);
  try {
    await writeJsonAtomic(paths.knowledgeIndex, index);
  } catch (error) {
    await rm(join(paths.knowledge, `${id}.md`), { force: true });
    throw error;
  }
  sendJson(res, 201, item);
}

export async function deleteKnowledgeBase(res, context, id) {
  const { paths } = context;
  const knowledgeIndex = await readJson(paths.knowledgeIndex);
  const item = knowledgeIndex.find((entry) => entry.id === id);
  if (!item) throw notFound("Knowledge base not found.");

  const planIndex = await readJson(paths.plansIndex);
  const plans = [];
  for (const entry of planIndex.filter((plan) => plan.knowledgeBaseId === id)) plans.push(await loadPlan(paths, entry.id));
  const episodes = (await listEpisodes(paths)).filter((episode) => !episode.corrupt && episode.knowledgeBaseId === id);
  const active = episodes.find((episode) => isActiveJob(episode.job));
  if (active) throw conflict(`Wait for active job on episode "${active.name}" before deleting this Knowledge Base.`);

  const now = new Date().toISOString();
  const changedPlans = plans.map((plan) => ({ ...plan, knowledgeBaseId: "", updatedAt: nextUpdatedAt(plan.updatedAt) }));
  const nextPlanIndex = planIndex.map((plan) => plan.knowledgeBaseId === id ? planIndexItem(changedPlans.find((item) => item.id === plan.id)) : plan);
  const writes = [
    { path: paths.knowledgeIndex, before: knowledgeIndex, after: knowledgeIndex.filter((entry) => entry.id !== id) },
    { path: paths.plansIndex, before: planIndex, after: nextPlanIndex },
    ...plans.map((plan, index) => ({ path: planPath(paths, plan.id), before: plan, after: changedPlans[index] })),
    ...episodes.map((episode) => ({ path: join(episodeDir(paths, episode.id), "episode.json"), before: episode, after: { ...episode, knowledgeBaseId: "", updatedAt: now } })),
  ];
  const applied = [];
  try {
    for (const write of writes) {
      await writeJsonAtomic(write.path, write.after);
      applied.push(write);
    }
    await rm(join(paths.knowledge, `${id}.md`), { force: true });
  } catch (error) {
    for (const write of applied.reverse()) await writeJsonAtomic(write.path, write.before).catch(() => {});
    throw error;
  }
  sendJson(res, 200, { id, deleted: true, cleared: { plans: plans.length, episodes: episodes.length } });
}

function planText(value, label, max = PLAN_MAX_TEXT_CHARS, required = false) {
  const text = value == null ? "" : String(value);
  if (required && !text.trim()) throw badRequest(`${label} is required.`);
  if (text.length > max) throw badRequest(`${label} must contain at most ${max} characters.`);
  return text;
}

function planInteger(value, label, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw badRequest(`${label} must be an integer from ${min} to ${max}.`);
  return number;
}

export function normalizePlannedEpisode(value, current = null) {
  const episode = value && typeof value === "object" ? value : {};
  const keyPoints = Array.isArray(episode.keyPoints) ? episode.keyPoints : [];
  if (keyPoints.length > PLAN_MAX_KEY_POINTS) throw badRequest(`Key points must contain at most ${PLAN_MAX_KEY_POINTS} items.`);
  return {
    id: current?.id || randomUUID(),
    number: current?.number || planInteger(episode.number, "Episode number", 1, PLAN_MAX_EPISODES),
    title: planText(episode.title, "Episode title", PLAN_MAX_TEXT_CHARS, true).trim(),
    premise: planText(episode.premise, "Episode premise"),
    knowledgeScope: planText(episode.knowledgeScope, "Knowledge scope"),
    keyPoints: keyPoints.map((point) => planText(point, "Key point")),
    listenerOutcome: planText(episode.listenerOutcome, "Listener outcome"),
    episodeProfileId: String(episode.episodeProfileId || "").trim(),
    additionalInstructions: planText(episode.additionalInstructions, "Additional instructions"),
    transcriptPromptGuidance: planText(episode.transcriptPromptGuidance, "Transcript prompt guidance"),
    createdEpisodeId: current?.createdEpisodeId || null,
  };
}

export function normalizePlanInput(value, current = null) {
  const raw = value && typeof value === "object" ? value : {};
  const now = new Date().toISOString();
  const language = String(raw.language || "es-419").trim();
  if (!LANGUAGE_OPTIONS.some((item) => item.id === language)) throw badRequest(`Unsupported language "${language}".`);
  const plan = {
    id: current?.id || randomUUID(),
    name: planText(raw.name, "Plan name", PLAN_MAX_TEXT_CHARS, true).trim(),
    status: "draft",
    knowledgeBaseId: String(raw.knowledgeBaseId || "").trim(),
    speakerProfileId: String(raw.speakerProfileId || "").trim(),
    episodeFormatId: String(raw.episodeFormatId || "").trim(),
    language,
    targetMinutes: planInteger(raw.targetMinutes ?? 18, "Target duration", 5, 60),
    theme: planText(raw.theme, "Theme", PLAN_MAX_THEME_CHARS),
    audience: planText(raw.audience, "Audience"),
    goal: planText(raw.goal, "Goal"),
    episodeCount: raw.episodeCount == null || raw.episodeCount === "" ? null : planInteger(raw.episodeCount, "Episode count", 1, PLAN_MAX_EPISODES),
    createdAt: current?.createdAt || now,
    updatedAt: now,
    episodes: [],
  };
  if (!current) {
    plan.episodes = (Array.isArray(raw.episodes) ? raw.episodes : []).map((item) => normalizePlannedEpisode(item));
  } else {
    plan.episodes = mergePlanCollection(current.episodes, raw.episodes, normalizePlannedEpisode, "Planned episodes");
  }
  if (plan.episodes.length > PLAN_MAX_EPISODES) throw badRequest(`Planned episodes must contain at most ${PLAN_MAX_EPISODES} items.`);
  return plan;
}

function mergePlanCollection(current, incoming, normalize, label) {
  if (incoming == null) return structuredClone(current || []);
  if (!Array.isArray(incoming) || incoming.length !== (current || []).length) throw badRequest(`${label} cannot be added, removed, or reordered here.`);
  return current.map((item, index) => {
    if (incoming[index]?.id !== item.id) throw badRequest(`${label} cannot be added, removed, or reordered here.`);
    return normalize(incoming[index], item);
  });
}

export async function validatePlanReferences(context, plan, { profiles: profilesOverride } = {}) {
  const [profiles, knowledge] = await Promise.all([profilesOverride ?? readJson(context.paths.profiles), readJson(context.paths.knowledgeIndex)]);
  if (plan.knowledgeBaseId && !knowledge.some((item) => item.id === plan.knowledgeBaseId)) throw badRequest("Knowledge base does not exist.");
  if (plan.speakerProfileId && !profiles.speakerProfiles.some((item) => item.id === plan.speakerProfileId)) throw badRequest("Speaker profile does not exist.");
  const episodeProfileIds = new Set(profiles.episodeProfiles.map((item) => item.id));
  if (plan.episodeFormatId && !episodeProfileIds.has(plan.episodeFormatId)) throw badRequest("Episode Format does not exist.");
  for (const episode of plan.episodes) {
    if (episode.episodeProfileId && !episodeProfileIds.has(episode.episodeProfileId)) throw badRequest("Episode Format does not exist.");
  }
  return { profiles, knowledge };
}

export async function createPlanRequest(req, res, context) {
  const body = await readJsonBody(req);
  const profiles = await readJson(context.paths.profiles);
  const speakerProfileId = String(body.speakerProfileId || profiles.speakerProfiles[0]?.id || "");
  const plan = normalizePlanInput({ ...body, id: undefined, episodes: [], name: body.name || "New Content Plan", speakerProfileId, episodeCount: body.episodeCount ?? null });
  await validatePlanReferences(context, plan);
  await savePlan(context.paths, plan);
  sendJson(res, 201, { plan });
}

export async function getPlanResponse(res, paths, id) {
  sendJson(res, 200, { plan: await loadPlan(paths, id) });
}

export async function updatePlanRequest(req, res, context, id) {
  const current = await loadPlan(context.paths, id);
  const body = await readJsonBody(req);
  if (Object.hasOwn(body, "expectedUpdatedAt") && body.expectedUpdatedAt !== current.updatedAt) throw conflict("Content plan changed in another tab. Reload the plan before saving your changes.");
  const plan = normalizePlanInput(body, current);
  await validatePlanReferences(context, plan);
  await savePlan(context.paths, plan);
  sendJson(res, 200, { plan });
}

export async function deletePlannedEpisodeRequest(res, paths, planId, plannedEpisodeId) {
  const plan = await loadPlan(paths, planId);
  const episode = plan.episodes.find((item) => item.id === plannedEpisodeId);
  if (!episode) throw notFound("Planned episode not found.");
  if (episode.createdEpisodeId) throw conflict("Delete the created episode instead.");
  plan.episodes = plan.episodes.filter((item) => item.id !== plannedEpisodeId);
  plan.updatedAt = new Date().toISOString();
  await savePlan(paths, plan);
  sendJson(res, 200, { plan });
}

export async function deletePlanRequest(res, context, id) {
  await loadPlan(context.paths, id);
  const index = await readJson(context.paths.plansIndex);
  await writeJsonAtomic(context.paths.plansIndex, index.filter((item) => item.id !== id));
  try {
    await rm(planPath(context.paths, id), { force: true });
  } catch (error) {
    await writeJsonAtomic(context.paths.plansIndex, index);
    throw error;
  }
  sendJson(res, 200, { id, deleted: true });
}

// The plan JSON contract the old planner model returned: titles for every episode, detail for episode 1, and an Episode Format when none is selected.
export function normalizeGeneratedPlan(raw, plan) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.episodes)) throw badRequest("Content planner response is invalid.");
  if (plan.episodeCount == null && (raw.episodes.length < 1 || raw.episodes.length > PLAN_MAX_EPISODES)) throw badRequest(`Content planner must return from 1 to ${PLAN_MAX_EPISODES} episodes.`);
  if (plan.episodeCount != null && raw.episodes.length !== plan.episodeCount) throw badRequest(`Content planner must return exactly ${plan.episodeCount} episodes.`);
  const episodes = raw.episodes.map((item, index) => {
    if (item?.number !== index + 1) throw badRequest(`Generated episode ${index + 1} has invalid numbering.`);
    return normalizePlannedEpisode({ number: item.number, title: item.title, id: randomUUID(), episodeProfileId: "" });
  });
  if (raw.detailedEpisode != null) {
    if (!raw.detailedEpisode || typeof raw.detailedEpisode !== "object" || Array.isArray(raw.detailedEpisode) || raw.detailedEpisode.number !== 1) throw badRequest("Detailed episode must reference episode 1.");
    episodes[0] = normalizePlannedEpisode({ ...episodes[0], ...raw.detailedEpisode }, episodes[0]);
  }
  let episodeFormat = null;
  if (!plan.episodeFormatId) {
    if (!raw.episodeFormat || typeof raw.episodeFormat !== "object" || Array.isArray(raw.episodeFormat)) throw badRequest("Content planner must return an Episode Format.");
    episodeFormat = {
      name: planText(raw.episodeFormat.name, "Episode Format name", PLAN_MAX_TEXT_CHARS, true).trim(),
      description: planText(raw.episodeFormat.description, "Episode Format description", PLAN_MAX_TEXT_CHARS, true).trim(),
    };
  }
  return { episodeFormat, episodes, episodeCount: episodes.length };
}

function buildPlannedAdditionalInstructions(plan, episode) {
  return [
    `Series/theme:\n${plan.theme}`,
    `Goal:\n${plan.goal || "None."}`,
    `Audience:\n${plan.audience || "General."}`,
    `Planned episode:\n${episode.premise || "None."}`,
    `Knowledge scope:\n${episode.knowledgeScope || "Use relevant source."}`,
    `Key points:\n${episode.keyPoints.length ? episode.keyPoints.map((item) => `- ${item}`).join("\n") : "- None."}`,
    `Listener outcome:\n${episode.listenerOutcome || "None."}`,
    `Planner instructions:\n${episode.additionalInstructions || "None."}`,
  ].join("\n\n");
}

export async function createPlanEpisodesRequest(req, res, context, id) {
  const body = await readJsonBody(req);
  const selected = Array.isArray(body.plannedEpisodeIds) ? [...new Set(body.plannedEpisodeIds.map(String))] : [];
  if (!selected.length) throw badRequest("Select at least one planned episode.");
  const plan = await loadPlan(context.paths, id);
  const profiles = await readJson(context.paths.profiles);
  const targets = selected.map((episodeId) => {
    const episode = plan.episodes.find((item) => item.id === episodeId);
    if (!episode) throw badRequest(`Planned episode "${episodeId}" does not exist.`);
    if (episode.createdEpisodeId) return { episode, skip: true };
    const episodeProfileId = episode.episodeProfileId || plan.episodeFormatId;
    if (!episodeProfileId || !profiles.episodeProfiles.some((item) => item.id === episodeProfileId)) throw badRequest("Pick an Episode Format for the plan before creating episode drafts.");
    return { episode, episodeProfileId };
  });
  const episodes = [];
  const createdIds = [];
  try {
    for (const target of targets) {
      if (target.skip) continue;
      const result = await saveEpisodeFromBody(context.paths, { name: target.episode.title, episodeProfileId: target.episodeProfileId, speakerProfileId: plan.speakerProfileId, knowledgeBaseId: plan.knowledgeBaseId, additionalInstructions: buildPlannedAdditionalInstructions(plan, target.episode), transcriptPromptGuidance: target.episode.transcriptPromptGuidance });
      target.episode.createdEpisodeId = result.episode.id;
      createdIds.push(result.episode.id);
      episodes.push(result.episode);
    }
    plan.updatedAt = new Date().toISOString();
    await savePlan(context.paths, plan);
  } catch (error) {
    await Promise.all(createdIds.map((episodeId) => rm(episodeDir(context.paths, episodeId), { recursive: true, force: true })));
    throw error;
  }
  sendJson(res, 200, { plan, episodes });
}
