import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { decideAssistantConfiguration, enforceJevSelections, JEV_MODEL } from "../src/jev.mjs";

const specialIds = new Set(["keep_current", "not_requested", "clarify"]);
const wireId = (id) => specialIds.has(id) ? id : `option_${createHash("sha256").update(id).digest("hex")}`;

function responseFor(request, selections = {}) {
  return {
    model: JEV_MODEL,
    answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      if (question.type === "noul") return [id, { type: "noul", noul: selections[id] ?? 1 }];
      const choice = wireId(selections[id] ?? (id === "route" ? "episodeFormat" : id === "profileAction" ? "update" : "keep_current"));
      return [id, { type: "choice", choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === choice ? 1 : 0])) }];
    })),
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}

function mockFetch(select, mutate) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body);
    requests.push({ url, options, request });
    const body = responseFor(request, typeof select === "function" ? select(request, requests.length) : select);
    return Response.json(mutate ? mutate(body, request, requests.length) : body);
  };
  return { fetchImpl, requests };
}

const defaults = { apiKey: "server-only-key", state: { message: "Use Spanish and the current format." } };

test("Jev uses the documented schema, server credential, and pinned model", async () => {
  const mock = mockFetch({ route: "question" });
  const result = await decideAssistantConfiguration({ ...defaults, ...mock });
  assert.equal(result.status, "ready");
  assert.equal(result.decisions.route, "question");
  assert.equal(mock.requests.length, 1);
  const { url, options, request } = mock.requests[0];
  assert.equal(url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(options.headers.Authorization, "Bearer server-only-key");
  assert.equal(options.redirect, "error");
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(request).sort(), ["model", "questions", "state"]);
  assert.equal(request.model, "jev-1.14.0");
  assert.equal(request.questions.route.type, "choice");
  assert.equal(Object.hasOwn(request.questions.route, "criteria"), true);
  assert.equal(Object.hasOwn(result.receipt, "state"), false);
  assert.equal(JSON.stringify(result).includes("server-only-key"), false);
  assert.equal(JSON.stringify(result.receipt).includes(defaults.state.message), false);
});

for (const message of ["Use Spanish for this podcast.", "Usa español para este podcast."]) {
  test(`configuration choices preserve the supplied request: ${message}`, async () => {
    const mock = mockFetch({ language: "es-419" });
    const result = await decideAssistantConfiguration({ ...defaults, ...mock, state: { message }, candidates: { fields: [{ id: "language", currentValue: "en-US", options: [{ id: "es-419", label: "Spanish (Latin America)" }, { id: "en-US", label: "English (United States)" }] }] } });
    assert.equal(result.status, "ready");
    assert.equal(result.decisions.language, "es-419");
    assert.equal(result.selections.language.value, "es-419");
    assert.equal(mock.requests[0].request.state.message, message);
    assert.deepEqual(enforceJevSelections({ language: "en-US", name: "Generated name" }, result), { language: "es-419", name: "Generated name" });
  });
}

test("unrelated fields use one scope batch, keep current, and never request choices", async () => {
  const mock = mockFetch({ route: "speakerProfile", scope_0: 0, scope_1: 0, scope_2: 0 });
  const fields = [
    { id: "voiceModel", currentValue: "unavailable-old-model" },
    { id: "speakers.0.voiceId", currentValue: "unavailable-old-voice" },
    { id: "language" },
  ];
  const result = await decideAssistantConfiguration({ ...defaults, ...mock, candidates: ({ phase, questionId }) => {
    if (phase === "fields") return fields;
    if (!["route", "profileAction"].includes(questionId)) assert.fail("Unrelated setting asked for choices.");
  } });
  assert.equal(result.status, "ready");
  assert.equal(mock.requests.length, 3);
  assert.deepEqual(Object.keys(mock.requests[2].request.questions), ["scope_0", "scope_1", "scope_2"]);
  assert.deepEqual(enforceJevSelections({ voiceModel: "invented", speakers: [{ name: "New name", voiceId: "invented" }], language: "invented" }, result), {
    voiceModel: "unavailable-old-model", speakers: [{ name: "New name", voiceId: "unavailable-old-voice" }],
  });
});

