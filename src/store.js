import { READ_KEYS_SCHEMA } from "./read-api.js";
// D1 repository: schema, site scoping, visitor identities, analytics.
// Single logical D1 instead of one SQLite file per site: every site-owned
// row carries site_id and every query scopes on it. Hot-path caches mirror
// the Bun app's per-process stores; public keys are immutable so the
// miss-fill site cache is exactly coherent.
import { bytesToHex, hashPassword, normalizeEmail, randomHex } from "./auth.js";
import { dayStringFromMs, unicodeText, utf8Bytes } from "./util.js";

// Daily salts cached per process like the Bun app's SiteStore: the day
// changes rarely, so the hot path skips three salt queries per event.
const saltCache = new Map();
// Public keys are immutable and sites are only added through this handler,
// so a miss-fill cache is exactly coherent and the collector skips its
// lookup after the first event per key.
const siteByKey = new Map();
export { siteByKey };

// Public keys are immutable and sites are only added through this handler,
// so a miss-fill cache is exactly coherent for hits. Misses are NEVER
// cached: a cached null would stick a transient lookup failure (or a key
// checked before its site exists) permanently. Unknown keys cost one
// indexed SELECT per request instead.
export function siteForKey(db, publicKey) {
  const hit = siteByKey.get(publicKey);
  if (hit !== undefined) return hit;
  const site = db.prepare("SELECT id, domain FROM sites WHERE public_key = ?").bind(publicKey).first() || null;
  if (site) siteByKey.set(publicKey, site);
  return site;
}

// Schema and bootstrap run once per process (like the Bun app migrating at
// startup), not per request. Memoized as a promise because hashing the first
// administrator is async.
let schemaReady = null;

export function optionalSecret(name) {
  try {
    return env[name] || "";
  } catch {
    return "";
  }
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
  db.exec(READ_KEYS_SCHEMA);
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_site_ts ON events(site_id, ts);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_site_ts_visitor ON events(site_id, ts, visitor);");
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

// Client IP for visitor hashing. Only source is the runtime-resolved
// request.cf.clientIp: the connection's remote address, or the rightmost
// untrusted X-Forwarded-For hop when the peer matches SB_TRUSTED_PROXIES
// (the server owns the header name, so direct exposure cannot be forged).
// Without any signal (older runtimes) this yields "" and weaker
// uniqueness. Never stored.
export function clientIp(request) {
  try {
    const cf = request.cf;
    if (cf && cf.clientIp) return String(cf.clientIp).slice(0, 45);
  } catch {
    /* ignore */
  }
  return "";
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
// round-trip) over the true UTF-8 bytes, matching the Bun app's visitor
// hashes for the same inputs; async only, so callers await it.
export async function visitorId(db, site, request) {
  const salt = siteSalt(db, site.id, dayString());
  const ua = (request.headers.get("user-agent") || "").slice(0, 512);
  const input = new Uint8Array(utf8Bytes(salt + "" + clientIp(request) + "" + ua));
  const digest = await crypto.subtle.digest("SHA-256", input);
  return bytesToHex(new Uint8Array(digest)).slice(0, 24);
}

export function siteSummary(db, siteId, since, until) {
  return db.prepare(
    "WITH pageviews AS (SELECT ts, visitor FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview'), " +
      "scoped AS (SELECT ts, visitor, date(ts, 'unixepoch') AS day FROM events " +
      "WHERE site_id = ? AND visitor != '' AND ts >= ? - 1800 AND ts < ?), " +
      "marked AS (SELECT ts, visitor, day, lag(ts) OVER (PARTITION BY visitor, day ORDER BY ts) AS prev FROM scoped) " +
      "SELECT (SELECT count(*) FROM pageviews) AS pageviews, " +
      "(SELECT count(DISTINCT visitor) FROM pageviews) AS visitors, " +
      "(SELECT count(*) FROM marked WHERE ts >= ? AND ts < ? AND (prev IS NULL OR ts - prev > 1800)) AS visits",
  ).bind(siteId, since, until, siteId, since, until, since, until).first();
}

// One session scan supplies the summary and both chart resolutions.
function sessionPeriods(db, siteId, since, until) {
  return db.prepare(
    "WITH scoped AS (SELECT ts, visitor, date(ts, 'unixepoch') AS day FROM events " +
      "WHERE site_id = ? AND visitor != '' AND ts >= ? - 1800 AND ts < ?), " +
      "marked AS (SELECT ts, visitor, day, lag(ts) OVER (PARTITION BY visitor, day ORDER BY ts) AS prev FROM scoped) " +
      "SELECT day, cast(strftime('%H', ts, 'unixepoch') AS INTEGER) AS hour, count(*) AS visits FROM marked " +
      "WHERE ts >= ? AND ts < ? AND (prev IS NULL OR ts - prev > 1800) GROUP BY day, hour ORDER BY day, hour",
  ).bind(siteId, since, until, since, until).all().results;
}

export function homeOverviews(db, user, now) {
  const sites = listSitesForUser(db, user);
  const since = (Math.floor(now / 86400) - 6) * 86400;
  // Join through authorized sites before aggregating, including for viewers.
  const scope = user.role === "admin" ? "" : " JOIN site_users ON site_users.site_id = sites.id AND site_users.user_id = ?";
  const query = db.prepare(
    "SELECT events.site_id, date(events.ts, 'unixepoch') AS day, count(*) AS pageviews, count(DISTINCT events.visitor) AS visitors " +
      "FROM sites" + scope + " JOIN events ON events.site_id = sites.id " +
      "WHERE events.ts >= ? AND events.ts < ? AND events.name = 'pageview' GROUP BY events.site_id, day ORDER BY events.site_id, day",
  );
  const rows = (user.role === "admin" ? query.bind(since, now + 1) : query.bind(user.user_id, since, now + 1)).all().results;
  const daysBySite = {};
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!daysBySite[row.site_id]) daysBySite[row.site_id] = {};
    daysBySite[row.site_id][row.day] = row;
  }
  const result = [];
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    const overview = { visitors: 0, pageviews: 0, byDay: [] };
    for (let day = 0; day < 7; day++) {
      const label = dayStringFromMs((since + day * 86400) * 1000);
      const row = (daysBySite[site.id] || {})[label];
      const visitors = row ? Number(row.visitors) : 0;
      const pageviews = row ? Number(row.pageviews) : 0;
      overview.byDay.push({ day: label, visitors, pageviews });
      overview.visitors += visitors;
      overview.pageviews += pageviews;
    }
    result.push({ id: site.id, name: site.name, domain: site.domain, overview });
  }
  return result;
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

