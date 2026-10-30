const mongoose = require("mongoose");

const investigationReviewSchema = new mongoose.Schema(
  {
    investigationId: {
      type: String,
      required: true,
      immutable: true,
      match: /^inv_[a-f0-9]{32}$/,
      index: true,
    },
    reviewerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Investigator",
      required: true,
      immutable: true,
    },
    action: {
      type: String,
      enum: [
        "investigation_created",
        "investigation_assigned",
        "status_changed",
        "review_note_added",
        "decision_recorded",
        "investigation_closed",
      ],
      required: true,
      immutable: true,
    },
    previousStatus: {
      type: String,
      enum: [
        "generated",
        "under_review",
        "requires_more_information",
        "reviewed",
        "closed",
      ],
      immutable: true,
    },
    newStatus: {
      type: String,
      enum: [
        "generated",
        "under_review",
        "requires_more_information",
        "reviewed",
        "closed",
      ],
      immutable: true,
    },
    previousAssigneeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Investigator",
      immutable: true,
    },
    newAssigneeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Investigator",
      immutable: true,
    },
    decision: {
      type: String,
      enum: [
        "reporting_discontinuity_observed",
        "channel_availability_concern",
        "insufficient_evidence",
        "no_significant_discontinuity",
        "other",
      ],
      immutable: true,
    },
    note: {
      type: String,
      trim: true,
      maxlength: 5000,
      immutable: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

investigationReviewSchema.index({ investigationId: 1, createdAt: 1 });
investigationReviewSchema.pre("validate", function validateReviewAction() {
  const transitions = {
    generated: new Set(["under_review"]),
    under_review: new Set(["requires_more_information", "reviewed"]),
    requires_more_information: new Set(["under_review"]),
    reviewed: new Set(["closed"]),
  };
  const statuses = {
    investigation_created:
      this.newStatus === "generated" && this.previousStatus === undefined,
    investigation_assigned: this.newAssigneeId !== undefined,
    status_changed:
      transitions[this.previousStatus]?.has(this.newStatus) === true,
    investigation_closed:
      this.previousStatus === "reviewed" && this.newStatus === "closed",
    review_note_added:
      typeof this.note === "string" &&
      this.note.trim().length >= 1 &&
      this.note.trim().length <= 5000,
    decision_recorded:
      this.decision !== undefined &&
      (this.decision !== "other" ||
        (typeof this.note === "string" && this.note.trim().length >= 1)),
  };
  if (!statuses[this.action]) {
    this.invalidate("action", "Review action fields are incomplete or invalid.");
  }
  if (
    this.action === "investigation_assigned" &&
    String(this.previousAssigneeId ?? "") ===
      String(this.newAssigneeId ?? "")
  ) {
    this.invalidate("newAssigneeId", "The assignment must change.");
  }
});
investigationReviewSchema.pre("save", function preventReviewUpdates() {
  if (!this.isNew) {
    throw new Error("Investigation review history is append-only.");
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
  investigationReviewSchema.pre(operation, function preventReviewMutation() {
    throw new Error("Investigation review history is append-only.");
  });
}
investigationReviewSchema.pre(
  "deleteOne",
  { document: true, query: false },
  function preventDocumentReviewDeletion() {
    throw new Error("Investigation review history is append-only.");
  },
);

module.exports =
  mongoose.models.InvestigationReview ||
  mongoose.model("InvestigationReview", investigationReviewSchema);
