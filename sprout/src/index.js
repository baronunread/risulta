// Risulta Sprout (single standalone binary, no platform).
//
// One app sprout, one D1 database, static assets embedded in the binary, no
// service bindings (standalone builds reject them: there is no edge). The
// existing Bun Risulta app is untouched; this is a smaller sibling that
// reuses its domain rules where the sprout runtime allows.
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
//   hash covers the User-Agent alone and uniqueness degrades; this is
//   reported honestly on the dashboard.
// - No cron, queues or background workers exist standalone. Reports
//   generate synchronously on request; there are no scheduled summaries.

import { sha256Hex } from "./sha256.js";

const SESSION_SECONDS = 7 * 24 * 60 * 60;
// 20k iterations measured ~0.5s per login in the Porffor build: enough to
// blunt online guessing alongside rate limits, not memory-hard like scrypt.
// The count is encoded in each row, so it can rise later compatibly.
const KDF_ITERATIONS = 20000;
const failures = new Map();

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
  // 302, not 303: the runtime cannot serialize a 303 status (connection
  // reset; probed 2026-09-10: 302/307 pass, every 303 shape fails).
  return new Response("", { status: 302, headers: { location: to } });
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
  if (optionalSecret("RISULTA_TRUST_PROXY") !== "1") return "";
  const forwarded = request.headers.get("x-forwarded-for") || "";
  return forwarded.split(",")[0].trim().slice(0, 45);
}

function dayString() {
  return new Date().toISOString().slice(0, 10);
}

function siteSalt(db, siteId, day) {
  db.prepare("DELETE FROM site_salts WHERE day != ?").bind(day).run();
  db.prepare("INSERT OR IGNORE INTO site_salts (site_id, day, value) VALUES (?, ?, ?)").bind(siteId, day, randomHex(32)).run();
  return db.prepare("SELECT value FROM site_salts WHERE site_id = ? AND day = ?").bind(siteId, day).first().value;
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
    return { since, until: Math.min(toDay + 86400, now + 1), label: fromRaw + ".." + toRaw };
  }
  const period = searchParams.get("period") || "7";
  const days = period === "1" ? 1 : period === "30" ? 30 : 7;
  return { since: now - days * 86400, until: now + 1, label: days + "d" };
}

