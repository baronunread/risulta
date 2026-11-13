// A poll, the tick and a page may all drive the same move at once: one runs, the others see the status.
import assert from "node:assert/strict";
import { makeHost, connect, seedInstance, beacon } from "./harness.mjs";
import { startMoveOut, runMove, moveStatus } from "../../src/move/moves.js";
import { count } from "./helpers.mjs";

const KEYS = ["k".repeat(32), "m".repeat(32)];
const instance = makeHost("instance", 1);
const cloud = makeHost("cloud", 7);
await connect(instance, cloud);
const ids = await seedInstance(instance, [{ key: KEYS[0], domain: "shop.test", events: 1000 }, { key: KEYS[1], domain: "blog.test", events: 500 }]);
const started = await startMoveOut(instance.ctx, 1, { window: 300 });
const deps = { fetch: instance.deps.fetch };
const posted = [];
const traffic = (async () => { for (let i = 0; i < 40; i++) { posted.push((await beacon(instance, ids[i % 2], KEYS[i % 2])).path); await new Promise((r) => setTimeout(r, 1)); } })();
await Promise.all([runMove(instance.ctx, started.id, deps), runMove(instance.ctx, started.id, deps), runMove(instance.ctx, started.id, deps), traffic]);
for (let i = 0; i < 50 && (await moveStatus(instance.ctx, started.id)).state !== "done"; i++) await runMove(instance.ctx, started.id, deps);
assert.equal((await moveStatus(instance.ctx, started.id)).state, "done");
const { flushOutbox } = await import("../../src/move/gateway.js");
for (let i = 0; i < 10; i++) { const r = await flushOutbox(instance.ctx, 1, { fetch: instance.deps.fetch }); if (!r.left) break; }
assert.equal(await count(cloud.store, "SELECT count(*) AS n FROM events WHERE path LIKE '/e/%'"), posted.length);
assert.equal(await count(cloud.store, "SELECT count(*) AS n FROM events"), 1500 + posted.length);
console.log("concurrent ok");
