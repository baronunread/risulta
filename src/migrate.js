// Instance-to-instance move: the target side of tools/migrate.mjs, plus the
// export routes that serve a rollback. Off unless RISULTA_IMPORT_TOKEN is set
// (32 characters or more); with it unset every route here answers 404, so a
// self-hosted instance exposes nothing new.
//
// Writes go through the data layer: sites into shared(env), everything else
// into store(env, orgId), so a move lands in whichever store backs the org.
// Ids are never trusted: the target issues its own, and the ledger
// (import_sites) maps a source site to its new one and remembers the last
// source event id applied, which makes every chunk idempotent and resumable.
//
// Never moved: users, sessions, password hashes, read-API keys (re-created by
// hand). Tracker keys are preserved, and an existing key is a conflict, never
// an overwrite.
import { shared, store, orgOfSite, listOrgs, DEFAULT_ORG } from "./data.js";
import { runRollups } from "./maintenance.js";
import { availableSiteSlug } from "./sites.ts";
import { bytesToHex } from "./auth.js";
import { cleanDomain, validDomain, validEventName } from "./domain.js";
import { optionalEnv, utf8Bytes } from "./util.js";

const MAX_BODY = 1500000;
const MAX_CHUNK = 2000;
const DAY = 86400;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const LINEAGE = /^[a-z0-9._-]{1,64}$/;
const SITE_FIELDS = ["src_id", "name", "domain", "public_key", "slug", "created_at", "widget", "goals", "funnels", "annotations", "salts"];

let ledgerReady = false;
async function ensureLedger(events) {
  if (ledgerReady) return;
  await events.prepare("CREATE TABLE IF NOT EXISTS import_sites (lineage TEXT NOT NULL, source_site_id INTEGER NOT NULL, public_key TEXT NOT NULL, site_id INTEGER NOT NULL DEFAULT 0, last_event_id INTEGER NOT NULL DEFAULT 0, imported INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (lineage, source_site_id))").run();
  ledgerReady = true;
}

async function sha256Hex(text) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(utf8Bytes(text)))));
}

