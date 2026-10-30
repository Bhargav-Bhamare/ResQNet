const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AuthenticationError,
  createInvestigatorAuthenticationService,
  hashPassword,
  verifyPassword,
} = require("../services/investigatorAuthentication");

function createModels() {
  const investigators = [];
  const sessions = [];
  const InvestigatorModel = {
    findOne(filter) {
      return {
        select() {
          return {
            lean: async () =>
              investigators.find((item) => item.email === filter.email) || null,
          };
        },
      };
    },
    findById(id) {
      return {
        lean: async () =>
          investigators.find((item) => String(item._id) === String(id)) || null,
      };
    },
    async create(document) {
      const investigator = { _id: `investigator-${investigators.length + 1}`, ...document };
      investigators.push(investigator);
      return investigator;
    },
  };
  const SessionModel = {
    async create(document) {
      const session = { _id: `session-${sessions.length + 1}`, ...document };
      sessions.push(session);
      return session;
    },
    findOne(filter) {
      return {
        lean: async () =>
          sessions.find(
            (session) =>
              session.tokenHash === filter.tokenHash &&
              !session.revokedAt &&
              session.expiresAt > filter.expiresAt.$gt,
          ) || null,
      };
    },
    async updateOne(filter, update) {
      const session = sessions.find(
        (item) =>
          item._id === filter._id &&
          String(item.investigatorId) === String(filter.investigatorId) &&
          !item.revokedAt,
      );
      if (session) session.revokedAt = update.$set.revokedAt;
    },
    async updateMany(filter, update) {
      for (const session of sessions) {
        if (
          String(session.investigatorId) === String(filter.investigatorId) &&
          !session.revokedAt
        ) {
          session.revokedAt = update.$set.revokedAt;
        }
      }
    },
  };
  return { InvestigatorModel, SessionModel, investigators, sessions };
}

test("passwords are stored as salted scrypt hashes and verified", async () => {
  const firstHash = await hashPassword("correct horse battery staple");
  const secondHash = await hashPassword("correct horse battery staple");

  assert.match(firstHash, /^scrypt\$32768\$8\$1\$/);
  assert.notEqual(firstHash, secondHash);
  assert.equal(await verifyPassword("correct horse battery staple", firstHash), true);
  assert.equal(await verifyPassword("wrong password", firstHash), false);
  await assert.rejects(hashPassword("short"), TypeError);
});

test("login issues a random expiring bearer token without exposing password hashes", async () => {
  const models = createModels();
  const passwordHash = await hashPassword("correct horse battery staple");
  await models.InvestigatorModel.create({
    name: "Analyst",
    email: "analyst@example.org",
    passwordHash,
    role: "investigator",
    status: "active",
    sourceCodes: ["CLINIC-1"],
  });
  const now = new Date("2026-10-30T00:00:00.000Z");
  const service = createInvestigatorAuthenticationService({
    ...models,
    now: () => now,
  });

  const result = await service.login({
    email: "ANALYST@example.org",
    password: "correct horse battery staple",
  });

  assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(result.token, models.sessions[0].tokenHash);
  assert.equal(models.sessions[0].tokenHash.length, 64);
  assert.equal(result.expiresAt.toISOString(), "2026-10-30T08:00:00.000Z");
  assert.deepEqual(result.investigator, {
    id: "investigator-1",
    name: "Analyst",
    email: "analyst@example.org",
    role: "investigator",
    status: "active",
    sourceCodes: ["CLINIC-1"],
  });
  assert.equal(JSON.stringify(result).includes(passwordHash), false);
});

test("invalid password and unknown account return the same generic failure", async () => {
  const models = createModels();
  await models.InvestigatorModel.create({
    name: "Analyst",
    email: "analyst@example.org",
    passwordHash: await hashPassword("correct horse battery staple"),
    role: "viewer",
    status: "active",
    sourceCodes: [],
  });
  const service = createInvestigatorAuthenticationService(models);
  const failures = await Promise.all(
    [
      service.login({ email: "analyst@example.org", password: "incorrect" }),
      service.login({ email: "nobody@example.org", password: "incorrect" }),
    ].map((promise) =>
      promise.catch((error) => ({
        code: error.code,
        message: error.message,
      })),
    ),
  );

  assert.deepEqual(failures[0], failures[1]);
  assert.deepEqual(failures[0], {
    code: "INVALID_CREDENTIALS",
    message: "Email or password is incorrect.",
  });
});

test("inactive accounts cannot authenticate", async () => {
  const models = createModels();
  await models.InvestigatorModel.create({
    name: "Former analyst",
    email: "former@example.org",
    passwordHash: await hashPassword("correct horse battery staple"),
    role: "viewer",
    status: "inactive",
    sourceCodes: [],
  });
  const service = createInvestigatorAuthenticationService(models);

  await assert.rejects(
    service.login({
      email: "former@example.org",
      password: "correct horse battery staple",
    }),
    (error) =>
      error instanceof AuthenticationError &&
      error.message === "Email or password is incorrect.",
  );
  assert.equal(models.sessions.length, 0);
});

test("sessions expire, can be authenticated, and are invalidated at logout", async () => {
  const models = createModels();
  await models.InvestigatorModel.create({
    name: "Viewer",
    email: "viewer@example.org",
    passwordHash: await hashPassword("correct horse battery staple"),
    role: "viewer",
    status: "active",
    sourceCodes: ["CLINIC-1"],
  });
  let time = new Date("2026-10-30T00:00:00.000Z");
  const service = createInvestigatorAuthenticationService({
    ...models,
    now: () => time,
  });
  const result = await service.login({
    email: "viewer@example.org",
    password: "correct horse battery staple",
  });

  assert.equal((await service.authenticateToken(result.token)).sessionId, "session-1");
  await service.logout(result.sessionId, result.investigator.id);
  assert.equal(await service.authenticateToken(result.token), null);

  const next = await service.login({
    email: "viewer@example.org",
    password: "correct horse battery staple",
  });
  time = new Date(next.expiresAt.getTime());
  assert.equal(await service.authenticateToken(next.token), null);
});

test("deactivating an investigator revokes all of their sessions", async () => {
  const models = createModels();
  await models.InvestigatorModel.create({
    name: "Viewer",
    email: "viewer@example.org",
    passwordHash: await hashPassword("correct horse battery staple"),
    role: "viewer",
    status: "active",
    sourceCodes: [],
  });
  const service = createInvestigatorAuthenticationService(models);
  const result = await service.login({
    email: "viewer@example.org",
    password: "correct horse battery staple",
  });
  await service.revokeInvestigatorSessions(result.investigator.id);

  assert.equal(models.sessions[0].revokedAt instanceof Date, true);
  assert.equal(await service.authenticateToken(result.token), null);
});
