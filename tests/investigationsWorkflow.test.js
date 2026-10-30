const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const {
  createEvidenceInvestigationsRouter,
} = require("../routes/evidenceInvestigations");
const {
  createInvestigationsRouter,
} = require("../routes/investigations");
const { app: serverApp } = require("../server");

const NOW = new Date("2026-10-30T12:00:00.000Z");
const CREATOR_ID = "507f1f77bcf86cd799439011";
const OTHER_ID = "507f1f77bcf86cd799439012";
const ADMIN_ID = "507f1f77bcf86cd799439013";
const SOURCE = {
  _id: "507f1f77bcf86cd799439099",
  sourceCode: "CLINIC-WORKFLOW",
  name: "Workflow clinic",
  isActive: true,
  validFrom: new Date("2020-01-01T00:00:00.000Z"),
  reportingSchedule: {
    frequency: "daily",
    expectedReportsPerPeriod: 10,
    reportingTime: "17:00",
    timezone: "UTC",
  },
};

const USERS = {
  creator: {
    id: CREATOR_ID,
    name: "Creator",
    email: "creator@example.org",
    role: "investigator",
    status: "active",
    sourceCodes: [SOURCE.sourceCode],
  },
  other: {
    id: OTHER_ID,
    name: "Other",
    email: "other@example.org",
    role: "investigator",
    status: "active",
    sourceCodes: [],
  },
  admin: {
    id: ADMIN_ID,
    name: "Admin",
    email: "admin@example.org",
    role: "admin",
    status: "active",
    sourceCodes: [],
  },
  viewer: {
    id: "507f1f77bcf86cd799439014",
    name: "Viewer",
    email: "viewer@example.org",
    role: "viewer",
    status: "active",
    sourceCodes: [SOURCE.sourceCode],
  },
};

function matches(document, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = document[key];
    if (
      expected &&
      typeof expected === "object" &&
      Object.hasOwn(expected, "$in")
    ) {
      return expected.$in.includes(actual);
    }
    return String(actual ?? "") === String(expected ?? "");
  });
}

function createQuery(value, controls = {}) {
  const query = {
    select() {
      return query;
    },
    sort(sort) {
      controls.sort = sort;
      return query;
    },
    skip(skip) {
      controls.skip = skip;
      return query;
    },
    limit(limit) {
      controls.limit = limit;
      return query;
    },
    async lean() {
      let result = Array.isArray(value) ? [...value] : value;
      if (Array.isArray(result) && controls.sort) {
        const [key, direction] = Object.entries(controls.sort)[0];
        result.sort((left, right) => {
          const compare = new Date(left[key]).getTime() - new Date(right[key]).getTime();
          return compare === 0
            ? String(left._id).localeCompare(String(right._id)) * direction
            : compare * direction;
        });
      }
      if (Array.isArray(result) && controls.skip !== undefined) {
        result = result.slice(controls.skip);
      }
      if (Array.isArray(result) && controls.limit !== undefined) {
        result = result.slice(0, controls.limit);
      }
      return result;
    },
  };
  return query;
}

