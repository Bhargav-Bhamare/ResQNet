const test = require("node:test");
const assert = require("node:assert/strict");
const createEvidencePackage = require("../services/evidencePackage");
const calculateReportingCompleteness = require("../services/reportingCompleteness");
const calculateHistoricalBaseline = require("../services/historicalBaseline");
const { detectReportingAnomaly } = require("../services/reportingAnomaly");

const evaluatedAt = "2026-02-02T18:00:00.000Z";
const periodStart = "2026-02-01T00:00:00.000Z";
const periodEnd = "2026-02-02T00:00:00.000Z";

function inputs(overrides = {}) {
  return {
    evaluatedAt,
    source: {
      sourceCode: "CLINIC-001",
      name: "Configured clinic",
      frequency: "daily",
    },
    completeness: {
      sourceCode: "CLINIC-001",
      status: "incomplete",
      period: {
        start: periodStart,
        end: periodEnd,
        deadline: periodEnd,
        timezone: "UTC",
      },
      expectedReports: 10,
      receivedReports: 7,
      completenessPercent: 70,
      channelAvailability: "available",
    },
    baseline: {
      sourceCode: "CLINIC-001",
      frequency: "daily",
      status: "ready",
      minimumObservations: 5,
      validHistoricalPeriods: 5,
      excluded: { untrusted: 1 },
      meanEligibleReports: 10,
      medianEligibleReports: 10,
      minimumEligibleReports: 8,
      maximumEligibleReports: 12,
      populationStandardDeviation: 1.2,
      expectedReportsPerPeriod: 10,
    },
    anomaly: {
      status: "anomaly",
      anomalyType: "unusually_low_reporting",
      deviationCategory: "material_drop",
      currentEligibleReports: 7,
      historicalMean: 10,
      historicalMedian: 10,
      absoluteDifference: 3,
      percentageDeviation: -30,
      historicalObservationCount: 5,
      explanation:
        "Reporting activity is below the established historical pattern; the reason has not been established.",
      possibleExplanations: [],
      unknowns: ["The cause is unknown."],
      limitations: ["Reporting activity does not establish disease incidence."],
      evidence: {
        observedFacts: {
          sourceCode: "CLINIC-001",
          periodStart,
          periodEnd,
          expectedReports: 10,
          eligibleReceivedReports: 7,
          status: "incomplete",
          channelAvailability: "available",
        },
        calculatedFindings: {
          historicalMean: 10,
          historicalMedian: 10,
          historicalPopulationStandardDeviation: 1.2,
          currentMinusHistoricalMean: -3,
          absoluteDifference: 3,
          percentageDeviation: -30,
        },
      },
    },
    thresholds: {
      minimumHistoricalPeriods: 5,
      unusuallyLowRatio: 0.75,
    },
    ...overrides,
  };
}

test("assembles a complete package from calculation service results", () => {
  const result = createEvidencePackage(inputs());

  assert.equal(result.schemaVersion, "null-signal-evidence-package.v1");
  assert.match(result.packageId, /^ep_[a-f0-9]{24}$/);
  assert.equal(result.metadata.evaluatedAt, evaluatedAt);
  assert.equal(result.summary.sourceCode, "CLINIC-001");
  assert.equal(result.summary.completenessPercent, 70);
  assert.equal(result.calculatedFindings.anomaly.type, "unusually_low_reporting");
});

