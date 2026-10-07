import type { Database } from "./types.ts";

import { ensureSiteSlugs } from "./sites.ts";
import { ROLLUP_SCHEMA, STATS_ROLLUP_SCHEMA } from "./rollups.ts";

export const SCHEMA_VERSION = 3;

// Adopt legacy databases without renumbering sites or rewriting raw events.
export function migrateSchema(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);");
  const latest = Number(db.prepare("SELECT coalesce(max(version), 0) AS version FROM schema_migrations").first<{ version: number }>()!.version);
  if (latest > SCHEMA_VERSION) throw new Error("This database requires a newer Risulta version.");
  applyMigration(db, 1, "stable site slugs", () => ensureSiteSlugs(db));
  applyMigration(db, 2, "daily analytics rollups", () => db.exec(ROLLUP_SCHEMA));
  applyMigration(db, 3, "hourly traffic and goal rollups", () => db.exec(STATS_ROLLUP_SCHEMA));
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