function siteSummary(db, siteId, since, until) {
  return db.prepare(
    "WITH scoped AS (SELECT ts, visitor, lag(ts) OVER (PARTITION BY visitor ORDER BY ts) AS prev FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview') " +
      "SELECT count(*) AS pageviews, count(DISTINCT visitor) AS visitors, " +
      "coalesce(sum(CASE WHEN prev IS NULL OR ts - prev > 1800 THEN 1 ELSE 0 END), 0) AS visits FROM scoped",
  ).bind(siteId, since, until).first();
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

function pageShell(title, user, body) {
  const nav = user
    ? "<nav><a href=\"/\">Sites</a> <a href=\"/account\">Account</a>" +
      (user.role === "admin" ? " <a href=\"/users\">Users</a>" : "") +
      " <span>" + escapeHtml(user.display_name || user.email) + " (" + user.role + ")</span>" +
      " <form style=\"display:inline\" method=\"post\" action=\"/logout\"><input type=\"hidden\" name=\"csrf\" value=\"" + user.csrf + "\"> <button>Sign out</button></form></nav>"
    : "<nav><a href=\"/login\">Sign in</a></nav>";
  return (
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<link rel=\"stylesheet\" href=\"/style.css\">" +
    "<title>" + escapeHtml(title) + "</title></head><body>" + nav + body +
    "<footer><p>Risulta Sprout: single binary, no platform. Visitor identities are daily salted hashes; raw IPs are never stored.</p></footer></body></html>"
  );
}

function loginPage(error) {
  return pageShell(
    "Sign in - Risulta Sprout",
    null,
    "<main><h1>Sign in</h1>" +
      (error ? "<p role=\"alert\">" + escapeHtml(error) + "</p>" : "") +
      "<form method=\"post\" action=\"/login\"><label>Email <input name=\"email\" type=\"email\" required autocomplete=\"username\"></label> " +
      "<label>Password <input name=\"password\" type=\"password\" required autocomplete=\"current-password\"></label> " +
      "<button>Sign in</button></form></main>",
  );
}

function homePage(user, sites, origin) {
  const rows = sites
    .map((s) => "<li><a href=\"/sites/" + s.id + "\"><strong>" + escapeHtml(s.name) + "</strong></a> (" + escapeHtml(s.domain) + ")</li>")
    .join("");
  const addForm = user.role === "admin"
    ? "<h2>Add a website</h2>" +
      "<form class=\"inline\" method=\"post\" action=\"/api/sites\"><input type=\"hidden\" name=\"csrf\" value=\"" + user.csrf + "\">" +
      "<input name=\"name\" placeholder=\"Example shop\" required> " +
      "<input name=\"domain\" placeholder=\"example.com\" required> <button>Add</button></form>"
    : "";
  return pageShell(
    "Risulta Sprout",
    user,
    "<header><h1>Risulta Sprout</h1><p>Origin for snippets: " + escapeHtml(origin) + "</p></header><main>" +
      addForm + "<h2>Websites</h2><ul>" + (rows || "<li>none yet</li>") + "</ul></main>",
  );
}

function sitePage(user, site, goals, origin) {
  const goalRows = goals
    .map((g) => "<li>" + escapeHtml(g.name) + " (" + escapeHtml(g.event_name) + (g.path ? ", " + escapeHtml(g.path) : "") + ")</li>")
    .join("");
  const goalForm = user.role === "admin"
    ? "<form class=\"inline\" method=\"post\" action=\"/api/sites/" + site.id + "/goals\">" +
      "<input type=\"hidden\" name=\"csrf\" value=\"" + user.csrf + "\">" +
      "<input name=\"name\" placeholder=\"Signup\" required> " +
      "<input name=\"event_name\" placeholder=\"signup\" required> " +
      "<input name=\"path\" placeholder=\"/pricing (optional)\"> <button>Add goal</button></form>"
    : "";
  const snippet = '<script src="' + origin + "/js/" + site.public_key + '.js"></script>';
  return pageShell(
    site.name + " - Risulta Sprout",
    user,
    "<header><h1>" + escapeHtml(site.name) + "</h1><p>" + escapeHtml(site.domain) + "</p></header><main>" +
      "<h2>Tracker snippet</h2><code class=\"snippet\">" + escapeHtml(snippet) + "</code>" +
      "<h2>Live traffic</h2><p class=\"status\" id=\"poll-status\" data-state=\"live\">Starting.</p>" +
      "<p><a data-period href=\"/api/sites/" + site.id + "/stats?period=1\">1 day</a> " +
      "<a data-period href=\"/api/sites/" + site.id + "/stats?period=7\">7 days</a> " +
      "<a data-period href=\"/api/sites/" + site.id + "/stats?period=30\">30 days</a></p>" +
      "<div id=\"live-stats\" data-stats-url=\"/api/sites/" + site.id + "/stats?period=7\"><p>Loading.</p></div>" +
      "<h2>Goals</h2><ul>" + (goalRows || "<li>none yet</li>") + "</ul>" + goalForm +
      "<h2>Reports</h2><ul>" +
      "<li><a href=\"/api/sites/" + site.id + "/report?dimension=path\">Pages (JSON)</a> / " +
      "<a href=\"/api/sites/" + site.id + "/report?dimension=path&format=csv\">CSV</a></li>" +
      "<li><a href=\"/api/sites/" + site.id + "/report?dimension=source\">Sources (JSON)</a> / " +
      "<a href=\"/api/sites/" + site.id + "/report?dimension=source&format=csv\">CSV</a></li>" +
      "<li><a href=\"/api/sites/" + site.id + "/report?dimension=event\">Events (JSON)</a> / " +
      "<a href=\"/api/sites/" + site.id + "/report?dimension=event&format=csv\">CSV</a></li>" +
      "</ul></main>" +
      "<script src=\"/dashboard.js\"></script>",
  );
}

function usersPage(admin, users, sites) {
  const rows = users
    .map((u) => "<li>" + escapeHtml(u.email) + " (" + u.role + (u.sites ? ", " + escapeHtml(u.sites) : "") + ") " +
      (u.id !== admin.user_id
        ? "<form style=\"display:inline\" method=\"post\" action=\"/api/users/" + u.id + "/delete\">" +
          "<input type=\"hidden\" name=\"csrf\" value=\"" + admin.csrf + "\"> <button>Delete</button></form>"
        : "(you)") + "</li>")
    .join("");
  const siteChecks = sites
    .map((s) => "<label><input type=\"checkbox\" name=\"site\" value=\"" + s.id + "\"> " + escapeHtml(s.name) + "</label>")
    .join(" ");
  return pageShell(
    "Users - Risulta Sprout",
    admin,
    "<main><h1>Users</h1><ul>" + (rows || "<li>none</li>") + "</ul>" +
      "<h2>Add user</h2><form method=\"post\" action=\"/api/users\">" +
      "<input type=\"hidden\" name=\"csrf\" value=\"" + admin.csrf + "\">" +
      "<label>Email <input name=\"email\" type=\"email\" required></label> " +
      "<label>Name <input name=\"display_name\"></label> " +
      "<label>Password (12+ chars) <input name=\"password\" type=\"password\" required></label> " +
      "<label>Role <select name=\"role\"><option value=\"viewer\">viewer</option><option value=\"admin\">admin</option></select></label>" +
      "<fieldset><legend>Viewer sites</legend>" + (siteChecks || "no sites yet") + "</fieldset> " +
      "<button>Add</button></form></main>",
  );
}

function accountPage(user, changed) {
  return pageShell(
    "Account - Risulta Sprout",
    user,
    "<main><h1>Account</h1><p>" + escapeHtml(user.email) + " (" + user.role + ")</p>" +
      (changed ? "<p role=\"status\">Password changed. Other sessions were signed out.</p>" : "") +
      "<h2>Change password</h2><form method=\"post\" action=\"/api/account/password\">" +
      "<input type=\"hidden\" name=\"csrf\" value=\"" + user.csrf + "\">" +
      "<label>Current password <input name=\"current\" type=\"password\" required autocomplete=\"current-password\"></label> " +
      "<label>New password (12+ chars) <input name=\"password\" type=\"password\" required autocomplete=\"new-password\"></label> " +
      "<button>Change</button></form></main>",
  );
}

export default {
  fetch(request) {
    ensureSchema(env.DB);
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
      const site = env.DB.prepare("SELECT id, domain FROM sites WHERE public_key = ?").bind(eventMatch[1]).first();
      if (!site) return json({ error: "unknown site" }, 404);
      let input = {};
      const parsed = parseJson(body);
      if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
      input = parsed.value;
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
        return new Response("", { status: 303, headers: { location: "/", "set-cookie": cookie } });
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
      return new Response("", { status: 303, headers: { location: "/login", "set-cookie": expired } });
    }

    if (path === "/api/session" && method === "GET") {
      return json({ id: session.user_id, email: session.email, displayName: session.display_name, role: session.role, csrf: session.csrf });
    }

    if (path === "/" && method === "GET") {
      const sites = listSitesForUser(env.DB, session);
      return new Response(homePage(session, sites, url.origin), { headers: { "content-type": "text/html;charset=utf-8" } });
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
      if (!isAdmin) return apiRoute ? json({ error: "forbidden" }, 403) : redirect("/");
      const users = env.DB.prepare(
        "SELECT users.id, users.email, users.display_name, users.role, users.created_at, group_concat(sites.name, ', ') AS sites " +
          "FROM users LEFT JOIN site_users ON site_users.user_id = users.id LEFT JOIN sites ON sites.id = site_users.site_id " +
          "GROUP BY users.id ORDER BY users.created_at, users.id",
      ).all().results;
      const sites = env.DB.prepare("SELECT id, name FROM sites ORDER BY name COLLATE NOCASE").all().results;
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
        siteIds = form.getAll("site").map(Number);
      }
      if (!email) return json({ error: "email is required" }, 400);
      if (password.length < 12) return json({ error: "password needs 12+ characters" }, 400);
      let userId = 0;
      try {
        userId = createUser(env.DB, email, password, role, siteIds, displayName);
      } catch {
        return json({ error: "email already registered" }, 409);
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
      if (!site) return new Response(pageShell("Not found", session, "<main><h1>Unknown site</h1></main>"), { status: 404, headers: { "content-type": "text/html;charset=utf-8" } });
      const goals = env.DB.prepare("SELECT id, name, event_name, path FROM goals WHERE site_id = ? ORDER BY id").bind(site.id).all().results;
      return new Response(sitePage(session, site, goals, url.origin), { headers: { "content-type": "text/html;charset=utf-8" } });
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
      if (!name) return json({ error: "name is required" }, 400);
      if (!validDomain(domain)) return json({ error: "domain is invalid" }, 400);
      const exists = env.DB.prepare("SELECT id FROM sites WHERE domain = ?").bind(domain).first();
      if (exists) return json({ error: "domain already registered" }, 409);
      const publicKey = randomHex(16);
      const res = env.DB.prepare("INSERT INTO sites (name, domain, public_key, created_at) VALUES (?, ?, ?, ?)")
        .bind(name, domain, publicKey, Math.floor(Date.now() / 1000))
        .run();
      if (wantsJson) return json({ id: res.meta.last_row_id, name, domain, publicKey }, 201);
      return redirect("/");
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
      const summary = siteSummary(env.DB, site.id, range.since, range.until);
      const byDay = env.DB.prepare(
        "WITH scoped AS (SELECT ts, visitor FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview') " +
          "SELECT date(ts, 'unixepoch') AS day, count(*) AS pageviews, count(DISTINCT visitor) AS visitors FROM scoped GROUP BY day ORDER BY day",
      ).bind(site.id, range.since, range.until).all().results;
      const paths = env.DB.prepare(
        "SELECT path AS label, count(*) AS pageviews, count(DISTINCT visitor) AS visitors FROM events " +
          "WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview' GROUP BY path ORDER BY visitors DESC, pageviews DESC LIMIT 8",
      ).bind(site.id, range.since, range.until).all().results;
      const sources = env.DB.prepare(
        "SELECT coalesce(nullif(source,''),'Direct / None') AS label, count(*) AS pageviews, count(DISTINCT visitor) AS visitors FROM events " +
          "WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview' GROUP BY label ORDER BY visitors DESC, pageviews DESC LIMIT 8",
      ).bind(site.id, range.since, range.until).all().results;
      const goals = siteGoals(env.DB, site.id, range.since, range.until, Number(summary.visitors));
      return json({ site: { id: site.id, name: site.name, domain: site.domain }, range: range.label, summary, byDay, paths, sources, goals });
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
