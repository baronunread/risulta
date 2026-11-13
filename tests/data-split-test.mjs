// Every events/rollups query goes through store(orgId), and the registry through
// shared(). Run the whole app with the two as separate SQLite databases: a
// query that reached across them, or an events query that used env.DB, fails.
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { createRisulta } from "../src/index.js";
import { createFunnel } from "../src/store.js";
import { d1 } from "./d1.mjs";

const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
crypto.subtle.digest = (algorithm, input) => nativeDigest(algorithm, input instanceof Uint8Array ? input : new TextEncoder().encode(String(input)));
const sharedLite = new Database(":memory:");
const eventsLite = new Database(":memory:");
const env = {
  DB: d1(sharedLite), EVENTS_DB: d1(eventsLite),
  RISULTA_ADMIN_EMAIL: "admin@example.com", RISULTA_ADMIN_PASSWORD: "change-me-test-0001",
  RISULTA_TRACKER_ORIGIN: "https://cdn.example.test", RISULTA_TRACKER_HOSTS: "cdn.example.test",
};
const worker = createRisulta();
const call = (path, init) => worker.fetch(new Request("http://app.example.test" + path, init), env, {});
const tables = (db) => new Set(db.query("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
const log = console.error;
console.error = () => {};
try {
  assert.equal((await call("/healthz")).status, 200);
  const shared = tables(sharedLite);
  const events = tables(eventsLite);
  for (const table of ["sites", "users", "sessions", "site_users", "read_api_keys", "public_widgets", "backup_settings"]) assert.ok(shared.has(table) && !events.has(table), table + " is shared");
  for (const table of ["events", "goals", "funnels", "funnel_steps", "annotations", "site_salts", "analytics_rollup_days", "analytics_rollup_dirty", "analytics_query_cache"]) assert.ok(events.has(table) && !shared.has(table), table + " is org data");

  const login = await call("/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password: "change-me-test-0001" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const session = await (await call("/api/session", { headers: { cookie } })).json();
  const post = (path, body) => call(path, { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": session.csrf }, body: JSON.stringify(body) });
  const site = await (await post("/api/sites", { name: "Shop", domain: "shop.example.test" })).json();
  assert.equal(site.slug, "shop");
  assert.equal(sharedLite.query("SELECT count(*) AS n FROM sites").get().n, 1);

  const send = (body, host) => call("/api/event/" + site.publicKey, { method: "POST", headers: { "content-type": "text/plain", host: host || "app.example.test" }, body: JSON.stringify(body) });
  assert.equal((await send({ name: "pageview", path: "/", referrer: "", domain: "shop.example.test" })).status, 202);
  assert.equal((await send({ name: "signup", path: "/thanks", referrer: "", domain: "shop.example.test" })).status, 202);
  assert.equal(eventsLite.query("SELECT count(*) AS n FROM events").get().n, 2);
  assert.equal(eventsLite.query("SELECT count(*) AS n FROM site_salts").get().n, 1);

  assert.equal((await post("/api/sites/" + site.id + "/goals", { name: "Signup", eventName: "signup" })).status, 201);
  const goal = eventsLite.query("SELECT id FROM goals").get().id;
  await createFunnel(env.EVENTS_DB, site.id, "Path", [goal]);
  assert.equal((await post("/api/sites/" + site.id + "/annotations", { day: new Date().toISOString().slice(0, 10), text: "Launch" })).status, 200);
  assert.equal(eventsLite.query("SELECT count(*) AS n FROM annotations").get().n, 1);
  const stats = await (await call("/api/sites/" + site.id + "/stats?period=7", { headers: { cookie } })).json();
  assert.equal(stats.summary.pageviews, 1);
  assert.equal(stats.goals[0].conversions, 1);
  for (const page of ["/", "/sites/shop", "/sites/shop/goals", "/sites/shop/funnels", "/sites/shop/reports", "/sites/shop/setup"]) {
    const response = await call(page, { headers: { cookie } });
    assert.equal(response.status, 200, page);
    if (page === "/sites/shop/setup") assert.ok((await response.text()).includes("https://cdn.example.test/js/" + site.publicKey), "snippet uses the tracker origin");
  }
  assert.equal((await post("/api/sites/" + site.id + "/public-widget", { enabled: true })).status < 400, true);
  assert.equal(sharedLite.query("SELECT enabled FROM public_widgets").get().enabled, 1);
  const widget = await (await call("/public/data/" + site.publicKey)).json();
  assert.equal(widget.pageviews, 1);

  // The tick works through the org's rollups and leaves the registry store alone.
  eventsLite.query("INSERT INTO events (site_id,ts,name,path,visitor) VALUES (?,?,'pageview','/old','v')").run(site.id, Math.floor(Date.now() / 1000) - 3 * 86400);
  await worker.scheduled({}, env, {});
  assert.ok(eventsLite.query("SELECT count(*) AS n FROM analytics_rollup_days").get().n >= 1, "rollups built in the org store");
  assert.equal(sharedLite.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'analytics_%'").get().n, 0);
  // Tracker hosts: routes outside the tracker set do not exist there.
  const onTracker = await worker.fetch(new Request("http://cdn.example.test/login"), env, {});
  assert.equal(onTracker.status, 404);
  console.error = log;
  console.log("data layer OK (registry and org store as separate databases: collector, auth, goals, funnels, notes, stats, pages, widget)");
} finally {
  console.error = log;
}
