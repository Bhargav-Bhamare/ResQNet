const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const {
  createAIInterpretationsRouter,
} = require("../routes/aiInterpretations");
const {
  NemotronInterpreterError,
} = require("../services/ai/nemotronInterpreter");
const { evidenceSnapshot } = require("./aiFixtures");

const INVESTIGATION_ID = `inv_${"a".repeat(32)}`;
const INVESTIGATOR_ID = "507f1f77bcf86cd799439011";
const OTHER_INVESTIGATOR_ID = "507f1f77bcf86cd799439012";
const VIEWER_ID = "507f1f77bcf86cd799439013";
const INTERPRETATION_ID = new mongoose.Types.ObjectId().toString();
const OTHER_INTERPRETATION_ID = new mongoose.Types.ObjectId().toString();

const investigators = {
  investigator: {
    id: INVESTIGATOR_ID,
    role: "investigator",
    sourceCodes: ["CLINIC-1"],
  },
  unassigned: {
    id: OTHER_INVESTIGATOR_ID,
    role: "investigator",
    sourceCodes: [],
  },
  viewer: {
    id: VIEWER_ID,
    role: "viewer",
    sourceCodes: ["CLINIC-1"],
  },
  admin: {
    id: "507f1f77bcf86cd799439014",
    role: "admin",
    sourceCodes: [],
  },
};

function query(value) {
  const controls = {};
  const result = {
    sort(value) {
      controls.sort = value;
      return result;
    },
    skip(value) {
      controls.skip = value;
      return result;
    },
    limit(value) {
      controls.limit = value;
      return result;
    },
    async lean() {
      if (!Array.isArray(value)) return value;
      let output = [...value];
      if (controls.sort) {
        output.sort(
          (left, right) =>
            new Date(right.createdAt).getTime() -
            new Date(left.createdAt).getTime(),
        );
      }
      if (controls.skip !== undefined) output = output.slice(controls.skip);
      if (controls.limit !== undefined) output = output.slice(0, controls.limit);
      return output;
    },
  };
  return result;
}

function createHarness({
  status = "under_review",
  includeInvestigation = true,
  auditFailure = false,
  interpretationFailure = false,
  providerFailure = false,
  interpreterOverride = {},
} = {}) {
  const calls = { prepared: 0, inference: 0 };
  const records = [];
  const audits = [];
  const investigation = {
    _id: "investigation-document",
    investigationId: INVESTIGATION_ID,
    recordType: "evidence_review",
    sourceId: "507f1f77bcf86cd799439099",
    sourceCode: "CLINIC-1",
    evidenceVersion: "null-signal-evidence-package.v1",
    evidenceSnapshot: evidenceSnapshot(),
    status,
  };
  const InvestigationModel = {
    findOne(filter) {
      const sourceAllowed =
        typeof filter.sourceCode === "undefined" ||
        filter.sourceCode.$in.includes(investigation.sourceCode);
      return query(
        includeInvestigation &&
          filter.investigationId === investigation.investigationId &&
          filter.recordType === "evidence_review" &&
          sourceAllowed
          ? investigation
          : null,
      );
    },
  };
  const InterpretationModel = {
    async create(document) {
      if (interpretationFailure) throw new Error("database write unavailable");
      const saved = {
        _id: INTERPRETATION_ID,
        createdAt: new Date("2026-10-30T12:00:00.000Z"),
        ...structuredClone(document),
      };
      records.push(saved);
      return saved;
    },
    find(filter) {
      return query(
        records.filter((record) => record.investigationId === filter.investigationId),
      );
    },
    countDocuments(filter) {
      return Promise.resolve(
        records.filter((record) => record.investigationId === filter.investigationId)
          .length,
      );
    },
    findOne(filter) {
      return query(
        records.find(
          (record) =>
            record._id === String(filter._id) &&
            record.investigationId === filter.investigationId,
        ) || null,
      );
    },
  };
  const AuditModel = {
    async create(document) {
      if (auditFailure) throw new Error("audit write unavailable");
      audits.push(structuredClone(document));
      return document;
    },
  };
  const interpreter = {
    prepareInterpretation(snapshot, version) {
      calls.prepared += 1;
      assert.equal(snapshot, investigation.evidenceSnapshot);
      assert.equal(version, investigation.evidenceVersion);
      return {
        attemptId: "123e4567-e89b-12d3-a456-426614174000",
        evidenceHash: "a".repeat(64),
        sanitized: {},
      };
    },
    async interpretPreparedEvidence() {
      calls.inference += 1;
      if (providerFailure) {
        throw new NemotronInterpreterError(
          "PROVIDER_TIMEOUT",
          "provider details",
          {
            status: 504,
            providerError: "REQUEST_TIMEOUT",
          },
        );
      }
      return {
        provider: "nebius",
        model: "nvidia/Nemotron-3_5-Lightning",
        promptVersion: "1.0",
        schemaVersion: "1.0",
        evidenceVersion: investigation.evidenceVersion,
        evidenceHash: "a".repeat(64),
        interpretation: {
          headline: "Validated synthetic interpretation",
          observedFacts: [],
        },
        validationStatus: "validated",
        validationWarnings: [],
        providerRequestId: "chatcmpl-test",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        latencyMs: 1200,
      };
    },
    ...interpreterOverride,
  };
  const authenticate = (request, response, next) => {
    const token = request.get("authorization")?.replace(/^Bearer /, "");
    const investigator = investigators[token];
    if (!investigator) {
      return response.status(401).json({ error: "Authentication required." });
    }
    request.investigator = investigator;
    return next();
  };
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.use(
    "/api/investigations",
    createAIInterpretationsRouter({
      InvestigationModel,
      InterpretationModel,
      AuditModel,
      interpreter,
      authenticate,
      env: {
        NEBIUS_API_KEY: "not-used-by-fake-interpreter",
        NEBIUS_MODEL: "nvidia/Nemotron-3_5-Lightning",
      },
    }),
  );
  return { app, calls, records, audits, investigation };
}

async function withServer(app, run) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}/api/investigations`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function headers(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

test("generation uses stored evidence and persists a new validated interpretation plus safe audit", async () => {
  const harness = createHarness();
  await withServer(harness.app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/${INVESTIGATION_ID}/interpretations`,
      {
        method: "POST",
        headers: headers("investigator", { "Content-Type": "application/json" }),
        body: "{}",
      },
    );
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(harness.calls.prepared, 1);
    assert.equal(harness.calls.inference, 1);
    assert.equal(harness.records.length, 1);
    assert.equal(harness.records[0].requestedBy, INVESTIGATOR_ID);
    assert.equal(harness.records[0].validationStatus, "validated");
    assert.equal(harness.records[0].model, "nvidia/Nemotron-3_5-Lightning");
    assert.equal(harness.audits.length, 2);
    assert.deepEqual(
      harness.audits.map((audit) => audit.stage),
      ["started", "succeeded"],
    );
    assert.equal(harness.audits[0].evidenceHash, "a".repeat(64));
    assert.equal(harness.audits.some((audit) => "prompt" in audit), false);
    assert.equal(body.interpretation.id, INTERPRETATION_ID);
    assert.equal(body.interpretation.usage.totalTokens, 30);
  });
});

test("explicit regeneration appends a new record without modifying prior interpretation", async () => {
  const harness = createHarness();
  await withServer(harness.app, async (baseUrl) => {
    for (let requestNumber = 0; requestNumber < 2; requestNumber += 1) {
      const response = await fetch(
        `${baseUrl}/${INVESTIGATION_ID}/interpretations`,
        {
          method: "POST",
          headers: headers("investigator"),
        },
      );
      assert.equal(response.status, 201);
    }

    assert.equal(harness.records.length, 2);
    assert.equal(harness.calls.inference, 2);
    assert.deepEqual(
      harness.records[0].interpretation,
      harness.records[1].interpretation,
    );
    assert.notEqual(harness.records[0], harness.records[1]);
  });
});

