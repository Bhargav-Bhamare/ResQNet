const test = require("node:test");
const assert = require("node:assert/strict");
const calculateHistoricalBaseline = require("../services/historicalBaseline");
const { detectReportingAnomaly } = require("../services/reportingAnomaly");

function baseline(counts, overrides = {}) {
  const observations = counts.map((count, index) => {
    const start = new Date(Date.UTC(2026, 0, index + 1));
    return {
      sourceCode: "CLINIC-001",
      frequency: "daily",
      periodStart: start,
      periodEnd: new Date(start.getTime() + 86400000),
      expectedReports: 10,
      eligibleReceivedReports: count,
      status: "complete",
      isTrusted: true,
    };
  });

  return calculateHistoricalBaseline({
    sourceCode: "CLINIC-001",
    frequency: "daily",
    observations,
    minimumObservations: 3,
    asOf: "2026-02-01T00:00:00.000Z",
    ...overrides,
  });
}

function current(overrides = {}) {
  return {
    sourceCode: "CLINIC-001",
    frequency: "daily",
    periodStart: "2026-02-01T00:00:00.000Z",
    periodEnd: "2026-02-02T00:00:00.000Z",
    expectedReports: 10,
    eligibleReceivedReports: 10,
    status: "complete",
    isTrusted: true,
    ...overrides,
  };
}

test("classifies ordinary reporting variation as normal", () => {
  const result = detectReportingAnomaly({
    currentObservation: current({ eligibleReceivedReports: 9 }),
    baseline: baseline([9, 10, 11, 10, 10]),
  });

  assert.equal(result.status, "normal_variation");
  assert.equal(result.anomalyType, null);
  assert.equal(result.historicalMean, 10);
  assert.equal(result.percentageDeviation, -10);
});

test("flags unusually low reporting with its statistical evidence", () => {
  const result = detectReportingAnomaly({
    currentObservation: current({ eligibleReceivedReports: 7 }),
    baseline: baseline([9, 10, 11, 10, 10]),
  });

  assert.equal(result.status, "anomaly");
  assert.equal(result.anomalyType, "unusually_low_reporting");
  assert.equal(result.currentEligibleReports, 7);
  assert.equal(result.historicalObservationCount, 5);
  assert.equal(result.absoluteDifference, 3);
  assert.match(result.explanation, /reason.*not been established/i);
  assert.equal(
    result.evidence.calculatedFindings.currentMinusHistoricalMean,
    -3,
  );
  assert.equal(
    result.evidence.observedFacts.eligibleReceivedReports,
    7,
  );
  assert.equal(
    result.evidence.calculatedFindings.historicalMean,
    10,
  );
  assert.deepEqual(result.possibleExplanations, []);
  assert.ok(result.unknowns.length > 0);
});

test("flags a sudden large drop separately", () => {
  const result = detectReportingAnomaly({
    currentObservation: current({ eligibleReceivedReports: 4 }),
    baseline: baseline([10, 10, 10, 10, 10]),
  });

  assert.equal(result.anomalyType, "sudden_reporting_drop");
  assert.equal(result.deviationCategory, "large_drop");
  assert.equal(result.percentageDeviation, -60);
});

test("flags a zero-report period against a non-zero historical pattern", () => {
  const result = detectReportingAnomaly({
    currentObservation: current({
      eligibleReceivedReports: 0,
      status: "reporting_gap",
    }),
    baseline: baseline([10, 9, 11, 10, 10]),
  });

  assert.equal(result.anomalyType, "zero_report_period");
  assert.equal(result.status, "anomaly");
  assert.equal(result.percentageDeviation, -100);
});

test("does not flag an in-progress period", () => {
  const result = detectReportingAnomaly({
    currentObservation: current({
      eligibleReceivedReports: 0,
      status: "in_progress",
    }),
    baseline: baseline([10, 10, 10, 10, 10]),
  });

  assert.equal(result.status, "in_progress");
  assert.equal(result.anomalyType, null);
});

test("reports an explicitly unavailable channel without inferring an anomaly", () => {
  const result = detectReportingAnomaly({
    currentObservation: current({
      eligibleReceivedReports: 0,
      status: "reporting_gap",
    }),
    baseline: baseline([10, 10, 10, 10, 10]),
    channelAvailability: "unavailable",
  });

  assert.equal(result.status, "channel_unavailable");
  assert.equal(result.anomalyType, null);
});

test("returns insufficient history when the baseline sample is too small", () => {
  const result = detectReportingAnomaly({
    currentObservation: current({ eligibleReceivedReports: 0 }),
    baseline: baseline([10, 10], { minimumObservations: 3 }),
  });

  assert.equal(result.status, "insufficient_history");
  assert.equal(result.anomalyType, null);
});

test("handles a zero historical mean without division by zero", () => {
  const zeroBaseline = baseline([0, 0, 0, 0, 0]);
  const result = detectReportingAnomaly({
    currentObservation: current({ eligibleReceivedReports: 0 }),
    baseline: zeroBaseline,
  });

  assert.equal(result.status, "normal_variation");
  assert.equal(result.percentageDeviation, null);
});

test("handles zero historical variance and detects a material drop", () => {
  const result = detectReportingAnomaly({
    currentObservation: current({ eligibleReceivedReports: 8 }),
    baseline: baseline([10, 10, 10, 10, 10]),
  });

  assert.equal(
    result.evidence.calculatedFindings.historicalPopulationStandardDeviation,
    0,
  );
  assert.equal(result.status, "anomaly");
  assert.equal(result.anomalyType, "unusually_low_reporting");
});

test("percentage deviation is null for a positive current count over zero baseline", () => {
  const result = detectReportingAnomaly({
    currentObservation: current({ eligibleReceivedReports: 3 }),
    baseline: baseline([0, 0, 0, 0, 0]),
  });

  assert.equal(result.percentageDeviation, null);
  assert.equal(result.status, "normal_variation");
  assert.match(result.explanation, /percentage deviation is undefined/i);
});

test("does not treat a matching sourceCode as a trust decision", () => {
  const result = detectReportingAnomaly({
    currentObservation: current({
      eligibleReceivedReports: 0,
      isTrusted: false,
    }),
    baseline: baseline([10, 10, 10, 10, 10]),
  });

  assert.equal(result.status, "untrusted_observation");
  assert.equal(result.anomalyType, null);
});

test("rejects malformed or missing inputs and invalid thresholds", () => {
  assert.throws(
    () => detectReportingAnomaly({ baseline: baseline([10, 10, 10]) }),
    /currentObservation must be an object/,
  );
  assert.throws(
    () =>
      detectReportingAnomaly({
        currentObservation: current({ eligibleReceivedReports: null }),
        baseline: baseline([10, 10, 10]),
      }),
    /eligibleReceivedReports must be a non-negative integer/,
  );
  assert.throws(
    () =>
      detectReportingAnomaly({
        currentObservation: current(),
        baseline: baseline([10, 10, 10]),
        thresholds: { suddenDropRatio: 0.9 },
      }),
    /suddenDropRatio/,
  );
});

test("returns deterministic results for identical inputs", () => {
  const input = {
    currentObservation: current({ eligibleReceivedReports: 4 }),
    baseline: baseline([10, 10, 10, 10, 10]),
  };

  assert.deepEqual(
    detectReportingAnomaly(input),
    detectReportingAnomaly(input),
  );
});
