const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const {
  AuthenticationError,
} = require("../services/investigatorAuthentication");
const {
  createAuthenticationRouter,
  createLoginRateLimiter,
} = require("../routes/authentication");
const {
  createAdminInvestigatorsRouter,
} = require("../routes/adminInvestigators");
const {
  createEvidenceInvestigationsRouter,
} = require("../routes/evidenceInvestigations");

const NOW = new Date("2026-10-30T11:18:57.000Z");
const TOKEN_ADMIN = "A".repeat(43);
const TOKEN_INVESTIGATOR = "B".repeat(43);
const TOKEN_VIEWER = "C".repeat(43);
const TOKEN_INACTIVE = "D".repeat(43);
const SOURCE = {
  _id: "source-document-id",
  sourceCode: "CLINIC-ROUTE-TEST",
  name: "Configured clinic",
  isActive: true,
  validFrom: new Date("2020-01-01T00:00:00.000Z"),
  reportingSchedule: {
    frequency: "daily",
    expectedReportsPerPeriod: 10,
    reportingTime: "17:00",
    timezone: "UTC",
  },
};

const identitiesByToken = new Map([
  [
    TOKEN_ADMIN,
    {
      investigator: {
        id: "507f1f77bcf86cd799439011",
        name: "Admin",
        email: "admin@example.org",
        role: "admin",
        status: "active",
        sourceCodes: [],
      },
      sessionId: "admin-session",
    },
  ],
  [
    TOKEN_INVESTIGATOR,
    {
      investigator: {
        id: "507f1f77bcf86cd799439012",
        name: "Investigator",
        email: "investigator@example.org",
        role: "investigator",
        status: "active",
        sourceCodes: [SOURCE.sourceCode],
      },
      sessionId: "investigator-session",
    },
  ],
  [
    TOKEN_VIEWER,
    {
      investigator: {
        id: "507f1f77bcf86cd799439013",
        name: "Viewer",
        email: "viewer@example.org",
        role: "viewer",
        status: "active",
        sourceCodes: [SOURCE.sourceCode],
      },
      sessionId: "viewer-session",
    },
  ],
]);

function createAuthenticationService(overrides = {}) {
  return {
    async authenticateToken(token) {
      if (token === TOKEN_INACTIVE) return null;
      return identitiesByToken.get(token) || null;
    },
    async login() {
      throw new AuthenticationError(
        "INVALID_CREDENTIALS",
        "Email or password is incorrect.",
      );
    },
    async logout() {},
    async revokeInvestigatorSessions() {},
    async hashPassword(password) {
      return `scrypt-test-hash:${password}`;
    },
    ...overrides,
  };
}

function createEvidenceFixture(overrides = {}) {
  const audits = [];
  const pipelineCalls = [];
  const sourceCalls = [];
  const sourceService = {
    async getConfiguredSource({ sourceCode }) {
      sourceCalls.push(sourceCode);
      return sourceCode === SOURCE.sourceCode ? SOURCE : null;
    },
  };
  const pipeline = {
    async generateEvidenceForSource(input) {
      pipelineCalls.push(input);
      if (overrides.pipelineError) throw overrides.pipelineError;
      return {
        evidencePackage: {
          packageId: "package-test",
          calculatedFindings: {
            historicalBaseline: { status: "insufficient_history" },
          },
        },
      };
    },
  };
  const AuditModel = {
    async create(document) {
      if (overrides.auditError) throw overrides.auditError;
      audits.push(document);
      return document;
    },
  };
  return { audits, pipelineCalls, sourceCalls, sourceService, pipeline, AuditModel };
}

async function withServer(application, run) {
  const server = application.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function createApp({ authenticationService, router }) {
  const app = express();
  app.use(express.json());
  if (router) app.use(router);
  return app;
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

test("login endpoint returns generic errors and never exposes token on failure", async () => {
  const app = createApp({
    router: createAuthenticationRouter({
      authenticationService: createAuthenticationService(),
      loginRateLimiter: createLoginRateLimiter(),
    }),
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "unknown@example.org",
        password: "wrong password",
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(body, { error: "Email or password is incorrect." });
  });
});

test("login and logout issue and invalidate a bearer session", async () => {
  let loggedOut;
  const authService = createAuthenticationService({
    async login() {
      return {
        token: TOKEN_VIEWER,
        expiresAt: new Date("2026-10-30T19:18:57.000Z"),
        investigator: identitiesByToken.get(TOKEN_VIEWER).investigator,
      };
    },
    async logout(sessionId, investigatorId) {
      loggedOut = { sessionId, investigatorId };
    },
  });
  const app = createApp({
    router: createAuthenticationRouter({
      authenticationService: authService,
    }),
  });
  await withServer(app, async (baseUrl) => {
    const login = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "viewer@example.org",
        password: "a secure long password",
      }),
    });
    const loginBody = await login.json();
    assert.equal(login.status, 200);
    assert.equal(loginBody.token, TOKEN_VIEWER);
    assert.equal(loginBody.tokenType, "Bearer");
    assert.equal(loginBody.investigator.passwordHash, undefined);

    const logout = await fetch(`${baseUrl}/logout`, {
      method: "POST",
      headers: bearer(TOKEN_VIEWER),
    });
    assert.equal(logout.status, 204);
    assert.deepEqual(loggedOut, {
      sessionId: "viewer-session",
      investigatorId: "507f1f77bcf86cd799439013",
    });
  });
});