test("four speakers get independent models, provider-filtered voices, and named deterministic presets", async () => {
  const selected = { route: "speakerProfile", voiceModel: "provider-a/model", ...Object.fromEntries(Array.from({ length: 4 }, (_, index) => [
    [`speakers.${index}.ttsModelOverride`, `provider-${index % 2 ? "b" : "a"}/model`],
    [`speakers.${index}.voiceId`, `voice-${index}`],
    [`speakers.${index}.deliveryPreset`, index % 2 ? "calm" : "expressive"],
  ]).flat()) };
  const fields = [{ id: "voiceModel", currentValue: "provider-a/model" }];
  for (let index = 0; index < 4; index += 1) fields.push(
    { id: `speakers.${index}.voiceId`, currentValue: "old" },
    { id: `speakers.${index}.deliveryPreset`, path: `speakers.${index}`, merge: true, currentValue: { stability: 0.5, speed: 1 } },
    { id: `speakers.${index}.ttsModelOverride`, currentValue: "" },
  );
  const mock = mockFetch(selected);
  const result = await decideAssistantConfiguration({ ...defaults, ...mock, candidates: ({ phase, questionId, decisions }) => {
    if (phase === "fields") return fields;
    if (questionId === "voiceModel" || questionId?.endsWith("ttsModelOverride")) return [{ id: "provider-a/model" }, { id: "provider-b/model" }];
    if (questionId?.endsWith("voiceId")) {
      const index = Number(questionId.split(".")[1]);
      assert.equal(decisions[`speakers.${index}.ttsModelOverride`], `provider-${index % 2 ? "b" : "a"}/model`);
      return [{ id: `voice-${index}`, description: `Voice for provider ${index % 2 ? "b" : "a"}` }];
    }
    if (questionId?.endsWith("deliveryPreset")) return [{ id: "calm", value: { stability: 0.8, speed: 0.9 } }, { id: "expressive", value: { stability: 0.3, speed: 1.1 } }];
  } });
  assert.equal(result.status, "ready");
  assert.equal(mock.requests.length, 6);
  assert.equal(Object.keys(mock.requests[2].request.questions).length, 13);
  assert.equal(Object.keys(mock.requests[4].request.questions).length, 4);
  assert.equal(Object.keys(mock.requests[5].request.questions).length, 8);
  assert.equal(mock.requests.some(({ request }) => Object.values(request.questions).some((question) => question.type === "score")), false);
  const output = enforceJevSelections({ voiceModel: "made-up", speakers: Array.from({ length: 4 }, (_, index) => ({ name: `Speaker ${index}`, voiceId: "wrong", stability: 0.456, speed: 0.789 })) }, result);
  for (let index = 0; index < 4; index += 1) {
    assert.equal(output.speakers[index].voiceId, `voice-${index}`);
    assert.equal(output.speakers[index].ttsModelOverride, selected[`speakers.${index}.ttsModelOverride`]);
    assert.equal(output.speakers[index].stability, index % 2 ? 0.8 : 0.3);
    assert.equal(output.speakers[index].speed, index % 2 ? 0.9 : 1.1);
    assert.equal(output.speakers[index].name, `Speaker ${index}`);
  }
});

test("language decisions are visible before model candidate filtering", async () => {
  const mock = mockFetch({ language: "es-419", hostModel: "spanish-model", guestModel: "spanish-model" });
  const result = await decideAssistantConfiguration({ ...defaults, ...mock, candidates: ({ phase, questionId, decisions }) => {
    if (phase === "fields") return [{ id: "guestModel" }, { id: "hostModel" }, { id: "language" }];
    if (questionId === "language") return ["es-419"];
    if (["hostModel", "guestModel"].includes(questionId)) {
      assert.equal(decisions.language, "es-419");
      return ["spanish-model"];
    }
  } });
  assert.equal(result.status, "ready");
  assert.equal(mock.requests.length, 5);
  assert.deepEqual(Object.keys(mock.requests[4].request.questions), ["guestModel", "hostModel"]);
});

test("keep_current preserves unavailable IDs without offering them as new options", async () => {
  const mock = mockFetch({ language: "keep_current" });
  const result = await decideAssistantConfiguration({ ...defaults, ...mock, candidates: { fields: [{ id: "language", currentValue: "saved-unavailable-id", options: ["en-US", "es-419"] }] } });
  assert.equal(result.status, "ready");
  assert.equal(result.selections.language.value, "saved-unavailable-id");
  assert.equal(Object.hasOwn(mock.requests.at(-1).request.questions.language.criteria, wireId("saved-unavailable-id")), false);
  assert.equal(enforceJevSelections({ language: "es-419" }, result).language, "saved-unavailable-id");
});

