import assert from "node:assert/strict";
import test from "node:test";
import { DECISIONS_MODEL, evaluateOpenAiDecisions, deliveryTraitDefinitions, compileDeliveryTraits } from "../src/decisions.mjs";
import { decideAssistantConfiguration, enforceJevSelections } from "../src/jev.mjs";

const definitions = {
  scope: { question: { type: "noul", instructions: "Is this requested?" } },
  choice: { question: { type: "choice", instructions: "Choose a typed option." }, mapping: new Map([[false, { id: "no" }], ["false", { id: "string" }]]) },
  energy: { question: { type: "score", instructions: "Rate energy.", levels: [{ label: "low", description: "Quiet" }, { label: "medium", description: "Engaged" }, { label: "high", description: "Lively" }] } },
};

function nativeAnswers(request, choices = {}) {
  return { model: DECISIONS_MODEL, answers: request.questions.map((question) => {
    const name = question.name;
    if (question.type === "predicate") return { type: "predicate", name, probability: choices[name] ?? 1 };
    if (question.type === "score") {
      const score = choices[name] ?? 1;
      return { type: "score", name, score, confidence: 1, probabilities: question.levels.map((level, value) => ({ value, label: level.label, probability: value === score ? 1 : 0 })) };
    }
    const choice = Object.hasOwn(choices, name) ? choices[name] : question.choices[0].value;
    return { type: "choice", name, choice, confidence: 1, probabilities: question.choices.map(({ value }) => ({ value, probability: value === choice ? 1 : 0 })) };
  }) };
}

function mock(mutate = (body) => body) {
  const requests = [];
  return { requests, fetchImpl: async (url, options) => {
    const request = JSON.parse(options.body);
    requests.push({ url, options, request });
    return Response.json(mutate(nativeAnswers(request), request));
  } };
}
const base = { apiKey: "server-only-secret", state: { message: "private-context" } };

test("native Decisions payload and typed predicate, choice, and ordinal score use the pinned endpoint and key", async () => {
  const fixture = mock();
  const result = await evaluateOpenAiDecisions({ ...base, ...fixture }, definitions);
  const { url, options, request } = fixture.requests[0];
  assert.equal(url, "https://api.openai.com/v1/decisions");
  assert.equal(options.headers.Authorization, "Bearer server-only-secret");
  assert.equal(options.redirect, "error");
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(request.model, DECISIONS_MODEL);
  assert.equal(request.input, JSON.stringify(base.state));
  assert.deepEqual(Object.keys(request).sort(), ["input", "model", "questions"]);
  assert.deepEqual(request.questions.map((question) => [question.name, question.type]), [["scope", "predicate"], ["choice", "choice"], ["energy", "score"]]);
  assert.equal(result.answers.scope.yes, true);
  assert.equal(result.answers.choice.option.id, "no");
  assert.equal(result.answers.energy.score, 1);
  assert.equal(result.answers.energy.label, "medium");
  assert.doesNotMatch(JSON.stringify(result), /server-only-secret|private-context/);
});

for (const [name, mutate] of [
  ["missing model", (data) => { delete data.model; }],
  ["wrong model", (data) => { data.model = "other"; }],
  ["missing answer", (data) => { data.answers.pop(); }],
  ["extra answer", (data) => { data.answers.push({ type: "refusal", name: "extra" }); }],
  ["duplicate name", (data) => { data.answers[1].name = "scope"; }],
  ["wrong name", (data) => { data.answers[1].name = "unknown"; }],
  ["wrong type", (data) => { data.answers[0].type = "choice"; }],
  ["invalid predicate", (data) => { data.answers[0].probability = "1"; }],
  ["nonfinite predicate", (data) => { data.answers[0].probability = Infinity; }],
  ["unknown choice", (data) => { data.answers[1].choice = "unknown"; }],
  ["typed mismatch", (data) => { data.answers[1].probabilities[0].value = "false"; }],
  ["duplicate distribution", (data) => { data.answers[1].probabilities[1] = data.answers[1].probabilities[0]; }],
  ["missing distribution", (data) => { data.answers[1].probabilities.pop(); }],
  ["invalid probability", (data) => { data.answers[1].probabilities[0].probability = -0.1; }],
  ["invalid sum", (data) => { data.answers[1].probabilities[0].probability = 0.5; }],
  ["non-maximal choice", (data) => { data.answers[1].choice = "false"; }],
  ["invalid confidence", (data) => { data.answers[2].confidence = 2; }],
  ["fractional score index", (data) => { data.answers[2].probabilities[0].value = 0.5; }],
  ["wrong score label", (data) => { data.answers[2].probabilities[0].label = "invented"; }],
  ["contradictory expected score", (data) => { data.answers[2].score = 2; }],
  ["nonfinite score", (data) => { data.answers[2].score = NaN; }],
]) test(`Decisions rejects ${name}`, async () => {
  const fixture = mock((data) => { mutate(data); return data; });
  await assert.rejects(evaluateOpenAiDecisions({ ...base, ...fixture }, definitions), (error) => error.code === "invalid_response" && !/server-only-secret|private-context/.test(error.message));
  assert.equal(fixture.requests.length, 1);
});

