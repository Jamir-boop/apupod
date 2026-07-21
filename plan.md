# Archived: pod-god format workflow, config reactivity, Responses API + effort

> Status: implemented in v0.14.0. Retained as historical design context; line references and execution instructions below are archival.

## Context

User's new podcast silently inherited the previous podcast's episode format (`episode-chisme-crianza`: wrong description, `es-419`, 18 min) — script generation produced "Transcript is too short: 1483 words. Recommended minimum is 2250 words for 18 minutes." Root causes: format is invisible in the chat workflow, `sanitizePlannerProposal` episodeFormat target falls back to another podcast's format, and format apply never propagates to created episodes (same gap hosts had). Separately: model selectors go stale after Config saves (`saveConfig` skips `renderChatControls` + episode-settings repopulate), and user wants OpenAI Responses API for gpt-5.5/5.6 with reasoning-effort control.

## Locked decisions (user-interviewed, do not re-litigate)

1. **Workflow: describe idea → hosts → format → episodes → scripts → audio. Hard gate**: planPatch apply no longer chains straight to generatePlan; assistant chains planPatch → speakerProfile → episodeFormat → then nextStep "generatePlan". Gate is prompt-level; server keeps generatePlan auto-format fallback. episodeFormat gets the same smart-apply as hosts (sharedElsewhere → " — Copy", propagate to created episodes).
2. **New Format view** in nav (Chat | Hosts | Format | Episodes | Script | Audio): name, description, language, target minutes, outline model+effort, transcript model+effort; save via wholesale `saveProfiles()`. **Script view keeps only** `#episodeHosts` + `#buildEpisodeProfile` (connect); `#epLanguage/#epMinutes/#epOutlineModel/#epTranscriptModel` die.
3. **Config reactivity**: one `renderModelSelectors()` funnel called from `loadModelCatalog` AND `saveConfig` repopulates every model-dependent surface without reload.
4. **Responses API, name heuristic**: `/^gpt-5\.(5|6)/` on the built-in openai connection (`compatible.connectionId === "openai"`) → `POST {llmBaseUrl}/responses`; everything else stays `/chat/completions`. No config toggle.
5. **Effort pills** (user round 2): levels are model-dependent, API does NOT enumerate them — hardcoded map: gpt-5.6* → none/low/medium/high/xhigh/max; gpt-5.5* → none/low/medium/high/xhigh; "(default)" omits param. Persist beside each model field: `plan.planningEffort` (chat pill), `format.outlineEffort` + `format.transcriptEffort` (Format view; script-generator pill sets transcriptEffort). Pill hidden for non-Responses models.

## Key code facts (verified)

- `callTextModel` src/app.mjs ~2032; dispatch via `parseCompatibleModelId` (584); `callCompatibleChat` (2310) uses `fetchJsonWithBody`, `compatibleConnection(context, id)`, `connection.requiresApiKey`, Bearer from `process.env[connection.apiKeyEnv]`. Callers: `generateOutline` (profile.outlineModel), `generateTranscript` (profile.transcriptModel), `generatePlanRequest` (plan.planningModel), planner chat send + corrective retry.
- episodeFormat proposal exists: `sanitizePlannerProposal` target fallback `find(targetId) || episodeProfiles[0]` (the leak); `applyPlannerChatProposal` episodeFormat branch repoints plan + planned rows but NOT created episode.json files. speakerProfile smart-apply branch (sharedElsewhere, " — Copy", followIds propagation loop, `result.updatedEpisodes`, generic `message.appliedAt`) is the template to mirror.
- `saveEpisodeFromBody` re-snapshots + `reconcileEpisodeContent(..., {strictTranscript:false})` invalidates stale audio for free.
- PLANNER_CHAT_SYSTEM_PROMPT: MUST keep exact substring "content planning assistant" (test stub keys on it) and keep the recent hosts rule line unchanged.
- Frontend: `modelCatalog` module-level (index.html ~670), populated by `loadModelCatalog()` (~993); `saveConfig()` (~1694) refreshes catalog from PUT response but re-renders only ConfigView/ProfileOptions/BuildOptions/TtsView — the bug. `renderChatControls()` (~1760) fills `#plannerChatModel`; `renderEpisodeSettingsFields()` (~1624) fills ep settings. `setView` aliases `formats: "transcript"` (876), `legacyTargets` same (2857), steps array `["Hosts", hasEpisodes, "speakers"]` (946), `chatPillModel` pattern (1774, 2909).
- Tests: version asserts pin `0.13.3` (bump to `0.14.0` via `npm version 0.14.0 --no-git-tag-version`); planner test has "Improve this format" stub (test/app.test.mjs:1539) targeting `episode-chisme-crianza`, in-place asserts at 1617-1618, holder plan created after (1619). HTML-regex test ~1765 — update with diff open.

