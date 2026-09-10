// Risulta Sprout (single standalone binary, no platform).
//
// One app sprout, one D1 database, static assets embedded in the binary, no
// service bindings (standalone builds reject them: there is no edge). The
// existing Bun Risulta app is untouched; this is a smaller sibling that
// reuses its domain rules and visual language where the sprout runtime
// allows. Page markup follows lib/views.js class names so the same
// stylesheet renders both; the chart builder is ported to runtime-safe
// constructs (no Intl, no Array.from, no padStart, no optional chaining).
//
// Authentication is real but standalone-scoped:
// - Passwords use an iterated salted SHA-256 KDF ("s2$") implemented over a
//   vendored pure-JS SHA-256 (src/sha256.js), because the sprout runtime
//   exposes no crypto.subtle/scrypt. Fresh accounts only: existing scrypt
//   hashes from the Bun app can never be verified here.
// - Sessions are random tokens stored as SHA-256 digests with CSRF tokens
//   and expiry, in HttpOnly SameSite cookies. String comparison is plain
//   === (no constant-time primitive exists); threat model is localhost or
//   a controlled proxy, not a hostile network.
// - Visitors are daily salted SHA-256 hashes of IP + User-Agent, like the
//   Bun app, except the client IP only exists when RISULTA_TRUST_PROXY=1
//   and your own proxy overwrites X-Forwarded-For (Caddy does this with
//   `header_up X-Forwarded-For {http.request.remote.host}`). Otherwise the
//   hash covers the User-Agent alone and uniqueness degrades.
// - No cron, queues or background workers exist standalone. Reports
//   generate synchronously on request; there are no scheduled summaries.
// - Redirects use 302: the runtime cannot serialize a 303 status (every
//   303 shape resets the connection; probed). Form logins use a 200 page
//   with a meta refresh because 302 + Set-Cookie fails the same way.

import { sha256Hex } from "./sha256.js";

const SESSION_SECONDS = 7 * 24 * 60 * 60;
// 20k iterations measured ~0.5s per login in the Porffor build: enough to
// blunt online guessing alongside rate limits, not memory-hard like scrypt.
// The count is encoded in each row, so it can rise later compatibly.
const KDF_ITERATIONS = 20000;
const failures = new Map();
// Daily salts cached per process like the Bun app's SiteStore: the day
// changes rarely, so the hot path skips three salt queries per event.
const saltCache = new Map();
// Public keys are immutable and sites are only added through this handler,
// so a miss-fill cache is exactly coherent and the collector skips its
// lookup after the first event per key.
const siteByKey = new Map();

function siteForKey(db, publicKey) {
  let site = siteByKey.get(publicKey);
  if (site === undefined) {
    site = db.prepare("SELECT id, domain FROM sites WHERE public_key = ?").bind(publicKey).first() || null;
    siteByKey.set(publicKey, site);
  }
  return site;
}
// Schema and bootstrap run once per process (like the Bun app migrating at
// startup), not per request. The trust flag is process env, also read once.
let schemaReady = false;
let trustProxyCached = null;

function trustProxyEnabled() {
  if (trustProxyCached === null) trustProxyCached = optionalSecret("RISULTA_TRUST_PROXY") === "1";
  return trustProxyCached;
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json" },
  });
}

function parseJson(body) {
  try {
    return { ok: true, value: JSON.parse(body || "{}") };
  } catch {
    return { ok: false, value: {} };
  }
}

function redirect(to) {
  return new Response("", { status: 302, headers: { location: to } });
}

// Form flows that set a cookie cannot use redirect(): 302 + Set-Cookie
// resets the connection in this runtime, so answer 200 with a same-click
// meta refresh instead. Browsers follow it; the link covers no-refresh.
function refreshPage(to, cookie) {
  const headers = { "content-type": "text/html;charset=utf-8" };
  if (cookie) headers["set-cookie"] = cookie;
  return new Response(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=' + escapeHtml(to) + '">' +
      "<title>Continue</title></head><body><main><p><a href=\"" + escapeHtml(to) + "\">Continue</a></p></main></body></html>",
    { status: 200, headers },
  );
}

function optionalSecret(name) {
  try {
    return env[name] || "";
  } catch {
    return "";
  }
}

function randomHex(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < n; i++) {
    const h = bytes[i].toString(16);
    s += h.length === 1 ? "0" + h : h;
  }
  return s;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase().slice(0, 254);
}

// Standalone KDF: iterated salted SHA-256. Versioned ("s2$") so iteration
// counts can rise later with old rows still verifiable. NOT scrypt: rows
// from the Bun app are never accepted here.
function hashPassword(password) {
  const salt = randomHex(16);
  return "s2$" + KDF_ITERATIONS + "$" + salt + "$" + kdf(String(password), salt, KDF_ITERATIONS);
}

function kdf(password, salt, iterations) {
  let h = salt + "" + password;
  for (let i = 0; i < iterations; i++) h = sha256Hex(h);
  return h;
}

function verifyPassword(password, encoded) {
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

function readCookies(header) {
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

function sessionCookieName(secure) {
  return secure ? "__Host-risulta_session" : "risulta_session";
}

function setSessionCookie(token, secure) {
  return sessionCookieName(secure) + "=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + SESSION_SECONDS + (secure ? "; Secure" : "");
}

function expiredSessionCookie(secure) {
  return sessionCookieName(secure) + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + (secure ? "; Secure" : "");
}

function readSession(db, request) {
  const cookies = readCookies(request.headers.get("cookie"));
  const token = cookies["__Host-risulta_session"] || cookies["risulta_session"] || "";
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    "SELECT sessions.token_hash, sessions.csrf, sessions.expires_at, users.id AS user_id, users.email, users.display_name, users.role " +
      "FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
  ).bind(sha256Hex(token), now).first() || null;
}

function createSession(db, userId) {
  const token = randomHex(32);
  const csrf = randomHex(32);
  const now = Math.floor(Date.now() / 1000);
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now).run();
  db.prepare("INSERT INTO sessions (token_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(sha256Hex(token), userId, csrf, now, now + SESSION_SECONDS)
    .run();
  return { token, csrf };
}

function csrfValue(request, body) {
  const header = request.headers.get("x-csrf-token") || "";
  if (header) return header;
  try {
    return new URLSearchParams(body || "").get("csrf") || "";
  } catch {
    return "";
  }
}

function csrfValid(session, value) {
  return !!session && String(value || "").length > 0 && String(value) === session.csrf;
}

function loginAllowed(key) {
  const now = Date.now();
  const state = failures.get(key);
  if (!state || state.resetAt <= now) return true;
  return state.count < 5;
}

function recordLoginFailure(key) {
  const now = Date.now();
  const state = failures.get(key);
  if (!state || state.resetAt <= now) failures.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
  else failures.set(key, { count: state.count + 1, resetAt: state.resetAt });
}

function clearLoginFailures(key) {
  failures.delete(key);
}

function ensureSchema(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS sites (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, domain TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER NOT NULL, ts INTEGER NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, referrer TEXT NOT NULL DEFAULT '', visitor TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', medium TEXT NOT NULL DEFAULT '', campaign TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', term TEXT NOT NULL DEFAULT '', value REAL);" +
      "CREATE TABLE IF NOT EXISTS goals (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER NOT NULL, name TEXT NOT NULL, event_name TEXT NOT NULL, path TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, UNIQUE (site_id, name));" +
      "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','viewer')), display_name TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS site_users (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('viewer')), PRIMARY KEY (user_id, site_id));" +
      "CREATE TABLE IF NOT EXISTS site_salts (site_id INTEGER NOT NULL, day TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (site_id, day));",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_site_ts ON events(site_id, ts);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_site_visitor_ts ON events(site_id, visitor, ts);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_site_name_ts ON events(site_id, name, ts);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);");

  // Bootstrap: first administrator from secrets, once. After that the
  // password lives only in D1; remove it from the environment.
  const count = Number(db.prepare("SELECT count(*) AS n FROM users").first().n);
  if (count === 0) {
    const email = normalizeEmail(optionalSecret("RISULTA_ADMIN_EMAIL"));
    const password = optionalSecret("RISULTA_ADMIN_PASSWORD");
    const displayName = String(optionalSecret("RISULTA_ADMIN_DISPLAY_NAME") || "").trim().slice(0, 80);
    if (email && password.length >= 12) {
      db.prepare("INSERT INTO users (email, password_hash, role, display_name, created_at) VALUES (?, ?, 'admin', ?, ?)")
        .bind(email, hashPassword(password), displayName || email.split("@")[0], Math.floor(Date.now() / 1000))
        .run();
    }
  }
}

