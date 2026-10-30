const { performance } = require("node:perf_hooks");
const { loadNebiusConfig } = require("./nebiusConfig");

const MAX_PROMPT_CHARACTERS = 20_000;
const DEFAULT_MAX_TOKENS = 512;
const MAX_GENERATION_TOKENS = 2_048;
const MAX_RETRY_DELAY_MS = 10_000;
const BASE_RETRY_DELAY_MS = 250;

const SAFE_MESSAGES = Object.freeze({
  AUTHENTICATION_ERROR: "Nebius rejected the configured credentials.",
  INVALID_REQUEST: "Nebius rejected the inference request.",
  MODEL_NOT_FOUND: "The configured Nebius model is unavailable.",
  QUOTA_EXCEEDED: "The Nebius account has insufficient quota or credits.",
  RATE_LIMITED: "Nebius rate-limited the inference request.",
  PROVIDER_UNAVAILABLE: "Nebius inference is temporarily unavailable.",
  NETWORK_ERROR: "The Nebius request could not be completed.",
  REQUEST_TIMEOUT: "The Nebius request timed out.",
  REQUEST_ABORTED: "The Nebius request was cancelled.",
  INVALID_PROVIDER_RESPONSE: "Nebius returned an invalid inference response.",
  UNKNOWN_PROVIDER_ERROR: "Nebius inference failed unexpectedly.",
});

class NebiusProviderError extends Error {
  constructor(code, { status = null, requestId = null, retryable = false } = {}) {
    super(SAFE_MESSAGES[code] || SAFE_MESSAGES.UNKNOWN_PROVIDER_ERROR);
    this.name = "NebiusProviderError";
    this.code = SAFE_MESSAGES[code] ? code : "UNKNOWN_PROVIDER_ERROR";
    this.status = Number.isInteger(status) ? status : null;
    this.requestId = typeof requestId === "string" ? requestId : null;
    this.retryable = Boolean(retryable);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      status: this.status,
      requestId: this.requestId,
      retryable: this.retryable,
    };
  }
}

function getHeader(response, name) {
  return typeof response.headers?.get === "function"
    ? response.headers.get(name)
    : null;
}

function getRequestId(response) {
  return safeRequestId(getHeader(response, "x-request-id"));
}

function safeRequestId(requestId) {
  return typeof requestId === "string" &&
    requestId.length <= 200 &&
    /^[A-Za-z0-9._:-]+$/.test(requestId)
    ? requestId
    : null;
}

function providerErrorForStatus(status, requestId) {
  if (status === 401 || status === 403) {
    return new NebiusProviderError("AUTHENTICATION_ERROR", {
      status,
      requestId,
    });
  }
  if (status === 400 || status === 422) {
    return new NebiusProviderError("INVALID_REQUEST", { status, requestId });
  }
  if (status === 404) {
    return new NebiusProviderError("MODEL_NOT_FOUND", { status, requestId });
  }
  if (status === 402) {
    return new NebiusProviderError("QUOTA_EXCEEDED", { status, requestId });
  }
  if (status === 429) {
    return new NebiusProviderError("RATE_LIMITED", {
      status,
      requestId,
      retryable: true,
    });
  }
  if (status === 408) {
    return new NebiusProviderError("REQUEST_TIMEOUT", {
      status,
      requestId,
      retryable: true,
    });
  }
  if (status === 529 || (status >= 500 && status <= 599)) {
    return new NebiusProviderError("PROVIDER_UNAVAILABLE", {
      status,
      requestId,
      retryable: true,
    });
  }
  return new NebiusProviderError("UNKNOWN_PROVIDER_ERROR", {
    status,
    requestId,
  });
}

function parseRetryAfter(response) {
  const value = getHeader(response, "retry-after");
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  }

  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.min(
    Math.max(0, date - Date.now()),
    MAX_RETRY_DELAY_MS,
  );
}

function getRetryDelayMs(attempt, retryAfterMs, random) {
  if (retryAfterMs !== null) return retryAfterMs;
  const ceiling = Math.min(
    BASE_RETRY_DELAY_MS * (2 ** attempt),
    MAX_RETRY_DELAY_MS,
  );
  return Math.floor(Math.max(0, Math.min(1, random())) * ceiling);
}

function waitForRetry(delayMs, signal, sleep) {
  if (signal?.aborted) {
    return Promise.reject(new NebiusProviderError("REQUEST_ABORTED"));
  }

  if (delayMs === 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new NebiusProviderError("REQUEST_ABORTED"));

    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => sleep(delayMs, signal))
      .then(() => finish(), (error) => finish(error));
  });
}

function defaultSleep(delayMs, signal) {
  return new Promise((resolve) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => finish();

    timer = setTimeout(finish, delayMs);
    if (signal?.aborted) {
      finish();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function fetchWithTimeout(fetchImpl, url, init, timeoutMs, callerSignal, readResponse) {
  if (callerSignal?.aborted) {
    return Promise.reject(new NebiusProviderError("REQUEST_ABORTED"));
  }

  const controller = new AbortController();
  let timeoutTriggered = false;
  let abortRequest;
  const aborted = new Promise((resolve, reject) => {
    abortRequest = () => {
      reject(
        new NebiusProviderError(
          timeoutTriggered ? "REQUEST_TIMEOUT" : "REQUEST_ABORTED",
          { retryable: false },
        ),
      );
    };
  });

  const onCallerAbort = () => controller.abort();
  const onControllerAbort = () => abortRequest();
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  controller.signal.addEventListener("abort", onControllerAbort, {
    once: true,
  });
  const timeout = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort();
  }, timeoutMs);

  const request = Promise.resolve()
    .then(() => fetchImpl(url, { ...init, signal: controller.signal }))
    .then(readResponse);

  return Promise.race([request, aborted])
    .catch((error) => {
      if (error instanceof NebiusProviderError) throw error;
      throw new NebiusProviderError("NETWORK_ERROR");
    })
    .finally(() => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      controller.signal.removeEventListener("abort", onControllerAbort);
    });
}

