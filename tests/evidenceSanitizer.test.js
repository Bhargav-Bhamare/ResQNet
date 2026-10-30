const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EVIDENCE_VERSION,
  SANITIZED_EVIDENCE_VERSION,
  EvidenceSanitizationError,
  sanitizeEvidenceSnapshot,
  stableStringify,
} = require("../services/ai/evidenceSanitizer");
const { evidenceSnapshot } = require("./aiFixtures");

test("sanitizer allowlists deterministic metrics and excludes identifying or free-text fields", () => {
  const result = sanitizeEvidenceSnapshot(
    evidenceSnapshot(),
    EVIDENCE_VERSION,
  );
  const promptData = JSON.stringify(result.sanitized);

  assert.equal(result.sanitized.schemaVersion, SANITIZED_EVIDENCE_VERSION);
  assert.equal(result.sanitized.evidenceVersion, EVIDENCE_VERSION);
  assert.equal(result.sanitized.observedFacts.eligibleReceivedReports, 0);
  assert.equal(
    result.sanitized.calculatedFindings.historicalBaseline.meanEligibleReports,
    10,
  );
  for (const excluded of [
    "SYNTHETIC-SOURCE",
    "Synthetic Patient",
    "+15555550123",
    "raw symptom description",
    "source-secret",
    "reveal secrets",
    "Ignore prior instructions",
    "rawReports",
    "unexpected",
  ]) {
    assert.equal(promptData.includes(excluded), false);
  }
});

test("sanitizer preserves null metrics and unknown channel status", () => {
  const snapshot = evidenceSnapshot({
    observedFacts: {
      eligibleReceivedReports: null,
      channelAvailability: "unknown",
      periodStatus: "in_progress",
      historicalObservationCount: 2,
    },
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
        completeness: { status: "in_progress", percent: null },
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
        anomaly: {
          status: "insufficient_history",
          type: null,
          deviationCategory: null,
          absoluteDifference: null,
          percentageDeviation: null,
        },
      },
    },
  });
  const { sanitized } = sanitizeEvidenceSnapshot(snapshot, EVIDENCE_VERSION);

  assert.equal(sanitized.observedFacts.eligibleReceivedReports, null);
  assert.equal(sanitized.observedFacts.channelAvailability, "unknown");
  assert.equal(sanitized.calculatedFindings.completeness.percent, null);
  assert.equal(sanitized.calculatedFindings.anomaly.type, null);
});

test("sanitizer rejects unsupported evidence versions and missing required fields", () => {
  assert.throws(
    () =>
      sanitizeEvidenceSnapshot(
        { ...evidenceSnapshot(), schemaVersion: "future.v2" },
        "future.v2",
      ),
    (error) => error.code === "UNSUPPORTED_EVIDENCE_VERSION",
  );
  assert.throws(
    () =>
      sanitizeEvidenceSnapshot(
        { schemaVersion: EVIDENCE_VERSION },
        EVIDENCE_VERSION,
      ),
    (error) => error.code === "INVALID_EVIDENCE",
  );
});

test("sanitizer rejects mismatched stored version and inconsistent status values", () => {
  assert.throws(
    () => sanitizeEvidenceSnapshot(evidenceSnapshot(), "different.v1"),
    (error) => error.code === "INVALID_EVIDENCE",
  );
  const inconsistent = evidenceSnapshot({
    snapshot: {
      calculatedFindings: {
        completeness: { status: "complete", percent: 100 },
      },
    },
  });
  assert.throws(
    () => sanitizeEvidenceSnapshot(inconsistent, EVIDENCE_VERSION),
    (error) => error.code === "INCONSISTENT_EVIDENCE",
  );
});

test("sanitizer enforces a bounded, allowlisted evidence payload", () => {
  const oversized = evidenceSnapshot({
    snapshot: {
      metadata: {
        expectedReportsPerPeriod: 10,
      },
      calculatedFindings: {
        anomaly: {
          type: "a".repeat(101),
          status: "anomaly",
        },
      },
    },
  });
  assert.throws(
    () => sanitizeEvidenceSnapshot(oversized, EVIDENCE_VERSION),
    (error) => error.code === "INVALID_EVIDENCE",
  );

  const largeUnapprovedContent = evidenceSnapshot();
  largeUnapprovedContent.metadata.sourceName = "unapproved".repeat(100_000);
  largeUnapprovedContent.evidence.largeRawPayload = "private".repeat(100_000);
  const sanitized = sanitizeEvidenceSnapshot(
    largeUnapprovedContent,
    EVIDENCE_VERSION,
  );
  assert.ok(sanitized.canonicalInput.length < 12_000);
  assert.equal(sanitized.canonicalInput.includes("unapproved"), false);
  assert.equal(sanitized.canonicalInput.includes("private"), false);
});

test("canonical JSON sorts object keys while preserving array order", () => {
  assert.equal(stableStringify({ b: 2, a: { d: 4, c: 3 } }), stableStringify({ a: { c: 3, d: 4 }, b: 2 }));
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
});

test("sanitizer error uses a safe stable error code", () => {
  assert.ok(EvidenceSanitizationError);
});
