require("dotenv").config({ quiet: true });

const { randomUUID } = require("node:crypto");
const express = require("express");
const mongoose = require("mongoose");
const connectToDatabase = require("./config/db");
const Report = require("./models/Report");
const Investigation = require("./models/Investigation");
const ReportingSource = require("./models/ReportingSource");
const evaluateEvidence = require("./services/evidenceDetector");
const reportingCompletenessRouter = require("./routes/reportingCompleteness");
const {
  createAuthenticationRouter,
} = require("./routes/authentication");
const {
  createAdminInvestigatorsRouter,
} = require("./routes/adminInvestigators");
const {
  createEvidenceInvestigationsRouter,
} = require("./routes/evidenceInvestigations");
const {
  createInvestigatorAuthenticationService,
} = require("./services/investigatorAuthentication");
const {
  createAuthenticationMiddleware,
  requireRoles,
} = require("./services/investigatorMiddleware");
const {
  createSourceAttributionService,
} = require("./services/sourceAttribution");

const app = express();
const port = process.env.PORT || 3000;
app.disable("x-powered-by");
const investigatorAuthenticationService =
  createInvestigatorAuthenticationService();
const authenticateInvestigator = createAuthenticationMiddleware(
  investigatorAuthenticationService,
);
const sourceAttributionService = createSourceAttributionService();

app.use((req, res, next) => {
  req.requestId = randomUUID();
  if (req.path.startsWith("/api/")) {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
  }
  next();
});

app.use(express.static(__dirname));
app.use(express.json({ limit: "100kb" }));

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

app.use(
  "/api/auth",
  createAuthenticationRouter({
    authenticationService: investigatorAuthenticationService,
    authenticate: authenticateInvestigator,
  }),
);
app.use(
  "/api/admin/investigators",
  createAdminInvestigatorsRouter({
    authenticationService: investigatorAuthenticationService,
    authenticate: authenticateInvestigator,
  }),
);
app.use(
  "/api/investigations",
  createEvidenceInvestigationsRouter({
    authenticationService: investigatorAuthenticationService,
    sourceAttributionService,
    authenticate: authenticateInvestigator,
  }),
);

// Reporting summaries are visible only for all sources to admins and for
// assigned sources to investigators and viewers.
app.use(
  "/api/reporting-completeness",
  authenticateInvestigator,
  reportingCompletenessRouter({
    getVisibleSources: (req) => {
      if (req.investigator.role === "admin") {
        return ReportingSource.find({}).lean();
      }
      return ReportingSource.find({
        sourceCode: { $in: req.investigator.sourceCodes },
      }).lean();
    },
  }),
);

