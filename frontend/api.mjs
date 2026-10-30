const SESSION_KEY = "resqnet.investigator.session";

export class ApiError extends Error {
  constructor(message, { status = 0, code = "UNKNOWN_ERROR" } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function safeErrorCode(code, status) {
  if (typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code)) return code;
  if (status === 401) return "AUTHENTICATION_REQUIRED";
  if (status === 403) return "ACCESS_DENIED";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "SERVER_ERROR";
  return "REQUEST_FAILED";
}

export function readSession(storage) {
  try {
    const target = storage || globalThis.sessionStorage;
    const raw = target.getItem(SESSION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (
      typeof value?.token !== "string" ||
      typeof value?.expiresAt !== "string" ||
      !value.investigator ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) <= Date.now()
    ) {
      target.removeItem(SESSION_KEY);
      return null;
    }
    return value;
  } catch {
    try {
      (storage || globalThis.sessionStorage)?.removeItem(SESSION_KEY);
    } catch {
      return null;
    }
    return null;
  }
}

export function saveSession(session, storage) {
  if (
    typeof session?.token !== "string" ||
    typeof session?.expiresAt !== "string" ||
    !session.investigator ||
    !Number.isFinite(Date.parse(session.expiresAt))
  ) {
    throw new TypeError("The authentication response is incomplete.");
  }
  (storage || globalThis.sessionStorage).setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(storage) {
  try {
    (storage || globalThis.sessionStorage).removeItem(SESSION_KEY);
  } catch {
    return;
  }
}

export function createApiClient({
  baseUrl = globalThis.RESQNET_API_BASE_URL || "",
  getSession = readSession,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
  onUnauthorized = () => {},
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required.");
  }
  const normalizedBase = String(baseUrl).replace(/\/+$/, "");

  async function request(path, {
    method = "GET",
    body,
    authenticated = true,
    headers = {},
  } = {}) {
    const session = authenticated ? getSession() : null;
    const requestHeaders = new Headers(headers);
    if (body !== undefined) requestHeaders.set("Content-Type", "application/json");
    if (session?.token) {
      requestHeaders.set("Authorization", `Bearer ${session.token}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${normalizedBase}${path}`, {
        method,
        headers: requestHeaders,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      throw new ApiError(
        error?.name === "AbortError"
          ? "The request timed out. Please try again."
          : "Could not reach the service. Check your connection and try again.",
        { code: error?.name === "AbortError" ? "REQUEST_TIMEOUT" : "NETWORK_ERROR" },
      );
    }
    clearTimeout(timer);

    if (response.status === 204) return null;
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const code = safeErrorCode(payload?.code, response.status);
      if (response.status === 401 && session?.token) onUnauthorized();
      throw new ApiError(
        typeof payload?.error === "string"
          ? payload.error
          : `The request failed (${response.status}).`,
        { status: response.status, code },
      );
    }
    return payload;
  }

  return Object.freeze({ request });
}

export const apiPaths = Object.freeze({
  login: "/api/auth/login",
  logout: "/api/auth/logout",
  me: "/api/auth/me",
  reporting: "/api/reporting-completeness",
  investigations: "/api/investigations",
});
