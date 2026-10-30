const test = require("node:test");
const assert = require("node:assert/strict");
const Investigator = require("../models/Investigator");
const InvestigatorSession = require("../models/InvestigatorSession");
const InvestigationAudit = require("../models/InvestigationAudit");
const InvestigatorBootstrap = require("../models/InvestigatorBootstrap");
const Investigation = require("../models/Investigation");
const InvestigationReview = require("../models/InvestigationReview");

test("investigator model stores only a hidden password hash and constrained roles", () => {
  const schema = Investigator.schema;

  assert.equal(schema.path("passwordHash").options.select, false);
  assert.deepEqual(schema.path("role").enumValues, [
    "admin",
    "investigator",
    "viewer",
  ]);
  assert.deepEqual(schema.path("status").enumValues, ["active", "inactive"]);
  assert.equal(schema.path("email").options.lowercase, true);
  assert.ok(schema.indexes().some(([index, options]) => index.email === 1 && options.unique));
  assert.ok(schema.path("sourceCodes"));
});

test("investigator sessions hash bearer tokens and expire automatically", () => {
  const schema = InvestigatorSession.schema;

  assert.equal(schema.path("tokenHash").options.select, false);
  assert.equal(schema.path("expiresAt").instance, "Date");
  assert.ok(
    schema.indexes().some(
      ([index, options]) =>
        index.expiresAt === 1 && options.expireAfterSeconds === 0,
    ),
  );
});

test("investigation audits contain safe request metadata, not report or credential data", () => {
  const schema = InvestigationAudit.schema;
  const fieldNames = Object.keys(schema.paths);

  assert.deepEqual(schema.path("outcome").enumValues, ["success", "failure"]);
  assert.ok(schema.path("investigatorId"));
  assert.ok(schema.path("sourceCode"));
  assert.ok(schema.path("requestId"));
  assert.equal(
    fieldNames.some((field) =>
      /password|token|secret|reportId|session/i.test(field),
    ),
    false,
  );
});

test("initial-admin bootstrap state is a unique one-time database claim", () => {
  const schema = InvestigatorBootstrap.schema;
  assert.equal(schema.path("_id").instance, "String");
  assert.equal(schema.path("claimToken").options.select, false);
  assert.equal(schema.path("claimedAt").instance, "Date");
});

test("investigation schema preserves legacy records and makes evidence snapshots immutable", async () => {
  const legacy = new Investigation({
    area: "legacy area",
    expectedReports: 5,
    receivedReports: 2,
    channelStatus: "unknown",
    status: "evidence_gap",
    severity: "low",
    missingReports: 3,
  });
  await legacy.validate();
  assert.equal(legacy.recordType, "legacy");

  const workflow = new Investigation({
    recordType: "evidence_review",
    investigationId: `inv_${"a".repeat(32)}`,
    sourceId: "507f1f77bcf86cd799439099",
    sourceCode: "CLINIC-1",
    createdBy: "507f1f77bcf86cd799439011",
    evaluatedAt: new Date(),
    periods: 5,
    status: "generated",
    evidenceSnapshot: { schemaVersion: "v1" },
    evidenceVersion: "v1",
  });
  await workflow.validate();
  assert.equal(Investigation.schema.path("evidenceSnapshot").options.immutable, true);
  assert.equal(Investigation.schema.path("sourceCode").options.immutable, true);
  assert.ok(
    Investigation.schema
      .indexes()
      .some(([index, options]) => index.investigationId === 1 && options.unique),
  );
  await assert.rejects(
    new Investigation({
      recordType: "evidence_review",
      status: "generated",
    }).validate(),
  );
});

test("review records validate actions and reject normal update and delete operations", async () => {
  const created = new InvestigationReview({
    investigationId: `inv_${"a".repeat(32)}`,
    reviewerId: "507f1f77bcf86cd799439011",
    action: "investigation_created",
    newStatus: "generated",
  });
  await created.validate();
  await assert.rejects(
    new InvestigationReview({
      investigationId: `inv_${"a".repeat(32)}`,
      reviewerId: "507f1f77bcf86cd799439011",
      action: "decision_recorded",
      decision: "other",
    }).validate(),
  );

  created.isNew = false;
  await assert.rejects(created.save(), /append-only/);
  await assert.rejects(
    InvestigationReview.updateOne(
      { investigationId: created.investigationId },
      { $set: { note: "rewritten" } },
    ),
    /append-only/,
  );
  await assert.rejects(
    InvestigationReview.deleteMany({
      investigationId: created.investigationId,
    }),
    /append-only/,
  );
});
