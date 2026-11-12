// Albums group episodes in track order; each language has its own edition of the same album.
import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { badRequest, conflict, notFound, oneLine, assertSafeId, readJsonBody, sendJson, sendFile, runProcess } from "./util.mjs";
import { LANGUAGE_OPTIONS, ISO_639_2_CODES, resolveLanguage } from "./providers/catalog.mjs";
import { serializeMutation, isActiveJob, resolveEpisodeProfiles, listEpisodes, episodeDir, nextUpdatedAt, readJson, writeJsonAtomic, writeTextAtomic, exists } from "./store.mjs";

export const MAX_COVER_BYTES = 2 * 1024 * 1024;
const COVER_TYPES = { "image/png": "png", "image/jpeg": "jpg" };

export async function readAlbums(paths) {
  return await exists(paths.albums) ? readJson(paths.albums) : [];
}

const findAlbum = (albums, id) => {
  const album = albums.find((item) => item.id === id);
  if (!album) throw notFound("Album not found.");
  return album;
};

const coverPath = (paths, album) => join(paths.albumCovers, album.id, album.cover.file);

// The album, edition and track number of an episode, or null.
export function episodeAlbum(albums, episodeId) {
  for (const album of albums) {
    for (const edition of album.editions) {
      const index = edition.episodeIds.indexOf(episodeId);
      if (index >= 0) return { album, edition, track: index + 1, total: edition.episodeIds.length };
    }
  }
  return null;
}

export function episodeAlbumView(albums, episodeId) {
  const found = episodeAlbum(albums, episodeId);
  return found ? { id: found.album.id, title: found.edition.title || found.album.title, language: found.edition.language, track: found.track } : null;
}

export async function albumView(paths, album, extra = {}) {
  const episodes = new Map((await listEpisodes(paths)).map((episode) => [episode.id, episode]));
  return {
    album: {
      ...album,
      coverUrl: album.cover ? `/covers/${album.id}` : null,
      editions: album.editions.map((edition) => ({
        ...edition,
        languageName: LANGUAGE_OPTIONS.find((item) => item.id === edition.language)?.name || edition.language,
        displayTitle: edition.title || album.title,
        tracks: edition.episodeIds.map((episodeId, index) => {
          const episode = episodes.get(episodeId);
          return { track: index + 1, episodeId, name: episode?.name ?? null, status: episode?.status ?? "missing", audioReady: episode?.audioReady === true };
        }),
      })),
    },
    ...extra,
  };
}

function textField(value, label, maximum, required, multiline = false) {
  if (value == null) {
    if (required) throw badRequest(`${label} is required.`);
    return "";
  }
  if (typeof value !== "string") throw badRequest(`${label} must be text.`);
  const text = multiline ? value.trim() : oneLine(value);
  if (required && !text) throw badRequest(`${label} is required.`);
  if (text.length > maximum) throw badRequest(`${label} must be at most ${maximum} characters.`);
  return text;
}

async function validateEditions(context, albums, albumId, editions) {
  if (!Array.isArray(editions)) throw badRequest("Album editions must be a list.");
  const episodes = new Map((await listEpisodes(context.paths)).map((episode) => [episode.id, episode]));
  const languages = new Set();
  const seen = new Set();
  const result = [];
  for (const input of editions) {
    if (!input || typeof input !== "object") throw badRequest("Each album edition must be an object.");
    const language = resolveLanguage(context, input.language).id;
    if (languages.has(language)) throw badRequest(`The album has more than one ${language} edition. Use one edition per language.`);
    languages.add(language);
    if (!Array.isArray(input.episodeIds)) throw badRequest(`The ${language} edition needs an episodeIds list.`);
    for (const episodeId of input.episodeIds) {
      if (typeof episodeId !== "string") throw badRequest("Episode IDs must be text.");
      assertSafeId(episodeId);
      const episode = episodes.get(episodeId);
      if (!episode || episode.corrupt) throw badRequest(`Episode ${episodeId} does not exist.`);
      if (seen.has(episodeId)) throw badRequest(`Episode "${episode.name}" is in the album more than once.`);
      seen.add(episodeId);
      const other = episodeAlbum(albums.filter((album) => album.id !== albumId), episodeId);
      if (other) throw conflict(`Episode "${episode.name}" is already in album "${other.album.title}" (${other.edition.language}). Remove it there first.`);
      const { episodeProfile } = await resolveEpisodeProfiles(context.paths, episode);
      if (episodeProfile.language !== language) throw badRequest(`Episode "${episode.name}" is in ${episodeProfile.language}, not ${language}. Put it in the ${episodeProfile.language} edition.`);
    }
    result.push({ language, title: textField(input.title, "Edition title", 200, false), episodeIds: [...input.episodeIds] });
  }
  return result;
}

