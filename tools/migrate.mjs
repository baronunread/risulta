#!/usr/bin/env bun
// Move a risulta instance to another one (self-hosted to Cloud, and back).
//
//   bun tools/migrate.mjs plan     --from snapshot.sqlite
//   bun tools/migrate.mjs copy     --from snapshot.sqlite --to https://target --lineage NAME
//   bun tools/migrate.mjs verify   --from snapshot.sqlite --to https://target --lineage NAME [--until-ts EPOCH]
//   bun tools/migrate.mjs finalize --to https://target --lineage NAME
//   bun tools/migrate.mjs reverse  --from-url https://target --to-sqlite stopped-instance.sqlite --since-ts FLIP_EPOCH
//
// The source is a SQLite snapshot (the file /api/backup or a scheduled backup
// writes, so it is consistent), read-only; the live instance is never touched.
// The target needs RISULTA_IMPORT_TOKEN set (see src/migrate.js); the same
// token goes in this process's RISULTA_IMPORT_TOKEN. It is never printed.
// `copy` is resumable and is also the delta pass: run it again on a newer
// snapshot and only events after the last applied source id are sent.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

const [command, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith("--")) opts[rest[i].slice(2)] = rest[i + 1] !== undefined && !rest[i + 1].startsWith("--") ? rest[++i] : "1";
const TOKEN = process.env.RISULTA_IMPORT_TOKEN || "";

function fail(message) {
  console.error("error: " + message);
  process.exit(1);
}
function need(name) {
  if (!opts[name]) fail("--" + name + " is required");
  return opts[name];
}
const sha = (text) => createHash("sha256").update(text).digest("hex");

