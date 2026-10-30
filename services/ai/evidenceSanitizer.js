const {
  EVIDENCE_VERSION,
  FACT_REFERENCES,
  SANITIZED_EVIDENCE_VERSION,
} = require("../../constants/aiInterpretation");

const MAX_SANITIZED_EVIDENCE_CHARACTERS = 12_000;

const FIELD_REFERENCES = Object.freeze({
  "metadata.evaluatedAt": ["metadata", "evaluatedAt"],
  "metadata.frequency": ["metadata", "frequency"],
  "metadata.period.start": ["metadata", "period", "start"],
  "metadata.period.end": ["metadata", "period", "end"],
  "metadata.expectedReportsPerPeriod": [
    "metadata",
    "expectedReportsPerPeriod",
  ],
  "observedFacts.expectedReports": ["observedFacts", "expectedReports"],
  "observedFacts.eligibleReceivedReports": [
    "observedFacts",
    "eligibleReceivedReports",
  ],
  "observedFacts.periodStatus": ["observedFacts", "periodStatus"],
  "observedFacts.channelAvailability": [
    "observedFacts",
    "channelAvailability",
  ],
  "observedFacts.historicalObservationCount": [
    "observedFacts",
    "historicalObservationCount",
  ],
  "calculatedFindings.completeness.status": [
    "calculatedFindings",
    "completeness",
    "status",
  ],
  "calculatedFindings.completeness.percent": [
    "calculatedFindings",
    "completeness",
    "percent",
  ],
  "calculatedFindings.historicalBaseline.status": [
    "calculatedFindings",
    "historicalBaseline",
    "status",
  ],
  "calculatedFindings.historicalBaseline.minimumObservations": [
    "calculatedFindings",
    "historicalBaseline",
    "minimumObservations",
  ],
  "calculatedFindings.historicalBaseline.validHistoricalPeriods": [
    "calculatedFindings",
    "historicalBaseline",
    "validHistoricalPeriods",
  ],
  "calculatedFindings.historicalBaseline.meanEligibleReports": [
    "calculatedFindings",
    "historicalBaseline",
    "meanEligibleReports",
  ],
  "calculatedFindings.historicalBaseline.medianEligibleReports": [
    "calculatedFindings",
    "historicalBaseline",
    "medianEligibleReports",
  ],
  "calculatedFindings.historicalBaseline.minimumEligibleReports": [
    "calculatedFindings",
    "historicalBaseline",
    "minimumEligibleReports",
  ],
  "calculatedFindings.historicalBaseline.maximumEligibleReports": [
    "calculatedFindings",
    "historicalBaseline",
    "maximumEligibleReports",
  ],
  "calculatedFindings.historicalBaseline.populationStandardDeviation": [
    "calculatedFindings",
    "historicalBaseline",
    "populationStandardDeviation",
  ],
  "calculatedFindings.historicalBaseline.expectedReportsPerPeriod": [
    "calculatedFindings",
    "historicalBaseline",
    "expectedReportsPerPeriod",
  ],
  "calculatedFindings.anomaly.status": [
    "calculatedFindings",
    "anomaly",
    "status",
  ],
  "calculatedFindings.anomaly.type": [
    "calculatedFindings",
    "anomaly",
    "type",
  ],
  "calculatedFindings.anomaly.deviationCategory": [
    "calculatedFindings",
    "anomaly",
    "deviationCategory",
  ],
  "calculatedFindings.anomaly.absoluteDifference": [
    "calculatedFindings",
    "anomaly",
    "absoluteDifference",
  ],
  "calculatedFindings.anomaly.percentageDeviation": [
    "calculatedFindings",
    "anomaly",
    "percentageDeviation",
  ],
});

const STRING_ENUMS = Object.freeze({
  "metadata.frequency": new Set(["daily", "weekly"]),
  "observedFacts.periodStatus": new Set([
    "complete",
    "incomplete",
    "reporting_gap",
    "in_progress",
    "channel_unavailable",
    "incomplete_channel_unavailable",
    "inactive",
    "not_applicable",
  ]),
  "observedFacts.channelAvailability": new Set([
    "unknown",
    "available",
    "unavailable",
  ]),
  "calculatedFindings.completeness.status": new Set([
    "complete",
    "incomplete",
    "reporting_gap",
    "in_progress",
    "channel_unavailable",
    "incomplete_channel_unavailable",
    "inactive",
    "not_applicable",
  ]),
  "calculatedFindings.historicalBaseline.status": new Set([
    "ready",
    "insufficient_history",
  ]),
  "calculatedFindings.anomaly.status": new Set([
    "anomaly",
    "normal_variation",
    "insufficient_history",
    "in_progress",
    "channel_unavailable",
    "inactive",
    "not_applicable",
    "untrusted_observation",
  ]),
});

class EvidenceSanitizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EvidenceSanitizationError";
    this.code = code;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function getPath(object, path) {
  return path.reduce((value, key) => value?.[key], object);
}

function requireInteger(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EvidenceSanitizationError(
      "INVALID_EVIDENCE",
      `${name} is missing or invalid.`,
    );
  }
}

function requireNullableNumber(value, name, { minimum = 0, maximum = Infinity } = {}) {
  if (
    value !== null &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < minimum ||
      value > maximum)
  ) {
    throw new EvidenceSanitizationError(
      "INVALID_EVIDENCE",
      `${name} is missing or invalid.`,
    );
  }
}

function requireSafeToken(value, name) {
  if (
    typeof value !== "string" ||
    value.length > 100 ||
    !/^[a-z][a-z0-9_]*$/.test(value)
  ) {
    throw new EvidenceSanitizationError(
      "INVALID_EVIDENCE",
      `${name} is missing or invalid.`,
    );
  }
}

function requireTimestamp(value, name) {
  if (
    typeof value !== "string" ||
    value.length > 30 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new EvidenceSanitizationError(
      "INVALID_EVIDENCE",
      `${name} is missing or invalid.`,
    );
  }
}

function stableStringify(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  throw new EvidenceSanitizationError(
    "INVALID_EVIDENCE",
    "Evidence contains an unsupported value.",
  );
}

