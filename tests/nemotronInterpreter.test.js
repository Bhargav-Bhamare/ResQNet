const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_OUTPUT_TOKENS,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  NemotronInterpreterError,
  createNemotronInterpreter,
  createSystemPrompt,
  createUserPrompt,
  prepareInterpretation,
} = require("../services/ai/nemotronInterpreter");
const { evidenceSnapshot, interpretationOutput } = require("./aiFixtures");

function providerResult(content, overrides = {}) {
  return {
    provider: "nebius",
    model: "nvidia/Nemotron-3_5-Lightning",
    content,
    finishReason: "stop",
    usage: {
      promptTokens: 200,
      completionTokens: 100,
      totalTokens: 300,
    },
    requestId: "chatcmpl-synthetic",
    latencyMs: 1200,
    ...overrides,
  };
}

test("prompt is versioned, bounded, and explicitly treats evidence as untrusted data", () => {
  const prompt = createSystemPrompt();
  assert.match(prompt, new RegExp(`prompt version ${PROMPT_VERSION}`, "i"));
  assert.match(prompt, /untrusted data/i);
  assert.match(prompt, /Never declare an outbreak/i);
  assert.match(prompt, /Required JSON schema/i);
  assert.match(prompt, /eligible_received_reports/);
  assert.match(prompt, /observedFacts\.eligibleReceivedReports/);
  assert.equal(MAX_OUTPUT_TOKENS, 2048);
});

test("user prompt includes only the sanitized allowlisted evidence", () => {
  const prepared = prepareInterpretation(evidenceSnapshot(), "null-signal-evidence-package.v1");
  const prompt = createUserPrompt(prepared.sanitized);

  assert.match(prompt, /expectedReports/);
  assert.doesNotMatch(prompt, /SYNTHETIC-SOURCE|Synthetic Patient|source-secret|symptom description/);
});

test("interpreter calls Task 12 interface with conservative JSON parameters", async () => {
  let observed;
  const snapshot = evidenceSnapshot();
  const interpreter = createNemotronInterpreter({
    clientFactory() {
      return {
        async generateChatCompletion(options) {
          observed = options;
          return providerResult(
            JSON.stringify(interpretationOutput(snapshot)),
          );
        },
      };
    },
  });
  const prepared = interpreter.prepareInterpretation(snapshot, snapshot.schemaVersion);
  const result = await interpreter.interpretPreparedEvidence(prepared);

  assert.equal(observed.temperature, 0);
  assert.equal(observed.maxTokens, MAX_OUTPUT_TOKENS);
  assert.deepEqual(observed.responseFormat, { type: "json_object" });
  assert.equal(observed.reasoningEffort, "none");
  assert.equal(result.provider, "nebius");
  assert.equal(result.model, "nvidia/Nemotron-3_5-Lightning");
  assert.equal(result.promptVersion, PROMPT_VERSION);
  assert.equal(result.schemaVersion, SCHEMA_VERSION);
  assert.equal(result.validationStatus, "validated");
  assert.equal(result.usage.totalTokens, 300);
  assert.equal(result.latencyMs, 1200);
  assert.equal(result.providerRequestId, "chatcmpl-synthetic");
});

test("sanitized evidence hash is stable and changes when allowed evidence changes", () => {
  const first = prepareInterpretation(evidenceSnapshot(), "null-signal-evidence-package.v1");
  const equivalent = prepareInterpretation(
    evidenceSnapshot({
      snapshot: {
        calculatedFindings: {
          anomaly: {
            explanation: "different excluded prose",
          },
        },
      },
    }),
    "null-signal-evidence-package.v1",
  );
  const changed = prepareInterpretation(
    evidenceSnapshot({
      observedFacts: { eligibleReceivedReports: 1 },
    }),
    "null-signal-evidence-package.v1",
  );

  assert.match(first.evidenceHash, /^[a-f0-9]{64}$/);
  assert.equal(first.evidenceHash, equivalent.evidenceHash);
  assert.notEqual(first.evidenceHash, changed.evidenceHash);
});

test("interpreter rejects invalid JSON and provider output without saving fallback", async () => {
  const interpreter = createNemotronInterpreter({
    clientFactory: () => ({
      async generateChatCompletion() {
        return providerResult("not json");
      },
    }),
  });
  const prepared = interpreter.prepareInterpretation(
    evidenceSnapshot(),
    "null-signal-evidence-package.v1",
  );

  await assert.rejects(
    interpreter.interpretPreparedEvidence(prepared),
    (error) =>
      error instanceof NemotronInterpreterError &&
      error.code === "INVALID_MODEL_JSON" &&
      error.status === 502,
  );
});

test("interpreter maps provider configuration, quota, timeout, and rate-limit failures", async () => {
  for (const [providerCode, expectedCode, expectedStatus] of [
    ["CONFIGURATION_ERROR", "PROVIDER_NOT_CONFIGURED", 503],
    ["QUOTA_EXCEEDED", "PROVIDER_QUOTA_EXCEEDED", 503],
    ["REQUEST_TIMEOUT", "PROVIDER_TIMEOUT", 504],
    ["RATE_LIMITED", "PROVIDER_RATE_LIMITED", 429],
  ]) {
    const interpreter = createNemotronInterpreter({
      clientFactory: () => ({
        async generateChatCompletion() {
          throw Object.assign(new Error("secret and raw provider body"), {
            code: providerCode,
          });
        },
      }),
    });
    const prepared = interpreter.prepareInterpretation(
      evidenceSnapshot(),
      "null-signal-evidence-package.v1",
    );
    await assert.rejects(
      interpreter.interpretPreparedEvidence(prepared),
      (error) => {
        assert.equal(error.code, expectedCode);
        assert.equal(error.status, expectedStatus);
        assert.doesNotMatch(error.message, /secret|raw provider/i);
        return true;
      },
    );
  }
});

test("interpreter rejects malformed normalized provider responses", async () => {
  const interpreter = createNemotronInterpreter({
    clientFactory: () => ({
      async generateChatCompletion() {
        return providerResult(JSON.stringify(interpretationOutput(evidenceSnapshot())), {
          model: null,
        });
      },
    }),
  });
  const prepared = interpreter.prepareInterpretation(
    evidenceSnapshot(),
    "null-signal-evidence-package.v1",
  );

  await assert.rejects(
    interpreter.interpretPreparedEvidence(prepared),
    (error) => error.code === "INVALID_PROVIDER_RESPONSE",
  );
});
