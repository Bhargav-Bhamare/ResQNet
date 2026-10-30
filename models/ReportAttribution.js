const mongoose = require("mongoose");

const reportAttributionSchema = new mongoose.Schema(
  {
    reportId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Report",
    },
    reportingSourceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReportingSource",
    },
    sourceCode: {
      type: String,
      trim: true,
      maxlength: 80,
    },
    method: {
      type: String,
      enum: ["source_api_key"],
      required: true,
    },
    outcome: {
      type: String,
      enum: ["accepted", "rejected"],
      required: true,
    },
    reason: {
      type: String,
      enum: [
        "source_credential_authenticated",
        "missing_credential",
        "invalid_credential",
        "credential_revoked",
        "credential_expired",
        "source_inactive",
        "source_not_yet_valid",
        "source_expired",
        "source_not_found",
        "attribution_fields_not_allowed",
        "invalid_report",
      ],
      required: true,
    },
    credentialId: {
      type: String,
      match: /^[a-f0-9]{24}$/,
    },
    sourceWasActive: Boolean,
    sourceWasWithinValidity: Boolean,
    attributedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  { timestamps: true },
);

reportAttributionSchema.index(
  { reportId: 1 },
  {
    unique: true,
    partialFilterExpression: { outcome: "accepted" },
  },
);
reportAttributionSchema.index({
  reportingSourceId: 1,
  outcome: 1,
  attributedAt: 1,
});

module.exports =
  mongoose.models.ReportAttribution ||
  mongoose.model("ReportAttribution", reportAttributionSchema);
