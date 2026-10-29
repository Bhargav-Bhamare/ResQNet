const test = require("node:test");
const assert = require("node:assert/strict");
const calculateReportingCompleteness = require("../services/reportingCompleteness");

function source(overrides = {}) {
  return {
    name: "Configured clinic",
    sourceCode: "CLINIC-001",
    isActive: true,
    validFrom: "2026-01-01T00:00:00.000Z",
    reportingSchedule: {
      frequency: "daily",
      expectedReportsPerPeriod: 10,
      reportingTime: "17:00",
      timezone: "Asia/Kolkata",
    },
    ...overrides,
  };
}

function report(id, sourceId, submittedAt) {
  return { _id: id, sourceId, submittedAt };
}

test("calculates completeness only after the daily local reporting deadline", () => {
  const result = calculateReportingCompleteness({
    sources: [source()],
    reports: Array.from({ length: 7 }, (_, index) =>
      report(
        `trusted-${index}`,
        "CLINIC-001",
        `2026-10-29T${String(1 + index).padStart(2, "0")}:00:00.000Z`,
      ),
    ),
    trustedReportIds: new Set(
      Array.from({ length: 7 }, (_, index) => `trusted-${index}`),
    ),
    now: "2026-10-29T12:00:00.000Z",
  })[0];

  assert.equal(result.status, "incomplete");
  assert.equal(result.expectedReports, 10);
  assert.equal(result.receivedReports, 7);
  assert.equal(result.completenessPercent, 70);
  assert.equal(result.period.deadline.toISOString(), "2026-10-29T11:30:00.000Z");
  assert.equal(result.period.start.toISOString(), "2026-10-28T18:30:00.000Z");
});

test("marks the reporting period in progress before the local deadline", () => {
  const result = calculateReportingCompleteness({
    sources: [source()],
    reports: [],
    now: "2026-10-29T11:29:59.000Z",
  })[0];

  assert.equal(result.status, "in_progress");
  assert.equal(result.completenessPercent, null);
});

test("uses the next local period boundary when reportingTime is omitted", () => {
  const result = calculateReportingCompleteness({
    sources: [
      source({
        reportingSchedule: {
          frequency: "daily",
          expectedReportsPerPeriod: 1,
          timezone: "Asia/Kolkata",
        },
      }),
    ],
    reports: [],
    now: "2026-10-29T18:29:59.000Z",
  })[0];

  assert.equal(result.status, "in_progress");
  assert.equal(result.period.deadline.toISOString(), "2026-10-29T18:30:00.000Z");
});

test("uses Sunday local reporting time for weekly deadlines across DST", () => {
  const result = calculateReportingCompleteness({
    sources: [
      source({
        reportingSchedule: {
          frequency: "weekly",
          expectedReportsPerPeriod: 5,
          reportingTime: "09:00",
          timezone: "America/New_York",
        },
      }),
    ],
    reports: [],
    now: "2026-03-08T12:59:59.000Z",
  })[0];

  assert.equal(result.status, "in_progress");
  assert.equal(result.period.deadline.toISOString(), "2026-03-08T13:00:00.000Z");
  assert.equal(result.period.start.toISOString(), "2026-03-02T05:00:00.000Z");
});

test("uses next local week boundary when weekly reportingTime is omitted", () => {
  const result = calculateReportingCompleteness({
    sources: [
      source({
        reportingSchedule: {
          frequency: "weekly",
          expectedReportsPerPeriod: 5,
          timezone: "Asia/Kolkata",
        },
      }),
    ],
    reports: [],
    now: "2026-10-29T12:00:00.000Z",
  })[0];

  assert.equal(result.status, "in_progress");
  assert.equal(result.period.deadline.toISOString(), "2026-11-01T18:30:00.000Z");
});

test("does not treat an untrusted sourceId as evidence of source attribution", () => {
  const candidate = report(
    "client-submitted-report",
    "CLINIC-001",
    "2026-10-29T09:00:00.000Z",
  );
  const result = calculateReportingCompleteness({
    sources: [source()],
    reports: [candidate],
    now: "2026-10-29T12:00:00.000Z",
  })[0];

  assert.equal(result.receivedReports, 0);
  assert.equal(result.status, "reporting_gap");
  assert.equal(result.completenessPercent, 0);
});

