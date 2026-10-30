const { randomUUID } = require("node:crypto");
const { randomBytes } = require("node:crypto");
const express = require("express");
const InvestigationAudit = require("../models/InvestigationAudit");
const Investigation = require("../models/Investigation");
const InvestigationReview = require("../models/InvestigationReview");
const ReportingSource = require("../models/ReportingSource");
const {
  createEvidencePipeline,
} = require("../services/evidencePipeline");
const {
  createSourceAttributionService,
} = require("../services/sourceAttribution");
const {
  createAuthenticationMiddleware,
} = require("../services/investigatorMiddleware");
const {
  createInvestigatorAuthenticationService,
} = require("../services/investigatorAuthentication");
const reportingCompleteness = require("../services/reportingCompleteness");

const DEFAULT_PERIODS = { daily: 30, weekly: 12 };
const MAX_PERIODS = { daily: 365, weekly: 103 };
const SAFE_ERROR_CODES = new Set([
  "INVALID_EVALUATION_TIME",
  "INVALID_PERIOD_RANGE",
  "SOURCE_NOT_FOUND",
  "SOURCE_INACTIVE",
  "TRUSTED_LOOKUP_FAILED",
  "INCOMPLETE_QUERY_COVERAGE",
  "AGGREGATION_FAILED",
  "COMPLETENESS_FAILED",
  "BASELINE_FAILED",
  "ANOMALY_DETECTION_FAILED",
  "EVIDENCE_PACKAGE_FAILED",
  "INVESTIGATION_PERSISTENCE_FAILED",
]);

function getHistoryStart(schedule, evaluatedAt, periods) {
  const localParts = reportingCompleteness.getLocalParts(
    evaluatedAt,
    schedule.timezone,
  );
  const currentPeriod =
    reportingCompleteness.getReportingPeriodForLocalDate(schedule, {
      year: localParts.year,
      month: localParts.month,
      day: localParts.day,
    });
  const currentLocalStart = reportingCompleteness.getLocalParts(
    currentPeriod.start,
    schedule.timezone,
  );
  const daysPerPeriod = schedule.frequency === "weekly" ? 7 : 1;
  const historyLocalDate = new Date(
    Date.UTC(
      currentLocalStart.year,
      currentLocalStart.month - 1,
      currentLocalStart.day - periods * daysPerPeriod,
    ),
  );
  return reportingCompleteness.getReportingPeriodForLocalDate(schedule, {
    year: historyLocalDate.getUTCFullYear(),
    month: historyLocalDate.getUTCMonth() + 1,
    day: historyLocalDate.getUTCDate(),
  }).start;
}

function isStrictUtcTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  ) {
    return false;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const normalizedInput = value.replace(
    /\.(\d{1,3})Z$/,
    (_, fraction) => `.${fraction.padEnd(3, "0")}Z`,
  );
  return parsed.toISOString() ===
    (normalizedInput.includes(".") ? normalizedInput : normalizedInput.replace("Z", ".000Z"));
}

