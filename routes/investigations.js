const express = require("express");
const mongoose = require("mongoose");
const Investigation = require("../models/Investigation");
const InvestigationReview = require("../models/InvestigationReview");
const Investigator = require("../models/Investigator");
const {
  createInvestigatorAuthenticationService,
} = require("../services/investigatorAuthentication");
const {
  createAuthenticationMiddleware,
} = require("../services/investigatorMiddleware");

const INVESTIGATION_ID_PATTERN = /^inv_[a-f0-9]{32}$/;
const REVIEW_STATUSES = new Set([
  "generated",
  "under_review",
  "requires_more_information",
  "reviewed",
  "closed",
]);
const DECISIONS = new Set([
  "reporting_discontinuity_observed",
  "channel_availability_concern",
  "insufficient_evidence",
  "no_significant_discontinuity",
  "other",
]);
const STATUS_TRANSITIONS = new Map([
  ["generated", new Set(["under_review"])],
  ["under_review", new Set(["requires_more_information", "reviewed"])],
  ["requires_more_information", new Set(["under_review"])],
  ["reviewed", new Set(["closed"])],
]);
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_REVIEW_HISTORY = 100;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowedKeys) {
  return (
    isPlainObject(value) &&
    Object.keys(value).every((key) => allowedKeys.includes(key))
  );
}

function toId(value) {
  return value == null ? null : String(value._id || value);
}

function serializeInvestigation(investigation, includeEvidence) {
  return {
    investigationId: investigation.investigationId,
    sourceCode: investigation.sourceCode,
    createdBy: toId(investigation.createdBy),
    assignedTo: toId(investigation.assignedTo),
    evaluatedAt: investigation.evaluatedAt,
    periods: investigation.periods,
    status: investigation.status,
    evidenceVersion: investigation.evidenceVersion,
    createdAt: investigation.createdAt,
    updatedAt: investigation.updatedAt,
    ...(includeEvidence
      ? { evidenceSnapshot: investigation.evidenceSnapshot }
      : {}),
  };
}

function serializeReview(review) {
  return {
    id: toId(review),
    investigationId: review.investigationId,
    reviewerId: toId(review.reviewerId),
    action: review.action,
    ...(review.previousStatus === undefined
      ? {}
      : { previousStatus: review.previousStatus }),
    ...(review.newStatus === undefined ? {} : { newStatus: review.newStatus }),
    ...(review.previousAssigneeId === undefined
      ? {}
      : { previousAssigneeId: toId(review.previousAssigneeId) }),
    ...(review.newAssigneeId === undefined
      ? {}
      : { newAssigneeId: toId(review.newAssigneeId) }),
    ...(review.decision === undefined ? {} : { decision: review.decision }),
    ...(review.note === undefined ? {} : { note: review.note }),
    createdAt: review.createdAt,
  };
}

function normalizeInvestigatorId(value) {
  return typeof value === "string" && mongoose.isValidObjectId(value)
    ? value
    : null;
}