test("login endpoint validates payloads and rate-limits attempts", async () => {
  let logins = 0;
  const app = createApp({
    router: createAuthenticationRouter({
      authenticationService: createAuthenticationService({
        async login() {
          logins += 1;
          throw new AuthenticationError(
            "INVALID_CREDENTIALS",
            "Email or password is incorrect.",
          );
        },
      }),
      loginRateLimiter: createLoginRateLimiter({
        maximumAttempts: 2,
        windowMs: 60_000,
      }),
    }),
  });
  await withServer(app, async (baseUrl) => {
    const request = () =>
      fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "analyst@example.org",
          password: "incorrect password",
        }),
      });
    assert.equal((await request()).status, 401);
    assert.equal((await request()).status, 401);
    const limited = await request();

    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    assert.equal(logins, 2);
  });
});

test("authentication rejects missing, malformed, and inactive bearer tokens", async () => {
  const auth = createAuthenticationService();
  const app = createApp({
    router: createAuthenticationRouter({ authenticationService: auth }),
  });
  await withServer(app, async (baseUrl) => {
    const [missing, malformed, inactive] = await Promise.all([
      fetch(`${baseUrl}/me`),
      fetch(`${baseUrl}/me`, { headers: { Authorization: "Bearer invalid" } }),
      fetch(`${baseUrl}/me`, { headers: bearer(TOKEN_INACTIVE) }),
    ]);

    assert.deepEqual(
      [missing.status, malformed.status, inactive.status],
      [401, 401, 401],
    );
    assert.deepEqual(await missing.json(), { error: "Authentication required." });
  });
});

test("authorized evidence request calls only the pipeline and records a safe audit", async () => {
  const fixture = createEvidenceFixture();
  const app = createApp({
    router: createEvidenceInvestigationsRouter({
      evidencePipeline: fixture.pipeline,
      sourceAttributionService: fixture.sourceService,
      AuditModel: fixture.AuditModel,
      authenticationService: createAuthenticationService(),
      now: () => NOW,
    }),
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/${SOURCE.sourceCode}/evidence?evaluatedAt=2026-10-30T10%3A00%3A00.000Z&periods=5`,
      { headers: bearer(TOKEN_INVESTIGATOR) },
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.packageId, "package-test");
    assert.equal(body.calculatedFindings.historicalBaseline.status, "insufficient_history");
    assert.deepEqual(fixture.sourceCalls, [SOURCE.sourceCode]);
    assert.equal(fixture.pipelineCalls.length, 1);
    assert.equal(fixture.pipelineCalls[0].sourceCode, SOURCE.sourceCode);
    assert.equal(
      fixture.pipelineCalls[0].evaluatedAt.toISOString(),
      "2026-10-30T10:00:00.000Z",
    );
    assert.equal(fixture.audits.length, 1);
    assert.equal(fixture.audits[0].outcome, "success");
    assert.equal(fixture.audits[0].investigatorId, "507f1f77bcf86cd799439012");
    assert.equal(fixture.audits[0].historyStart instanceof Date, true);
    assert.equal(JSON.stringify(fixture.audits[0]).includes(TOKEN_INVESTIGATOR), false);
    assert.ok(response.headers.get("x-request-id"));
  });
});

test("admins can access configured sources and assigned viewers can read evidence", async () => {
  for (const token of [TOKEN_ADMIN, TOKEN_VIEWER]) {
    const fixture = createEvidenceFixture();
    const app = createApp({
      router: createEvidenceInvestigationsRouter({
        evidencePipeline: fixture.pipeline,
        sourceAttributionService: fixture.sourceService,
        AuditModel: fixture.AuditModel,
        authenticationService: createAuthenticationService(),
        now: () => NOW,
      }),
    });
    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/${SOURCE.sourceCode}/evidence`,
        { headers: bearer(token) },
      );
      assert.equal(response.status, 200);
      assert.equal(fixture.pipelineCalls.length, 1);
    });
  }
});

