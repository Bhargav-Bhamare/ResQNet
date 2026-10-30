const DEFAULT_THRESHOLDS = Object.freeze({
  minimumHistoricalPeriods: 5,
  unusuallyLowRatio: 0.75,
  suddenDropRatio: 0.5,
  minimumAbsoluteDrop: 2,
  standardDeviationMultiplier: 2,
});
function validateCount(value, fieldName) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer.`);
  }
}

function validateThresholds(thresholds) {
  const result = { ...DEFAULT_THRESHOLDS, ...thresholds };

  if (
    !Number.isInteger(result.minimumHistoricalPeriods) ||
    result.minimumHistoricalPeriods < 1
  ) {
    throw new TypeError("minimumHistoricalPeriods must be a positive integer.");
  }
  if (
    !Number.isFinite(result.unusuallyLowRatio) ||
    result.unusuallyLowRatio <= 0 ||
    result.unusuallyLowRatio >= 1
  ) {
    throw new TypeError("unusuallyLowRatio must be between 0 and 1.");
  }
  if (
    !Number.isFinite(result.suddenDropRatio) ||
    result.suddenDropRatio <= 0 ||
    result.suddenDropRatio >= result.unusuallyLowRatio
  ) {
    throw new TypeError(
      "suddenDropRatio must be positive and less than unusuallyLowRatio.",
    );
  }
  if (
    !Number.isInteger(result.minimumAbsoluteDrop) ||
    result.minimumAbsoluteDrop < 1
  ) {
    throw new TypeError("minimumAbsoluteDrop must be a positive integer.");
  }
  if (
    !Number.isFinite(result.standardDeviationMultiplier) ||
    result.standardDeviationMultiplier <= 0
  ) {
    throw new TypeError(
      "standardDeviationMultiplier must be a positive number.",
    );
  }

  return result;
}

function baseResult(currentObservation, baseline, limitations) {
  return {
    status: "insufficient_history",
    anomalyType: null,
    deviationCategory: null,
    currentEligibleReports: currentObservation.eligibleReceivedReports,
    historicalMean: baseline.meanEligibleReports ?? null,
    historicalMedian: baseline.medianEligibleReports ?? null,
    absoluteDifference:
      baseline.meanEligibleReports == null
        ? null
        : Math.abs(
            currentObservation.eligibleReceivedReports -
              baseline.meanEligibleReports,
          ),
    percentageDeviation:
      baseline.meanEligibleReports > 0
        ? ((currentObservation.eligibleReceivedReports -
            baseline.meanEligibleReports) /
            baseline.meanEligibleReports) *
          100
        : null,
    historicalObservationCount: baseline.validHistoricalPeriods,
    explanation: "",
    possibleExplanations: [],
    unknowns: [
      "The cause of any reporting deviation is unknown.",
      "This calculation does not determine disease incidence or whether reports were prevented.",
    ],
    limitations,
    evidence: {
      observedFacts: {
        sourceCode: currentObservation.sourceCode,
        periodStart: currentObservation.periodStart,
        periodEnd: currentObservation.periodEnd,
        expectedReports: currentObservation.expectedReports,
        eligibleReceivedReports: currentObservation.eligibleReceivedReports,
        status: currentObservation.status,
        channelAvailability: currentObservation.channelAvailability || "unknown",
      },
      calculatedFindings: {
        historicalMean: baseline.meanEligibleReports ?? null,
        historicalMedian: baseline.medianEligibleReports ?? null,
        historicalPopulationStandardDeviation:
          baseline.populationStandardDeviation ?? null,
      },
    },
  };
}

function detectReportingAnomaly({
  currentObservation,
  baseline,
  channelAvailability,
  thresholds: thresholdOverrides = {},
}) {
  if (!currentObservation || typeof currentObservation !== "object") {
    throw new TypeError("currentObservation must be an object.");
  }
  if (!baseline || typeof baseline !== "object") {
    throw new TypeError("baseline must be an object.");
  }

  const thresholds = validateThresholds(thresholdOverrides);
  validateCount(
    currentObservation.eligibleReceivedReports,
    "currentObservation.eligibleReceivedReports",
  );
  validateCount(currentObservation.expectedReports, "currentObservation.expectedReports");
  if (currentObservation.expectedReports < 1) {
    throw new TypeError("currentObservation.expectedReports must be positive.");
  }

  if (!["daily", "weekly"].includes(currentObservation.frequency)) {
    throw new TypeError("currentObservation.frequency must be daily or weekly.");
  }
  if (
    typeof currentObservation.sourceCode !== "string" ||
    !currentObservation.sourceCode
  ) {
    throw new TypeError("currentObservation.sourceCode is required.");
  }
  if (!currentObservation.periodStart || !currentObservation.periodEnd) {
    throw new TypeError("Current period start and end are required.");
  }
  const periodStart = new Date(currentObservation.periodStart);
  const periodEnd = new Date(currentObservation.periodEnd);
  if (
    Number.isNaN(periodStart.getTime()) ||
    Number.isNaN(periodEnd.getTime()) ||
    periodEnd <= periodStart
  ) {
    throw new TypeError("Current period boundaries must be valid and ordered.");
  }
  if (
    ![
      "in_progress",
      "complete",
      "incomplete",
      "reporting_gap",
      "channel_unavailable",
      "incomplete_channel_unavailable",
      "inactive",
      "not_applicable",
    ].includes(currentObservation.status)
  ) {
    throw new TypeError("Current period status is invalid.");
  }
  if (
    channelAvailability !== undefined &&
    !["unknown", "available", "unavailable"].includes(channelAvailability)
  ) {
    throw new TypeError("channelAvailability is invalid.");
  }

  const limitations = [
    "This result describes reporting activity only; it does not establish a change in disease incidence or its cause.",
  ];
  const result = baseResult(currentObservation, baseline, limitations);
  const explicitlyUnavailable =
    channelAvailability === "unavailable" ||
    currentObservation.status === "channel_unavailable" ||
    currentObservation.status === "incomplete_channel_unavailable";

  if (currentObservation.status === "in_progress") {
    return {
      ...result,
      status: "in_progress",
      explanation: "The reporting period has not reached its deadline.",
    };
  }
  if (currentObservation.status === "inactive") {
    return {
      ...result,
      status: "inactive",
      explanation: "The reporting source is inactive for this period.",
    };
  }
  if (currentObservation.status === "not_applicable") {
    return {
      ...result,
      status: "not_applicable",
      explanation: "The reporting source is not valid for this period.",
    };
  }
  if (explicitlyUnavailable) {
    return {
      ...result,
      status: "channel_unavailable",
      explanation:
        "The reporting channel is explicitly known to be unavailable; this is not inferred from the report count.",
    };
  }

  // Trust must be attested by a server-controlled caller, never inferred here.
  if (currentObservation.isTrusted !== true) {
    return {
      ...result,
      status: "untrusted_observation",
      explanation:
        "The current observation lacks a server-controlled trust decision and was not compared with the baseline.",
    };
  }

  if (
    baseline.status !== "ready" ||
    baseline.sourceCode !== currentObservation.sourceCode ||
    baseline.frequency !== currentObservation.frequency ||
    baseline.validHistoricalPeriods < thresholds.minimumHistoricalPeriods
  ) {
    return {
      ...result,
      status: "insufficient_history",
      explanation:
        "There are not enough valid, trusted, completed historical periods of the same frequency and source to make a comparison.",
    };
  }

  const historicalMean = baseline.meanEligibleReports;
  const historicalMedian = baseline.medianEligibleReports;
  const standardDeviation = baseline.populationStandardDeviation;
  if (
    !Number.isFinite(historicalMean) ||
    historicalMean < 0 ||
    !Number.isFinite(historicalMedian) ||
    historicalMedian < 0 ||
    !Number.isFinite(standardDeviation) ||
    standardDeviation < 0
  ) {
    throw new TypeError("baseline statistics are invalid.");
  }

  const currentCount = currentObservation.eligibleReceivedReports;
  const drop = historicalMean - currentCount;
  const percentageDrop =
    historicalMean > 0 ? drop / historicalMean : null;
  const materialAbsoluteDrop =
    drop >= thresholds.minimumAbsoluteDrop;
  const deviationBeyondSpread =
    drop >
    thresholds.standardDeviationMultiplier * standardDeviation &&
    materialAbsoluteDrop;
  const unusuallyLow =
    historicalMean > 0 &&
    currentCount / historicalMean <= thresholds.unusuallyLowRatio &&
    materialAbsoluteDrop;
  const suddenDrop =
    historicalMean > 0 &&
    percentageDrop >= 1 - thresholds.suddenDropRatio &&
    materialAbsoluteDrop;

  result.historicalMean = historicalMean;
  result.historicalMedian = historicalMedian;
  result.absoluteDifference = Math.abs(currentCount - historicalMean);
  result.percentageDeviation =
    historicalMean > 0
      ? ((currentCount - historicalMean) / historicalMean) * 100
      : null;
  result.historicalObservationCount = baseline.validHistoricalPeriods;
  result.evidence.calculatedFindings.currentMinusHistoricalMean =
    currentCount - historicalMean;
  result.evidence.calculatedFindings.historicalMinimum =
    baseline.minimumEligibleReports;
  result.evidence.calculatedFindings.historicalMaximum =
    baseline.maximumEligibleReports;
  result.evidence.calculatedFindings.absoluteDifference =
    result.absoluteDifference;
  result.evidence.calculatedFindings.percentageDeviation =
    result.percentageDeviation;

  if (currentCount === 0 && historicalMean > 0) {
    return {
      ...result,
      status: "anomaly",
      anomalyType: "zero_report_period",
      deviationCategory: "complete_drop",
      explanation:
        "No eligible reports were recorded in this completed period despite a non-zero historical pattern. Reporting activity is substantially below the established historical pattern; the reason has not been established.",
    };
  }
  if (suddenDrop) {
    return {
      ...result,
      status: "anomaly",
      anomalyType: "sudden_reporting_drop",
      deviationCategory: "large_drop",
      explanation:
        "Reporting activity is substantially below the established historical pattern; the reason has not been established.",
    };
  }
  if (unusuallyLow || deviationBeyondSpread) {
    return {
      ...result,
      status: "anomaly",
      anomalyType: "unusually_low_reporting",
      deviationCategory: "material_drop",
      explanation:
        "Reporting activity is below the established historical pattern; the reason for this deviation has not been established.",
    };
  }
  if (historicalMean === 0 && currentCount === 0) {
    return {
      ...result,
      status: "normal_variation",
      explanation:
        "Current and historical eligible report counts are both zero; no decline from a non-zero baseline is present.",
    };
  }
  if (historicalMean === 0) {
    return {
      ...result,
      status: "normal_variation",
      explanation:
        "The historical mean is zero, so percentage deviation is undefined; lower-reporting anomaly rules were not applied.",
    };
  }

  return {
    ...result,
    status: "normal_variation",
    explanation:
      "Current reporting is within the configured normal variation thresholds.",
  };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  detectReportingAnomaly,
};
