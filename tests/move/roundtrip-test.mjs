import assert from "node:assert/strict";
import { makeWorld, addSite, addEvents, addMeta, collect, count } from "./helpers.mjs";
import { exportParts, estimateExport } from "../../src/move/exporter.js";
import { verifyParts, sha256 } from "../../src/move/bundle.js";
import { createImportJob, addPart, completeUpload, runJob, previewJob, startJob } from "../../src/move/importer.js";

// Source: one instance (org 1). Target: another instance, org 7, with ids that differ.
const src = makeWorld([1]);
const dst = makeWorld([7]);
const a = await addSite(src, 1, { name: "Shop", domain: "shop.test", key: "k".repeat(31) + "a", widget: 1 });
const b = await addSite(src, 1, { name: "Blog", domain: "blog.test", key: "k".repeat(31) + "b" });
await addMeta(src, 1, a);
await addEvents(src, 1, a, 6000, { seed: 3 });
await addEvents(src, 1, b, 1500, { seed: 4 });
await src.shared.prepare("INSERT INTO users (email, password_hash, role, display_name, created_at) VALUES ('boss@x.test', 'SECRET-HASH', 'admin', 'Boss', 1), ('v@x.test', 'SECRET-HASH-2', 'viewer', 'View', 1)").run();
await src.shared.prepare("INSERT INTO site_users (user_id, site_id, role) VALUES (2, ?, 'viewer')").bind(b).run();
await addSite(dst, 7, { name: "Other", domain: "other.test", key: "o".repeat(32) });
await addSite(dst, 7, { name: "Other2", domain: "other2.test", key: "p".repeat(32) });
await addSite(dst, 7, { name: "Other3", domain: "other3.test", key: "q".repeat(32) });
await addEvents(dst, 7, 3, 777, { seed: 9 });

const est = await estimateExport(src.ctx, { orgId: 1, siteIds: [a, b] });
assert.equal(est.events, 7500);

const parts = await collect(exportParts(src.ctx, { orgId: 1, siteIds: [a, b], includeUsers: true, scope: "org", partBytes: 64 * 1024 }));
assert.ok(parts.length > 4, "many parts: " + parts.length);
const all = parts.map((p) => p.text).join("");
assert.ok(!all.includes("SECRET-HASH"), "no password hash in a bundle");
assert.ok(!/password|token_hash|csrf/.test(all));
assert.ok(all.split("").every((c) => c === "\n" || (c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126)), "ASCII only");
const summary = await verifyParts(parts);
assert.equal(summary.counts.events, 7500);
assert.equal(summary.counts.users, 2);
assert.equal(summary.counts.sites, 2);

// Import the browser way: cut the stream at arbitrary byte positions.
async function importBundle(world, orgId, text, cut = 50001, options = {}) {
  const job = await createImportJob(world.ctx, { orgId, options });
  let n = 0;
  for (let i = 0; i < text.length; i += cut) {
    const chunk = text.slice(i, i + cut);
    await addPart(world.ctx, job.id, orgId, n++, chunk, await sha256(chunk));
  }
  await completeUpload(world.ctx, job.id, orgId);
  return { job, status: await runJob(world.ctx, job.id, orgId) };
}
const { job, status: verified } = await importBundle(dst, 7, all);
assert.equal(verified.state, "verified", JSON.stringify(verified));
const plan = await previewJob(dst.ctx, job.id, 7);
assert.equal(plan.sites.length, 2);
assert.ok(plan.sites.every((s) => s.action === "create"));
assert.equal(plan.invitations, 2);
assert.equal(await count(dst.stores[7], "SELECT count(*) AS n FROM events WHERE site_id > 3"), 0, "nothing is written before the owner starts it");
assert.equal(await count(dst.shared, "SELECT count(*) AS n FROM sites"), 3);
await startJob(dst.ctx, job.id, 7);
const done = await runJob(dst.ctx, job.id, 7);
assert.equal(done.state, "done", JSON.stringify(done));

const newA = await dst.shared.prepare("SELECT * FROM sites WHERE public_key = ?").bind("k".repeat(31) + "a").first();
const newB = await dst.shared.prepare("SELECT * FROM sites WHERE public_key = ?").bind("k".repeat(31) + "b").first();
assert.equal(Number(newA.org_id), 7);
assert.equal(newA.domain, "shop.test");
assert.equal(await count(dst.shared, "SELECT count(*) AS n FROM site_home"), 0, "activated: no hidden sites");
assert.equal(await count(dst.stores[7], "SELECT count(*) AS n FROM events WHERE site_id = ?", newA.id), 6000);
assert.equal(await count(dst.stores[7], "SELECT count(*) AS n FROM events WHERE site_id = ?", newB.id), 1500);
assert.equal(await count(dst.stores[7], "SELECT count(*) AS n FROM goals WHERE site_id = ?", newA.id), 2);
assert.equal(await count(dst.shared, "SELECT enabled AS n FROM public_widgets WHERE site_id = ?", newA.id), 1);
const steps = (await dst.stores[7].prepare("SELECT g.name FROM funnel_steps s JOIN goals g ON g.id = s.goal_id JOIN funnels f ON f.id = s.funnel_id WHERE f.site_id = ? ORDER BY s.position").bind(newA.id).all()).results;
assert.deepEqual(steps.map((s) => s.name), ["Pricing", "Signups"]);
const note = await dst.stores[7].prepare("SELECT text FROM annotations WHERE site_id = ?").bind(newA.id).first();
assert.equal(note.text, "Launched é 🚀");
// Events are equal after normalising ids.
const norm = async (world, orgId, siteId) => JSON.stringify((await world.stores[orgId].prepare("SELECT ts, name, path, referrer, visitor, source, value FROM events WHERE site_id = ? ORDER BY id").bind(siteId).all()).results);
assert.equal(await norm(dst, 7, newA.id), await norm(src, 1, a));
assert.equal(await norm(dst, 7, newB.id), await norm(src, 1, b));
// The other org's events never moved.
assert.equal(await count(dst.stores[7], "SELECT count(*) AS n FROM events WHERE site_id = 3"), 777);

// Round trip: export(import(bundle)) equals the bundle after ids are normalised.
const back = await collect(exportParts(dst.ctx, { orgId: 7, siteIds: [newA.id, newB.id], includeUsers: false, scope: "org", lineage: "x".repeat(16), partBytes: 64 * 1024 }));
const strip = (text) => text.split("\n").filter((l) => l && !/"t":"(manifest|trailer|user)"/.test(l)).map((l) => {
  const o = JSON.parse(l); delete o.id; delete o.ref; delete o.site; if (o.steps) o.steps = o.steps.length; return JSON.stringify(o);
}).join("\n");
assert.equal(strip(back.map((p) => p.text).join("")), strip(all));

// Importing the same bundle again changes nothing (the ledger remembers the lineage).
const events = await count(dst.stores[7], "SELECT count(*) AS n FROM events");
const again = await importBundle(dst, 7, all);
await startJob(dst.ctx, again.job.id, 7);
const second = await runJob(dst.ctx, again.job.id, 7);
assert.equal(second.state, "done", JSON.stringify(second));
assert.equal(await count(dst.stores[7], "SELECT count(*) AS n FROM events"), events, "no event is imported twice");
console.log("roundtrip ok");
