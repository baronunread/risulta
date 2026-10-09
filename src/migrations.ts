import type { Database } from "./types.ts";

import { ANALYTICS_CACHE_SCHEMA } from "./analytics-cache.js";
import { ensureSiteSlugs } from "./sites.ts";
import { ROLLUP_SCHEMA, STATS_ROLLUP_SCHEMA } from "./rollups.ts";

export const SCHEMA_VERSION = 6;

export const FUNNEL_INDEX_SCHEMA = "CREATE INDEX IF NOT EXISTS idx_events_site_visitor_ts_funnels ON events(site_id,visitor,ts,name,path);";

// Adopt legacy databases without renumbering sites or rewriting raw events.
export function migrateSchema(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);");
  const latest = Number(db.prepare("SELECT coalesce(max(version), 0) AS version FROM schema_migrations").first<{ version: number }>()!.version);
  if (latest > SCHEMA_VERSION) throw new Error("This database requires a newer Risulta version.");
  applyMigration(db, 1, "stable site slugs", () => ensureSiteSlugs(db));
  applyMigration(db, 2, "daily analytics rollups", () => db.exec(ROLLUP_SCHEMA));
  applyMigration(db, 3, "hourly traffic and goal rollups", () => db.exec(STATS_ROLLUP_SCHEMA));
  applyMigration(db, 4, "persistent analytics cache", () => db.exec(ANALYTICS_CACHE_SCHEMA));
  applyMigration(db, 5, "ordered covering funnel index", () => db.exec(FUNNEL_INDEX_SCHEMA));
  applyMigration(db, 6, "opt-in public widgets", () => db.exec("CREATE TABLE IF NOT EXISTS public_widgets (site_id INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)));"));
}

function applyMigration(db: Database, version: number, name: string, apply: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare("SELECT version FROM schema_migrations WHERE version = ?").bind(version).first()) {
      apply();
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").bind(version, name, Math.floor(Date.now() / 1000)).run();
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
