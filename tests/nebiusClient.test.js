const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NebiusProviderError,
  createNebiusClient,
} = require("../services/llm/nebiusClient");

const config = {
  apiKey: "secret-api-key",
  model: "nvidia/verified-model",
  baseUrl: "https://api.tokenfactory.nebius.com/v1",
  timeoutMs: 100,
  maxRetries: 2,
};

function testEnvironment({ timeoutMs = config.timeoutMs, maxRetries = config.maxRetries } = {}) {
  return {
    NEBIUS_API_KEY: config.apiKey,
    NEBIUS_MODEL: config.model,
    NEBIUS_BASE_URL: config.baseUrl,
    NEBIUS_TIMEOUT_MS: String(timeoutMs),
    NEBIUS_MAX_RETRIES: String(maxRetries),
  };
}

function response(status, data, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
    async json() {
      if (data instanceof Error) throw data;
      return data;
    },
  };
}

function successfulResponse(overrides = {}) {
  return response(200, {
    id: "chatcmpl-test-123",
    model: "nvidia/verified-model",
    choices: [
      {
        message: { role: "assistant", content: "READY" },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 2,
      total_tokens: 13,
    },
    ...overrides,
  });
}

function createClient({ fetchImpl, overrides = {} }) {
  return createNebiusClient({
    env: testEnvironment(overrides),
    fetchImpl,
    sleep: async () => {},
    random: () => 0,
  });
}

test("client sends an OpenAI-compatible chat-completions request", async () => {
  let observed;
  const client = createClient({
    fetchImpl: async (url, init) => {
      observed = { url, init, body: JSON.parse(init.body) };
      return successfulResponse();
    },
  });

  await client.generateChatCompletion({
    systemPrompt: "system instruction",
    userPrompt: "sanitized question",
    temperature: 0.2,
    maxTokens: 32,
  });

  assert.equal(
    observed.url,
    "https://api.tokenfactory.nebius.com/v1/chat/completions",
  );
  assert.equal(observed.init.method, "POST");
  assert.equal(observed.init.headers.Authorization, "Bearer secret-api-key");
  assert.equal(observed.init.headers["Content-Type"], "application/json");
  assert.deepEqual(observed.body, {
    model: "nvidia/verified-model",
    messages: [
      { role: "system", content: "system instruction" },
      { role: "user", content: "sanitized question" },
    ],
    temperature: 0.2,
    max_tokens: 32,
    stream: false,
  });
});

test("client supports a per-request model and JSON response format", async () => {
  let body;
  const client = createClient({
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return successfulResponse();
    },
  });

  await client.generateChatCompletion({
    systemPrompt: "system",
    userPrompt: "question",
    model: "other/verified-model",
    responseFormat: { type: "json_object" },
  });

  assert.equal(body.model, "other/verified-model");
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("client accepts only documented reasoning-effort options", async () => {
  let body;
  const client = createClient({
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return successfulResponse();
    },
  });

  await client.generateChatCompletion({
    systemPrompt: "system",
    userPrompt: "question",
    reasoningEffort: "none",
  });
  assert.equal(body.reasoning_effort, "none");

  await assert.rejects(
    client.generateChatCompletion({
      systemPrompt: "system",
      userPrompt: "question",
      reasoningEffort: "disabled",
    }),
    (error) => error.code === "INVALID_REQUEST",
  );
});

test("client normalizes response content and metadata", async () => {
  const client = createClient({ fetchImpl: async () => successfulResponse() });
  const result = await client.generateChatCompletion({
    systemPrompt: "system",
    userPrompt: "question",
  });

  assert.deepEqual(result, {
    provider: "nebius",
    model: "nvidia/verified-model",
    content: "READY",
    finishReason: "stop",
    usage: {
      promptTokens: 11,
      completionTokens: 2,
      totalTokens: 13,
    },
    requestId: "chatcmpl-test-123",
    latencyMs: result.latencyMs,
  });
  assert.ok(Number.isInteger(result.latencyMs));
});

test("client handles optional response metadata without fabricating values", async () => {
  const client = createClient({
    fetchImpl: async () =>
      response(200, {
        choices: [{ message: { content: "READY" } }],
      }, { "x-request-id": "provider-request-4" }),
  });
  const result = await client.generateChatCompletion({
    systemPrompt: "system",
    userPrompt: "question",
  });

  assert.equal(result.model, null);
  assert.equal(result.finishReason, null);
  assert.deepEqual(result.usage, {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
  });
  assert.equal(result.requestId, "provider-request-4");
});

test("client rejects invalid prompts and generation limits before networking", async () => {
  let calls = 0;
  const client = createClient({
    fetchImpl: async () => {
      calls += 1;
      return successfulResponse();
    },
  });
  const invalidInputs = [
    { systemPrompt: "", userPrompt: "question" },
    { systemPrompt: "system", userPrompt: " " },
    { systemPrompt: "s".repeat(10_001), userPrompt: "u".repeat(10_000) },
    { systemPrompt: "system", userPrompt: "question", temperature: 2.1 },
    { systemPrompt: "system", userPrompt: "question", maxTokens: 2049 },
    { systemPrompt: "system", userPrompt: "question", responseFormat: { type: "unknown" } },
    { systemPrompt: "system", userPrompt: "question", responseFormat: { type: "text" } },
  ];

  for (const input of invalidInputs) {
    await assert.rejects(
      client.generateChatCompletion(input),
      (error) => error.code === "INVALID_REQUEST",
    );
  }
  assert.equal(calls, 0);
});

const statusCases = [
  [400, "INVALID_REQUEST", false],
  [401, "AUTHENTICATION_ERROR", false],
  [403, "AUTHENTICATION_ERROR", false],
  [404, "MODEL_NOT_FOUND", false],
  [408, "REQUEST_TIMEOUT", true],
  [429, "RATE_LIMITED", true],
  [500, "PROVIDER_UNAVAILABLE", true],
  [502, "PROVIDER_UNAVAILABLE", true],
  [503, "PROVIDER_UNAVAILABLE", true],
  [504, "PROVIDER_UNAVAILABLE", true],
  [529, "PROVIDER_UNAVAILABLE", true],
  [402, "QUOTA_EXCEEDED", false],
];

for (const [status, code, retryable] of statusCases) {
  test(`client normalizes HTTP ${status} as ${code}`, async () => {
    let calls = 0;
    const client = createClient({
      fetchImpl: async () => {
        calls += 1;
        return response(status, { error: { message: "do not expose this" } });
      },
      overrides: { maxRetries: 0 },
    });

    await assert.rejects(
      client.generateChatCompletion({
        systemPrompt: "system",
        userPrompt: "question",
      }),
      (error) => {
        assert.ok(error instanceof NebiusProviderError);
        assert.equal(error.code, code);
        assert.equal(error.status, status);
        assert.equal(error.retryable, retryable);
        assert.doesNotMatch(error.message, /secret|expose|do not/i);
        assert.doesNotMatch(JSON.stringify(error.toJSON()), /secret-api-key/);
        return true;
      },
    );
    assert.equal(calls, 1);
  });
}

test("client retries a transient provider response then succeeds", async () => {
  let calls = 0;
  let delays = 0;
  const client = createNebiusClient({
    env: testEnvironment(),
    fetchImpl: async () =>
      ++calls === 1 ? response(503, {}) : successfulResponse(),
    sleep: async (delay) => {
      delays += delay;
    },
    random: () => 1,
  });

  const result = await client.generateChatCompletion({
    systemPrompt: "system",
    userPrompt: "question",
  });
  assert.equal(result.content, "READY");
  assert.equal(calls, 2);
  assert.equal(delays, 250);
});

test("client retries a rate limit and respects Retry-After", async () => {
  let calls = 0;
  const delays = [];
  const client = createNebiusClient({
    env: testEnvironment(),
    fetchImpl: async () =>
      ++calls === 1
        ? response(429, {}, { "retry-after": "2" })
        : successfulResponse(),
    sleep: async (delay) => delays.push(delay),
    random: () => 0,
  });

  await client.generateChatCompletion({
    systemPrompt: "system",
    userPrompt: "question",
  });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [2000]);
});

