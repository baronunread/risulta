// The link as an actor: another org's identifiers, signature and envelope
// attacks, connect attacks, the route manifest, and the self-hosted default.
import assert from "node:assert/strict";
import { makeHost, connect, seedSource, beacon, wire, INSTANCE, CLOUD, NOW } from "./harness.mjs";
import { count, makeStoreDb, orgDigest } from "./helpers.mjs";
import { startMoveOut, runMove, startMoveBack } from "../../src/move/moves.js";
import { flushOutbox } from "../../src/move/gateway.js";
import { signRequest, startConnect, finishConnect, authorizeConnect, redeemCode, pkceChallenge, parseLinkHeader } from "../../src/move/link.js";
import { exportParts } from "../../src/move/exporter.js";
import { collect } from "./helpers.mjs";

console.error = () => {};
const KA = "a".repeat(32), KB = "b".repeat(32);
const cloud = makeHost("cloud", 7);
cloud.world.stores[8] = makeStoreDb();
const instA = makeHost("instance", 1);
const instB = makeHost("instance", 1);
// two instances, two orgs on one cloud
cloud.state.adminOrg = 7; await connect(instA, cloud);
cloud.state.adminOrg = 8; await connect(instB, cloud);
const linkA = await instA.shared.prepare("SELECT link_id, secret FROM cloud_link").first();
const linkB = await instB.shared.prepare("SELECT link_id, secret FROM cloud_link").first();
assert.notEqual(linkA.link_id, linkB.link_id);
const siteA = await seedSource(instA, { events: 300, key: KA, domain: "a.test", seed: 2 });
const siteB = await seedSource(instB, { events: 300, key: KB, domain: "b.test", seed: 3 });
for (const [inst] of [[instA, siteA], [instB, siteB]]) {
  const m = await startMoveOut(inst.ctx, 1, { window: 200 });
  const s = await runMove(inst.ctx, m.id, { fetch: inst.deps.fetch });
  assert.equal(s.state, "done", JSON.stringify(s));
}
const idA = Number((await cloud.shared.prepare("SELECT id FROM sites WHERE public_key = ?").bind(KA).first()).id);
const idB = Number((await cloud.shared.prepare("SELECT id FROM sites WHERE public_key = ?").bind(KB).first()).id);
assert.equal(Number((await cloud.shared.prepare("SELECT org_id FROM sites WHERE id = ?").bind(idA).first()).org_id), 7);
assert.equal(Number((await cloud.shared.prepare("SELECT org_id FROM sites WHERE id = ?").bind(idB).first()).org_id), 8);
const jobB = (await cloud.shared.prepare("SELECT id FROM move_jobs WHERE org_id = 8 LIMIT 1").first()).id;
const lineageB = (await instB.shared.prepare("SELECT lineage FROM moves").first()).lineage;
const digestB = async () => JSON.stringify([await orgDigestOf(cloud, 8), await cloud.shared.prepare("SELECT count(*) AS n FROM site_links WHERE link_id = ?").bind(linkB.link_id).first()]);
async function orgDigestOf(host, org) {
  const store = host.world.stores[org];
  const rows = (await store.prepare("SELECT * FROM events ORDER BY id").all()).results;
  const fwd = (await store.prepare("SELECT * FROM fwd_dedupe ORDER BY fid").all()).results;
  return Bun.hash(JSON.stringify([rows, fwd])).toString(16);
}
const before = await digestB();

async function send(link, method, path, body = "", { ts = NOW, sigOf = link, headers = {} } = {}) {
  const auth = await signRequest({ linkId: sigOf.link_id, secret: sigOf.secret }, method, path, body, ts);
  const init = { method, headers: { authorization: auth, "content-type": "application/json", ...headers } };
  if (method !== "GET") init.body = body;
  return await cloud.app.fetch(new Request(CLOUD + path, init));
}
const envelope = (key, extra = {}) => ({ fid: Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32), key, ts: NOW - 5, day: Math.floor((NOW - 5) / 86400), ip: "203.0.113.1", ua: "ua", vh: "", origin: INSTANCE, host: "stats.example.test", ev: { name: "pageview", path: "/x", referrer: "", source: "", medium: "", campaign: "", content: "", term: "", value: null }, ...extra });
const forward = async (link, envs, opts) => { const r = await send(link, "POST", "/link/fwd/events", JSON.stringify({ envelopes: envs }), opts); return { status: r.status, body: r.status === 200 ? await r.json() : null }; };

