require("dotenv").config({ quiet: true });

const express = require("express");
const mongoose = require("mongoose");
const connectToDatabase = require("./config/db");

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
  console.error(`Unable to start NULL SIGNAL backend: ${error.message}`);
  process.exitCode = 1;
});