test("profile keep_current stops before unrelated configuration questions", async () => {
  const mock = mockFetch({ profileAction: "keep_current" });
  const result = await decideAssistantConfiguration({ ...defaults, ...mock, candidates: { fields: [{ id: "language", options: ["en-US"] }] } });
  assert.equal(result.status, "ready");
  assert.equal(result.decisions.profileAction, "keep_current");
  assert.equal(mock.requests.length, 2);
});

test("next actions are suggestions and do not request configuration", async () => {
  const mock = mockFetch({ route: "nextStep", nextAction: "generateTts" });
  const result = await decideAssistantConfiguration({ ...defaults, ...mock });
  assert.equal(result.status, "ready");
  assert.deepEqual(result.decisions, { route: "nextStep", nextAction: "generateTts" });
  assert.equal(mock.requests.length, 2);
});

test("low confidence asks a visible question and prevents enforcement", async () => {
  const mock = mockFetch({}, (body) => {
    body.answers.route.confidence = 0.4;
    return body;
  });
  const result = await decideAssistantConfiguration({ ...defaults, ...mock });
  assert.equal(result.status, "needs_clarification");
  assert.deepEqual(result.questionsNeeded, [{ id: "route", reason: "low_confidence" }]);
  assert.equal(mock.requests.length, 1);
  assert.throws(() => enforceJevSelections({}, result), /not ready/);
});

test("a flat distribution cannot use a falsely high claimed confidence", async () => {
  const mock = mockFetch({}, (body, request) => {
    const keys = Object.keys(request.questions.route.criteria);
    body.answers.route.probabilities = Object.fromEntries(keys.map((key) => [key, 1 / keys.length]));
    return body;
  });
  const result = await decideAssistantConfiguration({ ...defaults, ...mock });
  assert.equal(result.status, "needs_clarification");
  assert.ok(result.receipt.decisions[0].confidence < 0.000001);
});

test("an unclear scope stops before any configuration choices", async () => {
  const mock = mockFetch({ scope_0: 0.5 });
  const result = await decideAssistantConfiguration({ ...defaults, ...mock, candidates: { fields: [{ id: "language", options: ["en-US"] }] } });
  assert.equal(result.status, "needs_clarification");
  assert.deepEqual(result.questionsNeeded, [{ id: "language", reason: "unclear_scope" }]);
  assert.equal(mock.requests.length, 3);
});

test("explicit clarify and missing required current values need a user answer", async () => {
  for (const select of [{ route: "clarify" }, { language: "not_requested" }, { scope_0: 0 }]) {
    const mock = mockFetch(select);
    const result = await decideAssistantConfiguration({ ...defaults, ...mock, candidates: { fields: [{ id: "language", required: true, options: ["en-US"] }] } });
    assert.equal(result.status, "needs_clarification");
    assert.ok(result.questionsNeeded.length > 0);
  }
});

test("a voice outside the model-filtered options is rejected", async () => {
  const mock = mockFetch({ route: "speakerProfile", voiceModel: "provider-a", "speakers.0.voiceId": "provider-b-voice" });
  const result = await decideAssistantConfiguration({ ...defaults, ...mock, candidates: { fields: [{ id: "voiceModel", options: ["provider-a"] }, { id: "speakers.0.voiceId", options: ["provider-a-voice"] }] } });
  assert.equal(result.status, "unavailable");
  assert.equal(result.error.code, "invalid_response");
  assert.throws(() => enforceJevSelections({}, result), /not ready/);
});

test("opaque IDs map exactly and are independent of candidate order", async () => {
  const ids = ["compat:provider:model/name", "中文🌿", "a.b[0]", "__proto__"];
  for (const options of [ids, [...ids].reverse()]) {
    const mock = mockFetch({ language: "中文🌿" });
    const result = await decideAssistantConfiguration({ ...defaults, ...mock, candidates: { fields: [{ id: "language", options }] } });
    assert.equal(result.status, "ready");
    assert.equal(result.decisions.language, "中文🌿");
    assert.equal(result.selections.language.value, "中文🌿");
    assert.deepEqual(new Set(Object.keys(mock.requests.at(-1).request.questions.language.criteria)), new Set([...ids.map(wireId), ...specialIds]));
  }
});

