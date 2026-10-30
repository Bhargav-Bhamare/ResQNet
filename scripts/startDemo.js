require("dotenv").config({ quiet: true });

const mongoose = require("mongoose");

process.env.MONGODB_DATABASE = "resqnet_demo";
process.env.PORT = process.env.RESQNET_DEMO_PORT || "3001";

const connectToDatabase = require("../config/db");
const { app } = require("../server");

async function startDemoServer() {
  await connectToDatabase();
  const server = app.listen(process.env.PORT, () => {
    console.log(`ResQNet isolated demo workspace listening on port ${process.env.PORT}`);
  });
  server.once("error", async (error) => {
    console.error(`Unable to start the demo workspace: ${error.message}`);
    await mongoose.disconnect();
    process.exitCode = 1;
  });
}

startDemoServer().catch(async (error) => {
  console.error(`Unable to start the demo workspace: ${error.message}`);
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  process.exitCode = 1;
});
