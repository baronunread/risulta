import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SESSION_SECONDS = 7 * 24 * 60 * 60;
const failures = new Map();

export const normalizeEmail = (value) => String(value || "").trim().toLowerCase().slice(0, 254);

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 32, { N: 32768, r: 8, p: 3, maxmem: 128 * 1024 * 1024 });
  return `scrypt$32768$8$3$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password, encoded) {
  try {
    const [algorithm, n, r, p, salt, expected] = encoded.split("$");
    if (algorithm !== "scrypt") return false;
    const result = scryptSync(String(password), Buffer.from(salt, "base64url"), 32, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * 1024 * 1024,
    });
    return timingSafeEqual(result, Buffer.from(expected, "base64url"));
  } catch {
    return false;
  }
}

const digest = (token) => createHash("sha256").update(token).digest("hex");

export function createSession(database, userId) {
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  database.createSession(digest(token), userId, csrf, expiresAt);
  return { token, csrf, expiresAt };
}

export function readCookies(header = "") {
  return Object.fromEntries(String(header).split(";").map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part.trim(), ""] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }).filter(([name]) => name));
}

export function readSession(database, req) {
  const cookies = readCookies(req.headers.cookie);
  const token = cookies["__Host-risulta_session"] || cookies.risulta_session;
  if (!token) return null;
  return database.findSession(digest(token));
}

export function sessionCookie(token, secure) {
  const name = secure ? "__Host-risulta_session" : "risulta_session";
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}`;
}

export function expiredCookies() {
  return [
    "risulta_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    "__Host-risulta_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0",
  ];
}

export function destroySession(database, req) {
  const cookies = readCookies(req.headers.cookie);
  const token = cookies["__Host-risulta_session"] || cookies.risulta_session;
  if (token) database.deleteSession(digest(token));
}

export function loginAllowed(key) {
  const now = Date.now();
  const state = failures.get(key);
  if (!state || state.resetAt <= now) return true;
  return state.count < 5;
}

export function recordLoginFailure(key) {
  const now = Date.now();
  const state = failures.get(key);
  failures.set(key, !state || state.resetAt <= now
    ? { count: 1, resetAt: now + 15 * 60 * 1000 }
    : { ...state, count: state.count + 1 });
}

export function clearLoginFailures(key) {
  failures.delete(key);
}

export function csrfValid(session, value) {
  if (!session || value === null) return false;
  const a = Buffer.from(session.csrf);
  const b = Buffer.from(value);
  return a.length === b.length && timingSafeEqual(a, b);
}
