const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { createHash } = require("node:crypto");
const {
  SourceAttributionError,
  createSourceAttributionService,
} = require("../services/sourceAttribution");
const calculateReportingCompleteness = require("../services/reportingCompleteness");
const ReportingSourceCredential = require("../models/ReportingSourceCredential");

const fixedNow = new Date("2026-10-30T03:40:00.000Z");

function createHarness({
  sourceOverrides = {},
  existingReports = [],
  existingAttributions = [],
  auditFailure = false,
} = {}) {
  const source = {
    _id: "source-document-id",
    sourceCode: "CLINIC-TRUSTED",
    name: "Test clinic",
    isActive: true,
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    validUntil: undefined,
    ...sourceOverrides,
  };
  const credentials = [];
  const attributions = [...existingAttributions];
  const reports = [...existingReports];
  let nextReportId = 0;

  const ReportingSourceModel = {
    findById(id) {
      return Promise.resolve(String(id) === String(source._id) ? source : null);
    },
    findOne({ sourceCode }) {
      return Promise.resolve(sourceCode === source.sourceCode ? source : null);
    },
  };

  const CredentialModel = {
    async create(value) {
      const credential = { ...value, revokedAt: null };
      credentials.push(credential);
      return credential;
    },
    findOne({ credentialId }) {
      const credential = credentials.find(
        (item) => item.credentialId === credentialId,
      );
      return {
        select() {
          return Promise.resolve(credential || null);
        },
      };
    },
    async findOneAndUpdate({ credentialId }, update) {
      const credential = credentials.find(
        (item) => item.credentialId === credentialId,
      );
      if (!credential || credential.revokedAt) return null;
      credential.revokedAt = update.$set.revokedAt;
      return credential;
    },
  };

  const AttributionModel = {
    async create(value) {
      if (auditFailure) throw new Error("audit store unavailable");
      attributions.push({ ...value });
      return value;
    },
    find(filter) {
      return Promise.resolve(
        attributions.filter(
          (item) =>
            String(item.reportingSourceId) ===
              String(filter.reportingSourceId) &&
            item.sourceCode === filter.sourceCode &&
            item.method === filter.method &&
            item.outcome === filter.outcome &&
            item.reason === filter.reason &&
            item.sourceWasActive === filter.sourceWasActive &&
            item.sourceWasWithinValidity ===
              filter.sourceWasWithinValidity &&
            (!filter.reportId?.$in ||
              filter.reportId.$in.some(
                (id) => String(id) === String(item.reportId),
              )),
        ),
      );
    },
  };

  class ReportModel {
    constructor(value) {
      Object.assign(this, value);
      this._id = `report-${++nextReportId}`;
      this.submittedAt = fixedNow;
      this.verificationStatus = "pending";
    }

    async validate() {
      if (!["symptom", "disaster"].includes(this.reportType)) {
        const error = new mongoose.Error.ValidationError(this);
        error.addError(
          "reportType",
          new mongoose.Error.ValidatorError({
            path: "reportType",
            message: "Invalid reportType.",
          }),
        );
        throw error;
      }
    }

    async save() {
      reports.push(this);
      return this;
    }

    toObject() {
      return { ...this };
    }

    static find(filter) {
      const ids = new Set((filter._id?.$in || []).map(String));
      return Promise.resolve(
        reports.filter(
          (item) => {
            if (filter.sourceId && item.sourceId !== filter.sourceId) {
              return false;
            }
            if (
              filter.sourceChannel &&
              item.sourceChannel !== filter.sourceChannel
            ) {
              return false;
            }
            if (filter._id?.$in && !ids.has(String(item._id))) {
              return false;
            }
            if (filter.submittedAt) {
              const submittedAt = new Date(item.submittedAt);
              if (
                submittedAt < filter.submittedAt.$gte ||
                submittedAt >= filter.submittedAt.$lt ||
                (filter.submittedAt.$lte &&
                  submittedAt > filter.submittedAt.$lte)
              ) {
                return false;
              }
            }
            return true;
          },
        ),
      );
    }
  }

  const service = createSourceAttributionService({
    ReportingSourceModel,
    CredentialModel,
    AttributionModel,
    ReportModel,
    now: () => new Date(fixedNow),
  });
  return {
    service,
    source,
    credentials,
    attributions,
    reports,
    AttributionModel,
  };
}

