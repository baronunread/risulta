import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import app from "../src/index.js";
import { readKeyHash } from "../src/read-api.js";

// Sprout accepts string inputs to digest; Web Crypto in Bun accepts bytes.
const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
crypto.subtle.digest = (algorithm, input) => nativeDigest(algorithm,
  input instanceof Uint8Array ? input : new TextEncoder().encode(String(input)));
const sqlite = new Database(":memory:");
// Exercise production SQL and routing against SQLite, using the D1 interface.
const db = {
  exec(sql) { sqlite.exec(sql); },
  prepare(sql) {
    let values = [];
    const statement = sqlite.prepare(sql);
    return {
      bind(...args) { values = args; return this; },
      first() { return statement.get(...values); },
      all() { return { results: statement.all(...values) }; },
      run() { const result = statement.run(...values); return { meta: { last_row_id: result.lastInsertRowid } }; },
    };
  },
};
globalThis.env = { DB: db, RISULTA_LOG_LEVEL: "info" };
const logs = [];
const originalLog = console.error;
console.error = (...args) => logs.push(args.join(" "));
async function request(path, method = "GET", headers = {}) {
  return await app.fetch(new Request("http://localhost" + path, { method, headers }));
}
try {
  await request("/healthz");
  sqlite.exec("INSERT INTO users (id,email,password_hash,role,created_at) VALUES (1,'admin@test','unused','admin',0),(2,'viewer@test','unused','viewer',0); INSERT INTO sites (id,name,domain,public_key,created_at) VALUES (1,'One','one.test','one',0),(2,'Two','two.test','two',0); INSERT INTO site_users VALUES (2,1,'viewer');");
  const expires = Math.floor(Date.now() / 1000) + 3600;
  sqlite.prepare("INSERT INTO sessions VALUES (?,1,'csrf',0,?)").run(await readKeyHash("admin"), expires);
  sqlite.prepare("INSERT INTO sessions VALUES (?,2,'viewer-csrf',0,?)").run(await readKeyHash("viewer"), expires);
  const admin = { cookie: "risulta_session=admin", "x-csrf-token": "csrf" };
  const viewer = { cookie: "risulta_session=viewer", "x-csrf-token": "viewer-csrf" };
  const keys = "/api/sites/1/read-keys";
  assert.equal((await request(keys, "POST")).status, 401);
  assert.equal((await request(keys, "POST", viewer)).status, 403);
  assert.equal((await request(keys, "POST", { cookie: admin.cookie })).status, 403);
  assert.equal((await request("/api/sites/999/read-keys", "POST", admin)).status, 404);
  const created = await request(keys, "POST", admin);
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("cache-control"), "no-store");
  const key = await created.json();
  assert.match(key.token, /^risulta_read_[0-9a-f]{64}$/);
  const stored = sqlite.prepare("SELECT * FROM read_api_keys").get();
  assert.equal(stored.token_hash, await readKeyHash(key.token));
  assert.ok(!JSON.stringify(stored).includes(key.token));
  const bearer = { authorization: "Bearer " + key.token };
  const listed = await (await request(keys, "GET", admin)).json();
  assert.deepEqual(listed, [{ id: key.id, site_id: 1, created_at: key.created_at }]);
  sqlite.prepare("INSERT INTO events (site_id,ts,name,path,visitor) VALUES (1,?,'pageview','/home','v')").run(Math.floor(Date.now() / 1000));
  for (const endpoint of ["stats", "report"]) {
    const response = await request("/api/sites/1/" + endpoint, "GET", bearer);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), await (await request("/api/sites/1/" + endpoint, "GET", admin)).json());
    assert.equal((await request("/api/sites/2/" + endpoint, "GET", bearer)).status, 401);
    assert.equal((await request("/api/sites/1/" + endpoint + "?from=2020-01-01&to=2026-01-01", "GET", bearer)).status, 400);
    assert.equal((await request("/api/sites/1/" + endpoint, "POST", bearer)).status, 401);
  }
  for (const path of [keys, "/api/sites", "/api/users", "/api/sites/1/goals", "/api/sites/1/funnels", "/api/sites/1/stats/extra"]) {
    assert.equal((await request(path, "GET", bearer)).status, 401);
  }
  assert.equal((await request("/api/backup", "POST", bearer)).status, 401);
  assert.equal((await request("/sites/1", "GET", bearer)).status, 303);
  assert.equal((await request("/api/sites/1/stats?key=" + key.token)).status, 401);
  assert.equal((await request("/api/unknown?authorization=" + encodeURIComponent("Bearer " + key.token))).status, 401);
  assert.equal((await request("/api/sites/1/stats", "GET", { authorization: "Bearer risulta_read_" + "0".repeat(64) })).status, 401);
  assert.equal((await request("/api/sites/1/stats", "GET", viewer)).status, 200);
  assert.equal((await request(keys, "GET", viewer)).status, 403);
  const fullStats=await (await request('/api/sites/1/stats?fresh=1','GET',bearer)).json();
  const trafficStats=await (await request('/api/sites/1/stats?include=traffic&fresh=1','GET',bearer)).json();
  assert.deepEqual(trafficStats.summary,fullStats.summary);
  assert.ok(!('goals' in trafficStats) && !('funnels' in trafficStats) && !('paths' in trafficStats) && !('byHour' in trafficStats));
  const hourlyStats=await (await request('/api/sites/1/stats?include=hourly','GET',bearer)).json();
  assert.deepEqual(hourlyStats.byHour,fullStats.byHour);
  assert.equal((await request('/api/sites/1/stats?include=bogus','GET',bearer)).status,400);
  assert.equal((await request('/api/sites/2/stats?include=traffic','GET',bearer)).status,401);
  const tracedResponse=await request('/api/sites/1/stats?trace=1','GET',admin);
  assert.equal(tracedResponse.status,200);
  assert.match(tracedResponse.headers.get('server-timing'),/db;dur=/);
  const tracedStats=await tracedResponse.json();const trace=tracedStats.trace;delete tracedStats.trace;
  assert.deepEqual(tracedStats,fullStats);
  assert.ok(trace.spans.length>0 && trace.spans.every(span=>Array.isArray(span.plan)));
  assert.ok(!JSON.stringify(trace).includes('admin@test'));
  assert.equal((await request('/api/sites/1/stats?trace=1','GET',viewer)).status,403);
  assert.equal((await request('/api/sites/1/stats?trace=1','GET',bearer)).status,403);
  assert.equal((await request('/api/sites/1/stats?trace=1')).status,401);
  const tracedReport=await (await request('/api/sites/1/report?trace=1','GET',admin)).json();
  assert.ok(tracedReport.trace.spans.length>0);
  delete tracedReport.trace;
  assert.deepEqual(tracedReport,await (await request('/api/sites/1/report?fresh=1','GET',admin)).json());
  assert.equal((await request('/api/sites/1/report?trace=1&format=csv','GET',admin)).status,400);
  assert.ok(!('trace' in fullStats));
  const bounded = await (await request("/api/sites/1/report?limit=99999&offset=99999", "GET", bearer)).json();
  assert.equal(bounded.limit, 100);
  assert.equal(bounded.offset, 10000);
  const fractional = await (await request("/api/sites/1/report?limit=1.5&offset=0.5", "GET", bearer)).json();
  assert.equal(fractional.limit, 1);
  assert.equal(fractional.offset, 0);
  const csv = await request("/api/sites/1/report?format=csv", "GET", bearer);
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /\/home/);
  const revoke = keys + "/" + key.id + "/revoke";
  assert.equal((await request(revoke, "POST", bearer)).status, 401);
  assert.equal((await request(revoke, "POST", viewer)).status, 403);
  assert.equal((await request(revoke, "POST", { cookie: admin.cookie })).status, 403);
  assert.equal((await request("/api/sites/2/read-keys/" + key.id + "/revoke", "POST", admin)).status, 404);
  assert.equal((await request(revoke, "POST", admin)).status, 200);
  assert.equal((await request("/api/sites/1/stats", "GET", bearer)).status, 401);
  assert.equal((await request(revoke, "POST", admin)).status, 404);
  await request("/accidental/" + key.token);
  await request("/accidental?secret=" + key.token);
  assert.ok(!logs.join("\n").includes(key.token));
  assert.ok(!logs.join("\n").includes("Authorization"));
} finally {
  console.error = originalLog;
  sqlite.close();
  crypto.subtle.digest = nativeDigest;
}
console.log("read API credential and route tests passed");