// Overview filters select daily visitor identities with a matching pageview.
// All their events remain available so source/page filters can explain goals.
export function overviewScope(db, siteId, since, until, filters) {
  const clauses = [];
  const values = [];
  const columns = [["path", "path"], ["source", "coalesce(nullif(source,''),'Direct / None')"],
    ["medium", "coalesce(nullif(medium,''),'None')"], ["campaign", "coalesce(nullif(campaign,''),'None')"]];
  for (let i = 0; i < columns.length; i++) {
    const value = filters && filters[columns[i][0]];
    if (value) { clauses.push("visitor IN (SELECT visitor FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview' AND " + columns[i][1] + " = ?)"); values.push(siteId, since, until, value); }
  }
  if (!clauses.length) return db;
  const prefix = "WITH overview_events AS (SELECT * FROM events WHERE site_id = ? AND ts >= ? - 1800 AND ts < ? AND " + clauses.join(" AND ") + ") ";
  // Only event reads are scoped. Configuration and access checks use the original DB.
  return { prepare(sql) {
    if (sql.indexOf("FROM events") === -1) return db.prepare(sql);
    const scoped = sql.replace(/FROM events/g, "FROM overview_events");
    const query = db.prepare(prefix + (scoped.indexOf("WITH ") === 0 ? ", " + scoped.slice(5) : scoped));
    return { bind(...args) { return query.bind(siteId, since, until, ...values, ...args); } };
  } };
}

