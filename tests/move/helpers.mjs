// Shared fixtures for the move tests: a D1-shaped adapter over bun:sqlite (the
// Workers contract: async calls, batch() is one transaction, BEGIN refused),
// a shared database (site registry, users) and one event store per org.
import { Database } from "bun:sqlite";
import { ROLLUP_SCHEMA, STATS_ROLLUP_SCHEMA } from "../../src/rollups.ts";
import { ANNOTATION_SCHEMA } from "../../src/annotations.js";
import { memoryBlobs } from "../../src/move/blobs.js";

export function d1(sqlite) {
  const refused = /^\s*(begin|commit|end|rollback|savepoint|release)\b/i;
  function statement(sql, args) {
    return {
      bind(...values) { return statement(sql, values); },
      async first() { return sqlite.query(sql).get(...args) || null; },
      async all() { return { success: true, results: sqlite.query(sql).all(...args), meta: {} }; },
      async run() {
        const result = sqlite.query(sql).run(...args);
        return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
      __sql: sql,
    };
  }
  const db = {
    sqlite,
    prepare(sql) {
      if (refused.test(sql)) throw new Error("D1_ERROR: transaction statements are not allowed, use batch()");
      return statement(sql, []);
    },
    async batch(statements) {
      db.batches = (db.batches || 0) + 1;
      if (db.beforeBatch) await db.beforeBatch(statements);
      const results = [];
      sqlite.exec("BEGIN");
      try {
        for (const s of statements) results.push(await s.run());
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
      // After the commit: a failure here is a lost acknowledgement, the rows stay.
      if (db.afterBatch) await db.afterBatch(statements);
      return results;
    },
    async exec(sql) {
      for (const line of String(sql).split("\n").filter((l) => l.trim())) {
        if (refused.test(line)) throw new Error("D1_EXEC_ERROR: transaction statements are not allowed");
      }
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
  };
  return db;
}

const SHARED_DDL =
  "CREATE TABLE sites (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, domain TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, slug TEXT UNIQUE, org_id INTEGER NOT NULL DEFAULT 1);" +
  "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);" +
  "CREATE TABLE site_users (user_id INTEGER NOT NULL, site_id INTEGER NOT NULL, role TEXT NOT NULL, PRIMARY KEY (user_id, site_id));" +
  "CREATE TABLE public_widgets (site_id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);";

const STORE_DDL =
  "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER NOT NULL, ts INTEGER NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, referrer TEXT NOT NULL DEFAULT '', visitor TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', medium TEXT NOT NULL DEFAULT '', campaign TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', term TEXT NOT NULL DEFAULT '', value REAL);" +
  "CREATE TABLE goals (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER NOT NULL, name TEXT NOT NULL, event_name TEXT NOT NULL, path TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, UNIQUE (site_id, name));" +
  "CREATE TABLE funnels (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);" +
  "CREATE TABLE funnel_steps (funnel_id INTEGER NOT NULL, position INTEGER NOT NULL, goal_id INTEGER NOT NULL, PRIMARY KEY (funnel_id, position));" +
  "CREATE TABLE site_salts (site_id INTEGER NOT NULL, day TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (site_id, day));" +
  "CREATE INDEX idx_events_site_ts ON events(site_id, ts);" +
  ANNOTATION_SCHEMA.replace(" REFERENCES sites(id) ON DELETE CASCADE", "") + ROLLUP_SCHEMA + STATS_ROLLUP_SCHEMA;

export function makeShared() {
  const sqlite = new Database(":memory:");
  sqlite.exec(SHARED_DDL);
  return d1(sqlite);
}
export function makeStoreDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(STORE_DDL);
  return d1(sqlite);
}

// A world: one shared database and one store per org. ctx(orgId-less) is what
// the move modules take.
export function makeWorld(orgIds = [1]) {
  const shared = makeShared();
  const stores = {};
  for (const id of orgIds) stores[id] = makeStoreDb();
  const ctx = { shared, store: (orgId) => { if (!stores[orgId]) throw new Error("no store for org " + orgId); return stores[orgId]; }, blobs: memoryBlobs(), now: () => 1800000000 };
  return { shared, stores, ctx };
}

// Small deterministic generator, so a failing seed can be replayed.
export function prng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

export async function addSite(world, orgId, { name, domain, key, widget = 0 }) {
  const slug = domain.split(".")[0];
  await world.shared.prepare("INSERT INTO sites (name, domain, public_key, created_at, slug, org_id) VALUES (?, ?, ?, ?, ?, ?)").bind(name, domain, key, 1700000000, slug, orgId).run();
  const row = await world.shared.prepare("SELECT id FROM sites WHERE public_key = ?").bind(key).first();
  if (widget) await world.shared.prepare("INSERT INTO public_widgets (site_id, enabled) VALUES (?, 1)").bind(row.id).run();
  return Number(row.id);
}

export async function addEvents(world, orgId, siteId, n, { seed = 1, start = 1799000000, days = 5, visitors = 40, canary = "" } = {}) {
  const rnd = prng(seed + siteId);
  const store = world.stores[orgId];
  const names = ["pageview", "pageview", "pageview", "signup", "outbound"];
  const list = [];
  for (let i = 0; i < n; i++) {
    const name = names[Math.floor(rnd() * names.length)];
    const ts = start + Math.floor(rnd() * days * 86400);
    const visitor = "a1" + Math.floor(rnd() * visitors).toString(16).padStart(6, "0");
    list.push(store.prepare("INSERT INTO events (site_id, ts, name, path, referrer, visitor, source, medium, campaign, content, term, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(siteId, ts, name, "/p/" + Math.floor(rnd() * 20) + canary, rnd() < 0.3 ? "news.example" : "", visitor, rnd() < 0.2 ? "x" : "", "", "", "", "", name === "signup" ? Math.floor(rnd() * 100) : null));
    if (list.length >= 500) { await store.batch(list.splice(0)); }
  }
  if (list.length) await store.batch(list);
}

export async function addMeta(world, orgId, siteId) {
  const store = world.stores[orgId];
  await store.batch([
    store.prepare("INSERT INTO goals (site_id, name, event_name, path, created_at) VALUES (?, 'Signups', 'signup', '', 1700000100)").bind(siteId),
    store.prepare("INSERT INTO goals (site_id, name, event_name, path, created_at) VALUES (?, 'Pricing', 'pageview', '/pricing', 1700000200)").bind(siteId),
    store.prepare("INSERT INTO funnels (site_id, name, created_at) VALUES (?, 'Buy', 1700000300)").bind(siteId),
    store.prepare("INSERT INTO funnel_steps (funnel_id, position, goal_id) VALUES ((SELECT max(id) FROM funnels WHERE site_id = ?), 0, (SELECT id FROM goals WHERE site_id = ? AND name = 'Pricing'))").bind(siteId, siteId),
    store.prepare("INSERT INTO funnel_steps (funnel_id, position, goal_id) VALUES ((SELECT max(id) FROM funnels WHERE site_id = ?), 1, (SELECT id FROM goals WHERE site_id = ? AND name = 'Signups'))").bind(siteId, siteId),
    store.prepare("INSERT INTO annotations (site_id, ts, text) VALUES (?, 1799100000, 'Launched é 🚀')").bind(siteId),
    store.prepare("INSERT INTO site_salts (site_id, day, value) VALUES (?, '2027-01-15', ?)").bind(siteId, "ab".repeat(16)),
  ]);
}

export async function collect(gen) {
  const parts = [];
  for await (const part of gen) parts.push(part);
  return parts;
}

export async function count(db, sql, ...args) {
  return Number((await db.prepare(sql).bind(...args).first()).n);
}

// A stable digest of every row an org owns, ids and all, to prove an action did not touch it.
export async function orgDigest(world, orgId) {
  const store = world.stores[orgId];
  const parts = [];
  for (const table of ["events", "goals", "funnels", "funnel_steps", "annotations", "site_salts"]) {
    parts.push(table + JSON.stringify((await store.prepare("SELECT * FROM " + table + " ORDER BY rowid").all()).results));
  }
  parts.push("sites" + JSON.stringify((await world.shared.prepare("SELECT * FROM sites WHERE org_id = ? ORDER BY id").bind(orgId).all()).results));
  return Bun.hash(parts.join("|")).toString(16);
}
