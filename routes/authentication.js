const express = require("express");
const {
  AuthenticationError,
  createInvestigatorAuthenticationService,
} = require("../services/investigatorAuthentication");
const {
  createAuthenticationMiddleware,
} = require("../services/investigatorMiddleware");

function createLoginRateLimiter({
  windowMs = 15 * 60 * 1000,
  maximumAttempts = 10,
  now = () => Date.now(),
  maximumKeys = 10_000,
} = {}) {
  if (
    !Number.isSafeInteger(windowMs) ||
    windowMs < 1 ||
    !Number.isSafeInteger(maximumAttempts) ||
    maximumAttempts < 1 ||
    !Number.isSafeInteger(maximumKeys) ||
    maximumKeys < 1
  ) {
    throw new TypeError("Login rate-limit settings must be positive integers.");
  }
  const attempts = new Map();

  return function limitLoginAttempts(request, response, next) {
    const key = request.ip || request.socket.remoteAddress || "unknown";
    const time = now();
    let entry = attempts.get(key);
    if (!entry || entry.resetAt <= time) {
      if (attempts.size >= maximumKeys) {
        for (const [candidate, candidateEntry] of attempts) {
          if (candidateEntry.resetAt <= time) attempts.delete(candidate);
        }
        if (attempts.size >= maximumKeys) {
          const oldestKey = attempts.keys().next().value;
          if (oldestKey !== undefined) attempts.delete(oldestKey);
        }
      }
      entry = { count: 0, resetAt: time + windowMs };
      attempts.set(key, entry);
    }
    if (entry.count >= maximumAttempts) {
      response.set("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - time) / 1000))));
      return response.status(429).json({ error: "Too many login attempts." });
    }
    entry.count += 1;
    return next();
  };
}

function createAuthenticationRouter({
  authenticationService = createInvestigatorAuthenticationService(),
  authenticate = createAuthenticationMiddleware(authenticationService),
  loginRateLimiter = createLoginRateLimiter(),
} = {}) {
  const router = express.Router();

  router.post("/login", loginRateLimiter, async (request, response) => {
    const body = request.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !["email", "password"].includes(key))
    ) {
      return response.status(400).json({ error: "Invalid login request." });
    }

    try {
      const result = await authenticationService.login(body);
      return response.status(200).json({
        token: result.token,
        tokenType: "Bearer",
        expiresAt: result.expiresAt,
        investigator: result.investigator,
      });
    } catch (error) {
      if (error instanceof AuthenticationError) {
        return response
          .status(401)
          .json({ error: "Email or password is incorrect." });
      }
      if (error?.code === 11000) {
        return response.status(401).json({
          error: "Email or password is incorrect.",
        });
      }
      console.error("Investigator login failed.");
      return response.status(503).json({ error: "Login is temporarily unavailable." });
    }
  });

  router.post("/logout", authenticate, async (request, response) => {
    try {
      await authenticationService.logout(
        request.investigatorSessionId,
        request.investigator.id,
      );
      return response.status(204).end();
    } catch {
      console.error("Investigator logout failed.");
      return response.status(503).json({ error: "Logout is temporarily unavailable." });
    }
  });

  router.get("/me", authenticate, (request, response) =>
    response.status(200).json({ investigator: request.investigator }),
  );

  return router;
}

module.exports = {
  createAuthenticationRouter,
  createLoginRateLimiter,
};
