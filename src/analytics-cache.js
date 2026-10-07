// Persist historical calculations; live snapshots remain bounded in memory.
const snapshots = [];
const maxEntries = 128;
const maxCharacters = 262144;

export const ANALYTICS_CACHE_SCHEMA =
  "CREATE TABLE analytics_query_cache(site_id INTEGER NOT NULL,query_key TEXT NOT NULL,revision TEXT NOT NULL,created_at INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(site_id,query_key)) WITHOUT ROWID;" +
  "CREATE TABLE analytics_cache_days(site_id INTEGER NOT NULL,day INTEGER NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(site_id,day)) WITHOUT ROWID;" +
  "CREATE TABLE analytics_cache_config(site_id INTEGER PRIMARY KEY,revision INTEGER NOT NULL);" +
  eventTriggers() + configTriggers() +
  "CREATE TRIGGER analytics_cache_site_delete AFTER DELETE ON sites BEGIN DELETE FROM analytics_query_cache WHERE site_id=OLD.id;DELETE FROM analytics_cache_days WHERE site_id=OLD.id;INSERT INTO analytics_cache_config VALUES(OLD.id,1) ON CONFLICT(site_id) DO UPDATE SET revision=revision+1;END;";

function eventTriggers() {
  let sql = "";
  for (const action of ["INSERT", "UPDATE", "DELETE"]) {
    const references = action === "UPDATE" ? ["OLD", "NEW"] : [action === "DELETE" ? "OLD" : "NEW"];
    sql += "CREATE TRIGGER analytics_cache_event_" + action.toLowerCase() + " AFTER " + action + " ON events BEGIN ";
    for (const ref of references) sql += "INSERT INTO analytics_cache_days VALUES(" + ref + ".site_id,cast(" + ref + ".ts/86400 AS INTEGER)*86400,1) ON CONFLICT(site_id,day) DO UPDATE SET revision=revision+1;";
    sql += "END;";
  }
  return sql;
}

function configTriggers() {
  let sql = "";
  for (const table of ["goals", "funnels", "funnel_steps"]) {
    for (const action of ["INSERT", "UPDATE", "DELETE"]) {
      sql += "CREATE TRIGGER analytics_cache_" + table + "_" + action.toLowerCase() + " AFTER " + action + " ON " + table + " BEGIN ";
      const references = action === "UPDATE" ? ["OLD", "NEW"] : [action === "DELETE" ? "OLD" : "NEW"];
      for (const ref of references) {
        sql += table === "funnel_steps" ? "INSERT INTO analytics_cache_config SELECT site_id,1 FROM funnels WHERE id=" + ref + ".funnel_id ON CONFLICT(site_id) DO UPDATE SET revision=revision+1;" : "INSERT INTO analytics_cache_config VALUES(" + ref + ".site_id,1) ON CONFLICT(site_id) DO UPDATE SET revision=revision+1;";
      }
      sql += "END;";
    }
  }
  return sql;
}

// Authorization belongs to the route, before calling this shared result cache.
export function cachedAnalytics(db, siteId, kind, range, input, now, fresh, read) {
  if (fresh) return read();
  const today = Math.floor(now / 86400) * 86400;
  const historical = range.until <= today;
  const end = range.until === now + 1 ? "live" : range.until;
  const key = JSON.stringify([kind,range.since,end,input]);
  const days = db.prepare("SELECT day,revision FROM analytics_cache_days WHERE site_id=? AND day>=? AND day<? ORDER BY day")
    .bind(siteId,Math.floor(range.since/86400)*86400,range.until).all().results;
  const config = db.prepare("SELECT revision FROM analytics_cache_config WHERE site_id=?").bind(siteId).first();
  const revision = JSON.stringify([config ? config.revision : 0,days]);
  if (historical) {
    const row = db.prepare("SELECT payload,revision,created_at FROM analytics_query_cache WHERE site_id=? AND query_key=?").bind(siteId,key).first();
    if (row && row.revision === revision && now >= Number(row.created_at) && now-Number(row.created_at)<86400) return JSON.parse(row.payload);
  } else {
    for (let i=0;i<snapshots.length;i++) {
      const row = snapshots[i];
      if (row.db===db && row.siteId===siteId && row.key===key && row.revision===revision && now>=row.at && now-row.at<5) return JSON.parse(row.payload);
    }
  }
  const value = read();
  const payload = JSON.stringify(value);
  if (payload.length>maxCharacters) return value;
  if (historical) {
    db.prepare("INSERT INTO analytics_query_cache VALUES(?,?,?,?,?) ON CONFLICT(site_id,query_key) DO UPDATE SET revision=excluded.revision,created_at=excluded.created_at,payload=excluded.payload").bind(siteId,key,revision,now,payload).run();
    db.prepare("DELETE FROM analytics_query_cache WHERE (site_id,query_key) IN (SELECT site_id,query_key FROM analytics_query_cache ORDER BY created_at DESC,site_id,query_key LIMIT -1 OFFSET ?)").bind(maxEntries).run();
  } else {
    for (let i=snapshots.length-1;i>=0;i--) if (snapshots[i].db===db && snapshots[i].siteId===siteId && snapshots[i].key===key) snapshots.splice(i,1);
    if (snapshots.length>=maxEntries) snapshots.shift();
    snapshots.push({db,siteId,key,revision,at:now,payload});
  }
  return value;
}
