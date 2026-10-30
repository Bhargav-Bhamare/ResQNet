const test = require("node:test");
const assert = require("node:assert/strict");
const calculateReportingCompleteness = require("../services/reportingCompleteness");
const calculateHistoricalBaseline = require("../services/historicalBaseline");
const { detectReportingAnomaly } = require("../services/reportingAnomaly");
const {
  createReportingPeriodAggregationService,
} = require("../services/reportingPeriodAggregation");

function source(overrides = {}) {
  return {
    name: "Configured clinic",
    sourceCode: "CLINIC-AGG",
    isActive: true,
    validFrom: "2020-01-01T00:00:00.000Z",
    reportingSchedule: {
      frequency: "daily",
      expectedReportsPerPeriod: 10,
      reportingTime: "17:00",
      timezone: "UTC",
    },
    ...overrides,
  };
}

function periodFor(reportingSource, localDate) {
  return calculateReportingCompleteness.getReportingPeriodForLocalDate(
    reportingSource.reportingSchedule,
    localDate,
  );
}

function localDate(year, month, day) {
  return { year, month, day };
}

function createAggregator({
  reports = [],
  trustedIds = reports.map((report) => String(report._id)),
  attributions,
  queryCompleted = true,
  returnReportsUnfiltered = false,
} = {}) {
  const calls = [];
  const lookup = {
    async getConfiguredSource(options) {
      return options.source || null;
    },
    async getTrustedReports(options) {
      calls.push(options);
      if (!queryCompleted) {
        return {
          reports: [],
          trustedReportIds: new Set(),
          trustedAttributions: [],
          queryCompleted: false,
        };
      }

      const start = new Date(options.periodStart);
      const end = new Date(options.periodEnd);
      const asOf = new Date(options.asOf);
      const boundedReports = returnReportsUnfiltered
        ? reports
        : reports.filter((report) => {
        const submittedAt = new Date(report.submittedAt);
        return Number.isNaN(submittedAt.getTime()) || (
          submittedAt >= start &&
          submittedAt < end &&
          submittedAt <= asOf
        );
        });
      const boundedIds = new Set(
        [...trustedIds].filter((id) =>
          boundedReports.some((report) => String(report._id) === String(id)),
        ),
      );
      const trustedAttributions =
        attributions ||
        boundedReports
          .filter((report) => boundedIds.has(String(report._id)))
          .map((report) => ({
            reportId: String(report._id),
            attributedAt: report.attributedAt || report.submittedAt,
          }));
      return {
        reports: boundedReports,
        trustedReportIds: boundedIds,
        trustedAttributions,
        queryCompleted: true,
        sourceCode: "CLINIC-AGG",
        queryWindow: {
          start: options.periodStart,
          end: options.periodEnd,
          asOf: options.asOf,
        },
      };
    },
  };
  return {
    service: createReportingPeriodAggregationService({
      trustedReportService: lookup,
    }),
    lookup,
    calls,
  };
}

function report(id, submittedAt, overrides = {}) {
  return {
    _id: id,
    sourceId: "CLINIC-AGG",
    sourceChannel: "official_api",
    submittedAt,
    ...overrides,
  };
}

async function aggregateOnePeriod({
  reportingSource = source(),
  date = localDate(2026, 10, 30),
  evaluatedAt,
  reports = [],
  trustedIds,
  attributions,
  channelAvailabilityByPeriod,
  queryCompleted = true,
} = {}) {
  const period = periodFor(reportingSource, date);
  const rangeStart = period.start;
  const rangeEnd = period.end;
  const asOf =
    evaluatedAt ||
    new Date(period.deadline.getTime() + 1000);
  const harness = createAggregator({
    reports,
    trustedIds,
    attributions,
    queryCompleted,
  });
  const result = await harness.service.aggregateReportingPeriods({
    source: reportingSource,
    rangeStart,
    rangeEnd,
    evaluatedAt: asOf,
    channelAvailabilityByPeriod,
  });
  return { ...harness, period, result, asOf };
}

