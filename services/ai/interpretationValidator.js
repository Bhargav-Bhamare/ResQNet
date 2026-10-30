const {
  EVIDENCE_STRENGTHS: EVIDENCE_STRENGTH_VALUES,
  FACT_REFERENCES,
  FINDING_TYPES: FINDING_TYPE_VALUES,
  FOLLOW_UP_PRIORITIES: FOLLOW_UP_PRIORITY_VALUES,
  PROMPT_VERSION,
  SCHEMA_VERSION,
} = require("../../constants/aiInterpretation");
const { getPath } = require("./evidenceSanitizer");

const FINDING_TYPES = new Set(FINDING_TYPE_VALUES);
const EVIDENCE_STRENGTHS = new Set(EVIDENCE_STRENGTH_VALUES);
const FOLLOW_UP_PRIORITIES = new Set(FOLLOW_UP_PRIORITY_VALUES);
const RESPONSE_KEYS = ["schemaVersion", "promptVersion", "interpretation"];
const INTERPRETATION_KEYS = [
  "headline",
  "executiveSummary",
  "findingType",
  "evidenceStrength",
  "explanation",
  "observedFacts",
  "supportingEvidence",
  "unknowns",
  "alternativeExplanations",
  "recommendedFollowUps",
  "limitations",
  "interpretationBoundary",
];
const FACT_KEYS = ["factCode", "evidenceRefs"];
const FOLLOW_UP_KEYS = ["question", "reason", "priority"];

class InterpretationValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "InterpretationValidationError";
    this.code = code;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed) {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function requireText(value, field, maximum) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum
  ) {
    throw new InterpretationValidationError(
      "INVALID_MODEL_OUTPUT",
      `${field} is empty or exceeds its allowed length.`,
    );
  }
  return value.trim();
}

function requireStringList(value, field, { maxItems, maxLength }) {
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        item.trim().length === 0 ||
        item.length > maxLength,
    )
  ) {
    throw new InterpretationValidationError(
      "INVALID_MODEL_OUTPUT",
      `${field} has an invalid shape.`,
    );
  }
  return value.map((item) => item.trim());
}

function rejectUnsupportedClaims(interpretation, evidence) {
  const prose = [
    interpretation.headline,
    interpretation.executiveSummary,
    interpretation.explanation,
    interpretation.interpretationBoundary,
    ...interpretation.unknowns,
    ...interpretation.alternativeExplanations,
    ...interpretation.limitations,
    ...interpretation.recommendedFollowUps.flatMap(({ question, reason }) => [
      question,
      reason,
    ]),
  ].join(" ").toLowerCase();

  if (/\d/.test(prose)) {
    throw new InterpretationValidationError(
      "UNSUPPORTED_NUMERIC_CLAIM",
      "Numeric evidence values must be represented by validated fact codes.",
    );
  }

  const prohibited = [
    /\boutbreak\b.{0,60}\b(ended|over|resolved|contained)\b/,
    /\b(institution|clinic|facility|source)\b.{0,80}\b(hiding|concealing|suppressing|falsifying)\b/,
    /\b(deliberate|intentional)\b.{0,40}\b(suppression|concealment|misconduct|fraud)\b/,
    /\b(diagnos(?:e|is|ed)|prescrib(?:e|ed)|treat(?:ment|ing)?|medication|clinical advice|medical recommendation)\b/,
  ];
  if (prohibited.some((pattern) => pattern.test(prose))) {
    throw new InterpretationValidationError(
      "UNSUPPORTED_CONCLUSION",
      "The interpretation contains a conclusion outside its permitted scope.",
    );
  }

  const channelAvailability = evidence.observedFacts.channelAvailability;
  const claimsAvailable = /\b(channel|reporting channel)\b.{0,40}\b(is|was|remains)\s+(available|operational|functioning|online)\b/;
  const claimsUnavailable = /\b(channel|reporting channel)\b.{0,40}\b(is|was|remains)\s+(unavailable|offline|not functioning|down)\b/;
  if (
    (channelAvailability === "unknown" &&
      (claimsAvailable.test(prose) || claimsUnavailable.test(prose))) ||
    (channelAvailability === "available" && claimsUnavailable.test(prose)) ||
    (channelAvailability === "unavailable" && claimsAvailable.test(prose))
  ) {
    throw new InterpretationValidationError(
      "EVIDENCE_CONTRADICTION",
      "The interpretation contradicts the supplied channel-availability status.",
    );
  }

  if (
    evidence.calculatedFindings.historicalBaseline.status ===
      "insufficient_history" &&
    /\b(established|statistically established|reliable historical baseline|normal historical pattern)\b/.test(
      prose,
    )
  ) {
    throw new InterpretationValidationError(
      "EVIDENCE_CONTRADICTION",
      "The interpretation overstates the available historical baseline.",
    );
  }
  if (
    evidence.calculatedFindings.anomaly.status !== "anomaly" &&
    /\b(the deterministic engine|the anomaly detector|the system)\b.{0,50}\b(detected|identified|flagged)\b.{0,30}\banomal(?:y|ies)\b/.test(
      prose,
    )
  ) {
    throw new InterpretationValidationError(
      "EVIDENCE_CONTRADICTION",
      "The interpretation contradicts the deterministic anomaly result.",
    );
  }
  if (
    evidence.calculatedFindings.completeness.percent === null &&
    /\b\d+(?:\.\d+)?\s*%/.test(prose)
  ) {
    throw new InterpretationValidationError(
      "EVIDENCE_CONTRADICTION",
      "The interpretation states a percentage when completeness is unavailable.",
    );
  }
}

