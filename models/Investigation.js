
const mongoose = require("mongoose");

const investigationSchema = new mongoose.Schema(
  {
    recordType: {
      type: String,
      enum: ["legacy", "evidence_review"],
      default: "legacy",
      immutable: true,
    },
    investigationId: {
      type: String,
      required() {
        return this.recordType === "evidence_review";
      },
      immutable: true,
      match: /^inv_[a-f0-9]{32}$/,
    },
    sourceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReportingSource",
      required() {
        return this.recordType === "evidence_review";
      },
      immutable: true,
    },
    sourceCode: {
      type: String,
      trim: true,
      maxlength: 80,
      required() {
        return this.recordType === "evidence_review";
      },
      immutable: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Investigator",
      required() {
        return this.recordType === "evidence_review";
      },
      immutable: true,
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Investigator",
    },
    evaluatedAt: {
      type: Date,
      required() {
        return this.recordType === "evidence_review";
      },
      immutable: true,
    },
    periods: {
      type: Number,
      required() {
        return this.recordType === "evidence_review";
      },
      min: 1,
      max: 365,
      validate: {
        validator: Number.isInteger,
        message: "periods must be a positive integer.",
      },
      immutable: true,
    },
    evidenceSnapshot: {
      type: mongoose.Schema.Types.Mixed,
      immutable: true,
      required() {
        return this.recordType === "evidence_review";
      },
    },
    evidenceVersion: {
      type: String,
      maxlength: 80,
      immutable: true,
      required() {
        return this.recordType === "evidence_review";
      },
    },
    area: {
      type: String,
      required() {
        return this.recordType === "legacy";
      },
      trim: true,
    },
    expectedReports: {
      type: Number,
      required() {
        return this.recordType === "legacy";
      },
      min: 0,
    },
    receivedReports: {
      type: Number,
      required() {
        return this.recordType === "legacy";
      },
      min: 0,
    },
    channelStatus: {
      type: String,
      enum: ["healthy", "degraded", "failed", "unknown"],
      required() {
        return this.recordType === "legacy";
      },
    },
    status: {
      type: String,
      enum: [
        "generated",
        "under_review",
        "requires_more_information",
        "reviewed",
        "closed",
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
      required() {
        return this.recordType === "legacy";
      },
    },
    missingReports: {
      type: Number,
      required() {
        return this.recordType === "legacy";
      },
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
  { timestamps: true, optimisticConcurrency: true },
);

investigationSchema.path("status").required(function statusRequired() {
  return this.recordType === "legacy" || this.recordType === "evidence_review";
});
investigationSchema.path("status").validate(function validRecordStatus(status) {
  return [
    "generated",
    "under_review",
    "requires_more_information",
    "reviewed",
    "closed",
    "normal",
    "evidence_gap",
    "monitoring_failure",
    "insufficient_evidence",
  ].includes(status);
});
investigationSchema.index(
  { investigationId: 1 },
  {
    unique: true,
    partialFilterExpression: { investigationId: { $type: "string" } },
  },
);
investigationSchema.index({ sourceCode: 1, createdAt: -1 });
investigationSchema.index({ sourceCode: 1, status: 1, createdAt: -1 });
investigationSchema.index({ status: 1, createdAt: -1 });
investigationSchema.index({ createdBy: 1, createdAt: -1 });
investigationSchema.index({ assignedTo: 1, createdAt: -1 });

module.exports =
  mongoose.models.Investigation ||
  mongoose.model("Investigation", investigationSchema);
