import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DEFAULT_DATA } from "../src/defaults.mjs";
import { decideAssistantConfiguration } from "../src/jev.mjs";
import { enforceAssistantDecision, jevCandidates, profileTargets, voiceCatalog } from "../src/decide.mjs";
import { createModelCatalog } from "../src/providers/catalog.mjs";

const hashId = (id) => ["keep_current", "not_requested", "clarify"].includes(id) ? id : `option_${createHash("sha256").update(id).digest("hex")}`;
const spanish = [{ id: "es", name: "Spanish" }];

// A Spanish workspace with MiMo and two ElevenLabs models active, and a Jev stub that answers from `choices`.
function workspace() {
  const requests = [];
  const choices = { route: "speakerProfile", profileAction: "create", speakerCount: "1", voiceModel: "eleven_v4", "speakers.0.voiceId": "es-voice" };
  const jev = { lowConfidence: false, unavailable: false };
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes("typesafe.ai")) {
      const request = JSON.parse(options.body);
      requests.push(request);
      assert.equal(options.headers.Authorization, "Bearer test-typesafe-key");
      if (jev.unavailable) return Response.json({ secret: "do not expose" }, { status: 503 });
      return Response.json({ model: "jev-1.14.0", answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
        if (question.type === "noul") return [id, { type: "noul", noul: 1 }];
        const selected = hashId(choices[id] || "keep_current");
        return [id, { type: "choice", choice: selected, confidence: jev.lowConfidence ? 0.2 : 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === selected ? 1 : 0])) }];
      })) });
    }
    if (String(url).includes("/v2/voices")) return Response.json({ voices: [{ voice_id: "es-voice", name: "Spanish voice" }, { voice_id: "second-voice", name: "Second Spanish voice" }] });
    throw new Error(`Unexpected request ${url}`);
  };
  const modelCatalog = createModelCatalog({});
  Object.assign(modelCatalog.providers.mimo, { status: "ready", ttsModels: [{ id: "mimo-v2.5-tts" }] });
  const eleven = [{ id: "eleven_v4", name: "Eleven v4", supported: true, languages: spanish }, { id: "eleven_flash_v2_5", name: "Flash", supported: true, languages: spanish }];
  Object.assign(modelCatalog.providers.elevenlabs, { status: "ready", discoveredModels: eleven, ttsModels: eleven });
  const context = { config: { providers: {}, compatibleConnections: [] }, credentials: { ELEVENLABS_API_KEY: "test-eleven-key" }, fetchImpl, modelCatalog };
  const profiles = structuredClone(DEFAULT_DATA);
  const plan = { id: "plan", name: "Spanish podcast", theme: "Topic", language: "es-419", speakerProfileId: profiles.speakerProfiles[0].id, episodeFormatId: profiles.episodeProfiles[0].id, episodes: [] };
  const questions = (id) => requests.flatMap((request) => Object.entries(request.questions)).findLast(([questionId]) => questionId === id)?.[1];
  // The agent-side flow: Jev picks the route and host count, the agent proposes a value, Jev locks its configuration fields.
  const decide = async (text, proposal, { activeContext, focusEpisode = null } = {}) => {
    const targets = profileTargets(profiles, plan, activeContext);
    const base = { context, plan, profiles, profileTargets: targets, focusEpisode, knowledge: [], voiceCatalog: await voiceCatalog(context, profiles), text };
    const run = (candidates) => decideAssistantConfiguration({ fetchImpl, apiKey: "test-typesafe-key", state: { message: text }, candidates });
    const initial = await run(jevCandidates({ ...base, preliminary: true }));
    if (initial.status !== "ready") return initial;
    const raw = proposal?.[initial.decisions.route];
    const result = await run(jevCandidates({ ...base, proposed: raw?.value || raw?.changes || raw, initial }));
    if (result.status !== "ready") return result;
    return { ...result, enforced: enforceAssistantDecision({ message: text, proposal, nextStep: null }, result, profiles, initial, focusEpisode, targets) };
  };
  return { choices, jev, profiles, requests, questions, decide };
}

