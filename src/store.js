// D1 repository: schema, site scoping, visitor identities, analytics.
// Single logical D1 instead of one SQLite file per site: every site-owned
// row carries site_id and every query scopes on it. Hot-path caches mirror
// the Bun app's per-process stores; public keys are immutable so the
// miss-fill site cache is exactly coherent.
import { bytesToHex, hashPassword, normalizeEmail, randomHex } from "./auth.js";
import { dayStringFromMs } from "./util.js";

// Daily salts cached per process like the Bun app's SiteStore: the day
// changes rarely, so the hot path skips three salt queries per event.
const saltCache = new Map();
// Public keys are immutable and sites are only added through this handler,
// so a miss-fill cache is exactly coherent and the collector skips its
// lookup after the first event per key.
const siteByKey = new Map();
export { siteByKey };

export function siteForKey(db, publicKey) {
  let site = siteByKey.get(publicKey);
  if (site === undefined) {
    site = db.prepare("SELECT id, domain FROM sites WHERE public_key = ?").bind(publicKey).first() || null;
    siteByKey.set(publicKey, site);
  }
  return site;
}

// Schema and bootstrap run once per process (like the Bun app migrating at
// startup), not per request. Memoized as a promise because hashing the first
// administrator is async. Trust config is process env, also read once.
let schemaReady = null;
let trustProxyCached = null;

export function optionalSecret(name) {
  try {
    return env[name] || "";
  } catch {
    return "";
  }
}

export function trustProxyEnabled() {
  if (trustProxyCached === null) trustProxyCached = optionalSecret("RISULTA_TRUST_PROXY") === "1";
  return trustProxyCached;
}

export function ensureReady(db) {
  if (!schemaReady) schemaReady = ensureSchema(db);
  return schemaReady;
}

async function ensureSchema(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS sites (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, domain TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER NOT NULL, ts INTEGER NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, referrer TEXT NOT NULL DEFAULT '', visitor TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', medium TEXT NOT NULL DEFAULT '', campaign TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', term TEXT NOT NULL DEFAULT '', value REAL);" +
      "CREATE TABLE IF NOT EXISTS goals (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER NOT NULL, name TEXT NOT NULL, event_name TEXT NOT NULL, path TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, UNIQUE (site_id, name));" +
      "CREATE TABLE IF NOT EXISTS funnels (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS funnel_steps (funnel_id INTEGER NOT NULL REFERENCES funnels(id) ON DELETE CASCADE, position INTEGER NOT NULL, goal_id INTEGER NOT NULL REFERENCES goals(id), PRIMARY KEY (funnel_id, position));" +
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
        .bind(email, await hashPassword(password), displayName || email.split("@")[0], Math.floor(Date.now() / 1000))
        .run();
    }
  }
}

export function listSitesForUser(db, user) {
  if (user.role === "admin") return db.prepare("SELECT * FROM sites ORDER BY name COLLATE NOCASE").all().results;
  return db.prepare(
    "SELECT sites.* FROM sites JOIN site_users ON site_users.site_id = sites.id WHERE site_users.user_id = ? ORDER BY sites.name COLLATE NOCASE",
  ).bind(user.user_id).all().results;
}

export function updateProfile(db, userId, displayName, email) {
  db.prepare("UPDATE users SET display_name = ?, email = ? WHERE id = ?").bind(displayName, email, userId).run();
}

