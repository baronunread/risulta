// The whole move, instance to cloud and back, through the real routes: every website at once.
import assert from "node:assert/strict";
import { makeHost, connect, seedInstance, beacon, INSTANCE, CLOUD, CDN } from "./harness.mjs";
import { count } from "./helpers.mjs";
import { runMove, startMoveOut, startMoveBack, runMoveStep, previewMoveOut, retireGateway } from "../../src/move/moves.js";
import { flushOutbox, outboxStats, siteHome, instanceLocked } from "../../src/move/gateway.js";
import { visitorFor } from "../../src/store.js";
import { pendingInvitations } from "../../src/move/importer.js";

const KEYS = ["k".repeat(32), "m".repeat(32), "q".repeat(32)];
const SIZES = [1500, 900, 400];
const instance = makeHost("instance", 1);
const cloud = makeHost("cloud", 7);
// the target already has another website, so ids differ
await cloud.shared.prepare("INSERT INTO sites (name, domain, public_key, created_at, slug, org_id) VALUES ('Old', 'old.test', ?, 1, 'old', 7)").bind("o".repeat(32)).run();

// ---- connect
const { url, back } = await connect(instance, cloud);
assert.ok(url.startsWith(CLOUD + "/connect?instance=" + encodeURIComponent(INSTANCE)), url);
const link = await instance.shared.prepare("SELECT link_id, remote_origin FROM cloud_link").first();
assert.equal(link.remote_origin, CLOUD);
assert.equal(await count(cloud.shared, "SELECT count(*) AS n FROM links WHERE state = 'active' AND org_id = 7 AND instance_origin = ?", INSTANCE), 1);
// connecting moved nothing, and the instance is not locked
assert.equal(await count(cloud.shared, "SELECT count(*) AS n FROM sites"), 1);
assert.equal(await instanceLocked(instance.ctx), false);
// the code is single use, and a second redeem fails
const replay = await cloud.app.fetch(new Request(CLOUD + "/api/connect/token", { method: "POST", body: JSON.stringify({ code: new URL(back).searchParams.get("code"), verifier: "0".repeat(64), instance: INSTANCE }) }));
assert.equal(replay.status, 400);

// ---- an instance with three websites, and traffic that keeps coming to all of them
const ids = await seedInstance(instance);
const posted = [];
let turn = 0;
const post = async (n) => { for (let i = 0; i < n; i++) { const k = turn++ % 3; posted.push((await beacon(instance, ids[k], KEYS[k])).path); } };
await post(20); // before the move: plain stored events

// the page offers one button for everything
const page = await (await instance.app.fetch(new Request(INSTANCE + "/cloud"))).text();
assert.ok(page.includes("Move everything to risulta.dev") && !page.includes("/move\">Move to risulta.dev") && !/\/api\/sites\/\d+\/move/.test(page), "one button, no per-site move");
const preview = await previewMoveOut(instance.ctx, 1, { fetch: instance.deps.fetch });
assert.equal(preview.sites.length, 3);
assert.equal(preview.people, 2);
assert.equal(preview.events, SIZES.reduce((a, b) => a + b) + 20);
assert.equal(await count(cloud.shared, "SELECT count(*) AS n FROM sites"), 1, "a preview writes nothing");

const started = await startMoveOut(instance.ctx, 1, { window: 700 });
assert.equal(started.state, "preflight");
assert.equal(await instanceLocked(instance.ctx), true, "the instance is locked from the start");
await assert.rejects(() => startMoveOut(instance.ctx, 1, {}), /already in progress/);
const deps = { fetch: instance.deps.fetch };
let s = await runMoveStep(instance.ctx, started.id, deps);
assert.equal(s.state, "bulk");
for (const id of ids) assert.equal((await siteHome(instance.ctx, id)).home, "moving");
// traffic during the bulk copy: still stored locally (guarded insert)
await post(15);
assert.equal(await count(instance.store, "SELECT count(*) AS n FROM events WHERE path LIKE '/e/%'"), 35);
let guard = 0;
while (s.state === "bulk" && guard++ < 200) { s = await runMoveStep(instance.ctx, started.id, deps); await post(3); }
assert.equal(s.state, "seal", JSON.stringify(s));
s = await runMoveStep(instance.ctx, started.id, deps); // the seal: one fence per website
assert.equal(s.state, "catchup");
assert.ok(s.sealedId > 0);
for (const id of ids) assert.equal((await siteHome(instance.ctx, id)).home, "gateway", "every website forwards");
assert.equal(await count(instance.store, "SELECT count(*) AS n FROM site_fence"), 3);
// traffic after the seal goes to the outbox for ALL websites, not to the events table
const localBefore = await count(instance.store, "SELECT count(*) AS n FROM events");
for (let i = 0; i < 12; i++) { const k = i % 3; const r = await beacon(instance, ids[k], KEYS[k]); posted.push(r.path); assert.equal(r.outcome, "queued"); }
assert.equal(await count(instance.store, "SELECT count(*) AS n FROM events"), localBefore, "nothing is stored locally after the seal");
assert.equal((await outboxStats(instance.ctx, 1)).queued, 12);
s = await runMove(instance.ctx, started.id, deps);
assert.equal(s.state, "done", JSON.stringify(s));

// forwarded events reach the target once, with the instance's visitor hash
let flushed = await flushOutbox(instance.ctx, 1, { fetch: instance.deps.fetch });
assert.equal(flushed.left, 0, JSON.stringify(flushed));
const target = [];
for (const key of KEYS) {
  const row = await cloud.shared.prepare("SELECT id, org_id FROM sites WHERE public_key = ?").bind(key).first();
  assert.ok(row && Number(row.org_id) === 7, "the website exists on the cloud under its own tracker key");
  target.push(Number(row.id));
}
assert.equal(await count(cloud.shared, "SELECT count(*) AS n FROM site_home"), 0, "all activated together");
for (let i = 0; i < 3; i++) assert.equal(await count(cloud.store, "SELECT count(*) AS n FROM events WHERE site_id = ? AND path NOT LIKE '/e/%'", target[i]), await count(instance.store, "SELECT count(*) AS n FROM events WHERE site_id = ? AND path NOT LIKE '/e/%'", ids[i]), "history of website " + i + " arrived");
assert.equal(await count(cloud.store, "SELECT count(*) AS n FROM events WHERE path LIKE '/e/%'"), posted.length, "every posted event is on the cloud once");
assert.equal(await count(cloud.store, "SELECT count(*) AS n FROM (SELECT path FROM events WHERE path LIKE '/e/%' GROUP BY path HAVING count(*) > 1)"), 0);
// goals, funnels, notes came with it, and the people as invitations (never hashes)
assert.equal(await count(cloud.store, "SELECT count(*) AS n FROM goals WHERE site_id = ?", target[0]), 2);
assert.equal(await count(cloud.store, "SELECT count(*) AS n FROM funnels WHERE site_id = ?", target[0]), 1);
assert.equal(await count(cloud.store, "SELECT count(*) AS n FROM annotations WHERE site_id = ?", target[0]), 1);
const invites = await pendingInvitations(cloud.ctx, 7);
assert.equal(invites.length, 2, "both people arrive as invitations");
assert.ok(!JSON.stringify(invites).includes("HASH-SECRET"));
// the visitor hash is the instance's, not the cloud's
const sample = await cloud.store.prepare("SELECT visitor FROM events WHERE path LIKE '/e/%' AND site_id = ? LIMIT 1").bind(target[0]).first();
assert.equal(sample.visitor, await visitorFor(instance.store, ids[0], "203.0.113.9", "ua"));
// control calls go to the app origin, the traffic goes to the permanent tracker host
const urls = cloud.faults.sent;
assert.ok(urls.some((u) => u.startsWith(CLOUD + "/api/link/moves/")), "control calls use the app origin");
assert.ok(urls.filter((u) => u.includes("/link/fwd/")).length > 0 && urls.filter((u) => u.includes("/link/fwd/")).every((u) => u.startsWith(CDN + "/link/fwd/")), "forwards use " + CDN);
assert.equal((await instance.shared.prepare("SELECT forward_origin FROM cloud_link").first()).forward_origin, CDN);
// the instance is locked: no new website here, the page says everything lives on risulta.dev
assert.equal(await instanceLocked(instance.ctx), true);
const moved = await (await instance.app.fetch(new Request(INSTANCE + "/cloud"))).text();
assert.ok(moved.includes("Everything lives on risulta.dev") && moved.includes("Move back") && moved.includes("Retire the gateway") && !moved.includes("Move everything to risulta.dev"));
console.log("move out ok: 3 websites in one move, window=700, " + posted.length + " live events");

