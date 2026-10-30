const express = require("express");
const mongoose = require("mongoose");
const Investigator = require("../models/Investigator");
const ReportingSource = require("../models/ReportingSource");
const {
  createInvestigatorAuthenticationService,
  isValidEmail,
  normalizeEmail,
  toPublicInvestigator,
} = require("../services/investigatorAuthentication");
const {
  createSourceAttributionService,
} = require("../services/sourceAttribution");
const {
  createAuthenticationMiddleware,
  requireRoles,
} = require("../services/investigatorMiddleware");

const ROLES = new Set(["admin", "investigator", "viewer"]);
const STATUSES = new Set(["active", "inactive"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateSourceCodes(value) {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some(
      (sourceCode) =>
        typeof sourceCode !== "string" ||
        sourceCode.length < 1 ||
        sourceCode.length > 80 ||
        /[\u0000-\u001f\u007f]/.test(sourceCode),
    ) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return value;
}

async function ensureConfiguredSources(sourceCodes, sourceService) {
  for (const sourceCode of sourceCodes) {
    if (!(await sourceService.getConfiguredSource({ sourceCode }))) {
      return false;
    }
  }
  return true;
}

function createAdminInvestigatorsRouter({
  InvestigatorModel = Investigator,
  ReportingSourceModel = ReportingSource,
  authenticationService = createInvestigatorAuthenticationService({
    InvestigatorModel,
  }),
  sourceAttributionService = createSourceAttributionService({
    ReportingSourceModel,
  }),
  authenticate = createAuthenticationMiddleware(authenticationService),
} = {}) {
  const router = express.Router();
  router.use(authenticate, requireRoles("admin"));

  router.post("/", async (request, response) => {
    const body = request.body;
    if (
      !isPlainObject(body) ||
      Object.keys(body).some(
        (key) =>
          !["name", "email", "password", "role", "sourceCodes"].includes(key),
      ) ||
      typeof body.name !== "string" ||
      !body.name.trim() ||
      body.name.trim().length > 150 ||
      !isValidEmail(normalizeEmail(body.email)) ||
      typeof body.password !== "string" ||
      body.password.length < 12 ||
      body.password.length > 256 ||
      !ROLES.has(body.role)
    ) {
      return response.status(400).json({ error: "Invalid investigator details." });
    }
    const sourceCodes = validateSourceCodes(
      body.sourceCodes === undefined ? [] : body.sourceCodes,
    );
    if (!sourceCodes) {
      return response.status(400).json({ error: "Invalid source assignments." });
    }
    try {
      if (
        !(await ensureConfiguredSources(
          sourceCodes,
          sourceAttributionService,
        ))
      ) {
        return response.status(400).json({
          error: "Every assigned source must be configured.",
        });
      }
      const investigator = await InvestigatorModel.create({
        name: body.name.trim(),
        email: normalizeEmail(body.email),
        passwordHash: await authenticationService.hashPassword(body.password),
        role: body.role,
        status: "active",
        sourceCodes,
      });
      return response
        .status(201)
        .json({ investigator: toPublicInvestigator(investigator) });
    } catch (error) {
      if (error?.code === 11000) {
        return response.status(409).json({ error: "Email is already in use." });
      }
      if (error instanceof mongoose.Error.ValidationError) {
        return response.status(400).json({ error: "Invalid investigator details." });
      }
      console.error("Investigator account creation failed.");
      return response
        .status(503)
        .json({ error: "Investigator management is temporarily unavailable." });
    }
  });

  router.patch("/:investigatorId", async (request, response) => {
    const { investigatorId } = request.params;
    const body = request.body;
    const allowedFields = new Set(["role", "sourceCodes", "status"]);
    if (
      !mongoose.isValidObjectId(investigatorId) ||
      !isPlainObject(body) ||
      Object.keys(body).length === 0 ||
      Object.keys(body).some((key) => !allowedFields.has(key)) ||
      (body.role !== undefined && !ROLES.has(body.role)) ||
      (body.status !== undefined && !STATUSES.has(body.status))
    ) {
      return response.status(400).json({ error: "Invalid investigator update." });
    }
    const sourceCodes =
      body.sourceCodes === undefined
        ? undefined
        : validateSourceCodes(body.sourceCodes);
    if (body.sourceCodes !== undefined && !sourceCodes) {
      return response.status(400).json({ error: "Invalid source assignments." });
    }

    try {
      const current = await InvestigatorModel.findById(investigatorId).lean();
      if (!current) {
        return response.status(404).json({ error: "Investigator not found." });
      }
      if (String(current._id) === request.investigator.id) {
        return response.status(400).json({
          error: "Administrators cannot update their own account here.",
        });
      }
      if (
        sourceCodes &&
        !(await ensureConfiguredSources(sourceCodes, sourceAttributionService))
      ) {
        return response.status(400).json({
          error: "Every assigned source must be configured.",
        });
      }

      const updates = {};
      if (body.role !== undefined) updates.role = body.role;
      if (body.status !== undefined) updates.status = body.status;
      if (sourceCodes !== undefined) updates.sourceCodes = sourceCodes;
      const updated = await InvestigatorModel.findByIdAndUpdate(
        investigatorId,
        { $set: updates },
        { new: true, runValidators: true },
      ).select("-passwordHash");
      if (body.status === "inactive") {
        await authenticationService.revokeInvestigatorSessions(investigatorId);
      }
      return response
        .status(200)
        .json({ investigator: toPublicInvestigator(updated) });
    } catch (error) {
      if (error instanceof mongoose.Error.ValidationError) {
        return response.status(400).json({ error: "Invalid investigator update." });
      }
      console.error("Investigator account update failed.");
      return response
        .status(503)
        .json({ error: "Investigator management is temporarily unavailable." });
    }
  });

  return router;
}

module.exports = {
  createAdminInvestigatorsRouter,
  ensureConfiguredSources,
  validateSourceCodes,
};
