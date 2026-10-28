
function evaluateEvidence(input) {
  const {
    area,
    expectedReports,
    receivedReports,
    channelStatus,
  } = input;

  const missingReports = Math.max(
    0,
    expectedReports - receivedReports
  );

  const result = {
    area,
    expectedReports,
    receivedReports,
    channelStatus,
    missingReports,
    status: "normal",
    severity: "low",
    findings: [],
    recommendedActions: [],
  };

  // Expected reports have arrived.
  if (missingReports === 0) {
    result.findings.push(
      "The expected number of reports has been received."
    );

    if (receivedReports > expectedReports) {
      result.findings.push(
        "Report volume exceeds the expected count."
      );
    }

    if (
      channelStatus === "failed" ||
      channelStatus === "degraded"
    ) {
      result.findings.push(
        "The reporting channel has a reported technical issue."
      );

      result.recommendedActions.push(
        "Check channel reliability before relying on future reports."
      );
    }

    return result;
  }

  // Reports are missing and the channel has failed.
  if (channelStatus === "failed") {
    result.status = "monitoring_failure";
    result.severity = "high";

    result.findings.push(
      `${missingReports} expected report(s) are missing.`
    );
    result.findings.push(
      "The reporting channel is marked as failed."
    );

    result.recommendedActions.push(
      "Restore the reporting channel and verify connectivity."
    );
    result.recommendedActions.push(
      "Contact local reporting staff through an independent channel."
    );

    return result;
  }

  // Reports are missing, but channel health is unknown.
  if (channelStatus === "unknown") {
    result.status = "insufficient_evidence";
    result.severity = "medium";

    result.findings.push(
      `${missingReports} expected report(s) are missing.`
    );
    result.findings.push(
      "The reporting channel health has not been verified."
    );

    result.recommendedActions.push(
      "Check the reporting channel and its last successful transmission."
    );
    result.recommendedActions.push(
      "Seek independent confirmation from local health workers."
    );

    return result;
  }

  // Reports are missing and the channel is degraded or healthy.
  result.status = "evidence_gap";
  result.severity =
    channelStatus === "degraded" ? "high" : "medium";

  result.findings.push(
    `${missingReports} expected report(s) are missing.`
  );

  if (channelStatus === "degraded") {
    result.findings.push(
      "The reporting channel is degraded, which may explain the missing data."
    );
    result.recommendedActions.push(
      "Investigate channel delays, failed transmissions, and connectivity."
    );
  } else {
    result.findings.push(
      "The channel is marked healthy, but expected reports are missing."
    );
    result.recommendedActions.push(
      "Verify whether reports were submitted but not recorded."
    );
  }

  result.recommendedActions.push(
    "Request confirmation from an independent local source."
  );

  return result;
}

module.exports = evaluateEvidence;
