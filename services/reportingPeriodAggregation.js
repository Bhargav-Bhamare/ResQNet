const calculateReportingCompleteness = require("./reportingCompleteness");
const { createSourceAttributionService } = require("./sourceAttribution");

const MAX_PERIODS = 366;
const MAX_WEEKLY_PERIODS = 104;
const CHANNEL_AVAILABILITY_VALUES = new Set([
  "available",
  "unavailable",
  "unknown",
]);
function toDate(value, fieldName) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${fieldName} must be a valid date.`);
  }
  return date;
}

function validateSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("source must be a configured reporting source.");
  }
  const schedule = source.reportingSchedule;
  if (
    typeof source.sourceCode !== "string" ||
    !source.sourceCode.trim() ||
    !schedule ||
    !["daily", "weekly"].includes(schedule.frequency) ||
    !Number.isInteger(schedule.expectedReportsPerPeriod) ||
    schedule.expectedReportsPerPeriod < 1 ||
    typeof schedule.timezone !== "string" ||
    !schedule.timezone.trim()
  ) {
    throw new TypeError("source has an invalid reporting configuration.");
  }
  const validFrom = toDate(source.validFrom, "source.validFrom");
  const validUntil =
    source.validUntil == null
      ? null
      : toDate(source.validUntil, "source.validUntil");
  if (validUntil && validUntil < validFrom) {
    throw new TypeError("source.validUntil must not precede validFrom.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone });
  } catch {
    throw new TypeError("source reporting timezone must be a valid IANA timezone.");
  }
  if (
    schedule.reportingTime !== undefined &&
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.reportingTime)
  ) {
    throw new TypeError("source.reportingSchedule.reportingTime is invalid.");
  }
  return { schedule, validFrom, validUntil };
}

function makePeriodRange(schedule, rangeStart, rangeEnd, maximumPeriods) {
  const { getLocalParts, getReportingPeriodForLocalDate } =
    calculateReportingCompleteness;
  const startParts = getLocalParts(rangeStart, schedule.timezone);
  const endParts = getLocalParts(rangeEnd, schedule.timezone);
  if (
    startParts.hour !== 0 ||
    startParts.minute !== 0 ||
    startParts.second !== 0 ||
    endParts.hour !== 0 ||
    endParts.minute !== 0 ||
    endParts.second !== 0
  ) {
    throw new TypeError(
      "rangeStart and rangeEnd must be source-local midnight boundaries.",
    );
  }

  const startPeriod = getReportingPeriodForLocalDate(schedule, startParts);
  const endPeriod = getReportingPeriodForLocalDate(schedule, endParts);
  if (
    startPeriod.start.getTime() !== rangeStart.getTime() ||
    endPeriod.start.getTime() !== rangeEnd.getTime()
  ) {
    throw new TypeError(
      schedule.frequency === "weekly"
        ? "Weekly range boundaries must fall on local Mondays at midnight."
        : "Daily range boundaries must fall at local midnight.",
    );
  }

  const periods = [];
  let localDate = {
    year: startParts.year,
    month: startParts.month,
    day: startParts.day,
  };
  while (true) {
    const period = getReportingPeriodForLocalDate(schedule, localDate);
    if (period.start >= rangeEnd) break;
    if (period.start < rangeStart) {
      localDate = calculateReportingCompleteness.addCalendarDays(
        localDate,
        schedule.frequency === "daily" ? 1 : 7,
      );
      continue;
    }
    if (period.end > rangeEnd) {
      throw new TypeError("The requested range must contain complete periods.");
    }
    periods.push(period);
    if (periods.length > maximumPeriods) {
      throw new RangeError(
        `The requested range exceeds the maximum of ${maximumPeriods} reporting periods.`,
      );
    }
    localDate = calculateReportingCompleteness.addCalendarDays(
      localDate,
      schedule.frequency === "daily" ? 1 : 7,
    );
  }
  return periods;
}

function getIdentifier(report) {
  const identifier = report?._id ?? report?.id;
  return identifier == null ? null : String(identifier);
}

function createAttributionMap(attributions) {
  if (!Array.isArray(attributions)) {
    throw new TypeError(
      "Trusted report lookup must return trustedAttributions as an array.",
    );
  }
  const result = new Map();
  for (const attribution of attributions) {
    if (attribution?.reportId == null) continue;
    const id = String(attribution.reportId);
    if (!result.has(id)) result.set(id, attribution);
  }
  return result;
}

function channelForPeriod(map, periodStart) {
  const key = periodStart.toISOString();
  const value = map[key] === undefined ? "unknown" : map[key];
  if (!CHANNEL_AVAILABILITY_VALUES.has(value)) {
    throw new TypeError(
      `channelAvailabilityByPeriod[${key}] must be available, unavailable, or unknown.`,
    );
  }
  return value;
}

function determineStatus(isComplete, receivedReports, channelAvailability) {
  if (!isComplete) return "in_progress";
  if (channelAvailability === "unavailable") {
    return receivedReports === 0
      ? "channel_unavailable"
      : "incomplete_channel_unavailable";
  }
  return receivedReports === 0 ? "reporting_gap" : "incomplete";
}

function createReportingPeriodAggregationService({
  trustedReportService = createSourceAttributionService(),
  maximumPeriods = MAX_PERIODS,
} = {}) {
  if (!Number.isInteger(maximumPeriods) || maximumPeriods < 1 || maximumPeriods > MAX_PERIODS) {
    throw new TypeError(
      `maximumPeriods must be an integer between 1 and ${MAX_PERIODS}.`,
    );
  }
  if (
    !trustedReportService ||
    typeof trustedReportService.getTrustedReports !== "function" ||
    typeof trustedReportService.getConfiguredSource !== "function"
  ) {
    throw new TypeError(
      "Trusted source and report lookup methods are required.",
    );
  }

  return {
    async aggregateReportingPeriods({
      source: suppliedSource,
      sourceCode: requestedSourceCode,
      rangeStart,
      rangeEnd,
      evaluatedAt = new Date(),
      channelAvailabilityByPeriod = {},
    } = {}) {
      const sourceCode =
        requestedSourceCode || suppliedSource?.sourceCode;
      if (typeof sourceCode !== "string" || !sourceCode.trim()) {
        throw new TypeError("A configured source or sourceCode is required.");
      }
      const source = await trustedReportService.getConfiguredSource({
        sourceCode,
        source: suppliedSource,
      });
      if (!source) {
        return {
          sourceCode,
          status: "source_not_found",
          observations: [],
          queriedTrustedReports: false,
          limitations: [
            "No configured reporting source was found; no reporting periods were generated.",
          ],
        };
      }
      if (source.sourceCode !== sourceCode) {
        throw new TypeError(
          "Configured source lookup returned a different sourceCode.",
        );
      }
      const { schedule, validFrom, validUntil } = validateSource(source);
      if (
        !channelAvailabilityByPeriod ||
        typeof channelAvailabilityByPeriod !== "object" ||
        Array.isArray(channelAvailabilityByPeriod)
      ) {
        throw new TypeError("channelAvailabilityByPeriod must be an object.");
      }
      const start = toDate(rangeStart, "rangeStart");
      const end = toDate(rangeEnd, "rangeEnd");
      const evaluationTime = toDate(evaluatedAt, "evaluatedAt");
      if (end <= start) {
        throw new TypeError("rangeEnd must follow rangeStart.");
      }

      const base = {
        sourceCode: source.sourceCode,
        frequency: schedule.frequency,
        timezone: schedule.timezone,
        range: { start, end },
        evaluatedAt: evaluationTime,
      };
      if (source.isActive === false) {
        return {
          ...base,
          status: "inactive",
          observations: [],
          queriedTrustedReports: false,
          limitations: [
            "The configured reporting source is inactive; no periods were aggregated.",
          ],
        };
      }

      const periods = makePeriodRange(
        schedule,
        start,
        end,
        Math.min(
          maximumPeriods,
          schedule.frequency === "weekly"
            ? MAX_WEEKLY_PERIODS
            : MAX_PERIODS,
        ),
      );
      const relevantPeriods = periods.filter(
        (period) => period.start <= evaluationTime,
      );
      const validPeriods = relevantPeriods.filter(
        (period) =>
          validFrom <= period.start &&
          (validUntil === null || validUntil >= period.deadline),
      );
      const excludedValidityPeriods =
        relevantPeriods.length - validPeriods.length;

      if (validPeriods.length === 0) {
        return {
          ...base,
          status: "no_applicable_periods",
          observations: [],
          queriedTrustedReports: false,
          limitations: [
            ...(excludedValidityPeriods
              ? [
                  `${excludedValidityPeriods} period(s) were outside the source validity window.`,
                ]
              : []),
            "No valid reporting period in the requested range was queried.",
          ],
        };
      }

      const queryStart = validPeriods[0].start;
      const queryEnd = validPeriods[validPeriods.length - 1].end;
      const trustedResult = await trustedReportService.getTrustedReports({
        sourceCode: source.sourceCode,
        periodStart: queryStart,
        periodEnd: queryEnd,
        asOf: evaluationTime,
      });
      if (
        !trustedResult ||
        trustedResult.queryCompleted !== true ||
        trustedResult.sourceCode !== source.sourceCode ||
        !Array.isArray(trustedResult.reports) ||
        !(trustedResult.trustedReportIds instanceof Set) ||
        !trustedResult.queryWindow ||
        toDate(trustedResult.queryWindow.start, "trusted query start") >
          queryStart ||
        toDate(trustedResult.queryWindow.end, "trusted query end") <
          queryEnd ||
        trustedResult.queryWindow.asOf == null ||
        toDate(trustedResult.queryWindow.asOf, "trusted query evaluation") <
          evaluationTime
      ) {
        throw new TypeError(
          "Trusted report lookup did not confirm a completed, validated source query.",
        );
      }

      const trustedIds = trustedResult.trustedReportIds;
      const attributionById = createAttributionMap(
        trustedResult.trustedAttributions,
      );
      const countsByPeriod = new Map(
        validPeriods.map((period) => [
          period.start.toISOString(),
          { ids: new Set(), references: [] },
        ]),
      );
      const limitations = [];
      let excludedUntrustedReports = 0;
      let excludedInvalidTimestamps = 0;
      let excludedFutureReports = 0;

      const sortedReports = [...trustedResult.reports].sort((left, right) => {
        const leftId = getIdentifier(left) || "";
        const rightId = getIdentifier(right) || "";
        if (leftId !== rightId) return leftId.localeCompare(rightId);
        const leftTime = new Date(left?.submittedAt).getTime();
        const rightTime = new Date(right?.submittedAt).getTime();
        const normalizedLeft = Number.isNaN(leftTime)
          ? Number.POSITIVE_INFINITY
          : leftTime;
        const normalizedRight = Number.isNaN(rightTime)
          ? Number.POSITIVE_INFINITY
          : rightTime;
        if (normalizedLeft !== normalizedRight) {
          return normalizedLeft - normalizedRight;
        }
        const leftAttribution = attributionById.get(leftId)?.attributedAt;
        const rightAttribution = attributionById.get(rightId)?.attributedAt;
        const normalizedLeftAttribution = new Date(
          leftAttribution,
        ).getTime();
        const normalizedRightAttribution = new Date(
          rightAttribution,
        ).getTime();
        return (
          (Number.isNaN(normalizedLeftAttribution)
            ? Number.POSITIVE_INFINITY
            : normalizedLeftAttribution) -
          (Number.isNaN(normalizedRightAttribution)
            ? Number.POSITIVE_INFINITY
            : normalizedRightAttribution)
        );
      });
      const countedReportIds = new Set();
      for (const report of sortedReports) {
        const id = getIdentifier(report);
        if (!id || !trustedIds.has(id)) {
          excludedUntrustedReports += 1;
          continue;
        }
        if (String(report.sourceId || "") !== source.sourceCode) {
          excludedUntrustedReports += 1;
          continue;
        }
        if (report.sourceChannel !== "official_api") {
          excludedUntrustedReports += 1;
          continue;
        }
        const attribution = attributionById.get(id);
        if (!attribution) {
          excludedUntrustedReports += 1;
          continue;
        }

        const submittedAtValue = report.submittedAt;
        const submittedAt =
          submittedAtValue == null ? null : new Date(submittedAtValue);
        const attributedAt =
          attribution.attributedAt == null
            ? null
            : new Date(attribution.attributedAt);
        if (
          !submittedAt ||
          Number.isNaN(submittedAt.getTime()) ||
          !attributedAt ||
          Number.isNaN(attributedAt.getTime())
        ) {
          excludedInvalidTimestamps += 1;
          continue;
        }
        if (submittedAt > evaluationTime || attributedAt > evaluationTime) {
          excludedFutureReports += 1;
          continue;
        }

        const period = validPeriods.find(
          (candidate) =>
            submittedAt >= candidate.start && submittedAt < candidate.end,
        );
        if (!period) continue;
        if (countedReportIds.has(id)) continue;
        const counts = countsByPeriod.get(period.start.toISOString());
        if (counts.ids.has(id)) continue;
        countedReportIds.add(id);
        counts.ids.add(id);
        counts.references.push({
          id,
          submittedAt,
          attributedAt,
        });
      }

      if (excludedUntrustedReports > 0) {
        limitations.push(
          `${excludedUntrustedReports} report record(s) were excluded because trusted attribution could not be confirmed.`,
        );
      }
      if (excludedInvalidTimestamps > 0) {
        limitations.push(
          `${excludedInvalidTimestamps} trusted report(s) were excluded because submission or attribution timestamps were missing or invalid.`,
        );
      }
      if (excludedFutureReports > 0) {
        limitations.push(
          `${excludedFutureReports} trusted report(s) were excluded because submission or attribution occurred after the evaluation timestamp.`,
        );
      }
      if (excludedValidityPeriods > 0) {
        limitations.push(
          `${excludedValidityPeriods} period(s) were outside the source validity window.`,
        );
      }
      limitations.push(
        "Reports without a valid server-generated submittedAt timestamp cannot be assigned to a period; no timestamp is fabricated.",
      );

      const observations = validPeriods.map((period) => {
        const periodStart = period.start.toISOString();
        const periodEnd = period.end.toISOString();
        const periodCounts = countsByPeriod.get(periodStart);
        const receivedReports = periodCounts.ids.size;
        const channelAvailability = channelForPeriod(
          channelAvailabilityByPeriod,
          period.start,
        );
        const isComplete = evaluationTime >= period.deadline;
        const status =
          isComplete &&
          receivedReports >= schedule.expectedReportsPerPeriod
            ? "complete"
            : determineStatus(
                isComplete,
                receivedReports,
                channelAvailability,
              );
        const observationLimitations = [
          ...limitations,
          "Count is based on a completed server-controlled trusted-report query; matching source identifiers alone do not establish trust.",
          "Reporting counts describe system submissions, not symptom incidence.",
        ];
        return {
          sourceCode: source.sourceCode,
          frequency: schedule.frequency,
          timezone: schedule.timezone,
          periodStart,
          periodEnd,
          period: {
            start: period.start,
            end: period.end,
            deadline: period.deadline,
            timezone: schedule.timezone,
          },
          expectedReports: schedule.expectedReportsPerPeriod,
          eligibleReceivedReports: receivedReports,
          receivedReports,
          completenessPercent: isComplete
            ? Math.min(
                100,
                (receivedReports / schedule.expectedReportsPerPeriod) * 100,
              )
            : null,
          status,
          channelAvailability,
          isTrusted: true,
          trustProvenance: "server_controlled_source_attribution_query",
          trustedReportIds: [...periodCounts.ids],
          trustedReportReferences: periodCounts.references,
          limitations: [...new Set(observationLimitations)],
        };
      });

      return {
        ...base,
        status: "aggregated",
        observations,
        queriedTrustedReports: true,
        limitations: [...new Set(limitations)],
      };
    },
  };
}

const defaultAggregationService = createReportingPeriodAggregationService();

async function aggregateReportingPeriods(options) {
  return defaultAggregationService.aggregateReportingPeriods(options);
}

module.exports = aggregateReportingPeriods;
module.exports.MAX_PERIODS = MAX_PERIODS;
module.exports.MAX_WEEKLY_PERIODS = MAX_WEEKLY_PERIODS;
module.exports.createReportingPeriodAggregationService =
  createReportingPeriodAggregationService;
