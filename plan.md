# pod-god: fix hosts apply, add episode + host-profile deletion

## Context

User described a podcast idea, asked for two hosts, clicked "Apply to new profile" — and saw nothing change. Forensics on `data/` proved the apply worked **seven times**: `profiles.json` now holds 9 identical "Fable 5 Gossip Duo" profiles. Three compounding defects made success look like failure:

1. **Episodes never follow the podcast's hosts.** `applyPlannerChatProposal` repoints `plan.speakerProfileId`, but already-created episodes keep their frozen `speakerProfile` snapshot (all 12 of the user's episodes still show the previous podcast's "Chisme de Crianza" Valeria/Diego hosts). Worse, `createPlanEpisodesRequest` (src/app.mjs:1360) never passes `plan.speakerProfileId` to `saveEpisodeFromBody`, so even **newly created** episodes take hosts from the episode format's `speakerProfileId` — the plan's hosts setting is effectively dead.
2. **Proposal cards never show an applied state.** Buttons stay live forever; every retry silently minted another profile copy.
3. **The three-button ceremony** ("Apply to new profile" / "Update shared profile" / "Apply & continue") plus a raw JSON diff blob is unreadable. The assistant proposed `mode=update` targeting the *previous podcast's* profile (plans auto-inherit the first profile), which triggered the shared-profile warning on a brand-new podcast.

Additionally the user wants: delete episodes from the Episodes list, and delete speaker profiles with a usage-aware confirmation.

## Locked decisions (user-interviewed, do not re-litigate)

1. **One smart Apply button.** Server decides: if the target profile is shared with another podcast or another podcast's episodes → auto-create a new profile for this podcast; otherwise update in place. New hosts propagate to this podcast's existing episodes automatically. No confirm dialogs, no "Apply to new profile" button.
2. **Episode delete: the row disappears entirely** — episode files deleted AND the planned entry removed from `plan.episodes`.
3. **Speaker profile delete: delete + repoint.** Confirmation shows usage ("hosts for podcast X and N episodes"). On confirm: profile deleted, referencing podcasts/formats fall back to another profile, episodes keep their frozen voice snapshot (existing audio stays playable).
4. **Proposal cards show a readable summary** (e.g. "Hosts: Sofia — serious lead; Marco — dad jokes"). The raw JSON dump dies.

## Key code facts (verified)

- `applyPlannerChatProposal` — src/app.mjs:3525. speakerProfile branch at 3556-3571: `createNew` body flag creates+repoints; update mutates in place. `createNew` gate at 3540. Appends a system "Applied … proposal." message at 3621 but never marks the assistant message itself.
- `sanitizePlannerProposal` speakerProfile branch — src/app.mjs:3448-3458; target fallback chain `targetId → plan.speakerProfileId → speakerProfiles[0]`. `assistantReferenceImpact` (3436) counts plans by `speakerProfileId` and episodes by **snapshot** id.
- `saveEpisodeFromBody` — src/app.mjs:1397-1398: `speakerProfileId` override resolution `(speakerProfileId || episodeProfile.speakerProfileId)`; persists override; re-snapshots profiles. Audio invalidation on host change is free via `reconcileEpisodeContent` / `ttsProfileSignature`.
- `createPlanEpisodesRequest` — src/app.mjs:1337-1372; the `saveEpisodeFromBody` call at 1360 omits `speakerProfileId` (bug).
- Routes: episodeMatch table src/app.mjs:937-947 (no DELETE); planMatch has `PUT /api/plans/:id` → `updatePlanRequest` (931) — usable for removing planned rows client-side.
- Jobs: job objects carry `episodeId` + `status` (src/app.mjs:1663). Copy the active-job guard pattern from `deleteKnowledgeBase` (src/app.mjs:996-997). Multi-file write+rollback pattern exists at src/app.mjs:1008-1016.
- Frontend apply: `applyAssistantProposal` index.html:2674-2688; card render with three buttons + JSON blob in `renderPlannerChatMessages` index.html:2593-2613 (buttons at 2606-2607); delegation at 2709-2711.
- Existing client-side `deleteSpeakerProfile` handler — index.html:2397-2404: filters from state, blocks if any format references it, defers to Save. Will be rewritten.
- Episodes list: `episodeRowHtml` index.html:1733-1748; delegation index.html:2425-2438.
- Speakers form loader: `loadSpeakerForm(id)` exists (used at index.html:2656).
- Wholesale `PUT /api/profiles` (src/app.mjs:853) + `assertProfilesCompatibleWithEpisodes` (2384) stay as-is; the new DELETE endpoint bypasses them with its own cascade.
- Test trap: `test/app.test.mjs` has one giant HTML-regex test (`browser model fields and loading surfaces are present`, ~line 1714). Every UI string change breaks it — update assertions with the diff open, not from memory.