function openSource(path) {
  const db = new Database(path, { readonly: true });
  const tables = new Set(db.query("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  return { db, has: (name) => tables.has(name) };
}

// Everything about the sites except their events, in the shape the target takes.
function readSites(source) {
  const { db, has } = source;
  const columns = new Set(db.query("PRAGMA table_info(sites)").all().map((c) => c.name));
  const today = new Date().toISOString().slice(0, 10);
  return db.query("SELECT * FROM sites ORDER BY id").all().map((site) => {
    const goals = has("goals") ? db.query("SELECT id, name, event_name, path, created_at FROM goals WHERE site_id = ? ORDER BY id").all(site.id) : [];
    const goalNames = new Map(goals.map((g) => [g.id, g.name]));
    const funnels = has("funnels") ? db.query("SELECT id, name, created_at FROM funnels WHERE site_id = ? ORDER BY id").all(site.id).map((f) => ({
      name: f.name, created_at: f.created_at,
      steps: db.query("SELECT goal_id FROM funnel_steps WHERE funnel_id = ? ORDER BY position").all(f.id).map((s) => goalNames.get(s.goal_id)),
    })) : [];
    const range = db.query("SELECT count(*) AS n, coalesce(max(id),0) AS max_id FROM events WHERE site_id = ?").get(site.id);
    const out = { src_id: site.id, name: site.name, domain: site.domain, public_key: site.public_key, created_at: site.created_at };
    if (columns.has("slug") && site.slug) out.slug = site.slug;
    return Object.assign(out, {
      widget: has("public_widgets") && db.query("SELECT enabled FROM public_widgets WHERE site_id = ?").get(site.id)?.enabled === 1 ? 1 : 0,
      goals: goals.map((g) => ({ name: g.name, event_name: g.event_name, path: g.path || "", created_at: g.created_at })),
      funnels,
      annotations: has("annotations") ? db.query("SELECT ts, text FROM annotations WHERE site_id = ? ORDER BY id").all(site.id) : [],
      salts: has("site_salts") ? db.query("SELECT day, value FROM site_salts WHERE site_id = ? AND day = ?").all(site.id, today) : [],
      _events: range,
    });
  });
}

async function call(base, path, init = {}, tries = 4) {
  if (!TOKEN) fail("RISULTA_IMPORT_TOKEN is not set");
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(base.replace(/\/$/, "") + path, { ...init, headers: Object.assign({ authorization: "Bearer " + TOKEN }, init.headers) });
      if (response.status >= 500 && attempt < tries) throw new Error("status " + response.status);
      return response;
    } catch (error) {
      if (attempt >= tries) fail("request to " + path + " failed: " + String(error.message || error).replaceAll(TOKEN, "***"));
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

async function json(response) {
  const text = await response.text();
  try { return { status: response.status, body: JSON.parse(text) }; } catch { return { status: response.status, body: { error: text.slice(0, 200) } }; }
}

async function targetLedger(base, lineage) {
  const { status, body } = await json(await call(base, "/api/migrate/verify?lineage=" + encodeURIComponent(lineage)));
  if (status === 404) fail("the target has no import routes: set RISULTA_IMPORT_TOKEN there (32+ characters)");
  if (status !== 200) fail("verify failed: " + JSON.stringify(body));
  return new Map(body.sites.map((s) => [s.source_site_id, s]));
}

async function plan() {
  const source = openSource(need("from"));
  for (const site of readSites(source)) {
    console.log(`${site.domain}  key ${site.public_key.slice(0, 6)}...  events ${site._events.n}  max id ${site._events.max_id}  goals ${site.goals.length}  funnels ${site.funnels.length}  notes ${site.annotations.length}  widget ${site.widget}`);
  }
  const first = source.db.query("SELECT min(ts) AS a, max(ts) AS b FROM events").get();
  if (first.a !== null) console.log(`events span ${new Date(first.a * 1000).toISOString().slice(0, 10)} to ${new Date(first.b * 1000).toISOString().slice(0, 10)}`);
}

async function copy() {
  const base = need("to");
  const lineage = need("lineage");
  const chunk = Math.min(2000, Number(opts.chunk || 1000));
  const source = openSource(need("from"));
  const sites = readSites(source);
  const sent = sites.map(({ _events, ...site }) => site);
  const begun = await json(await call(base, "/api/migrate/sites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lineage, sites: sent }) }));
  if (begun.status === 404) fail("the target has no import routes: set RISULTA_IMPORT_TOKEN there (32+ characters)");
  if (begun.status !== 200) fail("sites were refused: " + JSON.stringify(begun.body));
  console.log(`sites: ${begun.body.created.length} created, ${begun.body.resumed.length} already there`);
  const ledger = await targetLedger(base, lineage);
  const read = source.db.query("SELECT id, ts, name, path, referrer, visitor, source, medium, campaign, content, term, value FROM events WHERE site_id = ? AND id > ? ORDER BY id LIMIT ?");
  for (const site of sites) {
    let after = ledger.get(site.src_id)?.ledger.last_event_id || 0;
    let moved = 0;
    for (;;) {
      const rows = read.all(site.src_id, after, chunk);
      if (!rows.length) break;
      const last = rows[rows.length - 1].id;
      const lines = [JSON.stringify({ lineage, source_site_id: site.src_id, after, last, count: rows.length })];
      for (const r of rows) lines.push(JSON.stringify([r.id, r.ts, r.name, r.path, r.referrer, r.visitor, r.source, r.medium, r.campaign, r.content, r.term, r.value]));
      const body = lines.join("\n") + "\n";
      const result = await json(await call(base, "/api/migrate/events", { method: "POST", headers: { "content-type": "application/x-ndjson", "x-chunk-sha256": sha(body) }, body }));
      if (result.status === 409 && result.body.expected_after !== undefined) { after = result.body.expected_after; continue; }
      if (result.status !== 200) fail("chunk after id " + after + " refused: " + JSON.stringify(result.body));
      moved += rows.length;
      after = last;
    }
    console.log(`${site.domain}: ${moved} events sent, target at source id ${after} of ${site._events.max_id}`);
  }
}

async function verify() {
  const base = need("to");
  const lineage = need("lineage");
  const until = Number(opts["until-ts"] || 0);
  const source = openSource(need("from"));
  const sites = readSites(source);
  const url = "/api/migrate/verify?lineage=" + encodeURIComponent(lineage) + (until ? "&until_ts=" + until : "");
  const { status, body } = await json(await call(base, url));
  if (status !== 200) fail("verify failed: " + JSON.stringify(body));
  const target = new Map(body.sites.map((s) => [s.source_site_id, s]));
  let bad = 0;
  for (const site of sites) {
    const t = target.get(site.src_id);
    if (!t) { console.log(`MISSING ${site.domain}`); bad++; continue; }
    const days = source.db.query("SELECT date(ts,'unixepoch') AS day, count(*) AS events, sum(name='pageview') AS pageviews, count(DISTINCT visitor) AS visitors FROM events WHERE site_id = ? AND ts < ? GROUP BY day ORDER BY day").all(site.src_id, until || 9e15);
    const want = new Map(days.map((d) => [d.day, `${d.events}/${d.pageviews}/${d.visitors}`]));
    const got = new Map(t.events.days.map((d) => [d.day, `${d.events}/${d.pageviews}/${d.visitors}`]));
    const diffs = [...new Set([...want.keys(), ...got.keys()])].filter((day) => want.get(day) !== got.get(day));
    const total = days.reduce((n, d) => n + d.events, 0);
    const problems = [];
    if (total !== t.events.total) problems.push(`events ${total} source vs ${t.events.total} target`);
    if (diffs.length) problems.push(`${diffs.length} day(s) differ, first ${diffs[0]}: source ${want.get(diffs[0])} target ${got.get(diffs[0])} (events/pageviews/visitors)`);
    if (t.public_key !== site.public_key) problems.push("tracker key differs");
    if (!until && t.ledger.last_event_id !== site._events.max_id) problems.push(`target at source id ${t.ledger.last_event_id}, source max ${site._events.max_id}`);
    if (t.rollups.mismatched_days.length) problems.push(`rollups disagree with events on ${t.rollups.mismatched_days.length} day(s)`);
    const pending = t.rollups.pending_days;
    console.log(`${site.domain}: ${problems.length ? "FAIL" : "ok"}  events ${total}/${t.events.total}  days ${days.length}  rollups pending ${pending}${problems.length ? "\n  - " + problems.join("\n  - ") : ""}`);
    if (problems.length) bad++;
  }
  process.exit(bad ? 1 : 0);
}

async function finalize() {
  const base = need("to");
  const lineage = need("lineage");
  for (let round = 1; round <= 500; round++) {
    const built = await json(await call(base, "/api/migrate/finalize", { method: "POST" }));
    if (built.status !== 200) fail("finalize failed: " + JSON.stringify(built.body));
    const { body } = await json(await call(base, "/api/migrate/verify?lineage=" + encodeURIComponent(lineage)));
    const pending = body.sites.reduce((n, s) => n + s.rollups.pending_days, 0);
    console.log(`round ${round}: built ${built.body.built}, pending ${pending}`);
    if (pending === 0) return;
  }
  fail("rollups still pending after 500 rounds");
}

// Rollback after a flip: bring the events the target collected since the flip
// (`--since-ts`) back into a stopped old instance's SQLite file.
async function reverse() {
  const base = need("from-url");
  const file = need("to-sqlite");
  const sinceTs = Number(need("since-ts"));
  const db = new Database(file);
  const { status, body } = await json(await call(base, "/api/migrate/export/sites"));
  if (status !== 200) fail("export failed: " + JSON.stringify(body));
  const insert = db.query("INSERT INTO events (site_id, ts, name, path, referrer, visitor, source, medium, campaign, content, term, value) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  let total = 0;
  for (const site of body.sites) {
    const local = db.query("SELECT id FROM sites WHERE public_key = ?").get(site.public_key);
    if (!local) { console.log(`skip ${site.domain}: not in the old instance`); continue; }
    let cursor = 0;
    for (;;) {
      const response = await call(base, `/api/migrate/export/events?site=${site.public_key}&after=${cursor}&since_ts=${sinceTs}&limit=1000`);
      const text = await response.text();
      if (sha(text) !== response.headers.get("x-chunk-sha256")) fail("export checksum mismatch");
      const lines = text.split("\n").filter(Boolean);
      const head = JSON.parse(lines[0]);
      if (!head.count) break;
      db.transaction(() => { for (const line of lines.slice(1)) { const r = JSON.parse(line); insert.run(local.id, r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11]); } })();
      total += head.count;
      cursor = head.last;
    }
  }
  console.log(`${total} events copied into ${file}`);
}

const commands = { plan, copy, verify, finalize, reverse };
if (!commands[command]) fail("usage: migrate.mjs plan|copy|verify|finalize|reverse (see the header of this file)");
await commands[command]();
