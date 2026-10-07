import type { AcquisitionDimension, AcquisitionReport, Database, DailyTraffic, ReportBounds, ReportRow, TrafficLabel, TrafficSummary, RollupTraffic, HourlyTraffic, GoalResult } from "./types.ts";

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
export function rollupBoundary(db: Database, siteId: number, since: number, until: number, now: number, stats = false): number {
  const today = Math.floor(now / 86400) * 86400;
  const end = Math.min(Math.floor(until / 86400) * 86400, today);
  if (since % 86400 !== 0 || end <= since) return 0;
  const table = stats ? "analytics_rollup_stats_days" : "analytics_rollup_days";
  const state = db.prepare("SELECT (SELECT count(*) FROM " + table + " WHERE site_id = ? AND day >= ? AND day < ?) AS covered, (SELECT count(*) FROM analytics_rollup_dirty WHERE site_id = ? AND day >= ? AND day < ?) AS dirty")
    .bind(siteId, since, end, siteId, since, end).first<{ covered: number; dirty: number }>()!;
  return Number(state.covered) === (end - since) / 86400 && Number(state.dirty) === 0 ? end : 0;
}

export function rollupTraffic(db: Database, siteId: number, since: number, until: number, boundary: number): RollupTraffic {
  const summary = db.prepare("SELECT coalesce(sum(pageviews), 0) AS pageviews, coalesce(sum(visits), 0) AS visits FROM analytics_rollup_visitors WHERE site_id = ? AND day >= ? AND day < ?")
    .bind(siteId, since, boundary).first<TrafficSummary>()!;
  const byDay = db.prepare("SELECT date(day, 'unixepoch') AS day, sum(pageviews) AS pageviews, count(CASE WHEN pageviews > 0 THEN 1 END) AS visitors, sum(visits) AS visits FROM analytics_rollup_visitors WHERE site_id = ? AND day >= ? AND day < ? GROUP BY day HAVING sum(pageviews) > 0 OR sum(visits) > 0 ORDER BY day")
    .bind(siteId, since, boundary).all<DailyTraffic>().results;
  summary.visitors = rollupVisitors(db, siteId, since, until, boundary);
  return { summary, byDay };
}

