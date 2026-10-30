const test = require("node:test");
const assert = require("node:assert/strict");
const calculateReportingCompleteness = require("../services/reportingCompleteness");
const calculateHistoricalBaseline = require("../services/historicalBaseline");
const { detectReportingAnomaly } = require("../services/reportingAnomaly");
const createEvidencePackage = require("../services/evidencePackage");
const { createReportingPeriodAggregationService } = require("../services/reportingPeriodAggregation");
const {
  EvidencePipelineError,
  createEvidencePipeline,
} = require("../services/evidencePipeline");

const sourceFixture = {
  _id: "configured-source-document",
  sourceCode: "PIPELINE-CLINIC",
  name: "Configured clinic",
  sourceType: "health_facility",
  isActive: true,
  validFrom: new Date("2026-01-01T00:00:00.000Z"),
  reportingSchedule: {
    frequency: "daily",
    expectedReportsPerPeriod: 10,
    reportingTime: "17:00",
    timezone: "UTC",
  },
};
const evaluationTime = new Date("2026-10-30T18:00:00.000Z");
const historyStart = new Date("2026-10-25T00:00:00.000Z");

function localPeriod(date) {
  return calculateReportingCompleteness.getReportingPeriodForLocalDate(
    sourceFixture.reportingSchedule,
    date,
  );
}

function trustedReport(id, submittedAt, overrides = {}) {
  return {
    _id: id,
    sourceId: sourceFixture.sourceCode,
    sourceChannel: "official_api",
    submittedAt: new Date(submittedAt),
    ...overrides,
  };
}

function fixtureReports({
  dailyCount = 10,
  includeCurrent = false,
  currentCount = dailyCount,
} = {}) {
  const reports = [];
  for (let day = 25; day <= 29; day += 1) {
    const period = localPeriod({ year: 2026, month: 10, day });
    for (let index = 0; index < dailyCount; index += 1) {
      reports.push(
        trustedReport(
          `trusted-${day}-${index}`,
          period.start.getTime() + (index + 1) * 60_000,
        ),
      );
    }
  }
  if (includeCurrent) {
    const currentPeriod = localPeriod({ year: 2026, month: 10, day: 30 });
    for (let index = 0; index < currentCount; index += 1) {
      reports.push(
        trustedReport(
          `trusted-current-${index}`,
          currentPeriod.start.getTime() + (index + 1) * 60_000,
        ),
      );
    }
  }
  return reports;
}

function createTrustedService({
  source = sourceFixture,
  reports = fixtureReports(),
  queryError,
  coverageOverride,
} = {}) {
  const calls = [];
  return {
    calls,
    service: {
      async getConfiguredSource({ sourceCode }) {
        return source?.sourceCode === sourceCode ? source : null;
      },
      async getTrustedReports(options) {
        calls.push(options);
        if (queryError) throw queryError;
        const start = new Date(options.periodStart);
        const end = new Date(options.periodEnd);
        const asOf = new Date(options.asOf);
        const selected = reports.filter((report) => {
          const submittedAt = new Date(report.submittedAt);
          return (
            submittedAt >= start &&
            submittedAt < end &&
            submittedAt <= asOf
          );
        });
        const trustedReportIds = new Set(
          selected.map((report) => String(report._id)),
        );
        return {
          reports: selected,
          trustedReportIds,
          trustedAttributions: selected.map((report) => ({
            reportId: String(report._id),
            attributedAt: new Date(
              new Date(report.submittedAt).getTime() + 1000,
            ),
            credentialId: "credential-reference",
          })),
          queryCompleted: true,
          sourceCode: source.sourceCode,
          queryWindow:
            coverageOverride ||
            {
              start,
              end,
              asOf,
            },
        };
      },
    },
  };
}

function createPipeline(options = {}) {
  const trusted = options.trusted || createTrustedService(options);
  const reportingPeriodAggregator =
    options.reportingPeriodAggregator ||
    createReportingPeriodAggregationService({
      trustedReportService: trusted.service,
    });
  const pipeline = createEvidencePipeline({
    sourceAttributionService: trusted.service,
    reportingPeriodAggregator,
    calculateCompleteness: options.calculateCompleteness,
    calculateBaseline: options.calculateBaseline,
    detectAnomaly: options.detectAnomaly,
    buildEvidencePackage: options.buildEvidencePackage,
    minimumHistoricalObservations:
      options.minimumHistoricalObservations || 5,
    anomalyThresholds: options.anomalyThresholds,
  });
  return { pipeline, trusted };
}