test("unassigned investigators receive a non-disclosing 404 without source lookup", async () => {
  const fixture = createEvidenceFixture();
  const app = createApp({
    router: createEvidenceInvestigationsRouter({
      evidencePipeline: fixture.pipeline,
      sourceAttributionService: fixture.sourceService,
      AuditModel: fixture.AuditModel,
      authenticationService: createAuthenticationService({
        async authenticateToken() {
          return {
            investigator: {
              id: "507f1f77bcf86cd799439014",
              role: "investigator",
              sourceCodes: [],
            },
            sessionId: "session",
          };
        },
      }),
      now: () => NOW,
    }),
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/${SOURCE.sourceCode}/evidence`,
      { headers: bearer(TOKEN_INVESTIGATOR) },
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "Reporting source not found.",
    });
    assert.deepEqual(fixture.sourceCalls, []);
    assert.equal(fixture.audits[0].errorCode, "SOURCE_ACCESS_DENIED");
  });
});

test("unknown sources and invalid or excessive evaluation ranges are rejected and audited", async () => {
  const cases = [
    ["?evaluatedAt=2030-01-01T00%3A00%3A00.000Z", 400],
    ["?periods=366", 400],
    ["?reportId=untrusted", 400],
    ["?evaluatedAt=not-a-date", 400],
    ["?evaluatedAt=2026-02-31T12%3A00%3A00Z", 400],
  ];
  for (const [query, expectedStatus] of cases) {
    const fixture = createEvidenceFixture();
    const app = createApp({
      router: createEvidenceInvestigationsRouter({
        evidencePipeline: fixture.pipeline,
        sourceAttributionService: fixture.sourceService,
        AuditModel: fixture.AuditModel,
        authenticationService: createAuthenticationService(),
        now: () => NOW,
      }),
    });
    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/${SOURCE.sourceCode}/evidence${query}`,
        { headers: bearer(TOKEN_INVESTIGATOR) },
      );
      assert.equal(response.status, expectedStatus);
      assert.equal(fixture.audits[0].outcome, "failure");
      assert.equal(fixture.pipelineCalls.length, 0);
    });
  }
});

test("unknown source returns non-disclosing 404 and records a failed audit", async () => {
  const fixture = createEvidenceFixture();
  const app = createApp({
    router: createEvidenceInvestigationsRouter({
      evidencePipeline: fixture.pipeline,
      sourceAttributionService: fixture.sourceService,
      AuditModel: fixture.AuditModel,
      authenticationService: createAuthenticationService(),
      now: () => NOW,
    }),
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/UNKNOWN-SOURCE/evidence`,
      { headers: bearer(TOKEN_ADMIN) },
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "Reporting source not found.",
    });
    assert.equal(fixture.audits[0].errorCode, "SOURCE_NOT_FOUND");
    assert.equal(fixture.pipelineCalls.length, 0);
  });
});

test("trusted pipeline failures are audited without leaking internal details", async () => {
  for (const code of [
    "TRUSTED_LOOKUP_FAILED",
    "INCOMPLETE_QUERY_COVERAGE",
  ]) {
    const fixture = createEvidenceFixture({
      pipelineError: Object.assign(
        new Error("database URL and stack secret"),
        { code },
      ),
    });
    const app = createApp({
      router: createEvidenceInvestigationsRouter({
        evidencePipeline: fixture.pipeline,
        sourceAttributionService: fixture.sourceService,
        AuditModel: fixture.AuditModel,
        authenticationService: createAuthenticationService(),
        now: () => NOW,
      }),
    });
    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/${SOURCE.sourceCode}/evidence`,
        { headers: bearer(TOKEN_INVESTIGATOR) },
      );
      const text = await response.text();

      assert.equal(response.status, 503);
      assert.equal(text.includes("database URL"), false);
      assert.equal(text.includes("stack secret"), false);
      assert.equal(fixture.audits[0].outcome, "failure");
      assert.equal(fixture.audits[0].errorCode, code);
    });
  }
});

