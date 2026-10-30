const {
  createHash,
  randomBytes,
  timingSafeEqual,
} = require("node:crypto");
const mongoose = require("mongoose");
const Report = require("../models/Report");
const ReportingSource = require("../models/ReportingSource");
const ReportingSourceCredential = require("../models/ReportingSourceCredential");
const ReportAttribution = require("../models/ReportAttribution");

const ATTRIBUTION_METHOD = "source_api_key";
const REPORT_FIELDS = new Set([
  "reportType",
  "description",
  "symptoms",
  "severity",
  "location",
  "reportedAt",
]);
const LOCATION_FIELDS = new Set([
  "region",
  "district",
  "state",
  "country",
  "coordinates",
]);

class SourceAttributionError extends Error {
  constructor(code, statusCode, message) {
    super(message);
    this.name = "SourceAttributionError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function hashSecret(secret) {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function createCredential() {
  const credentialId = randomBytes(12).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return {
    credentialId,
    secret,
    token: `nsq_${credentialId}.${secret}`,
    secretHash: hashSecret(secret),
  };
}

function parseCredential(token) {
  if (typeof token !== "string") return null;
  const match = /^nsq_([a-f0-9]{24})\.([A-Za-z0-9_-]{43})$/.exec(token);
  return match
    ? { credentialId: match[1], secret: match[2] }
    : null;
}

function safelyMatchesSecret(secret, secretHash) {
  const candidate = Buffer.from(hashSecret(secret), "hex");
  const expected =
    typeof secretHash === "string" && /^[a-f0-9]{64}$/.test(secretHash)
      ? Buffer.from(secretHash, "hex")
      : Buffer.alloc(candidate.length);
  return (
    timingSafeEqual(candidate, expected) &&
    typeof secretHash === "string" &&
    /^[a-f0-9]{64}$/.test(secretHash)
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateSourceReportShape(body) {
  if (!isPlainObject(body)) return "The request body must be a JSON object.";

  for (const field of Object.keys(body)) {
    if (field === "sourceId" || field === "sourceChannel") {
      return "Source attribution fields are assigned by the authenticated server.";
    }
    if (
      [
        "verificationStatus",
        "_id",
        "id",
        "__v",
        "submittedAt",
        "createdAt",
        "updatedAt",
      ].includes(field)
    ) {
      return `${field} is assigned by the server.`;
    }
    if (!REPORT_FIELDS.has(field)) return `Unsupported field: ${field}.`;
  }

  if (
    "symptoms" in body &&
    (!Array.isArray(body.symptoms) ||
      body.symptoms.some((symptom) => typeof symptom !== "string"))
  ) {
    return "symptoms must be an array of strings.";
  }
  if ("location" in body) {
    if (!isPlainObject(body.location)) return "location must be a JSON object.";
    for (const [field, value] of Object.entries(body.location)) {
      if (!LOCATION_FIELDS.has(field)) {
        return `Unsupported location field: ${field}.`;
      }
      if (field !== "coordinates" && typeof value !== "string") {
        return `location.${field} must be a string.`;
      }
      if (field === "coordinates" && !isPlainObject(value)) {
        return "location.coordinates must be a GeoJSON Point object.";
      }
    }
  }
  if (
    "reportedAt" in body &&
    (typeof body.reportedAt !== "string" ||
      Number.isNaN(Date.parse(body.reportedAt)))
  ) {
    return "reportedAt must be a valid date string.";
  }
  return null;
}

function getDate(value, fieldName) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${fieldName} must be a valid date.`);
  }
  return date;
}

async function resolveQuery(query) {
  return query && typeof query.lean === "function"
    ? query.lean()
    : query;
}

function safeCredentialId(token) {
  return parseCredential(token)?.credentialId;
}

function createSourceAttributionService({
  ReportingSourceModel = ReportingSource,
  CredentialModel = ReportingSourceCredential,
  AttributionModel = ReportAttribution,
  ReportModel = Report,
  now = () => new Date(),
} = {}) {
  async function writeAudit(entry) {
    return AttributionModel.create({
      method: ATTRIBUTION_METHOD,
      attributedAt: now(),
      ...entry,
    });
  }

  async function reject({
    code,
    statusCode,
    reason,
    token,
    source,
    reportId,
    message,
  }) {
    await writeAudit({
      ...(reportId ? { reportId } : {}),
      ...(source?._id ? { reportingSourceId: source._id } : {}),
      ...(source?.sourceCode ? { sourceCode: source.sourceCode } : {}),
      ...(safeCredentialId(token)
        ? { credentialId: safeCredentialId(token) }
        : {}),
      ...(source
        ? {
            sourceWasActive: source.isActive === true,
            sourceWasWithinValidity: isWithinSourceValidity(source, now()),
          }
        : {}),
      outcome: "rejected",
      reason,
    });
    throw new SourceAttributionError(code, statusCode, message);
  }

  async function authenticate(token) {
    if (token === undefined || token === null || token === "") {
      return reject({
        code: "missing_credential",
        statusCode: 401,
        reason: "missing_credential",
        message: "A source credential is required.",
      });
    }

    const parsed = parseCredential(token);
    if (!parsed) {
      return reject({
        code: "invalid_credential",
        statusCode: 401,
        reason: "invalid_credential",
        token,
        message: "The source credential is invalid.",
      });
    }

    let credentialQuery = CredentialModel.findOne({
      credentialId: parsed.credentialId,
    });
    if (typeof credentialQuery.select === "function") {
      credentialQuery = credentialQuery.select("+secretHash");
    }
    const credential = await resolveQuery(credentialQuery);

    if (
      !credential ||
      !safelyMatchesSecret(parsed.secret, credential.secretHash)
    ) {
      return reject({
        code: "invalid_credential",
        statusCode: 401,
        reason: "invalid_credential",
        token,
        message: "The source credential is invalid.",
      });
    }

    if (credential.revokedAt) {
      return reject({
        code: "credential_revoked",
        statusCode: 401,
        reason: "credential_revoked",
        token,
        message: "The source credential is invalid.",
      });
    }
    if (
      credential.expiresAt &&
      getDate(credential.expiresAt, "expiresAt") <= now()
    ) {
      return reject({
        code: "credential_expired",
        statusCode: 401,
        reason: "credential_expired",
        token,
        message: "The source credential is invalid.",
      });
    }

    const source = await resolveQuery(
      ReportingSourceModel.findById(credential.reportingSourceId),
    );
    if (!source) {
      return reject({
        code: "source_not_found",
        statusCode: 403,
        reason: "source_not_found",
        token,
        message: "The reporting source is not available.",
      });
    }
    if (source.isActive !== true) {
      return reject({
        code: "source_inactive",
        statusCode: 403,
        reason: "source_inactive",
        token,
        source,
        message: "The reporting source is not active.",
      });
    }

    const evaluationTime = getDate(now(), "now");
    const validFrom = getDate(source.validFrom, "source.validFrom");
    if (evaluationTime < validFrom) {
      return reject({
        code: "source_not_yet_valid",
        statusCode: 403,
        reason: "source_not_yet_valid",
        token,
        source,
        message: "The reporting source is not valid at this time.",
      });
    }
    if (
      source.validUntil != null &&
      evaluationTime > getDate(source.validUntil, "source.validUntil")
    ) {
      return reject({
        code: "source_expired",
        statusCode: 403,
        reason: "source_expired",
        token,
        source,
        message: "The reporting source is not valid at this time.",
      });
    }
    return { credential, source, credentialId: parsed.credentialId };
  }

  return {
    async provisionCredential({ sourceCode, expiresAt } = {}) {
      if (typeof sourceCode !== "string" || !sourceCode.trim()) {
        throw new TypeError("sourceCode is required.");
      }
      const evaluatedAt = getDate(now(), "now");
      const source = await resolveQuery(
        ReportingSourceModel.findOne({ sourceCode }),
      );
      if (!source || source.isActive !== true) {
        throw new SourceAttributionError(
          "source_not_available",
          403,
          "The reporting source is not available for credential provisioning.",
        );
      }
      if (!isWithinSourceValidity(source, evaluatedAt)) {
        throw new SourceAttributionError(
          "source_not_valid",
          403,
          "The reporting source is not valid at this time.",
        );
      }

      const credential = createCredential();
      const expiresAtDate =
        expiresAt === undefined ? undefined : getDate(expiresAt, "expiresAt");
      if (expiresAtDate && expiresAtDate <= evaluatedAt) {
        throw new TypeError("expiresAt must be in the future.");
      }
      await CredentialModel.create({
        credentialId: credential.credentialId,
        reportingSourceId: source._id,
        secretHash: credential.secretHash,
        ...(expiresAtDate ? { expiresAt: expiresAtDate } : {}),
      });

      return {
        credentialId: credential.credentialId,
        credential: credential.token,
        ...(expiresAtDate ? { expiresAt: expiresAtDate.toISOString() } : {}),
      };
    },

    async revokeCredential({ credentialId } = {}) {
      if (
        typeof credentialId !== "string" ||
        !/^[a-f0-9]{24}$/.test(credentialId)
      ) {
        throw new TypeError("credentialId is invalid.");
      }
      const revokedAt = getDate(now(), "now");
      const credential = await CredentialModel.findOneAndUpdate(
        { credentialId, revokedAt: null },
        { $set: { revokedAt } },
        { new: true },
      );
      return Boolean(credential);
    },

    async attributeReport({ credential: token, reportData } = {}) {
      const { source, credentialId } = await authenticate(token);
      const shapeError = validateSourceReportShape(reportData);
      if (shapeError) {
        const reason =
          reportData &&
          (Object.hasOwn(reportData, "sourceId") ||
            Object.hasOwn(reportData, "sourceChannel"))
            ? "attribution_fields_not_allowed"
            : "invalid_report";
        return reject({
          code: reason,
          statusCode: 400,
          reason,
          token,
          source,
          message: shapeError,
        });
      }

      const report = new ReportModel({
        ...reportData,
        sourceId: source.sourceCode,
        sourceChannel: "official_api",
      });
      try {
        await report.validate();
      } catch (error) {
        if (
          error instanceof mongoose.Error.ValidationError ||
          error instanceof mongoose.Error.CastError
        ) {
          return reject({
            code: "invalid_report",
            statusCode: 400,
            reason: "invalid_report",
            token,
            source,
            message: "Report validation failed.",
          });
        }
        throw error;
      }

      const reportId = report._id;
      try {
        await report.save();
        await writeAudit({
          reportId,
          reportingSourceId: source._id,
          sourceCode: source.sourceCode,
          credentialId,
          sourceWasActive: true,
          sourceWasWithinValidity: true,
          outcome: "accepted",
          reason: "source_credential_authenticated",
        });
      } catch {
        throw new SourceAttributionError(
          "attribution_persistence_failed",
          503,
          "The source report could not be accepted.",
        );
      }

      return {
        report: report.toObject({ versionKey: false }),
        attribution: {
          outcome: "accepted",
          method: ATTRIBUTION_METHOD,
          sourceCode: source.sourceCode,
          credentialId,
        },
      };
    },

    async getTrustedReports({ sourceCode } = {}) {
      if (typeof sourceCode !== "string" || !sourceCode.trim()) {
        throw new TypeError("sourceCode is required.");
      }
      const source = await resolveQuery(
        ReportingSourceModel.findOne({ sourceCode }),
      );
      if (!source) {
        return { reports: [], trustedReportIds: new Set() };
      }
      let attributionQuery = AttributionModel.find({
        reportingSourceId: source._id,
        sourceCode,
        method: ATTRIBUTION_METHOD,
        outcome: "accepted",
        reason: "source_credential_authenticated",
        sourceWasActive: true,
        sourceWasWithinValidity: true,
      });
      if (typeof attributionQuery.select === "function") {
        attributionQuery = attributionQuery.select("reportId");
      }
      const accepted = await resolveQuery(attributionQuery);
      const reportIds = accepted
        .map((attribution) => attribution.reportId)
        .filter(Boolean);
      if (reportIds.length === 0) {
        return { reports: [], trustedReportIds: new Set() };
      }

      const reports = await resolveQuery(
        ReportModel.find({
          _id: { $in: reportIds },
          sourceId: sourceCode,
          sourceChannel: "official_api",
        }),
      );
      const reportById = new Map(
        reports.map((report) => [String(report._id), report]),
      );
      const trustedReports = reportIds
        .map((id) => reportById.get(String(id)))
        .filter(Boolean);
      return {
        reports: trustedReports,
        trustedReportIds: new Set(
          trustedReports.map((report) => String(report._id)),
        ),
      };
    },
  };
}

function isWithinSourceValidity(source, date) {
  if (
    !source?.validFrom ||
    date < getDate(source.validFrom, "source.validFrom")
  ) {
    return false;
  }
  return (
    source.validUntil == null ||
    date <= getDate(source.validUntil, "source.validUntil")
  );
}

module.exports = {
  SourceAttributionError,
  createSourceAttributionService,
};