test("aggregates trusted reports into a daily reporting observation", async () => {
  const reportingSource = source();
  const period = periodFor(reportingSource, localDate(2026, 10, 30));
  const { result } = await aggregateOnePeriod({
    reportingSource,
    reports: [
      report("r1", new Date(period.start.getTime() + 3600000)),
      report("r2", new Date(period.start.getTime() + 7200000)),
    ],
  });
  const [observation] = result.observations;

  assert.equal(result.status, "aggregated");
  assert.equal(observation.frequency, "daily");
  assert.equal(observation.sourceCode, "CLINIC-AGG");
  assert.equal(observation.eligibleReceivedReports, 2);
  assert.equal(observation.expectedReports, 10);
  assert.equal(observation.status, "incomplete");
  assert.equal(observation.isTrusted, true);
  assert.equal(
    observation.trustProvenance,
    "server_controlled_source_attribution_query",
  );
});

test("aggregates weekly observations from Monday through the next Monday", async () => {
  const reportingSource = source({
    reportingSchedule: {
      frequency: "weekly",
      expectedReportsPerPeriod: 25,
      reportingTime: "09:00",
      timezone: "UTC",
    },
  });
  const { period, result } = await aggregateOnePeriod({
    reportingSource,
    date: localDate(2026, 10, 28),
  });
  const observation = result.observations[0];

  assert.equal(period.start.toISOString(), "2026-10-26T00:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-11-02T00:00:00.000Z");
  assert.equal(period.deadline.toISOString(), "2026-11-01T09:00:00.000Z");
  assert.equal(observation.expectedReports, 25);
  assert.equal(observation.frequency, "weekly");
  assert.equal(observation.periodStart, "2026-10-26T00:00:00.000Z");
});

test("uses Monday local midnight as weekly start and preserves year transitions", async () => {
  const reportingSource = source({
    reportingSchedule: {
      frequency: "weekly",
      expectedReportsPerPeriod: 4,
      timezone: "UTC",
    },
  });
  const { period } = await aggregateOnePeriod({
    reportingSource,
    date: localDate(2027, 1, 1),
  });

  assert.equal(period.start.toISOString(), "2026-12-28T00:00:00.000Z");
  assert.equal(period.end.toISOString(), "2027-01-04T00:00:00.000Z");
});

test("uses source-local midnight for a daily timezone boundary", async () => {
  const reportingSource = source({
    reportingSchedule: {
      frequency: "daily",
      expectedReportsPerPeriod: 3,
      timezone: "Asia/Kolkata",
    },
  });
  const { period } = await aggregateOnePeriod({
    reportingSource,
    date: localDate(2026, 10, 30),
  });

  assert.equal(period.start.toISOString(), "2026-10-29T18:30:00.000Z");
  assert.equal(period.end.toISOString(), "2026-10-30T18:30:00.000Z");
});

test("uses source-local Monday boundary for a weekly timezone period", async () => {
  const reportingSource = source({
    reportingSchedule: {
      frequency: "weekly",
      expectedReportsPerPeriod: 3,
      timezone: "Asia/Kolkata",
    },
  });
  const { period } = await aggregateOnePeriod({
    reportingSource,
    date: localDate(2026, 10, 30),
  });

  assert.equal(period.start.toISOString(), "2026-10-25T18:30:00.000Z");
  assert.equal(period.end.toISOString(), "2026-11-01T18:30:00.000Z");
});

test("daily periods retain 23-hour and 25-hour DST transition lengths", async () => {
  const reportingSource = source({
    reportingSchedule: {
      frequency: "daily",
      expectedReportsPerPeriod: 1,
      timezone: "America/New_York",
    },
  });
  const spring = await aggregateOnePeriod({
    reportingSource,
    date: localDate(2026, 3, 8),
  });
  const autumn = await aggregateOnePeriod({
    reportingSource,
    date: localDate(2026, 11, 1),
  });

  assert.equal(
    spring.period.end.getTime() - spring.period.start.getTime(),
    23 * 60 * 60 * 1000,
  );
  assert.equal(
    autumn.period.end.getTime() - autumn.period.start.getTime(),
    25 * 60 * 60 * 1000,
  );
});

test("weekly periods retain correct DST-adjusted local week lengths", async () => {
  const reportingSource = source({
    reportingSchedule: {
      frequency: "weekly",
      expectedReportsPerPeriod: 5,
      timezone: "America/New_York",
    },
  });
  const spring = await aggregateOnePeriod({
    reportingSource,
    date: localDate(2026, 3, 8),
  });
  const autumn = await aggregateOnePeriod({
    reportingSource,
    date: localDate(2026, 11, 1),
  });

  assert.equal(
    spring.period.end.getTime() - spring.period.start.getTime(),
    167 * 60 * 60 * 1000,
  );
  assert.equal(
    autumn.period.end.getTime() - autumn.period.start.getTime(),
    169 * 60 * 60 * 1000,
  );
});