test("audit persistence failure fails closed and does not return generated evidence", async () => {
  const fixture = createEvidenceFixture({ auditError: new Error("audit db failed") });
  const app = createApp({
    router: createEvidenceInvestigationsRouter({
      evidencePipeline: fixture.pipeline,
      sourceAttributionService: fixture.sourceService,
      AuditModel: fixture.AuditModel,
      authenticationService: createAuthenticationService(),
      now: () => NOW,
    }),
  });
  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/${SOURCE.sourceCode}/evidence`,
      { headers: bearer(TOKEN_INVESTIGATOR) },
    );
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.deepEqual(body, {
      error: "Investigation audit is temporarily unavailable.",
    });
    assert.equal(fixture.pipelineCalls.length, 1);
  });
});

test("admin investigator management enforces roles, source assignments, and self-change protection", async () => {
  const accounts = [
    {
      _id: "507f1f77bcf86cd799439011",
      name: "Admin",
      email: "admin@example.org",
      role: "admin",
      status: "active",
      sourceCodes: [],
    },
  ];
  const revoked = [];
  const configuredSources = new Set([SOURCE.sourceCode]);
  const InvestigatorModel = {
    async create(document) {
      const record = {
        _id: `507f1f77bcf86cd7994390${accounts.length + 20}`,
        ...document,
      };
      accounts.push(record);
      return record;
    },
    findById(id) {
      return {
        lean: async () => accounts.find((item) => String(item._id) === id) || null,
      };
    },
    findByIdAndUpdate(id, update) {
      return {
        select: async () => {
          const account = accounts.find((item) => String(item._id) === id);
          Object.assign(account, update.$set);
          return account;
        },
      };
    },
  };
  const app = createApp({
    router: createAdminInvestigatorsRouter({
      InvestigatorModel,
      authenticationService: createAuthenticationService({
        async revokeInvestigatorSessions(id) {
          revoked.push(String(id));
        },
      }),
      sourceAttributionService: {
        async getConfiguredSource({ sourceCode }) {
          return configuredSources.has(sourceCode)
            ? { sourceCode }
            : null;
        },
      },
      authenticate: (request, response, next) => {
        const identity = identitiesByToken.get(
          request.get("authorization")?.slice("Bearer ".length),
        );
        if (!identity) return response.status(401).json({ error: "Authentication required." });
        request.investigator = identity.investigator;
        return next();
      },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const create = (token, values) =>
      fetch(`${baseUrl}/`, {
        method: "POST",
        headers: {
          ...bearer(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(values),
      });
    const viewerDenied = await create(TOKEN_VIEWER, {
      name: "New analyst",
      email: "new@example.org",
      password: "a secure long password",
      role: "investigator",
      sourceCodes: [SOURCE.sourceCode],
    });
    assert.equal(viewerDenied.status, 403);
    const viewerRoleUpdate = await fetch(
      `${baseUrl}/507f1f77bcf86cd799439012`,
      {
        method: "PATCH",
        headers: {
          ...bearer(TOKEN_VIEWER),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: "admin" }),
      },
    );
    assert.equal(viewerRoleUpdate.status, 403);
    const investigatorAdminCreate = await create(TOKEN_INVESTIGATOR, {
      name: "Escalated",
      email: "escalated@example.org",
      password: "a secure long password",
      role: "admin",
      sourceCodes: [],
    });
    assert.equal(investigatorAdminCreate.status, 403);

    const createdResponse = await create(TOKEN_ADMIN, {
      name: "New analyst",
      email: "new@example.org",
      password: "a secure long password",
      role: "investigator",
      sourceCodes: [SOURCE.sourceCode],
    });
    const created = await createdResponse.json();
    assert.equal(createdResponse.status, 201);
    assert.equal(created.investigator.role, "investigator");
    assert.equal(created.investigator.passwordHash, undefined);
    assert.equal(accounts[1].passwordHash, "scrypt-test-hash:a secure long password");

    const badAssignment = await create(TOKEN_ADMIN, {
      name: "Other",
      email: "other@example.org",
      password: "a secure long password",
      role: "admin",
      sourceCodes: ["NOT-CONFIGURED"],
    });
    assert.equal(badAssignment.status, 400);

    const selfUpdate = await fetch(
      `${baseUrl}/507f1f77bcf86cd799439011`,
      {
        method: "PATCH",
        headers: {
          ...bearer(TOKEN_ADMIN),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: "viewer" }),
      },
    );
    assert.equal(selfUpdate.status, 400);

    const deactivate = await fetch(
      `${baseUrl}/${accounts[1]._id}`,
      {
        method: "PATCH",
        headers: {
          ...bearer(TOKEN_ADMIN),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "inactive" }),
      },
    );
    assert.equal(deactivate.status, 200);
    assert.equal((await deactivate.json()).investigator.status, "inactive");
    assert.deepEqual(revoked, [String(accounts[1]._id)]);
    const reactivate = await fetch(
      `${baseUrl}/${accounts[1]._id}`,
      {
        method: "PATCH",
        headers: {
          ...bearer(TOKEN_ADMIN),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "active" }),
      },
    );
    assert.equal(reactivate.status, 200);
    assert.equal((await reactivate.json()).investigator.status, "active");
  });
});