test("255 options are allowed, but 256 are not silently truncated", async () => {
  for (const count of [252, 253]) {
    const options = Array.from({ length: count }, (_, index) => `language-${index}`);
    const mock = mockFetch({ language: "language-251" });
    const result = await decideAssistantConfiguration({ ...defaults, ...mock, candidates: { fields: [{ id: "language", options }] } });
    if (count === 252) {
      assert.equal(result.status, "ready");
      assert.equal(Object.keys(mock.requests.at(-1).request.questions.language.criteria).length, 255);
      assert.equal(result.decisions.language, "language-251");
    } else {
      assert.equal(result.status, "unavailable");
      assert.equal(result.error.code, "too_many_options");
      assert.equal(mock.requests.length, 3);
    }
  }
});

for (const [name, mutate] of [
  ["unknown selected ID", (answer) => { answer.choice = "unknown"; }],
  ["negative probability", (answer) => { answer.probabilities[answer.choice] = -1; }],
  ["probability above one", (answer) => { answer.probabilities[answer.choice] = 2; }],
  ["null probability", (answer) => { answer.probabilities[answer.choice] = null; }],
  ["string probability", (answer) => { answer.probabilities[answer.choice] = "1"; }],
  ["incomplete distribution", (answer) => { delete answer.probabilities.clarify; }],
  ["unknown distribution ID", (answer) => { answer.probabilities.unknown = 0; }],
  ["distribution does not sum to one", (answer) => { answer.probabilities[answer.choice] = 0.7; }],
  ["selected ID is not most probable", (answer) => { answer.probabilities[answer.choice] = 0; answer.probabilities.clarify = 1; }],
  ["null confidence", (answer) => { answer.confidence = null; }],
  ["confidence above one", (answer) => { answer.confidence = 2; }],
  ["wrong type", (answer) => { answer.type = "score"; }],
]) {
  test(`rejects malformed Jev answer: ${name}`, async () => {
    const mock = mockFetch({}, (body) => { mutate(body.answers.route); return body; });
    const result = await decideAssistantConfiguration({ ...defaults, ...mock });
    assert.equal(result.status, "unavailable");
    assert.equal(result.error.code, "invalid_response");
    assert.equal(mock.requests.length, 1);
  });
}

test("missing, extra, and wrong-model answers are rejected", async () => {
  for (const mutate of [(body) => { delete body.answers.route; }, (body) => { body.answers.extra = { type: "noul", noul: 1 }; }, (body) => { body.model = "jev-latest"; }]) {
    const mock = mockFetch({}, (body) => { mutate(body); return body; });
    const result = await decideAssistantConfiguration({ ...defaults, ...mock });
    assert.equal(result.status, "unavailable");
    assert.equal(result.error.code, "invalid_response");
  }
});

test("malformed Noul values are rejected", async () => {
  for (const value of [null, "1", -0.1, 1.1]) {
    const mock = mockFetch({ scope_0: value });
    // responseFor treats null as a default, so overwrite the response after construction.
    const fetchImpl = async (url, options) => {
      const response = await mock.fetchImpl(url, options);
      const body = await response.json();
      if (body.answers.scope_0) body.answers.scope_0.noul = value;
      return Response.json(body);
    };
    const result = await decideAssistantConfiguration({ ...defaults, fetchImpl, candidates: { fields: [{ id: "language", options: ["en-US"] }] } });
    assert.equal(result.status, "unavailable");
    assert.equal(result.error.code, "invalid_response");
  }
});

