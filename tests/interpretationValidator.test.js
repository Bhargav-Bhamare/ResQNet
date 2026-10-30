const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PROMPT_VERSION,
  SCHEMA_VERSION,
  InterpretationValidationError,
  validateInterpretationOutput,
} = require("../services/ai/interpretationValidator");
const {
  sanitizeEvidenceSnapshot,
  EVIDENCE_VERSION,
} = require("../services/ai/evidenceSanitizer");
const { evidenceSnapshot, interpretationOutput } = require("./aiFixtures");

function validationContext(snapshot = evidenceSnapshot()) {
  return sanitizeEvidenceSnapshot(snapshot, EVIDENCE_VERSION);
}

function validate(output, context = validationContext()) {
  return validateInterpretationOutput(JSON.stringify(output), {
    evidence: context.sanitized,
    availableReferences: context.availableReferences,
  });
}

test("validator accepts strict JSON and attaches exact evidence values server-side", () => {
  const context = validationContext();
  const result = validate(interpretationOutput(context.sanitized), context);

  assert.equal(result.schemaVersion, SCHEMA_VERSION);
  assert.equal(result.promptVersion, PROMPT_VERSION);
  assert.equal(result.interpretation.observedFacts[0].value, 0);
  assert.deepEqual(result.interpretation.observedFacts[0].evidenceRefs, [
    "observedFacts.eligibleReceivedReports",
  ]);
  assert.equal(result.interpretation.supportingEvidence[0].value, 10);
});

test("validator rejects malformed JSON, extra properties, and missing fields", () => {
  const context = validationContext();
  assert.throws(
    () => validateInterpretationOutput("{not-json", {
      evidence: context.sanitized,
      availableReferences: context.availableReferences,
    }),
    (error) => error.code === "INVALID_MODEL_JSON",
  );
  for (const output of [
    { ...interpretationOutput(context.sanitized), extra: "unexpected" },
    {
      ...interpretationOutput(context.sanitized),
      interpretation: {
        ...interpretationOutput(context.sanitized).interpretation,
        ignored: true,
      },
    },
    {
      ...interpretationOutput(context.sanitized),
      interpretation: {
        ...interpretationOutput(context.sanitized).interpretation,
        headline: "",
      },
    },
  ]) {
    assert.throws(
      () => validate(output, context),
      (error) => error.code === "INVALID_MODEL_OUTPUT",
    );
  }
});

test("validator rejects invalid enums and oversized response arrays", () => {
  const context = validationContext();
  const invalidEnum = interpretationOutput(context.sanitized, {
    interpretation: { findingType: "outbreak_confirmed" },
  });
  assert.throws(
    () => validate(invalidEnum, context),
    (error) => error.code === "INVALID_MODEL_OUTPUT",
  );

  const tooManyUnknowns = interpretationOutput(context.sanitized, {
    interpretation: { unknowns: Array(9).fill("An unknown fact.") },
  });
  assert.throws(
    () => validate(tooManyUnknowns, context),
    (error) => error.code === "INVALID_MODEL_OUTPUT",
  );
});

test("validator rejects fabricated, missing, and mismatched evidence references", () => {
  const context = validationContext();
  const fabricated = interpretationOutput(context.sanitized, {
    interpretation: {
      observedFacts: [
        {
          factCode: "eligible_received_reports",
          evidenceRefs: ["rawReports.patientName"],
        },
      ],
    },
  });
  assert.throws(
    () => validate(fabricated, context),
    (error) => error.code === "INVALID_EVIDENCE_REFERENCE",
  );

  const missing = interpretationOutput(context.sanitized, {
    interpretation: {
      observedFacts: [
        {
          factCode: "eligible_received_reports",
          evidenceRefs: [],
        },
      ],
    },
  });
  assert.throws(
    () => validate(missing, context),
    (error) => error.code === "INVALID_EVIDENCE_REFERENCE",
  );
});

test("validator rejects unsupported outbreak, misconduct, and clinical conclusions", () => {
  const context = validationContext();
  for (const phrase of [
    "The outbreak has ended.",
    "The institution is hiding reports.",
    "The patient needs a diagnosis.",
  ]) {
    const output = interpretationOutput(context.sanitized, {
      interpretation: { executiveSummary: phrase },
    });
    assert.throws(
      () => validate(output, context),
      (error) => error.code === "UNSUPPORTED_CONCLUSION",
    );
  }
});

test("validator rejects unsupported numeric claims and false channel certainty", () => {
  const context = validationContext();
  const numeric = interpretationOutput(context.sanitized, {
    interpretation: { executiveSummary: "Reports fell by 90 percent." },
  });
  assert.throws(
    () => validate(numeric, context),
    (error) => error.code === "UNSUPPORTED_NUMERIC_CLAIM",
  );

  const channelClaim = interpretationOutput(context.sanitized, {
    interpretation: {
      executiveSummary: "The reporting channel is available and operational.",
    },
  });
  assert.throws(
    () => validate(channelClaim, context),
    (error) => error.code === "EVIDENCE_CONTRADICTION",
  );
});

test("validator rejects classifications that conflict with deterministic results", () => {
  const context = validationContext();
  const contradictory = interpretationOutput(context.sanitized, {
    interpretation: { findingType: "no_significant_discontinuity" },
  });
  assert.throws(
    () => validate(contradictory, context),
    (error) => error.code === "EVIDENCE_CONTRADICTION",
  );
});

test("validator classifies missing baseline evidence as insufficient", () => {
  const snapshot = evidenceSnapshot({
    observedFacts: { historicalObservationCount: 2 },
    baseline: {
      status: "insufficient_history",
      meanEligibleReports: null,
      medianEligibleReports: null,
      minimumEligibleReports: null,
      maximumEligibleReports: null,
      populationStandardDeviation: null,
      expectedReportsPerPeriod: null,
    },
    snapshot: {
      calculatedFindings: {
        historicalBaseline: {
          status: "insufficient_history",
          minimumObservations: 5,
          meanEligibleReports: null,
          medianEligibleReports: null,
          minimumEligibleReports: null,
          maximumEligibleReports: null,
          populationStandardDeviation: null,
          expectedReportsPerPeriod: null,
        },
      },
    },
  });
  const context = validationContext(snapshot);
  const output = interpretationOutput(context.sanitized, {
    interpretation: { evidenceStrength: "moderate" },
  });

  assert.throws(
    () => validate(output, context),
    (error) => error.code === "EVIDENCE_CONTRADICTION",
  );
});

test("validator surfaces typed validation errors", () => {
  assert.ok(InterpretationValidationError);
});
