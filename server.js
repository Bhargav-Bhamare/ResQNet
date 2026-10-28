const express = require("express");

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.get("/api/health", (req, res) => {
  res.status(200).json({
    application: "NULL SIGNAL",
    status: "running",
  });
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "API route not found" });
});

app.listen(port, () => {
  console.log(`NULL SIGNAL backend listening on port ${port}`);
});