function runPipeline(options = {}) {
  const { pipeline, trusted } = createPipeline(options);
  return {
    trusted,
    promise: pipeline.generateEvidenceForSource({
      sourceCode: sourceFixture.sourceCode,
      historyStart,
      evaluatedAt: evaluationTime,
      packageId: options.packageId,
      ...(options.pipelineOptions || {}),
    }),
  };
}

test("runs the complete pipeline using the real calculation and package services", async () => {
  const { promise } = runPipeline({ reports: fixtureReports({ dailyCount: 10 }) });
  const result = await promise;

  assert.equal(result.completeness.status, "reporting_gap");
  assert.equal(result.completeness.receivedReports, 0);
  assert.equal(result.baseline.status, "ready");
  assert.equal(result.baseline.meanEligibleReports, 10);
  assert.equal(result.anomaly.anomalyType, "zero_report_period");
  assert.equal(
    result.evidencePackage.calculatedFindings.anomaly.type,
    "zero_report_period",
  );
  assert.doesNotThrow(() => JSON.stringify(result.evidencePackage));
});

test("resolves source identity through configured server-side source lookup", async () => {
  const { promise, trusted } = runPipeline();
  await promise;

  assert.equal(trusted.calls.length, 1);
  assert.equal(trusted.calls[0].sourceCode, sourceFixture.sourceCode);
});

test("rejects unknown and inactive sources with stable pipeline errors", async () => {
  const unknown = createPipeline({
    source: null,
  });
  await assert.rejects(
    unknown.pipeline.generateEvidenceForSource({
      sourceCode: "MISSING-SOURCE",
      historyStart,
      evaluatedAt: evaluationTime,
    }),
    (error) =>
      error instanceof EvidencePipelineError &&
      error.code === "SOURCE_NOT_FOUND",
  );

  const inactiveSource = { ...sourceFixture, isActive: false };
  const inactive = createPipeline({ source: inactiveSource });
  await assert.rejects(
    inactive.pipeline.generateEvidenceForSource({
      sourceCode: sourceFixture.sourceCode,
      historyStart,
      evaluatedAt: evaluationTime,
    }),
    { code: "SOURCE_INACTIVE" },
  );
});

test("rejects an invalid evaluation timestamp", async () => {
  const { pipeline } = createPipeline();

  await assert.rejects(
    pipeline.generateEvidenceForSource({
      sourceCode: sourceFixture.sourceCode,
      historyStart,
      evaluatedAt: "not-a-time",
    }),
    { code: "INVALID_EVALUATION_TIME" },
  );
});

test("rejects an invalid history range", async () => {
  const { pipeline } = createPipeline();

  await assert.rejects(
    pipeline.generateEvidenceForSource({
      sourceCode: sourceFixture.sourceCode,
      historyStart: "invalid-range",
      evaluatedAt: evaluationTime,
    }),
    { code: "INVALID_PERIOD_RANGE" },
  );
});

test("calls the trusted lookup with source, period bounds, and evaluation time", async () => {
  const { promise, trusted } = runPipeline();
  await promise;
  const current = localPeriod({ year: 2026, month: 10, day: 30 });

  assert.deepEqual(trusted.calls[0], {
    sourceCode: sourceFixture.sourceCode,
    periodStart: historyStart,
    periodEnd: current.end,
    asOf: evaluationTime,
  });
});

test("trusted lookup failures stop the pipeline and preserve their cause", async () => {
  const lookupFailure = new Error("database unavailable");
  const { promise } = runPipeline({ queryError: lookupFailure });

  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "TRUSTED_LOOKUP_FAILED");
    assert.equal(error.cause, lookupFailure);
    return true;
  });
});

test("incomplete trusted query coverage stops before any calculations", async () => {
  const calculateSpy = () => {
    throw new Error("should not calculate");
  };
  const { pipeline } = createPipeline({
    coverageOverride: {
      start: new Date("2026-10-26T00:00:00.000Z"),
      end: new Date("2026-10-31T00:00:00.000Z"),
      asOf: evaluationTime,
    },
    calculateCompleteness: calculateSpy,
  });

  await assert.rejects(
    pipeline.generateEvidenceForSource({
      sourceCode: sourceFixture.sourceCode,
      historyStart,
      evaluatedAt: evaluationTime,
    }),
    { code: "INCOMPLETE_QUERY_COVERAGE" },
  );
});