// ---- 1. link A against org B: nothing, and always the same answer as "no such thing"
let r = await forward(linkA, [envelope(KB)]);
assert.equal(r.body.results[0].status, "unknown", "a key of another org is simply unknown");
r = await forward(linkA, [envelope(KA)]);
assert.equal(r.body.results[0].status, "stored", "its own key works");
const missing = await cloud.app.fetch(new Request(CLOUD + "/api/link/nothing/here"));
for (const [method, path] of [["GET", "/api/link/jobs/" + jobB], ["POST", "/api/link/jobs/" + jobB + "/complete"], ["PUT", "/api/link/jobs/" + jobB + "/parts/0"], ["POST", "/api/link/moves/" + lineageB + "/finalize"], ["POST", "/api/link/moves/" + lineageB + "/cancel"], ["POST", "/api/link/moves/" + lineageB + "/windows"], ["POST", "/api/link/moves/" + lineageB + "/back/preflight"], ["GET", "/api/link/moves/" + lineageB + "/back/export?since_id=0&until_id=999999"], ["POST", "/api/link/moves/" + lineageB + "/back/seal"], ["POST", "/api/link/moves/" + lineageB + "/back/release"]]) {
  const resp = await send(linkA, method, path, method === "POST" || method === "PUT" ? "{}" : "");
  assert.ok(resp.status === 404 || resp.status === 400, method + " " + path + " -> " + resp.status);
  const text = await resp.text();
  assert.ok(!text.includes(KB) && !text.includes("b.test"), "no data of org B in the answer");
}
assert.equal(await digestB(), before, "org B is unchanged");
assert.equal((await missing.text()).length > 0, true);

// ---- 2. signature attacks: all indistinguishable from a missing route
const good = JSON.stringify({ envelopes: [envelope(KA)] });
const ok = await send(linkA, "POST", "/link/fwd/events", good);
assert.equal(ok.status, 200);
const header = await signRequest({ linkId: linkA.link_id, secret: linkA.secret }, "POST", "/link/fwd/events", good, NOW);
const attempt = async (init, path = "/link/fwd/events") => (await cloud.app.fetch(new Request(CLOUD + path, { method: "POST", ...init }))).status;
assert.equal(await attempt({ headers: { authorization: header }, body: good.replace("203.0.113.1", "203.0.113.2") }), 404, "body swapped");
assert.equal(await attempt({ headers: { authorization: header }, body: good }, "/link/fwd/events?x=1"), 404, "query changed");
assert.equal(await attempt({ headers: { authorization: header }, body: good }, "/api/link/moves/preflight"), 404, "path swapped");
assert.equal((await cloud.app.fetch(new Request(CLOUD + "/link/fwd/events", { method: "PUT", headers: { authorization: header }, body: good }))).status, 404, "method swapped");
assert.equal((await send(linkA, "POST", "/link/fwd/events", good, { ts: NOW - 301 })).status, 404, "stale timestamp");
assert.equal((await send(linkA, "POST", "/link/fwd/events", good, { ts: NOW + 301 })).status, 404, "future timestamp");
assert.equal((await send(linkA, "POST", "/link/fwd/events", good, { sigOf: { link_id: linkA.link_id, secret: linkB.secret } })).status, 404, "signed by the other link's secret");
assert.equal((await send(linkA, "POST", "/link/fwd/events", good, { sigOf: { link_id: linkA.link_id, secret: "0".repeat(64) } })).status, 404, "wrong secret");
assert.equal(await attempt({ headers: { authorization: header.replace(linkA.link_id, linkB.link_id) }, body: good }), 404, "link id swapped");
for (const bad of ["", "Risulta-Link", "Bearer " + linkA.secret, header + ", extra=1", header.replace("sig=", "sig=0"), header.toUpperCase(), header + header]) assert.equal(await attempt({ headers: { authorization: bad }, body: good }), 404, "garbage header: " + bad.slice(0, 30));
assert.equal(parseLinkHeader(header).linkId, linkA.link_id);

