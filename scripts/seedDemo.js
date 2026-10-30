require("dotenv").config({ quiet: true });

const { randomBytes } = require("node:crypto");
const mongoose = require("mongoose");

const DEMO_DATABASE_NAME = "resqnet_demo";
const DEMO_SOURCE_CODE = "DEMO-CLINIC-01";
const DEMO_ADMIN_EMAIL = "judge-demo@example.test";
const DEMO_SOURCE_NAME = "Synthetic Demo Community Clinic";
const TIMEZONE = "Asia/Kolkata";
const EXPECTED_REPORTS_PER_DAY = 10;
const HISTORICAL_REPORT_COUNTS = [8, 9, 10, 9, 11, 8, 10, 9];

process.env.MONGODB_DATABASE = DEMO_DATABASE_NAME;

const connectToDatabase = require("../config/db");
const Investigator = require("../models/Investigator");
const InvestigatorBootstrap = require("../models/InvestigatorBootstrap");
const InvestigatorSession = require("../models/InvestigatorSession");
const Investigation = require("../models/Investigation");
const InvestigationAudit = require("../models/InvestigationAudit");
const InvestigationReview = require("../models/InvestigationReview");
const AIInterpretation = require("../models/AIInterpretation");
const AIInterpretationAudit = require("../models/AIInterpretationAudit");
const Report = require("../models/Report");
const ReportAttribution = require("../models/ReportAttribution");
const ReportingSource = require("../models/ReportingSource");
const ReportingSourceCredential = require("../models/ReportingSourceCredential");
const { hashPassword } = require("../services/investigatorAuthentication");
const {
  createSourceAttributionService,
} = require("../services/sourceAttribution");
const reportingCompleteness = require("../services/reportingCompleteness");

const modelsToCheck = [
  Investigator,
  InvestigatorBootstrap,
  InvestigatorSession,
  Investigation,
  InvestigationAudit,
  InvestigationReview,
  AIInterpretation,
  AIInterpretationAudit,
  Report,
  ReportAttribution,
  ReportingSource,
  ReportingSourceCredential,
];

async function assertDemoDatabaseIsEmpty() {
  const counts = await Promise.all(
    modelsToCheck.map((model) => model.countDocuments({})),
  );
  const populated = modelsToCheck
    .map((model, index) => ({ name: model.modelName, count: counts[index] }))
    .filter((entry) => entry.count > 0);
  if (populated.length) {
    throw new Error(
      `The isolated demo database is not empty (${populated.map((entry) => `${entry.name}: ${entry.count}`).join(", ")}). No data was changed.`,
    );
  }
}

function getLocalDateParts(date) {
  return reportingCompleteness.getLocalParts(date, TIMEZONE);
}

function makeReportData(timestamp, sequence) {
  const symptoms = sequence % 2 === 0 ? ["fever"] : ["headache"];
  return {
    reportType: "symptom",
    symptoms,
    severity: "mild",
    description: "SYNTHETIC DEMO DATA — not a real patient report.",
    location: { region: "Demo Region", country: "Demo" },
    reportedAt: timestamp.toISOString(),
  };
}

async function createSyntheticReports({
  credential,
  sourceCode,
  periodStart,
  count,
  firstSequence,
}) {
  const fixtureReports = [];
  for (let index = 0; index < count; index += 1) {
    const timestamp = new Date(
      periodStart.getTime() + 12 * 60 * 60 * 1000 + index * 60 * 1000,
    );
    const result = await createSourceAttributionService().attributeReport({
      credential,
      reportData: makeReportData(timestamp, firstSequence + index),
    });
    fixtureReports.push({ reportId: result.report._id, timestamp });
  }

  if (fixtureReports.length) {
    await Report.bulkWrite(
      fixtureReports.map(({ reportId, timestamp }) => ({
        updateOne: {
          filter: { _id: reportId, sourceId: sourceCode },
          update: {
            $set: {
              submittedAt: timestamp,
              reportedAt: timestamp,
              isSynthetic: true,
              description: "SYNTHETIC DEMO DATA — not a real patient report.",
            },
          },
        },
      })),
    );
    await ReportAttribution.bulkWrite(
      fixtureReports.map(({ reportId, timestamp }) => ({
        updateOne: {
          filter: { reportId, sourceCode, outcome: "accepted" },
          update: { $set: { attributedAt: timestamp } },
        },
      })),
    );
  }

  return fixtureReports.length;
}

async function seedDemo() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is required. Set it in the ignored .env file.");
  }

  await connectToDatabase();
  await assertDemoDatabaseIsEmpty();

  const now = new Date();
  const today = getLocalDateParts(now);
  const firstHistoricalDay = reportingCompleteness.addCalendarDays(
    today,
    -HISTORICAL_REPORT_COUNTS.length,
  );
  const firstPeriod = reportingCompleteness.getReportingPeriodForLocalDate(
    {
      frequency: "daily",
      timezone: TIMEZONE,
      reportingTime: "09:00",
    },
    firstHistoricalDay,
  );

  const source = await ReportingSource.create({
    name: DEMO_SOURCE_NAME,
    sourceCode: DEMO_SOURCE_CODE,
    sourceType: "health_facility",
    description: "Synthetic fixture source for the local ResQNet demo workspace.",
    region: "Demo Region",
    country: "Demo",
    reportingSchedule: {
      frequency: "daily",
      expectedReportsPerPeriod: EXPECTED_REPORTS_PER_DAY,
      reportingTime: "09:00",
      timezone: TIMEZONE,
    },
    isActive: true,
    validFrom: firstPeriod.start,
  });

  const password = randomBytes(18).toString("base64url");
  const investigator = await Investigator.create({
    name: "Demo Administrator",
    email: DEMO_ADMIN_EMAIL,
    passwordHash: await hashPassword(password),
    role: "admin",
    status: "active",
    sourceCodes: [],
  });

  const sourceAttribution = createSourceAttributionService();
  const provisioned = await sourceAttribution.provisionCredential({
    sourceCode: DEMO_SOURCE_CODE,
  });

  let totalReports = 0;
  for (let index = 0; index < HISTORICAL_REPORT_COUNTS.length; index += 1) {
    const daysAgo = HISTORICAL_REPORT_COUNTS.length - index;
    const localDate = reportingCompleteness.addCalendarDays(today, -daysAgo);
    const period = reportingCompleteness.getReportingPeriodForLocalDate(
      source.reportingSchedule,
      localDate,
    );
    totalReports += await createSyntheticReports({
      credential: provisioned.credential,
      sourceCode: DEMO_SOURCE_CODE,
      periodStart: period.start,
      count: HISTORICAL_REPORT_COUNTS[index],
      firstSequence: totalReports,
    });
  }

  const currentPeriod = reportingCompleteness.getReportingPeriodForLocalDate(
    source.reportingSchedule,
    today,
  );
  totalReports += await createSyntheticReports({
    credential: provisioned.credential,
    sourceCode: DEMO_SOURCE_CODE,
    periodStart: currentPeriod.start,
    count: 2,
    firstSequence: totalReports,
  });

  console.log("Synthetic demo data seeded in the isolated resqnet_demo database.");
  console.log(`Source: ${DEMO_SOURCE_CODE} (${DEMO_SOURCE_NAME})`);
  console.log(`Trusted demo reports: ${totalReports} (all marked synthetic)`);
  console.log(`Admin email: ${investigator.email}`);
  console.log(`Admin password: ${password}`);
  console.log("Save this password now; it is not stored in a plaintext file.");
  console.log("Start the isolated workspace with: npm run demo:start");
}

seedDemo()
  .catch((error) => {
    console.error(`Demo data setup failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });
