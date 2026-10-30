const { createHash } = require("node:crypto");

const PACKAGE_SCHEMA_VERSION = "null-signal-evidence-package.v1";
const COMPLETENESS_STATUSES = new Set([
  "complete",
  "incomplete",
  "reporting_gap",
  "in_progress",
  "channel_unavailable",
  "incomplete_channel_unavailable",
  "inactive",
  "not_applicable",
]);
const BASELINE_STATUSES = new Set(["ready", "insufficient_history"]);
const ANOMALY_STATUSES = new Set([
  "anomaly",
  "normal_variation",
  "insufficient_history",
  "in_progress",
  "channel_unavailable",
  "inactive",
  "not_applicable",
  "untrusted_observation",
]);
const CHANNEL_AVAILABILITY = new Set(["unknown", "available", "unavailable"]);

function toDate(value, fieldName) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${fieldName} must be a valid timestamp.`);
  }
  return date;
}

function isoDate(value, fieldName) {
  return toDate(value, fieldName).toISOString();
}

function stableStringify(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify(value[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireObject(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an object.`);
  }
}

function requireCount(value, fieldName, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer.`);
  }
}

function requireNullableNumber(value, fieldName) {
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    throw new TypeError(`${fieldName} must be a non-negative number or null.`);
  }
}

function sameTimestamp(left, right) {
  return isoDate(left, "period boundary") === isoDate(right, "period boundary");
}

function filterTrustedReferences(references) {
  if (references === undefined) return [];
  if (!Array.isArray(references)) {
    throw new TypeError("trustedObservationReferences must be an array.");
  }

  return references
    .filter((reference) => reference?.isTrusted === true)
    .map((reference, index) => {
      if (
        typeof reference.id !== "string" ||
        !reference.id.trim() ||
        typeof reference.periodStart !== "string" ||
        typeof reference.periodEnd !== "string"
      ) {
        throw new TypeError(
          `Trusted observation reference ${index} requires an id and period boundaries.`,
        );
      }

      return {
        id: reference.id,
        periodStart: isoDate(
          reference.periodStart,
          `trustedObservationReferences[${index}].periodStart`,
        ),
        periodEnd: isoDate(
          reference.periodEnd,
          `trustedObservationReferences[${index}].periodEnd`,
        ),
      };
    });
}

function pickDefined(source, keys) {
  return Object.fromEntries(
    keys
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]]),
  );
}

function createEvidencePackage({
  packageId,
  evaluatedAt,
  source,
  completeness,
  baseline,
  anomaly,
  thresholds,
  limitations = [],
  historicalObservations = [],
  trustedObservationReferences,
}) {
  requireObject(source, "source");
  requireObject(completeness, "completeness");
  requireObject(baseline, "baseline");
  requireObject(anomaly, "anomaly");
  requireObject(anomaly.evidence, "anomaly.evidence");
  requireObject(
    anomaly.evidence.observedFacts,
    "anomaly.evidence.observedFacts",
  );

  if (typeof source.sourceCode !== "string" || !source.sourceCode.trim()) {
    throw new TypeError("source.sourceCode is required.");
  }
  if (!["daily", "weekly"].includes(source.frequency)) {
    throw new TypeError("source.frequency must be daily or weekly.");
  }
  if (source.name !== undefined && typeof source.name !== "string") {
    throw new TypeError("source.name must be a string when supplied.");
  }
  if (
    source.timezone !== undefined &&
    typeof source.timezone !== "string"
  ) {
    throw new TypeError("source.timezone must be a string when supplied.");
  }
  if (
    source.expectedReportsPerPeriod !== undefined &&
    (!Number.isInteger(source.expectedReportsPerPeriod) ||
      source.expectedReportsPerPeriod < 1)
  ) {
    throw new TypeError(
      "source.expectedReportsPerPeriod must be a positive integer when supplied.",
    );
  }
  if (
    !Array.isArray(limitations) ||
    limitations.some((item) => typeof item !== "string")
  ) {
    throw new TypeError("limitations must be an array of strings.");
  }
  if (!Array.isArray(historicalObservations)) {
    throw new TypeError("historicalObservations must be an array.");
  }
  if (
    !Array.isArray(anomaly.limitations) ||
    anomaly.limitations.some((item) => typeof item !== "string") ||
    !Array.isArray(anomaly.unknowns) ||
    anomaly.unknowns.some((item) => typeof item !== "string")
  ) {
    throw new TypeError(
      "Anomaly limitations and unknowns must be arrays of strings.",
    );
  }

  const evaluatedAtIso = isoDate(evaluatedAt, "evaluatedAt");
  if (completeness.sourceCode !== source.sourceCode) {
    throw new TypeError("Completeness sourceCode does not match source.");
  }
  if (baseline.sourceCode !== source.sourceCode) {
    throw new TypeError("Baseline sourceCode does not match source.");
  }
  if (baseline.frequency !== source.frequency) {
    throw new TypeError("Baseline frequency does not match source.");
  }
  if (anomaly.evidence?.observedFacts?.sourceCode !== source.sourceCode) {
    throw new TypeError("Anomaly sourceCode does not match source.");
  }
  if (!COMPLETENESS_STATUSES.has(completeness.status)) {
    throw new TypeError("completeness.status is not supported.");
  }
  if (!BASELINE_STATUSES.has(baseline.status)) {
    throw new TypeError("baseline.status is not supported.");
  }
  if (!ANOMALY_STATUSES.has(anomaly.status)) {
    throw new TypeError("anomaly.status is not supported.");
  }
  if (
    completeness.channelAvailability !== undefined &&
    !CHANNEL_AVAILABILITY.has(completeness.channelAvailability)
  ) {
    throw new TypeError("completeness.channelAvailability is not supported.");
  }

  const periodStart = isoDate(
    completeness.period?.start,
    "completeness.period.start",
  );
  const periodEnd = isoDate(
    completeness.period?.end,
    "completeness.period.end",
  );
  if (new Date(periodEnd) <= new Date(periodStart)) {
    throw new TypeError("Completeness period end must follow period start.");
  }
  if (
    anomaly.evidence.observedFacts.periodStart === undefined ||
    !sameTimestamp(
      anomaly.evidence.observedFacts.periodStart,
      periodStart,
    ) ||
    !sameTimestamp(anomaly.evidence.observedFacts.periodEnd, periodEnd)
  ) {
    throw new TypeError("Anomaly period boundaries do not match completeness.");
  }

  requireCount(completeness.expectedReports, "completeness.expectedReports");
  requireCount(completeness.receivedReports, "completeness.receivedReports", {
    nullable: true,
  });
  if (
    completeness.completenessPercent !== null &&
    (!Number.isFinite(completeness.completenessPercent) ||
      completeness.completenessPercent < 0 ||
      completeness.completenessPercent > 100)
  ) {
    throw new TypeError(
      "completeness.completenessPercent must be null or 0–100.",
    );
  }
  if (
    baseline.validHistoricalPeriods === null ||
    !Number.isInteger(baseline.validHistoricalPeriods) ||
    baseline.validHistoricalPeriods < 0
  ) {
    throw new TypeError(
      "baseline.validHistoricalPeriods must be a non-negative integer.",
    );
  }
  if (
    !Number.isInteger(baseline.minimumObservations) ||
    baseline.minimumObservations < 1
  ) {
    throw new TypeError("baseline.minimumObservations must be a positive integer.");
  }
  for (const field of [
    "meanEligibleReports",
    "medianEligibleReports",
    "minimumEligibleReports",
    "maximumEligibleReports",
    "populationStandardDeviation",
    "expectedReportsPerPeriod",
  ]) {
    if (!(field in baseline)) {
      throw new TypeError(`baseline.${field} is required.`);
    }
    requireNullableNumber(baseline[field], `baseline.${field}`);
  }
  if (typeof anomaly.explanation !== "string") {
    throw new TypeError("anomaly.explanation is required.");
  }
  if (
    completeness.receivedReports !== null &&
    anomaly.currentEligibleReports !== completeness.receivedReports
  ) {
    throw new TypeError(
      "Anomaly eligible count does not match completeness received count.",
    );
  }
  requireCount(anomaly.currentEligibleReports, "anomaly.currentEligibleReports");
  if (completeness.expectedReports < 1) {
    throw new TypeError("completeness.expectedReports must be positive.");
  }
  if (
    (completeness.receivedReports !== null &&
      anomaly.evidence.observedFacts.eligibleReceivedReports !==
        completeness.receivedReports) ||
    anomaly.evidence.observedFacts.expectedReports !==
      completeness.expectedReports ||
    anomaly.evidence.observedFacts.status !== completeness.status
  ) {
    throw new TypeError(
      "Anomaly observed facts do not match completeness results.",
    );
  }
  if (
    anomaly.evidence.observedFacts.channelAvailability !== undefined &&
    completeness.channelAvailability !== undefined &&
    anomaly.evidence.observedFacts.channelAvailability !==
      completeness.channelAvailability
  ) {
    throw new TypeError(
      "Anomaly channel availability does not match completeness.",
    );
  }
  const periodDeadline =
    completeness.period.deadline === undefined
      ? undefined
      : isoDate(completeness.period.deadline, "completeness.period.deadline");
  if (
    completeness.period.timezone !== undefined &&
    typeof completeness.period.timezone !== "string"
  ) {
    throw new TypeError("completeness.period.timezone must be a string.");
  }
  const channelAvailability =
    completeness.channelAvailability || "unknown";
  const trustedReferences = filterTrustedReferences(
    trustedObservationReferences,
  );
  const summarizedHistoricalObservations = historicalObservations.map(
    (observation, index) => {
      requireObject(observation, `historicalObservations[${index}]`);
      if (
        observation.isTrusted !== true ||
        observation.sourceCode !== source.sourceCode ||
        observation.frequency !== source.frequency
      ) {
        throw new TypeError(
          `historicalObservations[${index}] is not a trusted matching observation.`,
        );
      }
      requireCount(
        observation.expectedReports,
        `historicalObservations[${index}].expectedReports`,
      );
      requireCount(
        observation.eligibleReceivedReports,
        `historicalObservations[${index}].eligibleReceivedReports`,
      );
      if (observation.expectedReports < 1) {
        throw new TypeError(
          `historicalObservations[${index}].expectedReports must be positive.`,
        );
      }
      return {
        periodStart: isoDate(
          observation.periodStart,
          `historicalObservations[${index}].periodStart`,
        ),
        periodEnd: isoDate(
          observation.periodEnd,
          `historicalObservations[${index}].periodEnd`,
        ),
        frequency: observation.frequency,
        expectedReports: observation.expectedReports,
        eligibleReceivedReports: observation.eligibleReceivedReports,
        status: observation.status,
        channelAvailability:
          observation.channelAvailability || "unknown",
        isTrusted: true,
        trustProvenance:
          "server_controlled_source_attribution_query",
      };
    },
  );
  const anomalyEvidence = {
    observedFacts: pickDefined(anomaly.evidence.observedFacts, [
      "sourceCode",
      "periodStart",
      "periodEnd",
      "expectedReports",
      "eligibleReceivedReports",
      "status",
      "channelAvailability",
    ]),
    calculatedFindings: pickDefined(anomaly.evidence.calculatedFindings, [
      "historicalMean",
      "historicalMedian",
      "historicalPopulationStandardDeviation",
      "currentMinusHistoricalMean",
      "historicalMinimum",
      "historicalMaximum",
      "absoluteDifference",
      "percentageDeviation",
    ]),
  };
  const allLimitations = [
    ...new Set([
      ...limitations,
      ...(baseline.excluded?.untrusted > 0
        ? [`${baseline.excluded.untrusted} untrusted historical observation(s) were excluded.`]
        : []),
      ...anomaly.limitations,
      ...anomaly.unknowns.map((unknown) => `Unknown: ${unknown}`),
      "This builder preserves upstream trust decisions; it does not verify report origin.",
      "A reporting anomaly is not proof of an outbreak, improved public health, deliberate suppression, or misconduct.",
      "An unavailable reporting channel does not establish why it became unavailable.",
      "Any future AI interpretation must not turn missing evidence into factual conclusions.",
    ]),
  ];

  const packageBody = {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    metadata: {
      evaluatedAt: evaluatedAtIso,
      sourceCode: source.sourceCode,
      ...(source.name === undefined ? {} : { sourceName: source.name }),
      frequency: source.frequency,
      ...(source.timezone === undefined ? {} : { timezone: source.timezone }),
      ...(source.expectedReportsPerPeriod === undefined
        ? {}
        : { expectedReportsPerPeriod: source.expectedReportsPerPeriod }),
      period: {
        start: periodStart,
        end: periodEnd,
        ...(periodDeadline ? { deadline: periodDeadline } : {}),
        ...(completeness.period.timezone === undefined
          ? {}
          : { timezone: completeness.period.timezone }),
      },
    },
    summary: {
      sourceCode: source.sourceCode,
      periodStatus: completeness.status,
      completenessPercent: completeness.completenessPercent,
      baselineStatus: baseline.status,
      anomalyStatus: anomaly.status,
      anomalyType: anomaly.anomalyType,
    },
    observedFacts: {
      expectedReports: completeness.expectedReports,
      eligibleReceivedReports: completeness.receivedReports,
      periodStatus: completeness.status,
      channelAvailability,
      historicalObservationCount: baseline.validHistoricalPeriods,
    },
    calculatedFindings: {
      completeness: {
        status: completeness.status,
        percent: completeness.completenessPercent,
      },
      historicalBaseline: {
        status: baseline.status,
        minimumObservations: baseline.minimumObservations,
        meanEligibleReports: baseline.meanEligibleReports,
        medianEligibleReports: baseline.medianEligibleReports,
        minimumEligibleReports: baseline.minimumEligibleReports,
        maximumEligibleReports: baseline.maximumEligibleReports,
        populationStandardDeviation: baseline.populationStandardDeviation,
        expectedReportsPerPeriod: baseline.expectedReportsPerPeriod,
      },
      anomaly: {
        status: anomaly.status,
        type: anomaly.anomalyType,
        deviationCategory: anomaly.deviationCategory,
        absoluteDifference: anomaly.absoluteDifference,
        percentageDeviation: anomaly.percentageDeviation,
        explanation: anomaly.explanation,
      },
    },
    evidence: {
      ...(thresholds === undefined ? {} : { thresholds }),
      anomaly: anomalyEvidence,
      historicalObservations: summarizedHistoricalObservations,
      trustedObservationReferences: trustedReferences,
    },
    limitationsAndUnknowns: {
      limitations: allLimitations,
      possibleExplanations: anomaly.possibleExplanations,
      unknowns: anomaly.unknowns,
    },
    interpretationBoundaries: [
      "A reporting anomaly is not proof of an outbreak.",
      "Reduced reporting is not proof of improved public health.",
      "Missing reports are not proof of deliberate suppression.",
      "An unavailable reporting channel does not establish why it became unavailable.",
      "AI must not turn missing evidence into factual conclusions.",
    ],
  };

  if (
    !Array.isArray(anomaly.possibleExplanations) ||
    anomaly.possibleExplanations.some((item) => typeof item !== "string")
  ) {
    throw new TypeError("anomaly.possibleExplanations must be an array.");
  }
  try {
    JSON.stringify(packageBody);
  } catch (error) {
    throw new TypeError("Evidence package inputs must be JSON-serializable.", {
      cause: error,
    });
  }

  if (
    packageId !== undefined &&
    (typeof packageId !== "string" || !packageId.trim())
  ) {
    throw new TypeError("packageId must be a non-empty string when supplied.");
  }
  const deterministicId = `ep_${createHash("sha256")
    .update(stableStringify(packageBody))
    .digest("hex")
    .slice(0, 24)}`;

  return {
    packageId: packageId || deterministicId,
    ...packageBody,
  };
}

module.exports = createEvidencePackage;
