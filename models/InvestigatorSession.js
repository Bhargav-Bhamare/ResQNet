const mongoose = require("mongoose");

const investigatorSessionSchema = new mongoose.Schema(
  {
    investigatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Investigator",
      required: true,
      index: true,
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      select: false,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    revokedAt: Date,
  },
  { timestamps: true },
);

investigatorSessionSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 },
);

module.exports =
  mongoose.models.InvestigatorSession ||
  mongoose.model("InvestigatorSession", investigatorSessionSchema);
