import test from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  clearSession,
  createApiClient,
  readSession,
  saveSession,
} from "../frontend/api.mjs";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function jsonResponse(status, value) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return value;
    },
  };
}

test("session storage validates expiry and removes malformed or expired sessions", () => {
  const storage = memoryStorage();
  saveSession({
    token: "sensitive-token",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    investigator: { id: "inv-user", role: "investigator" },
  }, storage);
  assert.equal(readSession(storage).token, "sensitive-token");

  saveSession({
    token: "expired-token",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    investigator: { id: "inv-user" },
  }, storage);
  assert.equal(readSession(storage), null);
  assert.throws(() => saveSession({ token: "missing-expiry" }, storage), TypeError);
  clearSession(storage);
  assert.equal(readSession(storage), null);
});

test("shared API client sends bearer auth and JSON bodies without exposing token in errors", async () => {
  let observed;
  const api = createApiClient({
    baseUrl: "https://api.example.test/",
    getSession: () => ({ token: "private-token" }),
    fetchImpl: async (url, init) => {
      observed = { url, init, body: JSON.parse(init.body) };
      return jsonResponse(201, { saved: true });
    },
  });

  assert.deepEqual(await api.request("/api/investigations", {
    method: "POST",
    body: { safe: true },
  }), { saved: true });
  assert.equal(observed.url, "https://api.example.test/api/investigations");
  assert.equal(observed.init.headers.get("Authorization"), "Bearer private-token");
  assert.equal(observed.init.headers.get("Content-Type"), "application/json");
  assert.deepEqual(observed.body, { safe: true });

  const unauthorized = createApiClient({
    getSession: () => ({ token: "do-not-print" }),
    fetchImpl: async () => jsonResponse(401, { error: "Authentication required." }),
  });
  await assert.rejects(unauthorized.request("/protected"), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.equal(error.code, "AUTHENTICATION_REQUIRED");
    assert.doesNotMatch(error.message, /do-not-print/);
    return true;
  });
});

test("client handles no-content responses and safely normalizes request failures", async () => {
  const noContent = createApiClient({
    fetchImpl: async () => ({ status: 204, ok: true }),
  });
  assert.equal(await noContent.request("/api/auth/logout"), null);

  const network = createApiClient({
    fetchImpl: async () => {
      throw new TypeError("network detail");
    },
  });
  await assert.rejects(network.request("/unavailable"), (error) => {
    assert.equal(error.code, "NETWORK_ERROR");
    assert.doesNotMatch(error.message, /network detail/);
    return true;
  });

  const timeout = createApiClient({
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  });
  await assert.rejects(timeout.request("/slow"), (error) => {
    assert.equal(error.code, "REQUEST_TIMEOUT");
    return true;
  });
});
