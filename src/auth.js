// Authentication: password KDF, sessions, CSRF, rate limits.
// New credentials use an iterated HMAC-SHA-256 chain ("h1$", count encoded
// per row) via the runtime's crypto.subtle (0.10.0+). Two legacy formats
// still verify and are re-hashed on next login: "s2$" (the previous
// standalone iterated SHA-256, verified through subtle.digest) and Bun-app
// "scrypt$" rows (verified through the runtime's verify-only
// crypto.scryptVerify, enabling real user migration). String comparison of
// secrets always goes through subtle.verify or a manual constant-time loop,
// never plain ===.
import { utf8Bytes } from "./util.js";
import { parseCookie, stringifySetCookie } from "cookie";

export const SESSION_SECONDS = 7 * 24 * 60 * 60;
// 20k HMAC iterations: trivial wall-clock for an interactive login (C hash,
// one microtask turn per step), enough to blunt offline guessing alongside
// rate limits. The count is encoded in each row, so it can change later
// with old rows still verifiable.
export const KDF_ITERATIONS = 20000;
const failures = new Map();

export function loginRateLimitKeys() {
  return failures.size;
}

export function randomHex(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < n; i++) {
    const h = bytes[i].toString(16);
    s += h.length === 1 ? "0" + h : h;
  }
  return s;
}

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase().slice(0, 254);
}

// Standalone KDF: iterated HMAC-SHA-256 ("h1$"). Versioned with the
// iteration count so the cost can change later with old rows still
// verifiable. Async only: subtle has no sync entry point, and login and
// account creation are rare human-rate operations.
export function bytesToHex(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < view.length; i++) out += (view[i] + 0x100).toString(16).slice(1);
  return out;
}

function base64urlDecode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const text = String(input).replace(/=+$/, "");
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    const digit = alphabet.indexOf(text[i]);
    if (digit < 0) throw new Error("invalid base64url");
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function constantTimeEqualStrings(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function constantTimeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function importHmacKey(keyBytes) {
  // NOTE: await before returning. A bare `return <promise>` from an async
  // function never resolves in this runtime (no promise adoption); every
  // async helper here resolves to a plain value for the same reason.
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  return key;
}

async function hmacChain(key, passwordBytes, iterations) {
  let data = passwordBytes;
  let previous = passwordBytes;
  for (let i = 0; i < iterations; i++) {
    previous = data;
    data = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  }
  return { previous, final: data };
}

export async function hashPassword(password) {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const key = await importHmacKey(saltBytes);
  const encoder = new TextEncoder();
  const { final } = await hmacChain(key, encoder.encode(String(password)), KDF_ITERATIONS);
  return "h1$" + KDF_ITERATIONS + "$" + bytesToHex(saltBytes) + "$" + bytesToHex(final);
}

async function digestHexString(message) {
  const digest = await crypto.subtle.digest("SHA-256", String(message));
  return bytesToHex(new Uint8Array(digest));
}

// Previous standalone format: iterated plain SHA-256 ("s2$"). Verifies
// through subtle.digest with identical string semantics to the old
// vendored implementation (UTF-8 in, hex out).
async function verifyS2(password, iterations, salt, expected) {
  let current = salt + "" + String(password);
  for (let i = 0; i < iterations; i++) current = await digestHexString(current);
  return constantTimeEqualStrings(current, expected);
}

// Bun-app format: scrypt$N$r$p$saltBase64url$hashBase64url (N=32768, r=8,
// p=3 in the Bun app). Verifies through the runtime's verify-only
// scrypt primitive. The password goes in as true UTF-8 bytes so rows made
// by the Bun app verify for non-ASCII passwords too. Synchronous; throws
// on malformed rows.
function verifyBunScrypt(password, parts) {
  const params = { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) };
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) return false;
  if (params.N <= 0 || params.r <= 0 || params.p <= 0 || params.N > 1048576) return false;
  const saltBytes = base64urlDecode(parts[4]);
  const expectedBytes = base64urlDecode(parts[5]);
  if (saltBytes.length === 0 || expectedBytes.length === 0) return false;
  const passwordBytes = new Uint8Array(utf8Bytes(String(password)));
  return crypto.scryptVerify(passwordBytes, saltBytes, expectedBytes, params) === true;
}