function createInvestigationsRouter({
  InvestigationModel = Investigation,
  ReviewModel = InvestigationReview,
  InvestigatorModel = Investigator,
  authenticationService = createInvestigatorAuthenticationService(),
  authenticate = createAuthenticationMiddleware(authenticationService),
} = {}) {
  const router = express.Router();
  router.use(authenticate);

  async function findAuthorizedInvestigation(investigationId, investigator) {
    if (!INVESTIGATION_ID_PATTERN.test(investigationId)) return null;
    const filter = {
      investigationId,
      recordType: "evidence_review",
      ...(investigator.role === "admin"
        ? {}
        : { sourceCode: { $in: investigator.sourceCodes || [] } }),
    };
    return InvestigationModel.findOne(filter).lean();
  }

  function canMutate(investigator, response) {
    if (investigator.role === "viewer") {
      response.status(403).json({ error: "Access denied." });
      return false;
    }
    return true;
  }

  async function updateAndAppendReview({
    investigation,
    updates,
    review,
    rollbackFilter,
    rollbackUpdate,
  }) {
    const updated = await InvestigationModel.findOneAndUpdate(
      {
        _id: investigation._id,
        investigationId: investigation.investigationId,
        ...(investigation.status
          ? { status: investigation.status }
          : {}),
        ...(investigation.assignedTo !== undefined
          ? { assignedTo: investigation.assignedTo || null }
          : {}),
      },
      { $set: updates },
      { new: true, runValidators: true },
    ).lean();
    if (!updated) return null;

    try {
      await ReviewModel.create(review);
      return updated;
    } catch (error) {
      try {
        await InvestigationModel.findOneAndUpdate(
          rollbackFilter(updated),
          { $set: rollbackUpdate },
          { new: true, runValidators: true },
        );
      } catch {
        console.error("Investigation review compensation failed.");
      }
      throw error;
    }
  }

  router.get("/", async (request, response) => {
    const allowedKeys = [
      "sourceCode",
      "status",
      "createdBy",
      "assignedTo",
      "page",
      "limit",
      "sort",
    ];
    if (Object.keys(request.query).some((key) => !allowedKeys.includes(key))) {
      return response.status(400).json({ error: "Invalid investigation filters." });
    }

    const pageText = request.query.page || "1";
    const limitText = request.query.limit || String(DEFAULT_PAGE_SIZE);
    if (
      !/^[1-9]\d*$/.test(pageText) ||
      !/^[1-9]\d*$/.test(limitText) ||
      Number(pageText) > 100_000 ||
      Number(limitText) > MAX_PAGE_SIZE
    ) {
      return response.status(400).json({ error: "Invalid pagination values." });
    }
    const page = Number(pageText);
    const limit = Number(limitText);
    if ((page - 1) * limit > 100_000) {
      return response.status(400).json({ error: "Pagination offset is too large." });
    }
    const sortDirection =
      request.query.sort === undefined || request.query.sort === "desc"
        ? -1
        : request.query.sort === "asc"
          ? 1
          : null;
    if (
      !sortDirection ||
      (request.query.status !== undefined &&
        !REVIEW_STATUSES.has(request.query.status)) ||
      (request.query.sourceCode !== undefined &&
        (typeof request.query.sourceCode !== "string" ||
          request.query.sourceCode.length < 1 ||
          request.query.sourceCode.length > 80)) ||
      (request.query.createdBy !== undefined &&
        !normalizeInvestigatorId(request.query.createdBy)) ||
      (request.query.assignedTo !== undefined &&
        !normalizeInvestigatorId(request.query.assignedTo))
    ) {
      return response.status(400).json({ error: "Invalid investigation filters." });
    }

    const filter = { recordType: "evidence_review" };
    if (request.investigator.role !== "admin") {
      filter.sourceCode = { $in: request.investigator.sourceCodes || [] };
    }
    if (request.query.sourceCode !== undefined) {
      if (request.investigator.role === "admin") {
        filter.sourceCode = request.query.sourceCode;
      } else {
        filter.sourceCode.$in = filter.sourceCode.$in.includes(
          request.query.sourceCode,
        )
          ? [request.query.sourceCode]
          : [];
      }
    }
    if (request.query.status !== undefined) filter.status = request.query.status;
    if (request.query.createdBy !== undefined) {
      filter.createdBy = request.query.createdBy;
    }
    if (request.query.assignedTo !== undefined) {
      filter.assignedTo = request.query.assignedTo;
    }

    try {
      const [records, total] = await Promise.all([
        InvestigationModel.find(filter)
          .select("-evidenceSnapshot")
          .sort({ createdAt: sortDirection, _id: sortDirection })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        InvestigationModel.countDocuments(filter),
      ]);
      return response.status(200).json({
        investigations: records.map((record) =>
          serializeInvestigation(record, false),
        ),
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      });
    } catch {
      console.error("Investigation listing failed.");
      return response
        .status(503)
        .json({ error: "Investigation history is temporarily unavailable." });
    }
  });

  router.get("/:investigationId", async (request, response) => {
    try {
      const investigation = await findAuthorizedInvestigation(
        request.params.investigationId,
        request.investigator,
      );
      if (!investigation) {
        return response.status(404).json({ error: "Investigation not found." });
      }
      const reviews = await ReviewModel.find({
        investigationId: investigation.investigationId,
      })
        .sort({ createdAt: -1, _id: -1 })
        .limit(MAX_REVIEW_HISTORY)
        .lean();
      const totalReviews = await ReviewModel.countDocuments({
        investigationId: investigation.investigationId,
      });
      return response.status(200).json({
        investigation: serializeInvestigation(investigation, true),
        reviewHistory: reviews.reverse().map(serializeReview),
        reviewHistoryTruncated: totalReviews > reviews.length,
      });
    } catch {
      console.error("Investigation retrieval failed.");
      return response
        .status(503)
        .json({ error: "Investigation history is temporarily unavailable." });
    }
  });

  router.get("/:investigationId/reviews", async (request, response) => {
    if (
      Object.keys(request.query).some(
        (key) => !["limit", "page"].includes(key),
      ) ||
      (request.query.page !== undefined &&
        !/^[1-9]\d*$/.test(request.query.page)) ||
      Number(request.query.page || 1) > 100_000 ||
      (request.query.limit !== undefined &&
        (!/^[1-9]\d*$/.test(request.query.limit) ||
          Number(request.query.limit) > MAX_REVIEW_HISTORY))
    ) {
      return response.status(400).json({ error: "Invalid review-history pagination." });
    }
    try {
      const investigation = await findAuthorizedInvestigation(
        request.params.investigationId,
        request.investigator,
      );
      if (!investigation) {
        return response.status(404).json({ error: "Investigation not found." });
      }
      const limit = Number(request.query.limit || MAX_REVIEW_HISTORY);
      const page = Number(request.query.page || 1);
      if ((page - 1) * limit > 100_000) {
        return response.status(400).json({ error: "Review-history offset is too large." });
      }
      const filter = { investigationId: investigation.investigationId };
      const [reviews, total] = await Promise.all([
        ReviewModel.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        ReviewModel.countDocuments(filter),
      ]);
      return response.status(200).json({
        investigationId: investigation.investigationId,
        reviewHistory: reviews.reverse().map(serializeReview),
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      });
    } catch {
      console.error("Investigation review-history retrieval failed.");
      return response
        .status(503)
        .json({ error: "Review history is temporarily unavailable." });
    }
  });

  router.post("/:investigationId/notes", async (request, response) => {
    if (!canMutate(request.investigator, response)) return;
    if (
      !hasOnlyKeys(request.body, ["note"]) ||
      typeof request.body.note !== "string" ||
      request.body.note.trim().length < 1 ||
      request.body.note.trim().length > 5000
    ) {
      return response.status(400).json({ error: "Note must contain 1 to 5000 characters." });
    }
    try {
      const investigation = await findAuthorizedInvestigation(
        request.params.investigationId,
        request.investigator,
      );
      if (!investigation) {
        return response.status(404).json({ error: "Investigation not found." });
      }
      const review = await ReviewModel.create({
        investigationId: investigation.investigationId,
        reviewerId: request.investigator.id,
        action: "review_note_added",
        note: request.body.note.trim(),
      });
      return response.status(201).json({ review: serializeReview(review) });
    } catch {
      console.error("Investigation note persistence failed.");
      return response.status(503).json({ error: "Unable to save review note." });
    }
  });

  router.patch("/:investigationId/status", async (request, response) => {
    if (!canMutate(request.investigator, response)) return;
    if (
      !hasOnlyKeys(request.body, ["status"]) ||
      !REVIEW_STATUSES.has(request.body.status)
    ) {
      return response.status(400).json({ error: "Invalid investigation status." });
    }
    try {
      const investigation = await findAuthorizedInvestigation(
        request.params.investigationId,
        request.investigator,
      );
      if (!investigation) {
        return response.status(404).json({ error: "Investigation not found." });
      }
      if (
        !STATUS_TRANSITIONS.get(investigation.status)?.has(request.body.status)
      ) {
        return response.status(409).json({
          error: "Investigation status transition is not allowed.",
        });
      }
      const newStatus = request.body.status;
      const updated = await updateAndAppendReview({
        investigation,
        updates: { status: newStatus },
        review: {
          investigationId: investigation.investigationId,
          reviewerId: request.investigator.id,
          action: newStatus === "closed" ? "investigation_closed" : "status_changed",
          previousStatus: investigation.status,
          newStatus,
        },
        rollbackFilter: (current) => ({
          _id: current._id,
          investigationId: current.investigationId,
          status: newStatus,
        }),
        rollbackUpdate: { status: investigation.status },
      });
      if (!updated) {
        return response.status(409).json({
          error: "Investigation changed; reload before reviewing it.",
        });
      }
      return response.status(200).json({
        investigation: serializeInvestigation(updated, false),
      });
    } catch {
      console.error("Investigation status update failed.");
      return response.status(503).json({ error: "Unable to update investigation status." });
    }
  });

  router.post("/:investigationId/decision", async (request, response) => {
    if (!canMutate(request.investigator, response)) return;
    if (
      !hasOnlyKeys(request.body, ["decision", "note"]) ||
      !DECISIONS.has(request.body.decision) ||
      (request.body.note !== undefined &&
        (typeof request.body.note !== "string" ||
          request.body.note.trim().length > 5000)) ||
      (request.body.decision === "other" &&
        (typeof request.body.note !== "string" ||
          request.body.note.trim().length < 1))
    ) {
      return response.status(400).json({ error: "Invalid review decision." });
    }
    try {
      const investigation = await findAuthorizedInvestigation(
        request.params.investigationId,
        request.investigator,
      );
      if (!investigation) {
        return response.status(404).json({ error: "Investigation not found." });
      }
      const review = await ReviewModel.create({
        investigationId: investigation.investigationId,
        reviewerId: request.investigator.id,
        action: "decision_recorded",
        decision: request.body.decision,
        ...(request.body.note?.trim()
          ? { note: request.body.note.trim() }
          : {}),
      });
      return response.status(201).json({
        review: serializeReview(review),
        decisionType: "investigator_assessment",
      });
    } catch {
      console.error("Investigation decision persistence failed.");
      return response.status(503).json({ error: "Unable to save review decision." });
    }
  });

  router.patch("/:investigationId/assignment", async (request, response) => {
    if (request.investigator.role !== "admin") {
      return response.status(403).json({ error: "Access denied." });
    }
    if (
      !hasOnlyKeys(request.body, ["assignedTo"]) ||
      (request.body.assignedTo !== null &&
        !normalizeInvestigatorId(request.body.assignedTo))
    ) {
      return response.status(400).json({ error: "Invalid investigation assignment." });
    }
    try {
      const investigation = await findAuthorizedInvestigation(
        request.params.investigationId,
        request.investigator,
      );
      if (!investigation) {
        return response.status(404).json({ error: "Investigation not found." });
      }
      const assigneeId =
        request.body.assignedTo === null ? null : request.body.assignedTo;
      if (String(investigation.assignedTo || "") === String(assigneeId || "")) {
        return response.status(409).json({
          error: "Investigation is already assigned to that investigator.",
        });
      }
      if (assigneeId) {
        const assignee = await InvestigatorModel.findById(assigneeId).lean();
        if (
          !assignee ||
          assignee.status !== "active" ||
          assignee.role !== "investigator" ||
          !assignee.sourceCodes?.includes(investigation.sourceCode)
        ) {
          return response.status(400).json({
            error: "Assignee must be an active investigator authorized for this source.",
          });
        }
      }
      const updated = await updateAndAppendReview({
        investigation,
        updates: { assignedTo: assigneeId },
        review: {
          investigationId: investigation.investigationId,
          reviewerId: request.investigator.id,
          action: "investigation_assigned",
          previousAssigneeId: investigation.assignedTo || null,
          newAssigneeId: assigneeId,
        },
        rollbackFilter: (current) => ({
          _id: current._id,
          investigationId: current.investigationId,
          assignedTo: assigneeId,
        }),
        rollbackUpdate: { assignedTo: investigation.assignedTo || null },
      });
      if (!updated) {
        return response.status(409).json({
          error: "Investigation changed; reload before assigning it.",
        });
      }
      return response.status(200).json({
        investigation: serializeInvestigation(updated, false),
      });
    } catch {
      console.error("Investigation assignment failed.");
      return response.status(503).json({ error: "Unable to update investigation assignment." });
    }
  });

  return router;
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  DECISIONS,
  INVESTIGATION_ID_PATTERN,
  MAX_PAGE_SIZE,
  MAX_REVIEW_HISTORY,
  REVIEW_STATUSES,
  STATUS_TRANSITIONS,
  createInvestigationsRouter,
  serializeInvestigation,
};