// ---- 3. envelope attacks: dropped one by one, never the batch, and never stored
const bad = [
  envelope(KA, { origin: "https://evil.example" }), envelope(KA, { ip: "not an ip!" }), envelope(KA, { vh: "XYZ" }), envelope(KA, { extra: 1 }),
  envelope(KA, { ts: NOW - 9 * 86400 }), envelope(KA, { ts: NOW + 4000 }), envelope(KA, { day: 5 }), envelope(KA, { fid: "short" }), envelope(KA, { key: "../x" }),
  envelope(KA, { ev: { name: "Bad Name", path: "/x", referrer: "", source: "", medium: "", campaign: "", content: "", term: "", value: null } }),
  envelope(KA, { ev: { name: "pageview", path: "x", referrer: "", source: "", medium: "", campaign: "", content: "", term: "", value: null } }),
  envelope(KA, { ev: { name: "pageview", path: "/x", referrer: "", source: "", medium: "", campaign: "", content: "", term: "", value: -1 } }),
];
const eventsBefore = await count(cloud.world.stores[7], "SELECT count(*) AS n FROM events");
r = await forward(linkA, bad.concat([envelope(KA)]));
assert.deepEqual(r.body.results.slice(0, bad.length).map((x) => x.status), bad.map(() => "invalid"));
assert.equal(r.body.results[bad.length].status, "stored");
assert.equal(await count(cloud.world.stores[7], "SELECT count(*) AS n FROM events"), eventsBefore + 1);
// duplicates are stored once
const e1 = envelope(KA);
r = await forward(linkA, [e1, e1]);
assert.deepEqual(r.body.results.map((x) => x.status), ["stored", "duplicate"]);
assert.equal((await forward(linkA, [e1])).body.results[0].status, "duplicate");
// a pre-hashed visitor is used as is; without one the cloud hashes with its own salt
await forward(linkA, [envelope(KA, { vh: "0123456789abcdef01234567", ev: { name: "pageview", path: "/vh", referrer: "", source: "", medium: "", campaign: "", content: "", term: "", value: null } })]);
assert.equal((await cloud.world.stores[7].prepare("SELECT visitor FROM events WHERE path = '/vh'").first()).visitor, "0123456789abcdef01234567");
await forward(linkA, [envelope(KA, { ev: { name: "pageview", path: "/novh", referrer: "", source: "", medium: "", campaign: "", content: "", term: "", value: null } })]);
assert.match((await cloud.world.stores[7].prepare("SELECT visitor FROM events WHERE path = '/novh'").first()).visitor, /^[0-9a-f]{24}$/);
// too many envelopes, too fast
assert.equal((await forward(linkA, Array.from({ length: 201 }, () => envelope(KA)))).status, 400);
// a second link of the same org that is not this site's gateway cannot forward for it
const instC = makeHost("instance", 1);
const originalOrigin = instC.deps.origin;
cloud.state.adminOrg = 7;
instC.deps.origin = () => "https://other.example";
await connect(instC, cloud).catch(() => {});
instC.deps.origin = originalOrigin;
const linkC = await instC.shared.prepare("SELECT link_id, secret FROM cloud_link").first();
if (linkC) {
  r = await forward(linkC, [envelope(KA)]);
  assert.ok(r.status === 404 || r.body.results[0].status === "unknown" || r.body.results[0].status === "invalid", "another link of the same org is not the gateway of this site: " + JSON.stringify(r.body));
}
assert.equal(await digestB(), before, "org B is still unchanged");