// One aggregate query previews five goals, including configured goals with no hits.
export function overviewGoals(db, siteId, since, until, visitors) {
  const rows = db.prepare("WITH preview AS (SELECT * FROM goals WHERE site_id = ? ORDER BY id LIMIT 5), " +
    "eligible AS MATERIALIZED (SELECT DISTINCT visitor FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview'), " +
    "hits AS MATERIALIZED (SELECT id, name, path, visitor FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name IN (SELECT event_name FROM preview)) " +
    "SELECT g.name, count(e.id) AS conversions, count(DISTINCT CASE WHEN e.visitor IN (SELECT visitor FROM eligible) THEN e.visitor END) AS unique_conversions " +
    "FROM preview g LEFT JOIN hits e ON e.name = g.event_name AND (g.path = '' OR e.path = g.path) GROUP BY g.id ORDER BY g.id")
    .bind(siteId, siteId, since, until, siteId, since, until).all().results;
  return rows.map((row) => ({ ...row, conversion_rate: visitors ? Number(row.unique_conversions) / visitors : 0 }));
}

export function siteAnalytics(db, site, since, until, includeConversions, previewGoals) {
  const summary = db.prepare(
    "SELECT count(*) AS pageviews, count(DISTINCT visitor) AS visitors FROM events " +
      "WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview'",
  ).bind(site.id, since, until).first();
  summary.visits = 0;
  const sessions = sessionPeriods(db, site.id, since, until);
  const byDay = db.prepare(
    "SELECT date(ts, 'unixepoch') AS day, count(*) AS pageviews, count(DISTINCT visitor) AS visitors FROM events " +
      "WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview' GROUP BY day ORDER BY day",
  ).bind(site.id, since, until).all().results;
  const byHour = db.prepare(
    "SELECT cast(strftime('%H', ts, 'unixepoch') AS INTEGER) AS hour, count(*) AS pageviews, count(DISTINCT visitor) AS visitors FROM events " +
      "WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview' GROUP BY hour ORDER BY hour",
  ).bind(site.id, since, until).all().results;
  const days = {};
  const hours = {};
  for (let i = 0; i < byDay.length; i++) { byDay[i].visits = 0; days[byDay[i].day] = byDay[i]; }
  for (let i = 0; i < byHour.length; i++) { byHour[i].visits = 0; hours[byHour[i].hour] = byHour[i]; }
  for (let i = 0; i < sessions.length; i++) {
    const row = sessions[i];
    const visits = Number(row.visits);
    if (!days[row.day]) { days[row.day] = { day: row.day, pageviews: 0, visitors: 0, visits: 0 }; byDay.push(days[row.day]); }
    if (!hours[row.hour]) { hours[row.hour] = { hour: Number(row.hour), pageviews: 0, visitors: 0, visits: 0 }; byHour.push(hours[row.hour]); }
    days[row.day].visits += visits;
    hours[row.hour].visits += visits;
    summary.visits += visits;
  }
  byDay.sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
  byHour.sort((a, b) => a.hour - b.hour);
  const visitors = Number(summary.visitors);
  const funnelResult = includeConversions === false ? { funnels: [], truncated: false } : siteFunnels(db, site.id, since, until);
  return {
    summary,
    current: siteCurrent(db, site.id),
    byDay,
    byHour,
    paths: topList(db, site.id, since, until, "path"),
    referrers: topList(db, site.id, since, until, "coalesce(nullif(source,''),'Direct / None')"),
    mediums: topList(db, site.id, since, until, "coalesce(nullif(medium,''),'None')"),
    campaigns: topList(db, site.id, since, until, "coalesce(nullif(campaign,''),'None')"),
    goals: includeConversions === false ? (previewGoals === false ? [] : overviewGoals(db, site.id, since, until, visitors)) : siteGoals(db, site.id, since, until, visitors),
    hasConversions: includeConversions === false ? Number(db.prepare(
      "SELECT (SELECT count(*) FROM goals WHERE site_id = ?) + (SELECT count(*) FROM funnels WHERE site_id = ?) AS n",
    ).bind(site.id, site.id).first().n) > 0 : false,
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
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(Number(limit)) || 50));
  const boundedOffset = Math.max(0, Math.min(10000, Math.floor(Number(offset)) || 0));
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
  // The current standalone transport encodes text as UTF-8. Pre-encoding
  // here would encode non-English labels twice.
  return unicodeText(lines.join("\n") + "\n");
}
