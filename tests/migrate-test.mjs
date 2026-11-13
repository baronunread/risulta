// End to end: a source snapshot, the real tools/migrate.mjs, and the real routes
// served over HTTP, with the shared registry and the org store in two separate
// SQLite files. If any query joined across them, or any events query bypassed
// store(), this fails.
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRisulta } from "../src/index.js";
import { d1 } from "./d1.mjs";

const root = mkdtempSync(join(tmpdir(), "risulta-migrate-test-"));
const token = "t".repeat(40);
const sharedLite = new Database(":memory:");
const eventsLite = new Database(":memory:");
const env = {
  DB: d1(sharedLite), EVENTS_DB: d1(eventsLite), RISULTA_IMPORT_TOKEN: token,
  RISULTA_TRACKER_ORIGIN: "https://t.example.test", RISULTA_TRACKER_HOSTS: "t.example.test,stats.example.test",
  RISULTA_ADMIN_EMAIL: "admin@example.com", RISULTA_ADMIN_PASSWORD: "change-me-test-0001",
};
const worker = createRisulta();
const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
crypto.subtle.digest = (algorithm, input) => nativeDigest(algorithm, input instanceof Uint8Array ? input : new TextEncoder().encode(String(input)));
const server = Bun.serve({ port: 0, fetch: (request) => worker.fetch(request, env, {}) });
const base = "http://127.0.0.1:" + server.port;
const names = (db) => new Set(db.query("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
async function run(...args) {
  const proc = Bun.spawn(["bun", "tools/migrate.mjs", ...args], { env: { ...process.env, RISULTA_IMPORT_TOKEN: token }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}
try {
  const source = join(root, "source.sqlite");
  const fixture = Bun.spawnSync(["bun", "scripts/migration-fixture.mjs", source, "4000"]);
  assert.equal(fixture.exitCode, 0);
  assert.equal((await fetch(base + "/healthz")).status, 200);
  // The two stores hold disjoint tables.
  const shared = names(sharedLite);
  const events = names(eventsLite);
  for (const table of ["sites", "users", "sessions", "site_users", "read_api_keys", "public_widgets"]) assert.ok(shared.has(table) && !events.has(table), table + " belongs to the shared store");
  for (const table of ["events", "goals", "funnels", "funnel_steps", "annotations", "site_salts", "analytics_rollup_days", "analytics_query_cache"]) assert.ok(events.has(table) && !shared.has(table), table + " belongs to the org store");

  const plan = await run("plan", "--from", source);
  assert.equal(plan.code, 0);
  assert.match(plan.out, /sproutboat\.com[^\n]*events/);
  const copied = await run("copy", "--from", source, "--to", base, "--lineage", "stats.example.test", "--chunk", "700");
  assert.equal(copied.code, 0, copied.err + copied.out);
  assert.match(copied.out, /sites: 2 created/);
  // Tracker keys survive; ids are the target's own.
  const keys = sharedLite.query("SELECT public_key, domain FROM sites ORDER BY id").all().map((r) => r.public_key + " " + r.domain);
  assert.deepEqual(keys, ["82f052fad621762871090faa6472f30c sproutboat.com", "0a1b2c3d4e5f60718293a4b5c6d7e8f9 risulta.dev"]);
  assert.equal(sharedLite.query("SELECT enabled FROM public_widgets").get().enabled, 1);
  assert.equal(eventsLite.query("SELECT count(*) AS n FROM events").get().n, new Database(source, { readonly: true }).query("SELECT count(*) AS n FROM events").get().n);
  assert.equal(eventsLite.query("SELECT count(*) AS n FROM funnel_steps").get().n, 2);
  assert.equal(eventsLite.query("SELECT count(*) AS n FROM annotations").get().n, 2);
  // Rollups: verify sees them pending, finalize builds them, verify then passes.
  const finalized = await run("finalize", "--to", base, "--lineage", "stats.example.test");
  assert.equal(finalized.code, 0, finalized.err);
  const verified = await run("verify", "--from", source, "--to", base, "--lineage", "stats.example.test");
  assert.equal(verified.code, 0, verified.out);
  assert.match(verified.out, /sproutboat\.com: ok/);
  // A resumed copy sends nothing and a late event on a completed day is caught, then rebuilt.
  assert.match((await run("copy", "--from", source, "--to", base, "--lineage", "stats.example.test")).out, /0 events sent/);
  const later = join(root, "later.sqlite");
  Bun.spawnSync(["cp", source, later]);
  const lite = new Database(later);
  lite.query("INSERT INTO events (site_id,ts,name,path,referrer,visitor,source,medium,campaign,content,term,value) VALUES (3,?,'pageview','/','','late','','','','','',NULL)").run(Math.floor(Date.now() / 1000) - 4 * 86400);
  lite.close();
  assert.equal((await run("copy", "--from", later, "--to", base, "--lineage", "stats.example.test")).code, 0);
  assert.notEqual((await run("verify", "--from", later, "--to", base, "--lineage", "stats.example.test")).code, 0, "stale rollup day is reported");
  assert.equal((await run("finalize", "--to", base, "--lineage", "stats.example.test")).code, 0);
  assert.equal((await run("verify", "--from", later, "--to", base, "--lineage", "stats.example.test")).code, 0);
  // Refusals: the same keys under another lineage, a wrong token, an unset token.
  const clash = await run("copy", "--from", source, "--to", base, "--lineage", "someone-else");
  assert.notEqual(clash.code, 0);
  assert.match(clash.err, /already in use/);
  assert.equal((await fetch(base + "/api/migrate/verify?lineage=x", { headers: { authorization: "Bearer " + "x".repeat(40) } })).status, 401);
  assert.equal((await fetch(base + "/api/migrate/verify?lineage=x")).status, 401);
  const off = createRisulta();
  assert.equal((await off.fetch(new Request("http://localhost/api/migrate/verify?lineage=x"), { ...env, RISULTA_IMPORT_TOKEN: "short" }, {})).status, 404);
  // Tracker hosts answer tracker routes only; the app host answers everything.
  const asHost = (host, path, init) => fetch(base + path, { ...init, headers: { ...(init && init.headers), host } });
  assert.equal((await asHost("stats.example.test", "/js/82f052fad621762871090faa6472f30c.js")).status, 200);
  assert.equal((await asHost("stats.example.test", "/login")).status, 404);
  assert.equal((await asHost("t.example.test", "/api/migrate/verify?lineage=x", { headers: { authorization: "Bearer " + token } })).status, 404);
  assert.equal((await asHost("app.example.test", "/login")).status, 200);
  const post = await asHost("stats.example.test", "/api/event/82f052fad621762871090faa6472f30c", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ name: "pageview", path: "/docs", referrer: "", domain: "sproutboat.com" }) });
  assert.equal(post.status, 202);
  assert.equal(post.headers.get("access-control-allow-origin"), "*");
  assert.equal(eventsLite.query("SELECT count(*) AS n FROM events WHERE path='/docs'").get().n, 1);
  assert.equal(sharedLite.query("SELECT count(*) AS n FROM sqlite_master WHERE name='events'").get().n, 0);
  // The snapshot of a moved instance exports back in the same shape.
  const exported = await (await fetch(base + "/api/migrate/export/sites", { headers: { authorization: "Bearer " + token } })).json();
  assert.equal(exported.sites.length, 2);
  assert.deepEqual(exported.sites[0].funnels[0].steps, ["Docs read", "Signup"]);
  console.log("migration OK (two stores, key preservation, resume, rollup verification, refusals, tracker hosts, export)");
} finally {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
