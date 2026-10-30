const {
  createHash,
  randomBytes,
  timingSafeEqual,
} = require("node:crypto");
const { promisify } = require("node:util");
const Investigator = require("../models/Investigator");
const InvestigatorSession = require("../models/InvestigatorSession");

const scrypt = promisify(require("node:crypto").scrypt);
const PASSWORD_HASH_PARAMETERS = {
  N: 32768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
};
const DEFAULT_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;

class AuthenticationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AuthenticationError";
    this.code = code;
  }
}

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function isValidEmail(email) {
  return (
    typeof email === "string" &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 256) {
    throw new TypeError("Password must contain between 12 and 256 characters.");
  }
  const salt = randomBytes(16);
  const derivedKey = await scrypt(
    password,
    salt,
    64,
    PASSWORD_HASH_PARAMETERS,
  );
  return `scrypt$${PASSWORD_HASH_PARAMETERS.N}$${PASSWORD_HASH_PARAMETERS.r}$${PASSWORD_HASH_PARAMETERS.p}$${salt.toString("base64url")}$${derivedKey.toString("base64url")}`;
}

async function verifyPassword(password, encodedHash) {
  if (typeof password !== "string" || typeof encodedHash !== "string") {
    return false;
  }
  const parts = encodedHash.split("$");
  if (
    parts.length !== 6 ||
    parts[0] !== "scrypt" ||
    Number(parts[1]) !== PASSWORD_HASH_PARAMETERS.N ||
    Number(parts[2]) !== PASSWORD_HASH_PARAMETERS.r ||
    Number(parts[3]) !== PASSWORD_HASH_PARAMETERS.p
  ) {
    return false;
  }

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], "base64url");
    expected = Buffer.from(parts[5], "base64url");
  } catch {
    return false;
  }
  if (salt.length !== 16 || expected.length !== 64) return false;

  const actual = await scrypt(
    password,
    salt,
    expected.length,
    PASSWORD_HASH_PARAMETERS,
  );
  return timingSafeEqual(actual, expected);
}

async function consumeUnknownAccountPassword(password) {
  const salt = Buffer.alloc(16, 0x6e);
  const expected = Buffer.alloc(64);
  const actual = await scrypt(
    password,
    salt,
    expected.length,
    PASSWORD_HASH_PARAMETERS,
  );
  timingSafeEqual(actual, expected);
}

function hashSessionToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function toPublicInvestigator(investigator) {
  return {
    id: String(investigator._id || investigator.id),
    name: investigator.name,
    email: investigator.email,
    role: investigator.role,
    status: investigator.status,
    sourceCodes: [...(investigator.sourceCodes || [])],
  };
}

async function resolveQuery(query) {
  return query && typeof query.lean === "function" ? query.lean() : query;
}

function createInvestigatorAuthenticationService({
  InvestigatorModel = Investigator,
  SessionModel = InvestigatorSession,
  now = () => new Date(),
  sessionLifetimeMs = DEFAULT_SESSION_LIFETIME_MS,
} = {}) {
  if (!Number.isSafeInteger(sessionLifetimeMs) || sessionLifetimeMs < 60_000) {
    throw new TypeError("sessionLifetimeMs must be at least one minute.");
  }

  async function login({ email, password } = {}) {
    const normalizedEmail = normalizeEmail(email);
    const validCredentials =
      isValidEmail(normalizedEmail) &&
      typeof password === "string" &&
      password.length > 0 &&
      password.length <= 256;
    if (!validCredentials) {
      throw new AuthenticationError(
        "INVALID_CREDENTIALS",
        "Email or password is incorrect.",
      );
    }

    const investigator = await resolveQuery(
      InvestigatorModel.findOne({ email: normalizedEmail }).select(
        "+passwordHash",
      ),
    );
    const passwordMatches = investigator
      ? await verifyPassword(password, investigator.passwordHash)
      : (await consumeUnknownAccountPassword(password), false);
    if (
      !investigator ||
      investigator.status !== "active" ||
      !passwordMatches
    ) {
      throw new AuthenticationError(
        "INVALID_CREDENTIALS",
        "Email or password is incorrect.",
      );
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now().getTime() + sessionLifetimeMs);
    const session = await SessionModel.create({
      investigatorId: investigator._id,
      tokenHash: hashSessionToken(token),
      expiresAt,
    });

    return {
      token,
      expiresAt,
      investigator: toPublicInvestigator(investigator),
      sessionId: String(session._id),
    };
  }

  async function authenticateToken(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      return null;
    }
    const session = await resolveQuery(
      SessionModel.findOne({
        tokenHash: hashSessionToken(token),
        revokedAt: null,
        expiresAt: { $gt: now() },
      }),
    );
    if (!session) return null;

    const investigator = await resolveQuery(
      InvestigatorModel.findById(session.investigatorId),
    );
    if (!investigator || investigator.status !== "active") return null;
    return {
      investigator: toPublicInvestigator(investigator),
      sessionId: String(session._id),
    };
  }

  async function logout(sessionId, investigatorId) {
    await SessionModel.updateOne(
      { _id: sessionId, investigatorId, revokedAt: null },
      { $set: { revokedAt: now() } },
    );
  }

  async function revokeInvestigatorSessions(investigatorId) {
    await SessionModel.updateMany(
      { investigatorId, revokedAt: null },
      { $set: { revokedAt: now() } },
    );
  }

  return {
    login,
    authenticateToken,
    logout,
    revokeInvestigatorSessions,
    hashPassword,
  };
}

module.exports = {
  AuthenticationError,
  DEFAULT_SESSION_LIFETIME_MS,
  createInvestigatorAuthenticationService,
  hashPassword,
  isValidEmail,
  normalizeEmail,
  toPublicInvestigator,
  verifyPassword,
};