function createModels({ failReviewCreate = false } = {}) {
  const investigations = [];
  const reviews = [];
  let nextId = 1;
  let reviewWriteFailure = failReviewCreate;
  const InvestigationModel = {
    async create(document) {
      const saved = {
        _id: `db-investigation-${nextId++}`,
        createdAt: NOW,
        updatedAt: NOW,
        assignedTo: null,
        ...structuredClone(document),
      };
      investigations.push(saved);
      return saved;
    },
    async deleteOne(filter) {
      const index = investigations.findIndex((item) => item._id === filter._id);
      if (index >= 0) investigations.splice(index, 1);
      return { deletedCount: index >= 0 ? 1 : 0 };
    },
    findOne(filter) {
      return createQuery(
        investigations.find((item) => matches(item, filter)) || null,
      );
    },
    find(filter) {
      return createQuery(
        investigations.filter((item) => matches(item, filter)),
        {},
      );
    },
    countDocuments(filter) {
      return Promise.resolve(
        investigations.filter((item) => matches(item, filter)).length,
      );
    },
    findOneAndUpdate(filter, update) {
      const record = investigations.find((item) => matches(item, filter));
      if (record) {
        Object.assign(record, structuredClone(update.$set));
        record.updatedAt = new Date(NOW.getTime() + 1000);
      }
      return createQuery(record || null);
    },
  };
  const ReviewModel = {
    async create(document) {
      if (reviewWriteFailure) throw new Error("review persistence failed");
      const saved = {
        _id: `db-review-${reviews.length + 1}`,
        createdAt: new Date(NOW.getTime() + reviews.length * 1000),
        ...structuredClone(document),
      };
      reviews.push(saved);
      return saved;
    },
    find(filter) {
      return createQuery(
        reviews.filter((item) => matches(item, filter)),
        {},
      );
    },
    countDocuments(filter) {
      return Promise.resolve(
        reviews.filter((item) => matches(item, filter)).length,
      );
    },
    collection: {
      async deleteOne(filter) {
        const index = reviews.findIndex((item) =>
          matches(item, filter),
        );
        if (index >= 0) reviews.splice(index, 1);
        return { deletedCount: index >= 0 ? 1 : 0 };
      },
    },
  };
  const InvestigatorModel = {
    findById(id) {
      const investigator = Object.values(USERS).find(
        (user) => user.id === String(id),
      );
      return createQuery(
        investigator
          ? {
              _id: investigator.id,
              role: investigator.role,
              status: investigator.status,
              sourceCodes: investigator.sourceCodes,
            }
          : null,
      );
    },
  };
  return {
    InvestigationModel,
    ReviewModel,
    InvestigatorModel,
    investigations,
    reviews,
    setReviewWriteFailure(value) {
      reviewWriteFailure = value;
    },
  };
}

function createAuth() {
  return {
    async authenticateToken(token) {
      const user =
        token === "creator"
          ? USERS.creator
          : token === "other"
            ? USERS.other
            : token === "viewer"
              ? USERS.viewer
              : token === "admin"
                ? USERS.admin
                : null;
      return user ? { investigator: user, sessionId: `${token}-session` } : null;
    },
    async hashPassword(value) {
      return value;
    },
    async logout() {},
    async revokeInvestigatorSessions() {},
  };
}

function evidencePackage(evaluatedAt = NOW) {
  return {
    schemaVersion: "null-signal-evidence-package.v1",
    packageId: "ep_fixture",
    metadata: {
      evaluatedAt: evaluatedAt.toISOString(),
      sourceCode: SOURCE.sourceCode,
    },
    evidence: {
      trustedObservationReferences: [{ id: "trusted-report-id" }],
    },
    calculatedFindings: {
      anomaly: { type: "zero_report_period" },
    },
  };
}