test("uses configured daily and weekly expected report totals unchanged", async () => {
  const daily = await aggregateOnePeriod({
    reportingSource: source({
      reportingSchedule: {
        frequency: "daily",
        expectedReportsPerPeriod: 7,
        timezone: "UTC",
      },
    }),
  });
  const weekly = await aggregateOnePeriod({
    reportingSource: source({
      reportingSchedule: {
        frequency: "weekly",
        expectedReportsPerPeriod: 37,
        timezone: "UTC",
      },
    }),
  });

  assert.equal(daily.result.observations[0].expectedReports, 7);
  assert.equal(weekly.result.observations[0].expectedReports, 37);
});

test("completed zero-report periods are genuine zero-count reporting gaps", async () => {
  const { result } = await aggregateOnePeriod();
  const [observation] = result.observations;

  assert.equal(result.queriedTrustedReports, true);
  assert.equal(observation.eligibleReceivedReports, 0);
  assert.equal(observation.status, "reporting_gap");
  assert.equal(observation.completenessPercent, 0);
});

test("preserves unknown channel availability for a zero-report period", async () => {
  const { result } = await aggregateOnePeriod();
  const [observation] = result.observations;

  assert.equal(observation.channelAvailability, "unknown");
  assert.equal(observation.status, "reporting_gap");
});

test("represents explicitly unavailable channel separately from zero reporting", async () => {
  const reportingSource = source();
  const period = periodFor(reportingSource, localDate(2026, 10, 30));
  const { result } = await aggregateOnePeriod({
    reportingSource,
    channelAvailabilityByPeriod: {
      [period.start.toISOString()]: "unavailable",
    },
  });

  assert.equal(result.observations[0].status, "channel_unavailable");
  assert.equal(result.observations[0].channelAvailability, "unavailable");
  assert.equal(result.observations[0].eligibleReceivedReports, 0);
});

test("in-progress periods remain marked and excluded by historical baseline", async () => {
  const reportingSource = source();
  const period = periodFor(reportingSource, localDate(2026, 10, 30));
  const { result } = await aggregateOnePeriod({
    reportingSource,
    evaluatedAt: new Date(period.deadline.getTime() - 1),
    reports: [report("current", new Date(period.start.getTime() + 1))],
  });
  const [observation] = result.observations;
  const baseline = calculateHistoricalBaseline({
    sourceCode: reportingSource.sourceCode,
    frequency: "daily",
    observations: [observation],
    minimumObservations: 1,
    asOf: new Date(period.deadline.getTime() + 1000),
  });

  assert.equal(observation.status, "in_progress");
  assert.equal(observation.completenessPercent, null);
  assert.equal(baseline.validHistoricalPeriods, 0);
  assert.equal(baseline.excluded.inProgress, 1);
});

test("excludes reports submitted after the evaluation timestamp", async () => {
  const reportingSource = source();
  const period = periodFor(reportingSource, localDate(2026, 10, 30));
  const reportTimestamp = new Date(period.start.getTime() + 5 * 60 * 60 * 1000);
  const { service } = createAggregator({
    reports: [report("future-report", reportTimestamp)],
    attributions: [
      {
        reportId: "future-report",
        attributedAt: new Date(reportTimestamp.getTime() + 1),
      },
    ],
    returnReportsUnfiltered: true,
  });
  const result = await service.aggregateReportingPeriods({
    source: reportingSource,
    rangeStart: period.start,
    rangeEnd: period.end,
    evaluatedAt: new Date(reportTimestamp.getTime() - 1),
  });

  assert.equal(result.observations[0].eligibleReceivedReports, 0);
  assert.match(result.limitations[0], /after the evaluation timestamp/);
});

