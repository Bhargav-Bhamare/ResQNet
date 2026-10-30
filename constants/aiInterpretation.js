const EVIDENCE_VERSION = "null-signal-evidence-package.v1";
const SANITIZED_EVIDENCE_VERSION = "null-signal-ai-evidence.v1";
const PROMPT_VERSION = "1.0";
const SCHEMA_VERSION = "1.0";

const FINDING_TYPES = Object.freeze([
  "reporting_discontinuity",
  "possible_reporting_change",
  "channel_availability_concern",
  "insufficient_evidence",
  "no_significant_discontinuity",
  "other",
]);
const EVIDENCE_STRENGTHS = Object.freeze([
  "insufficient",
  "limited",
  "moderate",
  "strong",
]);
const FOLLOW_UP_PRIORITIES = Object.freeze(["low", "medium", "high"]);
const FACT_REFERENCES = Object.freeze({
  expected_reports: "observedFacts.expectedReports",
  eligible_received_reports: "observedFacts.eligibleReceivedReports",
  period_status: "observedFacts.periodStatus",
  channel_availability: "observedFacts.channelAvailability",
  historical_observation_count: "observedFacts.historicalObservationCount",
  completeness_status: "calculatedFindings.completeness.status",
  completeness_percent: "calculatedFindings.completeness.percent",
  baseline_status: "calculatedFindings.historicalBaseline.status",
  baseline_minimum_observations:
    "calculatedFindings.historicalBaseline.minimumObservations",
  historical_periods:
    "calculatedFindings.historicalBaseline.validHistoricalPeriods",
  baseline_mean: "calculatedFindings.historicalBaseline.meanEligibleReports",
  baseline_median: "calculatedFindings.historicalBaseline.medianEligibleReports",
  baseline_minimum:
    "calculatedFindings.historicalBaseline.minimumEligibleReports",
  baseline_maximum:
    "calculatedFindings.historicalBaseline.maximumEligibleReports",
  baseline_standard_deviation:
    "calculatedFindings.historicalBaseline.populationStandardDeviation",
  baseline_expected_reports:
    "calculatedFindings.historicalBaseline.expectedReportsPerPeriod",
  anomaly_status: "calculatedFindings.anomaly.status",
  anomaly_type: "calculatedFindings.anomaly.type",
  deviation_category: "calculatedFindings.anomaly.deviationCategory",
  absolute_difference: "calculatedFindings.anomaly.absoluteDifference",
  percentage_deviation: "calculatedFindings.anomaly.percentageDeviation",
});

module.exports = {
  EVIDENCE_STRENGTHS,
  EVIDENCE_VERSION,
  FACT_REFERENCES,
  FINDING_TYPES,
  FOLLOW_UP_PRIORITIES,
  PROMPT_VERSION,
  SANITIZED_EVIDENCE_VERSION,
  SCHEMA_VERSION,
};
