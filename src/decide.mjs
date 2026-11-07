// Deterministic Jev candidates built from the live workspace. Jev picks only from these options; nothing here calls a text model.
import { decideAssistantConfiguration, enforceJevSelections } from "./jev.mjs";
import { badRequest, oneLine } from "./util.mjs";
import { MIMO_VOICES, OPENAI_VOICES, parseCompatibleModelId, compatibleConnection, availableModelIds, isElevenLabsModel, modelLanguageError, modelRuntimeSnapshot } from "./providers/catalog.mjs";
import { OPENAI_TTS_NO_INSTRUCTIONS, fetchElevenLabsVoices, fetchChatterboxVoices } from "./providers/generate.mjs";
import { isActiveJob, loadEpisode, loadPlan, readJson } from "./store.mjs";

export const JEV_TUNING_FIELDS = ["chatterboxExaggeration", "chatterboxCfgWeight", "chatterboxTemperature", "mimoTemperature", "mimoTopP", "mimoInstructionPreset", "mimoInstructionText", "elevenlabsStability", "elevenlabsSimilarityBoost", "elevenlabsStyle", "elevenlabsSpeed", "elevenlabsUseSpeakerBoost", "elevenlabsSeed", "elevenlabsTextNormalization"];

// Voices per active TTS model. A provider that is not ready, or whose discovery fails, offers no voices.
export async function voiceCatalog(context, profiles, fresh = false) {
  const voices = new Map();
  let eleven = [];
  let chatterbox = [];
  if (context.modelCatalog.providers.elevenlabs.status === "ready") {
    try { eleven = (await fetchElevenLabsVoices(context, 5_000)).voices; } catch {}
  }
  if (context.modelCatalog.providers.chatterbox.status === "ready") {
    try { chatterbox = await fetchChatterboxVoices(context, 2_000, !fresh); } catch {}
  }
  for (const model of availableModelIds(context).ttsModels) {
    const parsed = parseCompatibleModelId(model);
    const provider = model === "mimo-v2.5-tts" ? "mimo" : isElevenLabsModel(context, model) ? "elevenlabs" : parsed && compatibleConnection(context, parsed.connectionId)?.kind || "compatible";
    const items = provider === "mimo" ? MIMO_VOICES.map((id) => ({ id, name: id }))
      : provider === "elevenlabs" ? eleven : provider === "chatterbox" ? chatterbox
        : provider === "openai" ? OPENAI_VOICES.filter((id) => !OPENAI_TTS_NO_INSTRUCTIONS.has(parsed.modelId) || ["alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer"].includes(id)).map((id) => ({ id, name: id }))
          : profiles.speakerProfiles.flatMap((profile) => profile.speakers.filter((speaker) => (speaker.ttsModelOverride || profile.voiceModel) === model).map((speaker) => ({ id: speaker.voiceId, name: speaker.voiceId })));
    voices.set(model, [...new Map(items.filter((voice) => voice.id).map((voice) => [voice.id, voice])).values()]);
  }
  return voices;
}

// The Hosts and Format profiles a decision targets: the focused one in its view, else the plan's, else the first.
export function profileTargets(profiles, plan, activeContext = {}) {
  const speakerId = activeContext.view === "speakers" ? activeContext.speakerProfileId : "";
  const formatId = activeContext.view === "format" ? activeContext.episodeProfileId : "";
  if (speakerId && !profiles.speakerProfiles.some((item) => item.id === speakerId)) throw badRequest("The selected Hosts profile no longer exists.");
  if (formatId && !profiles.episodeProfiles.some((item) => item.id === formatId)) throw badRequest("The selected Episode Format no longer exists.");
  return { speakerProfileId: speakerId || plan.speakerProfileId || profiles.speakerProfiles[0]?.id,
    episodeProfileId: formatId || plan.episodeFormatId || profiles.episodeProfiles[0]?.id };
}

