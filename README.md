# ResQNet
ResQNet — Public Health Outbreak &amp; Crisis Response Network is a community-driven platform designed to detect health threats early and improve coordination between citizens, healthcare teams, and government authorities.

## Quick start

For local setup and a judge-ready feature walkthrough, see the
[ResQNet judge quick start](./docs/quick-start-judges.md). It covers the public
reporting demo, protected investigator workflow, required source data, and
optional Nebius/Nemotron setup.

## Trusted reporting-source attribution

Public report submission is unauthenticated, while the investigator API has
separate account authentication and role-based authorization. Source credential
provisioning and authenticated source ingestion are not exposed as HTTP
endpoints. `services/sourceAttribution.js` provides an internal service
boundary for provisioning, revoking, authenticating, auditing, and querying
source-attributed reports. Its provisioning method is only appropriate for a
trusted server-side operator process; it must not be wired to a public route
until an authenticated source-onboarding process exists.

Source credentials are generated from cryptographically secure random bytes.
Only a SHA-256 hash of the high-entropy secret is stored, and the raw credential
is returned once by the internal provisioning method. Successful attribution
requires both an authenticated, active credential and a source that is active
and within its configured validity period. Successful and rejected decisions
are recorded in `ReportAttribution`; trusted report lookup requires a successful
audit record as well as server-assigned `sourceId` and `sourceChannel` fields.
The ordinary public report endpoint remains unauthenticated and cannot assign
these fields.

This mechanism does not establish a facility's legal identity or institutional
authorization. Controlled facility onboarding, secure operator authentication,
credential delivery, rotation procedures, and operational incident response
remain prerequisites before it can be enabled for real sources.

## Historical reporting-period aggregation

`services/reportingPeriodAggregation.js` creates bounded daily or weekly
observations using the source's configured frequency, timezone, expected count,
validity window, and the same local-time boundary helpers as the current
completeness calculation. Range arguments are half-open UTC timestamps that
must align with local reporting-period boundaries. Daily ranges are capped at
366 periods and weekly ranges at 104 periods.

The aggregator calls the server-controlled `getTrustedReports` lookup with the
requested period window. Empty periods are emitted as zero only after that
lookup confirms a completed source-specific query and its window coverage.
Reports are assigned by the server-generated `Report.submittedAt` timestamp;
the accepted attribution audit timestamp is retained as provenance and must
also be valid and no later than evaluation. Client-provided `reportedAt` is an
event time and does not determine the reporting period. Reports are deduplicated
by database ID, not by their content.

Each observation contains the historical-baseline fields and current-period
fields consumed by the existing anomaly/completeness calculations. Its
`isTrusted` flag means only that aggregation ran over a configured source and a
completed, audit-backed server query; it is not legal or institutional
verification. Channel availability defaults to `unknown` and can only be
overridden per period by an explicit trusted caller. In-progress periods remain
in progress and are excluded by the baseline calculator. This service does not
create an API endpoint, write database records, or analyze real historical data
until trusted source reports actually exist.

## End-to-end evidence pipeline

`services/evidencePipeline.js` exposes `generateEvidenceForSource` for a
configured source code, a local-period-aligned `historyStart`, an evaluation
timestamp, and optional trusted per-period channel-availability data. It
resolves the source server-side and runs the trusted lookup, bounded period
aggregation, current-period completeness calculation, eligible historical
baseline, deterministic anomaly detection, and evidence-package builder in
sequence. It does not create an endpoint or write reports.

The current period is evaluated separately and never enters its own baseline.
Only completed, trusted historical observations are passed to the baseline
service; that service retains its minimum-history and unavailable-channel
rules. Successful empty trusted queries remain zero-report observations, while
failed or incompletely covered queries stop the pipeline with a stage-specific
error. `EvidencePipelineError.code` identifies the failed stage, and the
original cause is retained where available. Pipeline findings describe
reporting patterns only; they do not establish symptom prevalence, causation,
or real-world reporting behavior without validated trusted records.

## Investigator authentication and evidence access

Investigator accounts are separate from source-ingestion credentials. Passwords
are stored as salted Node.js `scrypt` hashes; the API issues random opaque
bearer tokens and stores only their SHA-256 hashes in revocable sessions. Tokens
expire after eight hours. Login uses a per-process IP rate limit; requests use
the `Authorization: Bearer <token>` header, not cookies, so this API does not
use cookie sessions or require cookie-based CSRF tokens.