const hosts = (...names) => ({ speakerProfile: { value: { name: "Hosts", speakers: names.map((name) => ({ name, backstory: "Host", personality: "Calm", style: "Natural", voiceId: "invented" })) } } });

test("a new solo host gets the named Spanish model and voice, and keeps the saved tuning", async () => {
  const w = workspace();
  const before = structuredClone(w.profiles.speakerProfiles[0]);
  const result = await w.decide("Create a new solo host named Charlie. Use eleven_v4 and es-voice.", { speakerProfile: { mode: "update", targetId: "invented", value: { name: "Charlie", voiceModel: "mimo-v2.5-tts", speakers: [{ name: "Charlie", backstory: "A host", personality: "Calm", style: "Natural", voiceId: "alloy", elevenlabsSpeed: 1.19 }] } } });
  assert.equal(result.status, "ready", JSON.stringify(result.error));
  const proposal = result.enforced.proposal.speakerProfile;
  assert.equal(proposal.mode, "create");
  assert.equal(proposal.targetId, before.id);
  assert.equal(proposal.value.voiceModel, "eleven_v4");
  assert.deepEqual(proposal.value.speakers.map((speaker) => [speaker.name, speaker.voiceId, speaker.elevenlabsSpeed]), [["Charlie", "es-voice", before.speakers[0].elevenlabsSpeed]]);
  assert.ok(Object.hasOwn(w.questions("speakers.0.voiceId").criteria, hashId("es-voice")));
  assert.ok(!Object.hasOwn(w.questions("speakers.0.voiceId").criteria, hashId("alloy")));
  assert.ok(!Object.hasOwn(w.questions("voiceModel").criteria, hashId("mimo-v2.5-tts")), "MiMo TTS does not speak Spanish");
  assert.deepEqual(w.profiles.speakerProfiles[0], before, "a decision never saves configuration");
});

test("Jev cannot override exact user IDs, and negative model phrasing is respected", async () => {
  const w = workspace();
  w.choices.voiceModel = "eleven_flash_v2_5";
  assert.equal((await w.decide("Create solo Charlie. Use eleven_v4 with es-voice.", hosts("Charlie"))).status, "unavailable");
  const result = await w.decide("Create solo Charlie. Do not use eleven_v4. Use eleven_flash_v2_5 with es-voice.", hosts("Charlie"));
  assert.equal(result.status, "ready", JSON.stringify(result.error));
  assert.equal(result.enforced.proposal.speakerProfile.value.voiceModel, "eleven_flash_v2_5");
  assert.equal(result.enforced.proposal.speakerProfile.value.speakers[0].ttsModelOverride, "", "a default model request must not add an override");
});

test("a positive model choice stays locked beside a negative voice choice in the same clause", async () => {
  const w = workspace();
  const text = "Create solo Charlie: use eleven_v4 but do not use es-voice.";
  assert.equal((await w.decide(text, hosts("Charlie"))).status, "unavailable");
  assert.ok(Object.hasOwn(w.questions("voiceModel").criteria, hashId("eleven_v4")));
  assert.ok(!Object.hasOwn(w.questions("voiceModel").criteria, hashId("eleven_flash_v2_5")));
  assert.ok(!Object.hasOwn(w.questions("speakers.0.voiceId").criteria, hashId("es-voice")));
  w.choices["speakers.0.voiceId"] = "second-voice";
  const result = await w.decide(text, hosts("Charlie"));
  assert.equal(result.enforced.proposal.speakerProfile.value.voiceModel, "eleven_v4");
  assert.equal(result.enforced.proposal.speakerProfile.value.speakers[0].voiceId, "second-voice");
});