test("assembles outputs produced by the actual calculation services", () => {
  const evaluatedAt = "2026-02-02T18:00:00.000Z";
  const source = {
    name: "Configured clinic",
    sourceCode: "CLINIC-001",
    isActive: true,
    validFrom: "2026-01-01T00:00:00.000Z",
    reportingSchedule: {
      frequency: "daily",
      expectedReportsPerPeriod: 10,
      reportingTime: "17:00",
      timezone: "UTC",
    },
  };
  const reports = Array.from({ length: 7 }, (_, index) => ({
    _id: `trusted-current-${index}`,
    sourceId: "CLINIC-001",
    submittedAt: `2026-02-02T${String(8 + index).padStart(2, "0")}:00:00.000Z`,
  }));
  const completeness = calculateReportingCompleteness({
    sources: [source],
    reports,
    trustedReportIds: reports.map((report) => report._id),
    now: evaluatedAt,
  })[0];
  const observations = Array.from({ length: 5 }, (_, index) => {
    const start = new Date(Date.UTC(2026, 0, 28 + index));
    return {
      sourceCode: "CLINIC-001",
      frequency: "daily",
      periodStart: start,
      periodEnd: new Date(start.getTime() + 86400000),
      expectedReports: 10,
      eligibleReceivedReports: 10,
      status: "complete",
      isTrusted: true,
    };
  });
  const baseline = calculateHistoricalBaseline({
    sourceCode: "CLINIC-001",
    frequency: "daily",
    observations,
    minimumObservations: 5,
    asOf: evaluatedAt,
  });
  const anomaly = detectReportingAnomaly({
    currentObservation: {
      sourceCode: "CLINIC-001",
      frequency: "daily",
      periodStart: completeness.period.start,
      periodEnd: completeness.period.end,
      expectedReports: completeness.expectedReports,
      eligibleReceivedReports: completeness.receivedReports,
      status: completeness.status,
      channelAvailability: completeness.channelAvailability,
      isTrusted: true,
    },
    baseline,
  });

  const result = createEvidencePackage({
    evaluatedAt,
    source: {
      sourceCode: source.sourceCode,
      name: source.name,
      frequency: source.reportingSchedule.frequency,
    },
    completeness,
    baseline,
    anomaly,
  });

  assert.equal(result.calculatedFindings.completeness.percent, 70);
  assert.equal(result.calculatedFindings.historicalBaseline.status, "ready");
  assert.equal(
    result.calculatedFindings.anomaly.type,
    "unusually_low_reporting",
  );
});

test("preserves source and period metadata in ISO format", () => {
  const result = createEvidencePackage(inputs());

  assert.equal(result.metadata.sourceCode, "CLINIC-001");
  assert.equal(result.metadata.sourceName, "Configured clinic");
  assert.equal(result.metadata.frequency, "daily");
  assert.deepEqual(result.metadata.period, {
    start: periodStart,
    end: periodEnd,
    deadline: periodEnd,
    timezone: "UTC",
  });
});

test("keeps supplied observations separate from calculated findings", () => {
  const result = createEvidencePackage(inputs());

  assert.deepEqual(result.observedFacts, {
    expectedReports: 10,
    eligibleReceivedReports: 7,
    periodStatus: "incomplete",
    channelAvailability: "available",
    historicalObservationCount: 5,
  });
  assert.equal(result.calculatedFindings.completeness.percent, 70);
  assert.equal(result.observedFacts.completenessPercent, undefined);
});

test("preserves completeness percentage without recalculating it", () => {
  const result = createEvidencePackage(inputs());

  assert.equal(result.calculatedFindings.completeness.percent, 70);
});

test("preserves null completeness rather than replacing it with zero", () => {
  const input = inputs();
  input.completeness.completenessPercent = null;
  const result = createEvidencePackage(input);

  assert.equal(result.calculatedFindings.completeness.percent, null);
});

test("preserves all historical baseline statistics", () => {
  const result = createEvidencePackage(inputs());

  assert.deepEqual(result.calculatedFindings.historicalBaseline, {
    status: "ready",
    minimumObservations: 5,
    meanEligibleReports: 10,
    medianEligibleReports: 10,
    minimumEligibleReports: 8,
    maximumEligibleReports: 12,
    populationStandardDeviation: 1.2,
    expectedReportsPerPeriod: 10,
  });
});

test("preserves the upstream anomaly classification and deviation", () => {
  const result = createEvidencePackage(inputs());

  assert.equal(result.calculatedFindings.anomaly.status, "anomaly");
  assert.equal(
    result.calculatedFindings.anomaly.type,
    "unusually_low_reporting",
  );
  assert.equal(result.calculatedFindings.anomaly.absoluteDifference, 3);
  assert.equal(result.calculatedFindings.anomaly.percentageDeviation, -30);
});

test("represents insufficient history without inventing baseline values", () => {
  const input = inputs();
  input.baseline.status = "insufficient_history";
  input.baseline.validHistoricalPeriods = 2;
  input.baseline.meanEligibleReports = null;
  input.baseline.medianEligibleReports = null;
  input.baseline.minimumEligibleReports = null;
  input.baseline.maximumEligibleReports = null;
  input.baseline.populationStandardDeviation = null;
  input.baseline.expectedReportsPerPeriod = null;
  input.anomaly.status = "insufficient_history";
  input.anomaly.anomalyType = null;
  input.anomaly.explanation = "There is insufficient history for comparison.";
  input.anomaly.historicalMean = null;
  input.anomaly.historicalMedian = null;
  input.anomaly.absoluteDifference = null;
  input.anomaly.percentageDeviation = null;
  input.anomaly.historicalObservationCount = 2;

  const result = createEvidencePackage(input);

  assert.equal(result.calculatedFindings.historicalBaseline.status, "insufficient_history");
  assert.equal(result.calculatedFindings.historicalBaseline.meanEligibleReports, null);
  assert.equal(result.calculatedFindings.anomaly.status, "insufficient_history");
  assert.equal(result.calculatedFindings.anomaly.type, null);
});