function validateFactItems(items, field, evidence, availableReferences) {
  if (!Array.isArray(items) || items.length < (field === "observedFacts" ? 1 : 0) || items.length > 8) {
    throw new InterpretationValidationError(
      "INVALID_MODEL_OUTPUT",
      `${field} has an invalid number of entries.`,
    );
  }

  const seen = new Set();
  return items.map((item) => {
    if (!isObject(item) || !exactKeys(item, FACT_KEYS)) {
      throw new InterpretationValidationError(
        "INVALID_MODEL_OUTPUT",
        `${field} entries must contain only factCode and evidenceRefs.`,
      );
    }
    if (
      typeof item.factCode !== "string" ||
      !Object.hasOwn(FACT_REFERENCES, item.factCode) ||
      seen.has(item.factCode)
    ) {
      throw new InterpretationValidationError(
        "INVALID_MODEL_OUTPUT",
        `${field} contains an unsupported or duplicate fact code.`,
      );
    }
    seen.add(item.factCode);

    const requiredReference = FACT_REFERENCES[item.factCode];
    if (
      !Array.isArray(item.evidenceRefs) ||
      item.evidenceRefs.length < 1 ||
      item.evidenceRefs.length > 4 ||
      item.evidenceRefs.some(
        (reference) =>
          typeof reference !== "string" ||
          !availableReferences.has(reference),
      ) ||
      !item.evidenceRefs.includes(requiredReference)
    ) {
      throw new InterpretationValidationError(
        "INVALID_EVIDENCE_REFERENCE",
        `${field} contains a missing or fabricated evidence reference.`,
      );
    }

    const value = getPath(evidence, requiredReference.split("."));
    if (value === undefined) {
      throw new InterpretationValidationError(
        "INVALID_EVIDENCE_REFERENCE",
        `${field} references unavailable evidence.`,
      );
    }
    return {
      factCode: item.factCode,
      value,
      evidenceRefs: [...new Set(item.evidenceRefs)],
    };
  });
}

