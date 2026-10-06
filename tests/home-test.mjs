import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { homeOverviews } from "../src/store.js";
import { homeCards } from "../src/home.js";
const sqlite = new Database(":memory:");
sqlite.exec("CREATE TABLE sites(id INTEGER PRIMARY KEY,name TEXT,domain TEXT); CREATE TABLE site_users(user_id INTEGER,site_id INTEGER); CREATE TABLE events(site_id INTEGER,ts INTEGER,name TEXT,visitor TEXT); INSERT INTO sites VALUES(1,'Shop <test>','shop.example'),(2,'Private','private.example'),(3,'Empty','empty.example'); INSERT INTO site_users VALUES(7,1),(7,3); INSERT INTO events VALUES(1,86410,'pageview','a'),(1,86411,'pageview','a'),(1,172810,'pageview','b'),(1,172811,'signup','b'),(2,172810,'pageview','private'),(1,604801,'pageview','future');");
let queries = 0;
const db = { prepare(sql) { queries++; const stmt = sqlite.prepare(sql); let params = []; return { bind(...args) { params = args; return this; }, all() { return { results: stmt.all(...params) }; } }; } };
try {
  const sites = homeOverviews(db, { role: "viewer", user_id: 7 }, 604800);
  assert.equal(queries, 2, "Home traffic uses two queries regardless of card count");
  assert.deepEqual(sites.map(s => s.id), [3, 1]);
  const shop = sites[1].overview;
  assert.equal(shop.visitors, 2);
  assert.equal(shop.pageviews, 3);
  assert.equal(shop.byDay.length, 7);
  assert.deepEqual(shop.byDay.map(row => row.visitors), [1, 1, 0, 0, 0, 0, 0]);
  assert.ok(sites[0].overview.byDay.every(row => !row.visitors && !row.pageviews));
  const html = homeCards(sites);
  assert.ok(html.includes('Shop &lt;test&gt;'));
  assert.equal((html.match(/class="home-sparkline"/g) || []).length, 2);
  assert.ok(!html.includes('NaN'));
  assert.ok(!html.includes('private.example'));
  assert.ok(homeOverviews(db, { role: "admin" }, 604800).some(site => site.id === 2));
  assert.deepEqual(homeOverviews(db, { role: "viewer", user_id: 99 }, 604800), []);
} finally { sqlite.close(); }
console.log("home OK");
