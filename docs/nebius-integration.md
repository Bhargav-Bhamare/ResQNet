# Nebius Token Factory provider

The Nebius client is an opt-in backend service for explicitly requested
inference. It is not called by report submission, evidence generation,
aggregation, baseline calculation, anomaly detection, or investigation
routes. Deterministic reporting evidence remains authoritative and is not
recomputed or modified by this provider.

## Verified API and model catalog

Official Nebius sources checked on 2026-10-30:

- [Token Factory quickstart](https://docs.tokenfactory.nebius.com/quickstart.md)
- [API introduction and authentication](https://docs.tokenfactory.nebius.com/api-reference/introduction.md)
- [Text generation request and response examples](https://docs.tokenfactory.nebius.com/api-reference/examples/text-generation.md)
- [List models](https://docs.tokenfactory.nebius.com/api-reference/examples/list-of-models.md)
- [Inference overview](https://docs.tokenfactory.nebius.com/ai-models-inference/overview.md)
- [Official OpenAPI schema](https://api.tokenfactory.nebius.com/openapi.json)

The documented endpoint is
`POST https://api.tokenfactory.nebius.com/v1/chat/completions`. The API uses
HTTP Bearer authentication (`Authorization: Bearer <API key>`) and JSON chat
messages with `model`, `messages`, generation parameters, and optional
`response_format`. Responses include `choices[0].message.content`,
`choices[0].finish_reason`, `model`, `id`, and usage token counts when provided.
The model-list endpoint is `GET /v1/models`; `?verbose=true` returns additional
catalog information.

The authenticated catalog was queried on 2026-10-30. It listed
`nvidia/Nemotron-3_5-Lightning` as a text-to-text model with a reported context
length of 1,048,576 tokens. Catalog availability and metadata can change;
Task 13 should re-check the configured account's current catalog before use.
The exact model ID can be verified with:

```sh
curl --fail --silent --show-error \
  'https://api.tokenfactory.nebius.com/v1/models?verbose=true' \
  -H "Authorization: Bearer ${NEBIUS_API_KEY}" \
  -H 'Accept: application/json'
```

Only select a Nemotron ID that appears in the authenticated current catalog.
The API supports the `response_format` JSON object option in its text-generation
examples; support can vary by model and should be confirmed before relying on
it. The docs describe OpenAI-compatible request parameters and usage metadata.
They do not provide a provider-specific retry guarantee; the bounded retry
policy below is client-side.

## Configuration and installation

The project already loads `.env` for server-side configuration. Set these
values in the ignored local `.env` file or the deployment secret environment;
`.env.example` contains placeholders only:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NEBIUS_API_KEY` | Yes | — | Secret API key. Keep it server-side; never commit or log it. |
| `NEBIUS_MODEL` | Yes | — | Exact model ID copied from the current authenticated catalog. |
| `NEBIUS_BASE_URL` | No | `https://api.tokenfactory.nebius.com/v1` | Official HTTPS API root, ending in `/v1`; other hosts are rejected. |
| `NEBIUS_TIMEOUT_MS` | No | `30000` | Per-attempt timeout, from 100 to 120000 ms. |
| `NEBIUS_MAX_RETRIES` | No | `2` | Retries after eligible HTTP errors, from 0 to 3. |

Create a key in the official [Token Factory API keys
page](https://tokenfactory.nebius.com/project/api-keys). The API key is shown
once; store it in a secret manager or ignored `.env` file.

## Client contract

Import `createNebiusClient` from `services/llm/nebiusClient.js`. Configuration
is validated when the client is created; missing credentials or model fail
with `CONFIGURATION_ERROR`.

```js
const { createNebiusClient } = require("./services/llm/nebiusClient");

const nebius = createNebiusClient();
const result = await nebius.generateChatCompletion({
  systemPrompt: "Interpret only the supplied, sanitized evidence.",
  userPrompt: JSON.stringify(sanitizedEvidence),
  model: process.env.NEBIUS_MODEL,
  temperature: 0,
  maxTokens: 512,
  responseFormat: { type: "json_object" },
  signal: abortController.signal,
});
```

`generateChatCompletion` accepts required non-empty `systemPrompt` and
`userPrompt` strings; optional `model`, `temperature` (0–2), `maxTokens`
(1–2048), `responseFormat` (`{ type: "json_object" }`),
`reasoningEffort` (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or
`max`), and `signal`. `reasoningEffort` is sent as the verified OpenAI-
compatible `reasoning_effort` parameter when supplied. The combined prompts
are limited to 20000 characters. Generation defaults to temperature 0 and at
most 512 output tokens. Streaming and tool calls are intentionally not exposed.

Success is normalized to:

```js
{
  provider: "nebius",
  model: "model-id-returned-by-provider", // null if not returned
  content: "completion text",
  finishReason: "stop",
  usage: {
    promptTokens: 11,       // null if not returned
    completionTokens: 2,    // null if not returned
    totalTokens: 13         // null if not returned
  },
  requestId: "provider-completion-id", // null if unavailable
  latencyMs: 123
}
```

Failures throw `NebiusProviderError`; `toJSON()` exposes only `name`, `message`,
`code`, `status`, `requestId`, and `retryable`. Supported codes are
`CONFIGURATION_ERROR`, `AUTHENTICATION_ERROR`, `INVALID_REQUEST`,
`MODEL_NOT_FOUND`, `QUOTA_EXCEEDED`, `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`,
`NETWORK_ERROR`, `REQUEST_TIMEOUT`, `REQUEST_ABORTED`,
`INVALID_PROVIDER_RESPONSE`, and `UNKNOWN_PROVIDER_ERROR`. Messages never
include raw provider bodies, prompts, credentials, or stack traces.

The timeout applies to each request attempt. The client retries HTTP 408, 429,
5xx, and 529 responses up to `NEBIUS_MAX_RETRIES`; exponential backoff uses
jitter, respects a valid `Retry-After`, and caps each wait at 10 seconds.
Authentication, invalid request, model, quota, network, local-timeout, and
caller-abort failures are not retried. Network failures and local timeouts are
not retried because the provider may already have accepted the billable
completion. Caller cancellation stops a request or its retry wait.

## Privacy, safety, and cost controls

The client has no database/model dependency and sends only the messages the
caller supplies. It does not choose, fetch, or sanitize evidence. Task 13 must
construct a minimal, sanitized interpretation request and must exclude names,
contact details, precise addresses, raw reports, credentials, and other direct
identifiers. The provider does not log prompts or responses. There is no
automatic inference path or fallback provider. The 20000-character input
limit, 2048-token hard output cap, finite timeout, disabled streaming, and
bounded retries limit resource use; each authorized invocation can still incur
provider charges.

## Tests and live smoke test

Run mocked provider tests with:

```sh
npm run test:nebius
```

After setting `NEBIUS_API_KEY` and a model copied from the authenticated model
catalog, perform one harmless live request with:

```sh
npm run test:nebius:live
```

The smoke test prints the returned model, finish reason, token usage, request
ID, latency, and whether content was received; it does not print the response
or API key. It is manual and is never run by the application or ordinary test
suite.

Live verification on 2026-10-30: the configured
`nvidia/Nemotron-3_5-Lightning` model was present in the authenticated catalog,
and one harmless inference request succeeded. The normalized response reported
28 prompt tokens, 8 completion tokens, 36 total tokens, and 1057 ms latency.
The finish reason was `length` because the smoke test caps generation at 8
tokens. The response text and API key were not printed. This verifies basic
live connectivity and response normalization, not model-specific JSON behavior
or interpretation quality.

## Task 13 handoff and limitations

Task 13 should call `createNebiusClient()` from a server-side, explicitly
authorized interpretation action, sanitize its evidence before supplying
`userPrompt`, and treat the normalized content as model output rather than as
deterministic evidence. It should handle `NebiusProviderError` by `code`
without inspecting Nebius HTTP details.

Live inference and current catalog availability were verified for the
configured account and model on 2026-10-30. Per-model JSON response support,
interpretation quality, continuing account quota, and live billing behavior
still need validation before production use.