test("assigns reports by server submission timestamp to the correct local day", async () => {
  const reportingSource = source({
    reportingSchedule: {
      frequency: "daily",
      expectedReportsPerPeriod: 10,
      timezone: "Asia/Kolkata",
    },
  });
  const first = periodFor(reportingSource, localDate(2026, 10, 30));
  const second = periodFor(reportingSource, localDate(2026, 10, 31));
  const { service } = createAggregator({
    reports: [
      report("last-before-midnight", new Date(first.end.getTime() - 1)),
      report("at-midnight", second.start),
    ],
  });
  const result = await service.aggregateReportingPeriods({
    source: reportingSource,
    rangeStart: first.start,
    rangeEnd: second.end,
    evaluatedAt: second.deadline,
  });

  assert.deepEqual(
    result.observations.map((observation) => observation.trustedReportIds),
    [["last-before-midnight"], ["at-midnight"]],
  );
});

test("deduplicates repeated records by stable report ID only", async () => {
  const reportingSource = source();
  const period = periodFor(reportingSource, localDate(2026, 10, 30));
  const timestamp = new Date(period.start.getTime() + 60_000);
  const { result } = await aggregateOnePeriod({
    reportingSource,
    reports: [
      report("same-id", timestamp, { description: "first" }),
      report("same-id", timestamp, { description: "duplicate copy" }),
      report("different-id-a", timestamp, { description: "same content" }),
      report("different-id-b", timestamp, { description: "same content" }),
    ],
  });

  assert.equal(result.observations[0].eligibleReceivedReports, 3);
  assert.deepEqual(
    result.observations[0].trustedReportIds.sort(),
    ["different-id-a", "different-id-b", "same-id"],
  );
});

test("a repeated report ID cannot be counted in two periods", async () => {
  const reportingSource = source({
    reportingSchedule: {
      frequency: "daily",
      expectedReportsPerPeriod: 10,
      timezone: "UTC",
    },
  });
  const first = periodFor(reportingSource, localDate(2026, 10, 30));
  const second = periodFor(reportingSource, localDate(2026, 10, 31));
  const { service } = createAggregator({
    reports: [
      report("same-stable-id", new Date(first.start.getTime() + 1000)),
      report("same-stable-id", new Date(second.start.getTime() + 1000)),
    ],
  });
  const result = await service.aggregateReportingPeriods({
    source: reportingSource,
    rangeStart: first.start,
    rangeEnd: second.end,
    evaluatedAt: second.deadline,
  });

  assert.deepEqual(
    result.observations.map((observation) => observation.eligibleReceivedReports),
    [1, 0],
  );
});

test("excludes reports absent from the trusted ID set despite matching source fields", async () => {
  const reportingSource = source();
  const period = periodFor(reportingSource, localDate(2026, 10, 30));
  const { result } = await aggregateOnePeriod({
    reportingSource,
    reports: [
      report(
        "untrusted",
        new Date(period.start.getTime() + 60_000),
      ),
    ],
    trustedIds: [],
  });

  assert.equal(result.observations[0].eligibleReceivedReports, 0);
  assert.equal(result.observations[0].isTrusted, true);
  assert.match(result.limitations[0], /excluded because trusted attribution/);
});

test("excludes a report with no successful attribution reference", async () => {
  const reportingSource = source();
  const period = periodFor(reportingSource, localDate(2026, 10, 30));
  const { service } = createAggregator({
    reports: [report("missing-audit", new Date(period.start.getTime() + 1000))],
    trustedIds: ["missing-audit"],
    attributions: [],
  });
  const result = await service.aggregateReportingPeriods({
    source: reportingSource,
    rangeStart: period.start,
    rangeEnd: period.end,
    evaluatedAt: period.deadline,
  });

  assert.equal(result.observations[0].eligibleReceivedReports, 0);
  assert.match(result.limitations[0], /excluded because trusted attribution/);
});

test("excludes invalid report timestamps with a visible limitation", async () => {
  const reportingSource = source();
  const period = periodFor(reportingSource, localDate(2026, 10, 30));
  const { service } = createAggregator({
    reports: [report("invalid-time", "not-a-date")],
    attributions: [
      { reportId: "invalid-time", attributedAt: period.start },
    ],
    returnReportsUnfiltered: true,
  });
  const result = await service.aggregateReportingPeriods({
    source: reportingSource,
    rangeStart: period.start,
    rangeEnd: period.end,
    evaluatedAt: period.end,
  });

  assert.equal(result.observations[0].eligibleReceivedReports, 0);
  assert.match(result.limitations[0], /missing or invalid/);
});

