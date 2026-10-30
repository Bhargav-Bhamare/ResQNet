const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const Report = require("../models/Report");
const ReportingSource = require("../models/ReportingSource");
const createReportingCompletenessRouter = require("../routes/reportingCompleteness");
const { app } = require("../server");

async function withServer(application, run) {
  const server = application.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function testSource(overrides = {}) {
  return {
    sourceCode: "CLINIC-TEST",
    isActive: true,
    validFrom: "2020-01-01T00:00:00.000Z",
    reportingSchedule: {
      frequency: "daily",
      expectedReportsPerPeriod: 10,
      reportingTime: "23:59",
      timezone: "UTC",
    },
    ...overrides,
  };
}

function createTestApp(findSources, options = {}) {
  const application = express();
  application.use(express.json());
  application.use(
    "/api/reporting-completeness",
    createReportingCompletenessRouter({
      ReportingSourceModel: {
        find() {
          return { lean: findSources };
        },
      },
      ...options,
    }),
  );
  return application;
}

test("returns a clear empty result when no sources are configured", async () => {
  await withServer(createTestApp(async () => []), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/reporting-completeness`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.count, 0);
    assert.deepEqual(body.sources, []);
    assert.ok(body.limitations.length > 0);
  });
});

test("returns current-period source results and trust limitations", async () => {
  await withServer(
    createTestApp(async () => [testSource()], {
      getTrustedReports: async () => ({
        reports: [],
        trustedReportIds: new Set(),
      }),
    }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/reporting-completeness`);
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.count, 1);
      assert.equal(body.sources[0].sourceCode, "CLINIC-TEST");
      assert.equal(body.sources[0].status, "in_progress");
      assert.equal(body.sources[0].expectedReports, 10);
      assert.equal(body.sources[0].eligibleReceivedReports, 0);
      assert.equal(body.sources[0].completenessPercent, null);
      assert.ok(body.sources[0].period.start);
      assert.ok(body.sources[0].period.deadline);
      assert.match(body.limitations[0], /public submissions are not attributed/);
    },
  );
});

test("passes only reports and IDs returned by the trusted-attribution query", async () => {
  const trustedReport = {
    _id: "attributed-report-id",
    sourceId: "CLINIC-TEST",
    submittedAt: new Date().toISOString(),
  };
  let receivedCalculatorInput;

  await withServer(
    createTestApp(async () => [testSource()], {
      getTrustedReports: async ({ sourceCode }) => {
        assert.equal(sourceCode, "CLINIC-TEST");
        return {
          reports: [trustedReport],
          trustedReportIds: new Set(["attributed-report-id"]),
        };
      },
      calculate(input) {
        receivedCalculatorInput = input;
        return [];
      },
    }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/reporting-completeness`);

      assert.equal(response.status, 200);
      assert.deepEqual(receivedCalculatorInput.reports, [trustedReport]);
      assert.deepEqual(
        [...receivedCalculatorInput.trustedReportIds],
        ["attributed-report-id"],
      );
    },
  );
});

test("returns a safe non-success response when source lookup fails", async () => {
  const unavailable = new Error("database details must not reach clients");
  unavailable.name = "MongoNetworkError";

  await withServer(
    createTestApp(async () => {
      throw unavailable;
    }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/reporting-completeness`);
      const body = await response.json();

      assert.equal(response.status, 503);
      assert.deepEqual(body, {
        error: "Reporting completeness is temporarily unavailable.",
      });
    },
  );
});

test("existing health routes and unknown API behavior remain intact", async () => {
  const originalReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;

  try {
    await withServer(app, async (baseUrl) => {
      const applicationHealth = await fetch(`${baseUrl}/api/health`);
      const databaseHealth = await fetch(`${baseUrl}/api/db-health`);
      const unknownRoute = await fetch(`${baseUrl}/api/not-a-route`);

      assert.equal(applicationHealth.status, 200);
      assert.equal(databaseHealth.status, 200);
      assert.deepEqual(await databaseHealth.json(), { status: "connected" });
      assert.equal(unknownRoute.status, 404);
    });
  } finally {
    mongoose.connection.readyState = originalReadyState;
  }
});

test("main application protects the completeness route with authentication", async () => {
  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/reporting-completeness`,
    );

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: "Authentication required.",
    });
  });
});

test("public report submissions cannot self-assign trusted source metadata", async () => {
  const originalReadyState = mongoose.connection.readyState;
  const originalSave = Report.prototype.save;
  mongoose.connection.readyState = 1;
  Report.prototype.save = async function saveWithoutPersistence() {
    const now = new Date();
    this.createdAt = this.createdAt || now;
    this.updatedAt = this.updatedAt || now;
    return this;
  };

  try {
    await withServer(app, async (baseUrl) => {
      const normalResponse = await fetch(`${baseUrl}/api/reports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reportType: "symptom",
          symptoms: ["fever"],
          severity: "mild",
          location: { region: "User-supplied region" },
        }),
      });
      const normalBody = await normalResponse.json();

      assert.equal(normalResponse.status, 201);
      assert.equal(normalBody.report.location.region, "User-supplied region");
      assert.equal(normalBody.report.sourceChannel, "web");
      assert.equal(normalBody.report.verificationStatus, "pending");
      assert.equal(normalBody.report.sourceId, undefined);
      assert.ok(normalBody.report._id);
      assert.ok(Number.isFinite(Date.parse(normalBody.report.submittedAt)));
      assert.ok(Number.isFinite(Date.parse(normalBody.report.createdAt)));

      const disasterResponse = await fetch(`${baseUrl}/api/reports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reportType: "disaster",
          description: "flood: rising river",
          severity: "high",
        }),
      });
      const disasterBody = await disasterResponse.json();
      assert.equal(disasterResponse.status, 201);
      assert.equal(disasterBody.report.reportType, "disaster");
      assert.equal(disasterBody.report.location, undefined);
      assert.equal(disasterBody.report.verificationStatus, "pending");

      for (const metadata of [
        { sourceId: "CLINIC-TEST" },
        { sourceChannel: "official_api" },
        { verificationStatus: "verified" },
        { submittedAt: "2000-01-01T00:00:00.000Z" },
        { createdAt: "2000-01-01T00:00:00.000Z" },
        { updatedAt: "2000-01-01T00:00:00.000Z" },
        { _id: new mongoose.Types.ObjectId().toString() },
      ]) {
        const response = await fetch(`${baseUrl}/api/reports`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            reportType: "symptom",
            symptoms: ["fever"],
            severity: "mild",
            ...metadata,
          }),
        });
        assert.equal(response.status, 400);
      }
    });
  } finally {
    Report.prototype.save = originalSave;
    mongoose.connection.readyState = originalReadyState;
  }
});
