const mongoose = require("mongoose");

const aiInterpretationAuditSchema = new mongoose.Schema(
  {
    attemptId: {
      type: String,
      required: true,
      immutable: true,
      match: /^[a-f0-9-]{36}$/,
    },
    investigatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Investigator",
      required: true,
      immutable: true,
    },
    sourceCode: {
      type: String,
      required: true,
      maxlength: 80,
      immutable: true,
    },
    investigationId: {
      type: String,
      required: true,
      immutable: true,
      match: /^inv_[a-f0-9]{32}$/,
    },
    stage: {
      type: String,
      enum: ["started", "succeeded", "failed"],
      required: true,
      immutable: true,
    },
    provider: {
      type: String,
      enum: ["nebius"],
      default: "nebius",
      immutable: true,
    },
    requestedAt: {
      type: Date,
      required: true,
      immutable: true,
    },
    model: {
      type: String,
      maxlength: 200,
      immutable: true,
    },
    evidenceHash: {
      type: String,
      match: /^[a-f0-9]{64}$/,
      immutable: true,
    },
    providerRequestId: {
      type: String,
      maxlength: 200,
      immutable: true,
    },
    errorCode: {
      type: String,
      maxlength: 80,
      immutable: true,
    },
    usage: {
      promptTokens: { type: Number, min: 0 },
      completionTokens: { type: Number, min: 0 },
      totalTokens: { type: Number, min: 0 },
    },
    latencyMs: { type: Number, min: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, strict: "throw" },
);

aiInterpretationAuditSchema.index(
  { attemptId: 1, stage: 1 },
  { unique: true },
);
aiInterpretationAuditSchema.index({ investigationId: 1, requestedAt: -1 });
aiInterpretationAuditSchema.index({ investigatorId: 1, requestedAt: -1 });
for (const operation of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "findOneAndReplace",
  "update",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
]) {
  aiInterpretationAuditSchema.pre(operation, function preventAuditMutation() {
    throw new Error("AI interpretation audit history is append-only.");
  });
}
aiInterpretationAuditSchema.pre("save", function preventAuditUpdate() {
  if (!this.isNew) {
    throw new Error("AI interpretation audit history is append-only.");
  }
});

module.exports =
  mongoose.models.AIInterpretationAudit ||
  mongoose.model("AIInterpretationAudit", aiInterpretationAuditSchema);