function listSitesForUser(db, user) {
  if (user.role === "admin") return db.prepare("SELECT * FROM sites ORDER BY name COLLATE NOCASE").all().results;
  return db.prepare(
    "SELECT sites.* FROM sites JOIN site_users ON site_users.site_id = sites.id WHERE site_users.user_id = ? ORDER BY sites.name COLLATE NOCASE",
  ).bind(user.user_id).all().results;
}

function getSiteForUser(db, siteId, user) {
  if (user.role === "admin") return db.prepare("SELECT * FROM sites WHERE id = ?").bind(siteId).first() || null;
  return db.prepare(
    "SELECT sites.* FROM sites JOIN site_users ON site_users.site_id = sites.id WHERE sites.id = ? AND site_users.user_id = ?",
  ).bind(siteId, user.user_id).first() || null;
}

function cleanDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .replace(/:\d+$/, "")
    .replace(/\.$/, "")
    .slice(0, 253);
}

function validDomain(value) {
  if (value === "localhost") return true;
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function validEventName(name) {
  return /^[a-z][a-z0-9_]{0,63}$/.test(String(name || ""));
}

function validValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1000000000) return false;
  return n;
}

// Split "path + query" into a bounded pathname and bounded UTM attribution.
// Non-attribution query parameters are dropped, never stored.
function splitPathAndAttribution(rawPath) {
  const raw = String(rawPath || "").slice(0, 2048);
  const q = raw.indexOf("?");
  const pathname = (q === -1 ? raw : raw.slice(0, q)).slice(0, 2048) || "/";
  const out = { path: pathname, source: "", medium: "", campaign: "", content: "", term: "" };
  if (q === -1) return out;
  const params = new URLSearchParams(raw.slice(q + 1));
  out.source = String(params.get("utm_source") || "").trim().slice(0, 128);
  out.medium = String(params.get("utm_medium") || "").trim().slice(0, 128);
  out.campaign = String(params.get("utm_campaign") || "").trim().slice(0, 128);
  out.content = String(params.get("utm_content") || "").trim().slice(0, 128);
  out.term = String(params.get("utm_term") || "").trim().slice(0, 128);
  return out;
}

function referrerHost(value) {
  const raw = String(value || "").trim().slice(0, 2048);
  if (!raw) return "";
  try {
    return new URL(raw).hostname.toLowerCase().slice(0, 253);
  } catch {
    return "";
  }
}

// Client IP for visitor hashing. Only ever taken from X-Forwarded-For when
// the operator explicitly trusts their proxy (RISULTA_TRUST_PROXY=1); the
// proxy must overwrite the header, otherwise any visitor can spoof it.
// Direct exposure yields "" and weaker uniqueness. Never stored.
function clientIp(request) {
  if (!trustProxyEnabled()) return "";
  const forwarded = request.headers.get("x-forwarded-for") || "";
  return forwarded.split(",")[0].trim().slice(0, 45);
}

function dayString() {
  return new Date().toISOString().slice(0, 10);
}

function siteSalt(db, siteId, day) {
  const hit = saltCache.get(siteId);
  if (hit && hit.day === day) return hit.value;
  db.prepare("DELETE FROM site_salts WHERE day != ?").bind(day).run();
  db.prepare("INSERT OR IGNORE INTO site_salts (site_id, day, value) VALUES (?, ?, ?)").bind(siteId, day, randomHex(32)).run();
  const value = db.prepare("SELECT value FROM site_salts WHERE site_id = ? AND day = ?").bind(siteId, day).first().value;
  if (saltCache.size > 64) saltCache.clear();
  saltCache.set(siteId, { day, value });
  return value;
}

// A site-local identity that resets daily: neither input is stored.
function visitorId(db, site, request) {
  const salt = siteSalt(db, site.id, dayString());
  const ua = (request.headers.get("user-agent") || "").slice(0, 512);
  return sha256Hex(salt + "" + clientIp(request) + "" + ua).slice(0, 24);
}

// Range selection: explicit UTC from/to (YYYY-MM-DD, at most 366 days) or a
// period in days. until is one second past now so events in the current
// second stay visible. Uses Date.UTC with explicit components only.
function parseRange(searchParams, now) {
  const fromRaw = searchParams.get("from") || "";
  const toRaw = searchParams.get("to") || "";
  if (fromRaw !== "" || toRaw !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromRaw) || !/^\d{4}-\d{2}-\d{2}$/.test(toRaw)) {
      return { error: "from and to must be YYYY-MM-DD" };
    }
    const f = fromRaw.split("-");
    const t = toRaw.split("-");
    const since = Math.floor(Date.UTC(Number(f[0]), Number(f[1]) - 1, Number(f[2])) / 1000);
    const toDay = Math.floor(Date.UTC(Number(t[0]), Number(t[1]) - 1, Number(t[2])) / 1000);
    if (!(since <= toDay)) return { error: "from must not be after to" };
    if (toDay - since > 366 * 86400) return { error: "range exceeds 366 days" };
    return { since, until: Math.min(toDay + 86400, now + 1), label: fromRaw + ".." + toRaw, days: 0, from: fromRaw, to: toRaw };
  }
  const period = searchParams.get("period") || "7";
  const days = period === "1" ? 1 : period === "30" ? 30 : 7;
  return { since: now - days * 86400, until: now + 1, label: days + "d", days, from: "", to: "" };
}

function rangeDays(range) {
  if (range.days) return range.days;
  return Math.max(1, Math.round((range.until - range.since) / 86400));
}

function siteSummary(db, siteId, since, until) {
  return db.prepare(
    "WITH scoped AS (SELECT ts, visitor, lag(ts) OVER (PARTITION BY visitor ORDER BY ts) AS prev FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview') " +
      "SELECT count(*) AS pageviews, count(DISTINCT visitor) AS visitors, " +
      "coalesce(sum(CASE WHEN prev IS NULL OR ts - prev > 1800 THEN 1 ELSE 0 END), 0) AS visits FROM scoped",
  ).bind(siteId, since, until).first();
}

function siteCurrent(db, siteId) {
  return Number(db.prepare(
    "SELECT count(DISTINCT visitor) AS n FROM events WHERE site_id = ? AND ts >= ? AND name = 'pageview'",
  ).bind(siteId, Math.floor(Date.now() / 1000) - 300).first().n);
}

function topList(db, siteId, since, until, select) {
  return db.prepare(
    "SELECT " + select + " AS label, count(*) AS pageviews, count(DISTINCT visitor) AS visitors FROM events " +
      "WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview' GROUP BY label ORDER BY visitors DESC, pageviews DESC LIMIT 8",
  ).bind(siteId, since, until).all().results;
}

function siteGoals(db, siteId, since, until, visitors) {
  const goals = db.prepare("SELECT id, name, event_name, path FROM goals WHERE site_id = ? ORDER BY id").bind(siteId).all().results;
  const out = [];
  for (let i = 0; i < goals.length; i++) {
    const g = goals[i];
    const r = db.prepare(
      "SELECT count(*) AS conversions, count(DISTINCT visitor) AS unique_conversions, coalesce(sum(value), 0) AS value " +
        "FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = ? AND (? = '' OR path = ?)",
    ).bind(siteId, since, until, g.event_name, g.path, g.path).first();
    out.push({
      name: g.name,
      event_name: g.event_name,
      path: g.path,
      conversions: r.conversions,
      unique_conversions: r.unique_conversions,
      value: r.value,
      conversion_rate: visitors ? r.unique_conversions / visitors : 0,
    });
  }
  return out;
}

