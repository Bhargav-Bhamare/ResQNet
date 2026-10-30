# ResQNet
ResQNet — Public Health Outbreak &amp; Crisis Response Network is a community-driven platform designed to detect health threats early and improve coordination between citizens, healthcare teams, and government authorities.

## Trusted reporting-source attribution

The backend has no user authentication or administrator authorization system.
Source credential provisioning and authenticated source ingestion are therefore
not exposed as HTTP endpoints. `services/sourceAttribution.js` provides an
internal service boundary for provisioning, revoking, authenticating, auditing,
and querying source-attributed reports. Its provisioning method is only
appropriate for a trusted server-side operator process; it must not be wired to
a public route until an authenticated administrative onboarding process exists.

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
