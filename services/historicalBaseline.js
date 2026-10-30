const COMPLETED_STATUSES = new Set([
  "complete",
  "incomplete",
  "reporting_gap",
]);
const UNAVAILABLE_STATUSES = new Set([
  "channel_unavailable",
  "incomplete_channel_unavailable",
]);
const NON_HISTORICAL_STATUSES = new Set([
  "in_progress",
  "inactive",
  "not_applicable",
]);

function toDate(value, fieldName) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${fieldName} must be a valid date.`);
  }
  return date;
}

function validateObservation(observation, index) {
  if (!observation || typeof observation !== "object") {
    throw new TypeError(`Observation ${index} must be an object.`);
  }

  if (!["daily", "weekly"].includes(observation.frequency)) {
    throw new TypeError(`Observation ${index} has an invalid frequency.`);
  }

  if (
    !COMPLETED_STATUSES.has(observation.status) &&
    !UNAVAILABLE_STATUSES.has(observation.status) &&
    !NON_HISTORICAL_STATUSES.has(observation.status)
  ) {
    throw new TypeError(`Observation ${index} has an invalid period status.`);
  }

  const periodStart = toDate(observation.periodStart, `Observation ${index} periodStart`);
  const periodEnd = toDate(observation.periodEnd, `Observation ${index} periodEnd`);
  if (periodEnd <= periodStart) {
    throw new TypeError(`Observation ${index} periodEnd must follow periodStart.`);
  }

  if (
    !Number.isInteger(observation.expectedReports) ||
    observation.expectedReports <= 0
  ) {
    throw new TypeError(
      `Observation ${index} expectedReports must be a positive integer.`,
    );
  }

  if (
    !Number.isInteger(observation.eligibleReceivedReports) ||
    observation.eligibleReceivedReports < 0
  ) {
    throw new TypeError(
      `Observation ${index} eligibleReceivedReports must be a non-negative integer.`,
    );
  }

  if (
    observation.channelAvailability !== undefined &&
    !["unknown", "available", "unavailable"].includes(
      observation.channelAvailability,
    )
  ) {
    throw new TypeError(
      `Observation ${index} has an invalid channelAvailability.`,
    );
  }

  return { periodStart, periodEnd };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function calculateHistoricalBaseline({
  sourceCode,
  frequency,
  observations,
  minimumObservations = 5,
  asOf = new Date(),
}) {
  if (typeof sourceCode !== "string" || !sourceCode.trim()) {
    throw new TypeError("sourceCode must be a non-empty string.");
  }
  if (!["daily", "weekly"].includes(frequency)) {
    throw new TypeError("frequency must be daily or weekly.");
  }
  if (!Array.isArray(observations)) {
    throw new TypeError("observations must be an array.");
  }
  if (!Number.isInteger(minimumObservations) || minimumObservations < 1) {
    throw new TypeError("minimumObservations must be a positive integer.");
  }

  const evaluationTime = toDate(asOf, "asOf");
  const excluded = {
    untrusted: 0,
    frequencyMismatch: 0,
    inProgress: 0,
    inactive: 0,
    notApplicable: 0,
    channelUnavailable: 0,
    future: 0,
  };
  const seenPeriods = new Set();
  const eligible = [];

  observations.forEach((observation, index) => {
    const { periodStart, periodEnd } = validateObservation(observation, index);
    if (observation.sourceCode !== sourceCode) {
      throw new TypeError(
        `Observation ${index} does not match sourceCode ${sourceCode}.`,
      );
    }

    const periodKey = `${periodStart.toISOString()}|${periodEnd.toISOString()}`;
    if (seenPeriods.has(periodKey)) {
      throw new TypeError(`Duplicate historical period at observation ${index}.`);
    }
    seenPeriods.add(periodKey);

    if (observation.isTrusted !== true) {
      excluded.untrusted += 1;
      return;
    }
    if (observation.frequency !== frequency) {
      excluded.frequencyMismatch += 1;
      return;
    }
    if (observation.status === "in_progress") {
      excluded.inProgress += 1;
      return;
    }
    if (observation.status === "inactive") {
      excluded.inactive += 1;
      return;
    }
    if (observation.status === "not_applicable") {
      excluded.notApplicable += 1;
      return;
    }
    if (
      UNAVAILABLE_STATUSES.has(observation.status) ||
      observation.channelAvailability === "unavailable"
    ) {
      excluded.channelUnavailable += 1;
      return;
    }
    if (
      !COMPLETED_STATUSES.has(observation.status) ||
      periodEnd > evaluationTime
    ) {
      excluded.future += 1;
      return;
    }

    eligible.push(observation);
  });

  const base = {
    sourceCode,
    frequency,
    status: "insufficient_history",
    minimumObservations,
    validHistoricalPeriods: eligible.length,
    excluded,
    meanEligibleReports: null,
    medianEligibleReports: null,
    minimumEligibleReports: null,
    maximumEligibleReports: null,
    populationStandardDeviation: null,
    expectedReportsPerPeriod: null,
  };

  if (eligible.length < minimumObservations) {
    return base;
  }

  const counts = eligible.map(
    (observation) => observation.eligibleReceivedReports,
  );
  const mean =
    counts.reduce((total, count) => total + count, 0) / counts.length;
  const variance =
    counts.reduce((total, count) => total + (count - mean) ** 2, 0) /
    counts.length;
  const expectedCounts = new Set(
    eligible.map((observation) => observation.expectedReports),
  );

  return {
    ...base,
    status: "ready",
    meanEligibleReports: mean,
    medianEligibleReports: median(counts),
    minimumEligibleReports: Math.min(...counts),
    maximumEligibleReports: Math.max(...counts),
    populationStandardDeviation: Math.sqrt(variance),
    expectedReportsPerPeriod:
      expectedCounts.size === 1 ? eligible[0].expectedReports : null,
  };
}

module.exports = calculateHistoricalBaseline;