test("current period is identified separately and excluded from its own baseline", async () => {
  let baselineInput;
  const { pipeline } = createPipeline({
    calculateBaseline(input) {
      baselineInput = input;
      return calculateHistoricalBaseline(input);
    },
  });
  const result = await pipeline.generateEvidenceForSource({
    sourceCode: sourceFixture.sourceCode,
    historyStart,
    evaluatedAt: evaluationTime,
  });
  const currentStart = localPeriod({ year: 2026, month: 10, day: 30 })
    .start.toISOString();

  assert.equal(result.completeness.period.start.toISOString(), currentStart);
  assert.equal(
    baselineInput.observations.some(
      (observation) => observation.periodStart === currentStart,
    ),
    false,
  );
});

test("in-progress periods do not enter the historical baseline", async () => {
  const inProgressEvaluation = new Date("2026-10-30T12:00:00.000Z");
  let baselineInput;
  const { pipeline } = createPipeline({
    reports: fixtureReports({ includeCurrent: true, currentCount: 2 }),
    calculateBaseline(input) {
      baselineInput = input;
      return calculateHistoricalBaseline(input);
    },
  });
  const result = await pipeline.generateEvidenceForSource({
    sourceCode: sourceFixture.sourceCode,
    historyStart,
    evaluatedAt: inProgressEvaluation,
  });

  assert.equal(result.completeness.status, "in_progress");
  assert.equal(result.completeness.completenessPercent, null);
  assert.equal(result.anomaly.status, "in_progress");
  assert.equal(
    baselineInput.observations.some(
      (observation) => observation.status === "in_progress",
    ),
    false,
  );
});

test("unavailable historical periods are excluded by the baseline engine", async () => {
  const unavailablePeriod = localPeriod({ year: 2026, month: 10, day: 25 });
  const { pipeline } = createPipeline({
    pipelineOptions: {
      channelAvailabilityByPeriod: {
        [unavailablePeriod.start.toISOString()]: "unavailable",
      },
    },
  });
  const result = await pipeline.generateEvidenceForSource({
    sourceCode: sourceFixture.sourceCode,
    historyStart,
    evaluatedAt: evaluationTime,
    channelAvailabilityByPeriod: {
      [unavailablePeriod.start.toISOString()]: "unavailable",
    },
  });

  assert.equal(result.baseline.validHistoricalPeriods, 4);
  assert.equal(result.baseline.excluded.channelUnavailable, 1);
});

test("unknown channel availability is preserved and not inferred as available", async () => {
  const { promise } = runPipeline();
  const result = await promise;

  assert.equal(result.completeness.channelAvailability, "unknown");
  assert.equal(result.anomaly.evidence.observedFacts.channelAvailability, "unknown");
  assert.equal(result.evidencePackage.observedFacts.channelAvailability, "unknown");
});

test("completed zero-report historical periods remain baseline observations", async () => {
  const reports = fixtureReports({ dailyCount: 10 }).filter((report) => {
    const day = new Date(report.submittedAt).getUTCDate();
    return day !== 27;
  });
  const { promise } = runPipeline({ reports });
  const result = await promise;
  const zeroPeriod = result.historicalObservations.find((observation) =>
    observation.periodStart.startsWith("2026-10-27"),
  );

  assert.equal(zeroPeriod.eligibleReceivedReports, 0);
  assert.equal(zeroPeriod.status, "reporting_gap");
  assert.equal(result.baseline.validHistoricalPeriods, 5);
});

test("insufficient history still produces a qualified evidence package", async () => {
  const { promise } = runPipeline({
    reports: [],
    pipelineOptions: { historyStart: new Date("2026-10-29T00:00:00.000Z") },
  });
  const result = await promise;

  assert.equal(result.baseline.status, "insufficient_history");
  assert.equal(result.baseline.validHistoricalPeriods, 1);
  assert.equal(
    result.evidencePackage.calculatedFindings.historicalBaseline.status,
    "insufficient_history",
  );
});

test("completeness remains null before the configured reporting deadline", async () => {
  const { promise } = runPipeline({
    pipelineOptions: { evaluatedAt: new Date("2026-10-30T12:00:00.000Z") },
  });
  const result = await promise;

  assert.equal(result.completeness.completenessPercent, null);
  assert.equal(result.evidencePackage.calculatedFindings.completeness.percent, null);
});