function createApp(options = {}) {
  const app = express();
  app.use(express.json());
  const models = options.models || createModels(options);
  const audits = [];
  const AuditModel = {
    async create(document) {
      if (options.auditFailure) throw new Error("audit unavailable");
      audits.push(structuredClone(document));
      return document;
    },
  };
  const pipelineCalls = [];
  const evidencePipeline = {
    async generateEvidenceForSource(input) {
      pipelineCalls.push(input);
      if (options.pipelineFailure) {
        throw Object.assign(new Error("pipeline failed"), {
          code: options.pipelineFailure,
        });
      }
      return {
        evidencePackage:
          options.packageOverride || evidencePackage(input.evaluatedAt),
      };
    },
  };
  const authenticate = async (request, response, next) => {
    const token = request.get("authorization")?.replace(/^Bearer /, "");
    const auth = await createAuth().authenticateToken(token);
    if (!auth) return response.status(401).json({ error: "Authentication required." });
    request.investigator = auth.investigator;
    request.investigatorSessionId = auth.sessionId;
    return next();
  };
  app.use(
    "/api/investigations",
    createEvidenceInvestigationsRouter({
      evidencePipeline,
      sourceAttributionService: {
        async getConfiguredSource({ sourceCode }) {
          return sourceCode === SOURCE.sourceCode ? SOURCE : null;
        },
      },
      AuditModel,
      InvestigationModel: models.InvestigationModel,
      ReviewModel: models.ReviewModel,
      authenticate,
      now: () => NOW,
    }),
  );
  app.use(
    "/api/investigations",
    createInvestigationsRouter({
      InvestigationModel: models.InvestigationModel,
      ReviewModel: models.ReviewModel,
      InvestigatorModel: models.InvestigatorModel,
      authenticate,
    }),
  );
  return { app, models, audits, pipelineCalls };
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

function authHeaders(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

async function createInvestigation(baseUrl, token = "creator", body = {}) {
  return fetch(`${baseUrl}/${SOURCE.sourceCode}`, {
    method: "POST",
    headers: authHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
}

test("POST creates a persistent investigation, immutable evidence snapshot, and initial review event", async () => {
  const { app, models, audits, pipelineCalls } = createApp();
  await withServer(app, async (baseUrl) => {
    const response = await createInvestigation(baseUrl, "creator", {
      evaluatedAt: NOW.toISOString(),
      periods: 5,
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.match(body.investigationId, /^inv_[a-f0-9]{32}$/);
    assert.equal(body.status, "generated");
    assert.deepEqual(
      models.investigations[0].evidenceSnapshot,
      body.evidencePackage,
    );
    assert.equal(models.investigations[0].recordType, "evidence_review");
    assert.equal(models.investigations[0].createdBy, USERS.creator.id);
    assert.equal(models.investigations[0].sourceCode, SOURCE.sourceCode);
    assert.equal(models.investigations[0].periods, 5);
    assert.equal(models.reviews.length, 1);
    assert.equal(models.reviews[0].action, "investigation_created");
    assert.equal(models.reviews[0].reviewerId, USERS.creator.id);
    assert.equal(models.reviews[0].newStatus, "generated");
    assert.equal(audits[0].outcome, "success");
    assert.equal(audits[0].investigationId, body.investigationId);
    assert.equal(pipelineCalls[0].sourceCode, SOURCE.sourceCode);
  });
});

test("POST rejects client-supplied source and investigator identity fields", async () => {
  const { app, models } = createApp();
  await withServer(app, async (baseUrl) => {
    const response = await createInvestigation(baseUrl, "creator", {
      sourceCode: "ATTACKER-CONTROLLED",
      createdBy: ADMIN_ID,
      assignedTo: ADMIN_ID,
      periods: 5,
    });
    assert.equal(response.status, 400);
    assert.equal(models.investigations.length, 0);
    assert.equal(models.reviews.length, 0);
  });
});

test("GET is a read-only preview and new investigations receive unique public IDs", async () => {
  const { app, models, audits } = createApp();
  await withServer(app, async (baseUrl) => {
    const preview = await fetch(
      `${baseUrl}/${SOURCE.sourceCode}/evidence?periods=2`,
      { headers: authHeaders("creator") },
    );
    assert.equal(preview.status, 200);
    assert.equal(models.investigations.length, 0);
    assert.equal(models.reviews.length, 0);

    const first = await createInvestigation(baseUrl);
    const second = await createInvestigation(baseUrl);
    const firstBody = await first.json();
    const secondBody = await second.json();
    assert.notEqual(firstBody.investigationId, secondBody.investigationId);
    assert.equal(audits.length, 3);
    assert.equal(models.investigations.length, 2);
  });
});

test("server mounts investigation history behind investigator authentication", async () => {
  await withServer(serverApp, async (baseUrl) => {
    const [list, create] = await Promise.all([
      fetch(baseUrl),
      fetch(`${baseUrl}/${SOURCE.sourceCode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periods: 2 }),
      }),
    ]);
    assert.deepEqual([list.status, create.status], [401, 401]);
  });
});

test("pipeline and persistence failures never return a successful partial investigation", async () => {
  const pipeline = createApp({ pipelineFailure: "TRUSTED_LOOKUP_FAILED" });
  await withServer(pipeline.app, async (baseUrl) => {
    const response = await createInvestigation(baseUrl);
    assert.equal(response.status, 503);
    assert.equal(pipeline.models.investigations.length, 0);
    assert.equal(pipeline.models.reviews.length, 0);
    assert.equal(pipeline.audits[0].outcome, "failure");
  });

  const invalidPackage = createApp({
    packageOverride: {
      metadata: {
        sourceCode: SOURCE.sourceCode,
        evaluatedAt: NOW.toISOString(),
      },
    },
  });
  await withServer(invalidPackage.app, async (baseUrl) => {
    const response = await createInvestigation(baseUrl);
    assert.equal(response.status, 500);
    assert.equal(invalidPackage.models.investigations.length, 0);
    assert.equal(invalidPackage.models.reviews.length, 0);
    assert.equal(invalidPackage.audits[0].outcome, "failure");
  });

  const reviewFailure = createApp({ failReviewCreate: true });
  await withServer(reviewFailure.app, async (baseUrl) => {
    const response = await createInvestigation(baseUrl);
    assert.equal(response.status, 503);
    assert.equal(reviewFailure.models.investigations.length, 0);
    assert.equal(reviewFailure.models.reviews.length, 0);
    assert.equal(reviewFailure.audits[0].outcome, "failure");
  });

  const auditFailure = createApp({ auditFailure: true });
  await withServer(auditFailure.app, async (baseUrl) => {
    const response = await createInvestigation(baseUrl);
    assert.equal(response.status, 503);
    assert.equal(auditFailure.models.investigations.length, 0);
    assert.equal(auditFailure.models.reviews.length, 0);
  });
});

test("investigation history list is paginated and supports scoped filters", async () => {
  const models = createModels();
  for (let index = 0; index < 3; index += 1) {
    await models.InvestigationModel.create({
      recordType: "evidence_review",
      investigationId: `inv_${String(index + 1).padStart(32, "0")}`,
      sourceId: SOURCE._id,
      sourceCode: SOURCE.sourceCode,
      createdBy: CREATOR_ID,
      evaluatedAt: NOW,
      periods: 5,
      status: index === 0 ? "generated" : "reviewed",
      evidenceVersion: "v1",
      evidenceSnapshot: evidencePackage(),
    });
  }
  const { app } = createApp({ models });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}?page=1&limit=1&status=reviewed&sourceCode=${SOURCE.sourceCode}`,
      { headers: authHeaders("creator") },
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.investigations.length, 1);
    assert.equal(body.pagination.total, 2);
    assert.equal(body.pagination.pages, 2);
    assert.equal(body.investigations[0].evidenceSnapshot, undefined);
  });
});

test("investigation detail returns immutable snapshot and chronological review history only to authorized sources", async () => {
  const models = createModels();
  const record = await models.InvestigationModel.create({
    recordType: "evidence_review",
    investigationId: `inv_${"a".repeat(32)}`,
    sourceId: SOURCE._id,
    sourceCode: SOURCE.sourceCode,
    createdBy: CREATOR_ID,
    evaluatedAt: NOW,
    periods: 5,
    status: "under_review",
    evidenceVersion: "v1",
    evidenceSnapshot: evidencePackage(),
  });
  await models.ReviewModel.create({
    investigationId: record.investigationId,
    reviewerId: CREATOR_ID,
    action: "investigation_created",
    newStatus: "generated",
  });
  await models.ReviewModel.create({
    investigationId: record.investigationId,
    reviewerId: CREATOR_ID,
    action: "status_changed",
    previousStatus: "generated",
    newStatus: "under_review",
  });
  const { app } = createApp({ models });

  await withServer(app, async (baseUrl) => {
    const allowed = await fetch(`${baseUrl}/${record.investigationId}`, {
      headers: authHeaders("creator"),
    });
    const detail = await allowed.json();
    assert.equal(allowed.status, 200);
    assert.deepEqual(
      detail.investigation.evidenceSnapshot,
      record.evidenceSnapshot,
    );
    assert.deepEqual(
      detail.reviewHistory.map((review) => review.action),
      ["investigation_created", "status_changed"],
    );
    assert.equal(detail.reviewHistoryTruncated, false);

    const denied = await fetch(`${baseUrl}/${record.investigationId}`, {
      headers: authHeaders("other"),
    });
    assert.equal(denied.status, 404);
    assert.deepEqual(await denied.json(), {
      error: "Investigation not found.",
    });

    const invalidDbId = await fetch(`${baseUrl}/${record._id}`, {
      headers: authHeaders("admin"),
    });
    assert.equal(invalidDbId.status, 404);
  });
});

test("notes and decisions append reviewer-owned records without changing the evidence snapshot", async () => {
  const models = createModels();
  const record = await models.InvestigationModel.create({
    recordType: "evidence_review",
    investigationId: `inv_${"b".repeat(32)}`,
    sourceId: SOURCE._id,
    sourceCode: SOURCE.sourceCode,
    createdBy: CREATOR_ID,
    evaluatedAt: NOW,
    periods: 5,
    status: "generated",
    evidenceVersion: "v1",
    evidenceSnapshot: evidencePackage(),
  });
  const originalSnapshot = structuredClone(record.evidenceSnapshot);
  const { app } = createApp({ models });
  await withServer(app, async (baseUrl) => {
    const note = await fetch(`${baseUrl}/${record.investigationId}/notes`, {
      method: "POST",
      headers: authHeaders("creator", { "Content-Type": "application/json" }),
      body: JSON.stringify({
        note: "Please confirm whether the reporting schedule was followed.",
        reviewerId: ADMIN_ID,
      }),
    });
    assert.equal(note.status, 400);

    const validNote = await fetch(`${baseUrl}/${record.investigationId}/notes`, {
      method: "POST",
      headers: authHeaders("creator", { "Content-Type": "application/json" }),
      body: JSON.stringify({
        note: "Please confirm whether the reporting schedule was followed.",
      }),
    });
    assert.equal(validNote.status, 201);
    const noteBody = await validNote.json();
    assert.equal(noteBody.review.reviewerId, CREATOR_ID);
    assert.equal(noteBody.review.action, "review_note_added");

    const decision = await fetch(
      `${baseUrl}/${record.investigationId}/decision`,
      {
        method: "POST",
        headers: authHeaders("creator", {
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          decision: "insufficient_evidence",
          note: "The channel history is unknown.",
        }),
      },
    );
    assert.equal(decision.status, 201);
    assert.equal((await decision.json()).decisionType, "investigator_assessment");
    assert.deepEqual(record.evidenceSnapshot, originalSnapshot);
    assert.equal(models.reviews.length, 2);
  });
});

test("review inputs validate note size, decision values, and explicit status transitions", async () => {
  const models = createModels();
  const record = await models.InvestigationModel.create({
    recordType: "evidence_review",
    investigationId: `inv_${"c".repeat(32)}`,
    sourceId: SOURCE._id,
    sourceCode: SOURCE.sourceCode,
    createdBy: CREATOR_ID,
    evaluatedAt: NOW,
    periods: 5,
    status: "generated",
    evidenceVersion: "v1",
    evidenceSnapshot: evidencePackage(),
  });
  const { app } = createApp({ models });
  await withServer(app, async (baseUrl) => {
    const send = (path, method, body, token = "creator") =>
      fetch(`${baseUrl}/${record.investigationId}${path}`, {
        method,
        headers: authHeaders(token, { "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });

      test("status mutation rolls back if its append-only history record cannot be stored", async () => {
        const models = createModels();
        const record = await models.InvestigationModel.create({
          recordType: "evidence_review",
          investigationId: `inv_${"f".repeat(32)}`,
          sourceId: SOURCE._id,
          sourceCode: SOURCE.sourceCode,
          createdBy: CREATOR_ID,
          evaluatedAt: NOW,
          periods: 5,
          status: "generated",
          evidenceVersion: "v1",
          evidenceSnapshot: evidencePackage(),
        });
        models.setReviewWriteFailure(true);
        const { app } = createApp({ models });
        await withServer(app, async (baseUrl) => {
          const response = await fetch(
            `${baseUrl}/${record.investigationId}/status`,
            {
              method: "PATCH",
              headers: authHeaders("creator", {
                "Content-Type": "application/json",
              }),
              body: JSON.stringify({ status: "under_review" }),
            },
          );
          assert.equal(response.status, 503);
          assert.equal(models.investigations[0].status, "generated");
          assert.equal(models.reviews.length, 0);
          assert.deepEqual(
            models.investigations[0].evidenceSnapshot,
            evidencePackage(),
          );
        });
      });

    assert.equal((await send("/notes", "POST", { note: "  " })).status, 400);
    assert.equal(
      (
        await send("/notes", "POST", {
          note: "x".repeat(5001),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await send("/decision", "POST", {
          decision: "not-a-decision",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await send("/decision", "POST", {
          decision: "other",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await send("/status", "PATCH", {
          status: "closed",
        })
      ).status,
      409,
    );
    assert.equal(
      (await send("/status", "PATCH", { status: "under_review" })).status,
      200,
    );
    assert.equal(
      (await send("/status", "PATCH", { status: "closed" })).status,
      409,
    );
    assert.equal(
      (await send("/status", "PATCH", { status: "reviewed" })).status,
      200,
    );
    assert.equal(
      (await send("/status", "PATCH", { status: "closed" })).status,
      200,
    );
    assert.equal(models.reviews.at(-1).action, "investigation_closed");
    assert.equal(
      (await send("/status", "PATCH", { status: "under_review" })).status,
      409,
    );
  });
});

test("viewers cannot mutate, investigators cannot assign, and admins assign only source-authorized investigators", async () => {
  const models = createModels();
  const record = await models.InvestigationModel.create({
    recordType: "evidence_review",
    investigationId: `inv_${"d".repeat(32)}`,
    sourceId: SOURCE._id,
    sourceCode: SOURCE.sourceCode,
    createdBy: CREATOR_ID,
    evaluatedAt: NOW,
    periods: 5,
    status: "generated",
    evidenceVersion: "v1",
    evidenceSnapshot: evidencePackage(),
  });
  const { app } = createApp({ models });
  await withServer(app, async (baseUrl) => {
    const viewerNote = await fetch(
      `${baseUrl}/${record.investigationId}/notes`,
      {
        method: "POST",
        headers: authHeaders("viewer", { "Content-Type": "application/json" }),
        body: JSON.stringify({ note: "Read-only role." }),
      },
    );
    assert.equal(viewerNote.status, 403);

    const investigatorAssignment = await fetch(
      `${baseUrl}/${record.investigationId}/assignment`,
      {
        method: "PATCH",
        headers: authHeaders("creator", {
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ assignedTo: OTHER_ID }),
      },
    );
    assert.equal(investigatorAssignment.status, 403);

    const unauthorizedAssignee = await fetch(
      `${baseUrl}/${record.investigationId}/assignment`,
      {
        method: "PATCH",
        headers: authHeaders("admin", { "Content-Type": "application/json" }),
        body: JSON.stringify({ assignedTo: OTHER_ID }),
      },
    );
    assert.equal(unauthorizedAssignee.status, 400);

    const assigned = await fetch(
      `${baseUrl}/${record.investigationId}/assignment`,
      {
        method: "PATCH",
        headers: authHeaders("admin", { "Content-Type": "application/json" }),
        body: JSON.stringify({ assignedTo: CREATOR_ID }),
      },
    );
    assert.equal(assigned.status, 200);
    assert.equal(models.investigations[0].assignedTo, CREATOR_ID);
    assert.equal(models.reviews.at(-1).action, "investigation_assigned");
    assert.equal(models.reviews.at(-1).reviewerId, ADMIN_ID);
  });
});

test("review history has a bounded dedicated read and there is no delete route", async () => {
  const models = createModels();
  const record = await models.InvestigationModel.create({
    recordType: "evidence_review",
    investigationId: `inv_${"e".repeat(32)}`,
    sourceId: SOURCE._id,
    sourceCode: SOURCE.sourceCode,
    createdBy: CREATOR_ID,
    evaluatedAt: NOW,
    periods: 5,
    status: "generated",
    evidenceVersion: "v1",
    evidenceSnapshot: evidencePackage(),
  });
  for (let index = 0; index < 3; index += 1) {
    await models.ReviewModel.create({
      investigationId: record.investigationId,
      reviewerId: CREATOR_ID,
      action: "review_note_added",
      note: `note-${index}`,
    });
  }
  const { app } = createApp({ models });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/${record.investigationId}/reviews?limit=2`,
      { headers: authHeaders("creator") },
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(
      body.reviewHistory.map((review) => review.note),
      ["note-1", "note-2"],
    );

    const invalidLimit = await fetch(
      `${baseUrl}/${record.investigationId}/reviews?limit=101`,
      { headers: authHeaders("creator") },
    );
    assert.equal(invalidLimit.status, 400);

    const remove = await fetch(`${baseUrl}/${record.investigationId}`, {
      method: "DELETE",
      headers: authHeaders("admin"),
    });
    assert.equal(remove.status, 404);
    assert.equal(models.investigations.length, 1);
    assert.equal(models.reviews.length, 3);
  });
});