test("represents an explicitly unavailable reporting channel", () => {
  const input = inputs();
  input.completeness.status = "channel_unavailable";
  input.completeness.receivedReports = 0;
  input.completeness.completenessPercent = 0;
  input.completeness.channelAvailability = "unavailable";
  input.anomaly.status = "channel_unavailable";
  input.anomaly.currentEligibleReports = 0;
  input.anomaly.evidence.observedFacts.status = "channel_unavailable";
  input.anomaly.evidence.observedFacts.eligibleReceivedReports = 0;
  input.anomaly.evidence.observedFacts.channelAvailability = "unavailable";

  const result = createEvidencePackage(input);

  assert.equal(result.observedFacts.channelAvailability, "unavailable");
  assert.equal(result.calculatedFindings.anomaly.status, "channel_unavailable");
});

test("preserves unknown channel availability rather than inferring it", () => {
  const input = inputs();
  input.completeness.channelAvailability = "unknown";
  input.anomaly.evidence.observedFacts.channelAvailability = "unknown";

  const result = createEvidencePackage(input);

  assert.equal(result.observedFacts.channelAvailability, "unknown");
});

test("excludes untrusted references and retains references marked trusted", () => {
  const input = inputs();
  input.anomaly.evidence.untrustedReportId = "raw-untrusted-report-id";
  const result = createEvidencePackage({
    ...input,
    trustedObservationReferences: [
      {
        id: "untrusted-history-id",
        periodStart,
        periodEnd,
        isTrusted: false,
      },
      {
        id: "trusted-history-id",
        periodStart,
        periodEnd,
        isTrusted: true,
      },
    ],
  });

  assert.deepEqual(result.evidence.trustedObservationReferences, [
    { id: "trusted-history-id", periodStart, periodEnd },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /untrusted-history-id/);
  assert.doesNotMatch(JSON.stringify(result), /raw-untrusted-report-id/);
});

test("omits unavailable optional source metadata without fabricating it", () => {
  const input = inputs();
  delete input.source.name;
  delete input.completeness.period.deadline;
  delete input.completeness.period.timezone;

  const result = createEvidencePackage(input);

  assert.equal("sourceName" in result.metadata, false);
  assert.deepEqual(result.metadata.period, { start: periodStart, end: periodEnd });
});

test("rejects missing required inputs", () => {
  const input = inputs();
  delete input.evaluatedAt;

  assert.throws(() => createEvidencePackage(input), /evaluatedAt/);
  assert.throws(() => createEvidencePackage({}), /source must be an object/);
});

test("rejects contradictory source and period metadata", () => {
  const sourceMismatch = inputs();
  sourceMismatch.anomaly.evidence.observedFacts.sourceCode = "OTHER-002";
  assert.throws(
    () => createEvidencePackage(sourceMismatch),
    /Anomaly sourceCode does not match source/,
  );

  const periodMismatch = inputs();
  periodMismatch.anomaly.evidence.observedFacts.periodEnd =
    "2026-02-03T00:00:00.000Z";
  assert.throws(
    () => createEvidencePackage(periodMismatch),
    /Anomaly period boundaries do not match completeness/,
  );

  const countMismatch = inputs();
  countMismatch.anomaly.evidence.observedFacts.eligibleReceivedReports = 6;
  assert.throws(
    () => createEvidencePackage(countMismatch),
    /Anomaly observed facts do not match completeness/,
  );
});

test("always includes the required interpretation boundaries", () => {
  const result = createEvidencePackage(inputs());

  assert.deepEqual(result.interpretationBoundaries, [
    "A reporting anomaly is not proof of an outbreak.",
    "Reduced reporting is not proof of improved public health.",
    "Missing reports are not proof of deliberate suppression.",
    "An unavailable reporting channel does not establish why it became unavailable.",
    "AI must not turn missing evidence into factual conclusions.",
  ]);
});

test("serializes to JSON and deterministic metadata yields identical packages", () => {
  const input = {
    ...inputs(),
    packageId: "caller-package-id",
    evaluatedAt,
  };
  const first = createEvidencePackage(input);
  const second = createEvidencePackage(input);

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
});