export function adminCount(db) {
  return Number(db.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin'").first().n);
}

// Full account removal with explicit child cleanup (deterministic whether
// or not the connection enforces foreign keys).
export function removeUser(db, userId) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
    db.prepare("DELETE FROM site_users WHERE user_id = ?").bind(userId).run();
    db.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
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

export function getSiteForUser(db, siteId, user) {
  if (user.role === "admin") return db.prepare("SELECT * FROM sites WHERE id = ?").bind(siteId).first() || null;
  return db.prepare(
    "SELECT sites.* FROM sites JOIN site_users ON site_users.site_id = sites.id WHERE sites.id = ? AND site_users.user_id = ?",
  ).bind(siteId, user.user_id).first() || null;
}

// Client IP for visitor hashing. Primary source is the runtime-resolved
// request.cf.clientIp: the connection's remote address, or the rightmost
// untrusted X-Forwarded-For hop when the peer matches SB_TRUSTED_PROXIES
// (the server owns the header name, so direct exposure cannot be forged).
// Falls back to the legacy RISULTA_TRUST_PROXY=1 XFF behavior only when the
// runtime provides no clientIp (older runtimes, defense in depth).
// Direct exposure without any signal yields "" and weaker uniqueness.
// Never stored.
export function clientIp(request) {
  try {
    const cf = request.cf;
    if (cf && cf.clientIp) return String(cf.clientIp).slice(0, 45);
  } catch {
    /* fall through to the legacy behavior */
  }
  if (!trustProxyEnabled()) return "";
  try {
    const forwarded = request.headers.get("x-forwarded-for") || "";
    return forwarded.split(",")[0].trim().slice(0, 45);
  } catch {
    return "";
  }
}

export function dayString() {
  return dayStringFromMs(Date.now());
}

export function siteSalt(db, siteId, day) {
  const hit = saltCache.get(siteId);
  if (hit && hit.day === day) return hit.value;
  db.prepare("DELETE FROM site_salts WHERE day != ?").bind(day).run();
  db.prepare("INSERT OR IGNORE INTO site_salts (site_id, day, value) VALUES (?, ?, ?)").bind(siteId, day, randomHex(32)).run();
  const value = db.prepare("SELECT value FROM site_salts WHERE site_id = ? AND day = ?").bind(siteId, day).first().value;
  if (saltCache.size > 64) saltCache.clear();
  saltCache.set(siteId, { day, value });
  return value;
}

// A site-local identity that resets daily: neither input is stored. The
// hash runs through the runtime's crypto.subtle (inline C, no host
// round-trip); async only, so callers await it.
export async function visitorId(db, site, request) {
  const salt = siteSalt(db, site.id, dayString());
  const ua = (request.headers.get("user-agent") || "").slice(0, 512);
  const digest = await crypto.subtle.digest("SHA-256", salt + "" + clientIp(request) + "" + ua);
  return bytesToHex(new Uint8Array(digest)).slice(0, 24);
}

export function siteSummary(db, siteId, since, until) {
  return db.prepare(
    "WITH scoped AS (SELECT ts, visitor, lag(ts) OVER (PARTITION BY visitor ORDER BY ts) AS prev FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview') " +
      "SELECT count(*) AS pageviews, count(DISTINCT visitor) AS visitors, " +
      "coalesce(sum(CASE WHEN prev IS NULL OR ts - prev > 1800 THEN 1 ELSE 0 END), 0) AS visits FROM scoped",
  ).bind(siteId, since, until).first();
}

export function siteCurrent(db, siteId) {
  return Number(db.prepare(
    "SELECT count(DISTINCT visitor) AS n FROM events WHERE site_id = ? AND ts >= ? AND name = 'pageview'",
  ).bind(siteId, Math.floor(Date.now() / 1000) - 300).first().n);
}

export function topList(db, siteId, since, until, select) {
  return db.prepare(
    "SELECT " + select + " AS label, count(*) AS pageviews, count(DISTINCT visitor) AS visitors FROM events " +
      "WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview' GROUP BY label ORDER BY visitors DESC, pageviews DESC LIMIT 8",
  ).bind(siteId, since, until).all().results;
}

export function siteGoals(db, siteId, since, until, visitors) {
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

export function listFunnels(db, siteId) {
  const funnels = db.prepare("SELECT id, name FROM funnels WHERE site_id = ? ORDER BY id").bind(siteId).all().results;
  const out = [];
  for (let i = 0; i < funnels.length; i++) {
    const steps = db.prepare(
      "SELECT goals.id, goals.name, goals.event_name, goals.path FROM funnel_steps " +
        "JOIN goals ON goals.id = funnel_steps.goal_id WHERE funnel_steps.funnel_id = ? ORDER BY funnel_steps.position",
    ).bind(funnels[i].id).all().results;
    out.push({ id: funnels[i].id, name: funnels[i].name, steps });
  }
  return out;
}

export function createFunnel(db, siteId, name, goalIds) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare("INSERT INTO funnels (site_id, name, created_at) VALUES (?, ?, ?)")
      .bind(siteId, name, Math.floor(Date.now() / 1000))
      .run();
    const funnelId = Number(result.meta.last_row_id);
    const assign = db.prepare("INSERT INTO funnel_steps (funnel_id, position, goal_id) VALUES (?, ?, ?)");
    for (let i = 0; i < goalIds.length; i++) assign.bind(funnelId, i, goalIds[i]).run();
    db.exec("COMMIT");
    return funnelId;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw error;
  }
}

