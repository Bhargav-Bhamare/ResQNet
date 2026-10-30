# ResQNet judge quick start

This guide is a short setup and trial script for the ResQNet demonstration. It
covers the public reporting site and the protected NULL SIGNAL investigator
workspace, including the features that need external configuration.

## What to expect

| Feature | What the demo does | Important limit |
| --- | --- | --- |
| Symptom reports | Saves a community report to MongoDB for platform review. | It is not medical advice, and it does not contact a clinician or emergency service. |
| Disaster reports | Saves a disaster observation for platform review. | An optional selected photo is previewed locally; it is not uploaded. No response is guaranteed. |
| Map | Shows a Leaflet map with fixed sample points. | Points are illustrative, not live incidents. There is no live map feed. |
| SOS | Shows a press-and-hold countdown demonstration. | It sends no SOS, location, or notification and dispatches no help. |
| Reporting completeness | Shows reporting-period counts and channel status for sources the signed-in user may access. | It requires configured reporting sources; frequency may be unavailable in the summary view. |
| Evidence preview and investigation | Calculates source-based reporting evidence, then can save a snapshot for human review. | It uses trusted, source-attributed reports. Public submissions are not source-attributed and do not feed this workflow. |
| Review workflow | Supports review notes, investigator decisions, and status changes with chronological review history. | Viewers can inspect but cannot make changes. |
| AI interpretation | On explicit request, asks the configured Nebius Nemotron provider to interpret a sanitized evidence snapshot. | Optional; requires provider credentials, can incur charges, and does not replace deterministic evidence or human review. |

The API also retains legacy admin-only evidence evaluation endpoints that use
manually supplied counts or a user-entered area, expected count, time window,
and channel status. They are not exposed in the current public or investigator
UI; for the judge walkthrough, use the protected source-based workspace above.

## Requirements

- Node.js and npm (Node.js 20 LTS recommended).
- A MongoDB database reachable by the machine running the app. A MongoDB Atlas
  database is suitable; make sure its network access rules permit your machine.
- For the investigator walkthrough: an initial admin account and at least one
  configured reporting source. To generate meaningful historical evidence,
  that source also needs trusted, source-attributed report data.
- For the optional AI trial only: a Nebius Token Factory API key and a model
  available to that account.

## Run locally

From the repository root in PowerShell:

```powershell
npm ci
Copy-Item .env.example .env
```

Edit `.env` and set `MONGODB_URI` to your database connection string. Set a
local `PORT` if needed; it defaults to `3000`. To create the one-time initial
administrator, also set:

```text
BOOTSTRAP_ADMIN_NAME=Demo Administrator
BOOTSTRAP_ADMIN_EMAIL=admin@example.test
BOOTSTRAP_ADMIN_PASSWORD=<unique password of at least 12 characters>
```

Keep `.env` private and do not commit it. Create the initial admin once:

```powershell
npm run bootstrap-admin
```

After it succeeds, remove the three `BOOTSTRAP_ADMIN_*` values from `.env`.
Bootstrap is intentionally disabled after an investigator account has been
created.

Start the application:

```powershell
npm start
```