function validateInterpretationOutput(content, { evidence, availableReferences }) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new InterpretationValidationError(
      "INVALID_MODEL_JSON",
      "Nemotron returned malformed JSON.",
    );
  }
  if (
    !isObject(parsed) ||
    !exactKeys(parsed, RESPONSE_KEYS) ||
    parsed.schemaVersion !== SCHEMA_VERSION ||
    parsed.promptVersion !== PROMPT_VERSION ||
    !isObject(parsed.interpretation) ||
    !exactKeys(parsed.interpretation, INTERPRETATION_KEYS)
  ) {
    throw new InterpretationValidationError(
      "INVALID_MODEL_OUTPUT",
      "Nemotron output does not match the required interpretation schema.",
    );
  }

  const raw = parsed.interpretation;
  if (!FINDING_TYPES.has(raw.findingType)) {
    throw new InterpretationValidationError(
      "INVALID_MODEL_OUTPUT",
      "findingType is unsupported.",
    );
  }
  if (!EVIDENCE_STRENGTHS.has(raw.evidenceStrength)) {
    throw new InterpretationValidationError(
      "INVALID_MODEL_OUTPUT",
      "evidenceStrength is unsupported.",
    );
  }
  const interpretation = {
    headline: requireText(raw.headline, "headline", 160),
    executiveSummary: requireText(raw.executiveSummary, "executiveSummary", 1000),
    findingType: raw.findingType,
    evidenceStrength: raw.evidenceStrength,
    explanation: requireText(raw.explanation, "explanation", 1500),
    observedFacts: validateFactItems(
      raw.observedFacts,
      "observedFacts",
      evidence,
      availableReferences,
    ),
    supportingEvidence: validateFactItems(
      raw.supportingEvidence,
      "supportingEvidence",
      evidence,
      availableReferences,
    ),
    unknowns: requireStringList(raw.unknowns, "unknowns", {
      maxItems: 8,
      maxLength: 300,
    }),
    alternativeExplanations: requireStringList(
      raw.alternativeExplanations,
      "alternativeExplanations",
      { maxItems: 6, maxLength: 300 },
    ),
    recommendedFollowUps: raw.recommendedFollowUps,
    limitations: requireStringList(raw.limitations, "limitations", {
      maxItems: 8,
      maxLength: 300,
    }),
    interpretationBoundary: requireText(
      raw.interpretationBoundary,
      "interpretationBoundary",
      500,
    ),
  };

  if (
    !Array.isArray(interpretation.recommendedFollowUps) ||
    interpretation.recommendedFollowUps.length > 5
  ) {
    throw new InterpretationValidationError(
      "INVALID_MODEL_OUTPUT",
      "recommendedFollowUps has an invalid number of entries.",
    );
  }
  interpretation.recommendedFollowUps = interpretation.recommendedFollowUps.map(
    (followUp) => {
      if (
        !isObject(followUp) ||
        !exactKeys(followUp, FOLLOW_UP_KEYS) ||
        !FOLLOW_UP_PRIORITIES.has(followUp.priority)
      ) {
        throw new InterpretationValidationError(
          "INVALID_MODEL_OUTPUT",
          "A follow-up question has an invalid shape or priority.",
        );
      }
      return {
        question: requireText(followUp.question, "follow-up question", 300),
        reason: requireText(followUp.reason, "follow-up reason", 300),
        priority: followUp.priority,
      };
    },
  );

  const anomalyStatus = evidence.calculatedFindings.anomaly.status;
  const baselineStatus =
    evidence.calculatedFindings.historicalBaseline.status;
  const channelAvailability = evidence.observedFacts.channelAvailability;
  const missingMetrics =
    evidence.observedFacts.eligibleReceivedReports === null ||
    evidence.calculatedFindings.completeness.percent === null;

  if (
    (interpretation.findingType === "no_significant_discontinuity" &&
      (anomalyStatus !== "normal_variation" ||
        channelAvailability !== "available" ||
        missingMetrics)) ||
    (interpretation.findingType === "reporting_discontinuity" &&
      anomalyStatus !== "anomaly" &&
      !["reporting_gap", "channel_unavailable", "incomplete_channel_unavailable"].includes(
        evidence.observedFacts.periodStatus,
      )) ||
    (interpretation.findingType === "possible_reporting_change" &&
      anomalyStatus !== "anomaly") ||
    (interpretation.findingType === "channel_availability_concern" &&
      channelAvailability === "available") ||
    (interpretation.findingType === "insufficient_evidence" &&
      baselineStatus === "ready" &&
      !missingMetrics &&
      channelAvailability !== "unknown") ||
    ((baselineStatus === "insufficient_history" || missingMetrics) &&
      interpretation.evidenceStrength !== "insufficient") ||
    (channelAvailability !== "available" &&
      interpretation.evidenceStrength === "strong")
  ) {
    throw new InterpretationValidationError(
      "EVIDENCE_CONTRADICTION",
      "The interpretation classification conflicts with deterministic evidence.",
    );
  }

  rejectUnsupportedClaims(interpretation, evidence);
  return {
    schemaVersion: SCHEMA_VERSION,
    promptVersion: PROMPT_VERSION,
    interpretation,
  };
}

module.exports = {
  EVIDENCE_STRENGTHS,
  FINDING_TYPES,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  InterpretationValidationError,
  validateInterpretationOutput,
};
