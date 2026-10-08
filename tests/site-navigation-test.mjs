import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import app from '../src/index.js';
import { ensureSiteSlugs, availableSiteSlug } from '../src/sites.ts';
import { siteGoals, siteForKey } from '../src/store.js';
import { readKeyHash } from '../src/read-api.js';
const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
crypto.subtle.digest = (algorithm,input)=>nativeDigest(algorithm,input instanceof Uint8Array ? input : new TextEncoder().encode(String(input)));
const sqlite=new Database(':memory:');
sqlite.exec("CREATE TABLE sites(id INTEGER PRIMARY KEY,name TEXT,domain TEXT UNIQUE,public_key TEXT UNIQUE,created_at INTEGER); INSERT INTO sites VALUES(1,'Shop','shop.test','one',0),(2,'Other Shop','shop.example','two',0),(3,'Blog','www.blog.test','three',0),(4,'New','new.test','four',0),(5,'Numbers','123.test','five',0);");
const db={exec(sql){sqlite.exec(sql)},prepare(sql){const stmt=sqlite.query(sql);let args=[];return{bind(...values){args=values;return this},first(){return stmt.get(...args)},all(){return{results:stmt.all(...args)}},run(){const r=stmt.run(...args);return{meta:{last_row_id:r.lastInsertRowid}}}}}};
globalThis.env={DB:db};
async function request(path,token='admin',body,csrf=true){const headers={cookie:'risulta_session='+token};if(body!==undefined){headers['content-type']='application/x-www-form-urlencoded';if(csrf)headers['x-csrf-token']='csrf';}const req=new Request('http://localhost'+path,{method:body===undefined?'GET':'POST',headers});if(body!==undefined)Object.defineProperty(req,'body',{value:body});return app.fetch(req);}
try{
 await app.fetch(new Request('http://localhost/healthz'));
 assert.deepEqual(sqlite.query('SELECT slug FROM sites ORDER BY id').all().map(r=>r.slug),['shop','shop-2','blog','site-new','site-123']);
 assert.equal(availableSiteSlug(db,'shop.other'),'shop-3');
 sqlite.exec("UPDATE sites SET name='Renamed',domain='renamed.test' WHERE id=1");ensureSiteSlugs(db);
 assert.equal(sqlite.query('SELECT slug FROM sites WHERE id=1').get().slug,'shop');
 sqlite.exec("INSERT INTO users(id,email,password_hash,role,created_at) VALUES(1,'admin@test','unused','admin',0),(2,'viewer@test','unused','viewer',0); INSERT INTO site_users VALUES(2,1,'viewer');");
 for(const [token,id] of [['admin',1],['viewer',2]]) sqlite.query('INSERT INTO sessions VALUES(?,?,?,0,?)').run(await readKeyHash(token),id,'csrf',Math.floor(Date.now()/1000)+3600);
 for(const [oldPath,newPath] of [['/sites/1?period=30','/sites/shop?period=30'],['/sites/1/settings?source=google','/sites/shop/settings?source=google'],['/sites/1/settings?error=funnel-steps-invalid','/sites/shop/settings?error=funnel-steps-invalid'],['/sites/shop/conversions?period=1','/sites/shop/goals?period=1']]){const r=await request(oldPath);assert.equal(r.status,308);assert.equal(r.headers.get('location'),newPath);}
 assert.equal((await request('/sites/shop/settings')).status,200);
 for(const suffix of ['','/goals','/funnels','/reports','/reports/journeys','/partials/live','/partials/goals']){
  assert.equal((await request('/sites/shop'+suffix,'viewer')).status,200,suffix);
  const denied=await request('/sites/shop-2'+suffix,'viewer');assert.equal(denied.status,404);assert.equal(denied.headers.get('location'),null);
 }
 const overview=await(await request('/sites/shop')).text();assert.ok(overview.includes('Copy tracker code'));assert.ok(!overview.includes('Website settings'));assert.ok(overview.includes('/sites/shop/goals'));assert.ok(overview.includes('/sites/shop/funnels'));
 const viewerGoals=await(await request('/sites/shop/goals','viewer')).text();assert.ok(!viewerGoals.includes('id="goal-name"'));
 const viewerFunnels=await(await request('/sites/shop/funnels','viewer')).text();assert.ok(!viewerFunnels.includes('id="funnel-name"'));
 const goalBody='name=Signup&event_name=signup&return_query=period%3D30%26source%3Dgoogle';
 assert.equal((await request('/api/sites/1/goals','viewer',goalBody)).status,403);
 assert.equal((await request('/api/sites/1/goals','admin',goalBody,false)).status,403);
 const created=await request('/api/sites/1/goals','admin',goalBody);assert.equal(created.headers.get('location'),'/sites/shop/goals?period=30&source=google');
 const duplicate=await request('/api/sites/1/goals','admin',goalBody);assert.equal(duplicate.headers.get('location'),'/sites/shop/goals?period=30&source=google&error=goal-name-registered');
 await request('/api/sites/1/goals','admin','name=Purchase&event_name=purchase');
 const funnel=await request('/api/sites/1/funnels','admin','name=Checkout&goal=1&goal=2&goal=&return_query=period%3D30');assert.equal(funnel.headers.get('location'),'/sites/shop/funnels?period=30');
 assert.equal(sqlite.query('SELECT count(*) n FROM funnel_steps').get().n,2);
 const goals=await(await request('/sites/shop/goals')).text();assert.ok(goals.includes('Signup'));assert.ok(goals.includes('Create a goal'));assert.ok(!goals.includes('id="funnel-name"'));
 const funnels=await(await request('/sites/shop/funnels')).text();assert.ok(funnels.includes('Checkout'));assert.ok(funnels.includes('Create a funnel'));assert.ok(!funnels.includes('id="goal-name"'));
 sqlite.exec("INSERT INTO goals(site_id,name,event_name,path,created_at) VALUES(1,'Exact signup','signup','/checkout',0); INSERT INTO events(site_id,ts,name,path,visitor,value) VALUES(1,100,'signup','/checkout','a',10),(1,120,'signup','/elsewhere','a',-4),(2,110,'signup','/checkout','other',99),(1,1000,'signup','/checkout','future',99)");
 const aggregate=siteGoals(db,1,0,1000,2);
 assert.deepEqual(aggregate.find(g=>g.name==='Signup'),{name:'Signup',event_name:'signup',path:'',conversions:2,unique_conversions:1,value:6,conversion_rate:0.5});
 const exact=aggregate.find(g=>g.name==='Exact signup');assert.equal(exact.conversions,1);assert.equal(exact.value,10);
 assert.equal(aggregate.find(g=>g.name==='Purchase').conversions,0);
 const settings=await(await request('/sites/shop/settings')).text();assert.ok(settings.includes('shell website-dashboard settings-page'));assert.ok(settings.includes('<h1>Settings</h1>'));assert.ok(settings.includes('Save hostname'));
 const viewerSettings=await(await request('/sites/shop/settings','viewer')).text();assert.ok(!viewerSettings.includes('Save hostname'));
 assert.equal((await request('/sites/shop-2/settings','viewer')).status,404);
 assert.equal((await request('/api/sites/1/domain','viewer','domain=moved.test')).status,403);
 assert.equal((await request('/api/sites/1/domain','admin','domain=moved.test',false)).status,403);
 assert.ok((await request('/api/sites/1/domain','admin','domain=bad!')).headers.get('location').includes('domain-invalid'));
 assert.ok((await request('/api/sites/1/domain','admin','domain=shop.example')).headers.get('location').includes('domain-registered'));
 const eventsBefore=sqlite.query('SELECT count(*) n FROM events WHERE site_id=1').get().n;
 assert.equal(siteForKey(db,'one').domain,'renamed.test');
 const moved=await request('/api/sites/1/domain','admin','domain=https%3A%2F%2Fmoved.test');assert.equal(moved.headers.get('location'),'/sites/shop/settings?saved=1');
 assert.deepEqual(sqlite.query('SELECT domain,public_key,slug FROM sites WHERE id=1').get(),{domain:'moved.test',public_key:'one',slug:'shop'});
 assert.equal(siteForKey(db,'one').domain,'moved.test');
 assert.equal(sqlite.query('SELECT count(*) n FROM events WHERE site_id=1').get().n,eventsBefore);
 const unauthenticated=await app.fetch(new Request('http://localhost/sites/shop/goals'));assert.equal(unauthenticated.status,303);
 const home=await(await request('/')).text();assert.ok(home.includes('/sites/shop'));assert.ok(!home.includes('href="/sites/1"'));
 console.log('site navigation OK (migration, stable collision-safe slugs, legacy redirects, permissions, CSRF and goal/funnel creation)');
}finally{sqlite.close();crypto.subtle.digest=nativeDigest;}