// Keep imported identities exact across both the historical prefix and live tail.
export function rollupVisitors(db: Database, siteId: number, since: number, until: number, boundary: number): number {
  return Number(db.prepare("SELECT count(DISTINCT visitor) AS n FROM (SELECT visitor FROM analytics_rollup_visitors WHERE site_id = ? AND day >= ? AND day < ? AND pageviews > 0 UNION ALL SELECT visitor FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview')")
    .bind(siteId, since, boundary, siteId, boundary, until).first<{ n: number }>()!.n);
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

// Separate coverage keeps existing daily reads available during a v2 upgrade.
export const STATS_ROLLUP_SCHEMA =
  "CREATE INDEX IF NOT EXISTS idx_events_site_ts_funnels ON events(site_id,ts,visitor,name,path);" +
  "CREATE TABLE IF NOT EXISTS analytics_rollup_stats_days (site_id INTEGER NOT NULL, day INTEGER NOT NULL, built_at INTEGER NOT NULL, PRIMARY KEY (site_id, day)) WITHOUT ROWID;" +
  "CREATE TABLE IF NOT EXISTS analytics_rollup_hours (site_id INTEGER NOT NULL, day INTEGER NOT NULL, hour INTEGER NOT NULL, visitor TEXT NOT NULL, pageviews INTEGER NOT NULL, visits INTEGER NOT NULL, PRIMARY KEY (site_id, day, hour, visitor)) WITHOUT ROWID;" +
  "CREATE TABLE IF NOT EXISTS analytics_rollup_events (site_id INTEGER NOT NULL, day INTEGER NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, visitor TEXT NOT NULL, events INTEGER NOT NULL, value REAL NOT NULL, PRIMARY KEY (site_id, day, name, path, visitor)) WITHOUT ROWID;";

export function rollupHours(db: Database, siteId: number, since: number, until: number, boundary: number): HourlyTraffic[] {
  return db.prepare("WITH marked AS (SELECT ts, visitor, name, lag(ts) OVER (PARTITION BY visitor, date(ts,'unixepoch') ORDER BY ts) AS previous FROM events WHERE site_id = ? AND ts >= ? - 1800 AND ts < ?), " +
    "combined AS (SELECT hour, visitor, pageviews, visits FROM analytics_rollup_hours WHERE site_id = ? AND day >= ? AND day < ? UNION ALL " +
    "SELECT cast(strftime('%H',ts,'unixepoch') AS INTEGER), visitor, sum(name='pageview'), sum(CASE WHEN visitor!='' AND (previous IS NULL OR ts-previous>1800) THEN 1 ELSE 0 END) FROM marked WHERE ts >= ? GROUP BY 1, visitor) " +
    "SELECT hour, sum(pageviews) AS pageviews, count(DISTINCT CASE WHEN pageviews>0 THEN visitor END) AS visitors, sum(visits) AS visits FROM combined GROUP BY hour HAVING sum(pageviews)>0 OR sum(visits)>0 ORDER BY hour")
    .bind(siteId, boundary, until, siteId, since, boundary, boundary).all<HourlyTraffic>().results;
}

export function rollupGoals(db: Database, siteId: number, since: number, until: number, boundary: number, visitors: number): GoalResult[] {
  const rows = db.prepare("WITH configured AS (SELECT id,name,event_name,path FROM goals WHERE site_id = ?), " +
    "hits AS MATERIALIZED (SELECT 'pageview' AS name, label AS path, visitor, pageviews AS events, value FROM analytics_rollup_dimensions WHERE site_id = ? AND dimension = 'path' AND day >= ? AND day < ? AND 'pageview' IN (SELECT event_name FROM configured) AND ('' IN (SELECT path FROM configured WHERE event_name='pageview') OR label IN (SELECT path FROM configured WHERE event_name='pageview')) " +
    "UNION ALL SELECT name,path,visitor,events,value FROM analytics_rollup_events e WHERE site_id = ? AND day >= ? AND day < ? AND name IN (SELECT event_name FROM configured) AND (name IN (SELECT event_name FROM configured WHERE path='') OR (name,path) IN (SELECT event_name,path FROM configured WHERE path!='')) " +
    "UNION ALL SELECT name,path,visitor,1 AS events,coalesce(value,0) FROM events e WHERE site_id = ? AND ts >= ? AND ts < ? AND name IN (SELECT event_name FROM configured) AND (name IN (SELECT event_name FROM configured WHERE path='') OR (name,path) IN (SELECT event_name,path FROM configured WHERE path!=''))), " +
    "totals AS (SELECT name, '' AS path, sum(events) AS conversions, count(DISTINCT visitor) AS unique_conversions, sum(value) AS value FROM hits WHERE name IN (SELECT event_name FROM configured WHERE path='') GROUP BY name " +
    "UNION ALL SELECT name,path,sum(events),count(DISTINCT visitor),sum(value) FROM hits WHERE path IN (SELECT path FROM configured WHERE path!='') GROUP BY name,path) " +
    "SELECT g.name,g.event_name,g.path,coalesce(t.conversions,0) AS conversions,coalesce(t.unique_conversions,0) AS unique_conversions,coalesce(t.value,0) AS value FROM configured g LEFT JOIN totals t ON t.name=g.event_name AND t.path=g.path ORDER BY g.id")
    .bind(siteId, siteId, since, boundary, siteId, since, boundary, siteId, boundary, until).all<Omit<GoalResult, 'conversion_rate'>>().results;
  return rows.map((row) => ({ ...row, conversion_rate: visitors ? Number(row.unique_conversions) / visitors : 0 }));
}
