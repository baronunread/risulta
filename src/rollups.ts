import type { AcquisitionDimension, AcquisitionReport, Database, DailyTraffic, ReportBounds, ReportRow, TrafficLabel, TrafficSummary, RollupTraffic } from "./types.ts";

export const ROLLUP_SCHEMA =
  "CREATE TABLE IF NOT EXISTS analytics_rollup_days (site_id INTEGER NOT NULL, day INTEGER NOT NULL, built_at INTEGER NOT NULL, PRIMARY KEY (site_id, day)) WITHOUT ROWID;" +
  "CREATE TABLE IF NOT EXISTS analytics_rollup_visitors (site_id INTEGER NOT NULL, day INTEGER NOT NULL, visitor TEXT NOT NULL, pageviews INTEGER NOT NULL, visits INTEGER NOT NULL, PRIMARY KEY (site_id, day, visitor)) WITHOUT ROWID;" +
  "CREATE TABLE IF NOT EXISTS analytics_rollup_dimensions (site_id INTEGER NOT NULL, day INTEGER NOT NULL, dimension TEXT NOT NULL, label TEXT NOT NULL, visitor TEXT NOT NULL, pageviews INTEGER NOT NULL, value REAL NOT NULL, PRIMARY KEY (site_id, dimension, day, label, visitor)) WITHOUT ROWID;" +
  "CREATE TABLE IF NOT EXISTS analytics_rollup_dirty (site_id INTEGER NOT NULL, day INTEGER NOT NULL, PRIMARY KEY (site_id, day)) WITHOUT ROWID;" +
  "CREATE TRIGGER IF NOT EXISTS analytics_rollup_insert AFTER INSERT ON events WHEN NOT EXISTS (SELECT 1 FROM analytics_rollup_dirty WHERE site_id = NEW.site_id AND day = cast(NEW.ts / 86400 AS INTEGER) * 86400) BEGIN INSERT INTO analytics_rollup_dirty VALUES (NEW.site_id, cast(NEW.ts / 86400 AS INTEGER) * 86400); END;" +
  "CREATE TRIGGER IF NOT EXISTS analytics_rollup_delete AFTER DELETE ON events BEGIN INSERT OR IGNORE INTO analytics_rollup_dirty VALUES (OLD.site_id, cast(OLD.ts / 86400 AS INTEGER) * 86400); END;" +
  "CREATE TRIGGER IF NOT EXISTS analytics_rollup_update AFTER UPDATE ON events BEGIN INSERT OR IGNORE INTO analytics_rollup_dirty VALUES (OLD.site_id, cast(OLD.ts / 86400 AS INTEGER) * 86400); INSERT OR IGNORE INTO analytics_rollup_dirty VALUES (NEW.site_id, cast(NEW.ts / 86400 AS INTEGER) * 86400); END;";

// Return a completed-day boundary only when every historical day is covered.
// A partial day and today's live data remain raw. Missing or dirty days fall
// back to the existing query, including throughout an interrupted backfill.
export function rollupBoundary(db: Database, siteId: number, since: number, until: number, now: number): number {
  const today = Math.floor(now / 86400) * 86400;
  const end = Math.min(Math.floor(until / 86400) * 86400, today);
  if (since % 86400 !== 0 || end <= since) return 0;
  const state = db.prepare("SELECT (SELECT count(*) FROM analytics_rollup_days WHERE site_id = ? AND day >= ? AND day < ?) AS covered, (SELECT count(*) FROM analytics_rollup_dirty WHERE site_id = ? AND day >= ? AND day < ?) AS dirty")
    .bind(siteId, since, end, siteId, since, end).first<{ covered: number; dirty: number }>()!;
  return Number(state.covered) === (end - since) / 86400 && Number(state.dirty) === 0 ? end : 0;
}

