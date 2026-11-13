import type { Database } from "./types.ts";

import { ANNOTATION_SCHEMA } from "./annotations.js";
import { ANALYTICS_CACHE_SCHEMA } from "./analytics-cache.js";
import { siteSlugStatements } from "./sites.ts";
import { ROLLUP_SCHEMA, STATS_ROLLUP_SCHEMA } from "./rollups.ts";
import { splitStatements } from "./sql.ts";

export const SCHEMA_VERSION = 7;

export const FUNNEL_INDEX_SCHEMA = "CREATE INDEX IF NOT EXISTS idx_events_site_visitor_ts_funnels ON events(site_id,visitor,ts,name,path);";

// Adopt legacy databases without renumbering sites or rewriting raw events.
export type SchemaScope = "shared" | "org";

// Which store owns each version's tables (see data.js).
const ORG_VERSIONS = [2, 3, 4, 5, 7];

// Each store keeps its own ledger and applies only its versions; with one D1
// binding both calls land in the same database and the ledger rows are disjoint.
export async function migrateSchema(db: Database, scope: SchemaScope): Promise<void> {
  await db.prepare("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);").run();
  const latest = Number((await db.prepare("SELECT coalesce(max(version), 0) AS version FROM schema_migrations").first<{ version: number }>())!.version);
  if (latest > SCHEMA_VERSION) throw new Error("This database requires a newer Risulta version.");
  await applyMigration(db, scope, 1, "stable site slugs", async () => await siteSlugStatements(db));
  await applyMigration(db, scope, 2, "daily analytics rollups", () => script(db, ROLLUP_SCHEMA));
  await applyMigration(db, scope, 3, "hourly traffic and goal rollups", () => script(db, STATS_ROLLUP_SCHEMA));
  await applyMigration(db, scope, 4, "persistent analytics cache", () => script(db, ANALYTICS_CACHE_SCHEMA));
  await applyMigration(db, scope, 5, "ordered covering funnel index", () => script(db, FUNNEL_INDEX_SCHEMA));
  await applyMigration(db, scope, 6, "opt-in public widgets", () => script(db, "CREATE TABLE IF NOT EXISTS public_widgets (site_id INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)));"));
  await applyMigration(db, scope, 7, "site-owned chart annotations", () => script(db, ANNOTATION_SCHEMA));
}

function script(db: Database, sql: string) {
  return splitStatements(sql).map((statement) => db.prepare(statement));
}

// Each migration's statements and its ledger row are one batch, so a failure
// leaves the version unrecorded and the migration is retried whole.
async function applyMigration(db: Database, scope: SchemaScope, version: number, name: string, statements: () => ReturnType<Database["prepare"]>[] | Promise<ReturnType<Database["prepare"]>[]>): Promise<void> {
  if ((ORG_VERSIONS.includes(version) ? "org" : "shared") !== scope) return;
  if (await db.prepare("SELECT version FROM schema_migrations WHERE version = ?").bind(version).first()) return;
  const list = await statements();
  list.push(db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").bind(version, name, Math.floor(Date.now() / 1000)));
  await db.batch(list);
}
