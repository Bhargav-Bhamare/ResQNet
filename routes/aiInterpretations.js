const { randomUUID } = require("node:crypto");
const express = require("express");
const mongoose = require("mongoose");
const AIInterpretation = require("../models/AIInterpretation");
const AIInterpretationAudit = require("../models/AIInterpretationAudit");
const Investigation = require("../models/Investigation");
const {
  EvidenceSanitizationError,
} = require("../services/ai/evidenceSanitizer");
const {
  createNemotronInterpreter,
  NemotronInterpreterError,
} = require("../services/ai/nemotronInterpreter");
const {
  createInvestigatorAuthenticationService,
} = require("../services/investigatorAuthentication");
const {
  createAuthenticationMiddleware,
} = require("../services/investigatorMiddleware");
const { loadNebiusConfig } = require("../services/llm/nebiusConfig");

const INVESTIGATION_ID_PATTERN = /^inv_[a-f0-9]{32}$/;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_OFFSET = 100_000;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeConfiguredModel(env) {
  try {
    const model = loadNebiusConfig(env).model;
    return /^[A-Za-z0-9._/-]{1,200}$/.test(model) ? model : undefined;
  } catch {
    return undefined;
  }
}

function serializeInterpretation(record) {
  return {
    id: String(record._id),
    investigationId: record.investigationId,
    sourceCode: record.sourceCode,
    requestedBy: String(record.requestedBy?._id || record.requestedBy),
    provider: record.provider,
    model: record.model,
    promptVersion: record.promptVersion,
    schemaVersion: record.schemaVersion,
    evidenceVersion: record.evidenceVersion,
    evidenceHash: record.evidenceHash,
    interpretation: record.interpretation,
    validationStatus: record.validationStatus,
    validationWarnings: record.validationWarnings,
    providerRequestId: record.providerRequestId,
    usage: record.usage,
    latencyMs: record.latencyMs,
    createdAt: record.createdAt,
  };
}

function validatePagination(query) {
  if (
    Object.keys(query).some((key) => !["page", "limit"].includes(key)) ||
    (query.page !== undefined && !/^[1-9]\d*$/.test(query.page)) ||
    (query.limit !== undefined && !/^[1-9]\d*$/.test(query.limit))
  ) {
    return null;
  }
  const page = Number(query.page || 1);
  const limit = Number(query.limit || DEFAULT_PAGE_SIZE);
  if (
    !Number.isSafeInteger(page) ||
    !Number.isSafeInteger(limit) ||
    page > MAX_OFFSET ||
    limit > MAX_PAGE_SIZE ||
    (page - 1) * limit > MAX_OFFSET
  ) {
    return null;
  }
  return { page, limit };
}

function mapGenerationError(error) {
  if (error instanceof EvidenceSanitizationError) {
    return {
      status: error.code === "EVIDENCE_TOO_LARGE" ? 413 : 422,
      code: error.code,
      message: "Investigation evidence cannot be safely interpreted.",
    };
  }
  if (error instanceof NemotronInterpreterError) {
    const messages = {
      PROVIDER_NOT_CONFIGURED: "Nemotron interpretation is not configured.",
      PROVIDER_AUTHENTICATION_FAILED: "The inference provider rejected its credentials.",
      PROVIDER_REQUEST_REJECTED: "The inference provider rejected the request.",
      MODEL_UNAVAILABLE: "The configured Nemotron model is unavailable.",
      PROVIDER_QUOTA_EXCEEDED: "The inference provider has insufficient quota.",
      PROVIDER_RATE_LIMITED: "Inference is rate-limited; retry later.",
      PROVIDER_UNAVAILABLE: "The inference provider is temporarily unavailable.",
      PROVIDER_NETWORK_ERROR: "The inference provider could not be reached.",
      PROVIDER_TIMEOUT: "Nemotron interpretation timed out.",
      REQUEST_ABORTED: "Nemotron interpretation was cancelled.",
      INVALID_PROVIDER_RESPONSE: "The inference provider returned an invalid response.",
      INVALID_MODEL_JSON: "Nemotron returned invalid structured output.",
      INVALID_MODEL_OUTPUT: "Nemotron output failed schema validation.",
      INVALID_EVIDENCE_REFERENCE: "Nemotron output cited unavailable evidence.",
      UNSUPPORTED_CONCLUSION: "Nemotron output exceeded its permitted scope.",
      UNSUPPORTED_NUMERIC_CLAIM: "Nemotron output contained unsupported numeric claims.",
      EVIDENCE_CONTRADICTION: "Nemotron output conflicted with deterministic evidence.",
    };
    return {
      status: error.status,
      code: error.code,
      message: messages[error.code] || "Nemotron interpretation could not be completed.",
    };
  }
  return {
    status: 503,
    code: "INTERPRETATION_UNAVAILABLE",
    message: "Interpretation is temporarily unavailable.",
  };
}