export function existingProposalSpeaker(speakers, proposed, index) {
  const name = typeof proposed?.name === "string" ? oneLine(proposed.name) : "";
  const exact = speakers.find((speaker) => name && oneLine(speaker.name) === name);
  if (exact) return exact;
  const matches = speakers.filter((speaker) => name && oneLine(speaker.name).toLowerCase() === name.toLowerCase());
  return (matches.length === 1 ? matches[0] : null) || speakers[index] || speakers[0];
}

function deliveryPresetOptions(model, current = {}, provider = "") {
  return ["natural", "calm", "expressive"].map((id) => {
    const value = model.startsWith("eleven") ? { elevenlabsStability: id === "calm" ? 0.8 : id === "expressive" ? 0.3 : 0.5 }
      : model === "mimo-v2.5-tts" ? { mimoInstructionPreset: id }
        : provider === "chatterbox" ? { chatterboxExaggeration: id === "calm" ? 0.4 : id === "expressive" ? 1 : 0.7, chatterboxCfgWeight: 0.3, chatterboxTemperature: 0.7 } : {};
    return { id, description: `${id} delivery using supported ${model} controls`, value: { ...current, ...value } };
  });
}

/** Candidates callback for decideAssistantConfiguration. `text` is the user's request: exact IDs it names
 * (and IDs it negates) lock or exclude options. `preliminary` asks only the route, profile action, and host count;
 * the full pass needs `proposed` (the proposed value for the route) and `initial` (the preliminary result).
 */
