const test = require("node:test");
const assert = require("node:assert/strict");
const Investigator = require("../models/Investigator");
const InvestigatorSession = require("../models/InvestigatorSession");
const InvestigationAudit = require("../models/InvestigationAudit");
const InvestigatorBootstrap = require("../models/InvestigatorBootstrap");

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