function same(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length && i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function bodyText(request) {
  const b = request.body;
  if (b && !(b instanceof ReadableStream)) return String(b);
  return await request.text();
}

function isInt(value) {
  return Number.isInteger(value) && value >= 0 && value <= 9007199254740991;
}
function isText(value, max) {
  return String(value) === value && value.length <= max;
}

function checkSite(site) {
  if (!site || Object(site) !== site) return "site must be an object";
  for (const field of Object.keys(site)) if (!SITE_FIELDS.includes(field)) return "unknown site field: " + field;
  if (!isInt(site.src_id)) return "src_id";
  if (!isText(site.name, 120) || !site.name) return "name";
  if (!validDomain(cleanDomain(site.domain))) return "domain";
  if (!KEY.test(String(site.public_key))) return "public_key";
  if (!isInt(site.created_at)) return "created_at";
  for (const goal of site.goals || []) {
    if (!isText(goal.name, 120) || !goal.name || !validEventName(String(goal.event_name)) || !isText(goal.path || "", 2048) || !isInt(goal.created_at || 0)) return "goal";
  }
  for (const funnel of site.funnels || []) {
    if (!isText(funnel.name, 120) || !funnel.name || !isInt(funnel.created_at || 0) || !Array.isArray(funnel.steps) || funnel.steps.length > 20) return "funnel";
    for (const step of funnel.steps) if (!isText(step, 120)) return "funnel step";
  }
  for (const note of site.annotations || []) if (!isInt(note.ts) || !isText(note.text, 240) || !note.text) return "annotation";
  for (const salt of site.salts || []) if (!isText(salt.day, 10) || !isText(salt.value, 128)) return "salt";
  if ((site.goals || []).length > 500 || (site.funnels || []).length > 200 || (site.annotations || []).length > 1000) return "too many rows";
  return "";
}

// The org-store half of one site: goals, funnels (steps by goal name), notes and
// the day's salt, plus the ledger update that marks the site as created.
function contentStatements(events, lineage, site, siteId) {
  const out = [];
  for (const goal of site.goals || []) {
    out.push(events.prepare("INSERT OR IGNORE INTO goals (site_id, name, event_name, path, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(siteId, goal.name, goal.event_name, goal.path || "", goal.created_at || site.created_at));
  }
  for (const funnel of site.funnels || []) {
    out.push(events.prepare("INSERT INTO funnels (site_id, name, created_at) VALUES (?, ?, ?)").bind(siteId, funnel.name, funnel.created_at || site.created_at));
    funnel.steps.forEach((goalName, position) => {
      out.push(events.prepare("INSERT INTO funnel_steps (funnel_id, position, goal_id) SELECT (SELECT max(id) FROM funnels WHERE site_id = ? AND name = ?), ?, id FROM goals WHERE site_id = ? AND name = ?")
        .bind(siteId, funnel.name, position, siteId, goalName));
    });
  }
  for (const note of site.annotations || []) out.push(events.prepare("INSERT INTO annotations (site_id, ts, text) VALUES (?, ?, ?)").bind(siteId, note.ts, note.text));
  for (const salt of site.salts || []) out.push(events.prepare("INSERT OR IGNORE INTO site_salts (site_id, day, value) VALUES (?, ?, ?)").bind(siteId, salt.day, salt.value));
  out.push(events.prepare("UPDATE import_sites SET site_id = ? WHERE lineage = ? AND source_site_id = ?").bind(siteId, lineage, site.src_id));
  return out;
}

async function begin(c, json) {
  let input;
  try { input = JSON.parse(await bodyText(c.req.raw)); } catch { return json({ error: "body must be JSON" }, 400); }
  const lineage = String((input && input.lineage) || "");
  if (!LINEAGE.test(lineage) || !Array.isArray(input.sites) || input.sites.length < 1 || input.sites.length > 50) return json({ error: "lineage and sites are required" }, 400);
  for (const site of input.sites) {
    const problem = checkSite(site);
    if (problem) return json({ error: "invalid site: " + problem }, 400);
  }
  const db = shared(c.env);
  const events = store(c.env, DEFAULT_ORG);
  await ensureLedger(events);
  const created = [];
  const resumed = [];
  for (const site of input.sites) {
    const domain = cleanDomain(site.domain);
    const inserted = await events.prepare("INSERT OR IGNORE INTO import_sites (lineage, source_site_id, public_key) VALUES (?, ?, ?)").bind(lineage, site.src_id, site.public_key).run();
    const fresh = Number(inserted.meta.changes) === 1;
    let row = await events.prepare("SELECT site_id, public_key FROM import_sites WHERE lineage = ? AND source_site_id = ?").bind(lineage, site.src_id).first();
    if (row.public_key !== site.public_key) return json({ error: "source site " + site.src_id + " was imported with a different key" }, 409);
    if (Number(row.site_id) > 0) { resumed.push({ src_id: site.src_id, site_id: Number(row.site_id) }); continue; }
    let existing = await db.prepare("SELECT id FROM sites WHERE public_key = ?").bind(site.public_key).first();
    const taken = await db.prepare("SELECT id FROM sites WHERE domain = ?").bind(domain).first();
    if (fresh && (existing || (taken && (!existing || taken.id !== existing.id)))) {
      await events.prepare("DELETE FROM import_sites WHERE lineage = ? AND source_site_id = ?").bind(lineage, site.src_id).run();
      return json({ error: existing ? "tracker key already in use" : "domain already in use", src_id: site.src_id, domain }, 409);
    }
    if (!existing) {
      const slug = site.slug && /^[a-z0-9-]{1,40}$/.test(site.slug) && !/^[0-9]+$/.test(site.slug) && !(await db.prepare("SELECT id FROM sites WHERE slug = ?").bind(site.slug).first())
        ? site.slug : await availableSiteSlug(db, domain);
      const statements = [db.prepare("INSERT INTO sites (name, domain, public_key, slug, created_at) VALUES (?, ?, ?, ?, ?)").bind(site.name, domain, site.public_key, slug, site.created_at)];
      if (site.widget) statements.push(db.prepare("INSERT OR IGNORE INTO public_widgets (site_id, enabled) VALUES ((SELECT id FROM sites WHERE public_key = ?), 1)").bind(site.public_key));
      await db.batch(statements);
      existing = await db.prepare("SELECT id FROM sites WHERE public_key = ?").bind(site.public_key).first();
    }
    await events.batch(contentStatements(events, lineage, site, Number(existing.id)));
    created.push({ src_id: site.src_id, site_id: Number(existing.id) });
  }
  return json({ ok: true, lineage, created, resumed });
}

async function applyChunk(c, json) {
  const text = await bodyText(c.req.raw);
  if (text.length > MAX_BODY) return json({ error: "chunk too large" }, 413);
  const claimed = String(c.req.header("x-chunk-sha256") || "");
  if (!same(claimed, await sha256Hex(text))) return json({ error: "checksum mismatch" }, 400);
  const lines = text.split("\n").filter((line) => line);
  let head;
  try { head = JSON.parse(lines[0]); } catch { return json({ error: "bad header" }, 400); }
  const rows = [];
  try { for (let i = 1; i < lines.length; i++) rows.push(JSON.parse(lines[i])); } catch { return json({ error: "bad row" }, 400); }
  if (!head || !LINEAGE.test(String(head.lineage)) || !isInt(head.source_site_id) || !isInt(head.after) || !isInt(head.last) || head.count !== rows.length || rows.length < 1 || rows.length > MAX_CHUNK) return json({ error: "bad header" }, 400);
  const now = Math.floor(Date.now() / 1000);
  let previous = head.after;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 12 || !isInt(row[0]) || row[0] <= previous || !isInt(row[1]) || row[1] > now + DAY ||
        !validEventName(String(row[2])) || !isText(row[3], 2048) || row[3].charAt(0) !== "/" || !isText(row[4], 256) || !isText(row[5], 64) ||
        !isText(row[6], 256) || !isText(row[7], 256) || !isText(row[8], 256) || !isText(row[9], 256) || !isText(row[10], 256) ||
        !(row[11] === null || (Number(row[11]) === row[11] && Number.isFinite(row[11])))) return json({ error: "invalid event row", id: Array.isArray(row) ? row[0] : null }, 400);
    previous = row[0];
  }
  if (previous !== head.last) return json({ error: "last id does not match the rows" }, 400);
  const events = store(c.env, DEFAULT_ORG);
  await ensureLedger(events);
  const ledger = await events.prepare("SELECT site_id, last_event_id FROM import_sites WHERE lineage = ? AND source_site_id = ?").bind(head.lineage, head.source_site_id).first();
  if (!ledger || Number(ledger.site_id) < 1) return json({ error: "site not created, call /api/migrate/sites first" }, 409);
  const applied = Number(ledger.last_event_id);
  if (applied >= head.last) return json({ ok: true, duplicate: true, last_event_id: applied });
  if (applied !== head.after) return json({ error: "out of order", expected_after: applied }, 409);
  // One batch is one transaction: the rows and the ledger move together, and a
  // chunk replayed after a lost response inserts nothing (the guard sees the new id).
  const guard = "EXISTS (SELECT 1 FROM import_sites WHERE lineage = ? AND source_site_id = ? AND last_event_id = ?)";
  const results = await events.batch([
    events.prepare("INSERT INTO events (site_id, ts, name, path, referrer, visitor, source, medium, campaign, content, term, value) " +
      "SELECT ?, json_extract(j.value,'$[1]'), json_extract(j.value,'$[2]'), json_extract(j.value,'$[3]'), json_extract(j.value,'$[4]'), json_extract(j.value,'$[5]'), " +
      "json_extract(j.value,'$[6]'), json_extract(j.value,'$[7]'), json_extract(j.value,'$[8]'), json_extract(j.value,'$[9]'), json_extract(j.value,'$[10]'), json_extract(j.value,'$[11]') " +
      "FROM json_each(?) j WHERE " + guard)
      .bind(Number(ledger.site_id), JSON.stringify(rows), head.lineage, head.source_site_id, head.after),
    events.prepare("UPDATE import_sites SET last_event_id = ?, imported = imported + ? WHERE lineage = ? AND source_site_id = ? AND last_event_id = ?")
      .bind(head.last, rows.length, head.lineage, head.source_site_id, head.after),
  ]);
  return json({ ok: true, imported: Number(results[0].meta.changes), last_event_id: head.last });
}

// Counts and per-day totals to compare with the source, plus the rollup state.
async function verify(c, json) {
  const lineage = String(c.req.query("lineage") || "");
  const until = Number(c.req.query("until_ts") || 0) || Math.floor(Date.now() / 1000) + DAY;
  if (!LINEAGE.test(lineage)) return json({ error: "lineage is required" }, 400);
  const events = store(c.env, DEFAULT_ORG);
  await ensureLedger(events);
  const today = Math.floor(Date.now() / 1000 / DAY) * DAY;
  const ledger = (await events.prepare("SELECT source_site_id, public_key, site_id, last_event_id, imported FROM import_sites WHERE lineage = ? ORDER BY source_site_id").bind(lineage).all()).results;
  const sites = [];
  for (const row of ledger) {
    const siteId = Number(row.site_id);
    const days = (await events.prepare("SELECT date(ts,'unixepoch') AS day, count(*) AS events, sum(name='pageview') AS pageviews, count(DISTINCT visitor) AS visitors FROM events WHERE site_id = ? AND ts < ? GROUP BY day ORDER BY day").bind(siteId, until).all()).results;
    const built = (await events.prepare("SELECT date(day,'unixepoch') AS day, sum(pageviews) AS pageviews FROM analytics_rollup_visitors WHERE site_id = ? GROUP BY day").bind(siteId).all()).results;
    const covered = new Set((await events.prepare("SELECT date(day,'unixepoch') AS day FROM analytics_rollup_stats_days WHERE site_id = ?").bind(siteId).all()).results.map((r) => r.day));
    const dirty = new Set((await events.prepare("SELECT date(day,'unixepoch') AS day FROM analytics_rollup_dirty WHERE site_id = ? AND day < ?").bind(siteId, today).all()).results.map((r) => r.day));
    const rawPageviews = new Map(days.map((d) => [d.day, Number(d.pageviews)]));
    const mismatched = built.filter((r) => rawPageviews.has(r.day) && Number(r.pageviews) !== rawPageviews.get(r.day)).map((r) => r.day);
    const todayLabel = new Date(today * 1000).toISOString().slice(0, 10);
    const pending = days.filter((d) => d.day < todayLabel && (!covered.has(d.day) || dirty.has(d.day))).length;
    sites.push({
      source_site_id: Number(row.source_site_id), public_key: row.public_key, site_id: siteId,
      ledger: { imported: Number(row.imported), last_event_id: Number(row.last_event_id) },
      events: { total: days.reduce((n, d) => n + Number(d.events), 0), days: days.map((d) => ({ day: d.day, events: Number(d.events), pageviews: Number(d.pageviews), visitors: Number(d.visitors) })) },
      rollups: { pending_days: pending, mismatched_days: mismatched },
    });
  }
  return json({ lineage, until_ts: until, sites });
}

// Build rollups for the imported days, a bounded number per call.
async function finalize(c, json) {
  const budget = 1500;
  const started = Date.now();
  let built = 0;
  for (const orgId of await listOrgs(shared(c.env))) {
    built += await runRollups(shared(c.env), store(c.env, orgId), Math.floor(Date.now() / 1000), 40, () => Date.now() - started > budget);
  }
  return json({ ok: true, built });
}

// Export for the reverse direction and for leaving: the same shapes the target
// accepts. Events come in pages after a source id.
async function exportSites(c, json) {
  const db = shared(c.env);
  const out = [];
  for (const site of (await db.prepare("SELECT id, name, domain, public_key, slug, created_at FROM sites ORDER BY id").all()).results) {
    const events = store(c.env, orgOfSite(site));
    const widget = await db.prepare("SELECT enabled FROM public_widgets WHERE site_id = ?").bind(site.id).first();
    const goals = (await events.prepare("SELECT id, name, event_name, path, created_at FROM goals WHERE site_id = ? ORDER BY id").bind(site.id).all()).results;
    const names = new Map(goals.map((g) => [Number(g.id), g.name]));
    const funnels = [];
    for (const f of (await events.prepare("SELECT id, name, created_at FROM funnels WHERE site_id = ? ORDER BY id").bind(site.id).all()).results) {
      const steps = (await events.prepare("SELECT goal_id FROM funnel_steps WHERE funnel_id = ? ORDER BY position").bind(f.id).all()).results;
      funnels.push({ name: f.name, created_at: Number(f.created_at), steps: steps.map((s) => names.get(Number(s.goal_id))) });
    }
    const annotations = (await events.prepare("SELECT ts, text FROM annotations WHERE site_id = ? ORDER BY id").bind(site.id).all()).results;
    const salts = (await events.prepare("SELECT day, value FROM site_salts WHERE site_id = ?").bind(site.id).all()).results;
    const range = await events.prepare("SELECT count(*) AS n, coalesce(max(id),0) AS max_id FROM events WHERE site_id = ?").bind(site.id).first();
    out.push({
      src_id: Number(site.id), name: site.name, domain: site.domain, public_key: site.public_key, slug: site.slug, created_at: Number(site.created_at),
      widget: widget && Number(widget.enabled) === 1 ? 1 : 0,
      goals: goals.map((g) => ({ name: g.name, event_name: g.event_name, path: g.path, created_at: Number(g.created_at) })),
      funnels, annotations: annotations.map((a) => ({ ts: Number(a.ts), text: a.text })), salts,
      events: { count: Number(range.n), max_id: Number(range.max_id) },
    });
  }
  return json({ format: "risulta-move", version: 1, sites: out });
}

async function exportEvents(c, json) {
  const key = String(c.req.query("site") || "");
  const after = Number(c.req.query("after") || 0);
  // Rollback copies what the target collected since the flip: by time, because
  // the delta import gives older events newer ids.
  const sinceTs = Number(c.req.query("since_ts") || 0);
  const limit = Math.min(MAX_CHUNK, Math.max(1, Number(c.req.query("limit") || 1000)));
  if (!KEY.test(key) || !isInt(after)) return json({ error: "site and after are required" }, 400);
  const site = await shared(c.env).prepare("SELECT id FROM sites WHERE public_key = ?").bind(key).first();
  if (!site) return json({ error: "unknown site" }, 404);
  const rows = (await store(c.env, DEFAULT_ORG).prepare("SELECT id, ts, name, path, referrer, visitor, source, medium, campaign, content, term, value FROM events WHERE site_id = ? AND id > ? AND ts >= ? ORDER BY id LIMIT ?").bind(site.id, after, sinceTs, limit).all()).results;
  const lines = rows.map((r) => JSON.stringify([Number(r.id), Number(r.ts), r.name, r.path, r.referrer, r.visitor, r.source, r.medium, r.campaign, r.content, r.term, r.value === null ? null : Number(r.value)]));
  const last = rows.length ? Number(rows[rows.length - 1].id) : after;
  const body = JSON.stringify({ after, last, count: rows.length }) + "\n" + lines.join("\n") + (lines.length ? "\n" : "");
  return new Response(body, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-chunk-sha256": await sha256Hex(body) } });
}

export function registerMigrateRoutes(app, json) {
  app.use("/api/migrate/*", async (c, next) => {
    const token = optionalEnv(c.env, "RISULTA_IMPORT_TOKEN");
    if (token.length < 32) return json({ error: "not found", path: new URL(c.req.url).pathname }, 404);
    const given = String(c.req.header("authorization") || "").replace(/^Bearer /, "");
    if (!same(await sha256Hex(given), await sha256Hex(token))) return json({ error: "unauthorized" }, 401);
    await next();
  });
  app.post("/api/migrate/sites", async (c) => await begin(c, json));
  app.post("/api/migrate/events", async (c) => await applyChunk(c, json));
  app.post("/api/migrate/finalize", async (c) => await finalize(c, json));
  app.get("/api/migrate/verify", async (c) => await verify(c, json));
  app.get("/api/migrate/export/sites", async (c) => await exportSites(c, json));
  app.get("/api/migrate/export/events", async (c) => await exportEvents(c, json));
}
