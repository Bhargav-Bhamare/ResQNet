const test = require("node:test");
const assert = require("node:assert/strict");
const calculateHistoricalBaseline = require("../services/historicalBaseline");

function observation(index, overrides = {}) {
  const start = new Date(Date.UTC(2026, 0, index + 1));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    sourceCode: "CLINIC-001",
    frequency: "daily",
    periodStart: start,
    periodEnd: end,
    expectedReports: 10,
    eligibleReceivedReports: 10,
    status: "complete",
    channelAvailability: "unknown",
    isTrusted: true,
    ...overrides,
  };
}

function calculate(observations, overrides = {}) {
  return calculateHistoricalBaseline({
    sourceCode: "CLINIC-001",
    frequency: "daily",
    observations,
    minimumObservations: 3,
    asOf: "2026-02-01T00:00:00.000Z",
    ...overrides,
  });
}

test("calculates mean, median, minimum, maximum, and population standard deviation", () => {
  const baseline = calculate([
    observation(0, { eligibleReceivedReports: 10 }),
    observation(1, { eligibleReceivedReports: 9 }),
    observation(2, { eligibleReceivedReports: 11 }),
  ]);

  assert.equal(baseline.status, "ready");
  assert.equal(baseline.validHistoricalPeriods, 3);
  assert.equal(baseline.meanEligibleReports, 10);
  assert.equal(baseline.medianEligibleReports, 10);
  assert.equal(baseline.minimumEligibleReports, 9);
  assert.equal(baseline.maximumEligibleReports, 11);
  assert.equal(baseline.populationStandardDeviation, Math.sqrt(2 / 3));
  assert.equal(baseline.expectedReportsPerPeriod, 10);
});

test("calculates even-sized median and a changing expected count explicitly", () => {
  const baseline = calculate([
    observation(0, { eligibleReceivedReports: 2, expectedReports: 10 }),
    observation(1, { eligibleReceivedReports: 4, expectedReports: 12 }),
    observation(2, { eligibleReceivedReports: 6, expectedReports: 12 }),
    observation(3, { eligibleReceivedReports: 8, expectedReports: 14 }),
  ]);

  assert.equal(baseline.medianEligibleReports, 5);
  assert.equal(baseline.expectedReportsPerPeriod, null);
});

test("excludes in-progress, inactive, not-applicable, and unavailable periods", () => {
  const baseline = calculate([
    observation(0, { eligibleReceivedReports: 8 }),
    observation(1, { status: "in_progress", eligibleReceivedReports: 0 }),
    observation(2, { status: "inactive", eligibleReceivedReports: 0 }),
    observation(3, { status: "not_applicable", eligibleReceivedReports: 0 }),
    observation(4, { status: "channel_unavailable", eligibleReceivedReports: 0 }),
    observation(5, {
      status: "complete",
      channelAvailability: "unavailable",
      eligibleReceivedReports: 0,
    }),
    observation(6, { eligibleReceivedReports: 10 }),
    observation(7, { eligibleReceivedReports: 12 }),
  ]);

  assert.equal(baseline.validHistoricalPeriods, 3);
  assert.equal(baseline.meanEligibleReports, 10);
  assert.deepEqual(baseline.excluded, {
    untrusted: 0,
    frequencyMismatch: 0,
    inProgress: 1,
    inactive: 1,
    notApplicable: 1,
    channelUnavailable: 2,
    future: 0,
  });
});

test("includes zero counts only for completed trusted available periods", () => {
  const baseline = calculate([
    observation(0, { eligibleReceivedReports: 0 }),
    observation(1, { eligibleReceivedReports: 10 }),
    observation(2, { eligibleReceivedReports: 10 }),
  ]);

  assert.equal(baseline.status, "ready");
  assert.equal(baseline.meanEligibleReports, 20 / 3);
  assert.equal(baseline.minimumEligibleReports, 0);
});

test("returns insufficient_history when valid observation minimum is not met", () => {
  const baseline = calculate([
    observation(0, { eligibleReceivedReports: 10 }),
    observation(1, { eligibleReceivedReports: 10 }),
    observation(2, { isTrusted: false }),
  ]);

  assert.equal(baseline.status, "insufficient_history");
  assert.equal(baseline.validHistoricalPeriods, 2);
  assert.equal(baseline.meanEligibleReports, null);
  assert.equal(baseline.excluded.untrusted, 1);
});

test("does not mix daily and weekly observations", () => {
  const baseline = calculate([
    observation(0, { eligibleReceivedReports: 10 }),
    observation(1, {
      frequency: "weekly",
      eligibleReceivedReports: 100,
    }),
    observation(2, { eligibleReceivedReports: 12 }),
    observation(3, { eligibleReceivedReports: 14 }),
  ]);

  assert.equal(baseline.validHistoricalPeriods, 3);
  assert.equal(baseline.meanEligibleReports, 12);
  assert.equal(baseline.excluded.frequencyMismatch, 1);
});

test("excludes untrusted observations even when sourceCode matches", () => {
  const baseline = calculate([
    observation(0, { eligibleReceivedReports: 100, isTrusted: false }),
    observation(1, { eligibleReceivedReports: 10 }),
    observation(2, { eligibleReceivedReports: 10 }),
    observation(3, { eligibleReceivedReports: 10 }),
  ]);

  assert.equal(baseline.meanEligibleReports, 10);
  assert.equal(baseline.excluded.untrusted, 1);
});

test("rejects missing report counts instead of treating them as zero", () => {
  assert.throws(
    () =>
      calculate([
        observation(0),
        observation(1, { eligibleReceivedReports: undefined }),
        observation(2),
      ]),
    /eligibleReceivedReports must be a non-negative integer/,
  );
});

test("rejects missing period and expected-count data", () => {
  assert.throws(
    () => calculate([observation(0, { periodStart: undefined })]),
    /periodStart must be a valid date/,
  );
  assert.throws(
    () => calculate([observation(0, { expectedReports: undefined })]),
    /expectedReports must be a positive integer/,
  );
});

test("excludes future periods even if marked completed", () => {
  const baseline = calculate([
    observation(0, { eligibleReceivedReports: 10 }),
    observation(1, {
      periodStart: "2026-02-02T00:00:00.000Z",
      periodEnd: "2026-02-03T00:00:00.000Z",
      eligibleReceivedReports: 100,
    }),
    observation(2, { eligibleReceivedReports: 10 }),
    observation(3, { eligibleReceivedReports: 10 }),
  ]);

  assert.equal(baseline.validHistoricalPeriods, 3);
  assert.equal(baseline.excluded.future, 1);
  assert.equal(baseline.meanEligibleReports, 10);
});

test("rejects observations for another source and duplicate periods", () => {
  assert.throws(
    () => calculate([observation(0, { sourceCode: "OTHER" })]),
    /does not match sourceCode/,
  );
  assert.throws(
    () => calculate([observation(0), observation(0)]),
    /Duplicate historical period/,
  );
});
