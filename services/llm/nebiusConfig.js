const DEFAULT_BASE_URL = "https://api.tokenfactory.nebius.com/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;

class NebiusConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "NebiusConfigurationError";
    this.code = "CONFIGURATION_ERROR";
    this.status = null;
    this.requestId = null;
    this.retryable = false;
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

function readInteger(env, name, fallback, minimum, maximum) {
  const rawValue = env[name];
  if (rawValue === undefined || rawValue === "") return fallback;

  if (!/^\d+$/.test(String(rawValue))) {
    throw new NebiusConfigurationError(`${name} must be a whole number.`);
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new NebiusConfigurationError(
      `${name} must be between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function validateBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new NebiusConfigurationError(
      "NEBIUS_BASE_URL must be a valid HTTPS URL ending in /v1.",
    );
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "api.tokenfactory.nebius.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/v1\/?$/.test(url.pathname)
  ) {
    throw new NebiusConfigurationError(
      "NEBIUS_BASE_URL must be an HTTPS URL ending in /v1.",
    );
  }

  return url.toString().replace(/\/$/, "");
}

function loadNebiusConfig(env = process.env) {
  const apiKey = typeof env.NEBIUS_API_KEY === "string"
    ? env.NEBIUS_API_KEY.trim()
    : "";
  const model = typeof env.NEBIUS_MODEL === "string"
    ? env.NEBIUS_MODEL.trim()
    : "";

  if (!apiKey) {
    throw new NebiusConfigurationError("NEBIUS_API_KEY is required.");
  }
  if (!model) {
    throw new NebiusConfigurationError("NEBIUS_MODEL is required.");
  }

  return Object.freeze({
    apiKey,
    model,
    baseUrl: validateBaseUrl(env.NEBIUS_BASE_URL || DEFAULT_BASE_URL),
    timeoutMs: readInteger(
      env,
      "NEBIUS_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
      100,
      MAX_TIMEOUT_MS,
    ),
    maxRetries: readInteger(
      env,
      "NEBIUS_MAX_RETRIES",
      DEFAULT_MAX_RETRIES,
      0,
      MAX_RETRIES,
    ),
  });
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  MAX_RETRIES,
  MAX_TIMEOUT_MS,
  NebiusConfigurationError,
  loadNebiusConfig,
};
