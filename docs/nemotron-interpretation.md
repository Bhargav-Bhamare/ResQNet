# Nemotron evidence interpretation

NULL SIGNAL's deterministic evidence remains the source of truth. This
feature lets an authenticated investigator explicitly ask NVIDIA Nemotron to
explain a stored evidence snapshot through the Task 12 Nebius Token Factory
client. It does not recalculate evidence, classify outbreaks, or run during
report submission, aggregation, baseline calculation, anomaly detection, or
investigation creation.

## Verified model and provider

The configured account's authenticated Token Factory catalog was checked on
2026-10-30 and listed **`nvidia/Nemotron-3_5-Lightning`** as text-to-text with a
reported context length of 1,048,576 tokens. A live inference response for this
model was previously verified through Task 12. The account-level catalog can
change; re-check the exact configured ID before use:

```sh
curl --fail --silent --show-error \
  'https://api.tokenfactory.nebius.com/v1/models?verbose=true' \
  -H "Authorization: Bearer ${NEBIUS_API_KEY}" \
  -H 'Accept: application/json'
```

Official sources:

- [Nebius Token Factory quickstart](https://docs.tokenfactory.nebius.com/quickstart.md)
- [Token Factory API introduction and authentication](https://docs.tokenfactory.nebius.com/api-reference/introduction.md)
- [Token Factory text generation request and response examples](https://docs.tokenfactory.nebius.com/api-reference/examples/text-generation.md)
- [Token Factory model-list example](https://docs.tokenfactory.nebius.com/api-reference/examples/list-of-models.md)
- [NVIDIA Nemotron model page](https://www.nvidia.com/en-us/ai-data-science/foundation-models/nemotron/)

The implementation calls the existing `createNebiusClient()` provider from
`services/llm/nebiusClient.js`; it does not add another HTTP client. JSON-object
response mode is requested through the Task 12 API option, then independently
parsed and validated. This is basic structured JSON mode, not a provider-
enforced JSON Schema guarantee. No claim is made that every Nemotron model
feature or response mode is supported.

## Data flow and sanitization

1. The authorized caller requests interpretation of a persisted
   `evidence_review` investigation.
2. The route reads its immutable `evidenceSnapshot` and stored `evidenceVersion`.
3. `sanitizeEvidenceSnapshot()` checks the supported evidence version and
   constructs a new allowlisted object. The original snapshot is not edited.
4. The interpreter hashes canonical sanitized JSON with SHA-256, creates the
   versioned prompt, and calls the Task 12 client with temperature `0`, JSON
   response format, `reasoningEffort: "none"`, a 2048-token output cap, and
   inherited finite timeout and bounded HTTP retries.
5. The validator parses the model's JSON, checks the exact schema and evidence
   references, and applies deterministic consistency/scope checks.
6. Only a validated result is saved as a new immutable `AIInterpretation`.
   Attempt lifecycle metadata is appended to `AIInterpretationAudit`.
7. The API returns normalized saved fields; no raw provider response or prompt
   is stored.

Only these allowlisted values are sent:

- Evidence/package version.
- Evaluation timestamp, reporting frequency, period boundaries, and expected
  reports per period.
- Expected and trusted received report counts, period status, channel
  availability, and historical observation count.
- Deterministic completeness status and percentage.
- Historical baseline status, minimum/valid period counts, and available
  aggregate statistics.
- Deterministic anomaly status/type/category and available numeric deviations.

Null values remain `null`; unavailable values are not calculated or filled in.
Source identifiers/names, package IDs, trusted report references, historical
observation details, timezone, free-text explanations, limitations, possible
explanations, thresholds, raw reports, symptoms, patient identifiers, provider
credentials, and investigation/investigator IDs are not sent. Unexpected
snapshot fields are ignored. Free-text fields in the snapshot are deliberately
excluded because they are untrusted and may contain prompt injection.

Sanitized evidence is capped at 12,000 serialized characters, below the Task
12 provider's 20,000-character combined prompt limit. The interpretation input
does not grant tools, external actions, or autonomous execution.

## Prompt version and output

The system prompt is version **`1.0`** and the interpretation schema version is
**`1.0`**. The prompt requires the model to treat evidence as untrusted data,
ignore embedded instructions, preserve deterministic findings, distinguish
facts from interpretations, identify unknowns, avoid causal/clinical/
misconduct conclusions, and return JSON only.

The provider returns `observedFacts` and `supportingEvidence` as lists of
`factCode` plus `evidenceRefs`. `interpretationValidator.js` verifies each code
and path against fields actually present in the sanitized object. It attaches
the exact referenced values itself; a model cannot supply or alter a fact's
value. Free-text fields do not contain numerical claims.

Validated interpretation shape:

```json
{
  "headline": "A reporting discontinuity requires verification",
  "executiveSummary": "The reporting gap is observed, but its cause is unknown.",
  "findingType": "channel_availability_concern",
  "evidenceStrength": "limited",
  "explanation": "The supplied evidence does not establish a change in public-health activity.",
  "observedFacts": [
    {
      "factCode": "eligible_received_reports",
      "value": 0,
      "evidenceRefs": ["observedFacts.eligibleReceivedReports"]
    }
  ],
  "supportingEvidence": [],
  "unknowns": ["Channel operation has not been verified."],
  "alternativeExplanations": ["A temporary reporting interruption is possible."],
  "recommendedFollowUps": [
    {
      "question": "Can the source confirm whether reporting was operational?",
      "reason": "Channel availability is unknown.",
      "priority": "high"
    }
  ],
  "limitations": ["The evidence does not establish whether activity changed."],
  "interpretationBoundary": "This describes reporting evidence, not its cause."
}
```

Allowed `findingType` values are `reporting_discontinuity`,
`possible_reporting_change`, `channel_availability_concern`,
`insufficient_evidence`, `no_significant_discontinuity`, and `other`.
`evidenceStrength` is `insufficient`, `limited`, `moderate`, or `strong`; it
describes evidence quality, not outbreak probability or statistical
confidence. Follow-up priority is `low`, `medium`, or `high`.

The validator rejects malformed JSON, extra properties, invalid enums,
oversized fields/lists, invented references, invalid classifications,
unavailable percentages, unsupported numeric claims in prose, detected
channel/baseline/anomaly contradictions, and obvious prohibited outbreak,
misconduct, or clinical conclusions. These checks reduce risk but cannot
prove that every natural-language assertion is true; investigators must review
the output against the cited deterministic values.

## Persistence, history, and audit

`AIInterpretation` stores only validated interpretations, separate from the
immutable investigation snapshot and investigator review/decision history. It
records investigation/source, requesting investigator, provider/model,
prompt/schema/evidence versions, SHA-256 hash of canonical sanitized JSON,
validated interpretation, provider request ID, usage, latency, and timestamp.
Interpretations are append-only; each explicit regeneration creates a new
record and leaves earlier interpretations unchanged.

`AIInterpretationAudit` appends `started`, `succeeded`, and `failed` events for
an attempt. It stores identifiers, timestamps, model, evidence hash, safe error
code, provider request ID, usage, and latency—never prompts, reports, keys,
passwords, or session tokens. Audit-start persistence is required before
inference. A successful interpretation may already have been saved if the
subsequent audit-completion write fails; in that case the API returns an
explicit audit failure rather than a false complete response.

Simultaneous requests for one investigation are rejected within the current
Node process to reduce accidental duplicate billing. This lock is not
distributed across multiple app instances. Sequential POSTs are explicit
regenerations and always create new model attempts; there is no silent reuse or
automatic regeneration.

## Authenticated API

All paths are mounted under `/api/investigations` and use the existing
investigator bearer authentication and source-code access checks.

### Generate

`POST /api/investigations/:investigationId/interpretations`

Send an empty JSON object (or no body). Evidence, source, model key, and
investigator identity are read or configured server-side and are not accepted
from the client.

```sh
curl --fail-with-body \
  -X POST \
  'http://localhost:3000/api/investigations/inv_<32-lowercase-hex>/interpretations' \
  -H "Authorization: Bearer ${INVESTIGATOR_SESSION_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Success is `201` with `{ "interpretation": { ...saved fields... } }`.
Investigators and admins can generate interpretations for accessible sources;
viewers cannot. Closed investigations reject new generation with `409`.

### List history

`GET /api/investigations/:investigationId/interpretations?page=1&limit=25`

All authorized roles, including viewers, can read. Page defaults to `1`;
`limit` defaults to `25` and is capped at `100`. Large offsets are rejected.
Results are newest first.

### Retrieve one

`GET /api/investigations/:investigationId/interpretations/:interpretationId`

Retrieval validates both IDs, source authorization, and that the interpretation
belongs to the specified investigation. Cross-investigation IDs return 404.

An interpretation response includes `provider`, `model`, `promptVersion`,
`schemaVersion`, `evidenceVersion`, `evidenceHash`, validated content,
`validationStatus`, `providerRequestId`, nullable usage counts, latency, and
creation time.

Provider/configuration/rate/quota/timeout/schema/evidence failures return safe
error codes and do not create a successful interpretation record. Error
responses never include provider bodies, stack traces, prompts, or keys.

## Configuration and running

Use the Task 12 `.env` variables: `NEBIUS_API_KEY`, `NEBIUS_MODEL`,
`NEBIUS_TIMEOUT_MS`, and `NEBIUS_MAX_RETRIES`. The model remains configurable;
the application does not silently select a replacement. For lowest retry
cost, set `NEBIUS_MAX_RETRIES=0`; otherwise Task 12's bounded policy allows at
most three HTTP attempts for retryable provider responses.

Mocked interpretation tests:

```sh
npm run test:ai
npm test
```

One real request using a small synthetic evidence package, strict validation,
and safe result metadata:

```sh
npm run test:ai:live
```

The smoke script does not use a database or persist an investigation; database
model validation and route persistence/retrieval are covered by isolated
automated tests. For an authenticated API integration, create a synthetic
investigation in a non-production test database, POST to its interpretation
endpoint, then GET its history and record. No actual health reports should be
used in a provider test.

## Limitations

- The authenticated model catalog and a basic live completion were verified
  for `nvidia/Nemotron-3_5-Lightning`; ongoing availability, account quota, and
  pricing may change.
- A provider-level live synthetic request using `reasoning_effort: "none"`
  returned JSON content, while default reasoning consumed the entire
  2048-token output cap without producing a final message. This setting is
  supported by the current Nebius OpenAPI schema and confirmed for the
  configured model/account. The end-to-end live smoke test has not yet passed:
  current model output has been rejected by strict validation for unsupported
  numeric prose or evidence references. No generated interpretation was
  accepted or persisted during this verification.
- JSON-object mode is requested, but the client still validates every output;
  structured-schema enforcement is not assumed.
- Natural-language contradiction safeguards are intentionally conservative
  deterministic checks, not a proof of factual correctness.
- In-process duplicate suppression does not coordinate across multiple server
  processes.
- Live smoke testing validates provider output only; it does not write to a
  production MongoDB database.
- This feature does not implement a frontend, automated alerts, clinical
  conclusions, or causal attribution.

## Task 14 handoff

The frontend should call the authenticated generation endpoint only after an
explicit user action, display loading and safe error states, and present
validated facts with their evidence references, unknowns, alternatives,
limitations, provider/model/version metadata, and prior history. It must not
present arbitrary raw model text as evidence or imply that AI changes the
deterministic package.
