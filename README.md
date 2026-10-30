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