test("four new hosts get independent voices and a named preset keeps unrelated tuning", async () => {
  const w = workspace();
  w.choices.speakerCount = "4";
  for (let index = 0; index < 4; index += 1) Object.assign(w.choices, { [`speakers.${index}.voiceId`]: index % 2 ? "second-voice" : "es-voice", [`speakers.${index}.deliveryPreset`]: "expressive" });
  const result = await w.decide("Create a new four-host Spanish panel. Use eleven_v4.", hosts("Ana", "Beto", "Cora", "Dani"));
  assert.equal(result.status, "ready", JSON.stringify(result.error));
  const speakers = result.enforced.proposal.speakerProfile.value.speakers;
  assert.deepEqual(speakers.map((speaker) => [speaker.name, speaker.voiceId]), [["Ana", "es-voice"], ["Beto", "second-voice"], ["Cora", "es-voice"], ["Dani", "second-voice"]]);
  assert.ok(speakers.every((speaker) => speaker.elevenlabsStability === 0.3 && speaker.elevenlabsSpeed === 1));
});

test("named-host clauses keep each exact voice in either order and reject swapped decisions", async () => {
  const w = workspace();
  w.choices.speakerCount = "2";
  for (const text of [
    "Create two hosts, Ana and Beto. Use eleven_v4. Ana should use es-voice and Beto should use second-voice.",
    "Create two hosts, Ana and Beto. Use eleven_v4. Use es-voice for Ana and second-voice for Beto.",
    "Create two hosts, Ana and Beto. Use eleven_v4. Use es-voice para Ana and second-voice para Beto.",
  ]) {
    for (const names of [["Ana", "Beto"], ["Beto", "Ana"]]) {
      for (const [index, name] of names.entries()) w.choices[`speakers.${index}.voiceId`] = name === "Ana" ? "second-voice" : "es-voice";
      assert.equal((await w.decide(text, hosts(...names))).status, "unavailable");
      for (const [index, name] of names.entries()) w.choices[`speakers.${index}.voiceId`] = name === "Ana" ? "es-voice" : "second-voice";
      const result = await w.decide(text, hosts(...names));
      assert.deepEqual(result.enforced.proposal.speakerProfile.value.speakers.map((speaker) => [speaker.name, speaker.voiceId]), names.map((name) => [name, name === "Ana" ? "es-voice" : "second-voice"]));
    }
  }
});

test("named-host model overrides stay scoped to their host", async () => {
  const w = workspace();
  Object.assign(w.choices, { speakerCount: "2", "speakers.0.ttsModelOverride": "eleven_v4", "speakers.1.ttsModelOverride": "eleven_flash_v2_5", "speakers.0.voiceId": "es-voice", "speakers.1.voiceId": "second-voice" });
  const text = "Create two hosts, Ana and Beto. Use eleven_v4. Use eleven_v4 for Ana and eleven_flash_v2_5 para Beto. Use es-voice for Ana and second-voice para Beto.";
  const result = await w.decide(text, hosts("Ana", "Beto"));
  assert.deepEqual(result.enforced.proposal.speakerProfile.value.speakers.map((speaker) => [speaker.ttsModelOverride, speaker.voiceId]), [["eleven_v4", "es-voice"], ["eleven_flash_v2_5", "second-voice"]]);
  w.choices["speakers.0.ttsModelOverride"] = "eleven_flash_v2_5";
  assert.equal((await w.decide(text, hosts("Ana", "Beto"))).status, "unavailable");
});

test("unknown, ambiguous, or unassigned hosts cannot produce a configuration", async () => {
  const w = workspace();
  w.choices.speakerCount = "2";
  for (const assignments of ["Use es-voice for Ghost and second-voice for Beto.", "Use es-voice for Ana and Beto.", "Use es-voice and second-voice."]) {
    const result = await w.decide(`Create two hosts, Ana and Beto. Use eleven_v4. ${assignments}`, hosts("Ana", "Beto"));
    assert.notEqual(result.status, "ready");
    assert.equal(result.enforced, undefined);
  }
});