## Phases

Executor: locate by FIND strings, never line numbers. Run `npm test` after phases 2, 5, 6.

### Phase 1 — Backend: hard gate prompt, episodeFormat smart-apply + propagation (src/app.mjs)

1. **Prompt rewrite** (FIND `const PLANNER_CHAT_SYSTEM_PROMPT`). Keep "content planning assistant" substring and the hosts rule line. Replace the rule `- Propose the podcast via planPatch ... with nextStep action "generatePlan". Applying it creates the episode list and episode drafts in one step...` and the rule `- Host profiles and episode settings (language, duration, models) are optional refinements, never prerequisites...` with:
   ```
   - Workflow order is fixed: 1) planPatch (theme, audience, goal, episodeCount) with no nextStep action, 2) speakerProfile (the hosts), 3) episodeFormat, 4) nextStep action "generatePlan" to create the episode list and drafts. Never attach action "generatePlan" to the planPatch proposal; after the plan is applied, propose the hosts, then the Episode Format, then suggest generatePlan.
   - episodeFormat: use mode "create" for a new podcast; fill name, description, language, targetMinutes, outlineModel, and transcriptModel from the user's idea and AVAILABLE OPTIONS. Use mode "update" to tweak this podcast's current format. Applying a format proposal automatically updates all of this podcast's episodes; stale audio re-renders.
   - If the user explicitly says defaults are fine, you may skip the speakerProfile/episodeFormat proposals and go straight to nextStep "generatePlan".
   ```
   Append to the speakerProfile rule (FIND `- speakerProfile: use mode "create"`): `After the hosts proposal is applied, your next reply must propose the episodeFormat.`
2. **Target fallback fix** (FIND `item.id === raw?.targetId) || profiles.episodeProfiles[0]` in the episodeFormat sanitize branch): insert `|| profiles.episodeProfiles.find((item) => item.id === plan.episodeFormatId)` before the `[0]` fallback.
3. **Smart-apply** — episodeFormat branch of `applyPlannerChatProposal` (FIND its `parsed.proposal.episodeFormat`), mirror speakerProfile branch:
   - `sharedElsewhere` = any other plan (full `loadPlan` of `listPlans` entries) has `episodeFormatId === targetId` or a planned row `episodeProfileId === targetId`, OR any episode outside this plan (`!ownEpisodeIds.has(id)`) has `episodeProfileId === targetId || episodeProfile?.id === targetId`.
   - `mode === "create" || sharedElsewhere` → new profile (`randomUUID()`, " — Copy" suffix on name collision with source), push; else in-place merge at targetId (existing code).
   - **Repoint plan + planned rows with followIds guard** (do NOT blanket-rewrite — per-row format overrides from plannedEpisodePatches must survive): `followIds = new Set(["", plan.episodeFormatId, targetId])`; `plan.episodeFormatId = appliedId`; each planned row with `followIds.has(row.episodeProfileId || "")` → `episodeProfileId = appliedId`. `// ponytail: rows with a deliberate different format are left alone`.
4. **Propagation to created episodes** — generalize the existing block (FIND `if (result.appliedType === "speakerProfile") {` with the followIds loop): extend to `|| result.appliedType === "episodeFormat"`, field = `speakerProfileId` vs `episodeProfileId`, followIds seeded from old `plan.speakerProfileId` / `plan.episodeFormatId` + targetId + "". `saveEpisodeFromBody(paths, { ...episode, [field]: result.appliedId })`, `result.updatedEpisodes`. `savePlan` change-detection already covers repoints.
5. **Whitelists gain "format"**: `normalizeAssistantContext` view list, `sanitizeAssistantNextStep` targets set + its `legacyTargets` map `formats: "format"`, `assistantState.availableOptions.targets`.