test("authentication, source access, and viewer role prevent paid inference", async () => {
  const harness = createHarness();
  await withServer(harness.app, async (baseUrl) => {
    const missingAuth = await fetch(
      `${baseUrl}/${INVESTIGATION_ID}/interpretations`,
      { method: "POST" },
    );
    const viewer = await fetch(
      `${baseUrl}/${INVESTIGATION_ID}/interpretations`,
      {
        method: "POST",
        headers: headers("viewer"),
      },
    );
    const unassigned = await fetch(
      `${baseUrl}/${INVESTIGATION_ID}/interpretations`,
      {
        method: "POST",
        headers: headers("unassigned"),
      },
    );

    assert.equal(missingAuth.status, 401);
    assert.equal(viewer.status, 403);
    assert.equal(unassigned.status, 404);
    assert.equal(harness.calls.inference, 0);
    assert.equal(harness.records.length, 0);
  });
});

test("viewer can read bounded history but cannot generate", async () => {
  const harness = createHarness();
  harness.records.push({
    _id: INTERPRETATION_ID,
    investigationId: INVESTIGATION_ID,
    sourceCode: "CLINIC-1",
    requestedBy: INVESTIGATOR_ID,
    provider: "nebius",
    model: "nvidia/Nemotron-3_5-Lightning",
    promptVersion: "1.0",
    schemaVersion: "1.0",
    evidenceVersion: "v1",
    evidenceHash: "a".repeat(64),
    interpretation: { headline: "Saved record" },
    validationStatus: "validated",
    validationWarnings: [],
    usage: { totalTokens: 2 },
    createdAt: new Date(),
  });
  await withServer(harness.app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/${INVESTIGATION_ID}/interpretations?limit=1`,
      { headers: headers("viewer") },
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.interpretations.length, 1);
    assert.equal(body.pagination.limit, 1);
    assert.equal(harness.calls.inference, 0);
  });
});

test("generation rejects client-supplied evidence, identity, closed investigations, and invalid IDs", async () => {
  const harness = createHarness();
  await withServer(harness.app, async (baseUrl) => {
    const suppliedData = await fetch(
      `${baseUrl}/${INVESTIGATION_ID}/interpretations`,
      {
        method: "POST",
        headers: headers("investigator", { "Content-Type": "application/json" }),
        body: JSON.stringify({
          investigatorId: "spoofed",
          evidence: { synthetic: true },
          sourceCode: "OTHER",
        }),
      },
    );
    const invalidId = await fetch(
      `${baseUrl}/not-an-investigation/interpretations`,
      {
        method: "POST",
        headers: headers("investigator"),
      },
    );
    assert.equal(suppliedData.status, 400);
    assert.equal(invalidId.status, 400);
    assert.equal(harness.calls.inference, 0);

    harness.investigation.status = "closed";
    const closed = await fetch(
      `${baseUrl}/${INVESTIGATION_ID}/interpretations`,
      {
        method: "POST",
        headers: headers("investigator"),
      },
    );
    assert.equal(closed.status, 409);
    assert.equal(harness.calls.inference, 0);
  });
});

test("provider failure is audited and never persisted as a successful interpretation", async () => {
  const harness = createHarness({ providerFailure: true });
  await withServer(harness.app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/${INVESTIGATION_ID}/interpretations`,
      {
        method: "POST",
        headers: headers("investigator"),
      },
    );
    const body = await response.json();
    assert.equal(response.status, 504);
    assert.equal(body.code, "PROVIDER_TIMEOUT");
    assert.equal(harness.records.length, 0);
    assert.deepEqual(
      harness.audits.map((audit) => audit.stage),
      ["started", "failed"],
    );
    assert.equal(JSON.stringify(body).includes("provider details"), false);
  });
});

