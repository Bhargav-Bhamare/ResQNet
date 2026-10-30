const mongoose = require("mongoose");

const coordinatesSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["Point"],
      required: true,
    },
    coordinates: {
      type: [Number],
      default: undefined,
      required: true,
      validate: {
        validator(coordinates) {
          return (
            coordinates.length === 2 &&
            coordinates[0] >= -180 &&
            coordinates[0] <= 180 &&
            coordinates[1] >= -90 &&
            coordinates[1] <= 90
          );
        },
        message:
          "Coordinates must be [longitude, latitude] within valid geographic ranges.",
      },
    },
  },
  { _id: false },
);

const locationSchema = new mongoose.Schema(
  {
    region: { type: String, trim: true, maxlength: 120 },
    district: { type: String, trim: true, maxlength: 120 },
    state: { type: String, trim: true, maxlength: 120 },
    country: { type: String, trim: true, maxlength: 100 },
    coordinates: { type: coordinatesSchema, default: undefined },
  },
  { _id: false },
);

const reportSchema = new mongoose.Schema(
  {
    reportType: {
      type: String,
      enum: ["symptom", "disaster"],
      required: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 2000,
    },
    symptoms: {
      type: [
        {
          type: String,
          trim: true,
          minlength: 1,
          maxlength: 100,
        },
      ],
      default: [],
      validate: {
        validator(symptoms) {
          return symptoms.length <= 20;
        },
        message: "A report can contain no more than 20 symptoms.",
      },
    },
    severity: {
      type: String,
      enum: [
        "low",
        "mild",
        "medium",
        "moderate",
        "high",
        "severe",
        "critical",
      ],
    },
    location: {
      type: locationSchema,
      default: undefined,
    },
    sourceChannel: {
      type: String,
      enum: ["web", "sms", "official_api"],
      default: "web",
    },
    sourceId: {
      type: String,
      trim: true,
      maxlength: 128,
    },
    reportedAt: Date,
    submittedAt: {
      type: Date,
      default: Date.now,
    },
    verificationStatus: {
      type: String,
      enum: ["pending", "verified", "rejected"],
      default: "pending",
    },
  },
  { timestamps: true },
);

reportSchema.index({ reportType: 1, submittedAt: 1 });
reportSchema.index({ sourceId: 1, sourceChannel: 1, submittedAt: 1 });

module.exports =
  mongoose.models.Report || mongoose.model("Report", reportSchema);
