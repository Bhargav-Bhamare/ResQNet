const calculateReportingCompleteness = require("./reportingCompleteness");
const calculateHistoricalBaseline = require("./historicalBaseline");
const { detectReportingAnomaly } = require("./reportingAnomaly");
const createEvidencePackage = require("./evidencePackage");
const { createSourceAttributionService } = require("./sourceAttribution");
const {
  createReportingPeriodAggregationService,
} = require("./reportingPeriodAggregation");

const DEFAULT_MINIMUM_HISTORICAL_OBSERVATIONS = 5;
const COMPLETED_PERIOD_STATUSES = new Set([
  "complete",
  "incomplete",
  "reporting_gap",
  "channel_unavailable",
  "incomplete_channel_unavailable",
]);

class EvidencePipelineError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "EvidencePipelineError";
    this.code = code;
  }
}

function toDate(value, fieldName) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new EvidencePipelineError(
      fieldName === "evaluatedAt"
        ? "INVALID_EVALUATION_TIME"
        : "INVALID_PERIOD_RANGE",
      `${fieldName} must be a valid timestamp.`,
    );
  }
  return date;
}

function getLocalDateParts(date, timezone) {
  const parts = calculateReportingCompleteness.getLocalParts(date, timezone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function getTrustedReportsFromObservations(observations) {
  const reportsById = new Map();
  for (const observation of observations) {
    if (observation.isTrusted !== true) continue;
    for (const reference of observation.trustedReportReferences || []) {
      if (!reference?.id) continue;
      const submittedAt = toDate(
        reference.submittedAt,
        "trusted report submittedAt",
      );
      reportsById.set(reference.id, {
        _id: reference.id,
        sourceId: observation.sourceCode,
        sourceChannel: "official_api",
        submittedAt,
      });
    }
  }
  return {
    reports: [...reportsById.values()],
    trustedReportIds: new Set(reportsById.keys()),
  };
}

function assertStageResult(condition, code, message) {
  if (!condition) throw new EvidencePipelineError(code, message);
}

function stageError(code, message, error) {
  if (error instanceof EvidencePipelineError) return error;
  return new EvidencePipelineError(code, message, error);
}

function createEvidencePipeline({
  sourceAttributionService = createSourceAttributionService(),
  reportingPeriodAggregator = createReportingPeriodAggregationService({
    trustedReportService: sourceAttributionService,
  }),
  calculateCompleteness = calculateReportingCompleteness,
  calculateBaseline = calculateHistoricalBaseline,
  detectAnomaly = detectReportingAnomaly,
  buildEvidencePackage = createEvidencePackage,
  minimumHistoricalObservations = DEFAULT_MINIMUM_HISTORICAL_OBSERVATIONS,
  anomalyThresholds,
} = {}) {
  if (
    !Number.isInteger(minimumHistoricalObservations) ||
    minimumHistoricalObservations < 1
  ) {
    throw new TypeError(
      "minimumHistoricalObservations must be a positive integer.",
    );
  }

  async function generateEvidenceForSource({
    sourceCode,
    historyStart,
    evaluatedAt = new Date(),
    channelAvailabilityByPeriod = {},
    packageId,
  } = {}) {
    if (typeof sourceCode !== "string" || !sourceCode.trim()) {
      throw new EvidencePipelineError(
        "SOURCE_NOT_FOUND",
        "A configured sourceCode is required.",
      );
    }

    let source;
    try {
      source = await sourceAttributionService.getConfiguredSource({
        sourceCode,
      });
    } catch (error) {
      throw stageError(
        "SOURCE_RESOLUTION_FAILED",
        "Unable to resolve the configured reporting source.",
        error,
      );
    }
    if (!source) {
      throw new EvidencePipelineError(
        "SOURCE_NOT_FOUND",
        "No configured reporting source matches the requested sourceCode.",
      );
    }
    if (source.sourceCode !== sourceCode) {
      throw new EvidencePipelineError(
        "SOURCE_NOT_FOUND",
        "Configured source resolution returned a different source.",
      );
    }
    if (source.isActive !== true) {
      throw new EvidencePipelineError(
        "SOURCE_INACTIVE",
        "The configured reporting source is inactive.",
      );
    }

    const evaluationTime = toDate(evaluatedAt, "evaluatedAt");
    let rangeStart;
    let currentPeriod;
    try {
      const schedule = source.reportingSchedule;
      currentPeriod =
        calculateReportingCompleteness.getReportingPeriodForLocalDate(
          schedule,
          getLocalDateParts(evaluationTime, schedule.timezone),
        );
      const sourceValidFrom = toDate(source.validFrom, "source.validFrom");
      const sourceValidUntil =
        source.validUntil == null
          ? null
          : toDate(source.validUntil, "source.validUntil");
      if (
        sourceValidFrom > currentPeriod.start ||
        (sourceValidUntil && sourceValidUntil < currentPeriod.deadline)
      ) {
        throw new TypeError(
          "The current reporting period is outside the configured source validity window.",
        );
      }
      rangeStart = toDate(historyStart, "historyStart");
      const historyStartPeriod =
        calculateReportingCompleteness.getReportingPeriodForLocalDate(
          schedule,
          getLocalDateParts(rangeStart, schedule.timezone),
        );
      if (
        historyStartPeriod.start.getTime() !== rangeStart.getTime() ||
        rangeStart > currentPeriod.start
      ) {
        throw new TypeError(
          "historyStart must align with a reporting-period boundary at or before the current period.",
        );
      }
    } catch (error) {
      throw stageError(
        "INVALID_PERIOD_RANGE",
        "The evaluation range is invalid for the configured reporting schedule.",
        error,
      );
    }

    let aggregation;
    try {
      aggregation =
        await reportingPeriodAggregator.aggregateReportingPeriods({
          sourceCode,
          rangeStart,
          rangeEnd: currentPeriod.end,
          evaluatedAt: evaluationTime,
          channelAvailabilityByPeriod,
        });
    } catch (error) {
      const code =
        error?.code === "TRUSTED_LOOKUP_FAILED" ||
        error?.code === "INCOMPLETE_QUERY_COVERAGE"
          ? error.code
          : error instanceof RangeError
            ? "INVALID_PERIOD_RANGE"
            : "AGGREGATION_FAILED";
      if (
        code === "TRUSTED_LOOKUP_FAILED" ||
        code === "INCOMPLETE_QUERY_COVERAGE"
      ) {
        throw new EvidencePipelineError(
          code,
          "Trusted report retrieval or query coverage validation failed.",
          error.cause || error,
        );
      }
      throw stageError(
        code,
        "Reporting-period aggregation or trusted query validation failed.",
        error,
      );
    }
    assertStageResult(
      aggregation?.queriedTrustedReports === true &&
        aggregation.status === "aggregated" &&
        aggregation.sourceCode === sourceCode &&
        Array.isArray(aggregation.observations),
      "INCOMPLETE_QUERY_COVERAGE",
      "Aggregation did not confirm complete trusted query coverage.",
    );

    const currentPeriodStart = currentPeriod.start.toISOString();
    const currentAggregatedObservation = aggregation.observations.find(
      (observation) =>
        new Date(observation.periodStart).toISOString() === currentPeriodStart,
    );
    assertStageResult(
      currentAggregatedObservation?.isTrusted === true,
      "INCOMPLETE_QUERY_COVERAGE",
      "The current reporting period is missing from trusted aggregation results.",
    );

    const { reports, trustedReportIds } =
      getTrustedReportsFromObservations(aggregation.observations);
    const currentChannelAvailability =
      currentAggregatedObservation.channelAvailability || "unknown";
    let completeness;
    try {
      const results = calculateCompleteness({
        sources: [source],
        reports,
        trustedReportIds,
        now: evaluationTime,
        channelAvailabilityBySourceCode: {
          [sourceCode]: currentChannelAvailability,
        },
      });
      completeness = results?.[0];
      assertStageResult(
        completeness &&
          completeness.sourceCode === sourceCode &&
          completeness.period?.start?.getTime?.() ===
            currentPeriod.start.getTime(),
        "COMPLETENESS_FAILED",
        "Completeness result does not match the current source period.",
      );
    } catch (error) {
      throw stageError(
        "COMPLETENESS_FAILED",
        "Unable to calculate current reporting completeness.",
        error,
      );
    }

    const historicalObservations = aggregation.observations.filter(
      (observation) =>
        observation.isTrusted === true &&
        observation.periodStart !== currentPeriodStart &&
        COMPLETED_PERIOD_STATUSES.has(observation.status) &&
        new Date(observation.periodEnd) <= evaluationTime,
    );

    let baseline;
    try {
      baseline = calculateBaseline({
        sourceCode,
        frequency: source.reportingSchedule.frequency,
        observations: historicalObservations,
        minimumObservations: minimumHistoricalObservations,
        asOf: evaluationTime,
      });
    } catch (error) {
      throw stageError(
        "BASELINE_FAILED",
        "Unable to calculate the historical reporting baseline.",
        error,
      );
    }

    const currentObservation = {
      sourceCode,
      frequency: source.reportingSchedule.frequency,
      periodStart: completeness.period.start,
      periodEnd: completeness.period.end,
      expectedReports: completeness.expectedReports,
      eligibleReceivedReports: completeness.receivedReports,
      status: completeness.status,
      channelAvailability: completeness.channelAvailability || "unknown",
      isTrusted: true,
    };
    let anomaly;
    try {
      anomaly = detectAnomaly({
        currentObservation,
        baseline,
        channelAvailability: currentObservation.channelAvailability,
        ...(anomalyThresholds ? { thresholds: anomalyThresholds } : {}),
      });
    } catch (error) {
      throw stageError(
        "ANOMALY_DETECTION_FAILED",
        "Unable to detect reporting-pattern anomalies.",
        error,
      );
    }

    const trustedObservationReferences = [
      ...historicalObservations,
      currentAggregatedObservation,
    ].flatMap(
      (observation) =>
        (observation.trustedReportIds || []).map((id) => ({
          id: String(id),
          periodStart: observation.periodStart,
          periodEnd: observation.periodEnd,
          isTrusted: true,
        })),
    );
    try {
      const evidencePackage = buildEvidencePackage({
        packageId,
        evaluatedAt: evaluationTime,
        source: {
          sourceCode: source.sourceCode,
          name: source.name,
          frequency: source.reportingSchedule.frequency,
          timezone: source.reportingSchedule.timezone,
          expectedReportsPerPeriod:
            source.reportingSchedule.expectedReportsPerPeriod,
        },
        completeness,
        baseline,
        anomaly,
        thresholds: anomalyThresholds,
        limitations: [
          ...aggregation.limitations,
          ...(currentAggregatedObservation.limitations || []),
        ],
        historicalObservations,
        trustedObservationReferences,
      });
      JSON.stringify(evidencePackage);
      return {
        evidencePackage,
        source,
        completeness,
        historicalObservations,
        baseline,
        anomaly,
        aggregation,
      };
    } catch (error) {
      throw stageError(
        "EVIDENCE_PACKAGE_FAILED",
        "Unable to assemble a JSON-compatible evidence package.",
        error,
      );
    }
  }

  return { generateEvidenceForSource };
}

const defaultPipeline = createEvidencePipeline();

module.exports = {
  DEFAULT_MINIMUM_HISTORICAL_OBSERVATIONS,
  EvidencePipelineError,
  createEvidencePipeline,
  generateEvidenceForSource: (options) =>
    defaultPipeline.generateEvidenceForSource(options),
};
