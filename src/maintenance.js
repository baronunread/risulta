import { randomHex } from "./auth.js";

const DAY = 86400;
const dimensions = [["path", "path"], ["source", "coalesce(nullif(source,''),'Direct / None')"],
  ["medium", "coalesce(nullif(medium,''),'None')"], ["campaign", "coalesce(nullif(campaign,''),'None')"]];

export function buildRollupDay(db, siteId, day, now) {
  if (day % DAY || day + DAY > Math.floor(now / DAY) * DAY) throw new Error("Only completed UTC days can be rolled up.");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of ["analytics_rollup_visitors", "analytics_rollup_hours", "analytics_rollup_events", "analytics_rollup_dimensions"]) {
      db.prepare("DELETE FROM " + table + " WHERE site_id=? AND day=?").bind(siteId, day).run();
    }
    db.prepare("INSERT INTO analytics_rollup_visitors WITH marked AS (SELECT visitor,name,ts,lag(ts) OVER (PARTITION BY visitor ORDER BY ts,id) AS previous FROM events WHERE site_id=? AND ts>=? AND ts<?) SELECT ?,?,visitor,sum(name='pageview'),sum(CASE WHEN visitor!='' AND (previous IS NULL OR ts-previous>1800) THEN 1 ELSE 0 END) FROM marked GROUP BY visitor")
      .bind(siteId, day, day + DAY, siteId, day).run();
    db.prepare("INSERT INTO analytics_rollup_hours WITH marked AS (SELECT ts,visitor,name,lag(ts) OVER (PARTITION BY visitor ORDER BY ts,id) AS previous FROM events WHERE site_id=? AND ts>=? AND ts<?) SELECT ?,?,cast(strftime('%H',ts,'unixepoch') AS INTEGER),visitor,sum(name='pageview'),sum(CASE WHEN visitor!='' AND (previous IS NULL OR ts-previous>1800) THEN 1 ELSE 0 END) FROM marked GROUP BY 3,visitor")
      .bind(siteId, day, day + DAY, siteId, day).run();
    db.prepare("INSERT INTO analytics_rollup_events SELECT ?,?,name,path,visitor,count(*),coalesce(sum(value),0) FROM events WHERE site_id=? AND ts>=? AND ts<? AND name!='pageview' GROUP BY name,path,visitor")
      .bind(siteId, day, siteId, day, day + DAY).run();
    for (const [dimension, expression] of dimensions) {
      db.prepare("INSERT INTO analytics_rollup_dimensions SELECT ?,?,?," + expression + ",visitor,count(*),coalesce(sum(value),0) FROM events WHERE site_id=? AND ts>=? AND ts<? AND name='pageview' GROUP BY " + expression + ",visitor")
        .bind(siteId, day, dimension, siteId, day, day + DAY).run();
    }
    for (const table of ["analytics_rollup_days", "analytics_rollup_stats_days"]) {
      db.prepare("INSERT INTO " + table + " VALUES (?,?,?) ON CONFLICT(site_id,day) DO UPDATE SET built_at=excluded.built_at").bind(siteId, day, now).run();
    }
    db.prepare("DELETE FROM analytics_rollup_dirty WHERE site_id=? AND day=?").bind(siteId, day).run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function runRollups(db, now, maxDays = 4) {
  if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > 1000) throw new Error("maxDays must be between 1 and 1000.");
  const today = Math.floor(now / DAY) * DAY;
  const sites = db.prepare("SELECT id,(SELECT min(ts) FROM events WHERE site_id=sites.id) AS first FROM sites ORDER BY id").all().results;
  const queues = [];
  for (const site of sites) {
    const covered = new Set(db.prepare("SELECT day FROM analytics_rollup_stats_days WHERE site_id=?").bind(site.id).all().results.map(row => row.day));
    const dirty = db.prepare("SELECT day FROM analytics_rollup_dirty WHERE site_id=? AND day<? ORDER BY day DESC").bind(site.id, today).all().results.map(row => row.day);
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
  while (pending && built < maxDays) {
    pending = false;
    for (const queue of queues) {
      if (queue.offset === queue.days.length) continue;
      pending = true;
      buildRollupDay(db, queue.id, queue.days[queue.offset++], now);
      built++;
      if (built === maxDays) break;
    }
  }
  return built;
}

export function runScheduledBackup(db, files, now) {
  const setting = db.prepare("SELECT frequency,hour,minute,retention FROM backup_settings WHERE id=1").first();
  if (!setting || !["off", "daily", "weekly"].includes(setting.frequency) ||
      !Number.isInteger(setting.hour) || !Number.isInteger(setting.minute) || !Number.isInteger(setting.retention) ||
      setting.hour < 0 || setting.hour > 23 || setting.minute < 0 || setting.minute > 59 || setting.retention < 1 || setting.retention > 90) throw new Error("Invalid backup preferences.");
  db.prepare("UPDATE backup_settings SET runner_seen=? WHERE id=1").bind(now).run();
  const date = new Date(now * 1000);
  if (setting.frequency === "off" || (setting.frequency === "weekly" && date.getUTCDay() !== 1) ||
      date.getUTCHours() * 60 + date.getUTCMinutes() < setting.hour * 60 + setting.minute) return "not due";
  const last = db.prepare("SELECT created_at FROM backup_history WHERE kind='scheduled' AND status='success' ORDER BY created_at DESC LIMIT 1").first();
  if (last && last.created_at >= Math.floor(now / DAY) * DAY) return "already backed up";
  const name = "AUTO-" + date.toISOString().slice(0, 19).replace(/:/g, "-") + "-" + randomHex(4) + ".sqlite";
  let partial = "";
  let snapshot;
  try {
    snapshot = db.backup(name + ".partial");
    partial = snapshot.path;
    files.publish(partial);
    snapshot.path = partial.slice(0, -8);
    db.prepare("INSERT INTO backup_history(created_at,kind,status,path,bytes) VALUES (?,'scheduled','success',?,?)").bind(now, snapshot.path, snapshot.bytes).run();
  } catch (error) {
    if (partial) files.remove(partial);
    db.prepare("INSERT INTO backup_history(created_at,kind,status) VALUES (?,'scheduled','failed')").bind(now).run();
    throw error;
  }
  const directory = snapshot.path.slice(0, snapshot.path.lastIndexOf("/"));
  const old = db.prepare("SELECT id,path FROM backup_history WHERE kind='scheduled' AND status='success' ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET ?").bind(setting.retention).all().results;
  for (const row of old) {
    const prefix = directory + "/";
    if (!row.path.startsWith(prefix) || !/^AUTO-[A-Za-z0-9._-]+\.sqlite$/.test(row.path.slice(prefix.length))) continue;
    if (files.remove(row.path)) db.prepare("UPDATE backup_history SET status='expired' WHERE id=?").bind(row.id).run();
  }
  return "backup created";
}
