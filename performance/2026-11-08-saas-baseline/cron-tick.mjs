// Idle and dirty-day cost of runRollups at N sites (bun:sqlite, in memory). Run: bun performance/2026-11-08-saas-baseline/cron-tick.mjs
import { Database } from "bun:sqlite";
import { runRollups } from "../../src/maintenance.js";
import { migrateSchema } from "../../src/migrations.ts";
function adapter(s){return{exec(q){s.exec(q)},prepare(q){const x=s.query(q);let a=[];return{bind(...v){a=v;return this},first(){return x.get(...a)},all(){return{results:x.all(...a)}},run(){return x.run(...a)}}}}}
const legacy="CREATE TABLE sites(id INTEGER PRIMARY KEY,name TEXT,domain TEXT UNIQUE,public_key TEXT UNIQUE,created_at INTEGER);CREATE TABLE events(id INTEGER PRIMARY KEY,site_id INTEGER,ts INTEGER,name TEXT,path TEXT,referrer TEXT DEFAULT '',visitor TEXT,source TEXT,medium TEXT,campaign TEXT,content TEXT DEFAULT '',term TEXT DEFAULT '',value REAL);CREATE TABLE goals(id INTEGER PRIMARY KEY,site_id INTEGER,name TEXT,event_name TEXT,path TEXT);CREATE TABLE funnels(id INTEGER PRIMARY KEY,site_id INTEGER,name TEXT);CREATE TABLE funnel_steps(funnel_id INTEGER,position INTEGER,goal_id INTEGER);";
const now = Math.floor(Date.now()/1000), today = Math.floor(now/86400)*86400;
for (const N of [10,100,1000]) {
  const s = new Database(":memory:"); s.exec(legacy); const db = adapter(s); migrateSchema(db);
  s.exec("BEGIN");
  const ins = s.query("INSERT INTO sites(id,name,domain,public_key,created_at) VALUES(?,?,?,?,0)"), ev = s.query("INSERT INTO events(site_id,ts,name,path,visitor,source,medium,campaign) VALUES(?,?,?,?,?,?,?,?)");
  for (let i=1;i<=N;i++){ ins.run(i,"s"+i,"d"+i+".x","k"+i); for(let d=1;d<=90;d++) ev.run(i,today-d*86400+100,"pageview","/","v"+d,"","",""); }
  s.exec("COMMIT");
  let t=performance.now(); let built=0; while((built=runRollups(db,now,1000))>0); const full=performance.now()-t;
  const times=[]; for(let k=0;k<20;k++){const a=performance.now(); runRollups(db,now); times.push(performance.now()-a);} times.sort((a,b)=>a-b);
  // dirty-day: one new event yesterday for 1 site
  s.query("INSERT INTO events(site_id,ts,name,path,visitor,source,medium,campaign) VALUES(1,?,?,?,?,?,?,?)").run(today-86400+500,"pageview","/","vx","","","");
  const b=performance.now(); runRollups(db,now); const one=performance.now()-b;
  console.log(JSON.stringify({sites:N,history_days:90,initial_backfill_ms:Math.round(full),idle_tick_median_ms:+times[10].toFixed(2),idle_tick_max_ms:+times[19].toFixed(2),one_dirty_day_tick_ms:+one.toFixed(2)}));
}
// build cost of one day with 3300 events (about 100k/month site)
const s=new Database(":memory:"); s.exec(legacy); const db=adapter(s); migrateSchema(db);
s.exec("INSERT INTO sites(id,name,domain,public_key,created_at) VALUES(1,'a','a.x','k',0)"); const ev=s.query("INSERT INTO events(site_id,ts,name,path,visitor,source,medium,campaign) VALUES(1,?,?,?,?,?,?,?)");
for(const n of [3300,33000]){ s.exec("DELETE FROM events"); s.exec("DELETE FROM analytics_rollup_days");
 for(let i=0;i<n;i++) ev.run(today-86400+(i*26%86400),"pageview","/p"+(i%200),"v"+(i%(n/2.5|0)),["","google","hn"][i%3],"","");
 const a=performance.now(); runRollups(db,now,1); console.log(JSON.stringify({events_in_day:n,build_one_day_ms:+(performance.now()-a).toFixed(1)}));}