function createAIInterpretationsRouter({
  InvestigationModel = Investigation,
  InterpretationModel = AIInterpretation,
  AuditModel = AIInterpretationAudit,
  interpreter = createNemotronInterpreter(),
  authenticationService = createInvestigatorAuthenticationService(),
  authenticate = createAuthenticationMiddleware(authenticationService),
  env = process.env,
  now = () => new Date(),
} = {}) {
  const router = express.Router();
  const activeGenerations = new Set();
  router.use(authenticate);

  async function findAuthorizedInvestigation(investigationId, investigator) {
    if (!INVESTIGATION_ID_PATTERN.test(investigationId)) return null;
    return InvestigationModel.findOne({
      investigationId,
      recordType: "evidence_review",
      ...(investigator.role === "admin"
        ? {}
        : { sourceCode: { $in: investigator.sourceCodes || [] } }),
    }).lean();
  }

  async function writeAudit(document) {
    try {
      await AuditModel.create({
        ...document,
        requestedAt: document.requestedAt || now(),
      });
      return true;
    } catch {
      console.error("AI interpretation audit persistence failed.");
      return false;
    }
  }

  router.post("/:investigationId/interpretations", async (request, response) => {
    if (request.investigator.role === "viewer") {
      return response.status(403).json({ error: "Access denied." });
    }
    if (!INVESTIGATION_ID_PATTERN.test(request.params.investigationId)) {
      return response.status(400).json({ error: "Invalid investigation ID." });
    }
    if (
      request.body !== undefined &&
      (!isPlainObject(request.body) || Object.keys(request.body).length !== 0)
    ) {
      return response.status(400).json({
        error: "Interpretation requests do not accept client-supplied evidence or identity.",
      });
    }

    let investigation;
    try {
      investigation = await findAuthorizedInvestigation(
        request.params.investigationId,
        request.investigator,
      );
    } catch {
      console.error("AI interpretation investigation lookup failed.");
      return response
        .status(503)
        .json({ error: "Investigation lookup is temporarily unavailable." });
    }
    if (!investigation) {
      return response.status(404).json({ error: "Investigation not found." });
    }
    const investigationId = investigation.investigationId;
    const lockKey = investigationId;
    const attemptId = randomUUID();
    const auditBase = {
      attemptId,
      investigatorId: request.investigator.id,
      sourceCode: investigation.sourceCode,
      investigationId,
      requestedAt: now(),
      model: safeConfiguredModel(env),
    };
    if (investigation.status === "closed") {
      if (
        !(await writeAudit({
          ...auditBase,
          stage: "failed",
          errorCode: "INVESTIGATION_CLOSED",
        }))
      ) {
        return response.status(503).json({
          error: "Interpretation audit is temporarily unavailable.",
        });
      }
      return response.status(409).json({
        error: "Closed investigations cannot generate new interpretations.",
      });
    }
    if (!investigation.evidenceSnapshot) {
      if (
        !(await writeAudit({
          ...auditBase,
          stage: "failed",
          errorCode: "MISSING_EVIDENCE",
        }))
      ) {
        return response.status(503).json({
          error: "Interpretation audit is temporarily unavailable.",
        });
      }
      return response
        .status(409)
        .json({ error: "Investigation evidence is unavailable." });
    }

    if (activeGenerations.has(lockKey)) {
      const audited = await writeAudit({
        ...auditBase,
        stage: "failed",
        errorCode: "CONCURRENT_GENERATION",
      });
      if (!audited) {
        return response.status(503).json({
          error: "Interpretation audit is temporarily unavailable.",
        });
      }
      return response.status(409).json({
        error: "An interpretation is already being generated for this investigation.",
      });
    }

    activeGenerations.add(lockKey);
    let prepared;
    try {
      prepared = interpreter.prepareInterpretation(
        investigation.evidenceSnapshot,
        investigation.evidenceVersion,
      );
    } catch (error) {
      activeGenerations.delete(lockKey);
      const mapped = mapGenerationError(error);
      const audited = await writeAudit({
        ...auditBase,
        stage: "failed",
        errorCode: mapped.code,
      });
      if (!audited) {
        return response.status(503).json({
          error: "Interpretation audit is temporarily unavailable.",
        });
      }
      return response.status(mapped.status).json({
        error: mapped.message,
        code: mapped.code,
      });
    }

    const attemptAudit = {
      ...auditBase,
      attemptId: prepared.attemptId,
      evidenceHash: prepared.evidenceHash,
      model: safeConfiguredModel(env),
    };
    if (
      !(await writeAudit({
        ...attemptAudit,
        stage: "started",
      }))
    ) {
      activeGenerations.delete(lockKey);
      return response.status(503).json({
        error: "Interpretation audit is temporarily unavailable.",
      });
    }

    const abortController = new AbortController();
    const onResponseClose = () => {
      if (!response.writableEnded) abortController.abort();
    };
    response.once("close", onResponseClose);
    try {
      const result = await interpreter.interpretPreparedEvidence(prepared, {
        signal: abortController.signal,
      });
      const saved = await InterpretationModel.create({
        investigationId,
        sourceId: investigation.sourceId,
        sourceCode: investigation.sourceCode,
        requestedBy: request.investigator.id,
        provider: result.provider,
        model: result.model,
        promptVersion: result.promptVersion,
        schemaVersion: result.schemaVersion,
        evidenceVersion: result.evidenceVersion,
        evidenceHash: result.evidenceHash,
        interpretation: result.interpretation,
        validationStatus: result.validationStatus,
        validationWarnings: result.validationWarnings,
        providerRequestId: result.providerRequestId,
        usage: result.usage,
        latencyMs: result.latencyMs,
      });
      if (
        !(await writeAudit({
          ...attemptAudit,
          stage: "succeeded",
          model: result.model,
          providerRequestId: result.providerRequestId || undefined,
          usage: result.usage,
          latencyMs: result.latencyMs ?? undefined,
        }))
      ) {
        return response.status(503).json({
          error: "Interpretation was saved but its audit record is unavailable.",
          code: "AUDIT_PERSISTENCE_FAILED",
        });
      }
      return response.status(201).json({
        interpretation: serializeInterpretation(saved),
      });
    } catch (error) {
      const mapped = mapGenerationError(error);
      const audited = await writeAudit({
        ...attemptAudit,
        stage: "failed",
        errorCode: mapped.code,
        ...(error instanceof NemotronInterpreterError
          ? {
              ...(error.providerRequestId
                ? { providerRequestId: error.providerRequestId }
                : {}),
              model: safeConfiguredModel(env),
            }
          : {}),
      });
      if (!audited) {
        return response.status(503).json({
          error: "Interpretation audit is temporarily unavailable.",
        });
      }
      console.error(`AI interpretation request failed (${mapped.code}).`);
      return response.status(mapped.status).json({
        error: mapped.message,
        code: mapped.code,
      });
    } finally {
      response.removeListener("close", onResponseClose);
      activeGenerations.delete(lockKey);
    }
  });

  router.get("/:investigationId/interpretations", async (request, response) => {
    const pagination = validatePagination(request.query);
    if (!pagination) {
      return response.status(400).json({ error: "Invalid interpretation pagination." });
    }
    if (!INVESTIGATION_ID_PATTERN.test(request.params.investigationId)) {
      return response.status(400).json({ error: "Invalid investigation ID." });
    }
    let investigation;
    try {
      investigation = await findAuthorizedInvestigation(
        request.params.investigationId,
        request.investigator,
      );
    } catch {
      console.error("AI interpretation investigation lookup failed.");
      return response
        .status(503)
        .json({ error: "Investigation lookup is temporarily unavailable." });
    }
    if (!investigation) {
      return response.status(404).json({ error: "Investigation not found." });
    }
    const filter = { investigationId: investigation.investigationId };
    try {
      const [records, total] = await Promise.all([
        InterpretationModel.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip((pagination.page - 1) * pagination.limit)
          .limit(pagination.limit)
          .lean(),
        InterpretationModel.countDocuments(filter),
      ]);
      return response.status(200).json({
        investigationId: investigation.investigationId,
        interpretations: records.map(serializeInterpretation),
        pagination: {
          ...pagination,
          total,
          pages: Math.ceil(total / pagination.limit),
        },
      });
    } catch {
      console.error("AI interpretation history retrieval failed.");
      return response
        .status(503)
        .json({ error: "Interpretation history is temporarily unavailable." });
    }
  });

  router.get(
    "/:investigationId/interpretations/:interpretationId",
    async (request, response) => {
      if (!INVESTIGATION_ID_PATTERN.test(request.params.investigationId)) {
        return response.status(400).json({ error: "Invalid investigation ID." });
      }
      if (!mongoose.isValidObjectId(request.params.interpretationId)) {
        return response.status(400).json({ error: "Invalid interpretation ID." });
      }
      let investigation;
      try {
        investigation = await findAuthorizedInvestigation(
          request.params.investigationId,
          request.investigator,
        );
      } catch {
        console.error("AI interpretation investigation lookup failed.");
        return response
          .status(503)
          .json({ error: "Investigation lookup is temporarily unavailable." });
      }
      if (!investigation) {
        return response.status(404).json({ error: "Investigation not found." });
      }
      try {
        const record = await InterpretationModel.findOne({
          _id: request.params.interpretationId,
          investigationId: investigation.investigationId,
        }).lean();
        if (!record) {
          return response
            .status(404)
            .json({ error: "Interpretation not found." });
        }
        return response
          .status(200)
          .json({ interpretation: serializeInterpretation(record) });
      } catch {
        console.error("AI interpretation retrieval failed.");
        return response
          .status(503)
          .json({ error: "Interpretation is temporarily unavailable." });
      }
    },
  );

  return router;
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  INVESTIGATION_ID_PATTERN,
  MAX_PAGE_SIZE,
  createAIInterpretationsRouter,
  mapGenerationError,
  serializeInterpretation,
  validatePagination,
};