### Phase 2 — Backend: Responses API + effort plumbing (src/app.mjs)

1. Next to `compatibleModelId`:
   ```js
   const EFFORT_LEVELS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
   function normalizeEffort(value) { const effort = String(value || "").trim(); return EFFORT_LEVELS.has(effort) ? effort : ""; }
   function effortLevelsForModel(rawModelId) {
     const id = String(rawModelId || "");
     if (/^gpt-5\.6/.test(id)) return ["none", "low", "medium", "high", "xhigh", "max"];
     if (/^gpt-5\.5/.test(id)) return ["none", "low", "medium", "high", "xhigh"];
     return [];
   }
   function usesResponsesApi(rawModelId) { return /^gpt-5\.(5|6)/.test(String(rawModelId || "")); }
   ```
2. `callOpenAiResponses(context, compositeModelId, { system, prompt, maxTokens, effort }, timeoutMs)` after `callCompatibleChat`, same connection/apiKey/`fetchJsonWithBody` shape, URL `${connection.llmBaseUrl || connection.baseUrl}/responses`, body `{ model, instructions: system, input: prompt, max_output_tokens: maxTokens, text: { format: { type: "json_object" } }, ...(effort && effortLevelsForModel(parsed.modelId).includes(effort) ? { reasoning: { effort } } : {}) }` — `// ponytail: no temperature/top_p — reasoning models reject them`. Parse `data.output_text` with fallback walk of `data.output[].content[]` for `type === "output_text"`; throw if empty. Return shim `{ choices: [{ message: { content: text } }] }` so callers stay untouched.
3. `callTextModel` gains `effort` param; inside the compatible branch, before payload build: `if (compatible.connectionId === "openai" && usesResponsesApi(compatible.modelId)) return callOpenAiResponses(...)`. `// ponytail: Responses only for built-in openai; compatible connections stay on chat/completions`.
4. Pass effort at all four call sites: generateOutline `effort: profile.outlineEffort`, generateTranscript `effort: profile.transcriptEffort`, generatePlanRequest + planner chat send AND its corrective retry `effort: plan.planningEffort`.
5. Fields: `normalizePlanInput` add `planningEffort: normalizeEffort(raw.planningEffort)`; `sanitizePlanPatch` key list add `"planningEffort"`; `validateProfileData` episode-profile loop add `profile.outlineEffort = normalizeEffort(...)` + `profile.transcriptEffort = ...`; `sanitizeProposalEpisode` accept `outlineEffort`/`transcriptEffort` strings via normalizeEffort. `// ponytail: lenient — model-specific validity enforced at call time`.

### Phase 3 — Frontend: Format view, nav/steps, Script strip (public/index.html)