test("missing credentials make no upstream request", async () => {
  let calls = 0;
  const result = await decideAssistantConfiguration({ state: "Hello", fetchImpl: () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.equal(result.status, "unavailable");
  assert.equal(result.error.code, "missing_api_key");
});

test("rate limits, authentication errors, and upstream failures are visible and do not retry", async () => {
  for (const [status, code] of [[429, "rate_limited"], [529, "rate_limited"], [401, "unauthorized"], [500, "upstream_error"]]) {
    let calls = 0;
    const result = await decideAssistantConfiguration({ ...defaults, fetchImpl: async () => { calls += 1; return new Response("server-only-key: full user prompt", { status }); } });
    assert.equal(result.status, "unavailable");
    assert.equal(result.error.code, code);
    assert.equal(result.error.statusCode, status);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes("server-only-key"), false);
    assert.equal(JSON.stringify(result).includes("full user prompt"), false);
  }
});

test("a timeout is bounded even when the injected fetch ignores abort", async () => {
  let signal;
  const result = await decideAssistantConfiguration({ ...defaults, timeoutMs: 5, fetchImpl: (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  assert.equal(result.status, "unavailable");
  assert.equal(result.error.code, "timeout");
  assert.equal(signal.aborted, true);
});

test("slow response bodies also time out", async () => {
  const result = await decideAssistantConfiguration({ ...defaults, timeoutMs: 5, fetchImpl: async () => new Response(new ReadableStream({ start() {} })) });
  assert.equal(result.status, "unavailable");
  assert.equal(result.error.code, "timeout");
});

test("untrusted network and callback errors never expose their message", async () => {
  for (const options of [
    { fetchImpl: async () => { throw Object.assign(new Error("server-only-key full user prompt"), { code: "invalid_response" }); } },
    { fetchImpl: mockFetch().fetchImpl, candidates: () => { throw new Error("server-only-key full user prompt"); } },
  ]) {
    const result = await decideAssistantConfiguration({ ...defaults, ...options });
    assert.equal(result.status, "unavailable");
    assert.equal(result.error.code, "unavailable");
    assert.equal(JSON.stringify(result).includes("server-only-key"), false);
    assert.equal(JSON.stringify(result).includes("full user prompt"), false);
  }
});

test("oversized JSON responses and requests are rejected", async () => {
  const largeResponse = await decideAssistantConfiguration({ ...defaults, fetchImpl: async () => new Response("x".repeat(256 * 1024 + 1)) });
  assert.equal(largeResponse.error.code, "response_too_large");
  let calls = 0;
  const largeRequest = await decideAssistantConfiguration({ ...defaults, state: "x".repeat(256 * 1024), fetchImpl: () => { calls += 1; } });
  assert.equal(largeRequest.error.code, "request_too_large");
  assert.equal(calls, 0);
});

test("invalid input, duplicate options, and unsafe paths fail closed", async () => {
  for (const options of [
    { threshold: NaN },
    { threshold: 0.2 },
    { timeoutMs: 0 },
    { state: null },
    { candidates: { fields: [{ id: "language", options: ["en-US", "en-US"] }] } },
    { candidates: { fields: [{ id: "language", options: ["keep_current"] }] } },
    { candidates: { fields: [{ id: "language", path: "__proto__.polluted", options: ["en-US"] }] } },
    { candidates: { fields: [{ id: "language" }, { id: "language" }] } },
  ]) {
    const result = await decideAssistantConfiguration({ ...defaults, fetchImpl: mockFetch().fetchImpl, ...options });
    assert.equal(result.status, "unavailable");
    assert.equal(Object.hasOwn({}, "polluted"), false);
  }
});

test("enforcement preserves exact chosen IDs and does not mutate the generated object", async () => {
  const currentPreset = { elevenlabsStability: 0.45, elevenlabsStyle: 0.2, elevenlabsSpeed: 1 };
  const mock = mockFetch({ route: "speakerProfile", "speakers.0.voiceId": "exact-voice-id", "speakers.0.deliveryPreset": "keep_current" });
  const result = await decideAssistantConfiguration({ ...defaults, ...mock, candidates: { fields: [
    { id: "speakers.0.voiceId", options: ["exact-voice-id"] },
    { id: "speakers.0.deliveryPreset", path: "speakers.0", merge: true, currentValue: currentPreset, options: [{ id: "calm", value: { elevenlabsStability: 0.8, elevenlabsStyle: 0, elevenlabsSpeed: 0.9 } }] },
  ] } });
  const generated = { speakers: [{ name: "Ana", voiceId: "invented", elevenlabsStability: 0.111, elevenlabsStyle: 0.999, elevenlabsSpeed: 1.2 }] };
  const output = enforceJevSelections(generated, result);
  assert.deepEqual(output.speakers[0], { name: "Ana", voiceId: "exact-voice-id", ...currentPreset });
  assert.equal(generated.speakers[0].voiceId, "invented");
  assert.equal(generated.speakers[0].elevenlabsSpeed, 1.2);
});

test("preset patches cannot override explicit model or voice choices", async () => {
  const mock = mockFetch({ route: "speakerProfile", "speakers.0.voiceId": "chosen-voice", "speakers.0.deliveryPreset": "calm" });
  const result = await decideAssistantConfiguration({ ...defaults, ...mock, candidates: { fields: [
    { id: "speakers.0.voiceId", options: ["chosen-voice"] },
    { id: "speakers.0.deliveryPreset", path: "speakers.0", merge: true, options: [{ id: "calm", value: { voiceId: "old-preset-voice", stability: 0.8 } }] },
  ] } });
  assert.equal(result.status, "ready");
  const output = enforceJevSelections({ speakers: [{ voiceId: "generated-voice" }] }, result);
  assert.deepEqual(output.speakers[0], { voiceId: "chosen-voice", stability: 0.8 });
});
