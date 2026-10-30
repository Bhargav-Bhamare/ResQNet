const mongoose = require("mongoose");

const geographicField = (maxlength) => ({
  type: String,
  trim: true,
  maxlength,
});

const reportingScheduleSchema = new mongoose.Schema(
  {
    frequency: {
      type: String,
      enum: ["daily", "weekly"],
      required: true,
    },
    expectedReportsPerPeriod: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: "expectedReportsPerPeriod must be a positive integer.",
      },
    },
    reportingTime: {
      type: String,
      trim: true,
      validate: {
        validator(reportingTime) {
          return /^([01]\d|2[0-3]):[0-5]\d$/.test(reportingTime);
        },
        message: "reportingTime must use 24-hour HH:mm format.",
      },
    },
    timezone: {
      type: String,
      trim: true,
      required: true,
      validate: {
        validator(timezone) {
          try {
            new Intl.DateTimeFormat("en-US", { timeZone: timezone });
            return true;
          } catch {
            return false;
          }
        },
        message: "timezone must be a valid IANA timezone identifier.",
      },
    },
  },
  { _id: false },
);

const reportingSourceSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150,
    },
    sourceCode: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
      unique: true,
    },
    sourceType: {
      type: String,
      required: true,
      enum: [
        "health_facility",
        "official_api",
        "community_network",
        "other",
      ],
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    region: geographicField(150),
    district: geographicField(150),
    state: geographicField(150),
    country: geographicField(100),
    reportingSchedule: {
      type: reportingScheduleSchema,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    validFrom: {
      type: Date,
      required: true,
    },
    validUntil: {
      type: Date,
      validate: {
        validator(validUntil) {
          return !this.validFrom || validUntil >= this.validFrom;
        },
        message: "validUntil must not be earlier than validFrom.",
      },
    },
  },
  { timestamps: true },
);

reportingSourceSchema.index({ isActive: 1 });

module.exports =
  mongoose.models.ReportingSource ||
  mongoose.model("ReportingSource", reportingSourceSchema);
