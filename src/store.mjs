import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { badRequest, notFound, ID_RE, assertSafeId } from "./util.mjs";

export async function serializeMutation(context, action) {
  // ponytail: one local process needs one lock; split by resource only if write throughput matters.
  const previous = context.mutationTail;
  let release;
  context.mutationTail = new Promise((resolvePromise) => { release = resolvePromise; });
  await previous;
  try {
    return await action();
  } finally {
    release();
  }
}

export function isActiveJob(job) {
  return job && ["queued", "running"].includes(job.status);
}

export function planPath(paths, id) {
  return join(paths.plans, `${id}.json`);
}

export function planIndexItem(plan) {
  return {
    id: plan.id,
    name: plan.name,
    status: "draft",
    knowledgeBaseId: plan.knowledgeBaseId,
    speakerProfileId: plan.speakerProfileId,
    episodeCount: plan.episodeCount,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

export async function listPlans(paths) {
  const plans = await readJson(paths.plansIndex);
  return plans.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function loadPlan(paths, id) {
  const path = planPath(paths, id);
  if (!(await exists(path))) throw notFound("Content plan not found.");
  const plan = await readJson(path);
  delete plan.formatDrafts;
  delete plan.episodeSeeds;
  for (const episode of plan.episodes || []) delete episode.formatDraftId;
  return plan;
}

export async function savePlan(paths, plan, { restore = false } = {}) {
  const path = planPath(paths, plan.id);
  const previous = await exists(path) ? await readJson(path) : null;
  if (!restore) plan.updatedAt = nextUpdatedAt(previous?.updatedAt);
  const previousIndex = await readJson(paths.plansIndex);
  const nextIndex = previousIndex.filter((item) => item.id !== plan.id);
  nextIndex.push(planIndexItem(plan));
  nextIndex.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  await writeJsonAtomic(path, plan);
  try {
    await writeJsonAtomic(paths.plansIndex, nextIndex);
  } catch (error) {
    if (previous) await writeJsonAtomic(path, previous);
    else await rm(path, { force: true });
    throw error;
  }
}

export function nextUpdatedAt(previous) {
  return new Date(Math.max(Date.now(), (Date.parse(previous) || 0) + 1)).toISOString();
}

export function profileRevision(profile) {
  return Number.isInteger(profile?.revision) && profile.revision >= 0 ? profile.revision : 0;
}

export async function resolveEpisodeProfiles(paths, episode) {
  if (episode.episodeProfile && episode.speakerProfile) {
    return { episodeProfile: structuredClone(episode.episodeProfile), speakerProfile: structuredClone(episode.speakerProfile) };
  }
  const data = await readJson(paths.profiles);
  const episodeProfile = data.episodeProfiles.find((item) => item.id === episode.episodeProfileId);
  if (!episodeProfile) throw badRequest("Episode Format does not exist.");
  const speakerProfile = data.speakerProfiles.find((item) => item.id === (episode.speakerProfileId || episodeProfile.speakerProfileId));
  if (!speakerProfile) throw badRequest("Speaker profile does not exist.");
  return { episodeProfile, speakerProfile };
}

export async function listEpisodes(paths) {
  const entries = await readdir(paths.episodes, { withFileTypes: true });
  const episodes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
    try {
      episodes.push(await readJson(join(paths.episodes, entry.name, "episode.json")));
    } catch (error) {
      const message = error.message || String(error);
      console.warn(`[episode:${entry.name}] cannot read episode.json: ${message}`);
      episodes.push({
        id: entry.name,
        name: `Corrupt episode (${entry.name})`,
        status: "corrupt",
        corrupt: true,
        audioReady: false,
        updatedAt: null,
        lastError: message,
      });
    }
  }
  return episodes.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function loadEpisode(paths, id, withTranscript) {
  assertSafeId(id);
  const file = join(episodeDir(paths, id), "episode.json");
  if (!(await exists(file))) throw notFound("Episode does not exist.");
  const episode = await readJson(file);
  if (withTranscript) {
    const transcriptPath = join(episodeDir(paths, id), "transcript.md");
    episode.transcript = (await exists(transcriptPath)) ? await readFile(transcriptPath, "utf8") : "";
    episode.audioUrl = episode.audioReady ? `/artifacts/${id}/episode.mp3` : null;
  }
  return episode;
}

export async function updateEpisode(paths, episode, changes) {
  const updated = { ...episode, ...changes, updatedAt: new Date().toISOString() };
  delete updated.transcript;
  delete updated.audioUrl;
  await writeJsonAtomic(join(episodeDir(paths, episode.id), "episode.json"), updated);
  return updated;
}

export function episodeDir(paths, id) {
  assertSafeId(id);
  return join(paths.episodes, id);
}

export async function readJson(path) {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw Object.assign(new Error(`${path} is not valid JSON: ${error.message || error}`), { invalidJson: true });
  }
}

export async function writeJsonAtomic(path, value) {
  await writeTextAtomic(path, JSON.stringify(value, null, 2) + "\n");
}

export async function writeTextAtomic(path, text, mode) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, mode == null ? "utf8" : { encoding: "utf8", mode });
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, path);
        break;
      } catch (error) {
        if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(error.code) || attempt === 5) throw error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10 * 2 ** attempt));
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
