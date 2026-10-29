const express = require("express");
const mongoose = require("mongoose");
const ReportingSource = require("../models/ReportingSource");
const calculateReportingCompleteness = require("../services/reportingCompleteness");

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
} = {}) {
  const router = express.Router();

  router.get("/", async (req, res) => {
    const evaluatedAt = new Date();

    try {
      const sources = await ReportingSourceModel.find({}).lean();
      const results = calculate({
        sources,
        reports: [],
        trustedReportIds: new Set(),
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
          "No server-controlled source-verification mechanism is configured; public submissions are not counted as reports from configured sources.",
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