function createEvidenceInvestigationsRouter({
  evidencePipeline = createEvidencePipeline(),
  sourceAttributionService = createSourceAttributionService({
    ReportingSourceModel: ReportingSource,
  }),
  AuditModel = InvestigationAudit,
  InvestigationModel = Investigation,
  ReviewModel = InvestigationReview,
  authenticationService,
  authenticate = createAuthenticationMiddleware(
    authenticationService ||
      createInvestigatorAuthenticationService(),
  ),
  now = () => new Date(),
} = {}) {
  const router = express.Router();

  async function compensateCreatedInvestigation(investigation, investigationId) {
    let failed = false;
    try {
      await ReviewModel.collection.deleteOne({ investigationId });
    } catch {
      failed = true;
      console.error("Investigation review compensation failed.");
    }
    if (investigation) {
      try {
        await InvestigationModel.deleteOne({ _id: investigation._id });
      } catch {
        failed = true;
        console.error("Investigation record compensation failed.");
      }
    }
    return !failed;
  }

  async function handleEvidenceRequest(request, response, persist) {
    const requestedAt = now();
    const sourceCode = request.params.sourceCode;
    const requestId = request.requestId || randomUUID();
    response.set("X-Request-Id", requestId);
    let evaluatedAt;
    let historyStart;
    let failureCode;
    let responseStatus = 500;
    let responseBody;

    async function persistAudit(outcome, errorCode) {
      try {
        await AuditModel.create({
          investigatorId: request.investigator.id,
          sourceCode:
            typeof sourceCode === "string" ? sourceCode.slice(0, 80) : "invalid",
          requestedAt,
          ...(evaluatedAt ? { evaluatedAt } : {}),
          ...(historyStart ? { historyStart } : {}),
          ...(request.createdInvestigation?.investigationId
            ? {
                investigationId:
                  request.createdInvestigation.investigationId,
              }
            : {}),
          outcome,
          ...(errorCode ? { errorCode } : {}),
          requestId,
        });
        return true;
      } catch {
        console.error("Investigation audit persistence failed.");
        return false;
      }
    }

    try {
      if (
        typeof sourceCode !== "string" ||
        sourceCode.length < 1 ||
        sourceCode.length > 80 ||
        /[\u0000-\u001f\u007f]/.test(sourceCode)
      ) {
        failureCode = "INVALID_SOURCE_CODE";
        responseStatus = 400;
        responseBody = { error: "Invalid source code." };
      } else if (
        request.investigator.role !== "admin" &&
        !request.investigator.sourceCodes.includes(sourceCode)
      ) {
        failureCode = "SOURCE_ACCESS_DENIED";
        responseStatus = 404;
        responseBody = { error: "Reporting source not found." };
      } else {
        const source = await sourceAttributionService.getConfiguredSource({
          sourceCode,
        });
        if (!source) {
          failureCode = "SOURCE_NOT_FOUND";
          responseStatus = 404;
          responseBody = { error: "Reporting source not found." };
        } else {
          const parameters = persist ? request.body : request.query;
          const allowedKeys = ["evaluatedAt", "periods"];
          const queryKeys = Object.keys(parameters || {});
          if (
            (persist &&
              (request.query &&
                Object.keys(request.query).length > 0 ||
                !parameters ||
                typeof parameters !== "object" ||
                Array.isArray(parameters))) ||
            queryKeys.some(
              (key) => !allowedKeys.includes(key),
            ) ||
            (parameters.evaluatedAt !== undefined &&
              !isStrictUtcTimestamp(parameters.evaluatedAt)) ||
            (parameters.periods !== undefined &&
              (typeof parameters.periods !== (persist ? "number" : "string") ||
                (persist
                  ? !Number.isSafeInteger(parameters.periods) ||
                    parameters.periods < 1
                  : !/^[1-9]\d*$/.test(parameters.periods))))
          ) {
            failureCode = "INVALID_PERIOD_RANGE";
            responseStatus = 400;
            responseBody = { error: "Invalid evidence query parameters." };
          } else {
            evaluatedAt =
              parameters.evaluatedAt === undefined
                ? requestedAt
                : new Date(parameters.evaluatedAt);
            if (evaluatedAt > requestedAt) {
              failureCode = "INVALID_EVALUATION_TIME";
              responseStatus = 400;
              responseBody = {
                error: "Evaluation time cannot be in the future.",
              };
            } else {
              const frequency = source.reportingSchedule?.frequency;
              const maxPeriods = MAX_PERIODS[frequency];
              const periods =
                parameters.periods === undefined
                  ? DEFAULT_PERIODS[frequency]
                  : Number(parameters.periods);
              if (!maxPeriods || periods > maxPeriods) {
                failureCode = "INVALID_PERIOD_RANGE";
                responseStatus = 400;
                responseBody = {
                  error: "Requested history exceeds the allowed range.",
                };
              } else {
                historyStart = getHistoryStart(
                  source.reportingSchedule,
                  evaluatedAt,
                  periods,
                );
                const result =
                  await evidencePipeline.generateEvidenceForSource({
                    sourceCode,
                    historyStart,
                    evaluatedAt,
                  });
                if (
                  !result?.evidencePackage ||
                  (persist &&
                    (result.evidencePackage.schemaVersion === undefined ||
                      result.evidencePackage.metadata?.sourceCode !==
                        sourceCode ||
                      new Date(
                        result.evidencePackage.metadata?.evaluatedAt,
                      ).getTime() !== evaluatedAt.getTime()))
                ) {
                  throw Object.assign(
                    new Error("Pipeline returned an invalid evidence snapshot."),
                    { code: "EVIDENCE_PACKAGE_FAILED" },
                  );
                }
                let evidenceSnapshot;
                try {
                  evidenceSnapshot = JSON.parse(
                    JSON.stringify(result.evidencePackage),
                  );
                } catch (error) {
                  throw Object.assign(
                    new Error("Evidence snapshot is not serializable.", {
                      cause: error,
                    }),
                    { code: "EVIDENCE_PACKAGE_FAILED" },
                  );
                }
                if (persist) {
                  if (!source._id) {
                    throw Object.assign(
                      new Error("Configured source is missing its database identifier."),
                      { code: "SOURCE_NOT_FOUND" },
                    );
                  }
                  const investigationId = `inv_${randomBytes(16).toString("hex")}`;
                  let investigation;
                  try {
                    investigation = await InvestigationModel.create({
                      recordType: "evidence_review",
                      investigationId,
                      sourceId: source._id,
                      sourceCode,
                      createdBy: request.investigator.id,
                      evaluatedAt,
                      periods,
                      status: "generated",
                      evidenceSnapshot,
                      evidenceVersion: evidenceSnapshot.schemaVersion,
                    });
                    await ReviewModel.create({
                      investigationId,
                      reviewerId: request.investigator.id,
                      action: "investigation_created",
                      newStatus: "generated",
                    });
                  } catch (error) {
                    await compensateCreatedInvestigation(
                      investigation,
                      investigationId,
                    );
                    throw Object.assign(
                      new Error("Investigation persistence failed.", {
                        cause: error,
                      }),
                      { code: "INVESTIGATION_PERSISTENCE_FAILED" },
                    );
                  }
                  request.createdInvestigation = {
                    investigation,
                    investigationId,
                  };
                  responseStatus = 201;
                  responseBody = {
                    investigationId,
                    status: "generated",
                    evidencePackage: evidenceSnapshot,
                  };
                } else {
                  responseStatus = 200;
                  responseBody = evidenceSnapshot;
                }
              }
            }
          }
        }
      }
    } catch (error) {
      failureCode = SAFE_ERROR_CODES.has(error?.code)
        ? error.code
        : "EVIDENCE_GENERATION_FAILED";
      if (
        failureCode === "INVALID_EVALUATION_TIME" ||
        failureCode === "INVALID_PERIOD_RANGE"
      ) {
        responseStatus = 400;
        responseBody = { error: "Invalid evidence evaluation parameters." };
      } else if (
        failureCode === "SOURCE_NOT_FOUND" ||
        failureCode === "SOURCE_INACTIVE"
      ) {
        responseStatus = 404;
        responseBody = { error: "Reporting source not found." };
      } else if (
        failureCode === "TRUSTED_LOOKUP_FAILED" ||
        failureCode === "INCOMPLETE_QUERY_COVERAGE"
      ) {
        responseStatus = 503;
        responseBody = {
          error: "Trusted evidence is temporarily unavailable.",
        };
      } else {
        responseStatus = 500;
        responseBody = { error: "Unable to generate evidence." };
      }
      if (failureCode === "INVESTIGATION_PERSISTENCE_FAILED") {
        responseStatus = 503;
        responseBody = {
          error: "Investigation creation is temporarily unavailable.",
        };
      }
      console.error(`Evidence investigation failed (${failureCode}).`);
    }

    const audited = await persistAudit(
      failureCode ? "failure" : "success",
      failureCode,
    );
    if (!audited) {
      if (request.createdInvestigation) {
        const { investigation, investigationId } = request.createdInvestigation;
        await compensateCreatedInvestigation(investigation, investigationId);
      }
      return response.status(503).json({
        error: "Investigation audit is temporarily unavailable.",
      });
    }
    return response.status(responseStatus).json(responseBody);
  }

  router.get("/:sourceCode/evidence", authenticate, (request, response) =>
    handleEvidenceRequest(request, response, false),
  );
  router.post("/:sourceCode", authenticate, (request, response) =>
    handleEvidenceRequest(request, response, true),
  );

  return router;
}

module.exports = {
  DEFAULT_PERIODS,
  MAX_PERIODS,
  createEvidenceInvestigationsRouter,
  getHistoryStart,
  isStrictUtcTimestamp,
};
