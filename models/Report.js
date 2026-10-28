
const mongoose = require("mongoose");

const reportSchema = new mongoose.Schema(
  {
    reportType: {
      type: String,
      enum: ["symptom", "disaster"],
      required: true,
    },
    symptoms: {
      type: [String],
      default: [],
    },
    disasterType: {
      type: String,
      default: null,
    },
    severity: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      default: "",
    },
    location: {
      type: String,
      required: true,
      trim: true,
    },
    source: {
      type: String,
      default: "resqnet-web",
    },
    isSynthetic: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.Report ||
  mongoose.model("Report", reportSchema);