function numericValue(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeSuccess(data, latencyMs, response) {
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  const content = choice?.message?.content;
  if (
    !choice ||
    typeof content !== "string" ||
    content.trim().length === 0
  ) {
    throw new NebiusProviderError("INVALID_PROVIDER_RESPONSE", {
      requestId: safeRequestId(data?.id) || getRequestId(response),
    });
  }

  const usage = data.usage;
  return {
    provider: "nebius",
    model: typeof data.model === "string" && data.model.length > 0
      ? data.model
      : null,
    content,
    finishReason: typeof choice.finish_reason === "string"
      ? choice.finish_reason
      : null,
    usage: {
      promptTokens: numericValue(usage?.prompt_tokens),
      completionTokens: numericValue(usage?.completion_tokens),
      totalTokens: numericValue(usage?.total_tokens),
    },
    requestId: safeRequestId(data.id) || getRequestId(response),
    latencyMs,
  };
}

function validateCompletionInput({
  systemPrompt,
  userPrompt,
  model,
  temperature,
  maxTokens,
  responseFormat,
}) {
  if (
    typeof systemPrompt !== "string" ||
    typeof userPrompt !== "string" ||
    systemPrompt.trim().length === 0 ||
    userPrompt.trim().length === 0
  ) {
    throw new NebiusProviderError("INVALID_REQUEST");
  }
  if (systemPrompt.length + userPrompt.length > MAX_PROMPT_CHARACTERS) {
    throw new NebiusProviderError("INVALID_REQUEST");
  }
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new NebiusProviderError("INVALID_REQUEST");
  }
  if (
    temperature !== undefined &&
    (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)
  ) {
    throw new NebiusProviderError("INVALID_REQUEST");
  }
  if (
    !Number.isInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > MAX_GENERATION_TOKENS
  ) {
    throw new NebiusProviderError("INVALID_REQUEST");
  }
  if (
    responseFormat !== undefined &&
    (!responseFormat ||
      responseFormat.type !== "json_object" ||
      Object.keys(responseFormat).some((key) => key !== "type"))
  ) {
    throw new NebiusProviderError("INVALID_REQUEST");
  }
}

function createNebiusClient({
  env = process.env,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  random = Math.random,
} = {}) {
  const settings = loadNebiusConfig(env);
  if (typeof fetchImpl !== "function") {
    throw new NebiusProviderError("NETWORK_ERROR");
  }

  async function generateChatCompletion({
    systemPrompt,
    userPrompt,
    model = settings.model,
    temperature = 0,
    maxTokens = DEFAULT_MAX_TOKENS,
    responseFormat,
    signal,
  }) {
    validateCompletionInput({
      systemPrompt,
      userPrompt,
      model,
      temperature,
      maxTokens,
      responseFormat,
    });

    const body = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature,
      max_tokens: maxTokens,
      stream: false,
    };
    if (responseFormat) body.response_format = responseFormat;

    let retries = 0;
    const callStartedAt = performance.now();
    while (true) {
      try {
        const response = await fetchWithTimeout(
          fetchImpl,
          `${settings.baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${settings.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          },
          settings.timeoutMs,
          signal,
          async (httpResponse) => {
            if (!httpResponse.ok) {
              return { response: httpResponse, data: null };
            }
            try {
              return {
                response: httpResponse,
                data: await httpResponse.json(),
              };
            } catch {
              throw new NebiusProviderError("INVALID_PROVIDER_RESPONSE", {
                requestId: getRequestId(httpResponse),
              });
            }
          },
        );
        const { response: httpResponse, data } = response;
        const requestId = getRequestId(httpResponse);
        if (!httpResponse.ok) {
          const error = providerErrorForStatus(httpResponse.status, requestId);
          if (!error.retryable || retries >= settings.maxRetries) throw error;
          const delay = getRetryDelayMs(
            retries,
            parseRetryAfter(httpResponse),
            random,
          );
          await waitForRetry(delay, signal, sleep);
          retries += 1;
          continue;
        }

        return normalizeSuccess(
          data,
          Math.max(0, Math.round(performance.now() - callStartedAt)),
          httpResponse,
        );
      } catch (error) {
        if (!(error instanceof NebiusProviderError)) {
          throw new NebiusProviderError("UNKNOWN_PROVIDER_ERROR");
        }
        if (!error.retryable || retries >= settings.maxRetries) throw error;

        const delay = getRetryDelayMs(retries, null, random);
        await waitForRetry(delay, signal, sleep);
        retries += 1;
      }
    }
  }

  return Object.freeze({ generateChatCompletion });
}

module.exports = {
  DEFAULT_MAX_TOKENS,
  MAX_GENERATION_TOKENS,
  MAX_PROMPT_CHARACTERS,
  NebiusProviderError,
  createNebiusClient,
};
