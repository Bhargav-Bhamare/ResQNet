require("dotenv").config({ quiet: true });

const { randomBytes } = require("node:crypto");
const mongoose = require("mongoose");
const connectToDatabase = require("../config/db");
const Investigator = require("../models/Investigator");
const InvestigatorBootstrap = require("../models/InvestigatorBootstrap");
const { hashPassword, isValidEmail, normalizeEmail } = require("../services/investigatorAuthentication");

const BOOTSTRAP_ID = "initial-investigator-admin";

async function bootstrapAdmin() {
  const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim();
  const email = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (
    !name ||
    name.length > 150 ||
    !isValidEmail(email) ||
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 256
  ) {
    throw new Error(
      "Set BOOTSTRAP_ADMIN_NAME, BOOTSTRAP_ADMIN_EMAIL, and a 12-256 character BOOTSTRAP_ADMIN_PASSWORD.",
    );
  }

  await connectToDatabase();
  if ((await Investigator.countDocuments({})) !== 0) {
    throw new Error(
      "Bootstrap is disabled because investigator accounts already exist.",
    );
  }

  const claimToken = randomBytes(32).toString("hex");
  try {
    await InvestigatorBootstrap.create({
      _id: BOOTSTRAP_ID,
      claimToken,
      claimedAt: new Date(),
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw new Error("Initial administrator bootstrap has already been claimed.");
    }
    throw error;
  }
  if ((await Investigator.countDocuments({})) !== 0) {
    throw new Error(
      "Bootstrap stopped because an investigator account was created concurrently.",
    );
  }

  await Investigator.create({
    name,
    email,
    passwordHash: await hashPassword(password),
    role: "admin",
    status: "active",
    sourceCodes: [],
  });
  await InvestigatorBootstrap.updateOne(
    { _id: BOOTSTRAP_ID, claimToken },
    { $set: { completedAt: new Date() } },
  );
  console.log("Initial administrator created. Remove bootstrap variables now.");
}

bootstrapAdmin()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });
