const test = require("node:test");
const assert = require("node:assert/strict");
const ReportingSource = require("../models/ReportingSource");
const { app } = require("../server");

async function withServer(run) {
  const server = app.listen(0, "127.0.0.1");
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

test("source ingestion and credential provisioning are not exposed as public routes", async () => {
  await withServer(async (baseUrl) => {
    const responses = await Promise.all([
      fetch(`${baseUrl}/api/source-reports`, { method: "POST" }),
      fetch(`${baseUrl}/api/reporting-sources/CLINIC-001/credentials`, {
        method: "POST",
      }),
      fetch(`${baseUrl}/api/reporting-source-credentials`),
    ]);

    assert.deepEqual(
      responses.map((response) => response.status),
      [404, 404, 404],
    );
  });
});

test("ordinary reporting read endpoint does not expose source credentials", async () => {
  const originalFind = ReportingSource.find;
  ReportingSource.find = () => ({ lean: async () => [] });

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/reporting-completeness`,
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(JSON.stringify(body).includes("secretHash"), false);
      assert.equal(JSON.stringify(body).includes("nsq_"), false);
    });
  } finally {
    ReportingSource.find = originalFind;
  }
});
