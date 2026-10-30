
const mongoose = require("mongoose");

const investigationSchema = new mongoose.Schema(
  {
    area: {
      type: String,
      required: true,
      trim: true,
    },
    expectedReports: {
      type: Number,
      required: true,
      min: 0,
    },
    receivedReports: {
      type: Number,
      required: true,
      min: 0,
    },
    channelStatus: {
      type: String,
      enum: ["healthy", "degraded", "failed", "unknown"],
      required: true,
    },
    status: {
      type: String,
      enum: [
        "normal",
        "evidence_gap",
        "monitoring_failure",
        "insufficient_evidence",
      ],
      required: true,
    },
    severity: {
      type: String,
      enum: ["low", "medium", "high"],
      required: true,
    },
    missingReports: {
      type: Number,
      required: true,
      min: 0,
    },
    findings: {
      type: [String],
      default: [],
    },
    recommendedActions: {
      type: [String],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.Investigation ||
  mongoose.model("Investigation", investigationSchema);