function sanitizeEvidenceSnapshot(snapshot, evidenceVersion) {
  if (!isPlainObject(snapshot)) {
    throw new EvidenceSanitizationError(
      "INVALID_EVIDENCE",
      "Investigation evidence is missing or invalid.",
    );
  }
  if (snapshot.schemaVersion !== EVIDENCE_VERSION) {
    throw new EvidenceSanitizationError(
      "UNSUPPORTED_EVIDENCE_VERSION",
      "The investigation evidence version is not supported.",
    );
  }
  if (
    evidenceVersion !== undefined &&
    evidenceVersion !== snapshot.schemaVersion
  ) {
    throw new EvidenceSanitizationError(
      "INVALID_EVIDENCE",
      "The stored evidence version does not match its snapshot.",
    );
  }

  const metadata = snapshot.metadata;
  const observedFacts = snapshot.observedFacts;
  const findings = snapshot.calculatedFindings;
  const completeness = findings?.completeness;
  const baseline = findings?.historicalBaseline;
  const anomaly = findings?.anomaly;
  if (
    !isPlainObject(metadata) ||
    !isPlainObject(metadata.period) ||
    !isPlainObject(observedFacts) ||
    !isPlainObject(findings) ||
    !isPlainObject(completeness) ||
    !isPlainObject(baseline) ||
    !isPlainObject(anomaly)
  ) {
    throw new EvidenceSanitizationError(
      "INVALID_EVIDENCE",
      "The evidence snapshot is missing required deterministic findings.",
    );
  }

  requireSafeToken(metadata.frequency, "Reporting frequency");
  if (!["daily", "weekly"].includes(metadata.frequency)) {
    throw new EvidenceSanitizationError(
      "INVALID_EVIDENCE",
      "Reporting frequency is unsupported.",
    );
  }
  for (const [value, name] of [
    [metadata.evaluatedAt, "Evaluation time"],
    [metadata.period.start, "Reporting period start"],
    [metadata.period.end, "Reporting period end"],
  ]) {
    requireTimestamp(value, name);
  }
  if (Date.parse(metadata.period.end) <= Date.parse(metadata.period.start)) {
    throw new EvidenceSanitizationError(
      "INVALID_EVIDENCE",
      "Reporting period boundaries are invalid.",
    );
  }

  const sanitized = {
    schemaVersion: SANITIZED_EVIDENCE_VERSION,
    evidenceVersion: snapshot.schemaVersion,
    metadata: {
      evaluatedAt: new Date(metadata.evaluatedAt).toISOString(),
      frequency: metadata.frequency,
      period: {
        start: new Date(metadata.period.start).toISOString(),
        end: new Date(metadata.period.end).toISOString(),
      },
      expectedReportsPerPeriod:
        metadata.expectedReportsPerPeriod === undefined
          ? null
          : metadata.expectedReportsPerPeriod,
    },
    observedFacts: {
      expectedReports: observedFacts.expectedReports,
      eligibleReceivedReports: observedFacts.eligibleReceivedReports,
      periodStatus: observedFacts.periodStatus,
      channelAvailability: observedFacts.channelAvailability,
      historicalObservationCount: observedFacts.historicalObservationCount,
    },
    calculatedFindings: {
      completeness: {
        status: completeness.status,
        percent: completeness.percent,
      },
      historicalBaseline: {
        status: baseline.status,
        minimumObservations: baseline.minimumObservations,
        validHistoricalPeriods: observedFacts.historicalObservationCount,
        meanEligibleReports: baseline.meanEligibleReports,
        medianEligibleReports: baseline.medianEligibleReports,
        minimumEligibleReports: baseline.minimumEligibleReports,
        maximumEligibleReports: baseline.maximumEligibleReports,
        populationStandardDeviation: baseline.populationStandardDeviation,
        expectedReportsPerPeriod: baseline.expectedReportsPerPeriod,
      },
      anomaly: {
        status: anomaly.status,
        type: anomaly.type ?? null,
        deviationCategory: anomaly.deviationCategory ?? null,
        absoluteDifference: anomaly.absoluteDifference ?? null,
        percentageDeviation: anomaly.percentageDeviation ?? null,
      },
    },
  };

  requireInteger(sanitized.metadata.expectedReportsPerPeriod, "Expected reports", {
    nullable: true,
  });
  requireInteger(sanitized.observedFacts.expectedReports, "Expected reports");
  requireInteger(
    sanitized.observedFacts.eligibleReceivedReports,
    "Eligible received reports",
    { nullable: true },
  );
  requireInteger(
    sanitized.observedFacts.historicalObservationCount,
    "Historical observation count",
  );
  requireInteger(
    sanitized.calculatedFindings.historicalBaseline.minimumObservations,
    "Minimum historical observations",
  );
  for (const [path, value] of Object.entries({
    "observedFacts.periodStatus": sanitized.observedFacts.periodStatus,
    "observedFacts.channelAvailability":
      sanitized.observedFacts.channelAvailability,
    "calculatedFindings.completeness.status": completeness.status,
    "calculatedFindings.historicalBaseline.status": baseline.status,
    "calculatedFindings.anomaly.status": anomaly.status,
  })) {
    const allowed = STRING_ENUMS[path];
    if (typeof value !== "string" || !allowed?.has(value)) {
      throw new EvidenceSanitizationError(
        "INVALID_EVIDENCE",
        `${path} is missing or unsupported.`,
      );
    }
  }
  requireNullableNumber(sanitized.calculatedFindings.completeness.percent, "Completeness percent", {
    maximum: 100,
  });
  for (const [field, value] of Object.entries(
    sanitized.calculatedFindings.historicalBaseline,
  )) {
    if (!["status", "minimumObservations", "validHistoricalPeriods"].includes(field)) {
      requireNullableNumber(value, `Historical baseline ${field}`);
    }
  }
  if (anomaly.type !== null) requireSafeToken(anomaly.type, "Anomaly type");
  if (
    anomaly.deviationCategory !== null &&
    anomaly.deviationCategory !== undefined
  ) {
    requireSafeToken(anomaly.deviationCategory, "Deviation category");
  }
  requireNullableNumber(anomaly.absoluteDifference, "Absolute difference");
  requireNullableNumber(anomaly.percentageDeviation, "Percentage deviation", {
    minimum: -100_000,
  });

  if (
    sanitized.observedFacts.periodStatus !==
      sanitized.calculatedFindings.completeness.status
  ) {
    throw new EvidenceSanitizationError(
      "INCONSISTENT_EVIDENCE",
      "The observed and calculated period statuses do not match.",
    );
  }

  const canonicalInput = stableStringify(sanitized);
  if (canonicalInput.length > MAX_SANITIZED_EVIDENCE_CHARACTERS) {
    throw new EvidenceSanitizationError(
      "EVIDENCE_TOO_LARGE",
      "Sanitized evidence exceeds the allowed size.",
    );
  }
  const availableReferences = new Set(
    Object.entries(FIELD_REFERENCES)
      .filter(([, path]) => getPath(sanitized, path) !== undefined)
      .map(([reference]) => reference),
  );
  return { sanitized, canonicalInput, availableReferences };
}

module.exports = {
  EVIDENCE_VERSION,
  FACT_REFERENCES,
  FIELD_REFERENCES,
  MAX_SANITIZED_EVIDENCE_CHARACTERS,
  SANITIZED_EVIDENCE_VERSION,
  EvidenceSanitizationError,
  getPath,
  sanitizeEvidenceSnapshot,
  stableStringify,
};