// Create (no id) or update an album. The caller holds serializeMutation.
export async function saveAlbum(context, input = {}) {
  const albums = await readAlbums(context.paths);
  const { id: albumId, expectedRevision } = input;
  const existing = albumId ? findAlbum(albums, albumId) : null;
  if (existing && expectedRevision != null && expectedRevision !== existing.revision) throw conflict(`Album "${existing.title}" changed after you read it (revision ${existing.revision}, expected ${expectedRevision}). Read it again with get_album.`);
  const before = existing ? structuredClone(existing) : null;
  const album = existing || { id: `album-${randomUUID()}`, title: "", description: "", revision: -1, updatedAt: null, cover: null, editions: [] };
  album.title = input.title === undefined && existing ? album.title : textField(input.title, "Album title", 200, true);
  if (input.description !== undefined) album.description = textField(input.description, "Album description", 2000, false, true);
  if (input.editions !== undefined) album.editions = await validateEditions(context, albums, album.id, input.editions);
  album.revision += 1;
  album.updatedAt = nextUpdatedAt(album.updatedAt);
  await writeJsonAtomic(context.paths.albums, existing ? albums : [...albums, album]);
  const affected = new Set([...(before?.editions || []), ...album.editions].flatMap((edition) => edition.episodeIds));
  return albumView(context.paths, album, { warnings: await retagEpisodes(context, affected) });
}

export async function deleteAlbum(context, albumId) {
  const albums = await readAlbums(context.paths);
  const album = findAlbum(albums, albumId);
  await writeJsonAtomic(context.paths.albums, albums.filter((item) => item.id !== albumId));
  await rm(join(context.paths.albumCovers, album.id), { recursive: true, force: true });
  const warnings = await retagEpisodes(context, album.editions.flatMap((edition) => edition.episodeIds));
  return { id: albumId, deleted: true, warnings };
}

// Checks the magic bytes, not only the declared type. remove: true (no bytes) clears the cover.
export async function setAlbumCover(context, albumId, bytes, mimeType) {
  const albums = await readAlbums(context.paths);
  const album = findAlbum(albums, albumId);
  const directory = join(context.paths.albumCovers, album.id);
  if (bytes == null) {
    album.cover = null;
  } else {
    const extension = COVER_TYPES[mimeType];
    if (!extension) throw badRequest("The cover must be a PNG or JPEG image (image/png or image/jpeg).");
    if (bytes.length === 0) throw badRequest("The cover image is empty.");
    if (bytes.length > MAX_COVER_BYTES) throw badRequest("The cover image exceeds 2 MB.");
    const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpeg = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    if (!(extension === "png" ? png : jpeg)) throw badRequest(`The cover data is not a valid ${extension === "png" ? "PNG" : "JPEG"} image.`);
    await writeTextAtomic(join(directory, `cover.${extension}`), bytes);
    album.cover = { file: `cover.${extension}`, mimeType };
  }
  for (const name of Object.values(COVER_TYPES).map((extension) => `cover.${extension}`)) {
    if (name !== album.cover?.file) await rm(join(directory, name), { force: true });
  }
  album.revision += 1;
  album.updatedAt = nextUpdatedAt(album.updatedAt);
  await writeJsonAtomic(context.paths.albums, albums);
  return albumView(context.paths, album, { warnings: await retagEpisodes(context, album.editions.flatMap((edition) => edition.episodeIds)) });
}

// Called by deleteEpisode before the episode folder goes; returns the albums before the change (for rollback) and the remaining tracks to retag.
export async function removeEpisodeFromAlbums(paths, episodeId) {
  const albums = await readAlbums(paths);
  const found = episodeAlbum(albums, episodeId);
  if (!found) return null;
  const before = structuredClone(albums);
  found.edition.episodeIds = found.edition.episodeIds.filter((item) => item !== episodeId);
  found.album.revision += 1;
  found.album.updatedAt = nextUpdatedAt(found.album.updatedAt);
  await writeJsonAtomic(paths.albums, albums);
  return { before, retag: found.edition.episodeIds };
}

export async function restoreAlbums(paths, albums) {
  await writeJsonAtomic(paths.albums, albums);
}

// Re-tag the rendered MP3s of these episodes from the saved albums. Skips episodes without audio or with an active job.
export async function retagEpisodes(context, episodeIds) {
  const ids = new Set(episodeIds);
  if (!ids.size) return [];
  const albums = await readAlbums(context.paths);
  const warnings = [];
  for (const episode of await listEpisodes(context.paths)) {
    if (!ids.has(episode.id) || episode.corrupt || episode.audioReady !== true) continue;
    if (isActiveJob(episode.job)) {
      warnings.push(`Episode "${episode.name}" has an active render job; its MP3 tags were not updated. The render writes the current album tags when it finishes.`);
      continue;
    }
    const warning = await tagEpisodeMp3(context.paths, episode, albums);
    if (warning) warnings.push(warning);
  }
  return warnings;
}

