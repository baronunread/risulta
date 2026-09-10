// Authentication: standalone password KDF, sessions, CSRF, rate limits.
// Passwords use iterated salted SHA-256 ("s2$") because the sprout runtime
// exposes no crypto.subtle/scrypt. Fresh accounts only: scrypt rows from
// the Bun app are never accepted here. String comparison is plain ===
// (no constant-time primitive exists); threat model is localhost or a
// controlled proxy, not a hostile network.
import { sha256Hex } from "./sha256.js";

export const SESSION_SECONDS = 7 * 24 * 60 * 60;
// 20k iterations measured ~0.5s per login in the Porffor build: enough to
// blunt online guessing alongside rate limits, not memory-hard like scrypt.
// The count is encoded in each row, so it can rise later compatibly.
export const KDF_ITERATIONS = 20000;
const failures = new Map();

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

// Standalone KDF: iterated salted SHA-256. Versioned ("s2$") so iteration
// counts can rise later with old rows still verifiable. NOT scrypt: rows
// from the Bun app are never accepted here.
export function hashPassword(password) {
  const salt = randomHex(16);
  return "s2$" + KDF_ITERATIONS + "$" + salt + "$" + kdf(String(password), salt, KDF_ITERATIONS);
}

export function kdf(password, salt, iterations) {
  let h = salt + "" + password;
  for (let i = 0; i < iterations; i++) h = sha256Hex(h);
  return h;
}

export function verifyPassword(password, encoded) {
  try {
    const parts = String(encoded).split("$");
    if (parts[0] !== "s2") return false;
    const iterations = Number(parts[1]);
    if (!(iterations >= 1000) || iterations > 1000000) return false;
    const candidate = kdf(String(password), parts[2], iterations);
    return candidate.length === parts[3].length && candidate === parts[3];
  } catch {
    return false;
  }
}

export function readCookies(header) {
  const out = {};
  const parts = String(header || "").split(";");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const index = part.indexOf("=");
    if (index < 0) {
      const name = part.trim();
      if (name) out[name] = "";
    } else {
      const name = part.slice(0, index).trim();
      if (name) out[name] = part.slice(index + 1).trim();
    }
  }
  return out;
}

export function sessionCookieName(secure) {
  return secure ? "__Host-risulta_session" : "risulta_session";
}

export function setSessionCookie(token, secure) {
  return sessionCookieName(secure) + "=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + SESSION_SECONDS + (secure ? "; Secure" : "");
}

export function expiredSessionCookie(secure) {
  return sessionCookieName(secure) + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + (secure ? "; Secure" : "");
}

export function readSession(db, request) {
  const cookies = readCookies(request.headers.get("cookie"));
  const token = cookies["__Host-risulta_session"] || cookies["risulta_session"] || "";
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    "SELECT sessions.token_hash, sessions.csrf, sessions.expires_at, users.id AS user_id, users.email, users.display_name, users.role " +
      "FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
  ).bind(sha256Hex(token), now).first() || null;
}

export function createSession(db, userId) {
  const token = randomHex(32);
  const csrf = randomHex(32);
  const now = Math.floor(Date.now() / 1000);
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now).run();
  db.prepare("INSERT INTO sessions (token_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(sha256Hex(token), userId, csrf, now, now + SESSION_SECONDS)
    .run();
  return { token, csrf };
}

export function destroySession(db, request) {
  const cookies = readCookies(request.headers.get("cookie"));
  const token = cookies["__Host-risulta_session"] || cookies["risulta_session"] || "";
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(sha256Hex(token)).run();
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

export function createUser(db, email, password, role, siteIds, displayName) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare("INSERT INTO users (email, password_hash, role, display_name, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(email, hashPassword(password), role, displayName || email.split("@")[0], Math.floor(Date.now() / 1000))
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