// Allowed fields for public report submissions.
const reportFields = new Set([
  "reportType",
  "disasterType",
  "description",
  "symptoms",
  "severity",
  "location",
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
      ["sourceId", "sourceChannel", "isSynthetic", "source"].includes(field)
    ) {
      return "Reporting-source attribution and synthetic status are assigned by the server.";
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
    "disasterType",
    "description",
    "severity",
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

      if (
        field !== "coordinates" &&
        typeof body.location[field] !== "string"
      ) {
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
        coordinates.coordinates.length !== 2 ||
        coordinates.coordinates.some(
          (coordinate) => typeof coordinate !== "number",
        )
      ) {
        return "location.coordinates must contain a Point and two numeric coordinates.";
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

// Public report submission.
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

// Retrieve recent reports.
app.get(
  "/api/reports",
  authenticateInvestigator,
  requireRoles("admin"),
  async (req, res) => {
    try {
      const reports = await Report.find()
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();

      return res.status(200).json({
        count: reports.length,
        reports,
      });
    } catch (error) {
      console.error("Report retrieval failed:", error.message);

      return res.status(500).json({
        error: "Unable to retrieve reports.",
      });
    }
  },
);

// Evaluate evidence using reports stored in MongoDB.
app.use(
  "/api/evidence",
  authenticateInvestigator,
  requireRoles("admin"),
);
app.post("/api/evidence/evaluate-from-reports", async (req, res) => {
  try {
    const {
      area,
      expectedReports,
      windowHours,
      channelStatus,
    } = req.body;

    const validStatuses = ["healthy", "degraded", "failed", "unknown"];

    if (
      typeof area !== "string" ||
      !area.trim() ||
      !Number.isInteger(expectedReports) ||
      expectedReports < 0 ||
      typeof windowHours !== "number" ||
      !Number.isFinite(windowHours) ||
      windowHours <= 0 ||
      windowHours > 720 ||
      !validStatuses.includes(channelStatus)
    ) {
      return res.status(400).json({
        error:
          "Provide area, a non-negative integer expectedReports, windowHours between 0 and 720, and a valid channelStatus.",
      });
    }

    const now = new Date();
    const windowStart = new Date(
      now.getTime() - windowHours * 60 * 60 * 1000,
    );

    const escapedArea = area.trim().replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );

    // Match structured locations and exclude synthetic test reports.
    // Older records without submittedAt use createdAt as a fallback.
    const receivedReports = await Report.countDocuments({
      "location.region": {
        $regex: `^${escapedArea}$`,
        $options: "i",
      },
      $or: [
        {
          submittedAt: {
            $gte: windowStart,
            $lte: now,
          },
        },
        {
          submittedAt: { $exists: false },
          createdAt: {
            $gte: windowStart,
            $lte: now,
          },
        },
      ],
      isSynthetic: { $ne: true },
    });

    const result = evaluateEvidence({
      area: area.trim(),
      expectedReports,
      receivedReports,
      channelStatus,
    });

    const investigation = await Investigation.create(result);

    return res.status(201).json({
      message: "Database-backed evidence evaluation completed.",
      window: {
        hours: windowHours,
        from: windowStart,
        to: now,
      },
      investigation,
    });
  } catch (error) {
    console.error(
      "Database-backed evidence evaluation failed:",
      error.message,
    );

    return res.status(500).json({
      error: "Unable to evaluate stored reports.",
    });
  }
});

// Evaluate manually supplied evidence counts.
app.post("/api/evidence/evaluate", async (req, res) => {
  try {
    const {
      area,
      expectedReports,
      receivedReports,
      channelStatus,
    } = req.body;

    if (
      typeof area !== "string" ||
      !area.trim() ||
      !Number.isInteger(expectedReports) ||
      !Number.isInteger(receivedReports) ||
      expectedReports < 0 ||
      receivedReports < 0 ||
      !["healthy", "degraded", "failed", "unknown"].includes(
        channelStatus,
      )
    ) {
      return res.status(400).json({
        error:
          "Provide area, non-negative integer report counts, and a valid channelStatus.",
      });
    }

    const result = evaluateEvidence({
      area: area.trim(),
      expectedReports,
      receivedReports,
      channelStatus,
    });

    const saved = await Investigation.create(result);

    return res.status(201).json({
      message: "Evidence evaluation completed and saved.",
      investigation: saved,
    });
  } catch (error) {
    console.error("Evidence evaluation failed:", error.message);

    return res.status(500).json({
      error: "Unable to evaluate and save evidence.",
    });
  }
});

// Retrieve recent investigations.
app.get("/api/evidence/investigations", async (req, res) => {
  try {
    const investigations = await Investigation.find()
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return res.status(200).json({
      count: investigations.length,
      investigations,
    });
  } catch (error) {
    console.error("Investigation retrieval failed:", error.message);

    return res.status(500).json({
      error: "Unable to retrieve investigations.",
    });
  }
});

// API 404 handler.
app.use("/api", (req, res) => {
  res.status(404).json({ error: "API route not found" });
});

// Global error handler.
app.use((error, req, res, next) => {
  if (error?.type === "entity.parse.failed" || error instanceof SyntaxError) {
    return res.status(400).json({ error: "Malformed JSON request body." });
  }

  if (error?.type === "entity.too.large") {
    return res.status(400).json({ error: "Request body is too large." });
  }

  console.error("Unexpected request error.");

  return res.status(500).json({
    error: "Internal server error.",
  });
});

async function startServer() {
  await connectToDatabase();

  app.listen(port, () => {
    console.log(`NULL SIGNAL backend listening on port ${port}`);
  });
}

// Only start the server when this file is run directly.
// This allows automated tests to import the Express app.
if (require.main === module) {
  startServer().catch((error) => {
    console.error(`Unable to start NULL SIGNAL backend: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { app };