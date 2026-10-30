const express = require("express");
const mongoose = require("mongoose");
const ReportingSource = require("../models/ReportingSource");
const calculateReportingCompleteness = require("../services/reportingCompleteness");
const { createSourceAttributionService } = require("../services/sourceAttribution");

function isDatabaseUnavailable(error) {
  return (
    mongoose.connection.readyState !== 1 ||
    [
      "MongoNetworkError",
      "MongoServerSelectionError",
      "MongoNotConnectedError",
    ].includes(error?.name) ||
    /buffering timed out/i.test(error?.message || "")
  );
}

function createReportingCompletenessRouter({
  ReportingSourceModel = ReportingSource,
  calculate = calculateReportingCompleteness,
  getTrustedReports,
  getVisibleSources = () => ReportingSourceModel.find({}).lean(),
} = {}) {
  const router = express.Router();
  const loadTrustedReports =
    getTrustedReports ||
    createSourceAttributionService({ ReportingSourceModel }).getTrustedReports;

  router.get("/", async (req, res) => {
    const evaluatedAt = new Date();

    try {
      const sources = await getVisibleSources(req);
      const sourceReports = await Promise.all(
        sources.map((source) =>
          loadTrustedReports({ sourceCode: String(source.sourceCode) }),
        ),
      );
      const reports = sourceReports.flatMap((result) => result.reports);
      const trustedReportIds = new Set(
        sourceReports.flatMap((result) => [...result.trustedReportIds]),
      );
      const results = calculate({
        sources,
        reports,
        trustedReportIds,
        now: evaluatedAt,
      });

      return res.status(200).json({
        evaluatedAt,
        count: results.length,
        sources: results.map((result) => ({
          sourceCode: result.sourceCode,
          status: result.status,
          period: result.period,
          expectedReports: result.expectedReports,
          eligibleReceivedReports: result.receivedReports,
          completenessPercent: result.completenessPercent,
          channelAvailability: result.channelAvailability,
        })),
        limitations: [
          "Only reports with successful server-controlled source-attribution audit records are counted; ordinary public submissions are not attributed to configured sources.",
          "Authenticated source ingestion and administrator-authorized credential provisioning are not exposed as HTTP endpoints.",
          "Channel availability is unknown unless separately established; a reporting gap is not proof of an outbreak, suppression, fraud, or misconduct.",
        ],
      });
    } catch (error) {
      if (isDatabaseUnavailable(error)) {
        return res.status(503).json({
          error: "Reporting completeness is temporarily unavailable.",
        });
      }

      console.error(
        `Reporting completeness evaluation failed (${error?.name || "UnknownError"}).`,
      );
      return res.status(500).json({
        error: "Unable to evaluate reporting completeness.",
      });
    }
  });

  return router;
}

module.exports = createReportingCompletenessRouter;
