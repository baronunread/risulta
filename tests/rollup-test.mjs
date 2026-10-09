import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRollups } from '../src/maintenance.js';
import { FUNNEL_INDEX_SCHEMA, migrateSchema } from '../src/migrations.ts';
import { ROLLUP_SCHEMA, STATS_ROLLUP_SCHEMA, rollupBoundary } from '../src/rollups.ts';
import { siteStats, dashboardGoals, siteGoals, dashboardTraffic, dashboardSummary, siteAnalytics, siteSummary, dashboardReport, siteReport } from '../src/store.js';

function adapter(sqlite) {
  return { exec(sql) { sqlite.exec(sql); }, prepare(sql) {
    const query = sqlite.query(sql); let args = [];
    return { bind(...values) { args = values; return this; }, first() { return query.get(...args); },
      all() { return { results: query.all(...args) }; }, run() { return query.run(...args); } };
  } };
}
const legacy = "CREATE TABLE sites(id INTEGER PRIMARY KEY,name TEXT,domain TEXT UNIQUE,public_key TEXT UNIQUE,created_at INTEGER);" +
  "CREATE TABLE events(id INTEGER PRIMARY KEY,site_id INTEGER,ts INTEGER,name TEXT,path TEXT,visitor TEXT,source TEXT,medium TEXT,campaign TEXT,value REAL);" +
  "CREATE TABLE goals(id INTEGER PRIMARY KEY,site_id INTEGER,name TEXT,event_name TEXT,path TEXT);CREATE TABLE funnels(id INTEGER PRIMARY KEY,site_id INTEGER,name TEXT);CREATE TABLE funnel_steps(funnel_id INTEGER,position INTEGER,goal_id INTEGER);";

// A failed step rolls back its DDL and marker, and a restart resumes safely.
const failure = new Database(':memory:'); failure.exec(legacy);
const failingDb = adapter(failure);
const exec = failingDb.exec;
failingDb.exec = (sql) => { if (sql === ROLLUP_SCHEMA) exec(sql.split(';')[0] + '; INVALID SQL;'); else exec(sql); };
assert.throws(() => migrateSchema(failingDb));
assert.equal(failure.query('SELECT max(version) AS n FROM schema_migrations').get().n, 1);
assert.equal(failure.query("SELECT count(*) AS n FROM sqlite_master WHERE name='analytics_rollup_days'").get().n, 0);
failingDb.exec = exec; migrateSchema(failingDb); migrateSchema(failingDb);
assert.equal(failure.query('SELECT count(*) AS n FROM schema_migrations').get().n, 6);
failure.exec("INSERT INTO schema_migrations VALUES(7,'future',0)");
assert.throws(() => migrateSchema(failingDb), /newer Risulta/);
failure.close();
// A schema-4 database keeps its events when the covering-index upgrade retries.
const indexUpgrade = new Database(':memory:'); indexUpgrade.exec(legacy);
const indexDb = adapter(indexUpgrade); migrateSchema(indexDb);
indexUpgrade.exec("DROP INDEX idx_events_site_visitor_ts_funnels; DELETE FROM schema_migrations WHERE version>=5; INSERT INTO events(id,site_id,ts,name,path,visitor) VALUES(1,1,10,'pageview','/','a');");
const indexExec = indexDb.exec;
indexDb.exec = (sql) => { if (sql === FUNNEL_INDEX_SCHEMA) indexExec(sql + ' INVALID SQL;'); else indexExec(sql); };
assert.throws(() => migrateSchema(indexDb));
assert.equal(indexUpgrade.query('SELECT max(version) AS n FROM schema_migrations').get().n,4);
assert.equal(indexUpgrade.query("SELECT count(*) AS n FROM sqlite_master WHERE name='idx_events_site_visitor_ts_funnels'").get().n,0);
indexDb.exec = indexExec; migrateSchema(indexDb); migrateSchema(indexDb);
assert.equal(indexUpgrade.query('SELECT count(*) AS n FROM events').get().n,1);
assert.equal(indexUpgrade.query('SELECT max(version) AS n FROM schema_migrations').get().n,6);
indexUpgrade.close();
// Upgrade an already covered v2 database without replaying or discarding daily data.
const upgrade = new Database(':memory:'); upgrade.exec(legacy + "INSERT INTO sites VALUES(1,'Shop','shop.test','key',0);");
const upgradeDb = adapter(upgrade);
upgrade.exec("ALTER TABLE sites ADD COLUMN slug TEXT;CREATE UNIQUE INDEX idx_sites_slug ON sites(slug);" + ROLLUP_SCHEMA + "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at INTEGER);INSERT INTO schema_migrations VALUES(1,'slugs',0),(2,'daily',0);INSERT INTO analytics_rollup_days VALUES(1,86400,0);");
const upgradeExec = upgradeDb.exec;
upgradeDb.exec = (sql) => { if (sql === STATS_ROLLUP_SCHEMA) upgradeExec(sql.split(';')[0] + '; INVALID SQL;'); else upgradeExec(sql); };
assert.throws(() => migrateSchema(upgradeDb));
assert.equal(upgrade.query('SELECT max(version) AS n FROM schema_migrations').get().n, 2);
assert.equal(upgrade.query("SELECT count(*) AS n FROM sqlite_master WHERE name='analytics_rollup_stats_days'").get().n, 0);
upgradeDb.exec = upgradeExec; migrateSchema(upgradeDb); migrateSchema(upgradeDb);
assert.equal(rollupBoundary(upgradeDb,1,86400,172800,172800),172800);
assert.equal(rollupBoundary(upgradeDb,1,86400,172800,172800,true),0);
upgrade.close();