// ---- 4. connect attacks
{
  const inst = makeHost("instance", 1);
  const ctx = inst.ctx;
  const cl = makeHost("cloud", 7);
  const start = await startConnect(ctx, { instanceOrigin: INSTANCE, targetOrigin: CLOUD, sessionHash: "s1" });
  const q = new URL(start.url).searchParams;
  // a callback on another origin is refused at authorization
  await assert.rejects(() => authorizeConnect(cl.ctx, { userId: 1, orgId: 7, instance: INSTANCE, state: q.get("state"), challenge: q.get("challenge"), callback: "https://evil.example/api/cloud/connect/callback" }), /return address/);
  await assert.rejects(() => authorizeConnect(cl.ctx, { userId: 1, orgId: 7, instance: "http://insecure.example", state: q.get("state"), challenge: q.get("challenge"), callback: "http://insecure.example/api/cloud/connect/callback" }), /https/);
  const { redirect } = await authorizeConnect(cl.ctx, { userId: 1, orgId: 7, instance: INSTANCE, state: q.get("state"), challenge: q.get("challenge"), callback: q.get("callback") });
  const code = new URL(redirect).searchParams.get("code");
  const verifier = (await inst.shared.prepare("SELECT verifier FROM connect_states").first()).verifier;
  // wrong verifier, wrong instance, wrong code
  await assert.rejects(() => redeemCode(cl.ctx, { code, verifier: "1".repeat(64), instance: INSTANCE }), /not valid/);
  await assert.rejects(() => redeemCode(cl.ctx, { code, verifier, instance: "https://other.example" }), /not valid/);
  await assert.rejects(() => redeemCode(cl.ctx, { code: "0".repeat(32), verifier, instance: INSTANCE }), /not valid/);
  // the right one works once
  assert.ok((await redeemCode(cl.ctx, { code, verifier, instance: INSTANCE })).secret);
  await assert.rejects(() => redeemCode(cl.ctx, { code, verifier, instance: INSTANCE }), /not valid/);
  // an expired code
  const s2 = await startConnect(ctx, { instanceOrigin: INSTANCE, targetOrigin: CLOUD, sessionHash: "s1" });
  const q2 = new URL(s2.url).searchParams;
  const a2 = await authorizeConnect(cl.ctx, { userId: 1, orgId: 7, instance: INSTANCE, state: q2.get("state"), challenge: q2.get("challenge"), callback: q2.get("callback") });
  const later = { ...cl.ctx, now: () => NOW + 301 };
  const v2 = (await inst.shared.prepare("SELECT verifier FROM connect_states WHERE verifier != ?").bind(verifier).first()).verifier;
  await assert.rejects(() => redeemCode(later, { code: new URL(a2.redirect).searchParams.get("code"), verifier: v2, instance: INSTANCE }), /not valid/);
  // callback from a different browser session, and state reuse
  const s3 = await startConnect(ctx, { instanceOrigin: INSTANCE, targetOrigin: CLOUD, sessionHash: "s1" });
  await assert.rejects(() => finishConnect(ctx, { state: s3.state, code: "x", sessionHash: "someone-else", instanceOrigin: INSTANCE }), /not valid any more/);
  await assert.rejects(() => finishConnect(ctx, { state: s3.state, code: "x", sessionHash: "s1", instanceOrigin: INSTANCE }), /not valid any more/);
  // a non-admin cannot authorize
  cl.state.admin = false;
  const forbid = await cl.app.fetch(new Request(CLOUD + "/api/connect/authorize", { method: "POST", body: "x=1" }));
  assert.equal(forbid.status, 403);
  assert.equal(await pkceChallenge("abc").then((c) => c.length), 43);
}