// ---- move back, with traffic arriving the whole time
const after = [];
const postAfter = async (n) => { for (let i = 0; i < n; i++) { const k = turn++ % 3; after.push((await beacon(instance, ids[k], KEYS[k])).path); } };
await postAfter(10); // gateway traffic, still forwarded
const backMove = await startMoveBack(instance.ctx, 1);
s = await runMoveStep(instance.ctx, backMove.id, deps);
assert.equal(s.state, "pull", JSON.stringify(s));
for (const id of ids) assert.equal((await siteHome(instance.ctx, id)).home, "moving-back");
await postAfter(7);
guard = 0;
while (s.state === "pull" && guard++ < 50) { s = await runMoveStep(instance.ctx, backMove.id, deps); await postAfter(2); }
assert.equal(s.state, "seal", JSON.stringify(s));
await flushOutbox(instance.ctx, 1, { fetch: instance.deps.fetch, limit: 9 });
s = await runMoveStep(instance.ctx, backMove.id, deps);
assert.equal(s.state, "catchup");
await postAfter(6); // after the cloud's fence: its answer is "sealed" and the instance keeps them
s = await runMove(instance.ctx, backMove.id, deps);
assert.equal(s.state, "returned", JSON.stringify(s));
for (let i = 0; i < 3; i++) {
  assert.equal((await siteHome(instance.ctx, ids[i])).home, "", "local again");
  assert.equal((await siteHome(cloud.ctx, target[i])).home, "frozen", "the cloud copy is the rollback copy");
}
assert.equal(await instanceLocked(instance.ctx), false);
for (let i = 0; i < 20; i++) { const r = await flushOutbox(instance.ctx, 1, { fetch: instance.deps.fetch }); if (!r.left) break; }
assert.equal((await outboxStats(instance.ctx, 1)).queued, 0);
const all = posted.concat(after);
const here = (await instance.store.prepare("SELECT path, count(*) AS n FROM events WHERE path LIKE '/e/%' GROUP BY path").all()).results;
assert.equal(here.length, all.length, "every posted event is on the instance: " + here.length + " of " + all.length);
assert.ok(here.every((r) => r.n === 1), "none doubled");
assert.equal((await beacon(instance, ids[2], KEYS[2])).outcome, "stored", "it collects directly again");
console.log("move back ok: " + all.length + " events accounted for exactly once");

// ---- a second move to the same target is refused, cleanly, while the rollback copy is there
{
  const m = await startMoveOut(instance.ctx, 1, { window: 5000 });
  const failed = await runMove(instance.ctx, m.id, deps);
  assert.equal(failed.state, "failed", JSON.stringify(failed));
  assert.match(failed.error, /key_taken/);
  for (const id of ids) assert.equal((await siteHome(instance.ctx, id)).home, "", "nothing stays half moved");
  assert.equal(await instanceLocked(instance.ctx), false);
  assert.equal((await beacon(instance, ids[0], KEYS[0])).outcome, "stored", "and the instance keeps collecting");
  console.log("second move refused cleanly ok");
}

// ---- the gateway can be retired once everything lives on the target
{
  const inst = makeHost("instance", 1);
  const tgt = makeHost("cloud", 7);
  await connect(inst, tgt);
  const sites = await seedInstance(inst, [{ key: "r".repeat(32), domain: "r.test", events: 200 }, { key: "s".repeat(32), domain: "s.test", events: 100 }]);
  const m = await startMoveOut(inst.ctx, 1, { window: 5000 });
  assert.equal((await runMove(inst.ctx, m.id, { fetch: inst.deps.fetch })).state, "done");
  await retireGateway(inst.ctx, 1);
  for (const id of sites) assert.equal((await siteHome(inst.ctx, id)).home, "frozen");
  assert.equal((await beacon(inst, sites[0], "r".repeat(32))).outcome, "dropped", "a retired gateway stores and forwards nothing");
  await assert.rejects(() => retireGateway(inst.ctx, 1), /not forwarding/);
  console.log("retire ok");
}

// ---- the target advises a window size, and its plan must have room for every website
{
  const small = makeHost("instance", 1);
  const big = makeHost("cloud", 7, { limits: { move: async () => ({ window: 300 }), canAddSite: async (_org, n) => n <= 3 } });
  await connect(small, big);
  await seedInstance(small, [{ key: "w".repeat(32), domain: "w.test", events: 600 }, { key: "x".repeat(32), domain: "x.test", events: 400 }]);
  const m = await startMoveOut(small.ctx, 1, { window: 5000 });
  const done = await runMove(small.ctx, m.id, { fetch: small.deps.fetch });
  assert.equal(done.state, "done");
  const jobs = await big.shared.prepare("SELECT count(*) AS n FROM move_jobs").first();
  assert.ok(Number(jobs.n) >= 4, "1000 events in windows of 300 are at least 4 jobs: " + jobs.n);
  const tight = makeHost("cloud", 7, { limits: { canAddSite: async (_org, n) => n <= 1 } });
  const wide = makeHost("instance", 1);
  await connect(wide, tight);
  await seedInstance(wide, [{ key: "a".repeat(32), domain: "a.test", events: 10 }, { key: "b".repeat(32), domain: "b.test", events: 10 }]);
  await assert.rejects(() => previewMoveOut(wide.ctx, 1, { fetch: wide.deps.fetch }), /no room for 2 more websites/);
  assert.equal(await count(tight.shared, "SELECT count(*) AS n FROM sites"), 0, "nothing was created");
  console.log("window advice and site quota ok");
}