test("persistence and audit failures fail closed without fake success responses", async () => {
  const persistenceFailure = createHarness({ interpretationFailure: true });
  await withServer(persistenceFailure.app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/${INVESTIGATION_ID}/interpretations`,
      {
        method: "POST",
        headers: headers("investigator"),
      },
    );
    assert.equal(response.status, 503);
    assert.equal(persistenceFailure.records.length, 0);
    assert.equal(persistenceFailure.audits.at(-1).stage, "failed");
  });

  const auditFailure = createHarness({ auditFailure: true });
  await withServer(auditFailure.app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/${INVESTIGATION_ID}/interpretations`,
      {
        method: "POST",
        headers: headers("investigator"),
      },
    );
    assert.equal(response.status, 503);
    assert.equal(auditFailure.calls.inference, 0);
    assert.equal(auditFailure.records.length, 0);
  });
});

test("history pagination and cross-investigation retrieval are enforced", async () => {
  const harness = createHarness();
  harness.records.push({
    _id: INTERPRETATION_ID,
    investigationId: INVESTIGATION_ID,
    sourceCode: "CLINIC-1",
    requestedBy: INVESTIGATOR_ID,
    provider: "nebius",
    model: "nvidia/Nemotron-3_5-Lightning",
    promptVersion: "1.0",
    schemaVersion: "1.0",
    evidenceVersion: "v1",
    evidenceHash: "a".repeat(64),
    interpretation: { headline: "Saved record" },
    validationStatus: "validated",
    validationWarnings: [],
    usage: { totalTokens: 2 },
    createdAt: new Date(),
  });
  await withServer(harness.app, async (baseUrl) => {
    const invalidPagination = await fetch(
      `${baseUrl}/${INVESTIGATION_ID}/interpretations?limit=1000`,
      { headers: headers("investigator") },
    );
    assert.equal(invalidPagination.status, 400);
    const invalidInvestigation = await fetch(
      `${baseUrl}/bad/interpretations`,
      { headers: headers("investigator") },
    );
    assert.equal(invalidInvestigation.status, 400);
    const own = await fetch(
      `${baseUrl}/${INVESTIGATION_ID}/interpretations/${INTERPRETATION_ID}`,
      { headers: headers("investigator") },
    );
    assert.equal(own.status, 200);
    const cross = await fetch(
      `${baseUrl}/${INVESTIGATION_ID}/interpretations/${OTHER_INTERPRETATION_ID}`,
      { headers: headers("investigator") },
    );
    assert.equal(cross.status, 404);
  });
});

test("simultaneous generation is rejected before a second provider call", async () => {
  let releaseProvider;
  const harness = createHarness({
    interpreterOverride: {
      async interpretPreparedEvidence() {
        harness.calls.inference += 1;
        await new Promise((resolve) => {
          releaseProvider = resolve;
        });
        return {
          provider: "nebius",
          model: "nvidia/Nemotron-3_5-Lightning",
          promptVersion: "1.0",
          schemaVersion: "1.0",
          evidenceVersion: "null-signal-evidence-package.v1",
          evidenceHash: "a".repeat(64),
          interpretation: { headline: "Validated synthetic interpretation" },
          validationStatus: "validated",
          validationWarnings: [],
          providerRequestId: "chatcmpl-test",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          latencyMs: 1,
        };
      },
    },
  });
  await withServer(harness.app, async (baseUrl) => {
    const first = fetch(`${baseUrl}/${INVESTIGATION_ID}/interpretations`, {
      method: "POST",
      headers: headers("investigator"),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await fetch(
      `${baseUrl}/${INVESTIGATION_ID}/interpretations`,
      {
        method: "POST",
        headers: headers("investigator"),
      },
    );
    assert.equal(second.status, 409);
    releaseProvider();
    const firstResponse = await first;
    assert.equal(firstResponse.status, 201);
    assert.equal(harness.calls.inference, 1);
  });
});
