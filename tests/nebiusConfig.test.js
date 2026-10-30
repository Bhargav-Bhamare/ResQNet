const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  NebiusConfigurationError,
  loadNebiusConfig,
} = require("../services/llm/nebiusConfig");

const validEnvironment = {
  NEBIUS_API_KEY: "test-secret",
  NEBIUS_MODEL: "verified/model",
};

test("configuration requires an API key without exposing its value", () => {
  assert.throws(
    () => loadNebiusConfig({ NEBIUS_MODEL: "verified/model" }),
    (error) => {
      assert.ok(error instanceof NebiusConfigurationError);
      assert.equal(error.code, "CONFIGURATION_ERROR");
      assert.equal(error.message, "NEBIUS_API_KEY is required.");
      return true;
    },
  );
});

test("configuration requires a model", () => {
  assert.throws(
    () => loadNebiusConfig({ NEBIUS_API_KEY: "test-secret" }),
    (error) => error.code === "CONFIGURATION_ERROR",
  );
});

test("configuration validates required values and uses conservative defaults", () => {
  const config = loadNebiusConfig(validEnvironment);
  assert.equal(config.apiKey, "test-secret");
  assert.equal(config.model, "verified/model");
  assert.equal(config.baseUrl, DEFAULT_BASE_URL);
  assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(config.maxRetries, DEFAULT_MAX_RETRIES);
  assert.equal(Object.isFrozen(config), true);
});

test("configuration accepts supported explicit settings", () => {
  const config = loadNebiusConfig({
    ...validEnvironment,
    NEBIUS_BASE_URL: "https://api.tokenfactory.nebius.com/v1/",
    NEBIUS_TIMEOUT_MS: "1000",
    NEBIUS_MAX_RETRIES: "0",
  });
  assert.equal(config.baseUrl, "https://api.tokenfactory.nebius.com/v1");
  assert.equal(config.timeoutMs, 1000);
  assert.equal(config.maxRetries, 0);
});

for (const value of ["0", "99", "120001", "invalid"]) {
  test(`configuration rejects invalid timeout ${value}`, () => {
    assert.throws(
      () =>
        loadNebiusConfig({
          ...validEnvironment,
          NEBIUS_TIMEOUT_MS: value,
        }),
      (error) => error.code === "CONFIGURATION_ERROR",
    );
  });
}

for (const value of ["-1", "1.5", "4", "invalid"]) {
  test(`configuration rejects invalid retry count ${value}`, () => {
    assert.throws(
      () =>
        loadNebiusConfig({
          ...validEnvironment,
          NEBIUS_MAX_RETRIES: value,
        }),
      (error) => error.code === "CONFIGURATION_ERROR",
    );
  });
}

for (const value of [
  "not-a-url",
  "http://api.tokenfactory.nebius.com/v1",
  "https://user:pass@example.com/v1",
  "https://example.com/v2",
  "https://example.com/v1?token=secret",
  "https://gateway.example/v1",
]) {
  test(`configuration rejects invalid base URL ${value}`, () => {
    assert.throws(
      () =>
        loadNebiusConfig({
          ...validEnvironment,
          NEBIUS_BASE_URL: value,
        }),
      (error) => {
        assert.equal(error.code, "CONFIGURATION_ERROR");
        assert.doesNotMatch(error.message, /secret/);
        return true;
      },
    );
  });
}