function siteAnalytics(db, site, since, until) {
  const summary = siteSummary(db, site.id, since, until);
  const visitors = Number(summary.visitors);
  return {
    summary,
    current: siteCurrent(db, site.id),
    byDay: db.prepare(
      "WITH scoped AS (SELECT ts, visitor FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview') " +
        "SELECT date(ts, 'unixepoch') AS day, count(*) AS pageviews, count(DISTINCT visitor) AS visitors FROM scoped GROUP BY day ORDER BY day",
    ).bind(site.id, since, until).all().results,
    byHour: db.prepare(
      "WITH scoped AS (SELECT ts, visitor FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview') " +
        "SELECT cast(strftime('%H', ts, 'unixepoch') AS INTEGER) AS hour, count(*) AS pageviews, count(DISTINCT visitor) AS visitors " +
        "FROM scoped GROUP BY hour ORDER BY hour",
    ).bind(site.id, since, until).all().results,
    paths: topList(db, site.id, since, until, "path"),
    referrers: topList(db, site.id, since, until, "coalesce(nullif(source,''),'Direct / None')"),
    mediums: topList(db, site.id, since, until, "coalesce(nullif(medium,''),'None')"),
    campaigns: topList(db, site.id, since, until, "coalesce(nullif(campaign,''),'None')"),
    goals: siteGoals(db, site.id, since, until, visitors),
  };
}

// Bounded report query mirroring the Bun app's report semantics: exact-match
// filters, pageviews-only dimensions except event, sortable, paginated.
function siteReport(db, siteId, since, until, dimension, filters, limit, offset, sort) {
  const dimensions = {
    path: { label: "path", pageviewsOnly: true },
    source: { label: "coalesce(nullif(source,''),'Direct / None')", pageviewsOnly: true },
    medium: { label: "coalesce(nullif(medium,''),'None')", pageviewsOnly: true },
    campaign: { label: "coalesce(nullif(campaign,''),'None')", pageviewsOnly: true },
    event: { label: "name", pageviewsOnly: false },
  };
  const selected = dimensions[dimension] || dimensions.path;
  const conditions = ["site_id = ?", "ts >= ?", "ts < ?"];
  const values = [siteId, since, until];
  if (selected.pageviewsOnly) conditions.push("name = 'pageview'");
  const columns = [["path", "path"], ["campaign", "campaign"], ["event", "name"]];
  for (let i = 0; i < columns.length; i++) {
    if (filters[columns[i][0]]) {
      conditions.push(columns[i][1] + " = ?");
      values.push(filters[columns[i][0]]);
    }
  }
  if (filters.source) {
    conditions.push("coalesce(nullif(source,''),'Direct / None') = ?");
    values.push(filters.source);
  }
  if (filters.medium) {
    conditions.push("coalesce(nullif(medium,''),'None') = ?");
    values.push(filters.medium);
  }
  const where = conditions.join(" AND ");
  const ordering = sort === "pageviews" || sort === "value" ? sort : "visitors";
  const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const boundedOffset = Math.max(0, Math.min(10000, Number(offset) || 0));
  const grouped =
    "SELECT " + selected.label + " AS label, count(*) AS pageviews, count(DISTINCT visitor) AS visitors, coalesce(sum(value), 0) AS value " +
    "FROM events WHERE " + where + " GROUP BY label";
  const listed = db.prepare(grouped + " ORDER BY " + ordering + " DESC, label LIMIT ? OFFSET ?");
  const result = listed.bind(...values, boundedLimit, boundedOffset).all().results;
  const counted = db.prepare("SELECT count(*) AS n FROM (" + grouped + ")");
  const total = Number(counted.bind(...values).first().n);
  return { dimension: dimensions[dimension] ? dimension : "path", filters, rows: result, total, limit: boundedLimit, offset: boundedOffset, sort: ordering };
}