test("a focused Format edit locks the selected target and keeps an unrequested duration", async () => {
  const w = workspace();
  w.profiles.episodeProfiles.push({ ...w.profiles.episodeProfiles[0], id: "other-format", name: "Other format", targetMinutes: 12 });
  Object.assign(w.choices, { route: "episodeFormat", profileAction: "update", language: "es-419" });
  const proposal = { episodeFormat: { mode: "update", targetId: w.profiles.episodeProfiles[0].id, value: { name: "Renamed focused format", language: "en-US", targetMinutes: 59 } } };
  const result = await w.decide("Rename this format and use Spanish es-419.", proposal, { activeContext: { view: "format", episodeProfileId: "other-format" } });
  assert.equal(result.status, "ready", JSON.stringify(result.error));
  assert.equal(result.enforced.proposal.episodeFormat.targetId, "other-format");
  assert.deepEqual([result.enforced.proposal.episodeFormat.value.language, result.enforced.proposal.episodeFormat.value.targetMinutes], ["es-419", 12]);
  await assert.rejects(w.decide("Rename this format.", proposal, { activeContext: { view: "format", episodeProfileId: "missing-format" } }), /selected Episode Format no longer exists/);
});

test("episode next steps pin the focused episode and need one", async () => {
  const w = workspace();
  Object.assign(w.choices, { route: "nextStep", nextAction: "generateTranscript" });
  const focused = await w.decide("Write the script for this episode.", null, { focusEpisode: { id: "ep-1", status: "draft" } });
  assert.deepEqual(focused.enforced.nextStep, { target: "transcript", action: "generateTranscript", targetIds: ["ep-1"], reason: "Write the script for this episode." });
  assert.equal((await w.decide("Write an episode script.", null)).status, "unavailable", "no focused episode offers no script step");
});

test("low confidence asks the user, and a failed Jev call exposes no upstream text", async () => {
  const w = workspace();
  w.jev.lowConfidence = true;
  const unclear = await w.decide("Choose a configuration.", hosts("Charlie"));
  assert.equal(unclear.status, "needs_clarification");
  assert.equal(unclear.enforced, undefined);
  w.jev.lowConfidence = false;
  w.jev.unavailable = true;
  const failed = await w.decide("Choose a configuration.", hosts("Charlie"));
  assert.equal(failed.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(failed), /do not expose/);
});

test("reordered hosts keep their own voice, accent, override, and tuning", async () => {
  const w = workspace();
  Object.assign(w.choices, { profileAction: "update", speakerCount: "2", voiceModel: "keep_current", "speakers.0.voiceId": "keep_current" });
  const [first, second] = w.profiles.speakerProfiles[0].speakers;
  Object.assign(first, { accent: "American", mimoTemperature: 0.2, elevenlabsStability: 0.31 });
  Object.assign(second, { accent: "British", mimoTemperature: 1.1, elevenlabsStability: 0.72, ttsModelOverride: "mimo-v2.5-tts" });
  const reversed = [second, first];
  const proposal = { speakerProfile: { value: { speakers: reversed.map(({ name, backstory, personality, style }) => ({ name, backstory, personality, style })) } } };
  const result = await w.decide("Reverse the host order. Keep each host's model, voice, accent, and delivery settings.", proposal);
  assert.equal(result.status, "ready", JSON.stringify(result.error));
  const keys = ["name", "voiceId", "accent", "mimoTemperature", "elevenlabsStability", "ttsModelOverride"];
  const pick = (speaker) => keys.map((key) => speaker[key]);
  assert.deepEqual(result.enforced.proposal.speakerProfile.value.speakers.map(pick), reversed.map(pick));
});

test("legacy OpenAI TTS models offer only their nine owned voices", async () => {
  const modelCatalog = createModelCatalog({});
  Object.assign(modelCatalog.providers.openai, { status: "ready", ttsModels: [{ id: "compat:openai:tts-1" }, { id: "compat:openai:gpt-4o-mini-tts" }] });
  const voices = await voiceCatalog({ config: { providers: { openai: {} }, compatibleConnections: [] }, modelCatalog }, structuredClone(DEFAULT_DATA));
  assert.deepEqual(voices.get("compat:openai:tts-1").map((voice) => voice.id), ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"]);
  assert.ok(voices.get("compat:openai:gpt-4o-mini-tts").some((voice) => voice.id === "marin"));
});
