// The real app: once an instance is moving or has moved, websites cannot be added or renamed
// (the target holds the list the move sent), and nothing changes for an instance that never connects.
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { createRisulta } from "../../src/index.js";
import { ensureSchema } from "../../src/move/schema.js";
import { d1 } from "../d1.mjs";

const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
crypto.subtle.digest = (algorithm, input) => nativeDigest(algorithm, input instanceof Uint8Array ? input : new TextEncoder().encode(String(input)));
const lite = new Database(":memory:");
const env = { DB: d1(lite), RISULTA_ADMIN_EMAIL: "admin@example.com", RISULTA_ADMIN_PASSWORD: "change-me-test-0001" };
const worker = createRisulta();
const call = (path, init) => worker.fetch(new Request("http://app.example.test" + path, init), env, {});
const log = console.log;
console.log = () => {};
const login = await call("/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password: "change-me-test-0001" }) });
const cookie = login.headers.get("set-cookie").split(";")[0];
const session = await (await call("/api/session", { headers: { cookie } })).json();
const post = (path, body) => call(path, { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": session.csrf }, body: JSON.stringify(body) });
console.log = log;

const first = await (await post("/api/sites", { name: "One", domain: "one.example.test" })).json();
assert.equal((await post("/api/sites", { name: "Two", domain: "two.example.test" })).status, 201, "an instance that never connects adds websites as before");
assert.equal((await post("/api/sites/" + first.id + "/domain", { domain: "uno.example.test" })).status < 400, true);
assert.equal((await call("/cloud", { headers: { cookie } })).status, 200);
const page = await (await call("/cloud", { headers: { cookie } })).text();
assert.ok(page.includes("Connect to risulta.dev") && !page.includes("Move everything"), "connect first");

// a move has started: the registry holds a site_home row
await ensureSchema(env.DB, "shared");
await env.DB.prepare("INSERT INTO site_home (site_id, home, lineage, src_ref, link_id, job_id, updated_at) VALUES (?, 'gateway', 'lineage-lock-0001', ?, 'l', '', 1)").bind(first.id, first.id).run();
const blocked = await post("/api/sites", { name: "Three", domain: "three.example.test" });
assert.equal(blocked.status, 409);
assert.match((await blocked.json()).error, /moved to risulta\.dev/);
assert.equal((await post("/api/sites/" + first.id + "/domain", { domain: "eins.example.test" })).status, 409);
assert.equal(lite.query("SELECT count(*) AS n FROM sites").get().n, 2);
await ensureSchema(env.DB, "store");
// an event for a forwarding website is queued, not stored
const key = lite.query("SELECT public_key FROM sites WHERE id = ?").get(first.id).public_key;
const sent = await call("/api/event/" + key, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ name: "pageview", path: "/", referrer: "", domain: "uno.example.test" }) });
assert.equal(sent.status, 202);
assert.equal(lite.query("SELECT count(*) AS n FROM events").get().n, 0);
assert.equal(lite.query("SELECT count(*) AS n FROM gateway_outbox").get().n, 1);
console.log("lock ok");

// The host's blobs hook is where bundle parts wait (a function of env: the storage is a binding).
{
  const { memoryBlobs } = await import("../../src/move/blobs.js");
  const spy = memoryBlobs();
  let seenEnv = null;
  const hosted = createRisulta({ blobs: (e) => { seenEnv = e; return spy; } });
  const hcall = (path, init) => hosted.fetch(new Request("http://app.example.test" + path, init), env, {});
  const quiet = console.log; console.log = () => {};
  const hlogin = await hcall("/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password: "change-me-test-0001" }) });
  const hcookie = hlogin.headers.get("set-cookie").split(";")[0];
  const hsession = await (await hcall("/api/session", { headers: { cookie: hcookie } })).json();
  console.log = quiet;
  const hpost = (path, body) => hcall(path, { method: "POST", headers: { cookie: hcookie, "content-type": "application/json", "x-csrf-token": hsession.csrf }, body: JSON.stringify(body) });
  const job = await (await hpost("/api/imports", {})).json();
  const text = '{"t":"manifest"}\n';
  const digest = Array.from(new Uint8Array(await nativeDigest("SHA-256", new TextEncoder().encode(text)))).map((b) => b.toString(16).padStart(2, "0")).join("");
  const put = await hcall("/api/imports/" + job.id + "/parts/0", { method: "PUT", headers: { cookie: hcookie, "x-csrf-token": hsession.csrf, "x-risulta-part-sha256": digest }, body: text });
  assert.equal(put.status, 200, await put.clone().text());
  assert.ok(seenEnv === env, "the hook receives the request's env");
  assert.ok(spy.keys().some((k) => k === "imports/" + job.id + "/0"), "the part waits in the host's storage: " + spy.keys().join(","));
  console.log("blobs hook ok");
}
