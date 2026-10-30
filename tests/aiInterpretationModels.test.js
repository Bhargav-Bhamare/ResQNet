const test = require("node:test");
const assert = require("node:assert/strict");
const AIInterpretation = require("../models/AIInterpretation");
const AIInterpretationAudit = require("../models/AIInterpretationAudit");
const { evidenceSnapshot, interpretationOutput } = require("./aiFixtures");
const {
  sanitizeEvidenceSnapshot,
  EVIDENCE_VERSION,
} = require("../services/ai/evidenceSanitizer");
const { validateInterpretationOutput } = require("../services/ai/interpretationValidator");

const INVESTIGATION_ID = `inv_${"a".repeat(32)}`;
const INVESTIGATOR_ID = "507f1f77bcf86cd799439011";
const SOURCE_ID = "507f1f77bcf86cd799439099";

function validInterpretationDocument() {
  const evidence = sanitizeEvidenceSnapshot(
    evidenceSnapshot(),
    EVIDENCE_VERSION,
  );
  const validated = validateInterpretationOutput(
    JSON.stringify(interpretationOutput(evidence.sanitized)),
    {
      evidence: evidence.sanitized,
      availableReferences: evidence.availableReferences,
    },
  );
  return {
    investigationId: INVESTIGATION_ID,
    sourceId: SOURCE_ID,
    sourceCode: "SYNTHETIC-SOURCE",
    requestedBy: INVESTIGATOR_ID,
    provider: "nebius",
    model: "nvidia/Nemotron-3_5-Lightning",
    promptVersion: "1.0",
    schemaVersion: "1.0",
    evidenceVersion: EVIDENCE_VERSION,
    evidenceHash: "a".repeat(64),
    interpretation: validated.interpretation,
    validationStatus: "validated",
    providerRequestId: "chatcmpl-synthetic",
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    latencyMs: 1200,
  };
}

test("AI interpretation model stores validated output and provider metadata", async () => {
  const record = new AIInterpretation(validInterpretationDocument());
  await record.validate();

  assert.equal(record.validationStatus, "validated");
  assert.equal(record.usage.totalTokens, 30);
  assert.equal(record.interpretation.observedFacts[0].value, 0);
  assert.ok(
    AIInterpretation.schema
      .indexes()
      .some(
        ([index]) =>
          index.investigationId === 1 &&
          index.createdAt === -1 &&
          index._id === -1,
      ),
  );
});

test("AI interpretation model rejects invalid model, evidence hash, and enum values", async () => {
  const invalidModel = new AIInterpretation({
    ...validInterpretationDocument(),
    model: "",
  });
  await assert.rejects(invalidModel.validate());

  const invalidHash = new AIInterpretation({
    ...validInterpretationDocument(),
    evidenceHash: "not-a-hash",
  });
  await assert.rejects(invalidHash.validate());

  const invalidFinding = new AIInterpretation(validInterpretationDocument());
  invalidFinding.interpretation.findingType = "outbreak_confirmed";
  await assert.rejects(invalidFinding.validate());
});

test("AI interpretations and their audit records are append-only", async () => {
  const record = new AIInterpretation(validInterpretationDocument());
  record.isNew = false;
  await assert.rejects(record.save(), /append-only/);

  const audit = new AIInterpretationAudit({
    attemptId: "123e4567-e89b-12d3-a456-426614174000",
    investigatorId: INVESTIGATOR_ID,
    sourceCode: "SYNTHETIC-SOURCE",
    investigationId: INVESTIGATION_ID,
    stage: "started",
    requestedAt: new Date(),
  });
  await audit.validate();
  audit.isNew = false;
  await assert.rejects(audit.save(), /append-only/);
});

test("AI audit schema contains only operational metadata, not prompts or secrets", () => {
  const fields = Object.keys(AIInterpretationAudit.schema.paths);
  assert.equal(
    fields.some((field) =>
      /password|secret|systemPrompt|userPrompt|rawReport|reportBody|sessionToken|apiKey/i.test(
        field,
      ),
    ),
    false,
  );
  assert.ok(AIInterpretationAudit.schema.path("evidenceHash"));
  assert.ok(AIInterpretationAudit.schema.path("providerRequestId"));
  assert.ok(AIInterpretationAudit.schema.path("investigatorId"));
});