// Funnel conversions, computed in JS over one ordered event scan like the
// Bun app. Bounded: at most FUNNEL_EVENT_LIMIT rows are scanned, and the
// result says when the cap bit so funnels on huge ranges read as the
// approximation they are.
export const FUNNEL_EVENT_LIMIT = 50000;

export function siteFunnels(db, siteId, since, until) {
  const funnels = listFunnels(db, siteId);
  if (!funnels.length) return { funnels: [], truncated: false };
  const events = db.prepare(
    "SELECT visitor, ts, name, path FROM events WHERE site_id = ? AND ts >= ? AND ts < ? ORDER BY visitor, ts LIMIT ?",
  ).bind(siteId, since, until, FUNNEL_EVENT_LIMIT).all().results;
  const truncated = events.length >= FUNNEL_EVENT_LIMIT;
  const out = [];
  for (let i = 0; i < funnels.length; i++) {
    const funnel = funnels[i];
    // Plain objects stand in for Sets (visitor identity per step); the
    // runtime subset is safer without Set.
    const completed = [];
    for (let s = 0; s < funnel.steps.length; s++) completed.push({});
    const positions = {};
    for (let e = 0; e < events.length; e++) {
      const event = events[e];
      const position = positions[event.visitor] || 0;
      const step = funnel.steps[position];
      if (!step || event.name !== step.event_name || (step.path && event.path !== step.path)) continue;
      completed[position][event.visitor] = 1;
      positions[event.visitor] = position + 1;
    }
    const counts = [];
    for (let s = 0; s < completed.length; s++) counts.push(Object.keys(completed[s]).length);
    out.push({
      id: funnel.id,
      name: funnel.name,
      steps: funnel.steps.map((step, index) => ({
        name: step.name,
        conversions: counts[index],
        drop_off: index ? counts[index - 1] - counts[index] : 0,
      })),
    });
  }
  return { funnels: out, truncated };
}

export function siteAnalytics(db, site, since, until) {
  const summary = siteSummary(db, site.id, since, until);
  const visitors = Number(summary.visitors);
  const funnelResult = siteFunnels(db, site.id, since, until);
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
    funnels: funnelResult.funnels,
    funnelsTruncated: funnelResult.truncated,
  };
}

// Bounded report query mirroring the Bun app's report semantics: exact-match
// filters, pageviews-only dimensions except event, sortable, paginated.
export function siteReport(db, siteId, since, until, dimension, filters, limit, offset, sort) {
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

export function csvEscape(value) {
  const s = String(value === null || value === undefined ? "" : value);
  if (s.indexOf('"') !== -1 || s.indexOf(",") !== -1 || s.indexOf("\n") !== -1) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function reportCsv(report) {
  const lines = ["label,pageviews,visitors,value"];
  for (let i = 0; i < report.rows.length; i++) {
    const r = report.rows[i];
    lines.push(csvEscape(r.label) + "," + r.pageviews + "," + r.visitors + "," + csvEscape(r.value));
  }
  return lines.join("\n") + "\n";
}