// One tagging path for renders and album changes. Episodes outside an album keep only their title.
// Never throws for an ffmpeg failure: the original MP3 stays and the result is a warning.
export async function tagEpisodeMp3(paths, episode, albums) {
  const mp3 = join(episodeDir(paths, episode.id), "episode.mp3");
  if (!(await exists(mp3))) return null;
  const found = episodeAlbum(albums, episode.id);
  const tags = { title: episode.name };
  let cover = null;
  if (found) {
    const { album, edition } = found;
    let artist = "";
    try { artist = (await resolveEpisodeProfiles(paths, episode)).speakerProfile.name || ""; } catch {}
    const language = LANGUAGE_OPTIONS.find((item) => item.id === edition.language);
    Object.assign(tags, {
      album: edition.title || album.title,
      track: `${found.track}/${found.total}`,
      artist,
      language: ISO_639_2_CODES.get(language?.apiCode) || edition.language,
      genre: "Podcast",
    });
    if (album.cover && await exists(coverPath(paths, album))) cover = coverPath(paths, album);
  }
  const temporary = `${mp3}.${randomUUID()}.tag.tmp`;
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", mp3];
  if (cover) args.push("-i", cover);
  args.push("-map", "0:a");
  if (cover) args.push("-map", "1:v", "-disposition:v", "attached_pic", "-metadata:s:v", "title=Album cover", "-metadata:s:v", "comment=Cover (front)");
  // Drop old tags so an episode that leaves an album loses its album tags.
  args.push("-map_metadata", "-1", "-c", "copy", "-id3v2_version", "3");
  for (const [name, value] of Object.entries(tags)) if (value) args.push("-metadata", `${name}=${value}`);
  args.push("-f", "mp3", temporary);
  try {
    await runProcess("ffmpeg", args);
    await rename(temporary, mp3);
    return null;
  } catch (error) {
    console.warn(`[episode:${episode.id}] MP3 tagging failed: ${error.message || error}`);
    return `Could not write MP3 tags for "${episode.name}"; the audio is unchanged. ${error.message || error}`;
  } finally {
    await rm(temporary, { force: true });
  }
}

// REST: GET/POST /api/albums, GET/PUT/DELETE /api/albums/<id>, PUT/DELETE /api/albums/<id>/cover, GET /covers/<id>.
export async function handleAlbumRequest(req, res, context, method, path) {
  const { paths } = context;
  if (method === "GET" && path.startsWith("/covers/")) {
    const albumId = path.slice("/covers/".length);
    assertSafeId(albumId);
    const album = findAlbum(await readAlbums(paths), albumId);
    if (!album.cover) throw notFound("The album has no cover.");
    return sendFile(req, res, coverPath(paths, album), album.cover.mimeType);
  }
  if (path === "/api/albums") {
    if (method === "GET") return sendJson(res, 200, { albums: await readAlbums(paths) });
    if (method === "POST") {
      const body = await readJsonBody(req);
      if (body?.id !== undefined) throw badRequest("Create an album without an id; update it with PUT /api/albums/<id>.");
      return sendJson(res, 201, await serializeMutation(context, () => saveAlbum(context, body)));
    }
  }
  const match = path.match(/^\/api\/albums\/([a-zA-Z0-9_-]+)(?:\/(cover))?$/);
  if (match) {
    const [, albumId, action] = match;
    assertSafeId(albumId);
    if (!action) {
      if (method === "GET") return sendJson(res, 200, await albumView(paths, findAlbum(await readAlbums(paths), albumId)));
      if (method === "PUT") {
        const body = await readJsonBody(req);
        return sendJson(res, 200, await serializeMutation(context, () => saveAlbum(context, { ...body, id: albumId })));
      }
      if (method === "DELETE") return sendJson(res, 200, await serializeMutation(context, () => deleteAlbum(context, albumId)));
    } else {
      if (method === "PUT") {
        const mimeType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        const bytes = await readCoverBody(req);
        return sendJson(res, 200, await serializeMutation(context, () => setAlbumCover(context, albumId, bytes, mimeType)));
      }
      if (method === "DELETE") return sendJson(res, 200, await serializeMutation(context, () => setAlbumCover(context, albumId, null)));
    }
  }
  sendJson(res, 404, { error: "Not found." });
}

async function readCoverBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_COVER_BYTES) throw badRequest("The cover image exceeds 2 MB.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
