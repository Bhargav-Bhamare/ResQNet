const mongoose = require("mongoose");

const investigatorBootstrapSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      required: true,
    },
    claimToken: {
      type: String,
      required: true,
      select: false,
    },
    claimedAt: {
      type: Date,
      required: true,
    },
    completedAt: Date,
  },
  { versionKey: false },
);

module.exports =
  mongoose.models.InvestigatorBootstrap ||
  mongoose.model("InvestigatorBootstrap", investigatorBootstrapSchema);
