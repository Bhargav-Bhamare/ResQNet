const mongoose = require("mongoose");
const {
  EVIDENCE_STRENGTHS,
  FINDING_TYPES,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  FACT_REFERENCES,
} = require("../constants/aiInterpretation");

const factSchema = new mongoose.Schema(
  {
    factCode: {
      type: String,
      enum: Object.keys(FACT_REFERENCES),
      required: true,
    },
    value: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    evidenceRefs: {
      type: [String],
      required: true,
      validate: {
        validator: (references) =>
          references.length > 0 &&
          references.length <= 4 &&
          new Set(references).size === references.length,
        message: "Evidence references must be unique and bounded.",
      },
    },
  },
  { _id: false, strict: "throw" },
);

const followUpSchema = new mongoose.Schema(
  {
    question: { type: String, required: true, maxlength: 300 },
    reason: { type: String, required: true, maxlength: 300 },
    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      required: true,
    },
  },
  { _id: false, strict: "throw" },
);

const interpretationSchema = new mongoose.Schema(
  {
    headline: { type: String, required: true, maxlength: 160 },
    executiveSummary: { type: String, required: true, maxlength: 1000 },
    findingType: {
      type: String,
      enum: [...FINDING_TYPES],
      required: true,
    },
    evidenceStrength: {
      type: String,
      enum: [...EVIDENCE_STRENGTHS],
      required: true,
    },
    explanation: { type: String, required: true, maxlength: 1500 },
    observedFacts: {
      type: [factSchema],
      required: true,
      validate: {
        validator: (facts) => facts.length > 0 && facts.length <= 8,
        message: "Observed facts must contain between 1 and 8 entries.",
      },
    },
    supportingEvidence: {
      type: [factSchema],
      required: true,
      validate: {
        validator: (facts) => facts.length <= 8,
        message: "Supporting evidence is limited to 8 entries.",
      },
    },
    unknowns: [{ type: String, maxlength: 300 }],
    alternativeExplanations: [{ type: String, maxlength: 300 }],
    recommendedFollowUps: {
      type: [followUpSchema],
      validate: {
        validator: (items) => items.length <= 5,
        message: "Follow-up questions are limited to 5 entries.",
      },
    },
    limitations: [{ type: String, maxlength: 300 }],
    interpretationBoundary: { type: String, required: true, maxlength: 500 },
  },
  { _id: false, strict: "throw" },
);

const nullableTokenCount = {
  type: Number,
  default: null,
  min: 0,
  validate: {
    validator: (value) => value === null || Number.isSafeInteger(value),
    message: "Token usage must be a non-negative integer or null.",
  },
};

const usageSchema = new mongoose.Schema(
  {
    promptTokens: nullableTokenCount,
    completionTokens: nullableTokenCount,
    totalTokens: nullableTokenCount,
  },
  { _id: false, strict: "throw" },
);

const aiInterpretationSchema = new mongoose.Schema(
  {
    investigationId: {
      type: String,
      required: true,
      immutable: true,
      match: /^inv_[a-f0-9]{32}$/,
    },
    sourceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReportingSource",
      required: true,
      immutable: true,
    },
    sourceCode: {
      type: String,
      required: true,
      maxlength: 80,
      immutable: true,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Investigator",
      required: true,
      immutable: true,
    },
    provider: {
      type: String,
      enum: ["nebius"],
      required: true,
      immutable: true,
    },
    model: {
      type: String,
      required: true,
      maxlength: 200,
      immutable: true,
    },
    promptVersion: {
      type: String,
      required: true,
      enum: [PROMPT_VERSION],
      immutable: true,
    },
    schemaVersion: {
      type: String,
      required: true,
      enum: [SCHEMA_VERSION],
      immutable: true,
    },
    evidenceVersion: {
      type: String,
      required: true,
      maxlength: 80,
      immutable: true,
    },
    evidenceHash: {
      type: String,
      required: true,
      match: /^[a-f0-9]{64}$/,
      immutable: true,
    },
    interpretation: {
      type: interpretationSchema,
      required: true,
      immutable: true,
    },
    validationStatus: {
      type: String,
      enum: ["validated"],
      required: true,
      immutable: true,
    },
    validationWarnings: {
      type: [String],
      default: [],
      immutable: true,
    },
    providerRequestId: {
      type: String,
      maxlength: 200,
      default: null,
      immutable: true,
    },
    usage: {
      type: usageSchema,
      required: true,
      immutable: true,
    },
    latencyMs: {
      type: Number,
      min: 0,
      default: null,
      validate: {
        validator: (value) => value === null || Number.isSafeInteger(value),
        message: "Latency must be a non-negative integer or null.",
      },
      immutable: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    strict: "throw",
  },
);

aiInterpretationSchema.index({ investigationId: 1, createdAt: -1, _id: -1 });
aiInterpretationSchema.index({ sourceCode: 1, createdAt: -1 });
aiInterpretationSchema.index({ investigationId: 1, evidenceHash: 1, model: 1 });
aiInterpretationSchema.pre("save", function preventInterpretationUpdates() {
  if (!this.isNew) {
    throw new Error("AI interpretation history is append-only.");
  }
});
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
  aiInterpretationSchema.pre(operation, function preventInterpretationMutation() {
    throw new Error("AI interpretation history is append-only.");
  });
}
aiInterpretationSchema.pre(
  "deleteOne",
  { document: true, query: false },
  function preventDocumentInterpretationDeletion() {
    throw new Error("AI interpretation history is append-only.");
  },
);

module.exports =
  mongoose.models.AIInterpretation ||
  mongoose.model("AIInterpretation", aiInterpretationSchema);
