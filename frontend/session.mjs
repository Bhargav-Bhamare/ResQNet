import {
  apiPaths,
  clearSession,
  readSession,
  saveSession,
} from "./api.mjs";

export async function login(api, email, password) {
  const result = await api.request(apiPaths.login, {
    method: "POST",
    authenticated: false,
    body: { email, password },
  });
  const session = {
    token: result?.token,
    expiresAt: result?.expiresAt,
    investigator: result?.investigator,
  };
  saveSession(session);
  return session;
}

export async function restoreSession(api) {
  const session = readSession();
  if (!session) return null;
  try {
    const result = await api.request(apiPaths.me);
    const refreshed = { ...session, investigator: result?.investigator };
    saveSession(refreshed);
    return refreshed;
  } catch (error) {
    if (error.status === 401 || error.status === 403) clearSession();
    throw error;
  }
}

export async function logout(api) {
  try {
    await api.request(apiPaths.logout, { method: "POST" });
  } finally {
    clearSession();
  }
}
