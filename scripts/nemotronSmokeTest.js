require("dotenv").config({ quiet: true });

const {
  createNemotronInterpreter,
} = require("../services/ai/nemotronInterpreter");

const evidenceSnapshot = {
  schemaVersion: "null-signal-evidence-package.v1",
  metadata: {
    evaluatedAt: "2026-10-30T12:00:00.000Z",
    sourceCode: "SYNTHETIC-SMOKE-TEST",
    sourceName: "Synthetic only",
    frequency: "daily",
    expectedReportsPerPeriod: 10,
    period: {
      start: "2026-10-29T00:00:00.000Z",
      end: "2026-10-30T00:00:00.000Z",
    },
  },
  observedFacts: {
    expectedReports: 10,
    eligibleReceivedReports: 0,
    periodStatus: "reporting_gap",
    channelAvailability: "unknown",
    historicalObservationCount: 2,
  },
  calculatedFindings: {
    completeness: {
      status: "reporting_gap",
      percent: 0,
    },
    historicalBaseline: {
      status: "insufficient_history",
      minimumObservations: 5,
      meanEligibleReports: null,
      medianEligibleReports: null,
      minimumEligibleReports: null,
      maximumEligibleReports: null,
      populationStandardDeviation: null,
      expectedReportsPerPeriod: null,
    },
    anomaly: {
      status: "insufficient_history",
      type: null,
      deviationCategory: null,
      absoluteDifference: null,
      percentageDeviation: null,
      explanation: "This synthetic free text must not be sent.",
    },
  },
  evidence: {
    rawReports: [
      {
        name: "Synthetic patient",
        symptoms: "Synthetic symptom text must not be sent.",
      },
    ],
  },
};

async function main() {
  const interpreter = createNemotronInterpreter();
  const prepared = interpreter.prepareInterpretation(
    evidenceSnapshot,
    evidenceSnapshot.schemaVersion,
  );
  const result = await interpreter.interpretPreparedEvidence(prepared);

  console.log(
    JSON.stringify({
      outcome: "validated",
      provider: result.provider,
      model: result.model,
      promptVersion: result.promptVersion,
      schemaVersion: result.schemaVersion,
      evidenceVersion: result.evidenceVersion,
      evidenceHash: result.evidenceHash,
      validationStatus: result.validationStatus,
      findingType: result.interpretation.findingType,
      evidenceStrength: result.interpretation.evidenceStrength,
      citedFactCount:
        result.interpretation.observedFacts.length +
        result.interpretation.supportingEvidence.length,
      usage: result.usage,
      requestId: result.providerRequestId,
      latencyMs: result.latencyMs,
    }),
  );
}

main().catch((error) => {
  const code =
    typeof error?.code === "string" &&
    /^[A-Z0-9_]{1,80}$/.test(error.code)
      ? error.code
      : "SMOKE_TEST_FAILED";
  console.error(JSON.stringify({
    outcome: "failed",
    code,
    message: "Nemotron synthetic smoke test failed.",
  }));
  process.exitCode = 1;
});