test("passes the exact calculated baseline and current observation to anomaly detection", async () => {
  let baselineResult;
  let anomalyInput;
  const { pipeline } = createPipeline({
    calculateBaseline(input) {
      baselineResult = calculateHistoricalBaseline(input);
      return baselineResult;
    },
    detectAnomaly(input) {
      anomalyInput = input;
      return detectReportingAnomaly(input);
    },
  });
  const result = await pipeline.generateEvidenceForSource({
    sourceCode: sourceFixture.sourceCode,
    historyStart,
    evaluatedAt: evaluationTime,
  });

  assert.equal(anomalyInput.baseline, baselineResult);
  assert.equal(anomalyInput.currentObservation.sourceCode, sourceFixture.sourceCode);
  assert.equal(
    anomalyInput.currentObservation.periodStart.toISOString(),
    result.completeness.period.start.toISOString(),
  );
  assert.equal(anomalyInput.currentObservation.eligibleReceivedReports, 0);
});

test("normal reporting variation is carried through the package", async () => {
  const { promise } = runPipeline({
    reports: fixtureReports({ includeCurrent: true, currentCount: 10 }),
  });
  const result = await promise;

  assert.equal(result.anomaly.status, "normal_variation");
  assert.equal(result.evidencePackage.summary.anomalyStatus, "normal_variation");
});

test("reporting anomaly is carried through without causal claims", async () => {
  const { promise } = runPipeline({
    reports: fixtureReports({ includeCurrent: true, currentCount: 0 }),
  });
  const result = await promise;

  assert.equal(result.anomaly.anomalyType, "zero_report_period");
  assert.match(result.anomaly.explanation, /reason has not been established/i);
  assert.ok(result.evidencePackage.interpretationBoundaries.length > 0);
});

test("evidence package includes source, period, history, completeness, baseline, and anomaly", async () => {
  const { promise } = runPipeline({ packageId: "package-fixed-id" });
  const result = await promise;
  const evidence = result.evidencePackage;

  assert.equal(evidence.packageId, "package-fixed-id");
  assert.equal(evidence.metadata.sourceCode, sourceFixture.sourceCode);
  assert.equal(evidence.metadata.timezone, "UTC");
  assert.equal(evidence.metadata.expectedReportsPerPeriod, 10);
  assert.equal(evidence.evidence.historicalObservations.length, 5);
  assert.equal(evidence.calculatedFindings.completeness.status, "reporting_gap");
  assert.equal(evidence.calculatedFindings.historicalBaseline.status, "ready");
  assert.equal(evidence.calculatedFindings.anomaly.type, "zero_report_period");
});

test("aggregation limitations survive into evidence package limitations", async () => {
  const limitation = "A trusted report timestamp was invalid and excluded.";
  const reportingPeriodAggregator = {
    async aggregateReportingPeriods() {
      const period = localPeriod({ year: 2026, month: 10, day: 30 });
      return {
        sourceCode: sourceFixture.sourceCode,
        status: "aggregated",
        queriedTrustedReports: true,
        observations: [
          {
            sourceCode: sourceFixture.sourceCode,
            frequency: "daily",
            periodStart: period.start.toISOString(),
            periodEnd: period.end.toISOString(),
            expectedReports: 10,
            eligibleReceivedReports: 0,
            status: "reporting_gap",
            channelAvailability: "unknown",
            isTrusted: true,
            trustedReportIds: [],
            trustedReportReferences: [],
            limitations: [limitation],
          },
        ],
        limitations: [limitation],
      };
    },
  };
  const { pipeline } = createPipeline({ reportingPeriodAggregator });
  const result = await pipeline.generateEvidenceForSource({
    sourceCode: sourceFixture.sourceCode,
    historyStart,
    evaluatedAt: evaluationTime,
  });

  assert.ok(
    result.evidencePackage.limitationsAndUnknowns.limitations.includes(
      limitation,
    ),
  );
});

test("untrusted IDs from aggregation are not exposed as package references", async () => {
  const reports = fixtureReports();
  const trusted = createTrustedService({ reports });
  const originalGetTrustedReports =
    trusted.service.getTrustedReports.bind(trusted.service);
  trusted.service.getTrustedReports = async (options) => {
    const result = await originalGetTrustedReports(options);
    result.reports.push(
      trustedReport(
        "untrusted-sensitive-report",
        new Date("2026-10-29T12:00:00.000Z"),
      ),
    );
    return result;
  };
  const reportingPeriodAggregator = createReportingPeriodAggregationService({
    trustedReportService: trusted.service,
  });
  const pipeline = createEvidencePipeline({
    sourceAttributionService: trusted.service,
    reportingPeriodAggregator,
  });
  const result = await pipeline.generateEvidenceForSource({
    sourceCode: sourceFixture.sourceCode,
    historyStart,
    evaluatedAt: evaluationTime,
  });

  assert.doesNotMatch(
    JSON.stringify(result.evidencePackage),
    /untrusted-sensitive-report/,
  );
});

