import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANALYTICS_CACHE_SCHEMA, cachedAnalytics } from '../src/analytics-cache.js';
import { migrateSchema } from '../src/migrations.ts';

const root = mkdtempSync(join(tmpdir(),'risulta-cache-'));
const path = join(root,'data.sqlite');
function adapter(sqlite) { return { exec(sql) { sqlite.exec(sql); }, prepare(sql) { const q=sqlite.query(sql);let args=[];return { bind(...values) { args=values;return this; },first() { return q.get(...args); },all() { return {results:q.all(...args)}; },run() { return q.run(...args); } }; } }; }
let sqlite=new Database(path);let db=adapter(sqlite);
try {
  sqlite.exec("CREATE TABLE sites(id INTEGER PRIMARY KEY,name TEXT,domain TEXT,public_key TEXT,created_at INTEGER);CREATE TABLE events(id INTEGER PRIMARY KEY,site_id INTEGER,ts INTEGER,name TEXT,path TEXT,visitor TEXT);CREATE TABLE goals(id INTEGER PRIMARY KEY,site_id INTEGER,name TEXT,event_name TEXT,path TEXT);CREATE TABLE funnels(id INTEGER PRIMARY KEY,site_id INTEGER,name TEXT);CREATE TABLE funnel_steps(funnel_id INTEGER,position INTEGER,goal_id INTEGER);INSERT INTO sites VALUES(1,'One','one.test','one',0),(2,'Two','two.test','two',0);");
  const exec=db.exec;
  db.exec=(sql) => { if(sql===ANALYTICS_CACHE_SCHEMA) exec(sql.split(';')[0]+';INVALID SQL;'); else exec(sql); };
  assert.throws(()=>migrateSchema(db));
  assert.equal(sqlite.query('SELECT max(version) AS n FROM schema_migrations').get().n,3);
  assert.equal(sqlite.query("SELECT count(*) AS n FROM sqlite_master WHERE name='analytics_query_cache'").get().n,0);
  db.exec=exec;migrateSchema(db);migrateSchema(db);
  const range={since:86400,until:172800};const now=260000;let reads=0;
  const read=()=>{reads++;return {n:sqlite.query('SELECT count(*) AS n FROM events WHERE site_id=1 AND ts>=86400 AND ts<172800').get().n};};
  const get=(clock=now,fresh=false,input=null)=>cachedAnalytics(db,1,'stats',range,input,clock,fresh,read);
  assert.deepEqual(get(),{n:0});get();assert.equal(reads,1);
  sqlite.close();sqlite=new Database(path);db=adapter(sqlite);
  get();assert.equal(reads,1,'restart uses persisted result');
  const external=new Database(path);
  external.exec("INSERT INTO events VALUES(1,1,260001,'pageview','/','live');INSERT INTO events VALUES(2,2,86500,'pageview','/','other');");
  get();assert.equal(reads,1,'unrelated days and sites preserve history');
  external.exec("INSERT INTO events VALUES(3,1,86500,'pageview','/','historical');");
  assert.deepEqual(get(),{n:1});assert.equal(reads,2);
  external.exec('UPDATE events SET ts=260000 WHERE id=3');assert.deepEqual(get(),{n:0});
  external.exec('UPDATE events SET ts=86500,site_id=1 WHERE id=2');assert.deepEqual(get(),{n:1});
  external.exec('DELETE FROM events WHERE id=2');assert.deepEqual(get(),{n:0});
  for(const sql of ["INSERT INTO goals VALUES(1,1,'View','pageview','')","UPDATE goals SET path='/home' WHERE id=1","INSERT INTO funnels VALUES(1,1,'Funnel')","INSERT INTO funnel_steps VALUES(1,0,1)","UPDATE funnel_steps SET position=1 WHERE funnel_id=1","DELETE FROM funnel_steps","DELETE FROM funnels","DELETE FROM goals"]) {
    const before=reads;external.exec(sql);get();assert.equal(reads,before+1,sql);
  }
  external.close();
  const before=reads;get(now+86400);assert.equal(reads,before+1,'historical TTL');get(now+86400,true);assert.equal(reads,before+2,'fresh bypass');
  const live=(clock)=>cachedAnalytics(db,1,'stats',{since:259200,until:clock+1},null,clock,false,read);
  const liveBefore=reads;live(now);live(now+1);assert.equal(reads,liveBefore+1);live(now+5);assert.equal(reads,liveBefore+2);
  sqlite.exec("INSERT INTO events VALUES(4,1,260002,'pageview','/','new');");live(now+6);assert.equal(reads,liveBefore+3,'live event invalidates memory snapshot');
  for(let i=0;i<140;i++) get(now,false,i);
  assert.equal(sqlite.query('SELECT count(*) AS n FROM analytics_query_cache').get().n,128);
  cachedAnalytics(db,1,'large',range,null,now,false,()=>({text:'x'.repeat(262145)}));
  assert.equal(sqlite.query("SELECT count(*) AS n FROM analytics_query_cache WHERE query_key LIKE '%large%'").get().n,0);
  const beforeDelete=reads;live(now+6);sqlite.exec('DELETE FROM sites WHERE id=1');live(now+6);assert.equal(reads,beforeDelete+1,'deletion invalidates in-memory results too');assert.equal(sqlite.query('SELECT count(*) AS n FROM analytics_query_cache').get().n,0);
  console.log('analytics cache OK (migration retry, restart, external writes, day/site moves, config, TTL, bypass and bounds)');
} finally { sqlite.close();rmSync(root,{recursive:true,force:true}); }