test("respects source validFrom by omitting periods before the source began", async () => {
  const reportingSource = source({
    validFrom: "2026-10-30T00:00:00.000Z",
    reportingSchedule: {
      frequency: "daily",
      expectedReportsPerPeriod: 2,
      timezone: "UTC",
    },
  });
  const start = periodFor(reportingSource, localDate(2026, 10, 29));
  const end = periodFor(reportingSource, localDate(2026, 10, 31));
  const { service } = createAggregator();
  const result = await service.aggregateReportingPeriods({
    source: reportingSource,
    rangeStart: start.start,
    rangeEnd: end.start,
    evaluatedAt: end.deadline,
  });

  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].periodStart, "2026-10-30T00:00:00.000Z");
  assert.match(result.limitations[0], /outside the source validity window/);
});

test("respects source validUntil and excludes later periods", async () => {
  const reportingSource = source({
    validUntil: "2026-10-30T23:59:59.999Z",
    reportingSchedule: {
      frequency: "daily",
      expectedReportsPerPeriod: 2,
      timezone: "UTC",
    },
  });
  const start = periodFor(reportingSource, localDate(2026, 10, 29));
  const end = periodFor(reportingSource, localDate(2026, 10, 31));
  const { service } = createAggregator();
  const result = await service.aggregateReportingPeriods({
    source: reportingSource,
    rangeStart: start.start,
    rangeEnd: end.end,
    evaluatedAt: end.deadline,
  });

  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].periodStart, "2026-10-29T00:00:00.000Z");
});

test("inactive source returns no observations and does not query", async () => {
  const harness = createAggregator();
  const reportingSource = source({ isActive: false });
  const period = periodFor(reportingSource, localDate(2026, 10, 30));
  const result = await harness.service.aggregateReportingPeriods({
    source: reportingSource,
    rangeStart: period.start,
    rangeEnd: period.end,
    evaluatedAt: period.end,
  });

  assert.equal(result.status, "inactive");
  assert.deepEqual(result.observations, []);
  assert.equal(result.queriedTrustedReports, false);
  assert.equal(harness.calls.length, 0);
});

test("rejects ranges exceeding the configured bounded period maximum", async () => {
  const reportingSource = source();
  const start = periodFor(reportingSource, localDate(2026, 10, 1));
  const end = periodFor(reportingSource, localDate(2026, 10, 5));
  const harness = createAggregator();
  const service = createReportingPeriodAggregationService({
    trustedReportService: harness.lookup,
    maximumPeriods: 3,
  });

  await assert.rejects(
    service.aggregateReportingPeriods({
      source: reportingSource,
      rangeStart: start.start,
      rangeEnd: end.end,
      evaluatedAt: end.deadline,
    }),
    /exceeds the maximum of 3/,
  );
});

test("caps weekly history at two years even when the daily maximum is higher", async () => {
  const reportingSource = source({
    reportingSchedule: {
      frequency: "weekly",
      expectedReportsPerPeriod: 2,
      timezone: "UTC",
    },
  });
  const rangeStart = new Date("2024-01-01T00:00:00.000Z");
  const rangeEnd = new Date(
    rangeStart.getTime() + 105 * 7 * 24 * 60 * 60 * 1000,
  );
  const harness = createAggregator();

  await assert.rejects(
    harness.service.aggregateReportingPeriods({
      source: reportingSource,
      rangeStart,
      rangeEnd,
      evaluatedAt: rangeEnd,
    }),
    /exceeds the maximum of 104/,
  );
});

test("rejects missing source configuration safely", async () => {
  const harness = createAggregator();
  await assert.rejects(
    harness.service.aggregateReportingPeriods({
      rangeStart: "2026-10-30T00:00:00.000Z",
      rangeEnd: "2026-10-31T00:00:00.000Z",
    }),
    /configured source or sourceCode is required/,
  );
});

test("does not generate observations for a source absent from configuration", async () => {
  const harness = createAggregator();
  const result = await harness.service.aggregateReportingPeriods({
    sourceCode: "UNCONFIGURED",
    rangeStart: "2026-10-30T00:00:00.000Z",
    rangeEnd: "2026-10-31T00:00:00.000Z",
    evaluatedAt: "2026-10-31T00:00:00.000Z",
  });

  assert.equal(result.status, "source_not_found");
  assert.deepEqual(result.observations, []);
  assert.equal(harness.calls.length, 0);
});

