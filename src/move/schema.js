// Tables the move feature adds. They are created lazily the first time a
// connect, export-with-ledger or import runs, never by a core migration, so a
// self-hosted instance that never uses the feature has none of them and its
// schema version does not change.
//
// Two databases, never joined: `shared` (the site registry and jobs) and the
// org's own event store. Nothing here references a table in the other one.
export const SHARED_SCHEMA = [
  // One row per site that is not simply local. A missing row means "local".
  "CREATE TABLE IF NOT EXISTS site_home (site_id INTEGER PRIMARY KEY, home TEXT NOT NULL CHECK (home IN ('importing','moving','gateway','frozen','moving-back')), lineage TEXT NOT NULL DEFAULT '', src_ref INTEGER NOT NULL DEFAULT 0, link_id TEXT NOT NULL DEFAULT '', job_id TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_site_home_lineage ON site_home(lineage, src_ref) WHERE lineage != ''",
  "CREATE TABLE IF NOT EXISTS move_jobs (id TEXT PRIMARY KEY, org_id INTEGER NOT NULL, kind TEXT NOT NULL, lineage TEXT NOT NULL, state TEXT NOT NULL, phase TEXT NOT NULL DEFAULT '', parts INTEGER NOT NULL DEFAULT 0, verified_parts INTEGER NOT NULL DEFAULT 0, verify_state TEXT NOT NULL DEFAULT '{}', options TEXT NOT NULL DEFAULT '{}', report TEXT NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT '', link_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
];

// Link and move tables (shared database). `cloud_link` and `connect_states` live on the
// self-hosted instance; `links` and `connect_codes` on the target (risulta.dev).
SHARED_SCHEMA.push(
  "CREATE TABLE IF NOT EXISTS cloud_link (id INTEGER PRIMARY KEY CHECK (id = 1), remote_origin TEXT NOT NULL, forward_origin TEXT NOT NULL DEFAULT '', link_id TEXT NOT NULL, secret TEXT NOT NULL, org_slug TEXT NOT NULL DEFAULT '', org_name TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'active', created_by INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS connect_states (state_hash TEXT PRIMARY KEY, verifier TEXT NOT NULL, session_hash TEXT NOT NULL, target TEXT NOT NULL, expires_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS links (link_id TEXT PRIMARY KEY, org_id INTEGER NOT NULL, instance_origin TEXT NOT NULL, secret TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked')), created_by INTEGER NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS connect_codes (code_hash TEXT PRIMARY KEY, org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, instance_origin TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER NOT NULL DEFAULT 0)",
  // The sites a link serves as a gateway for. Survives activation, so forwards keep resolving.
  "CREATE TABLE IF NOT EXISTS site_links (site_id INTEGER PRIMARY KEY, link_id TEXT NOT NULL, lineage TEXT NOT NULL, created_at INTEGER NOT NULL)",
  // The people a moved instance had, kept as invitations until the owner acts on them (no passwords, ever).
  "CREATE TABLE IF NOT EXISTS move_invitations (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, lineage TEXT NOT NULL, email TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL, sites TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, UNIQUE (org_id, email))",
  // A move of the whole instance, seen from the instance that drives it (source side).
  "CREATE TABLE IF NOT EXISTS move_blobs (key TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (key, seq)) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS moves (id TEXT PRIMARY KEY, org_id INTEGER NOT NULL, direction TEXT NOT NULL CHECK (direction IN ('out','back')), lineage TEXT NOT NULL, state TEXT NOT NULL, step TEXT NOT NULL DEFAULT '', after_id INTEGER NOT NULL DEFAULT 0, bulk_until INTEGER NOT NULL DEFAULT 0, sealed_id INTEGER NOT NULL DEFAULT 0, remote_move TEXT NOT NULL DEFAULT '', events_total INTEGER NOT NULL DEFAULT 0, events_sent INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', options TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
);

export const STORE_SCHEMA = [
  // One row per (lineage, source site): where the import is, and whether the
  // site's goals, funnels, notes and salts are in.
  "CREATE TABLE IF NOT EXISTS import_ledger (lineage TEXT NOT NULL, src_site INTEGER NOT NULL, site_id INTEGER NOT NULL, meta_done INTEGER NOT NULL DEFAULT 0, last_src_event_id INTEGER NOT NULL DEFAULT 0, imported INTEGER NOT NULL DEFAULT 0, created_job TEXT NOT NULL DEFAULT '', PRIMARY KEY (lineage, src_site))",
  // The contiguous run of target event ids one import step created. Ids that
  // fall in no range belong to events the site received natively (forwarded or
  // sent directly), which is how a reverse move finds exactly those.
  "CREATE TABLE IF NOT EXISTS import_ranges (job_id TEXT NOT NULL, lineage TEXT NOT NULL, site_id INTEGER NOT NULL, first_id INTEGER NOT NULL, last_id INTEGER NOT NULL, src_first INTEGER NOT NULL, src_last INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (job_id, site_id, src_last))",
  "CREATE INDEX IF NOT EXISTS idx_import_ranges_site ON import_ranges(lineage, site_id, first_id)",
  "CREATE TABLE IF NOT EXISTS import_map (lineage TEXT NOT NULL, kind TEXT NOT NULL, source_id INTEGER NOT NULL, new_id INTEGER NOT NULL, PRIMARY KEY (lineage, kind, source_id))",
  // Once a site is sealed no local event may be stored for it. The fence is
  // next to the events so the check and the insert are one statement.
  "CREATE TABLE IF NOT EXISTS site_fence (site_id INTEGER PRIMARY KEY, sealed_at INTEGER NOT NULL, sealed_max_id INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS gateway_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, fid TEXT NOT NULL UNIQUE, site_id INTEGER NOT NULL, created_at INTEGER NOT NULL, envelope TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS fwd_dedupe (fid TEXT PRIMARY KEY, day INTEGER NOT NULL) WITHOUT ROWID",
  "CREATE INDEX IF NOT EXISTS idx_fwd_dedupe_day ON fwd_dedupe(day)",
];

const ready = new WeakMap();

export async function ensureSchema(db, kind) {
  let done = ready.get(db);
  if (!done) { done = {}; ready.set(db, done); }
  if (done[kind]) return;
  const list = kind === "shared" ? SHARED_SCHEMA : STORE_SCHEMA;
  await db.batch(list.map((sql) => db.prepare(sql)));
  done[kind] = true;
}

export async function tableExists(db, name) {
  const row = await db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").bind(name).first();
  return !!row;
}

export const ROLLUP_TABLES = [
  "analytics_rollup_days", "analytics_rollup_visitors", "analytics_rollup_dimensions", "analytics_rollup_dirty",
  "analytics_rollup_stats_days", "analytics_rollup_hours", "analytics_rollup_events",
  "analytics_query_cache", "analytics_cache_days", "analytics_cache_config",
];
