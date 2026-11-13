// createRisulta(hooks): the interface, its defaults and its failure policy.
// Module state is per process, so every scenario reuses one database and calls
// createRisulta again with another hooks object.
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { createRisulta } from "../src/index.js";
import { HOOKS_VERSION, resolveHooks } from "../src/hooks.js";
import { d1 } from "./d1.mjs";

const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
crypto.subtle.digest = (algorithm, input) => nativeDigest(algorithm, input instanceof Uint8Array ? input : new TextEncoder().encode(String(input)));
const lite = new Database(":memory:");
const env = { DB: d1(lite), RISULTA_ADMIN_EMAIL: "admin@example.com", RISULTA_ADMIN_PASSWORD: "change-me-test-0001" };
const log = console.error;
const logged = [];
console.error = (...args) => { logged.push(args.join(" ")); };

// The interface itself: refuse a wrong version, unknown names and bad migrations.
assert.throws(() => createRisulta({ hooksVersion: HOOKS_VERSION + 1 }), /hooksVersion/);
assert.throws(() => createRisulta({ ingestGard: () => "drop" }), /unknown hook 'ingestGard'/);
assert.throws(() => resolveHooks({ migrations: [{ version: 2, sql: "SELECT 1" }, { version: 2, sql: "SELECT 1" }] }), /strictly increasing/);
assert.throws(() => resolveHooks({ migrations: [{ version: 1 }] }), /strictly increasing/);
const defaults = resolveHooks();
assert.equal(defaults.hooksVersion, HOOKS_VERSION);
assert.deepEqual(defaults.migrations, []);
assert.equal(defaults.ingestGuard, null);

const request = (worker, path, init) => worker.fetch(new Request("http://app.example.test" + path, init), env, {});
async function signIn(worker) {
  const login = await request(worker, "/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password: "change-me-test-0001" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const session = await (await request(worker, "/api/session", { headers: { cookie } })).json();
  return (path, body) => request(worker, path, { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": session.csrf }, body: JSON.stringify(body) });
}

try {
  // Defaults: a plain createRisulta() is the self-hosted app, unlimited.
  let worker = createRisulta();
  let post = await signIn(worker);
  const one = await (await post("/api/sites", { name: "One", domain: "one.example.test" })).json();
  const send = (key, domain) => request(worker, "/api/event/" + key, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ name: "pageview", path: "/", referrer: "", domain }) });
  assert.equal((await send(one.publicKey, "one.example.test")).status, 202);
  const events = () => lite.query("SELECT count(*) AS n FROM events").get().n;
  assert.equal(events(), 1);

  // quota.limits caps websites, and fails open when the hook breaks.
  const created = [];
  let limits = { sites: 2 };
  const envSeen = [];
  worker = createRisulta({ quota: { limits: async (org, e) => { envSeen.push(e); return limits; } }, events: { siteCreated: async (payload) => { created.push(payload); } } });
  post = await signIn(worker);
  assert.equal((await post("/api/sites", { name: "Two", domain: "two.example.test" })).status, 201);
  assert.ok(envSeen.length && envSeen.every((e) => e === env), "the quota hook gets the request's env");
  assert.equal(created.length, 1);
  assert.equal(created[0].site.domain, "two.example.test");
  assert.equal(created[0].orgId, 1);
  const refused = await post("/api/sites", { name: "Three", domain: "three.example.test" });
  assert.equal(refused.status, 402);
  assert.equal(lite.query("SELECT count(*) AS n FROM sites").get().n, 2);
  worker = createRisulta({ quota: { limits: async () => { throw new Error("billing is down"); } }, events: { siteCreated: async () => { throw new Error("mail is down"); } } });
  post = await signIn(worker);
  assert.equal((await post("/api/sites", { name: "Three", domain: "three.example.test" })).status, 201, "a failing quota hook fails open, a failing events hook is contained");
  assert.ok(logged.some((line) => line.includes("quota hook failed")));
  assert.ok(logged.some((line) => line.includes("events.siteCreated hook failed")));

  // ingestGuard: "drop" is answered like a stored event but stores nothing; a throw allows.
  const seen = [];
  worker = createRisulta({ ingestGuard: (site) => { seen.push(site.domain); return site.domain === "one.example.test" ? "drop" : "allow"; } });
  const before = events();
  assert.equal((await send(one.publicKey, "one.example.test")).status, 202);
  assert.equal(events(), before, "dropped");
  assert.deepEqual(seen, ["one.example.test"]);
  const two = lite.query("SELECT public_key FROM sites WHERE domain = 'two.example.test'").get().public_key;
  assert.equal((await send(two, "two.example.test")).status, 202);
  assert.equal(events(), before + 1, "allowed");
  worker = createRisulta({ ingestGuard: () => { throw new Error("guard broke"); } });
  assert.equal((await send(one.publicKey, "one.example.test")).status, 202);
  assert.equal(events(), before + 2, "a failing guard fails open");

  // migrations: the host's own tables, once, in order, in their own ledger.
  worker = createRisulta({ migrations: [{ version: 1, sql: "CREATE TABLE host_accounts (id INTEGER PRIMARY KEY, note TEXT);" }, { version: 2, sql: "ALTER TABLE host_accounts ADD COLUMN plan TEXT NOT NULL DEFAULT 'x'; INSERT INTO host_accounts (note) VALUES ('seed');" }] });
  assert.equal((await request(worker, "/healthz")).status, 200);
  assert.equal(lite.query("SELECT plan FROM host_accounts").get().plan, "x");
  assert.deepEqual(lite.query("SELECT version FROM host_migrations ORDER BY version").all().map((r) => r.version), [1, 2]);
  worker = createRisulta({ migrations: [{ version: 1, sql: "CREATE TABLE host_accounts (id INTEGER PRIMARY KEY, note TEXT);" }, { version: 2, sql: "SELECT 1;" }, { version: 3, sql: "CREATE TABLE host_more (id INTEGER PRIMARY KEY);" }] });
  assert.equal((await request(worker, "/healthz")).status, 200);
  assert.equal(lite.query("SELECT count(*) AS n FROM host_accounts").get().n, 1, "applied versions are not run again");
  assert.deepEqual(lite.query("SELECT version FROM host_migrations ORDER BY version").all().map((r) => r.version), [1, 2, 3]);
  assert.ok(lite.query("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations'").get(), "core's ledger is separate");

  // schedule runs inside the tick; a failure does not stop the tick.
  let ticks = 0;
  worker = createRisulta({ schedule: async (info) => { ticks++; assert.ok(info.now > 0); } });
  await worker.scheduled({}, env, {});
  assert.equal(ticks, 1);
  worker = createRisulta({ schedule: async () => { throw new Error("schedule broke"); } });
  await worker.scheduled({}, env, {});
  assert.ok(logged.some((line) => line.includes("schedule hook failed")));
  console.error = log;
  console.log("hooks OK (version, unknown names, quota, events, ingestGuard, migrations, schedule, fail-open and contained failures)");
} finally {
  console.error = log;
}