test("client respects HTTP-date Retry-After values", async () => {
  let calls = 0;
  const delays = [];
  const client = createNebiusClient({
    env: testEnvironment(),
    fetchImpl: async () =>
      ++calls === 1
        ? response(429, {}, {
            "retry-after": new Date(Date.now() + 120_000).toUTCString(),
          })
        : successfulResponse(),
    sleep: async (delay) => delays.push(delay),
    random: () => 0,
  });

  await client.generateChatCompletion({
    systemPrompt: "system",
    userPrompt: "question",
  });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [10_000]);
});

test("client caps Retry-After and retries only up to the configured bound", async () => {
  let calls = 0;
  const delays = [];
  const client = createNebiusClient({
    env: testEnvironment(),
    fetchImpl: async () => {
      calls += 1;
      return response(503, {}, { "retry-after": "60" });
    },
    sleep: async (delay) => delays.push(delay),
    random: () => 1,
  });

  await assert.rejects(
    client.generateChatCompletion({
      systemPrompt: "system",
      userPrompt: "question",
    }),
    (error) => error.code === "PROVIDER_UNAVAILABLE",
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10_000, 10_000]);
});

test("client does not retry invalid requests or authentication errors", async () => {
  for (const status of [400, 401]) {
    let calls = 0;
    const client = createClient({
      fetchImpl: async () => {
        calls += 1;
        return response(status, {});
      },
    });
    await assert.rejects(
      client.generateChatCompletion({
        systemPrompt: "system",
        userPrompt: "question",
      }),
    );
    assert.equal(calls, 1);
  }
});