test("a refusal for any question blocks the whole proposal, without exposing provider text", async () => {
  const fixture = mock((data) => { data.answers[2] = { type: "refusal", name: "energy", message: "server-only-secret" }; return data; });
  await assert.rejects(evaluateOpenAiDecisions({ ...base, ...fixture }, definitions), (error) => error.code === "refusal" && !error.message.includes("server-only-secret"));
});

test("fractional expected ordinal scores are validated against the zero-based distribution", async () => {
  const fixture = mock((data) => {
    data.answers[2].probabilities = [{ value: 0, label: "low", probability: 0.05 }, { value: 1, label: "medium", probability: 0.9 }, { value: 2, label: "high", probability: 0.05 }];
    return data;
  });
  const result = await evaluateOpenAiDecisions({ ...base, ...fixture }, definitions);
  assert.equal(result.answers.energy.score, 1);
  assert.ok(result.answers.energy.confidence > 0.7);
});

test("Decisions transport errors, timeouts including slow bodies, limits, and invalid configuration are bounded and redacted", async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    await assert.rejects(evaluateOpenAiDecisions({ ...base, fetchImpl: async () => { calls++; return Response.json({ secret: "server-only-secret" }, { status }); } }, definitions), (error) => error.statusCode === status && !error.message.includes("server-only-secret"));
    assert.equal(calls, 1);
  }
  await assert.rejects(evaluateOpenAiDecisions({ ...base, fetchImpl: async () => { throw new Error("server-only-secret"); } }, definitions), (error) => error.code === "unavailable" && !error.message.includes("server-only-secret"));
  for (const fetchImpl of [async () => new Promise(() => {}), async () => new Response(new ReadableStream({ start() {} }))]) {
    await assert.rejects(evaluateOpenAiDecisions({ ...base, fetchImpl, timeoutMs: 5 }, definitions), (error) => error.code === "timeout");
  }
  await assert.rejects(evaluateOpenAiDecisions({ ...base, ...mock(), state: { text: "x".repeat(300_000) } }, definitions), (error) => error.code === "request_too_large");
  for (const response of [new Response("x".repeat(300_000)), new Response("{}", { headers: { "Content-Length": "300000" } }), new Response("not-json")]) {
    await assert.rejects(evaluateOpenAiDecisions({ ...base, fetchImpl: async () => response }, definitions), (error) => ["response_too_large", "invalid_response"].includes(error.code));
  }
  for (const options of [{ apiKey: "" }, { model: "other" }, { state: undefined }, { timeoutMs: 0 }]) {
    await assert.rejects(evaluateOpenAiDecisions({ ...base, ...mock(), ...options }, definitions), (error) => typeof error.code === "string");
  }
  for (const bad of [{ scope: null }, { energy: { question: { type: "score", instructions: "Rate", levels: [] } } }]) await assert.rejects(evaluateOpenAiDecisions(base, bad), (error) => error.code === "invalid_candidates");
});

test("trait rubrics compile only supported deterministic presets and share manual enforcement", async () => {
  const traitDefinitions = deliveryTraitDefinitions("speakers.0.deliveryPreset", 0);
  const fixture = mock();
  const evaluated = await evaluateOpenAiDecisions({ ...base, ...fixture }, traitDefinitions);
  assert.equal(Object.values(traitDefinitions).filter((definition) => definition.question.type === "score").length, 5);
  assert.equal(compileDeliveryTraits("speakers.0.deliveryPreset", evaluated.answers).preset, "natural");
  const result = await decideAssistantConfiguration({ ...base, ...fixture, provider: "openai", deliverySetup: true,
    candidates: { fields: [{ id: "speakers.0.deliveryPreset", path: ["speakers", "0"], merge: true, forceRequested: true, deliveryTraits: { hostIndex: 0, style: "Exact current style." }, options: [{ id: "natural", value: { stability: 0.5 } }, { id: "calm", value: { stability: 0.8 } }, { id: "expressive", value: { stability: 0.3 } }] }] } });
  assert.equal(result.status, "ready");
  assert.equal(result.receipt.provider, "openai");
  assert.equal(result.receipt.gate.calibration, "UNCALIBRATED");
  const applied = enforceJevSelections({ speakers: [{ name: "Host", voiceId: "kept" }] }, result);
  assert.match(applied.speakers[0].style, /^Exact current style\.\n\nDelivery setup:/);
  assert.equal(applied.speakers[0].voiceId, "kept");
  const uncertain = mock((data) => { data.answers[0].confidence = 0.2; return data; });
  const blocked = await decideAssistantConfiguration({ ...base, ...uncertain, provider: "openai", deliverySetup: true, candidates: { fields: [{ id: "speakers.0.deliveryPreset", path: ["speakers", "0"], merge: true, forceRequested: true, deliveryTraits: { hostIndex: 0 }, options: [{ id: "natural", value: {} }] }] } });
  assert.equal(blocked.status, "needs_clarification");
  assert.throws(() => enforceJevSelections({}, blocked), /not ready/);
});