function csvEscape(value) {
  const s = String(value === null || value === undefined ? "" : value);
  if (s.indexOf('"') !== -1 || s.indexOf(",") !== -1 || s.indexOf("\n") !== -1) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function reportCsv(report) {
  const lines = ["label,pageviews,visitors,value"];
  for (let i = 0; i < report.rows.length; i++) {
    const r = report.rows[i];
    lines.push(csvEscape(r.label) + "," + r.pageviews + "," + r.visitors + "," + csvEscape(r.value));
  }
  return lines.join("\n") + "\n";
}

function trackerFor(publicKey) {
  return (
    "/*! Risulta tracker - MIT */(()=>{let l=\"\";const s=document.currentScript,e=new URL(\"/api/event/" +
    publicKey +
    "\",s.src).href,p=(n,v)=>fetch(e,{method:\"POST\",mode:\"cors\",keepalive:true,headers:{\"Content-Type\":\"text/plain\"},body:JSON.stringify({name:n,path:location.pathname+location.search,referrer:document.referrer,domain:location.hostname,value:v})}).catch(()=>{}),f=()=>{const p=location.pathname+location.search;if(p===l)return;l=p;return(window.risulta??={}).track(\"pageview\")};for(const k of[\"pushState\",\"replaceState\"]){const o=history[k];history[k]=function(){const r=o.apply(this,arguments);f();return r}}(window.risulta??={}).track=p;addEventListener(\"popstate\",f);addEventListener(\"pageshow\",e=>{if(e.persisted){l=\"\";f()}});f()})();"
  );
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtInt(n) {
  const neg = Number(n) < 0;
  let s = String(Math.floor(Math.abs(Number(n)) || 0));
  let out = "";
  while (s.length > 3) {
    out = "," + s.slice(-3) + out;
    s = s.slice(0, -3);
  }
  return (neg ? "-" : "") + s + out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayLabel(isoDay) {
  const parts = String(isoDay).split("-");
  return MONTHS[Number(parts[1]) - 1] + " " + Number(parts[2]);
}

function hourLabel(hour) {
  const h = Number(hour);
  const pad = h < 10 ? "0" + h : "" + h;
  return pad + ":00";
}

// Fill trailing UTC days so the chart never has gaps.
function dateSeries(days, rows) {
  const values = {};
  for (let i = 0; i < rows.length; i++) values[rows[i].day] = rows[i];
  const out = [];
  const todayStart = Math.floor(Date.now() / 86400000) * 86400000;
  for (let offset = days - 1; offset >= 0; offset--) {
    const day = new Date(todayStart - offset * 86400000).toISOString().slice(0, 10);
    out.push(values[day] || { day, pageviews: 0, visitors: 0, visits: 0 });
  }
  return out;
}

function hourSeries(rows) {
  const values = {};
  for (let i = 0; i < rows.length; i++) values[Number(rows[i].hour)] = rows[i];
  const out = [];
  for (let hour = 0; hour < 24; hour++) {
    const row = values[hour] || { pageviews: 0, visitors: 0, visits: 0 };
    out.push({ hour, pageviews: row.pageviews, visitors: row.visitors, visits: row.visits });
  }
  return out;
}

function chartPointLabel(point) {
  if (point.hour === undefined) return dayLabel(point.day);
  return hourLabel(point.hour) + " UTC";
}

function chart(series, metric, metricLabel) {
  const width = 960;
  const height = 248;
  const top = 16;
  const bottom = 30;
  let max = 1;
  for (let i = 0; i < series.length; i++) max = Math.max(max, Number(series[i][metric]));
  const x = function (index) {
    return series.length === 1 ? width / 2 : (index / (series.length - 1)) * width;
  };
  const y = function (value) {
    return top + (1 - Number(value) / max) * (height - top - bottom);
  };
  const xs = [];
  const ys = [];
  for (let i = 0; i < series.length; i++) {
    xs.push(x(i));
    ys.push(y(series[i][metric]));
  }
  let line = "";
  for (let i = 0; i < series.length; i++) {
    if (!i) {
      line += "M" + xs[i].toFixed(1) + "," + ys[i].toFixed(1);
      continue;
    }
    const beforeX = i >= 2 ? xs[i - 2] : xs[i - 1];
    const beforeY = i >= 2 ? ys[i - 2] : ys[i - 1];
    const afterX = i + 1 < series.length ? xs[i + 1] : xs[i];
    const afterY = i + 1 < series.length ? ys[i + 1] : ys[i];
    const segmentMin = Math.min(ys[i - 1], ys[i]);
    const segmentMax = Math.max(ys[i - 1], ys[i]);
    const clampY = function (value) {
      return Math.max(segmentMin, Math.min(segmentMax, value));
    };
    const c1x = xs[i - 1] + (xs[i] - beforeX) / 6;
    const c1y = clampY(ys[i - 1] + (ys[i] - beforeY) / 6);
    const c2x = xs[i] - (afterX - xs[i - 1]) / 6;
    const c2y = clampY(ys[i] - (afterY - ys[i - 1]) / 6);
    line += "C" + c1x.toFixed(1) + "," + c1y.toFixed(1) + " " + c2x.toFixed(1) + "," + c2y.toFixed(1) + " " + xs[i].toFixed(1) + "," + ys[i].toFixed(1);
  }
  const area = line + " L" + width + "," + (height - bottom) + " L0," + (height - bottom) + " Z";
  const ticks = [];
  for (let i = 0; i < series.length; i++) {
    if (series.length <= 7 || i % Math.ceil(series.length / 6) === 0 || i === series.length - 1) ticks.push(i);
  }
  let circles = "";
  for (let i = 0; i < series.length; i++) {
    const label = chartPointLabel(series[i]) + ": " + fmtInt(series[i][metric]) + " " + metricLabel.toLowerCase();
    circles += '<circle class="chart-point" cx="' + xs[i] + '" cy="' + ys[i] + '" r="5" tabindex="0" data-value="' + escapeHtml(label) + '"><title>' + escapeHtml(label) + "</title></circle>";
  }
  let tickLabels = "";
  for (let t = 0; t < ticks.length; t++) {
    const i = ticks[t];
    const anchor = i === 0 ? "start" : i === series.length - 1 ? "end" : "middle";
    const text = chartPointLabel(series[i]).replace(" UTC", "");
    tickLabels += '<text x="' + xs[i] + '" y="' + (height - 7) + '" text-anchor="' + anchor + '">' + escapeHtml(text) + "</text>";
  }
  return '<svg class="chart" viewBox="0 0 ' + width + " " + height + '" role="img" aria-labelledby="chart-title chart-desc">' +
    '<title id="chart-title">' + escapeHtml(metricLabel) + " over the selected period</title>" +
    '<desc id="chart-desc">A line chart with a peak of ' + fmtInt(max) + " " + escapeHtml(metricLabel.toLowerCase()) + " in one interval.</desc>" +
    '<defs><linearGradient id="area" x1="0" x2="0" y1="0" y2="1"><stop stop-color="currentColor" stop-opacity=".16"/>' +
    '<stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>' +
    '<g class="grid" aria-hidden="true"><path d="M0 ' + top + "H" + width + "M0 " + (height - bottom + top) / 2 + "H" + width + "M0 " + (height - bottom) + 'H' + width + '"/></g>' +
    '<polygon points="' + area + '" fill="url(#area)" aria-hidden="true"/>' +
    '<path d="' + line + '" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" aria-hidden="true"/>' +
    circles + tickLabels + "</svg>";
}

const MARK = '<span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>';

function topbar(user, site, sites) {
  const switcher = site && sites.length > 1
    ? '<div class="site-context"><details class="site-switcher"><summary class="site-switcher-trigger"><span>' + escapeHtml(site.name) +
      '</span><span class="select-chevron" aria-hidden="true"></span></summary><div class="site-switcher-menu">' +
      sites.map((s) => '<a href="/sites/' + s.id + '"' + (s.id === site.id ? ' aria-current="page"' : "") + "><span>" + (s.id === site.id ? "✓" : "") + "</span>" + escapeHtml(s.name) + "</a>").join("") +
      "</div></details></div>"
    : "";
  return '<header class="topbar"><div class="shell topbar-inner"><a class="brand" href="/">' + MARK + "<span>Risulta</span></a>" + switcher +
    '<nav class="nav" aria-label="Account"><details class="account-menu"><summary><span class="account-trigger-email">' + escapeHtml(user.email) + "</span></summary>" +
    '<div class="account-panel"><span class="account-email">' + escapeHtml(user.email) + '</span><a href="/">Websites</a><a href="/account">Account settings</a>' +
    (user.role === "admin" ? '<a href="/users">Users</a>' : "") +
    '<form method="post" action="/logout"><input type="hidden" name="csrf" value="' + user.csrf + '"><button class="link-button" type="submit">Log out</button></form>' +
    "</div></details></nav></div></header>";
}

function pageShell(title, user, body, site, sites) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light dark"><meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">' +
    '<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">' +
    '<link rel="stylesheet" href="/style.css">' +
    "<title>" + escapeHtml(title) + " - Risulta</title>" +
    '<script src="/dashboard.js" defer></script></head><body><a class="skip" href="#main">Skip to content</a>' +
    (user ? topbar(user, site || null, sites || []) : "") + body +
    (user ? '<footer class="footer"><div class="shell"><span><strong>Risulta Sprout</strong> standalone analytics</span></div></footer>' : "") +
    "</body></html>";
}

function loginPage(error) {
  return pageShell(
    "Sign in",
    null,
    '<main class="auth" id="main"><div class="auth-box"><div class="auth-brand">' + MARK + "<span>Risulta</span></div>" +
      '<section class="card" aria-labelledby="login-title"><h1 id="login-title">Sign in to Risulta</h1>' +
      '<p class="intro">Use one account to view all of your websites.</p>' +
      (error ? '<p class="error" id="login-error">' + escapeHtml(error) + "</p>" : "") +
      '<form class="form" method="post" action="/login">' +
      '<div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required></div>' +
      '<div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>' +
      '<button class="button" type="submit">Sign in</button></form></section></div></main>',
  );
}

function homePage(user, sites) {
  const cards = sites.length
    ? '<ol class="site-list">' + sites.map((s) =>
      '<li><a class="site-link" href="/sites/' + s.id + '"><span><strong>' + escapeHtml(s.name) + '</strong><span class="site-domain">' + escapeHtml(s.domain) +
      '</span></span><span class="arrow" aria-hidden="true">→</span>' +
      '<span class="site-overview" aria-label="Last 7 days"><span><strong>' + fmtInt(s.overview.visitors) + "</strong>visitors</span>" +
      "<span><strong>" + fmtInt(s.overview.pageviews) + "</strong>views</span></span></a></li>").join("") + "</ol>"
    : '<div class="empty-card"><h2>No websites yet</h2><p>Add your first website to start collecting private analytics.</p></div>';
  return pageShell(
    "Websites",
    user,
    '<main class="shell" id="main"><div class="titlebar"><div><p class="eyebrow">Workspace</p><h1>Your websites</h1></div>' +
      (user.role === "admin"
        ? '<div class="actions"><a class="button" href="/sites/new">Add website</a></div>'
        : "") + "</div>" +
      '<section aria-label="Websites">' + cards + "</section></main>",
    null,
    sites,
  );
}

function newSitePage(user, error) {
  return pageShell(
    "Add website",
    user,
    '<main class="shell" id="main"><div class="titlebar"><div><p class="eyebrow">Website administration</p><h1>Add a website</h1></div></div>' +
      '<section class="card"><form class="form" method="post" action="/api/sites"><input type="hidden" name="csrf" value="' + user.csrf + '">' +
      (error ? '<p class="error">' + escapeHtml(error) + "</p>" : "") +
      '<div class="field"><label for="name">Name</label><input id="name" name="name" required maxlength="100"><p class="hint">A friendly name, such as Marketing site.</p></div>' +
      '<div class="field"><label for="domain">Domain</label><input id="domain" name="domain" required maxlength="253" inputmode="url" placeholder="example.com">' +
      "<p class=\"hint\">Hostname only. Risulta rejects events claiming another domain.</p></div>" +
      '<div class="actions"><button class="button" type="submit">Add website</button><a class="button secondary" href="/">Cancel</a></div>' +
      "</form></section></main>",
  );
}

function reportCard(title, rows, emptyLabel, detailLinks) {
  let max = 1;
  for (let i = 0; i < rows.length; i++) max = Math.max(max, Number(rows[i].visitors));
  const items = rows.length
    ? "<ol>" + rows.map((row) => {
      const width = Math.max(2, (Number(row.visitors) / max) * 100).toFixed(1);
      return '<li><div class="row-label"><span class="truncate" title="' + escapeHtml(row.label) + '">' + escapeHtml(row.label) +
        '</span><span class="value">' + fmtInt(row.visitors) + '</span></div><div class="meter" aria-hidden="true"><span style="width:' + width + '%"></span></div></li>';
    }).join("") + "</ol>"
    : '<p class="empty-small">' + escapeHtml(emptyLabel) + "</p>";
  const id = title.toLowerCase().replace(/ /g, "-");
  return '<section class="report" aria-labelledby="' + id + '"><div class="report-head"><h2 id="' + id + '">' + escapeHtml(title) + "</h2><span>" + detailLinks + "</span></div>" + items + "</section>";
}

function goalCard(goals) {
  if (!goals.length) return "";
  const items = goals.map((goal) => {
    let hint = fmtInt(goal.unique_conversions) + " unique, " + (Number(goal.conversion_rate) * 100).toFixed(1) + "% conversion rate";
    if (Number(goal.value)) hint += ", " + fmtInt(goal.value) + " value";
    return '<li><div class="row-label"><span class="truncate">' + escapeHtml(goal.name) + '</span><span class="value">' + fmtInt(goal.conversions) +
      '</span></div><p class="hint">' + escapeHtml(hint) + "</p></li>";
  }).join("");
  return '<section class="report" aria-labelledby="goals-title"><div class="report-head"><h2 id="goals-title">Goals</h2><span>Conversions</span></div><ol>' + items + "</ol></section>";
}

function sitePage(user, site, sites, analytics, range, days, metric, origin) {
  const metrics = analytics.summary;
  const viewsPerVisit = Number(metrics.visits) ? Number(metrics.pageviews) / Number(metrics.visits) : 0;
  const visitorLabel = days === 1 ? "Unique visitors today" : "Unique visitor-days";
  const metricLabel = metric === "pageviews" ? "Pageviews" : metric === "visits" ? "Visits" : visitorLabel;
  const title = range.from ? range.from + " to " + range.to : days === 1 ? "Today" : "Last " + days + " days";
  const hasData = Number(metrics.pageviews) > 0;
  const series = days === 1 ? hourSeries(analytics.byHour) : dateSeries(days, analytics.byDay);
  const statsBase = "/api/sites/" + site.id + "/stats?" + (range.from ? "from=" + range.from + "&to=" + range.to : "period=" + days);
  const pageQuery = range.from ? "from=" + range.from + "&to=" + range.to : "period=" + days;
  const metricTabs = [["visitors", visitorLabel], ["visits", "Visits"], ["pageviews", "Pageviews"]].map((tab) =>
    '<a href="/sites/' + site.id + "?" + pageQuery + "&metric=" + tab[0] + '"' + (metric === tab[0] ? ' aria-current="page"' : "") + ">" + escapeHtml(tab[1]) + "</a>").join("");
  const periodTabs = [1, 7, 30].map((period) =>
    '<a href="/sites/' + site.id + "?period=" + period + "&metric=" + metric + '"' + (!range.from && period === days ? ' aria-current="page"' : "") + ">" +
    (period === 1 ? "Today" : period + "d") + "</a>").join("");
  const snippet = '<script defer src="' + origin + "/js/" + site.public_key + '.js"></script>';
  const install = '<section class="card install" aria-labelledby="install-title"><h2 id="install-title">Install the tracker</h2><p>Paste this into the <code>&lt;head&gt;</code> of ' +
    escapeHtml(site.domain) + '.</p><div class="snippet" role="region" tabindex="0" aria-label="Tracker installation code"><code>' + escapeHtml(snippet) +
    '</code></div><button class="button secondary" type="button" data-copy-code>Copy code</button><p class="hint" id="copy-status" role="status" aria-live="polite"></p></section>';
  const goalItems = analytics.goalsList.map((g) => "<li>" + escapeHtml(g.name) + " (" + escapeHtml(g.event_name) + (g.path ? ", " + escapeHtml(g.path) : "") + ")</li>").join("");
  const goalForm = user.role === "admin"
    ? '<section class="card" aria-labelledby="goals-admin"><h2 id="goals-admin">Conversion goals</h2><ul>' + (goalItems || "<li>none yet</li>") + "</ul>" +
      '<form class="form" method="post" action="/api/sites/' + site.id + '/goals"><input type="hidden" name="csrf" value="' + user.csrf + '">' +
      '<div class="field"><label for="goal-name">Name</label><input id="goal-name" name="name" required maxlength="80" placeholder="Signup"></div>' +
      '<div class="field"><label for="goal-event">Event</label><input id="goal-event" name="event_name" required maxlength="64" placeholder="signup"></div>' +
      '<div class="field"><label for="goal-path">Path (optional)</label><input id="goal-path" name="path" maxlength="2048" placeholder="/pricing"></div>' +
      '<div class="actions"><button class="button" type="submit">Add goal</button></div></form></section>'
    : "";
  const reportLinks = '<a class="footer-link" href="/api/sites/' + site.id + "/report?" + pageQuery + '&dimension=path">JSON</a> · <a class="footer-link" href="/api/sites/' + site.id + "/report?" + pageQuery + '&dimension=path&format=csv">CSV</a>';
  return pageShell(
    site.name + " analytics",
    user,
    '<main class="shell" id="main"><div class="titlebar"><div><p class="eyebrow">' + escapeHtml(site.domain) + "</p><h1>" + escapeHtml(title) + "</h1></div>" +
      '<div class="dashboard-controls"><div id="live-current" aria-live="polite"><span class="current"><span class="site-dot" aria-hidden="true"></span><strong data-current>' +
      fmtInt(analytics.current) + '</strong> current</span></div><nav class="periods" aria-label="Date range">' + periodTabs + "</nav>" +
      '<details class="range-picker"><summary class="button secondary">Custom range</summary>' +
      '<form class="range-form" method="get" action="/sites/' + site.id + '"><input type="hidden" name="metric" value="' + escapeHtml(metric) + '">' +
      '<label class="compact-field" for="range-from"><span>From</span><input id="range-from" name="from" type="date" required value="' + escapeHtml(range.from) + '"></label>' +
      '<label class="compact-field" for="range-to"><span>To</span><input id="range-to" name="to" type="date" required value="' + escapeHtml(range.to) + '"></label>' +
      '<button class="button secondary" type="submit">Apply</button></form></details></div></div>' +
      '<div id="live-stats" data-stats-url="' + statsBase + '" data-range-query="' + pageQuery + '" data-site-id="' + site.id + '">' +
      '<section class="panel" aria-label="Traffic summary"><div class="metrics">' +
      '<div class="metric"><span>' + escapeHtml(visitorLabel) + '</span><strong data-metric="visitors">' + fmtInt(metrics.visitors) + "</strong></div>" +
      '<div class="metric"><span>Total visits</span><strong data-metric="visits">' + fmtInt(metrics.visits) + "</strong></div>" +
      '<div class="metric"><span>Total pageviews</span><strong data-metric="pageviews">' + fmtInt(metrics.pageviews) + "</strong></div>" +
      '<div class="metric"><span>Views per visit</span><strong data-metric="views-per-visit">' + viewsPerVisit.toFixed(2) + "</strong></div></div>" +
      (hasData
        ? '<div class="chart-wrap"><nav class="periods" aria-label="Chart metric">' + metricTabs + "</nav>" + chart(series, metric === "visitors" ? "visitors" : metric, metricLabel) + "</div>"
        : '<div class="empty"><h2>Waiting for the first visitor</h2><p>Install the tracker below. New visits will appear here live.</p></div>') +
      "</section>" +
      '<p class="hint metrics-note">Visitor identities reset at each UTC day. Multi-day totals are unique visitor-days, not deduplicated people. <span class="status" id="poll-status" data-state="live">Live.</span></p>' +
      '<div id="dashboard-reports" class="reports">' + goalCard(analytics.goals) +
      reportCard("Top pages", analytics.paths, "Pages will appear after the first view.", reportLinks) +
      reportCard("Top sources", analytics.referrers, "Sources will appear after the first visit.", reportLinks) +
      reportCard("Top mediums", analytics.mediums, "Mediums will appear after tagged visits.", reportLinks) +
      reportCard("Top campaigns", analytics.campaigns, "Campaigns will appear after tagged visits.", reportLinks) +
      "</div></div>" + (hasData ? "" : install) + goalForm + "</main>",
    site,
    sites,
  );
}

function usersPage(admin, users, sites) {
  const records = users.map((u) =>
    '<li class="user-record"><div class="user-identity"><strong>' + escapeHtml(u.display_name || u.email) + "</strong><span>" + escapeHtml(u.email) + "</span></div>" +
    '<div class="user-access"><span class="badge">' + escapeHtml(u.role) + "</span><span>" + escapeHtml(u.role === "admin" ? "All websites" : u.sites || "No websites assigned") + "</span>" +
    (u.id !== admin.user_id
      ? '<form class="inline" method="post" action="/api/users/' + u.id + '/delete"><input type="hidden" name="csrf" value="' + admin.csrf + '"><button class="link-button" type="submit">Delete</button></form>'
      : "<span>(you)</span>") + "</div></li>").join("");
  const checks = sites.length
    ? sites.map((s) => '<label class="check"><input type="checkbox" name="site" value="' + s.id + '"><span>' + escapeHtml(s.name) + ' <span class="hint">' + escapeHtml(s.domain) + "</span></span></label>").join("")
    : '<p class="hint">Add a website before assigning a viewer.</p>';
  return pageShell(
    "Users",
    admin,
    '<main class="shell" id="main"><div class="titlebar"><div><p class="eyebrow">Administration</p><h1>Users</h1></div></div>' +
      '<div class="users-workspace"><section class="card"><h2>Create user</h2><form class="form" method="post" action="/api/users">' +
      '<input type="hidden" name="csrf" value="' + admin.csrf + '">' +
      '<div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="off" required></div>' +
      '<div class="field"><label for="password">Temporary password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required><p class="hint">Use at least 12 characters.</p></div>' +
      '<div class="field"><label for="role">Access level</label><select id="role" name="role"><option value="viewer">Viewer</option><option value="admin">Administrator</option></select></div>' +
      '<fieldset class="checks"><legend class="legend">Viewer websites</legend>' + checks + "</fieldset>" +
      '<button class="button" type="submit">Create user</button></form></section>' +
      '<section class="card users-panel" aria-labelledby="existing-users-title"><div class="users-head"><div><h2 id="existing-users-title">Existing users</h2><p>' +
      users.length + " account" + (users.length === 1 ? "" : "s") + "</p></div></div>" +
      '<ol class="user-list">' + records + "</ol></section></div></main>",
    null,
    [],
  );
}

function accountPage(user, changed) {
  return pageShell(
    "Account settings",
    user,
    '<main class="shell" id="main"><div class="titlebar"><div><p class="eyebrow">Account</p><h1>Account settings</h1></div></div>' +
      '<section class="card settings-section" aria-labelledby="password-title"><h2 id="password-title">Change password</h2>' +
      '<p class="hint">Changing your password signs out your other active sessions.</p>' +
      (changed ? '<p class="success" role="status">Password changed. Other sessions were signed out.</p>' : "") +
      '<form class="form" method="post" action="/api/account/password"><input type="hidden" name="csrf" value="' + user.csrf + '">' +
      '<div class="field"><label for="current-password">Current password</label><input id="current-password" name="current" type="password" autocomplete="current-password" required></div>' +
      '<div class="field"><label for="new-password">New password</label><input id="new-password" name="password" type="password" autocomplete="new-password" minlength="12" required><p class="hint">Use at least 12 characters.</p></div>' +
      '<button class="button" type="submit">Change password</button></form></section></main>',
    null,
    [],
  );
}

export default {
  fetch(request) {
    if (!schemaReady) {
      ensureSchema(env.DB);
      schemaReady = true;
    }
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const secure = url.protocol === "https:";
    const body = method === "POST" || method === "PUT" ? request.body || "" : "";
    const ctype = request.headers.get("content-type") || "";
    const wantsJson = ctype.indexOf("application/json") !== -1;

    if (path === "/healthz") return new Response("ok\n");
    if (path === "/favicon.ico") return new Response("", { status: 204 });
    if (method === "GET" && (path === "/style.css" || path === "/dashboard.js")) return env.ASSETS.fetch(request);

    // Tracker asset: public, cookieless, same behavior as the Bun app.
    const jsMatch = /^\/js\/([A-Za-z0-9_-]+)\.js$/.exec(path);
    if (jsMatch && method === "GET") {
      const site = env.DB.prepare("SELECT id FROM sites WHERE public_key = ?").bind(jsMatch[1]).first();
      if (!site) return json({ error: "unknown site" }, 404);
      return new Response(trackerFor(jsMatch[1]), { headers: { "content-type": "text/javascript;charset=utf-8" } });
    }

    // Collector: public. Derives the daily salted visitor hash server-side
    // from proxy-provided IP + User-Agent; neither input is stored.
    const eventMatch = /^\/api\/event\/([A-Za-z0-9_-]+)$/.exec(path);
    if (eventMatch && method === "POST") {
      const site = siteForKey(env.DB, eventMatch[1]);
      if (!site) return json({ error: "unknown site" }, 404);
      const parsed = parseJson(body);
      if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
      const input = parsed.value;
      const name = String(input.name || "");
      if (!validEventName(name)) return json({ error: "event name is invalid" }, 400);
      const value = validValue(input.value === undefined ? null : input.value);
      if (value === false) return json({ error: "value is out of range" }, 400);
      const domain = cleanDomain(input.domain);
      if (domain !== site.domain) return json({ error: "domain mismatch" }, 403);
      const parts = splitPathAndAttribution(input.path);
      if (parts.path.charAt(0) !== "/") return json({ error: "path must start with /" }, 400);
      const ts = Math.floor(Date.now() / 1000);
      env.DB.prepare(
        "INSERT INTO events (site_id, ts, name, path, referrer, visitor, source, medium, campaign, content, term, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          site.id, ts, name, parts.path, referrerHost(input.referrer),
          visitorId(env.DB, site, request),
          parts.source, parts.medium, parts.campaign, parts.content, parts.term, value,
        )
        .run();
      return json({ ok: true }, 202);
    }

    // Sign-in. Rate-limited per email; JSON callers get codes, forms get the
    // page re-rendered with an error.
    if (path === "/login") {
      if (method === "GET") {
        const existing = readSession(env.DB, request);
        if (existing) return redirect("/");
        return new Response(loginPage(""), { headers: { "content-type": "text/html;charset=utf-8" } });
      }
      if (method === "POST") {
        let email = "";
        let password = "";
        if (wantsJson) {
          const parsed = parseJson(body);
          if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
          email = normalizeEmail(parsed.value.email);
          password = String(parsed.value.password || "");
        } else {
          const form = new URLSearchParams(body);
          email = normalizeEmail(form.get("email"));
          password = String(form.get("password") || "");
        }
        if (!loginAllowed(email)) {
          if (wantsJson) return json({ error: "too many attempts, try later" }, 429);
          return new Response(loginPage("Too many attempts, try again later."), { headers: { "content-type": "text/html;charset=utf-8" } });
        }
        const user = env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
        if (!user || !verifyPassword(password, user.password_hash)) {
          recordLoginFailure(email);
          if (wantsJson) return json({ error: "invalid email or password" }, 401);
          return new Response(loginPage("Invalid email or password."), { headers: { "content-type": "text/html;charset=utf-8" } });
        }
        clearLoginFailures(email);
        const session = createSession(env.DB, user.id);
        const cookie = setSessionCookie(session.token, secure);
        if (wantsJson) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "set-cookie": cookie } });
        return refreshPage("/", cookie);
      }
    }

    // Everything below requires a session. API callers get 401 JSON,
    // browsers get the sign-in page via redirect.
    const session = readSession(env.DB, request);
    const apiRoute = path === "/api" || path.indexOf("/api/") === 0;
    if (!session) {
      if (apiRoute) return json({ error: "sign in required" }, 401);
      return redirect("/login");
    }
    const isAdmin = session.role === "admin";

    if (path === "/logout" && method === "POST") {
      if (!csrfValid(session, csrfValue(request, body))) return wantsJson ? json({ error: "csrf mismatch" }, 403) : redirect("/login");
      destroySession(env.DB, request);
      const expired = expiredSessionCookie(secure);
      if (wantsJson) return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "set-cookie": expired } });
      return refreshPage("/login", expired);
    }

    if (path === "/api/session" && method === "GET") {
      return json({ id: session.user_id, email: session.email, displayName: session.display_name, role: session.role, csrf: session.csrf });
    }

    if (path === "/" && method === "GET") {
      const sites = listSitesForUser(env.DB, session);
      const now = Math.floor(Date.now() / 1000);
      const overviews = [];
      for (let i = 0; i < sites.length; i++) {
        const summary = siteSummary(env.DB, sites[i].id, now - 7 * 86400, now + 1);
        overviews.push({ id: sites[i].id, name: sites[i].name, domain: sites[i].domain, overview: { visitors: Number(summary.visitors), pageviews: Number(summary.pageviews) } });
      }
      return new Response(homePage(session, overviews), { headers: { "content-type": "text/html;charset=utf-8" } });
    }

    if (path === "/sites/new" && method === "GET") {
      if (!isAdmin) return redirect("/");
      const error = url.searchParams.get("error") || "";
      return new Response(newSitePage(session, error), { headers: { "content-type": "text/html;charset=utf-8" } });
    }

    if (path === "/account" && method === "GET") {
      const changed = (url.searchParams.get("changed") || "") === "1";
      return new Response(accountPage(session, changed), { headers: { "content-type": "text/html;charset=utf-8" } });
    }

    if (path === "/api/account/password" && method === "POST") {
      let current = "";
      let next = "";
      if (wantsJson) {
        const parsed = parseJson(body);
        if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
        current = String(parsed.value.current || "");
        next = String(parsed.value.password || "");
      } else {
        const form = new URLSearchParams(body);
        current = String(form.get("current") || "");
        next = String(form.get("password") || "");
      }
      if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
      const user = env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(session.user_id).first();
      if (!user || !verifyPassword(current, user.password_hash)) return json({ error: "current password is wrong" }, 403);
      if (next.length < 12) return json({ error: "new password needs 12+ characters" }, 400);
      changePassword(env.DB, session, hashPassword(next));
      if (wantsJson) return json({ ok: true });
      return redirect("/account?changed=1");
    }

    if (path === "/users" && method === "GET") {
      if (!isAdmin) return redirect("/");
      const users = env.DB.prepare(
        "SELECT users.id, users.email, users.display_name, users.role, users.created_at, group_concat(sites.name, ', ') AS sites " +
          "FROM users LEFT JOIN site_users ON site_users.user_id = users.id LEFT JOIN sites ON sites.id = site_users.site_id " +
          "GROUP BY users.id ORDER BY users.created_at, users.id",
      ).all().results;
      const sites = env.DB.prepare("SELECT id, name, domain FROM sites ORDER BY name COLLATE NOCASE").all().results;
      return new Response(usersPage(session, users, sites), { headers: { "content-type": "text/html;charset=utf-8" } });
    }

    if (path === "/api/users" && method === "POST") {
      if (!isAdmin) return json({ error: "forbidden" }, 403);
      if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
      let email = "";
      let displayName = "";
      let password = "";
      let role = "viewer";
      let siteIds = [];
      if (wantsJson) {
        const parsed = parseJson(body);
        if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
        const input = parsed.value;
        email = normalizeEmail(input.email);
        displayName = String(input.displayName || input.display_name || "").trim().slice(0, 80);
        password = String(input.password || "");
        role = input.role === "admin" ? "admin" : "viewer";
        const rawSites = input.siteIds || input.site_ids || [];
        for (let i = 0; i < rawSites.length; i++) siteIds.push(Number(rawSites[i]));
      } else {
        const form = new URLSearchParams(body);
        email = normalizeEmail(form.get("email"));
        displayName = String(form.get("display_name") || "").trim().slice(0, 80);
        password = String(form.get("password") || "");
        role = form.get("role") === "admin" ? "admin" : "viewer";
        const checked = form.getAll("site");
        for (let i = 0; i < checked.length; i++) siteIds.push(Number(checked[i]));
      }
      if (!email) {
        if (wantsJson) return json({ error: "email is required" }, 400);
        return redirect("/users");
      }
      if (password.length < 12) {
        if (wantsJson) return json({ error: "password needs 12+ characters" }, 400);
        return redirect("/users");
      }
      let userId = 0;
      try {
        userId = createUser(env.DB, email, password, role, siteIds, displayName);
      } catch {
        if (wantsJson) return json({ error: "email already registered" }, 409);
        return redirect("/users");
      }
      if (wantsJson) return json({ ok: true, id: userId, email, role }, 201);
      return redirect("/users");
    }

    const deleteUserMatch = /^\/api\/users\/(\d+)\/delete$/.exec(path);
    if (deleteUserMatch && method === "POST") {
      if (!isAdmin) return json({ error: "forbidden" }, 403);
      if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
      const targetId = Number(deleteUserMatch[1]);
      if (targetId === session.user_id) return json({ error: "cannot delete yourself" }, 400);
      const target = env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(targetId).first();
      if (!target) return json({ error: "unknown user" }, 404);
      if (target.role === "admin" && Number(env.DB.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin'").first().n) < 2) {
        return json({ error: "cannot delete the last administrator" }, 400);
      }
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(targetId).run();
      if (wantsJson) return json({ ok: true });
      return redirect("/users");
    }

    const sitePageMatch = /^\/sites\/(\d+)$/.exec(path);
    if (sitePageMatch && method === "GET") {
      const site = getSiteForUser(env.DB, Number(sitePageMatch[1]), session);
      if (!site) {
        return new Response(pageShell("Not found", session, '<main class="shell" id="main"><h1>Unknown site</h1></main>', null, []),
          { status: 404, headers: { "content-type": "text/html;charset=utf-8" } });
      }
      const now = Math.floor(Date.now() / 1000);
      const range = parseRange(url.searchParams, now);
      if (range.error) {
        return new Response(pageShell("Not found", session, '<main class="shell" id="main"><h1>' + escapeHtml(range.error) + "</h1></main>", null, []),
          { status: 400, headers: { "content-type": "text/html;charset=utf-8" } });
      }
      const days = rangeDays(range);
      const metricParam = url.searchParams.get("metric") || "visitors";
      const metric = metricParam === "visits" || metricParam === "pageviews" ? metricParam : "visitors";
      const analytics = siteAnalytics(env.DB, site, range.since, range.until);
      const goalsList = env.DB.prepare("SELECT id, name, event_name, path FROM goals WHERE site_id = ? ORDER BY id").bind(site.id).all().results;
      analytics.goalsList = goalsList;
      const sites = listSitesForUser(env.DB, session);
      return new Response(sitePage(session, site, sites, analytics, range, days, metric, url.origin),
        { headers: { "content-type": "text/html;charset=utf-8" } });
    }

    if (path === "/api/sites" && method === "GET") {
      return json(listSitesForUser(env.DB, session));
    }

    if (path === "/api/sites" && method === "POST") {
      if (!isAdmin) return json({ error: "forbidden" }, 403);
      if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
      let name = "";
      let domain = "";
      if (wantsJson) {
        const parsed = parseJson(body);
        if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
        const input = parsed.value;
        name = String(input.name || "").trim().slice(0, 80);
        domain = cleanDomain(input.domain);
      } else {
        const form = new URLSearchParams(body);
        name = String(form.get("name") || "").trim().slice(0, 80);
        domain = cleanDomain(form.get("domain"));
      }
      if (!name || !validDomain(domain)) {
        if (wantsJson) return json({ error: !name ? "name is required" : "domain is invalid" }, 400);
        return redirect("/sites/new?error=" + (!name ? "name-required" : "domain-invalid"));
      }
      const exists = env.DB.prepare("SELECT id FROM sites WHERE domain = ?").bind(domain).first();
      if (exists) {
        if (wantsJson) return json({ error: "domain already registered" }, 409);
        return redirect("/sites/new?error=domain-registered");
      }
      const publicKey = randomHex(16);
      const res = env.DB.prepare("INSERT INTO sites (name, domain, public_key, created_at) VALUES (?, ?, ?, ?)")
        .bind(name, domain, publicKey, Math.floor(Date.now() / 1000))
        .run();
      siteByKey.set(publicKey, { id: Number(res.meta.last_row_id), domain });
      if (wantsJson) return json({ id: res.meta.last_row_id, name, domain, publicKey }, 201);
      return redirect("/sites/" + res.meta.last_row_id);
    }

    // Goals per site (writes are admin-only; reads follow site access).
    const goalsMatch = /^\/api\/sites\/(\d+)\/goals$/.exec(path);
    if (goalsMatch) {
      const site = getSiteForUser(env.DB, Number(goalsMatch[1]), session);
      if (!site) return json({ error: "unknown site" }, 404);
      if (method === "GET") {
        return json(env.DB.prepare("SELECT id, name, event_name, path, created_at FROM goals WHERE site_id = ? ORDER BY id").bind(site.id).all().results);
      }
      if (method === "POST") {
        if (!isAdmin) return json({ error: "forbidden" }, 403);
        if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
        let name = "";
        let eventName = "";
        let goalPath = "";
        if (wantsJson) {
          const parsed = parseJson(body);
          if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
          const input = parsed.value;
          name = String(input.name || "").trim().slice(0, 80);
          eventName = String(input.eventName || input.event_name || "").trim().slice(0, 64);
          goalPath = String(input.path || "").trim().slice(0, 2048);
        } else {
          const form = new URLSearchParams(body);
          name = String(form.get("name") || "").trim().slice(0, 80);
          eventName = String(form.get("event_name") || "").trim().slice(0, 64);
          goalPath = String(form.get("path") || "").trim().slice(0, 2048);
        }
        if (!name) return json({ error: "name is required" }, 400);
        if (!validEventName(eventName)) return json({ error: "event name is invalid" }, 400);
        if (goalPath !== "" && goalPath.charAt(0) !== "/") return json({ error: "path must start with /" }, 400);
        try {
          env.DB.prepare("INSERT INTO goals (site_id, name, event_name, path, created_at) VALUES (?, ?, ?, ?, ?)")
            .bind(site.id, name, eventName, goalPath, Math.floor(Date.now() / 1000))
            .run();
        } catch {
          return json({ error: "goal name already exists for this site" }, 409);
        }
        if (wantsJson) return json({ ok: true, name, eventName, path: goalPath }, 201);
        return redirect("/sites/" + site.id);
      }
    }

    // Stats: D1-backed summary with 30-minute visit boundary, configured
    // conversion goals, and an explicit or period-based range. Per-day rows
    // carry their own distinct counts; multi-day totals are visitor-days
    // only in the per-day breakdown, never summed.
    const statsMatch = /^\/api\/sites\/(\d+)\/stats$/.exec(path);
    if (statsMatch && method === "GET") {
      const site = getSiteForUser(env.DB, Number(statsMatch[1]), session);
      if (!site) return json({ error: "unknown site" }, 404);
      const now = Math.floor(Date.now() / 1000);
      const range = parseRange(url.searchParams, now);
      if (range.error) return json({ error: range.error }, 400);
      const analytics = siteAnalytics(env.DB, site, range.since, range.until);
      return json({ site: { id: site.id, name: site.name, domain: site.domain }, range: range.label, ...analytics });
    }

    // Bounded report with exact-match filters, sortable and paginated, as
    // JSON or CSV download. Generated synchronously; no job queue exists.
    const reportMatch = /^\/api\/sites\/(\d+)\/report$/.exec(path);
    if (reportMatch && method === "GET") {
      const site = getSiteForUser(env.DB, Number(reportMatch[1]), session);
      if (!site) return json({ error: "unknown site" }, 404);
      const now = Math.floor(Date.now() / 1000);
      const range = parseRange(url.searchParams, now);
      if (range.error) return json({ error: range.error }, 400);
      const q = url.searchParams;
      const filters = {};
      const pathFilter = String(q.get("path") || "").slice(0, 2048);
      const sourceFilter = String(q.get("source") || "").slice(0, 128);
      const mediumFilter = String(q.get("medium") || "").slice(0, 128);
      const campaignFilter = String(q.get("campaign") || "").slice(0, 128);
      const eventFilter = String(q.get("event") || "").slice(0, 64);
      if (pathFilter !== "") filters.path = pathFilter;
      if (sourceFilter !== "") filters.source = sourceFilter;
      if (mediumFilter !== "") filters.medium = mediumFilter;
      if (campaignFilter !== "") filters.campaign = campaignFilter;
      if (eventFilter !== "") filters.event = eventFilter;
      const report = siteReport(
        env.DB, site.id, range.since, range.until,
        String(q.get("dimension") || "path"), filters,
        q.get("limit"), q.get("offset"), String(q.get("sort") || "visitors"),
      );
      if (String(q.get("format") || "") === "csv") {
        return new Response(reportCsv(report), {
          headers: {
            "content-type": "text/csv;charset=utf-8",
            "content-disposition": 'attachment; filename="site-' + site.id + "-" + report.dimension + '.csv"',
          },
        });
      }
      return json({ site: { id: site.id, name: site.name, domain: site.domain }, range: range.label, ...report });
    }

    // Embedded static assets for signed-in pages. The assets directory is
    // the URL root; unknown API routes stay JSON.
    if (apiRoute) return json({ error: "not found", path }, 404);
    if (method === "GET") return env.ASSETS.fetch(request);

    return json({ error: "not found", path }, 404);
  },
};

function destroySession(db, request) {
  const cookies = readCookies(request.headers.get("cookie"));
  const token = cookies["__Host-risulta_session"] || cookies["risulta_session"] || "";
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(sha256Hex(token)).run();
}

function createUser(db, email, password, role, siteIds, displayName) {
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

function changePassword(db, session, passwordHash) {
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
