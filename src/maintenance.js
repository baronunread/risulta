import { randomHex } from "./auth.js";

const DAY = 86400;
const dimensions = [["path", "path"], ["source", "coalesce(nullif(source,''),'Direct / None')"],
  ["medium", "coalesce(nullif(medium,''),'None')"], ["campaign", "coalesce(nullif(campaign,''),'None')"]];

export async function buildRollupDay(db, siteId, day, now) {
  if (day % DAY || day + DAY > Math.floor(now / DAY) * DAY) throw new Error("Only completed UTC days can be rolled up.");
  // One batch is one transaction: a failed day leaves the previous rollup intact.
  const statements = [];
  for (const table of ["analytics_rollup_visitors", "analytics_rollup_hours", "analytics_rollup_events"]) {
    statements.push(db.prepare("DELETE FROM " + table + " WHERE site_id=? AND day=?").bind(siteId, day));
  }
  // Match the dimension primary key's (site, dimension, day) prefix.
  for (const [dimension] of dimensions) {
    statements.push(db.prepare("DELETE FROM analytics_rollup_dimensions WHERE site_id=? AND dimension=? AND day=?").bind(siteId, dimension, day));
  }
  statements.push(db.prepare("INSERT INTO analytics_rollup_visitors WITH marked AS (SELECT visitor,name,ts,lag(ts) OVER (PARTITION BY visitor ORDER BY ts,id) AS previous FROM events WHERE site_id=? AND ts>=? AND ts<?) SELECT ?,?,visitor,sum(name='pageview'),sum(CASE WHEN visitor!='' AND (previous IS NULL OR ts-previous>1800) THEN 1 ELSE 0 END) FROM marked GROUP BY visitor")
    .bind(siteId, day, day + DAY, siteId, day));
  statements.push(db.prepare("INSERT INTO analytics_rollup_hours WITH marked AS (SELECT ts,visitor,name,lag(ts) OVER (PARTITION BY visitor ORDER BY ts,id) AS previous FROM events WHERE site_id=? AND ts>=? AND ts<?) SELECT ?,?,cast(strftime('%H',ts,'unixepoch') AS INTEGER),visitor,sum(name='pageview'),sum(CASE WHEN visitor!='' AND (previous IS NULL OR ts-previous>1800) THEN 1 ELSE 0 END) FROM marked GROUP BY 3,visitor")
    .bind(siteId, day, day + DAY, siteId, day));
  statements.push(db.prepare("INSERT INTO analytics_rollup_events SELECT ?,?,name,path,visitor,count(*),coalesce(sum(value),0) FROM events WHERE site_id=? AND ts>=? AND ts<? AND name!='pageview' GROUP BY name,path,visitor")
    .bind(siteId, day, siteId, day, day + DAY));
  for (const [dimension, expression] of dimensions) {
    statements.push(db.prepare("INSERT INTO analytics_rollup_dimensions SELECT ?,?,?," + expression + ",visitor,count(*),coalesce(sum(value),0) FROM events WHERE site_id=? AND ts>=? AND ts<? AND name='pageview' GROUP BY " + expression + ",visitor")
      .bind(siteId, day, dimension, siteId, day, day + DAY));
  }
  for (const table of ["analytics_rollup_days", "analytics_rollup_stats_days"]) {
    statements.push(db.prepare("INSERT INTO " + table + " VALUES (?,?,?) ON CONFLICT(site_id,day) DO UPDATE SET built_at=excluded.built_at").bind(siteId, day, now));
  }
  statements.push(db.prepare("DELETE FROM analytics_rollup_dirty WHERE site_id=? AND day=?").bind(siteId, day));
  await db.batch(statements);
}