Open [http://localhost:3000](http://localhost:3000) for the public site, or
[http://localhost:3000/investigator.html](http://localhost:3000/investigator.html)
for the protected investigator workspace. If you changed `PORT`, use that
port instead. Verify the app and database with:

- [http://localhost:3000/api/health](http://localhost:3000/api/health) — should
  return `status: "running"`.
- [http://localhost:3000/api/db-health](http://localhost:3000/api/db-health) —
  should return `status: "connected"`.

The server requires MongoDB to start. If startup fails, check `MONGODB_URI`,
database credentials, DNS/connectivity, and the database network access list.

## Judge trial: public site (about 3 minutes)

1. On the home page, follow **Report Symptoms**. Select at least one symptom,
   choose a severity, optionally enter a short non-sensitive description or
   region, then submit. A success message means the report was saved.
2. Follow **Report Disaster**. Select a disaster type and severity and submit.
   You can select an image to see the local preview; the page explains that the
   image is not uploaded.
3. Open **Live Map**. Confirm that the page identifies its markers as sample
   points and that no live incident feed is connected.
4. Open **SOS demo (no dispatch)**. Briefly press and hold the demo control to
   see the countdown, then release to cancel. No alert or dispatch is sent.

Use clearly fictitious demonstration details. Do not submit real patient
information or use the SOS demo in place of emergency services.

## Judge trial: investigator workspace (about 5 minutes)

Sign in at `/investigator.html` with the initial admin credentials created
above. The workspace provides:

1. **Overview / Reporting completeness** — inspect source-scoped current-period
   counts, expected submissions, completeness, channel availability, status,
   evaluation time, and limitations.
2. **Evidence preview** — choose a configured source code and preview its
   evidence without saving an investigation. Review the current period,
   eligible historical observations, baseline, and deterministic anomaly
   findings where available.
3. **Create an investigation** — explicitly confirm creation from the preview.
   Open the new investigation to inspect its persisted evidence snapshot and
   review history.
4. **Review and record a decision** — add a note, move the investigation from
   `generated` to `under_review`, and record an investigator-assessed decision.
   Depending on the evidence, continue to `requires_more_information` or
   `reviewed`; a reviewed investigation can be closed. Closed investigations
   cannot be reopened.
5. **Optional AI interpretation** — if configured, explicitly request an
   interpretation from an open investigation. Inspect its facts, references,
   unknowns, limitations, and follow-up questions alongside the deterministic
   evidence. Only validated interpretations are displayed; failed output is
   not presented as a successful interpretation.

Decisions available in the review workflow are reporting discontinuity
observed, channel availability concern, insufficient evidence, no significant
discontinuity, and other. The workflow records review actions and does not
rewrite the original evidence snapshot.

## Investigator data setup: important

This repository does not include seeded reporting sources or demo source
reports, a public source-onboarding screen, or a source-creation endpoint.
Source credential provisioning and trusted source ingestion are intentionally
not exposed as public HTTP endpoints, and the repository does not ship a source
seed/provisioning command. An admin account by itself therefore does not
guarantee that the evidence preview has a source to inspect.

Before the investigator trial, arrange with the project operator to provision
a controlled demo source, valid reporting schedule, source credentials, and
trusted attributed reports through a separately controlled server-side process.
Then sign in as admin (admins can inspect configured sources), or have the
operator create an investigator account with access to that source. The admin
account API can create accounts only for already-configured sources; the
browser workspace does not provide investigator-management screens.

Do not treat public symptom/disaster reports as trusted reporting-source
records. The two data paths are deliberately separate. If the demo source has
no eligible trusted historical reports, baseline and anomaly findings may be
unavailable; this is not evidence that no real-world activity occurred.

## Optional Nebius / Nemotron setup

AI interpretation is optional and is never called automatically. To enable it,
set these server-side values in the ignored `.env` file:

```text
NEBIUS_API_KEY=<your API key>
NEBIUS_MODEL=<model ID available to your account>
```

The default API base URL is `https://api.tokenfactory.nebius.com/v1`.
`NEBIUS_TIMEOUT_MS` and `NEBIUS_MAX_RETRIES` are optional; see
[Nebius integration](./nebius-integration.md) and
[Nemotron interpretation](./nemotron-interpretation.md) for configuration,
data handling, and limits. Keep the key secret. Explicit interpretation
requests may incur provider charges. Without valid provider configuration,
the core public and deterministic investigator workflows remain usable.

## Tests and troubleshooting

Run the automated test suite from the repository root:

```powershell
npm test
```

Optional focused suites and manual live-provider checks:

```powershell
npm run test:ai
npm run test:nebius
npm run test:ai:live
npm run test:nebius:live
```

The `*:live` commands contact the configured provider and may incur costs;
they require valid Nebius credentials/model configuration. They are not needed
to run the app or the ordinary tests.

| Symptom | Check |
| --- | --- |
| App does not start | Confirm `.env` exists, `MONGODB_URI` is set, and MongoDB is reachable. |
| `/api/db-health` says disconnected | Check the MongoDB URI, user/password, DNS, and network access rules. |
| Public report submission fails | Confirm the database health check is connected. |
| No source is available to preview | Ask the project operator to provision a configured source and grant access; there is no source-creation UI or seed data. |
| Evidence has no useful historical baseline | Confirm trusted attributed reports cover completed reporting periods for the configured source. |
| AI interpretation is unavailable | Check the server-side Nebius key/model and provider quota/network; the AI feature is optional. |
