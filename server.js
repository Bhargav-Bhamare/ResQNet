
require("dotenv").config({ quiet: true });

const express = require("express");
const mongoose = require("mongoose");
const connectToDatabase = require("./config/db");

const Investigation = require("./models/Investigation");
const evaluateEvidence = require("./services/evidenceDetector");

const app = express();
app.use(express.static(__dirname));
const port = process.env.PORT || 3000;
const Report = require("./models/Report");

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

// Evaluate an evidence situation and save the result.
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
        channelStatus
      )
    ) {
      return res.status(400).json({
        error: "Provide area, non-negative integer report counts, and a valid channelStatus.",
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


app.post("/api/reports", async (req, res) => {
  try {
    const {
      reportType,
      symptoms,
      disasterType,
      severity,
      description,
      location,
    } = req.body;

    if (
      !["symptom", "disaster"].includes(reportType) ||
      typeof location !== "string" ||
      !location.trim() ||
      typeof severity !== "string" ||
      !severity.trim()
    ) {
      return res.status(400).json({
        error: "Valid reportType, location, and severity are required.",
      });
    }

    if (
      reportType === "symptom" &&
      (!Array.isArray(symptoms) || symptoms.length === 0)
    ) {
      return res.status(400).json({
        error: "Select at least one symptom.",
      });
    }

    if (reportType === "disaster" && !disasterType) {
      return res.status(400).json({
        error: "Disaster type is required.",
      });
    }

    const report = await Report.create({
      reportType,
      symptoms: reportType === "symptom" ? symptoms : [],
      disasterType: reportType === "disaster" ? disasterType : null,
      severity,
      description: typeof description === "string" ? description : "",
      location: location.trim(),
    });

    return res.status(201).json({
      message: "Report saved successfully.",
      report,
    });
  } catch (error) {
    console.error("Report creation failed:", error.message);
    return res.status(500).json({
      error: "Unable to save report.",
    });
  }
});

app.get("/api/reports", async (req, res) => {
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
});


app.use("/api", (req, res) => {
  res.status(404).json({ error: "API route not found" });
});

async function startServer() {
  await connectToDatabase();

  app.listen(port, () => {
    console.log(`NULL SIGNAL backend listening on port ${port}`);
  });
}

startServer().catch((error) => {
  console.error(
    `Unable to start NULL SIGNAL backend: ${error.message}`
  );
  process.exitCode = 1;
});

