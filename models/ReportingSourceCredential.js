const mongoose = require("mongoose");

const reportingSourceCredentialSchema = new mongoose.Schema(
  {
    credentialId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      match: /^[a-f0-9]{24}$/,
    },
    reportingSourceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReportingSource",
      required: true,
      immutable: true,
      index: true,
    },
    secretHash: {
      type: String,
      required: true,
      select: false,
      match: /^[a-f0-9]{64}$/,
      immutable: true,
    },
    expiresAt: Date,
    revokedAt: Date,
  },
  { timestamps: true },
);

reportingSourceCredentialSchema.index({
  reportingSourceId: 1,
  revokedAt: 1,
  expiresAt: 1,
});

module.exports =
  mongoose.models.ReportingSourceCredential ||
  mongoose.model(
    "ReportingSourceCredential",
    reportingSourceCredentialSchema,
  );
