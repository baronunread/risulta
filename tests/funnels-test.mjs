import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { siteFunnels } from '../src/store.js';

const sqlite = new Database(':memory:');
sqlite.exec("CREATE TABLE events(id INTEGER PRIMARY KEY,site_id INTEGER,ts INTEGER,name TEXT,path TEXT,visitor TEXT);CREATE TABLE goals(id INTEGER PRIMARY KEY,site_id INTEGER,name TEXT,event_name TEXT,path TEXT);CREATE TABLE funnels(id INTEGER PRIMARY KEY,site_id INTEGER,name TEXT);CREATE TABLE funnel_steps(funnel_id INTEGER,position INTEGER,goal_id INTEGER);");
const db = { prepare(sql) { const q = sqlite.query(sql); let args = []; return { bind(...values) { args = values; return this; }, first() { return q.get(...args); }, all() { return { results: q.all(...args) }; } }; } };
sqlite.exec("INSERT INTO goals VALUES(1,1,'View','pageview',''),(2,1,'Signup','signup','/thanks'),(3,1,'Purchase','purchase','');INSERT INTO funnels VALUES(1,1,'Conversion'),(2,1,'Repeated views'),(3,1,'Empty');INSERT INTO funnel_steps VALUES(1,0,1),(1,1,2),(1,2,3),(2,0,1),(2,1,1);");
const insert = sqlite.query('INSERT INTO events VALUES(?,?,?,?,?,?)');
const names = ['purchase','pageview','signup','pageview','signup'];
sqlite.transaction(() => { for (let i = 0; i < 1500; i++) insert.run(i + 1, i % 11 ? 1 : 2, i, names[i % names.length], i % 3 ? '/thanks' : '/wrong', i % 13 ? 'visitor' + (i % 23) : ''); })();
// Reference the previous event-by-event algorithm independently of the SQL implementation.
function expected(steps, since, until) {
  const positions = new Map(); const counts = steps.map(() => 0);
  const events = sqlite.query('SELECT visitor,name,path FROM events WHERE site_id=1 AND ts>=? AND ts<? ORDER BY visitor,ts LIMIT 50000').all(since, until);
  for (const event of events) {
    const position = positions.get(event.visitor) || 0; const step = steps[position];
    if (!step || event.name !== step.name || (step.path && step.path !== event.path)) continue;
    counts[position]++; positions.set(event.visitor, position + 1);
  }
  return counts;
}
for (const [since, until] of [[0,1500],[115,997],[1600,1800]]) {
  const result = siteFunnels(db, 1, since, until);
  assert.deepEqual(result.funnels[0].steps.map((step) => step.conversions), expected([{name:'pageview',path:''},{name:'signup',path:'/thanks'},{name:'purchase',path:''}], since, until));
  assert.deepEqual(result.funnels[1].steps.map((step) => step.conversions), expected([{name:'pageview',path:''},{name:'pageview',path:''}], since, until));
  assert.deepEqual(result.funnels[2].steps, []);
  assert.equal(result.truncated, false);
}
sqlite.exec('DELETE FROM events');
sqlite.transaction(() => { for (let i = 0; i < 50002; i++) insert.run(i + 1,1,i,'pageview','/','one'); })();
assert.equal(siteFunnels(db,1,0,50002).truncated,true);
assert.equal(siteFunnels(db,1,0,49999).truncated,false);
assert.deepEqual(siteFunnels(db,2,0,50002),{funnels:[],truncated:false});
console.log('funnels OK (reference parity, repeated steps, ordering, paths, ranges, isolation and cap)');
sqlite.close();