test("counts only trusted reports matching the configured source code", () => {
  const reports = [
    report("trusted-match", "CLINIC-001", "2026-10-29T09:00:00.000Z"),
    report("trusted-other-source", "UNCONFIGURED-999", "2026-10-29T09:00:00.000Z"),
    report("untrusted-match", "CLINIC-001", "2026-10-29T09:00:00.000Z"),
  ];
  const result = calculateReportingCompleteness({
    sources: [source()],
    reports,
    trustedReportIds: ["trusted-match", "trusted-other-source"],
    now: "2026-10-29T12:00:00.000Z",
  })[0];

  assert.equal(result.receivedReports, 1);
  assert.equal(result.completenessPercent, 10);
  assert.equal(result.status, "incomplete");
});

test("distinguishes no reports from a known unavailable reporting channel", () => {
  const results = calculateReportingCompleteness({
    sources: [
      source(),
      source({ sourceCode: "CLINIC-002" }),
    ],
    reports: [],
    now: "2026-10-29T12:00:00.000Z",
    channelAvailabilityBySourceCode: {
      "CLINIC-002": "unavailable",
    },
  });

  assert.equal(results[0].status, "reporting_gap");
  assert.equal(results[0].channelAvailability, "unknown");
  assert.equal(results[1].status, "channel_unavailable");
});

test("does not evaluate inactive sources", () => {
  const result = calculateReportingCompleteness({
    sources: [source({ isActive: false })],
    reports: [],
    now: "2026-10-29T12:00:00.000Z",
  })[0];

  assert.equal(result.status, "inactive");
  assert.equal(result.receivedReports, null);
  assert.equal(result.completenessPercent, null);
});

test("does not evaluate a period outside configured validity dates", () => {
  const result = calculateReportingCompleteness({
    sources: [
      source({
        validFrom: "2026-10-29T05:00:00.000Z",
        validUntil: "2026-10-29T10:00:00.000Z",
      }),
    ],
    reports: [],
    now: "2026-10-29T12:00:00.000Z",
  })[0];

  assert.equal(result.status, "not_applicable");
  assert.equal(result.completenessPercent, null);
});

test("reports a completed zero-report period as a reporting gap", () => {
  const result = calculateReportingCompleteness({
    sources: [source()],
    reports: [],
    now: "2026-10-29T12:00:00.000Z",
  })[0];

  assert.equal(result.status, "reporting_gap");
  assert.equal(result.receivedReports, 0);
  assert.equal(result.completenessPercent, 0);
});

test("uses submittedAt and excludes reports outside the local period", () => {
  const reports = [
    report("inside-period", "CLINIC-001", "2026-10-29T02:00:00.000Z"),
    report("previous-period", "CLINIC-001", "2026-10-28T17:00:00.000Z"),
    report("future-report", "CLINIC-001", "2026-10-29T19:00:00.000Z"),
  ];
  const result = calculateReportingCompleteness({
    sources: [source()],
    reports,
    trustedReportIds: ["inside-period", "previous-period", "future-report"],
    now: "2026-10-29T12:00:00.000Z",
  })[0];

  assert.equal(result.receivedReports, 1);
});

test("rejects duplicate configured source codes", () => {
  assert.throws(
    () =>
      calculateReportingCompleteness({
        sources: [source(), source()],
        reports: [],
        now: "2026-10-29T12:00:00.000Z",
      }),
    /Duplicate reporting source code/,
  );
});

test("caps completeness at 100 percent without capping received reports", () => {
  const reports = Array.from({ length: 12 }, (_, index) =>
    report(`excess-${index}`, "CLINIC-001", "2026-10-29T09:00:00.000Z"),
  );
  const result = calculateReportingCompleteness({
    sources: [source()],
    reports,
    trustedReportIds: reports.map((item) => item._id),
    now: "2026-10-29T12:00:00.000Z",
  })[0];

  assert.equal(result.receivedReports, 12);
  assert.equal(result.completenessPercent, 100);
});

test("rejects zero expected reports instead of relaxing source constraints", () => {
  assert.throws(
    () =>
      calculateReportingCompleteness({
        sources: [
          source({
            reportingSchedule: {
              frequency: "daily",
              expectedReportsPerPeriod: 0,
              timezone: "UTC",
            },
          }),
        ],
        reports: [],
        now: "2026-10-29T12:00:00.000Z",
      }),
    /invalid schedule/,
  );
});
