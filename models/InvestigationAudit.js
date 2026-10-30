const mongoose = require("mongoose");

const investigationAuditSchema = new mongoose.Schema(
  {
    investigatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Investigator",
      required: true,
      index: true,
    },
    sourceCode: {
      type: String,
      required: true,
      maxlength: 80,
    },
    requestedAt: {
      type: Date,
      required: true,
    },
    evaluatedAt: Date,
    historyStart: Date,
    outcome: {
      type: String,
      enum: ["success", "failure"],
      required: true,
    },
    errorCode: {
      type: String,
      maxlength: 80,
    },
    requestId: {
      type: String,
      maxlength: 80,
    },
  },
  { timestamps: true },
);

investigationAuditSchema.index({ sourceCode: 1, requestedAt: -1 });
investigationAuditSchema.index({ investigatorId: 1, requestedAt: -1 });

module.exports =
  mongoose.models.InvestigationAudit ||
  mongoose.model("InvestigationAudit", investigationAuditSchema);
