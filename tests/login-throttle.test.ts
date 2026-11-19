import "./env-setup";
import assert from "node:assert/strict";
import test from "node:test";
import { DUMMY_PASSWORD_HASH, evaluateCredentialLogin, type CredentialLoginDeps, type CredentialLoginUser } from "../src/lib/auth/credential-login";
import { LOGIN_ATTEMPTS_PER_ACCOUNT, LOGIN_ATTEMPTS_PER_ACCOUNT_AND_IP, LOGIN_ATTEMPTS_PER_IP, clientIp, loginThrottle } from "../src/lib/auth/login-throttle";
import { store } from "../src/lib/rate-limit";

const user: CredentialLoginUser = { id: "u1", name: "U", email: "u@example.test", password: "real-hash", role: "USER", isEmailVerified: true, imageUrl: null, sessionVersion: 0 };
const GENERIC = { ok: false, outcome: "invalid_credentials", message: "Invalid email or password" };

function deps(over: Partial<CredentialLoginDeps> & { compared?: string[] } = {}): CredentialLoginDeps {
  return {
    findUserByEmail: async (email) => (email === user.email ? user : null),
    hasPendingApproval: async () => false,
    comparePassword: async (password, hash) => (over.compared?.push(hash), password === "right" && hash === "real-hash"),
    ...over,
  };
}
// Off Vercel the address is the last x-forwarded-for hop.
const attemptFrom = (ip: string, compared?: string[]) => (email: string, password: string) =>
  evaluateCredentialLogin({ email, password }, deps({ compared, ...loginThrottle({ "x-forwarded-for": ip }) }));

test("an account is throttled from one address after its attempts; the answer is the wrong-password answer with the same bcrypt work", async () => {
  store.clear();
  const compared: string[] = [];
  const attempt = attemptFrom("203.0.113.7", compared);
  for (let i = 0; i < LOGIN_ATTEMPTS_PER_ACCOUNT_AND_IP; i += 1) assert.equal((await attempt("u@example.test", "wrong")).ok, false);
  compared.length = 0;
  const blocked = await attempt("u@example.test", "right");
  assert.deepEqual(blocked, GENERIC);
  assert.deepEqual(compared, [DUMMY_PASSWORD_HASH], "a throttled attempt does one bcrypt comparison against the dummy hash");

  // An unknown email is indistinguishable once throttled.
  for (let i = 0; i < LOGIN_ATTEMPTS_PER_ACCOUNT_AND_IP; i += 1) await attempt("nobody@example.test", "x");
  assert.deepEqual(await attempt("nobody@example.test", "x"), blocked);
});

test("parallel guesses cannot slip past the limit (the attempt is counted before the password check)", async () => {
  store.clear();
  const compared: string[] = [];
  const attempt = attemptFrom("198.51.100.4", compared);
  await Promise.all(Array.from({ length: 40 }, () => attempt("u@example.test", "wrong")));
  assert.ok(compared.filter((hash) => hash === "real-hash").length <= LOGIN_ATTEMPTS_PER_ACCOUNT_AND_IP, `${compared.length} password checks`);
});

test("guessing from one address cannot lock the real owner out from another address, and success clears the counter", async () => {
  store.clear();
  const attacker = attemptFrom("192.0.2.66");
  for (let i = 0; i < LOGIN_ATTEMPTS_PER_ACCOUNT_AND_IP + 5; i += 1) await attacker("u@example.test", "wrong");
  assert.deepEqual(await attacker("u@example.test", "right"), GENERIC, "the attacker's address is throttled");
  const owner = attemptFrom("198.51.100.200");
  assert.equal((await owner("u@example.test", "right")).ok, true, "the owner is not locked out");

  // A few slips then the right password: the counter is cleared, so later attempts start fresh.
  const person = attemptFrom("203.0.113.90");
  for (let i = 0; i < 6; i += 1) await person("u@example.test", "wrong");
  assert.equal((await person("u@example.test", "right")).ok, true);
  for (let i = 0; i < 6; i += 1) await person("u@example.test", "wrong");
  assert.equal((await person("u@example.test", "right")).ok, true, "six more slips after a success are still allowed");
});

test("many accounts guessed from one address hit the per-address limit", async () => {
  store.clear();
  const attempt = attemptFrom("192.0.2.50");
  for (let i = 0; i < LOGIN_ATTEMPTS_PER_IP; i += 1) await attempt(`guess${i}@example.test`, "x");
  assert.deepEqual(await attempt("u@example.test", "right"), GENERIC);
});

test("the client address: platform headers only on Vercel, otherwise the last forwarded hop", () => {
  const saved = process.env.VERCEL;
  try {
    delete process.env.VERCEL;
    assert.equal(clientIp({ "x-vercel-forwarded-for": "6.6.6.6", "x-real-ip": "7.7.7.7", "x-forwarded-for": "6.6.6.6, 203.0.113.9" }), "203.0.113.9", "client-rotatable headers are ignored off Vercel");
    assert.equal(clientIp({}), "unknown");
    process.env.VERCEL = "1";
    assert.equal(clientIp({ "x-vercel-forwarded-for": "203.0.113.1", "x-forwarded-for": "6.6.6.6, 203.0.113.1" }), "203.0.113.1");
    assert.equal(clientIp({ "x-real-ip": "198.51.100.2", "x-forwarded-for": "6.6.6.6" }), "198.51.100.2");
    assert.equal(clientIp({ "x-forwarded-for": "6.6.6.6, 7.7.7.7, 203.0.113.9" }), "203.0.113.9");
  } finally {
    if (saved === undefined) delete process.env.VERCEL; else process.env.VERCEL = saved;
  }
});

test("hammering from one address cannot run up the account counter and lock the owner out", async () => {
  store.clear();
  const attacker = attemptFrom("192.0.2.77");
  for (let i = 0; i < LOGIN_ATTEMPTS_PER_ACCOUNT * 3; i += 1) await attacker("u@example.test", "wrong");
  const owner = attemptFrom("198.51.100.201");
  assert.equal((await owner("u@example.test", "right")).ok, true, "the owner can still sign in after 300 attacker attempts");
});

test("the pure login policy is unchanged without throttle dependencies", async () => {
  assert.equal((await evaluateCredentialLogin({ email: "u@example.test", password: "right" }, deps())).ok, true);
});