// Returns { ok, rehash }: rehash is true for legacy formats that should be
// upgraded to h1$ on the next successful login.
export async function verifyPassword(password, encoded) {
  try {
    const text = String(encoded);
    if (text.startsWith("h1$")) {
      const parts = text.split("$");
      if (parts.length !== 4) return { ok: false, rehash: false };
      const iterations = Number(parts[1]);
      if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 1000000) return { ok: false, rehash: false };
      const saltHex = parts[2];
      if (!/^[0-9a-f]+$/i.test(saltHex) || saltHex.length % 2 !== 0 || saltHex.length === 0) return { ok: false, rehash: false };
      const saltBytes = new Uint8Array(saltHex.length / 2);
      for (let i = 0; i < saltBytes.length; i++) saltBytes[i] = parseInt(saltHex.slice(i * 2, i * 2 + 2), 16);
      const key = await importHmacKey(saltBytes);
      const encoder = new TextEncoder();
      const { final } = await hmacChain(key, encoder.encode(String(password)), iterations);
      if (!/^[0-9a-f]+$/i.test(parts[3]) || parts[3].length % 2 !== 0 || parts[3].length === 0) return { ok: false, rehash: false };
      const stored = new Uint8Array(parts[3].length / 2);
      for (let i = 0; i < stored.length; i++) stored[i] = parseInt(parts[3].slice(i * 2, i * 2 + 2), 16);
      return { ok: constantTimeEqualBytes(final, stored), rehash: false };
    }
    if (text.startsWith("s2$")) {
      const parts = text.split("$");
      if (parts.length !== 4) return { ok: false, rehash: false };
      const iterations = Number(parts[1]);
      if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 1000000) return { ok: false, rehash: false };
      const ok = await verifyS2(password, iterations, parts[2], parts[3]);
      return { ok, rehash: true };
    }
    if (text.startsWith("scrypt$")) {
      const parts = text.split("$");
      if (parts.length !== 6) return { ok: false, rehash: false };
      const ok = verifyBunScrypt(password, parts);
      return { ok, rehash: true };
    }
    return { ok: false, rehash: false };
  } catch {
    return { ok: false, rehash: false };
  }
}

async function tokenHash(token) {
  const digest = await crypto.subtle.digest("SHA-256", String(token));
  return bytesToHex(new Uint8Array(digest));
}

export function readCookies(header) {
  return parseCookie(String(header || ""));
}

export function sessionCookieName(secure) {
  return secure ? "__Host-risulta_session" : "risulta_session";
}

export function setSessionCookie(token, secure) {
  return stringifySetCookie({
    name: sessionCookieName(secure),
    value: token,
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_SECONDS,
    secure,
  });
}

export function expiredSessionCookie(secure) {
  return stringifySetCookie({
    name: sessionCookieName(secure),
    value: "",
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 0,
    secure,
  });
}

export async function readSession(db, request) {
  const cookies = readCookies(request.headers.get("cookie"));
  const token = cookies["__Host-risulta_session"] || cookies["risulta_session"] || "";
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    "SELECT sessions.token_hash, sessions.csrf, sessions.expires_at, users.id AS user_id, users.email, users.display_name, users.role " +
      "FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
  ).bind(await tokenHash(token), now).first() || null;
}

export async function createSession(db, userId) {
  const token = randomHex(32);
  const csrf = randomHex(32);
  const now = Math.floor(Date.now() / 1000);
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now).run();
  db.prepare("INSERT INTO sessions (token_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await tokenHash(token), userId, csrf, now, now + SESSION_SECONDS)
    .run();
  return { token, csrf };
}

export async function destroySession(db, request) {
  const cookies = readCookies(request.headers.get("cookie"));
  const token = cookies["__Host-risulta_session"] || cookies["risulta_session"] || "";
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await tokenHash(token)).run();
}

export function csrfValue(request, body) {
  const header = request.headers.get("x-csrf-token") || "";
  if (header) return header;
  try {
    return new URLSearchParams(body || "").get("csrf") || "";
  } catch {
    return "";
  }
}

export function csrfValid(session, value) {
  return !!session && String(value || "").length > 0 && String(value) === session.csrf;
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
  if (!state || state.resetAt <= now) failures.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
  else failures.set(key, { count: state.count + 1, resetAt: state.resetAt });
}

export function clearLoginFailures(key) {
  failures.delete(key);
}

export async function createUser(db, email, password, role, siteIds, displayName) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare("INSERT INTO users (email, password_hash, role, display_name, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(email, await hashPassword(password), role, displayName || email.split("@")[0], Math.floor(Date.now() / 1000))
      .run();
    const userId = Number(result.meta.last_row_id);
    if (role === "viewer") {
      const assign = db.prepare("INSERT OR IGNORE INTO site_users (user_id, site_id, role) VALUES (?, ?, 'viewer')");
      for (let i = 0; i < siteIds.length; i++) assign.bind(userId, siteIds[i]).run();
    }
    db.exec("COMMIT");
    return userId;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw error;
  }
}

export function changePassword(db, session, passwordHash) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(passwordHash, session.user_id).run();
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(session.user_id, session.token_hash).run();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw error;
  }
}