1. **`#view-format` markup** before `#view-transcript`, mirroring Hosts view header/panel pattern: `#saveFormat` (primary, disabled), `#formatSelect`, `#fmtName`, `#fmtDescription` (textarea), `#fmtLanguage`, `#fmtMinutes` (number 5-60), `#fmtOutlineModel` + `#fmtOutlineEffort`, `#fmtTranscriptModel` + `#fmtTranscriptEffort`. Id is `view-format` singular (test has `doesNotMatch /id="view-formats"/`). No create/duplicate/delete buttons — assistant creates formats.
2. **JS** next to `loadSpeakerForm`: frontend `effortLevelsForModel(modelId)` (only for ids starting `compat:openai:`, strip prefix, same map), `effortOptions(modelId, selected)` with leading `("", "(default)")`, `activeFormat()` (tracks `activeEpisodeProfileId`, defaults to first), `renderFormatView()` (fills all fields, hides effort labels when list empty), `syncFormatForm()` (reads fields back into the format object; guard against unrendered form). Wire: `saveProfiles()` calls `syncFormatForm()` beside `syncSpeakerForm()` and re-renders `renderFormatView()`; `refreshState` same pattern; listeners — `#saveFormat` click → `saveProfiles`, `#formatSelect` change → sync + switch + re-render, `#view-format` input → `profilesDirty = true` + `updateSaveButtons()`, model selects change → sync + re-render (effort options follow model). Mirror `$("saveProfiles").disabled` logic for `#saveFormat` in `updateSaveButtons`.
3. **Routing**: `setView` aliases `formats: "format"`; valid list adds `"format"`; `if (selected === "format") renderFormatView();`. `openAssistantTarget` legacyTargets `formats: "format"`.
4. **Assistant steps**: after `["Hosts", hasEpisodes, "speakers"],` insert `["Format", hasEpisodes, "format"],`; insert the paired nextSteps entry after the hosts one: `{ text: "Optional: review the episode format — language, duration, models.", target: "format", highlight: "#saveFormat", go: "Open Format" },`.
5. **Script strip**: in `<details id="episodeSettings">` delete the `#epLanguage/#epMinutes/#epOutlineModel/#epTranscriptModel` labels, keep `#episodeHosts` + `#buildEpisodeProfile` + `#saveEpisodeSettings`, summary → `Episode settings — hosts and format`. `renderEpisodeSettingsFields()` keeps only the hosts line + the Phase 5 transcript-effort lines. `saveEpisodeSettings()` simplifies to `saveEpisode()` + notify (format editing moved).

### Phase 4 — Frontend: config/model-catalog reactivity (public/index.html)

New funnel near `renderModelStatus`:
```js
function renderModelSelectors() {
  // ponytail: one funnel for every model-dependent surface; add new selectors here only
  renderModelStatus();
  if (!state) return;
  syncSpeakerForm(); syncConfigForm(); syncFormatForm();
  renderProfileOptions(); renderBuildOptions(); renderChatControls();
  renderEpisodeSettingsFields(); renderFormatView(); renderConfigView(); renderTtsView(); renderJobIndicators();
}
```
`loadModelCatalog` replaces its render block with `renderModelSelectors()`; `saveConfig` replaces its four render calls with `renderModelSelectors()` (keep `configDirty = false` before). This is the fix for "models added in Config don't appear until reload".

### Phase 5 — Frontend: effort pills (public/index.html)

1. **Chat**: label+select `#plannerChatEffort` (wrapped in `#plannerChatEffortLabel`, hidden) after the `#plannerChatModel` label in `#chatControlsPanel`; pill `#chatPillEffort` (hidden) after `#chatPillModel`. `renderChatControls` fills effortOptions from `activePlan?.planningEffort`, toggles label hidden. `updateChatPills` toggles pill hidden + textContent. `capturePlanDraft` adds `plan.planningEffort = $("plannerChatEffort").value;`. `#plannerChatModel` change re-renders effort options; `#plannerChatEffort` change → `updateChatPills`; `#chatPillEffort` click mirrors `chatPillModel`'s open-panel-and-focus handler. Persists via existing plan save paths — no new endpoint.
2. **Script generator**: `#transcriptEffort` (in `#transcriptEffortLabel`, hidden) beside `#generateTranscript`. Populated in `renderEpisodeSettingsFields` from the connected format's transcriptModel/transcriptEffort. Change handler sets `format.transcriptEffort` + `await saveProfiles()` — `// ponytail: wholesale PUT on change; fine for a pill`.
3. Format view efforts already in Phase 3.

### Phase 6 — Tests (test/app.test.mjs) + version

Bump `npm version 0.14.0 --no-git-tag-version`; update the three version asserts from `0.13.3`.

1. **episodeFormat smart-copy + propagation** in the planner test:
   - fetchImpl branch `prompt.includes("Improve shared format")` → episodeFormat mode update targeting `episode-chisme-crianza`, value `{ description: "Shared format revised.", language: "en-US" }`.
   - Existing "Improve this format" apply (runs before holder plan exists): add asserts `updatedEpisodes === 2` and `plan.episodeFormatId === "episode-chisme-crianza"` (new repoint behavior) near existing asserts at the `appliedFormat` block.
   - New block between holder-plan creation and its DELETE: chat "Improve shared format" + apply → appliedType `episodeFormat`; new " — Copy" profile with revised description and new id; original `episode-chisme-crianza` description still "Focused by the Podcast Assistant"; `applied.plan.episodeFormatId === copy.id` and planned rows repointed; `updatedEpisodes === 2`; on-disk episode.json has `episodeProfileId === copy.id` and `episodeProfile.id === copy.id`; holder plan untouched; message `appliedAt` set.
