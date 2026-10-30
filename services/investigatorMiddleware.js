function extractBearerToken(request) {
  const authorization = request.get("authorization");
  if (typeof authorization !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  return match ? match[1] : null;
}

function createAuthenticationMiddleware(authenticationService) {
  return async function authenticateInvestigator(request, response, next) {
    const token = extractBearerToken(request);
    if (!token) {
      return response.status(401).json({ error: "Authentication required." });
    }

    try {
      const authenticated = await authenticationService.authenticateToken(token);
      if (!authenticated) {
        return response.status(401).json({ error: "Authentication required." });
      }
      request.investigator = authenticated.investigator;
      request.investigatorSessionId = authenticated.sessionId;
      return next();
    } catch {
      console.error("Investigator authentication lookup failed.");
      return response
        .status(503)
        .json({ error: "Authentication is temporarily unavailable." });
    }
  };
}

function requireRoles(...roles) {
  return function authorizeInvestigatorRole(request, response, next) {
    if (!request.investigator || !roles.includes(request.investigator.role)) {
      return response.status(403).json({ error: "Access denied." });
    }
    return next();
  };
}

module.exports = {
  createAuthenticationMiddleware,
  extractBearerToken,
  requireRoles,
};