// `shared` holds the site registry, `db` the org store with the events and rollups.
export async function runRollups(shared, db, now, maxDays = 4, overBudget = null) {
  if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > 1000) throw new Error("maxDays must be between 1 and 1000.");
  const today = Math.floor(now / DAY) * DAY;
  const ids = (await shared.prepare("SELECT id FROM sites ORDER BY id").all()).results;
  const firsts = new Map();
  for (const row of (await db.prepare("SELECT site_id, min(ts) AS first FROM events GROUP BY site_id").all()).results) firsts.set(row.site_id, row.first);
  const sites = ids.map((row) => ({ id: row.id, first: firsts.has(row.id) ? firsts.get(row.id) : null }));
  const queues = [];
  for (const site of sites) {
    const covered = new Set((await db.prepare("SELECT day FROM analytics_rollup_stats_days WHERE site_id=?").bind(site.id).all()).results.map(row => row.day));
    const dirty = (await db.prepare("SELECT day FROM analytics_rollup_dirty WHERE site_id=? AND day<? ORDER BY day DESC").bind(site.id, today).all()).results.map(row => row.day);
    const changed = new Set(dirty);
    const pending = dirty.slice();
    if (site.first !== null) {
      for (let day = today - DAY; day >= Math.floor(site.first / DAY) * DAY; day -= DAY) {
        if (!covered.has(day) && !changed.has(day)) pending.push(day);
      }
    }
    queues.push({ id: site.id, days: pending, offset: 0 });
  }
  let built = 0;
  let pending = true;
  while (pending && built < maxDays && !(built > 0 && overBudget && overBudget())) {
    pending = false;
    for (const queue of queues) {
      if (queue.offset === queue.days.length) continue;
      pending = true;
      await buildRollupDay(db, queue.id, queue.days[queue.offset++], now);
      built++;
      if (built === maxDays) break;
    }
  }
  return built;
}

// One maintenance tick. A time budget keeps the tick short on the shared event
// loop: no new rollup day starts after it is spent (one always runs).
// The backup covers the shared store; each org's rollups are separate work.
export async function runMaintenance(db, storeFor, orgs, files, now, budgetMs = 1200) {
  const started = Date.now();
  let backup = "unavailable";
  let days = 0;
  let failed = false;
  if (files) {
    try {
      backup = await runScheduledBackup(db, files, now);
    } catch (error) {
      failed = true;
      backup = "failed";
      console.error("Scheduled backup failed: " + String(error));
    }
  }
  try {
    for (const orgId of orgs) {
      if (days > 0 && Date.now() - started > budgetMs) break;
      days += await runRollups(db, storeFor(orgId), now, 4, () => Date.now() - started > budgetMs);
    }
  } catch (error) {
    failed = true;
    console.error("Rollup processing failed: " + String(error));
  }
  return { backup, days, failed };
}

export async function runScheduledBackup(db, files, now) {
  const setting = await db.prepare("SELECT frequency,hour,minute,retention FROM backup_settings WHERE id=1").first();
  if (!setting || !["off", "daily", "weekly"].includes(setting.frequency) ||
      !Number.isInteger(setting.hour) || !Number.isInteger(setting.minute) || !Number.isInteger(setting.retention) ||
      setting.hour < 0 || setting.hour > 23 || setting.minute < 0 || setting.minute > 59 || setting.retention < 1 || setting.retention > 90) throw new Error("Invalid backup preferences.");
  await db.prepare("UPDATE backup_settings SET runner_seen=? WHERE id=1").bind(now).run();
  const date = new Date(now * 1000);
  if (setting.frequency === "off" || (setting.frequency === "weekly" && date.getUTCDay() !== 1) ||
      date.getUTCHours() * 60 + date.getUTCMinutes() < setting.hour * 60 + setting.minute) return "not due";
  const last = await db.prepare("SELECT created_at FROM backup_history WHERE kind='scheduled' AND status='success' ORDER BY created_at DESC LIMIT 1").first();
  if (last && last.created_at >= Math.floor(now / DAY) * DAY) return "already backed up";
  const name = "AUTO-" + date.toISOString().slice(0, 19).replace(/:/g, "-") + "-" + randomHex(4) + ".sqlite";
  let partial = "";
  let snapshot;
  try {
    snapshot = await db.backup(name + ".partial");
    partial = snapshot.path;
    files.publish(partial);
    snapshot.path = partial.slice(0, -8);
    await db.prepare("INSERT INTO backup_history(created_at,kind,status,path,bytes) VALUES (?,'scheduled','success',?,?)").bind(now, snapshot.path, snapshot.bytes).run();
  } catch (error) {
    if (partial) files.remove(partial);
    await db.prepare("INSERT INTO backup_history(created_at,kind,status) VALUES (?,'scheduled','failed')").bind(now).run();
    throw error;
  }
  const directory = snapshot.path.slice(0, snapshot.path.lastIndexOf("/"));
  const old = (await db.prepare("SELECT id,path FROM backup_history WHERE kind='scheduled' AND status='success' ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET ?").bind(setting.retention).all()).results;
  for (const row of old) {
    const prefix = directory + "/";
    if (!row.path.startsWith(prefix) || !/^AUTO-[A-Za-z0-9._-]+\.sqlite$/.test(row.path.slice(prefix.length))) continue;
    if (files.remove(row.path)) await db.prepare("UPDATE backup_history SET status='expired' WHERE id=?").bind(row.id).run();
  }
  return "backup created";
}