export function jevCandidates({ context, plan, profiles, profileTargets, focusEpisode, knowledge, voiceCatalog, text, proposed = null, preliminary = false, initial = null }) {
  const speakerProfile = profiles.speakerProfiles.find((item) => item.id === profileTargets.speakerProfileId);
  const format = profiles.episodeProfiles.find((item) => item.id === profileTargets.episodeProfileId);
  const models = availableModelIds(context);
  const choices = (items) => items.map((item) => typeof item === "string" ? { id: item, description: item } : { id: item.id, description: item.name || item.id, value: item.value ?? item.id });
  const hostNames = Array.isArray(proposed?.speakers) ? proposed.speakers.map((speaker) => typeof speaker.name === "string" ? oneLine(speaker.name) : "") : [];
  const mentions = (items, speakerName = "", allowSharedModel = false) => {
    const byId = new Map(items.map((item) => [item.id, item]));
    if (!byId.size) return { value: undefined, excluded: [] };
    const ids = [...byId.keys()].sort((left, right) => right.length - left.length).map(RegExp.escape).join("|");
    const tokens = new RegExp(`(?<![\\p{L}\\p{N}_:/.-])(${ids})(?![\\p{L}\\p{N}_:/-]|\\.[\\p{L}\\p{N}_-])`, "gu");
    const positive = new Set();
    const excluded = new Set();
    for (const match of text.matchAll(tokens)) {
      const before = text.slice(0, match.index);
      const clauseStart = [...before.matchAll(/[!?;\n]|\.(?=\s)/g)].at(-1)?.index;
      const prefix = before.slice(clauseStart == null ? 0 : clauseStart + 1);
      if (speakerName) {
        const names = hostNames.slice().sort((left, right) => right.length - left.length).map(RegExp.escape).join("|");
        const afterId = text.slice(match.index + match[1].length);
        if (/^\s+(?:for|para)\b/i.test(afterId)) {
          const assigned = afterId.match(new RegExp(`^\\s+(?:for|para)\\s+(${names})(?![\\p{L}\\p{N}_])`, "u"));
          if (!assigned) throw badRequest("The host choice names an unknown host. Specify a configured host name.");
          const afterHost = afterId.slice(assigned[0].length);
          if (new RegExp(`^\\s*(?:and|y|&|,)\\s+(${names})(?![\\p{L}\\p{N}_])`, "u").test(afterHost)) throw badRequest("The host choice has an ambiguous subject. Specify each host and choice in a separate clause.");
          if (assigned[1] !== speakerName) continue;
        } else {
          const subjects = [...prefix.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_])(${names})(?![\\p{L}\\p{N}_])`, "gu"))];
          const subject = subjects.at(-1);
          const previous = subjects.at(-2);
          const grouped = previous && /^\s*(?:and|y|&|,)\s*$/i.test(prefix.slice(previous.index + previous[1].length, subject.index));
          if (grouped) throw badRequest("The host choice has an ambiguous subject. Specify each host and choice in a separate clause.");
          if (!subject) {
            if (allowSharedModel) continue;
            throw badRequest("The voice choice has no host. Specify each host and voice in a separate clause.");
          }
          if (subject[1] !== speakerName) continue;
        }
      }
      const direction = [...prefix.matchAll(/\b(?:do\s+not\s+(?:use|select|choose|set)?|don't\s+(?:use|select|choose|set)?|avoid(?:\s+using)?|not(?:\s+(?:use|using|select|choose|set))?|no\s+(?:uses|usa|usar|use|quiero)|without|sin|instead\s+of|rather\s+than|use|select|choose|set|usa|usar|elige|selecciona)\b/gi)].at(-1)?.[0] || "";
      if (/^(?:do\s+not|don't|avoid|not|no|without|sin|instead|rather)\b/i.test(direction)) excluded.add(match[1]);
      else positive.add(match[1]);
    }
    const selected = [...positive].filter((id) => !excluded.has(id));
    return { value: selected.length === 1 ? byId.get(selected[0]).value ?? selected[0] : undefined, excluded: [...excluded] };
  };
  const explicit = (items, speakerName = "", allowSharedModel = false) => mentions(items, speakerName, allowSharedModel).value;
  const target = (route) => route === "speakerProfile" ? speakerProfile : route === "episodeFormat" ? format : route === "episodePatch" ? focusEpisode : plan;
  const valueFor = (id, decisions, fields) => {
    const selected = decisions[id];
    if (selected && !["keep_current", "not_requested"].includes(selected)) return selected;
    return fields.find((field) => field.id === id)?.currentValue;
  };
  let fields = [];
  return ({ phase, questionId, route, decisions }) => {
    if (questionId === "route") return choices(["planPatch", "speakerProfile", "episodeFormat", ...(plan.episodes.length ? ["plannedEpisodePatches"] : []), ...(focusEpisode ? ["episodePatch"] : []), "nextStep", "question"]);
    if (questionId === "profileAction") return choices(["create", "update"]);
    if (questionId === "nextAction") return choices(["none", ...(plan.theme || plan.goal ? ["generatePlan"] : []), ...(plan.episodes.some((item) => !item.createdEpisodeId && (item.episodeProfileId || plan.episodeFormatId)) ? ["createEpisodes"] : []), ...(focusEpisode && !isActiveJob(focusEpisode.job) ? ["generateTranscript"] : []), ...(focusEpisode?.status === "transcript_ready" ? ["generateTts"] : []), ...(focusEpisode?.audioReady ? ["openPlayer"] : [])]);
    const current = target(route) || {};
    const selectedLanguage = valueFor("language", decisions, fields) || plan.language || format?.language;
    const language = context.modelCatalog.languages.find((item) => item.id === selectedLanguage);
    const ttsChoices = choices([...models.ttsModels].filter((id) => language && !modelLanguageError(context, id, language)));
    if (phase === "fields") {
      const add = (id, value, options, extra = {}) => {
        const named = options ? mentions(options, extra.speakerName || "", id.endsWith(".ttsModelOverride")) : { value: undefined, excluded: [] };
        const exact = Object.hasOwn(extra, "explicitValue") ? extra.explicitValue : named.value;
        const field = { id, currentValue: exact ?? value, options, ...extra, excludedIds: [...new Set([...named.excluded, ...(extra.excludedIds || [])])] };
        if (exact !== undefined && exact !== null) field.explicitValue = exact;
        else delete field.explicitValue;
        if (field.excludedIds.some((optionId) => options?.find((option) => option.id === optionId)?.value === field.currentValue || optionId === field.currentValue)) {
          delete field.currentValue;
          field.required = true;
        }
        fields.push(field);
      };
      fields = [];
      if (preliminary) {
        if (route === "speakerProfile") {
          fields.push({ id: "speakerCount", label: "number of hosts (1 to 4)", path: ["speakers", "length"], required: true,
            ...(decisions.profileAction === "update" ? { currentValue: speakerProfile.speakers.length } : {}),
            options: [1, 2, 3, 4].map((count) => ({ id: String(count), description: `${count} host(s)`, value: count })) });
        }
        return fields;
      }
      if (["planPatch", "episodeFormat"].includes(route)) {
        add("language", current.language, choices(context.modelCatalog.languages));
        add("speakerProfileId", current.speakerProfileId || "", choices(profiles.speakerProfiles));
        if (route === "planPatch") {
          add("episodeFormatId", current.episodeFormatId || "", choices(profiles.episodeProfiles));
          add("knowledgeBaseId", current.knowledgeBaseId || "", [{ id: "none", value: "", description: "No knowledge base" }, ...choices(knowledge)]);
          const count = text.match(/\b(\d{1,3})\s*(?:episodes?|episodios?)\b/i);
          add("episodeCount", count && Number(count[1]) <= 100 ? Number(count[1]) : current.episodeCount, []);
        }
        const minutes = text.match(/\b(\d{1,2})\s*(?:minutes?|minutos?|min)\b/i);
        add("targetMinutes", minutes && Number(minutes[1]) >= 5 && Number(minutes[1]) <= 60 ? Number(minutes[1]) : current.targetMinutes, []);
      } else if (route === "speakerProfile") {
        add("voiceModel", current.voiceModel, ttsChoices, { required: true, stage: 1 });
        const count = proposed?.speakers?.length || 0;
        if (count < 1 || count > 4 || count !== initial.selections.speakerCount?.value) throw badRequest("The proposed host count does not match the selected count. Ask for the host count again.");
        if (new Set(hostNames).size !== count || hostNames.some((name) => !name || /[:\[\]\r\n]/.test(name))) throw badRequest("The proposed host names are invalid or ambiguous. Ask for a new proposal.");
        for (let index = 0; index < count; index += 1) {
          const base = existingProposalSpeaker(current.speakers, proposed.speakers[index], index);
          const prefix = `speakers.${index}`;
          const speakerName = count > 1 ? hostNames[index] : "";
          add(`${prefix}.ttsModelOverride`, base.ttsModelOverride || "", [{ id: "profile_default", value: "", description: "Use the profile TTS model" }, ...ttsChoices], { stage: 2, speakerName, explicitValue: count > 1 ? explicit(ttsChoices, speakerName, true) : /\boverride\b/i.test(text) ? explicit(ttsChoices) : undefined });
          const model = explicit(ttsChoices, speakerName, true) || base.ttsModelOverride || explicit(ttsChoices) || current.voiceModel;
          const voiceOptions = choices(voiceCatalog.get(model) || []);
          const namedVoice = mentions(voiceOptions, speakerName);
          add(`${prefix}.voiceId`, namedVoice.value ?? base.voiceId, null, { required: true, stage: 3, speakerName, excludedIds: namedVoice.excluded, ...(namedVoice.value !== undefined ? { explicitValue: namedVoice.value } : {}) });
          add(`${prefix}.accent`, base.accent || "", [{ id: "language_default", value: "", description: "Use the language default" }, ...choices([...new Set(context.modelCatalog.languages.map((item) => item.defaultAccent).filter(Boolean))])], { stage: 3 });
          add(`${prefix}.deliveryPreset`, Object.fromEntries(JEV_TUNING_FIELDS.map((key) => [key, base[key] ?? null])), null,
            { label: `host ${index + 1} delivery preset and saved tuning (${JEV_TUNING_FIELDS.join(", ")})`, path: ["speakers", String(index)], merge: true, stage: 3 });
        }
      } else if (route === "episodePatch") {
        for (const [key, options] of [["episodeProfileId", profiles.episodeProfiles], ["speakerProfileId", profiles.speakerProfiles], ["knowledgeBaseId", knowledge]]) add(key, current[key] || "", choices(options));
      } else if (route === "plannedEpisodePatches") {
        for (const [index, patch] of (proposed || []).entries()) {
          const existing = plan.episodes.find((item) => item.id === patch.id);
          if (!existing) throw badRequest("The planned episode target is unavailable.");
          add(`episode.${index}.target`, existing.id, choices(plan.episodes.map((item) => ({ id: item.id, name: item.title }))), { path: [String(index), "id"], stage: 0 });
          add(`episode.${index}.episodeProfileId`, existing.episodeProfileId || "", choices(profiles.episodeProfiles), { path: [String(index), "changes", "episodeProfileId"] });
        }
      }
      return fields;
    }
    const field = fields.find((item) => item.id === questionId);
    const locked = (options) => {
      const excluded = new Set([...(field?.excludedIds || []), ...mentions(options, field?.speakerName || "", questionId?.endsWith(".ttsModelOverride")).excluded]);
      return options.filter((option) => !excluded.has(option.id) && (!field || !Object.hasOwn(field, "explicitValue") || (option.value ?? option.id) === field.explicitValue));
    };
    if (questionId?.endsWith(".voiceId") || questionId?.endsWith(".deliveryPreset")) {
      const prefix = questionId.slice(0, questionId.lastIndexOf("."));
      const override = valueFor(`${prefix}.ttsModelOverride`, decisions, fields);
      const model = override === "profile_default" ? valueFor("voiceModel", decisions, fields) : override || valueFor("voiceModel", decisions, fields);
      const provider = compatibleConnection(context, parseCompatibleModelId(model)?.connectionId)?.kind;
      return locked(questionId.endsWith(".voiceId") ? choices(voiceCatalog.get(model) || []) : deliveryPresetOptions(model || "", field.currentValue, provider));
    }
    if (questionId === "voiceModel" || questionId?.endsWith(".ttsModelOverride")) return locked(questionId === "voiceModel" ? ttsChoices : [{ id: "profile_default", value: "", description: "Use the profile TTS model" }, ...ttsChoices]);
    return field?.options ? locked(field.options) : undefined;
  };
}

/** Lock a proposal to a ready Jev result. `parsed` is {message, proposal, nextStep}; the proposal holds the
 * value for `initial`'s route. Returns the proposal with every selected field forced to Jev's choice.
 */
export function enforceAssistantDecision(parsed, result, profiles, initial, focusEpisode, targets) {
  const route = result.decisions.route;
  if (route !== initial.decisions.route || result.decisions.profileAction !== initial.decisions.profileAction) throw badRequest("The configuration decisions changed. Ask again before applying a proposal.");
  if (["question", "keep_current", "not_requested"].includes(route) || ["keep_current", "not_requested"].includes(result.decisions.profileAction)) return { ...parsed, proposal: null, nextStep: null };
  if (route === "nextStep") {
    const action = result.decisions.nextAction;
    const target = { generatePlan: "chat", createEpisodes: "episodes", generateTranscript: "transcript", generateTts: "tts", openPlayer: "player" }[action] || "chat";
    const episodeAction = ["generateTranscript", "generateTts", "openPlayer"].includes(action);
    if (episodeAction && !focusEpisode?.id) throw badRequest("Select the episode for this action, then ask for a new step.");
    return { ...parsed, proposal: null, nextStep: action && !["none", "keep_current", "not_requested"].includes(action) ? { target, action, targetIds: episodeAction ? [focusEpisode.id] : [], reason: parsed.message } : null };
  }
  if (!parsed.proposal?.[route]) throw badRequest("The proposal does not match the selected proposal type. Ask again.");
  const raw = parsed.proposal[route];
  const value = enforceJevSelections(Array.isArray(raw) ? { rows: raw } : raw.value || raw.changes || raw, Array.isArray(raw) ? { ...result, selections: Object.fromEntries(Object.entries(result.selections).map(([id, selection]) => [id, { ...selection, path: ["rows", ...selection.path] }])) } : result);
  let proposal;
  if (["speakerProfile", "episodeFormat"].includes(route)) {
    const target = (route === "speakerProfile" ? profiles.speakerProfiles : profiles.episodeProfiles).find((item) => item.id === (route === "speakerProfile" ? targets.speakerProfileId : targets.episodeProfileId));
    proposal = { [route]: { mode: result.decisions.profileAction, targetId: target.id, value } };
  } else proposal = { [route]: Array.isArray(raw) ? value.rows : raw.changes ? { ...raw, ...(route === "episodePatch" ? { episodeId: focusEpisode.id } : {}), changes: value } : value };
  return { ...parsed, proposal, nextStep: null };
}

// Routes whose full pass needs the agent's proposed value (host names and count, or the planned-episode patch rows).
const PROPOSAL_ROUTES = new Set(["speakerProfile", "plannedEpisodePatches"]);

/** The jev_decide tool: an optional typed check of the agent's reading of a request, against the live workspace.
 * Without TYPESAFE_API_KEY it returns status "unavailable" (not an error). `fields` limits the configuration fields
 * Jev may change; the others keep their current values. A `proposal` ({[route]: value}) is locked to Jev's choices.
 */
export async function jevDecide(context, { request, fields, planId, episodeId, focus = {}, proposal = null }) {
  const runtime = await modelRuntimeSnapshot(context);
  const apiKey = runtime.credentials.TYPESAFE_API_KEY;
  if (!apiKey) return { status: "unavailable", reason: "TYPESAFE_API_KEY is not set. Jev checks are optional; add the key in Settings to use them." };
  const [profiles, knowledge] = await Promise.all([readJson(context.paths.profiles), readJson(context.paths.knowledgeIndex)]);
  const plan = planId ? await loadPlan(context.paths, planId)
    : { id: "", name: "", theme: "", goal: "", language: profiles.episodeProfiles[0]?.language || "", speakerProfileId: "", episodeFormatId: "", knowledgeBaseId: "", episodes: [] };
  const focusEpisode = episodeId ? await loadEpisode(context.paths, episodeId, false) : null;
  const targets = profileTargets(profiles, plan, focus);
  const base = { context: runtime, plan, profiles, profileTargets: targets, focusEpisode, knowledge, voiceCatalog: await voiceCatalog(runtime, profiles), text: request };
  const state = {
    request,
    plan: plan.id ? { id: plan.id, name: plan.name, theme: plan.theme, goal: plan.goal, language: plan.language, episodeCount: plan.episodeCount ?? null } : null,
    profileTargets: targets,
    focusEpisode: focusEpisode && { id: focusEpisode.id, name: focusEpisode.name, status: focusEpisode.status },
  };
  const allowed = Array.isArray(fields) && fields.length ? new Set(fields) : null;
  const restrict = (candidates) => async (input) => {
    const value = await candidates(input);
    return input.phase === "fields" && allowed && Array.isArray(value) ? value.map((field) => allowed.has(field.id) ? field : { ...field, locked: true }) : value;
  };
  const run = (candidates) => decideAssistantConfiguration({ fetchImpl: runtime.fetchImpl, apiKey, state, candidates: restrict(candidates) });
  const view = (result, extra = {}) => ({ status: result.status, decisions: result.decisions, selections: result.selections, questionsNeeded: result.questionsNeeded, receipt: result.receipt, ...(result.error ? { error: result.error } : {}), ...extra });
  const initial = await run(jevCandidates({ ...base, preliminary: true }));
  const route = initial.decisions.route;
  if (initial.status !== "ready" || ["question", "nextStep", "keep_current", "not_requested"].includes(route) || ["keep_current", "not_requested"].includes(initial.decisions.profileAction)) return view(initial);
  const raw = proposal?.[route];
  if (PROPOSAL_ROUTES.has(route) && !raw) {
    const count = initial.selections.speakerCount?.value;
    return view(initial, { status: "needs_proposal", reason: `Call jev_decide again with proposal.${route}${count ? ` (exactly ${count} speakers with names)` : ""} to decide its configuration fields.` });
  }
  const result = await run(jevCandidates({ ...base, proposed: raw?.value || raw?.changes || raw, initial }));
  if (result.status !== "ready" || !raw) return view(result);
  return view(result, { proposal: enforceAssistantDecision({ message: request, proposal, nextStep: null }, result, profiles, initial, focusEpisode, targets).proposal });
}
