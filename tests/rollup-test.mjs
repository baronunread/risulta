import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { migrateSchema } from '../src/migrations.ts';
import { ROLLUP_SCHEMA, rollupBoundary } from '../src/rollups.ts';
import { dashboardTraffic, dashboardSummary, siteAnalytics, siteSummary, dashboardReport, siteReport } from '../src/store.js';

function adapter(sqlite) {
  return { exec(sql) { sqlite.exec(sql); }, prepare(sql) {
    const query = sqlite.query(sql); let args = [];
    return { bind(...values) { args = values; return this; }, first() { return query.get(...args); },
      all() { return { results: query.all(...args) }; }, run() { return query.run(...args); } };
  } };
}
const legacy = "CREATE TABLE sites(id INTEGER PRIMARY KEY,name TEXT,domain TEXT UNIQUE,public_key TEXT UNIQUE,created_at INTEGER);" +
  "CREATE TABLE events(id INTEGER PRIMARY KEY,site_id INTEGER,ts INTEGER,name TEXT,path TEXT,visitor TEXT,source TEXT,medium TEXT,campaign TEXT,value REAL);" +
  "CREATE TABLE goals(id INTEGER PRIMARY KEY,site_id INTEGER,name TEXT,event_name TEXT,path TEXT);CREATE TABLE funnels(id INTEGER PRIMARY KEY,site_id INTEGER,name TEXT);";

// A failed step rolls back its DDL and marker, and a restart resumes safely.
const failure = new Database(':memory:'); failure.exec(legacy);
const failingDb = adapter(failure);
const exec = failingDb.exec;
failingDb.exec = (sql) => { if (sql === ROLLUP_SCHEMA) exec(sql.split(';')[0] + '; INVALID SQL;'); else exec(sql); };
assert.throws(() => migrateSchema(failingDb));
assert.equal(failure.query('SELECT max(version) AS n FROM schema_migrations').get().n, 1);
assert.equal(failure.query("SELECT count(*) AS n FROM sqlite_master WHERE name='analytics_rollup_days'").get().n, 0);
failingDb.exec = exec; migrateSchema(failingDb); migrateSchema(failingDb);
assert.equal(failure.query('SELECT count(*) AS n FROM schema_migrations').get().n, 2);
failure.exec("INSERT INTO schema_migrations VALUES(3,'future',0)");
assert.throws(() => migrateSchema(failingDb), /newer Risulta/);
failure.close();

const root = mkdtempSync(join(tmpdir(), 'risulta-rollup-test-'));
mkdirSync(join(root, 'd1'));
const sqlite = new Database(join(root, 'd1/DB.sqlite'));
const db = adapter(sqlite);
const day = 86400; const start = 10 * day; const today = start + 3 * day; const now = today + 1000;
function worker(maxDays = 100) {
  const result = spawnSync('python3', ['-c', "import importlib.util; s=importlib.util.spec_from_file_location('rollups','deploy/rollup-runner.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.run(__import__('sys').argv[1],now=int(__import__('sys').argv[2]),max_days=int(__import__('sys').argv[3])))", root, String(now), String(maxDays)], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return Number(result.stdout.trim());
}
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
  worker(); parity(range); parity(range, 2);
  sqlite.exec('DELETE FROM events WHERE site_id=2'); worker(); parity(range, 2);
  assert.deepEqual(sqlite.query('PRAGMA integrity_check').get(), { integrity_check: 'ok' });
} finally { sqlite.close(); rmSync(root, { recursive: true, force: true }); }
console.log('rollups OK (legacy upgrade, restart, migration rollback, backfill, raw parity, exact identities, mutations and atomic publication)');
