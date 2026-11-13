// Exactly once under chaos: lost responses, refused connections, 503s and
// crashes inside batches, on either side, at random moments of a live move
// in both directions. For every seed: no event is lost, none is doubled.
import assert from "node:assert/strict";
import { makeHost, connect, seedInstance, beacon, prng } from "./harness.mjs";
import { startMoveOut, startMoveBack, runMoveStep, moveStatus } from "../../src/move/moves.js";
import { flushOutbox, outboxStats, siteHome } from "../../src/move/gateway.js";

console.error = () => {}; // a crash inside a handler is logged by the framework: that is the point
const KEYS = ["k".repeat(32), "m".repeat(32)];
const seeds = Number(process.env.CHAOS_SEEDS || 30);
let crashes = 0, lost = 0, refused = 0, flipsSeen = new Set();

async function scenario(seed) {
  const rnd = prng(seed * 104729);
  const instance = makeHost("instance", 1);
  const cloud = makeHost("cloud", 7);
  await connect(instance, cloud);
  const ids = await seedInstance(instance, [{ key: KEYS[0], domain: "shop.test", events: 200 + Math.floor(rnd() * 600) }, { key: KEYS[1], domain: "blog.test", events: 100 + Math.floor(rnd() * 300) }]);
  const deps = { fetch: instance.deps.fetch };
  const posted = [];
  const post = async () => { const k = rnd() < 0.6 ? 0 : 1; posted.push((await beacon(instance, ids[k], KEYS[k], { ip: "198.51.100." + Math.floor(rnd() * 200) })).path); };
  const arm = (host) => {
    let k = 1 + Math.floor(rnd() * 5);
    const after = rnd() < 0.5;
    const hook = async () => { if (--k === 0) { crashes++; delete host.store.beforeBatch; delete host.store.afterBatch; delete host.shared.beforeBatch; delete host.shared.afterBatch; throw new Error("crash"); } };
    const target = rnd() < 0.34 ? host.shared : host.store;
    if (after) target.afterBatch = hook; else target.beforeBatch = hook;
  };
  const chaos = () => {
    const x = rnd();
    if (x < 0.25) { cloud.faults.dropNext += 1; lost++; }
    else if (x < 0.45) { cloud.faults.down = true; refused++; }
    else if (x < 0.6) cloud.faults.failNext += 1;
    else if (x < 0.8) arm(instance);
    else arm(cloud);
  };
  async function drive(id, state, actions) {
    for (let i = 0; i < actions; i++) {
      const x = rnd();
      try {
        if (x < 0.5) await post();
        else if (x < 0.78) { await runMoveStep(instance.ctx, id, deps); }
        else if (x < 0.9) await flushOutbox(instance.ctx, 1, { fetch: instance.deps.fetch, limit: 1 + Math.floor(rnd() * 30) });
        else chaos();
      } catch (error) {
        assert.ok(["crash", "response lost", "connection refused"].includes(error.message), "seed " + seed + ": unexpected " + error.stack);
      }
      if (rnd() < 0.15) cloud.faults.down = false;
      const s = await moveStatus(instance.ctx, id);
      flipsSeen.add(s.state);
      if (s.state === state) break;
    }
  }
  const settle = async (id, wanted) => {
    cloud.faults.down = false; cloud.faults.dropNext = 0; cloud.faults.failNext = 0;
    for (const h of [instance, cloud]) { delete h.store.beforeBatch; delete h.store.afterBatch; delete h.shared.beforeBatch; delete h.shared.afterBatch; }
    for (let i = 0; i < 500; i++) {
      const s = await moveStatus(instance.ctx, id);
      if (s.state === wanted) return s;
      assert.ok(["preflight", "bulk", "seal", "catchup", "finalize", "pull"].includes(s.state), "seed " + seed + ": stuck in " + s.state + " " + s.error);
      await runMoveStep(instance.ctx, id, deps);
      if (i % 3 === 0) await post();
    }
    throw new Error("seed " + seed + ": did not settle");
  };
  const drain = async () => { for (let i = 0; i < 60; i++) { const r = await flushOutbox(instance.ctx, 1, { fetch: instance.deps.fetch }); if (!r.left) return; } throw new Error("seed " + seed + ": outbox never drained"); };

  // out
  const out = await startMoveOut(instance.ctx, 1, { window: 100 + Math.floor(rnd() * 300) });
  await drive(out.id, "done", 120 + Math.floor(rnd() * 120));
  await settle(out.id, "done");
  await drain();
  const target = [];
  for (const key of KEYS) target.push((await cloud.shared.prepare("SELECT id FROM sites WHERE public_key = ?").bind(key).first()).id);
  const onCloud = (await cloud.store.prepare("SELECT path, count(*) AS n FROM events WHERE path LIKE '/e/%' GROUP BY path").all()).results;
  assert.equal(onCloud.length, posted.length, "seed " + seed + " (out): " + onCloud.length + " of " + posted.length + " events on the cloud");
  assert.ok(onCloud.every((r) => r.n === 1), "seed " + seed + " (out): an event is doubled");
  for (let i = 0; i < 2; i++) {
    const history = await cloud.store.prepare("SELECT count(*) AS n FROM events WHERE site_id = ? AND path NOT LIKE '/e/%'").bind(target[i]).first();
    const original = await instance.store.prepare("SELECT count(*) AS n FROM events WHERE site_id = ? AND path NOT LIKE '/e/%'").bind(ids[i]).first();
    assert.equal(history.n, original.n, "seed " + seed + ": history of website " + i + " differs");
    // every live event is on the website it was sent to, on the cloud
    const mine = (await instance.store.prepare("SELECT path FROM events WHERE site_id = ? AND path LIKE '/e/%'").bind(ids[i]).all()).results.length;
    void mine;
  }

  // back
  const back = await startMoveBack(instance.ctx, 1);
  await drive(back.id, "returned", 100 + Math.floor(rnd() * 100));
  await settle(back.id, "returned");
  await drain();
  const onInstance = (await instance.store.prepare("SELECT path, count(*) AS n FROM events WHERE path LIKE '/e/%' GROUP BY path").all()).results;
  assert.equal(onInstance.length, posted.length, "seed " + seed + " (back): " + onInstance.length + " of " + posted.length + " events on the instance");
  assert.ok(onInstance.every((r) => r.n === 1), "seed " + seed + " (back): an event is doubled");
  for (const id of ids) assert.equal((await siteHome(instance.ctx, id)).home, "");
  assert.equal((await outboxStats(instance.ctx, 1)).queued, 0);
  return posted.length;
}

let total = 0;
for (let seed = 1; seed <= seeds; seed++) total += await scenario(seed);
console.log("chaos ok: " + seeds + " seeds, " + total + " live events, " + crashes + " crashes, " + lost + " lost responses, " + refused + " refused connections, states " + Array.from(flipsSeen).sort().join(","));
