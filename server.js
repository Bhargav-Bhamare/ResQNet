require("dotenv").config({ quiet: true });

const express = require("express");
const mongoose = require("mongoose");
const connectToDatabase = require("./config/db");
const Report = require("./models/Report");

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.get("/api/health", (req, res) => {
  res.status(200).json({
    application: "NULL SIGNAL",
    status: "running",
  });
});

app.get("/api/db-health", (req, res) => {
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({
    status: connected ? "connected" : "disconnected",
  });
});

const reportFields = new Set([
  "reportType",
  "description",
  "symptoms",
  "severity",
  "location",
  "sourceChannel",
  "sourceId",
  "reportedAt",
]);
const locationFields = new Set([
  "region",
  "district",
  "state",
  "country",
  "coordinates",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateSubmissionShape(body) {
  if (!isPlainObject(body)) {
    return "The request body must be a JSON object.";
  }

  for (const field of Object.keys(body)) {
    if (field === "verificationStatus") {
      return "verificationStatus is assigned by the server.";
    }

    if (
      ["_id", "id", "__v", "submittedAt", "createdAt", "updatedAt"].includes(
        field,
      )
    ) {
      return `${field} is assigned by the server.`;
    }

    if (!reportFields.has(field)) {
      return `Unsupported field: ${field}.`;
    }
  }

  for (const field of [
    "reportType",
    "description",
    "severity",
    "sourceChannel",
    "sourceId",
  ]) {
    if (field in body && typeof body[field] !== "string") {
      return `${field} must be a string.`;
    }
  }

  if ("symptoms" in body) {
    if (
      !Array.isArray(body.symptoms) ||
      body.symptoms.some((symptom) => typeof symptom !== "string")
    ) {
      return "symptoms must be an array of strings.";
    }
  }

  if ("reportedAt" in body) {
    if (
      typeof body.reportedAt !== "string" ||
      Number.isNaN(Date.parse(body.reportedAt))
    ) {
      return "reportedAt must be a valid date string.";
    }
  }

  if ("location" in body) {
    if (!isPlainObject(body.location)) {
      return "location must be a JSON object.";
    }

    for (const field of Object.keys(body.location)) {
      if (!locationFields.has(field)) {
        return `Unsupported location field: ${field}.`;
      }

      if (field !== "coordinates" && typeof body.location[field] !== "string") {
        return `location.${field} must be a string.`;
      }
    }

    if ("coordinates" in body.location) {
      const { coordinates } = body.location;
      if (!isPlainObject(coordinates)) {
        return "location.coordinates must be a GeoJSON Point object.";
      }

      for (const field of Object.keys(coordinates)) {
        if (!["type", "coordinates"].includes(field)) {
          return `Unsupported location.coordinates field: ${field}.`;
        }
      }

      if (
        coordinates.type !== "Point" ||
        !Array.isArray(coordinates.coordinates) ||
        coordinates.coordinates.some(
          (coordinate) => typeof coordinate !== "number",
        )
      ) {
        return "location.coordinates must contain a Point and numeric coordinates.";
      }
    }
  }

  return null;
}

function isDatabaseUnavailable(error) {
  return (
    mongoose.connection.readyState !== 1 ||
    [
      "MongoNetworkError",
      "MongoServerSelectionError",
      "MongoNotConnectedError",
    ].includes(error?.name) ||
    /buffering timed out/i.test(error?.message || "")
  );
}

app.post("/api/reports", async (req, res) => {
  const shapeError = validateSubmissionShape(req.body);
  if (shapeError) {
    return res.status(400).json({ error: shapeError });
  }

  const report = new Report(req.body);

  try {
    await report.validate();
  } catch (error) {
    if (
      error instanceof mongoose.Error.ValidationError ||
      error instanceof mongoose.Error.CastError
    ) {
      const fields = error.errors
        ? Object.keys(error.errors)
        : [error.path].filter(Boolean);
      return res.status(400).json({
        error: "Report validation failed.",
        fields,
      });
    }
    throw error;
  }

  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: "Database unavailable." });
  }

  try {
    const savedReport = await report.save();
    return res.status(201).json({
      report: savedReport.toObject({ versionKey: false }),
    });
  } catch (error) {
    if (
      error instanceof mongoose.Error.ValidationError ||
      error instanceof mongoose.Error.CastError
    ) {
      const fields = error.errors
        ? Object.keys(error.errors)
        : [error.path].filter(Boolean);
      return res.status(400).json({
        error: "Report validation failed.",
        fields,
      });
    }

    if (isDatabaseUnavailable(error)) {
      return res.status(503).json({ error: "Database unavailable." });
    }

    console.error(
      `Unable to save report (${error?.name || "UnknownError"}).`,
    );
    return res.status(500).json({ error: "Unable to save report." });
  }
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "API route not found" });
});

app.use((error, req, res, next) => {
  if (error?.type === "entity.parse.failed" || error instanceof SyntaxError) {
    return res.status(400).json({ error: "Malformed JSON request body." });
  }

  if (error?.type === "entity.too.large") {
    return res.status(400).json({ error: "Request body is too large." });
  }

  console.error("Unexpected request error.");
  return res.status(500).json({ error: "Internal server error." });
});

async function startServer() {
  await connectToDatabase();
  app.listen(port, () => {
    console.log(`NULL SIGNAL backend listening on port ${port}`);
  });
}

startServer().catch((error) => {
  console.error(`Unable to start NULL SIGNAL backend: ${error.message}`);
  process.exitCode = 1;
});