## Phases

Executor: locate by FIND strings, never line numbers. Files: `src/app.mjs`, `public/index.html`, `test/app.test.mjs`. Run `npm test` after phases 3, 5, 7.

### Phase 1 — Backend: episodes follow the podcast's hosts

1. `createPlanEpisodesRequest` (FIND `saveEpisodeFromBody(context.paths, { name: target.episode.title`): add `speakerProfileId: plan.speakerProfileId,` to the body object. Newly created episodes now carry an explicit hosts override matching the podcast.
2. Smart apply — rewrite the speakerProfile branch of `applyPlannerChatProposal` (FIND `if (proposal.mode === "create" || createNew)`):
   - Delete the `createNew` body flag, its gate (FIND `createNew is only supported`), and the `body.createNew` read. Ignore any stray `createNew` in old client requests (just don't read it).
   - Compute `const target` = the sanitized proposal's target profile (sanitize already resolved it); `const oldSpeakerId = plan.speakerProfileId`.
   - `sharedElsewhere` = any OTHER plan in the plan index has `speakerProfileId === target.id`, OR any episode NOT belonging to this plan (`!plan.episodes.some(e => e.createdEpisodeId === episode.id)`) references it via `episode.speakerProfileId === target.id || episode.speakerProfile?.id === target.id`. Load episodes via existing `listEpisodes`.
   - `proposal.mode === "create" || sharedElsewhere` → create new profile (`randomUUID()` id, keep existing name-collision `" — Copy"` suffix logic only when name collides with the source), push, repoint `result.plan.speakerProfileId`. Else → update in place at `targetId` (existing code).
   - **Propagate** after profiles + plan are saved: for each `plan.episodes[].createdEpisodeId`, load the episode; if `!episode.speakerProfileId || episode.speakerProfileId === oldSpeakerId || episode.speakerProfileId === target.id` → `saveEpisodeFromBody(paths, { ...episode, speakerProfileId: <applied profile id> })` (re-snapshots hosts, invalidates stale audio). Episodes with a deliberate different per-episode override are left alone. Count them: `result.updatedEpisodes = n`.
3. Applied state: in `applyPlannerChatProposal` before `saveChatThread` (FIND `thread.messages.push({ role: "system", content: \`Applied`), also set `message.appliedAt = new Date().toISOString();` on the assistant message being applied.
4. `sanitizePlannerProposal` speakerProfile impact (FIND `assistantReferenceImpact`): replace with `impact = { episodes: plan.episodes.filter((item) => item.createdEpisodeId).length }` — the frontend info line becomes "updates hosts on N episode(s)". Remove the now-unused plans-count path for speakerProfile only (keep `assistantReferenceImpact` if episodeFormat still uses it; if nothing uses it, delete the function).
5. `PLANNER_CHAT_SYSTEM_PROMPT` (FIND `speakerProfile` inside the prompt): adjust guidance — propose `mode:"create"` when defining hosts for a new podcast, `mode:"update"` to tweak the podcast's current hosts; note that applying host changes updates all of this podcast's episodes automatically. KEEP the exact substring "content planning assistant" (test detects it).

### Phase 2 — Backend: DELETE /api/episodes/:id

1. Route (FIND `if (method === "PATCH" && !action) return serializeMutation(context, () => renameEpisodeRequest`): add `if (method === "DELETE" && !action) return serializeMutation(context, () => deleteEpisodeRequest(res, context, id));`
2. `deleteEpisodeRequest(res, context, id)`:
   - 404 if `episode.json` missing (reuse `loadEpisode` or `exists`).
   - 409 `conflict("Wait for the episode's active job to finish.")` if any job in the jobs registry has `job.episodeId === id` and status queued/running (copy the guard shape from `deleteKnowledgeBase`).
   - `rm(episodeDir(context.paths, id), { recursive: true, force: true })`.
   - For every plan (via `listPlans` + `loadPlan`): if `plan.episodes.some(e => e.createdEpisodeId === id)` → `plan.episodes = plan.episodes.filter(e => e.createdEpisodeId !== id)` (row disappears), bump `updatedAt`, `savePlan`.
   - Respond `{ id, deleted: true }`.

### Phase 3 — Backend: DELETE /api/speaker-profiles/:id (cascade)

1. Route: new match `const speakerMatch = path.match(/^\/api\/speaker-profiles\/([a-zA-Z0-9_-]+)$/);` with `if (method === "DELETE") return serializeMutation(context, () => deleteSpeakerProfileRequest(res, context, id));`
2. `deleteSpeakerProfileRequest`:
   - 404 if no speaker profile with that id.
   - 400 `badRequest("At least one host profile must remain.")` if it is the last one.
   - `fallback` = first remaining profile.
   - Cascade: remove the profile from `speakerProfiles`; every `episodeProfiles[]` entry with `speakerProfileId === id` → `fallback.id`; every plan with `speakerProfileId === id` → `fallback.id` (bump `updatedAt`, save). Use the existing multi-file write+rollback pattern (FIND `const applied = []`) so a failed plan save restores profiles.
   - Episodes untouched (frozen snapshots keep rendering/playing).
   - Respond `{ id, deleted: true, fallbackId: fallback.id, repointedPlans: n, repointedFormats: n }`.

### Phase 4 — Frontend: smart apply, applied state, readable cards

In `public/index.html`, `renderPlannerChatMessages` (FIND `const sharedSpeaker =`):
1. Delete `sharedSpeaker`, the `newProfileButton` (`data-create-new`), and the "Update shared profile" label logic. Buttons become: `<button class="primary" data-apply-assistant="i" data-continue="false">Apply</button>` plus the existing `Apply & <next>` when `nextStep` exists.
2. Impact line for speakerProfile: `proposal.impact?.episodes` → `Updates hosts on N episode(s) of this podcast — stale audio will re-render.` Other types keep no impact line.
3. Applied state: if `message.appliedAt`, render the card with the summary + `<div class="assistant-impact">✓ Applied</div>` and NO buttons. (Old threads without the field keep buttons — acceptable.)
4. Readable summary — new `summarizeProposal(type, proposal)` returning escaped HTML lines, replacing the `JSON.stringify` blob (FIND `chat-proposal-diff`):
   - `speakerProfile`: profile name, then one line per `value.speakers[]`: `Name — <first sentence of personality or style>`; voice model if set.
   - `planPatch`: `Label: value` per present key (Name/Theme/Audience/Goal/Episodes/Language/Minutes…).
   - `episodeFormat`: name, language, target minutes, models.
   - `plannedEpisodePatches`: one line per patch: episode title (resolve id against `activePlan.episodes`) + changed fields.
   - `episodePatch`: episode name + list of changed field labels.
   - Unknown type → fall back to compact `JSON.stringify` (single-line).
5. `applyAssistantProposal` (FIND `async function applyAssistantProposal`): drop the `createNew` parameter and the shared-impact `confirm()`; after apply, if `data.appliedType === "speakerProfile"` call `loadSpeakerForm(data.plan?.speakerProfileId || activePlan.speakerProfileId)` so the Hosts view shows the new profile; notify `Hosts applied — updated ${data.updatedEpisodes ?? 0} episode(s).` for speakerProfile, else keep "Proposal applied." Delegation (FIND `apply.dataset.createNew`): drop the third argument.

### Phase 5 — Frontend: delete episode rows + delete host profile

1. `episodeRowHtml` (FIND `function episodeRowHtml`): add a `Delete` button — `data-delete-episode="<id>"` on created rows, `data-delete-planned="<plannedId>"` on uncreated planned rows.
2. `#episodeList` click delegation (FIND `data-create-planned`):
   - `data-delete-episode`: `confirm(\`Delete "<name>"? Script and audio files will be removed.\`)` → `api(\`/api/episodes/${id}\`, { method: "DELETE" })` → if `currentEpisode?.id === id` clear `currentEpisode` → `await refreshState()` + reload active plan (`loadPlan(activePlanId, true)` or existing refresh path) → `notify("Episode deleted.", "ok")`.
   - `data-delete-planned`: `confirm("Remove this planned episode?")` → remove the entry from `activePlan.episodes` → `PUT /api/plans/:id` with the plan body (existing `saveActivePlan()` if present, else direct `api` call) → `renderEpisodeList()`.
3. Rewrite the `deleteSpeakerProfile` listener (FIND `Speaker Profile is used by an Episode Format.`):
   - Compute usage client-side: podcasts from the plan index (`GET /api/plans` result cached in `planIndex`/`refreshPlanIndex` — plans with `speakerProfileId === activeSpeakerProfileId`), episodes from `state.episodes` (`episode.speakerProfileId === id || episode.speakerProfile?.id === id`).
   - Block only when it's the last profile: `notify("At least one host profile must remain.", "error")`.
   - Confirm: used → `\`"<name>" is hosts for <podcastNames or "N podcast(s)"> and <m> episode(s). Episodes keep their current audio; affected podcasts switch to "<fallback name>". Delete?\``; unused → `\`Delete host profile "<name>"?\``.
   - `api(\`/api/speaker-profiles/${id}\`, { method: "DELETE" })` → `refreshState()` → reload profile form to fallback (`loadSpeakerForm(state.profiles.speakerProfiles[0].id)`), refresh plan index + `loadPlan(activePlanId, true)` if the active plan was repointed → notify. Delete the old client-side filter/`profilesDirty` logic.

### Phase 6 — Tests (`test/app.test.mjs`)

Server tests:
- Smart apply: (a) proposal `mode:"update"` targeting a profile shared by another plan → apply creates a NEW profile, repoints the plan, and the plan's created episodes get `speakerProfileId` = new id with `speakerProfile.id` snapshot updated and `audioReady === false` when audio existed; (b) update targeting the podcast's own unshared profile → in-place update, same propagation; (c) the applied assistant message gains `appliedAt`.
- `create-episodes` now stamps `episode.speakerProfileId === plan.speakerProfileId`.
- DELETE `/api/episodes/:id`: 200 removes the directory AND the planned row from the plan; 404 unknown id.
- DELETE `/api/speaker-profiles/:id`: repoints referencing plan + format to the fallback and deletes; 400 when deleting the last profile; 404 unknown.
- Remove/adjust any test posting `createNew: true` to `/api/plans/chat/apply`.

HTML-regex test (FIND `browser model fields and loading surfaces are present`) — with the diff open:
- Remove asserts for `data-create-new`, "Apply to new profile", "Update shared profile", `Speaker Profile is used by an Episode Format.` (if asserted).
- Add: `data-delete-episode`, `data-delete-planned`, `function summarizeProposal`, `appliedAt`, `✓ Applied` (or the exact applied-state string used).

### Phase 7 — Handdown + verification

1. Copy this plan to repo `plan.md` (user's handdown convention). Do NOT commit (git only on explicit request).
2. `npm test` green.
3. Manual smoke against the user's real broken data (`data/` in repo): start `node server.mjs` →
   - Episodes list shows Delete buttons; deleting one removes the row and its folder.
   - Hosts view: delete the 8 duplicate "Fable 5 Gossip Duo" profiles — confirmation names the podcast for the one in use; podcast repoints; last-profile delete blocked.
   - In the existing chat, the old hosts proposal card (no `appliedAt`) renders the readable summary; pressing Apply once updates `plan.speakerProfileId` AND all 12 episodes' hosts (Hosts dropdowns show Sofia/Marco, audio chips clear), card flips to "✓ Applied".
   - New podcast flow: describe idea → hosts proposal → single Apply → episodes created with the right hosts from the start.

## Risks

- Propagation overwrites per-episode host overrides that happen to equal the plan's old profile — by design (they were following the podcast). Deliberate different overrides are preserved.
- Old chat threads keep live Apply buttons (no `appliedAt`); re-applying is now idempotent-ish (update mode) but a `create` proposal re-applied still makes another profile — acceptable, user can delete it.
- `deleteEpisodeRequest` scans all plans; fine at this scale (`// ponytail:` linear scan, index it if plans ever number in the hundreds).
- HTML-regex test block breaks on any string drift — update with the diff open.