For local setup, copy `.env.example` to the ignored `.env` file and configure
the MongoDB URI and bootstrap values there. Never commit `.env`.
Create the initial administrator only from a controlled machine after setting
`BOOTSTRAP_ADMIN_NAME`, `BOOTSTRAP_ADMIN_EMAIL`, and a unique
`BOOTSTRAP_ADMIN_PASSWORD` of at least 12 characters in a protected local
environment. Then run `npm run bootstrap-admin`. The command refuses to run
after any investigator account exists and claims a unique database bootstrap
record before creating the account, preventing concurrent/repeated bootstrap.
If the process fails after claiming that record, stop and resolve it through a
controlled database administration procedure; do not expose a reset endpoint.
Do not commit these values or put them in shell history; remove the bootstrap
variables after initialization.
Administrators can create accounts and assign configured source codes. Admins
can inspect any configured source; investigators and viewers can inspect only
their assigned sources. Deactivation revokes sessions. No public registration
or source-credential provisioning endpoint is provided.

The read-only evidence endpoint is
`GET /api/investigations/:sourceCode/evidence`, with optional `evaluatedAt`
(UTC ISO timestamp, not in the future) and `periods` query parameters.
Historical periods default to 30 daily or 12 weekly periods and are capped at
365 daily or 103 weekly periods, leaving room for the current period within the
aggregation service's bound. Evidence generation still uses the trusted
attribution-backed pipeline. Investigation requests record the investigator,
source code, timestamps, outcome, safe error code, and request identifier.
Audit persistence is fail-closed: evidence is not returned if the audit write
fails. The legacy all-source completeness route now requires authentication
and limits results to the caller's authorized sources; raw report reads and
legacy evidence routes are admin-only.

This is not a production security certification. Login rate limits are
in-memory and per-process, so deployment needs a shared rate limiter, correctly
configured proxy/network boundaries, HTTPS, secret management, backups,
account recovery, audit retention controls, and verified institutional
identity/onboarding procedures. Never treat account role assignment as proof
of a person's institutional identity or a report's source attribution.

## Investigation history and human review

`POST /api/investigations/:sourceCode` generates evidence through the existing
deterministic pipeline and persists a new `evidence_review` investigation with
a unique `inv_<32 lowercase hex characters>` public ID, source/creator
references, exact evaluation time, requested period count, initial `generated`
status, and a sanitized snapshot of the complete evidence package. Its optional
JSON body accepts only `evaluatedAt` and integer `periods`. The existing
`GET /api/investigations/:sourceCode/evidence` remains a read-only preview; it
does not create an investigation.

The history endpoints are `GET /api/investigations`,
`GET /api/investigations/:investigationId`, and
`GET /api/investigations/:investigationId/reviews`. Authenticated investigators
and viewers can list and read records only for their assigned sources. Listing
supports bounded `page`, `limit`, `sourceCode`, `status`, `createdBy`,
`assignedTo`, and `sort=asc|desc` filters. Details include the immutable
evidence snapshot and up to 100 most recent review records in chronological
order. Review-history pagination supports bounded `page` and `limit`. Public
investigation IDs are distinct from MongoDB document IDs.

Investigators can append notes through
`POST /api/investigations/:investigationId/notes`, record investigator-assessed
decisions through `POST /api/investigations/:investigationId/decision`, and
change status through `PATCH /api/investigations/:investigationId/status`.
Allowed status transitions are `generated -> under_review`,
`under_review -> requires_more_information` or `reviewed`,
`requires_more_information -> under_review`, and `reviewed -> closed`.
Closed investigations cannot be reopened through this API. Admins can assign
or unassign through `PATCH /api/investigations/:investigationId/assignment`,
only to an active investigator who already has access to that source. Viewers
are read-only. Reviewer identity and timestamps are always assigned by the
server, and decisions are stored as review history rather than mixed into
calculated findings.

Evidence snapshots and review records are immutable through the Mongoose model
and application routes provide no update/delete operations for review history.
Creation writes the investigation and its initial review record sequentially;
if a later write or required investigation audit fails, the route attempts a
compensating deletion and returns an error rather than success. This is not a
MongoDB transaction: a process crash between writes or a failed compensation
can leave incomplete records and requires operational reconciliation. Direct
database administrators can still bypass application-level immutability.
Review records are append-only for API purposes, not a tamper-proof legal
record. No real reporting-source investigations are implied by this workflow.