test("future reports are excluded by trusted lookup and aggregation", async () => {
  const reports = [
    ...fixtureReports(),
    trustedReport("future-report", "2026-10-30T19:00:00.000Z"),
  ];
  const { promise } = runPipeline({ reports });
  const result = await promise;

  assert.equal(
    JSON.stringify(result.evidencePackage).includes("future-report"),
    false,
  );
  assert.equal(
    result.aggregation.observations.at(-1).eligibleReceivedReports,
    0,
  );
});

test("pipeline and calculation stages perform no database writes", async () => {
  let writes = 0;
  const trusted = createTrustedService();
  const originalGetTrustedReports =
    trusted.service.getTrustedReports.bind(trusted.service);
  trusted.service.getTrustedReports = async (...args) => {
    const result = await originalGetTrustedReports(...args);
    return result;
  };
  const reportingPeriodAggregator = createReportingPeriodAggregationService({
    trustedReportService: trusted.service,
  });
  const pipeline = createEvidencePipeline({
    sourceAttributionService: trusted.service,
    reportingPeriodAggregator,
    buildEvidencePackage(input) {
      return createEvidencePackage(input);
    },
  });
  const originalCreate = trusted.service.create;
  trusted.service.create = async () => {
    writes += 1;
    return originalCreate?.();
  };

  await pipeline.generateEvidenceForSource({
    sourceCode: sourceFixture.sourceCode,
    historyStart,
    evaluatedAt: evaluationTime,
  });
  assert.equal(writes, 0);
});

test("identical inputs with caller-supplied package ID are deterministic", async () => {
  const options = {
    reports: fixtureReports({ includeCurrent: true, currentCount: 10 }),
    pipelineOptions: { packageId: "stable-package" },
  };
  const first = await runPipeline(options).promise;
  const second = await runPipeline(options).promise;

  assert.deepEqual(first.evidencePackage, second.evidencePackage);
});

test("preserves source-resolution errors as causes", async () => {
  const failure = new Error("source database unavailable");
  const trusted = createTrustedService();
  trusted.service.getConfiguredSource = async () => {
    throw failure;
  };
  const pipeline = createPipeline({ trusted }).pipeline;

  await assert.rejects(
    pipeline.generateEvidenceForSource({
      sourceCode: sourceFixture.sourceCode,
      historyStart,
      evaluatedAt: evaluationTime,
    }),
    (error) => error.code === "SOURCE_RESOLUTION_FAILED" && error.cause === failure,
  );
});

test("wraps completeness calculation failures with stage-specific error", async () => {
  const failure = new Error("completeness failure");
  const { pipeline } = createPipeline({
    calculateCompleteness() {
      throw failure;
    },
  });

  await assert.rejects(
    pipeline.generateEvidenceForSource({
      sourceCode: sourceFixture.sourceCode,
      historyStart,
      evaluatedAt: evaluationTime,
    }),
    (error) => error.code === "COMPLETENESS_FAILED" && error.cause === failure,
  );
});

test("wraps baseline calculation failures with stage-specific error", async () => {
  const failure = new Error("baseline failure");
  const { pipeline } = createPipeline({
    calculateBaseline() {
      throw failure;
    },
  });

  await assert.rejects(
    pipeline.generateEvidenceForSource({
      sourceCode: sourceFixture.sourceCode,
      historyStart,
      evaluatedAt: evaluationTime,
    }),
    (error) => error.code === "BASELINE_FAILED" && error.cause === failure,
  );
});

test("wraps anomaly detection failures with stage-specific error", async () => {
  const failure = new Error("anomaly failure");
  const { pipeline } = createPipeline({
    detectAnomaly() {
      throw failure;
    },
  });

  await assert.rejects(
    pipeline.generateEvidenceForSource({
      sourceCode: sourceFixture.sourceCode,
      historyStart,
      evaluatedAt: evaluationTime,
    }),
    (error) =>
      error.code === "ANOMALY_DETECTION_FAILED" && error.cause === failure,
  );
});

test("wraps evidence package failures with stage-specific error", async () => {
  const failure = new Error("package failure");
  const { pipeline } = createPipeline({
    buildEvidencePackage() {
      throw failure;
    },
  });

  await assert.rejects(
    pipeline.generateEvidenceForSource({
      sourceCode: sourceFixture.sourceCode,
      historyStart,
      evaluatedAt: evaluationTime,
    }),
    (error) =>
      error.code === "EVIDENCE_PACKAGE_FAILED" && error.cause === failure,
  );
});