async function provision(harness) {
  return harness.service.provisionCredential({
    sourceCode: harness.source.sourceCode,
  });
}

function addCredential(harness, overrides = {}) {
  const credentialId = "a".repeat(24);
  const secret = "b".repeat(43);
  const credential = {
    credentialId,
    reportingSourceId: harness.source._id,
    secretHash: createHash("sha256").update(secret, "utf8").digest("hex"),
    revokedAt: null,
    ...overrides,
  };
  harness.credentials.push(credential);
  return { credentialId, credential: `nsq_${credentialId}.${secret}` };
}

test("generates a high-entropy credential and stores only its cryptographic hash", async () => {
  const harness = createHarness();
  const provisioned = await provision(harness);
  const saved = harness.credentials[0];

  assert.match(provisioned.credential, /^nsq_[a-f0-9]{24}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(provisioned.credentialId, saved.credentialId);
  assert.match(saved.secretHash, /^[a-f0-9]{64}$/);
  assert.equal(saved.secretHash.includes(provisioned.credential), false);
  assert.equal(JSON.stringify(saved).includes(provisioned.credential), false);
});

test("authenticates a valid source credential and assigns attribution server-side", async () => {
  const harness = createHarness();
  const provisioned = await provision(harness);
  const result = await harness.service.attributeReport({
    credential: provisioned.credential,
    reportData: {
      reportType: "symptom",
      symptoms: ["fever"],
      severity: "mild",
    },
  });

  assert.equal(result.report.sourceId, harness.source.sourceCode);
  assert.equal(result.report.sourceChannel, "official_api");
  assert.equal(result.report.verificationStatus, "pending");
  assert.equal(result.attribution.sourceCode, harness.source.sourceCode);
  assert.equal(harness.attributions.length, 1);
  assert.equal(harness.attributions[0].outcome, "accepted");
  assert.equal(
    harness.attributions[0].reason,
    "source_credential_authenticated",
  );
  assert.equal(harness.attributions[0].sourceWasActive, true);
  assert.equal(harness.attributions[0].sourceWasWithinValidity, true);
});

test("rejects invalid and missing credentials and records no report", async () => {
  for (const [credential, reason] of [
    ["invalid-token", "invalid_credential"],
    [undefined, "missing_credential"],
  ]) {
    const harness = createHarness();
    await assert.rejects(
      harness.service.attributeReport({
        credential,
        reportData: { reportType: "symptom", symptoms: ["fever"] },
      }),
      (error) =>
        error instanceof SourceAttributionError &&
        error.code === reason,
    );
    assert.equal(harness.reports.length, 0);
    assert.equal(harness.attributions.length, 1);
    assert.equal(harness.attributions[0].outcome, "rejected");
    assert.equal(harness.attributions[0].reason, reason);
  }
});

test("rejects inactive and expired sources after authenticating the credential", async () => {
  const cases = [
    [{ isActive: false }, "source_inactive"],
    [{ validUntil: new Date("2026-10-29T23:59:59.000Z") }, "source_expired"],
    [{ validFrom: new Date("2026-11-01T00:00:00.000Z") }, "source_not_yet_valid"],
  ];

  for (const [sourceOverrides, expectedCode] of cases) {
    const harness = createHarness({ sourceOverrides });
    const provisioned = addCredential(harness);
    await assert.rejects(
      harness.service.attributeReport({
        credential: provisioned.credential,
        reportData: { reportType: "symptom", symptoms: ["fever"] },
      }),
      (error) => error.code === expectedCode,
    );
    assert.equal(harness.reports.length, 0);
    assert.equal(harness.attributions.at(-1).reason, expectedCode);
  }
});

test("client-supplied source identifiers and channels cannot override authenticated source", async () => {
  const harness = createHarness();
  const provisioned = await provision(harness);

  await assert.rejects(
    harness.service.attributeReport({
      credential: provisioned.credential,
      reportData: {
        reportType: "symptom",
        symptoms: ["fever"],
        sourceId: "ATTACKER-CHOSEN-SOURCE",
      },
    }),
    (error) => error.code === "attribution_fields_not_allowed",
  );
  await assert.rejects(
    harness.service.attributeReport({
      credential: provisioned.credential,
      reportData: {
        reportType: "symptom",
        symptoms: ["fever"],
        sourceChannel: "official_api",
      },
    }),
    (error) => error.code === "attribution_fields_not_allowed",
  );
  assert.equal(harness.reports.length, 0);
  assert.equal(harness.attributions.at(-1).outcome, "rejected");
});

test("does not store raw credentials in successful or rejected audit records", async () => {
  const harness = createHarness();
  const provisioned = await provision(harness);
  await harness.service.attributeReport({
    credential: provisioned.credential,
    reportData: { reportType: "symptom", symptoms: ["fever"] },
  });

  await assert.rejects(
    harness.service.attributeReport({
      credential: `${provisioned.credential.slice(0, -1)}x`,
      reportData: { reportType: "symptom", symptoms: ["fever"] },
    }),
    { code: "invalid_credential" },
  );
  assert.equal(
    JSON.stringify(harness.attributions).includes(provisioned.credential),
    false,
  );
  assert.equal(
    JSON.stringify(harness.attributions).includes("secretHash"),
    false,
  );
});

test("invalid report data is audited and never persisted as trusted", async () => {
  const harness = createHarness();
  const provisioned = await provision(harness);

  await assert.rejects(
    harness.service.attributeReport({
      credential: provisioned.credential,
      reportData: { reportType: "unknown" },
    }),
    { code: "invalid_report" },
  );
  assert.equal(harness.reports.length, 0);
  assert.equal(harness.attributions.at(-1).reason, "invalid_report");
});

test("trusted report lookup requires successful audit and server-assigned attribution", async () => {
  const trustedReport = {
    _id: "trusted-report",
    sourceId: "CLINIC-TRUSTED",
    sourceChannel: "official_api",
    submittedAt: fixedNow,
  };
  const publicReport = {
    _id: "public-report",
    sourceChannel: "web",
    submittedAt: fixedNow,
  };
  const forgedAttribution = {
    reportId: "unverified-report",
    reportingSourceId: "source-document-id",
    sourceCode: "CLINIC-TRUSTED",
    method: "source_api_key",
    outcome: "rejected",
    reason: "invalid_credential",
    sourceWasActive: true,
    sourceWasWithinValidity: true,
  };
  const harness = createHarness({
    existingReports: [trustedReport, publicReport],
    existingAttributions: [
      {
        reportId: trustedReport._id,
        reportingSourceId: "source-document-id",
        sourceCode: "CLINIC-TRUSTED",
        method: "source_api_key",
        outcome: "accepted",
        reason: "source_credential_authenticated",
        sourceWasActive: true,
        sourceWasWithinValidity: true,
      },
      forgedAttribution,
    ],
  });

  const result = await harness.service.getTrustedReports({
    sourceCode: "CLINIC-TRUSTED",
  });

  assert.deepEqual(result.reports.map((report) => report._id), [
    "trusted-report",
  ]);
  assert.deepEqual([...result.trustedReportIds], ["trusted-report"]);
  assert.equal(result.reports.includes(publicReport), false);
});

test("trusted report IDs remain compatible with the completeness calculator", async () => {
  const report = {
    _id: "trusted-counted-report",
    sourceId: "CLINIC-TRUSTED",
    sourceChannel: "official_api",
    submittedAt: "2026-10-30T02:00:00.000Z",
  };
  const harness = createHarness({
    existingReports: [report],
    existingAttributions: [
      {
        reportId: report._id,
        reportingSourceId: "source-document-id",
        sourceCode: "CLINIC-TRUSTED",
        method: "source_api_key",
        outcome: "accepted",
        reason: "source_credential_authenticated",
        sourceWasActive: true,
        sourceWasWithinValidity: true,
      },
    ],
  });
  const trusted = await harness.service.getTrustedReports({
    sourceCode: "CLINIC-TRUSTED",
  });
  const completeness = calculateReportingCompleteness({
    sources: [
      {
        sourceCode: "CLINIC-TRUSTED",
        isActive: true,
        validFrom: "2026-01-01T00:00:00.000Z",
        reportingSchedule: {
          frequency: "daily",
          expectedReportsPerPeriod: 10,
          timezone: "UTC",
        },
      },
    ],
    reports: trusted.reports,
    trustedReportIds: trusted.trustedReportIds,
    now: fixedNow,
  })[0];

  assert.equal(completeness.receivedReports, 1);
});

test("bounded trusted lookup confirms source, successful audit, and query coverage", async () => {
  const trustedReport = {
    _id: "range-trusted",
    sourceId: "CLINIC-TRUSTED",
    sourceChannel: "official_api",
    submittedAt: "2026-10-30T02:00:00.000Z",
  };
  const untrustedReport = {
    _id: "range-untrusted",
    sourceId: "CLINIC-TRUSTED",
    sourceChannel: "official_api",
    submittedAt: "2026-10-30T03:00:00.000Z",
  };
  const harness = createHarness({
    existingReports: [trustedReport, untrustedReport],
    existingAttributions: [
      {
        reportId: trustedReport._id,
        reportingSourceId: "source-document-id",
        sourceCode: "CLINIC-TRUSTED",
        method: "source_api_key",
        outcome: "accepted",
        reason: "source_credential_authenticated",
        sourceWasActive: true,
        sourceWasWithinValidity: true,
        attributedAt: "2026-10-30T02:00:01.000Z",
        credentialId: "credential-ref",
      },
      {
        reportId: untrustedReport._id,
        reportingSourceId: "source-document-id",
        sourceCode: "CLINIC-TRUSTED",
        method: "source_api_key",
        outcome: "rejected",
        reason: "invalid_credential",
        sourceWasActive: true,
        sourceWasWithinValidity: true,
      },
    ],
  });
  const result = await harness.service.getTrustedReports({
    sourceCode: "CLINIC-TRUSTED",
    periodStart: "2026-10-30T00:00:00.000Z",
    periodEnd: "2026-10-31T00:00:00.000Z",
    asOf: "2026-10-30T23:59:59.999Z",
  });

  assert.equal(result.queryCompleted, true);
  assert.equal(result.sourceCode, "CLINIC-TRUSTED");
  assert.deepEqual(result.reports.map((item) => item._id), ["range-trusted"]);
  assert.deepEqual([...result.trustedReportIds], ["range-trusted"]);
  assert.equal(result.trustedAttributions[0].attributedAt, "2026-10-30T02:00:01.000Z");
  assert.deepEqual(result.queryWindow, {
    start: new Date("2026-10-30T00:00:00.000Z"),
    end: new Date("2026-10-31T00:00:00.000Z"),
    asOf: new Date("2026-10-30T23:59:59.999Z"),
  });
});

test("credential revocation prevents subsequent authentication", async () => {
  const harness = createHarness();
  const provisioned = await provision(harness);

  assert.equal(
    await harness.service.revokeCredential({
      credentialId: provisioned.credentialId,
    }),
    true,
  );
  await assert.rejects(
    harness.service.attributeReport({
      credential: provisioned.credential,
      reportData: { reportType: "symptom", symptoms: ["fever"] },
    }),
    { code: "credential_revoked" },
  );
  assert.equal(harness.reports.length, 0);
  assert.equal(harness.attributions.at(-1).reason, "credential_revoked");
});

test("expired credentials cannot authenticate", async () => {
  const harness = createHarness();
  const provisioned = addCredential(harness, {
    expiresAt: new Date("2026-10-30T03:39:59.000Z"),
  });

  await assert.rejects(
    harness.service.attributeReport({
      credential: provisioned.credential,
      reportData: { reportType: "symptom", symptoms: ["fever"] },
    }),
    { code: "credential_expired" },
  );
  assert.equal(harness.reports.length, 0);
});

test("audit persistence failure does not return a successful attribution", async () => {
  const harness = createHarness({ auditFailure: true });
  const provisioned = await provision(harness);

  await assert.rejects(
    harness.service.attributeReport({
      credential: provisioned.credential,
      reportData: { reportType: "symptom", symptoms: ["fever"] },
    }),
    { code: "attribution_persistence_failed" },
  );
  assert.equal(harness.reports.length, 1);
  const trusted = await harness.service.getTrustedReports({
    sourceCode: harness.source.sourceCode,
  });
  assert.deepEqual(trusted.reports, []);
});

test("secret hashes are excluded from normal credential queries", async () => {
  assert.equal(
    ReportingSourceCredential.schema.path("secretHash").options.select,
    false,
  );
});