const root = mkdtempSync(join(tmpdir(), 'risulta-rollup-test-'));
mkdirSync(join(root, 'd1'));
const sqlite = new Database(join(root, 'd1/DB.sqlite'));
const db = adapter(sqlite);
const day = 86400; const start = 10 * day; const today = start + 3 * day; const now = today + 1000;
function worker(maxDays = 100) { return runRollups(db, now, maxDays); }

function normalized(result) {
  const fields = ['paths', 'referrers', 'mediums', 'campaigns'];
  const output = { summary: result.summary, byDay: result.byDay, byHour: result.byHour };
  for (const field of fields) output[field] = result[field].slice().sort((a, b) => a.label.localeCompare(b.label));
  return output;
}
function parity(range, siteId = 1) {
  const site = { id: siteId };
  assert.deepEqual(normalized(dashboardTraffic(db, site, range, now)), normalized(siteAnalytics(db, site, range.since, range.until, false, false, false)));
  assert.deepEqual(dashboardSummary(db, site, range, now), siteSummary(db, siteId, range.since, range.until));
}
try {
  sqlite.exec(legacy + "INSERT INTO sites VALUES(1,'Shop','shop.test','key',0),(2,'Other','other.test','two',0);");
  const insert = sqlite.query('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,NULL)');
  const events = [
    [1,1,start+100,'pageview','/home','same','google','organic','launch'],
    [2,1,start+1900,'signup','/thanks','same','','',''],
    [3,1,start+3701,'pageview','/pricing','same','partner','referral',''],
    [4,1,start+day-1,'pageview','/home','same','','',''],
    [5,1,start+200,'signup','/thanks','custom-only','','',''],
    [6,1,start+300,'signup','/thanks','','','',''],
    [7,1,start+400,'pageview','/home','','','',''],
    [8,1,start+day+1,'pageview','/home','same','google','organic','launch'],
    [9,2,start+100,'pageview','/other','same','google','organic',''],
    [10,1,today+100,'pageview','/home','same','google','organic','launch'],
    [11,1,today+300,'purchase','/thanks','live-custom','','',''],
  ];
  for (const event of events) insert.run(...event);
  sqlite.exec('UPDATE events SET value=10 WHERE id=1;UPDATE events SET value=-4 WHERE id=3;UPDATE events SET value=1.5 WHERE id=8;');
  sqlite.exec("INSERT INTO goals VALUES(1,1,'Views','pageview',''),(2,1,'Home','pageview','/home'),(3,1,'Signup','signup',''),(4,1,'Thanks','signup','/thanks'),(5,1,'Missing','purchase','/missing'),(6,2,'Other','pageview','');INSERT INTO funnels VALUES(1,1,'Signup funnel');INSERT INTO funnel_steps VALUES(1,0,1),(1,1,3);");
  const before = sqlite.query('SELECT * FROM events ORDER BY id').all();
  migrateSchema(db); migrateSchema(db);
  assert.deepEqual(sqlite.query('SELECT * FROM events ORDER BY id').all(), before);
  assert.equal(sqlite.query('SELECT slug FROM sites WHERE id=1').get().slug, 'shop');
  const range = { since: start, until: now + 1, days: 7, filters: {} };
  parity(range);
  assert.equal(worker(1), 1);
  assert.equal(rollupBoundary(db, 1, start, now + 1, now), 0);
  parity(range);
  assert.ok(worker() > 0);
  assert.equal(worker(), 0);
  assert.equal(rollupBoundary(db, 1, start, now + 1, now), today);
  parity(range); parity({ ...range, until: today }); parity(range, 2);
  function statsParity(testRange, id = 1) {
    assert.deepEqual(siteStats(db,{id},testRange,now),siteAnalytics(db,{id},testRange.since,testRange.until));
    assert.deepEqual(dashboardGoals(db,{id},testRange,now),siteGoals(db,id,testRange.since,testRange.until,siteSummary(db,id,testRange.since,testRange.until).visitors));
  }
  statsParity(range); statsParity({...range,until:today}); statsParity({...range,until:start+day+2000});
  statsParity({...range,since:start+50}); statsParity(range,2);
  // Optional sections preserve the corresponding fields and skip unused queries.
  for (const testRange of [range,{...range,since:start+50}]) {
    const expected = siteAnalytics(db,{id:1},testRange.since,testRange.until);
    for (let mask=0;mask<16;mask++) {
      const sections={hourly:!!(mask&1),acquisition:!!(mask&2),goals:!!(mask&4),funnels:!!(mask&8)};
      const statements=[];
      const traced={prepare(sql){statements.push(sql);return db.prepare(sql);}};
      const result=siteStats(traced,{id:1},testRange,now,sections,true);
      const fields=['summary','current','byDay','hasConversions'];
      if(sections.hourly) fields.push('byHour');
      if(sections.acquisition) fields.push('paths','referrers','mediums','campaigns');
      if(sections.goals) fields.push('goals');
      if(sections.funnels) fields.push('funnels','funnelsTruncated');
      assert.deepEqual(result,Object.fromEntries(fields.map(field=>[field,expected[field]])));
      if(!sections.funnels) assert.ok(!statements.some(sql=>sql.includes('ranked AS')));
      if(!sections.acquisition && !sections.goals) assert.ok(!statements.some(sql=>sql.includes('analytics_rollup_dimensions')));
    }
  }
  // New live traffic reuses historical totals, with exact cross-day visitor identity.
  dashboardTraffic(db,{id:1},range,now);
  const prefixBefore=sqlite.query("SELECT revision,created_at,payload FROM analytics_query_cache WHERE query_key LIKE '%traffic-history%' ORDER BY query_key").all();
  insert.run(999,1,now-1,'pageview','/home','same','','','');
  parity(range);statsParity(range);
  assert.deepEqual(sqlite.query("SELECT revision,created_at,payload FROM analytics_query_cache WHERE query_key LIKE '%traffic-history%' ORDER BY query_key").all(),prefixBefore);
  sqlite.exec('DELETE FROM events WHERE id=999');
  // Coverage is separate: missing new summaries fall back, without losing old daily reads.
  sqlite.exec('DELETE FROM analytics_rollup_stats_days WHERE site_id=1 AND day='+start);
  statsParity(range); assert.equal(rollupBoundary(db,1,start,now+1,now,true),0);
  worker(); statsParity(range);
  // Goal edits use immutable event facts, without having to invalidate or rebuild summaries.
  sqlite.exec("UPDATE goals SET path='/home' WHERE id=1;INSERT INTO goals VALUES(7,1,'Late goal','signup','/thanks');");
  statsParity(range);

  for (const dimension of ['path','source','medium','campaign','event']) {
    for (const sort of ['visitors','pageviews','value']) {
      for (const offset of [0,1,100]) {
        const input = {dimension,filters:{},limit:1,offset,sort};
        assert.deepEqual({...dashboardReport(db,{id:1},range,input,true,now),filters:{}},siteReport(db,1,start,now+1,dimension,{},1,offset,sort));
      }
    }
  }

  // Arbitrary boundaries stay raw, and partial historical tails stay exact.
  parity({ ...range, since: start + 50 });
  parity({ ...range, until: start + day + 2000 });
  const filtered = { ...range, filters: { source: 'google' } };
  const filteredResult = dashboardTraffic(db, { id: 1 }, filtered, now);
  assert.equal(filteredResult.summary.pageviews, 5);
  // Mutations invalidate completed days, including site/day moves and deletes.
  insert.run(12,1,start+500,'pageview','/new','new','','','');
  assert.equal(rollupBoundary(db, 1, start, now + 1, now), 0); parity(range);
  // Publishing failure retains previous summaries and dirty markers.
  sqlite.exec("CREATE TRIGGER fail_rollup BEFORE INSERT ON analytics_rollup_dimensions BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  const oldRows = sqlite.query('SELECT * FROM analytics_rollup_visitors ORDER BY site_id,day,visitor').all();
  assert.throws(() => worker(), /test failure/);
  assert.deepEqual(sqlite.query('SELECT * FROM analytics_rollup_visitors ORDER BY site_id,day,visitor').all(), oldRows);
  parity(range);
  sqlite.exec('DROP TRIGGER fail_rollup'); worker(); parity(range);
  sqlite.exec('UPDATE events SET site_id=2,ts=ts+86400 WHERE id=12');
  assert.equal(rollupBoundary(db, 1, start, now + 1, now), 0);
  worker(); parity(range); parity(range, 2); statsParity(range); statsParity(range,2);
  sqlite.exec('DELETE FROM events WHERE site_id=2'); worker(); parity(range, 2); statsParity(range,2);
  assert.deepEqual(sqlite.query('PRAGMA integrity_check').get(), { integrity_check: 'ok' });
} finally { sqlite.close(); rmSync(root, { recursive: true, force: true }); }
console.log('rollups OK (legacy upgrade, restart, migration rollback, backfill, raw parity, exact identities, mutations and atomic publication)');