export function rollupTraffic(db: Database, siteId: number, since: number, until: number, boundary: number): RollupTraffic {
  const summary = db.prepare("SELECT coalesce(sum(pageviews), 0) AS pageviews, coalesce(sum(visits), 0) AS visits FROM analytics_rollup_visitors WHERE site_id = ? AND day >= ? AND day < ?")
    .bind(siteId, since, boundary).first<TrafficSummary>()!;
  const byDay = db.prepare("SELECT date(day, 'unixepoch') AS day, sum(pageviews) AS pageviews, count(CASE WHEN pageviews > 0 THEN 1 END) AS visitors, sum(visits) AS visits FROM analytics_rollup_visitors WHERE site_id = ? AND day >= ? AND day < ? GROUP BY day HAVING sum(pageviews) > 0 OR sum(visits) > 0 ORDER BY day")
    .bind(siteId, since, boundary).all<DailyTraffic>().results;
  // Keep imported identities exact too, even if a hash repeats on another day.
  summary.visitors = Number(db.prepare("SELECT count(DISTINCT visitor) AS n FROM (SELECT visitor FROM analytics_rollup_visitors WHERE site_id = ? AND day >= ? AND day < ? AND pageviews > 0 UNION ALL SELECT visitor FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview')")
    .bind(siteId, since, boundary, siteId, boundary, until).first<{ n: number }>()!.n);
  return { summary, byDay };
}

export function rollupTop(db: Database, siteId: number, since: number, until: number, boundary: number, dimension: AcquisitionDimension): TrafficLabel[] {
  const column = dimension === "path" ? "path" : dimension === "source" ? "coalesce(nullif(source,''),'Direct / None')" : dimension === "medium" ? "coalesce(nullif(medium,''),'None')" : "coalesce(nullif(campaign,''),'None')";
  return db.prepare("SELECT label, sum(pageviews) AS pageviews, count(DISTINCT visitor) AS visitors FROM (SELECT label, visitor, pageviews FROM analytics_rollup_dimensions WHERE site_id = ? AND day >= ? AND day < ? AND dimension = ? UNION ALL SELECT " + column + " AS label, visitor, 1 AS pageviews FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview') GROUP BY label ORDER BY visitors DESC, pageviews DESC, label LIMIT 8")
    .bind(siteId, since, boundary, dimension, siteId, boundary, until).all<TrafficLabel>().results;
}

export function rollupReport(db: Database, siteId: number, since: number, until: number, boundary: number, dimension: AcquisitionDimension, bounds: ReportBounds): AcquisitionReport {
  const column = dimension === "path" ? "path" : dimension === "source" ? "coalesce(nullif(source,''),'Direct / None')" : dimension === "medium" ? "coalesce(nullif(medium,''),'None')" : "coalesce(nullif(campaign,''),'None')";
  const grouped = "SELECT label, sum(pageviews) AS pageviews, count(DISTINCT visitor) AS visitors, sum(value) AS value FROM (SELECT label, visitor, pageviews, value FROM analytics_rollup_dimensions WHERE site_id = ? AND day >= ? AND day < ? AND dimension = ? UNION ALL SELECT " + column + " AS label, visitor, 1 AS pageviews, coalesce(value,0) AS value FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview') GROUP BY label";
  const args = [siteId, since, boundary, dimension, siteId, boundary, until];
  const rows = db.prepare("SELECT *, count(*) OVER () AS total_rows FROM (" + grouped + ") ORDER BY " + bounds.sort + " DESC, label LIMIT ? OFFSET ?").bind(...args, bounds.limit, bounds.offset).all<ReportRow & { total_rows?: number }>().results;
  const total = rows.length ? Number(rows[0].total_rows) : Number(db.prepare("SELECT count(*) AS n FROM (" + grouped + ")").bind(...args).first<{ n: number }>()!.n);
  for (let i = 0; i < rows.length; i++) delete rows[i].total_rows;
  return { dimension, filters: {}, rows, total, ...bounds };
}