test("rejects ranges that do not align with complete source-local periods", async () => {
  const reportingSource = source({
    reportingSchedule: {
      frequency: "daily",
      expectedReportsPerPeriod: 1,
      timezone: "Asia/Kolkata",
    },
  });
  const harness = createAggregator();

  await assert.rejects(
    harness.service.aggregateReportingPeriods({
      source: reportingSource,
      rangeStart: "2026-10-30T00:00:00.000Z",
      rangeEnd: "2026-10-31T00:00:00.000Z",
      evaluatedAt: "2026-10-31T00:00:00.000Z",
    }),
    /source-local midnight boundaries/,
  );
});

test("requires a completed trusted query before assigning a zero count", async () => {
  const reportingSource = source();
  const period = periodFor(reportingSource, localDate(2026, 10, 30));
  const harness = createAggregator({ queryCompleted: false });

  await assert.rejects(
    harness.service.aggregateReportingPeriods({
      source: reportingSource,
      rangeStart: period.start,
      rangeEnd: period.end,
      evaluatedAt: period.end,
    }),
    /completed, validated source query/,
  );
});

test("observations are accepted by the historical baseline and anomaly engines", async () => {
  const reportingSource = source({
    reportingSchedule: {
      frequency: "daily",
      expectedReportsPerPeriod: 10,
      reportingTime: "17:00",
      timezone: "UTC",
    },
  });
  const first = periodFor(reportingSource, localDate(2026, 10, 20));
  const end = periodFor(reportingSource, localDate(2026, 10, 25));
  const reports = [];
  for (let day = 0; day < 5; day += 1) {
    const period = periodFor(
      reportingSource,
      localDate(2026, 10, 20 + day),
    );
    for (let index = 0; index < 10; index += 1) {
      reports.push(
        report(
          `day-${day}-report-${index}`,
          new Date(period.start.getTime() + (index + 1) * 60_000),
        ),
      );
    }
  }
  const harness = createAggregator({ reports });
  const aggregated = await harness.service.aggregateReportingPeriods({
    source: reportingSource,
    rangeStart: first.start,
    rangeEnd: end.start,
    evaluatedAt: end.start,
  });
  const baseline = calculateHistoricalBaseline({
    sourceCode: reportingSource.sourceCode,
    frequency: "daily",
    observations: aggregated.observations,
    minimumObservations: 5,
    asOf: end.start,
  });

  assert.equal(baseline.status, "ready");
  assert.equal(baseline.meanEligibleReports, 10);
  const current = aggregated.observations.at(-1);
  const anomaly = detectReportingAnomaly({
    currentObservation: current,
    baseline,
  });
  assert.equal(anomaly.status, "normal_variation");

  const completeness = calculateReportingCompleteness({
    sources: [reportingSource],
    reports,
    trustedReportIds: new Set(reports.map((item) => item._id)),
    now: new Date(end.start.getTime() - 6 * 60 * 60 * 1000),
  })[0];
  assert.equal(completeness.receivedReports, 10);
});

test("identical inputs produce deterministic aggregation output", async () => {
  const reportingSource = source();
  const period = periodFor(reportingSource, localDate(2026, 10, 30));
  const options = {
    source: reportingSource,
    rangeStart: period.start,
    rangeEnd: period.end,
    evaluatedAt: period.end,
  };
  const first = await createAggregator().service.aggregateReportingPeriods(
    options,
  );
  const second = await createAggregator().service.aggregateReportingPeriods(
    options,
  );

  assert.deepEqual(first, second);
});

test("does not perform database writes while aggregating isolated inputs", async () => {
  const reportingSource = source();
  const period = periodFor(reportingSource, localDate(2026, 10, 30));
  let writeCalls = 0;
  const lookup = {
    async getConfiguredSource(options) {
      return options.source || null;
    },
    async getTrustedReports() {
      return {
        reports: [],
        trustedReportIds: new Set(),
        trustedAttributions: [],
        queryCompleted: true,
        sourceCode: "CLINIC-AGG",
        queryWindow: {
          start: period.start,
          end: period.end,
          asOf: period.end,
        },
      };
    },
    async create() {
      writeCalls += 1;
    },
    async save() {
      writeCalls += 1;
    },
  };
  const service = createReportingPeriodAggregationService({
    trustedReportService: lookup,
  });

  await service.aggregateReportingPeriods({
    source: reportingSource,
    rangeStart: period.start,
    rangeEnd: period.end,
    evaluatedAt: period.end,
  });
  assert.equal(writeCalls, 0);
});