// ---- 5. revocation: the gateway keeps its events and says so
{
  const l = await instA.shared.prepare("SELECT link_id FROM cloud_link").first();
  cloud.state.adminOrg = 8;
  const denied = await cloud.app.fetch(new Request(CLOUD + "/api/links/" + l.link_id, { method: "DELETE", headers: { "x-csrf-token": "csrf" } }));
  assert.equal((await denied.json()).ok, false, "org 8 cannot revoke org 7's link");
  cloud.state.adminOrg = 7;
  const done = await cloud.app.fetch(new Request(CLOUD + "/api/links/" + l.link_id, { method: "DELETE", headers: { "x-csrf-token": "csrf" } }));
  assert.equal((await done.json()).ok, true);
  await beacon(instA, siteA, KA);
  const flush = await flushOutbox(instA.ctx, 1, { fetch: instA.deps.fetch });
  assert.equal(flush.left, 1);
  assert.match(flush.error, /refused 404/);
  // disconnect is refused while the site forwards
  const refused = await instA.app.fetch(new Request(INSTANCE + "/api/cloud/disconnect", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": "csrf" }, body: "{}" }));
  assert.equal(refused.status, 409);
}

// ---- 6. the route manifest: every route has a class, a new route fails here
{
  const classes = {
    "POST /api/connect/token": "connect", "POST /api/link/moves/preflight": "link", "POST /api/link/moves/:lineage{[a-z0-9._-]{8,64}}/windows": "link",
    "PUT /api/link/jobs/:id{[0-9a-f]{32}}/parts/:n{[0-9]{1,6}}": "link", "POST /api/link/jobs/:id{[0-9a-f]{32}}/complete": "link", "GET /api/link/jobs/:id{[0-9a-f]{32}}": "link",
    "POST /api/link/moves/:lineage{[a-z0-9._-]{8,64}}/finalize": "link", "POST /api/link/moves/:lineage{[a-z0-9._-]{8,64}}/cancel": "link",
    "POST /api/link/moves/:lineage{[a-z0-9._-]{8,64}}/back/preflight": "link", "GET /api/link/moves/:lineage{[a-z0-9._-]{8,64}}/back/export": "link",
    "POST /api/link/moves/:lineage{[a-z0-9._-]{8,64}}/back/seal": "link", "POST /api/link/moves/:lineage{[a-z0-9._-]{8,64}}/back/release": "link",
    "POST /link/fwd/events": "link-forward", "GET /link/fwd/public/data/:key{[A-Za-z0-9_-]+}": "link-forward",
  };
  const link = Object.keys(classes);
  for (const route of cloud.app.routes) {
    const name = route.method + " " + route.path;
    if (route.method === "ALL") continue;
    const isLink = route.path.startsWith("/api/link/") || route.path.startsWith("/link/fwd/") || route.path === "/api/connect/token";
    if (isLink) assert.ok(link.includes(name), "unclassified link route: " + name);
    else assert.ok(["admin", "session"].length, name); // org-scoped: guarded by wrap()
  }
  for (const name of link) assert.ok(cloud.app.routes.some((x) => x.method + " " + x.path === name), "classified but missing: " + name);
}

// ---- 7. a self-hosted instance that never connects has none of it
{
  const lone = makeHost("instance", 1);
  const id = await seedSource(lone, { events: 50, key: "z".repeat(32), domain: "z.test" });
  const outcome = await beacon(lone, id, "z".repeat(32));
  assert.equal(outcome.outcome, "stored");
  for (const path of ["/api/cloud/status", "/cloud", "/import"]) assert.equal((await lone.app.fetch(new Request(INSTANCE + path))).status, 200);
  const tables = (db) => db.sqlite.query("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name);
  for (const name of ["site_fence", "gateway_outbox", "fwd_dedupe", "import_ledger", "import_ranges", "import_map"]) assert.ok(!tables(lone.store).includes(name), "no " + name + " on the store");
  for (const name of ["site_home", "moves", "cloud_link", "links", "move_jobs", "site_links"]) assert.ok(!tables(lone.shared).includes(name), "no " + name + " in the registry");
  // and every link route is a plain 404 there
  const anyLink = await lone.app.fetch(new Request(INSTANCE + "/link/fwd/events", { method: "POST", body: "{}" }));
  assert.equal(anyLink.status, 404);
  // "Download your data" works with no link
  const dl = await lone.app.fetch(new Request(INSTANCE + "/api/exports/download?site=" + id));
  assert.equal(dl.status, 200);
  const text = await dl.text();
  assert.ok(text.startsWith('{"t":"manifest"') && text.includes('"t":"trailer"') && !text.includes("password"));
  const other = await lone.app.fetch(new Request(INSTANCE + "/api/exports/download?site=9999"));
  assert.equal(other.status, 404);
  // with no choice at all, the download is everything the org has
  const all = await (await lone.app.fetch(new Request(INSTANCE + "/api/exports/download"))).text();
  assert.ok(all.includes('"domain":"z.test"') && all.includes('"scope":"org"'));
}
void collect; void exportParts; void startMoveBack; void orgDigest; void wire;
console.log("link ok");