2. **Responses API test** — clone harness of `test("built-in OpenAI discovers models and uses chat plus TTS endpoints")` (env save/restore): fetchImpl serves `/models` (`gpt-5.6`, `gpt-4o-mini`), `/responses` returning `{ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(<valid plan JSON>) }] }] }` (exercises fallback walk), records `/chat/completions`. Plan with `planningModel: "compat:openai:gpt-5.6"`, `planningEffort: "high"` → generate 200; assert recorded `/responses` call: URL ends `/responses`, Bearer header, body `model === "gpt-5.6"`, numeric `max_output_tokens`, `reasoning.effort === "high"`, `text.format.type === "json_object"`, `temperature === undefined`, `top_p === undefined`, `instructions` string, prompt in `input`. Negative: `compat:openai:gpt-4o-mini` generate hits `/chat/completions`, never `/responses`.
3. **Effort roundtrips**: PUT profiles with `outlineEffort: "max"`, `transcriptEffort: "nope"` → saved `"max"` / `""` (extend the Episode Formats segments test); plan PUT `planningEffort: "high"` persists, `"bogus"` → `""` (extend plan CRUD test).
4. **HTML-regex test** (with diff open): REMOVE the `#epOutlineModel`/`#epTranscriptModel`/`#epLanguage` select asserts; EXTEND the existing `doesNotMatch /id="epSegments"|.../ ` alternation with `|id="epOutlineModel"|id="epTranscriptModel"|id="epLanguage"|id="epMinutes"`; ADD matches for `id="view-format" class="view" hidden`, `id="formatSelect"`, `fmtName/fmtDescription/fmtLanguage/fmtMinutes/fmtOutlineModel/fmtOutlineEffort/fmtTranscriptModel/fmtTranscriptEffort`, `id="saveFormat"`, `"Format", hasEpisodes, "format"`, `id="plannerChatEffort"`, `id="chatPillEffort"`, `id="transcriptEffort"`, `function effortLevelsForModel\(modelId\)`, `function renderModelSelectors\(\)`, `Episode settings — hosts and format`. Verified safe: `view-format` doesn't trip `doesNotMatch /id="view-formats"/`; Format step uses `data-assistant-target`, not `data-view`.

### Phase 7 — Handdown + verification

1. Copy this plan to repo `plan.md`. NO git commits (explicit request only).
2. `npm test` green.
3. Manual smoke (`node server.mjs`, real `data/`):
   - New chat: planPatch card has no "Apply & create episodes"; chain hosts → format (fields filled from idea) → generatePlan. No `episode-chisme-crianza` leakage in profiles.json.
   - Format propagation: change format language via chat on a podcast with created episodes → episode.json repointed + snapshot updated + audio stale; shared format → " — Copy".
   - Format view at `#format`: edit + Save → persists; Script view shows only Hosts + Format selectors.
   - Config reactivity: toggle model active, Save → `#plannerChatModel` + Format view models + TTS selectors update without reload.
   - Responses (needs OPENAI_API_KEY + gpt-5.5/5.6 active): effort pill appears with correct levels, chat/script hit `/responses`; other models hide pill, hit `/chat/completions`; "(default)" omits `reasoning`.

## Risks

- Hard gate is prompt-level; a non-compliant model could still chain generatePlan early — smart-copy + target-fallback fix are the server-side net against wrong-format leakage.
- gpt-5.5/5.6 effort lists hardcoded from docs (API doesn't enumerate them); unknown future values need a map edit. `// ponytail:` comment at the map.
- `plan.planningEffort` may hold a stale value after switching to a non-Responses model — harmless, ignored at call time.
- HTML-regex test breaks on any string drift — update with the diff open.