test("caller cancellation during retry backoff prevents another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = createNebiusClient({
    env: testEnvironment(),
    fetchImpl: async () => {
      calls += 1;
      return response(503, {});
    },
    sleep: () =>
      new Promise((resolve) => {
        setTimeout(() => controller.abort(), 0);
        setTimeout(resolve, 10);
      }),
  });

  await assert.rejects(
    client.generateChatCompletion({
      systemPrompt: "system",
      userPrompt: "question",
      signal: controller.signal,
    }),
    (error) => error.code === "REQUEST_ABORTED",
  );
  assert.equal(calls, 1);
});

test("client surfaces network and DNS failures without retrying uncertain requests", async () => {
  for (const message of ["network unavailable", "getaddrinfo ENOTFOUND host"]) {
    let calls = 0;
    const client = createClient({
      fetchImpl: async () => {
        calls += 1;
        throw new TypeError(message);
      },
    });
    await assert.rejects(
      client.generateChatCompletion({
        systemPrompt: "system",
        userPrompt: "question",
      }),
      (error) => {
        assert.equal(error.code, "NETWORK_ERROR");
        assert.doesNotMatch(error.message, /ENOTFOUND|secret/i);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("client times out promptly without retrying an uncertain request", async () => {
  let calls = 0;
  const client = createClient({
    fetchImpl: (_url, { signal }) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });
    },
    overrides: { timeoutMs: 100 },
  });

  await assert.rejects(
    client.generateChatCompletion({
      systemPrompt: "system",
      userPrompt: "question",
    }),
    (error) => error.code === "REQUEST_TIMEOUT",
  );
  assert.equal(calls, 1);
});

test("client timeout covers slow response bodies", async () => {
  let calls = 0;
  const client = createClient({
    fetchImpl: async (_url, { signal }) => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("body read aborted")),
              { once: true },
            );
          }),
      };
    },
    overrides: { timeoutMs: 100 },
  });

  await assert.rejects(
    client.generateChatCompletion({
      systemPrompt: "system",
      userPrompt: "question",
    }),
    (error) => error.code === "REQUEST_TIMEOUT",
  );
  assert.equal(calls, 1);
});

test("client supports caller cancellation during an in-flight request", async () => {
  const controller = new AbortController();
  const client = createClient({
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      }),
  });
  const completion = client.generateChatCompletion({
    systemPrompt: "system",
    userPrompt: "question",
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(completion, (error) => error.code === "REQUEST_ABORTED");
});

test("client classifies malformed and structurally unexpected responses", async () => {
  const invalidResponses = [
    response(200, new SyntaxError("raw provider payload")),
    response(200, {}),
    response(200, { choices: [] }),
    response(200, { choices: [{ message: { content: "" } }] }),
  ];

  for (const invalidResponse of invalidResponses) {
    const client = createClient({
      fetchImpl: async () => invalidResponse,
      overrides: { maxRetries: 0 },
    });
    await assert.rejects(
      client.generateChatCompletion({
        systemPrompt: "system",
        userPrompt: "question",
      }),
      (error) => {
        assert.equal(error.code, "INVALID_PROVIDER_RESPONSE");
        assert.doesNotMatch(error.message, /payload|secret/i);
        return true;
      },
    );
  }
});

test("client reports safe request IDs from error headers", async () => {
  const client = createClient({
    fetchImpl: async () =>
      response(401, {}, { "x-request-id": "request-401" }),
    overrides: { maxRetries: 0 },
  });
  await assert.rejects(
    client.generateChatCompletion({
      systemPrompt: "system",
      userPrompt: "question",
    }),
    (error) => error.requestId === "request-401",
  );
});
