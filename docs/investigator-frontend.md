# Investigator frontend

The protected vanilla-JavaScript workspace is served at `/investigator.html`.
The original public report forms and Leaflet map remain in `/`; use
`window.RESQNET_API_BASE_URL` before loading the module to point the workspace
at a separate API origin. The default is the current origin.

## API contract

| Screen/action | Endpoint | Behavior |
| --- | --- | --- |
| Sign in / restore / sign out | `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout` | Bearer token; login returns token, expiry, and investigator; logout returns 204. |
| Overview and reporting | `GET /api/reporting-completeness` | Authenticated and source-scoped; returns source codes, current period, expected/eligible counts, completeness, channel availability, status, evaluation time, and limitations. |
| Investigation list | `GET /api/investigations?page=&limit=&sort=&status=&sourceCode=&createdBy=&assignedTo=` | Authenticated, server paginated, max limit 100; current UI requests 25 and uses only supported filters. |
| Evidence preview / create | `GET /api/investigations/:sourceCode/evidence`, `POST /api/investigations/:sourceCode` | Authenticated. Preview is read-only. Creation sends `{}` and only occurs after explicit confirmation. |
| Investigation detail / reviews | `GET /api/investigations/:investigationId` | Returns the persisted evidence snapshot and up to 100 chronological review entries. |
| Notes / status / decision | `POST /api/investigations/:id/notes`, `PATCH /api/investigations/:id/status`, `POST /api/investigations/:id/decision` | Viewer is read-only. Transitions and decision enums match the backend. |
| AI history / retrieve / generate | `GET /api/investigations/:id/interpretations`, `GET /api/investigations/:id/interpretations/:interpretationId`, `POST /api/investigations/:id/interpretations` | Generation is explicit, confirmed, and only successful when the response is marked `validated`. |

The frontend API client applies bearer authentication, JSON headers, a finite
request timeout, safe response parsing, and normalized errors. It never logs or
renders the token. The session token is held in `sessionStorage` for the
current tab and cleared on logout, expiry, or an authenticated 401.

All untrusted API text is added with DOM `textContent`/text nodes. The
interpretation view refuses to render a record unless its backend
`validationStatus` is `validated`; failed provider output is never available to
the frontend.

## Backend capabilities not exposed by an API

- There is no investigator listing endpoint. Admin assignment controls and
  investigator management lists are therefore omitted; the existing
  assignment mutation cannot safely populate eligible assignees by itself.
- Completeness does not return source names or reporting frequency. The UI
  shows the source code and marks frequency as unavailable there; the preview
  includes schedule data when it is present in the evidence snapshot.
- The backend has no live map-data endpoint. Public map points are identified
  as illustrative, and no fabricated incident feed is shown.
- The legacy `/api/evidence` evaluator is admin-only and accepts client-entered
  estimates. The protected workspace instead uses source-based deterministic
  preview and investigation APIs.
