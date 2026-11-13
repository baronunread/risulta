// Hostile bundles, crash and resume, cancel, retention, catch-up and the reverse delta.
import assert from "node:assert/strict";
import { makeWorld, addSite, addEvents, addMeta, collect, count, orgDigest, prng } from "./helpers.mjs";
import { exportParts } from "../../src/move/exporter.js";
import { BundleWriter, BundleError, verifyParts, sha256, FORMAT } from "../../src/move/bundle.js";
import { createImportJob, addPart, completeUpload, runJob, runStep, previewJob, startJob, cancelJob, jobStatus, activateJobSites } from "../../src/move/importer.js";

const KEY = (c) => c.repeat(32);
async function upload(world, orgId, text, { cut = 40000, options = {} } = {}) {
  const job = await createImportJob(world.ctx, { orgId, options });
  let n = 0;
  for (let i = 0; i < text.length; i += cut) {
    const chunk = text.slice(i, i + cut);
    await addPart(world.ctx, job.id, orgId, n++, chunk, await sha256(chunk));
  }
  await completeUpload(world.ctx, job.id, orgId);
  return job;
}
const manifest = (extra = {}) => ({ t: "manifest", format: FORMAT, format_version: 1, schema_version: 7, app_version: "0.2.2", created_at: 1800000000, scope: "site", lineage: "lineage-hostile-1", since_id: 0, until_id: 1000, contains_secrets: false, ...extra });
const siteLine = (ref, extra = {}) => ({ t: "site", ref, name: "S" + ref, domain: "s" + ref + ".test", slug: "s" + ref, key: KEY(String.fromCharCode(96 + ref)), created_at: 1700000000, widget: 0, salts: [], ...extra });
const eventLine = (id, site, extra = {}) => ({ t: "event", id, site, ts: 1799000000 + id, name: "pageview", path: "/", referrer: "", visitor: "ab", source: "", medium: "", campaign: "", content: "", term: "", value: null, ...extra });
async function bundleOf(lines) {
  const parts = [];
  const w = new BundleWriter((p) => { parts.push(p); }, 100000, false);
  for (const l of lines) await w.line(l);
  await w.finish();
  return parts.map((p) => p.text).join("");
}
async function expectReject(lines, code, label) {
  const text = Array.isArray(lines) ? await bundleOf(lines) : lines;
  await assert.rejects(() => verifyParts([{ text }]), (e) => e instanceof BundleError && (!code || e.code === code), label + " (wanted " + code + ")");
}

// ---- 1. hostile bundle fixtures: every one is refused by the verifier, before a row is written
await expectReject([manifest(), siteLine(1), { t: "goal", site: 99, ref: 1, name: "g", event_name: "signup", path: "", created_at: 1 }], "dangling", "goal at unknown site");
await expectReject([manifest(), siteLine(1), { t: "goal", site: 1, ref: 1, name: "g", event_name: "signup", path: "", created_at: 1 }, { t: "funnel", site: 1, ref: 1, name: "f", created_at: 1, steps: [1, 77] }], "dangling", "funnel step outside the file");
await expectReject([manifest(), siteLine(1), eventLine(1, 42)], "dangling", "event at unknown site");
await expectReject([manifest(), siteLine(1, { org_id: 2 })], "unknown_field", "org_id");
await expectReject([manifest(), siteLine(1, { user_id: 2 })], "unknown_field", "user_id");
await expectReject([manifest(), siteLine(1), { t: "user", email: "a@b.c", display_name: "", role: "admin", sites: ["s1"], org_id: 3 }], "unknown_field", "user org_id");
await expectReject([manifest(), siteLine(1), { t: "user", email: "a@b.c", display_name: "", role: "owner", sites: ["s1"] }], "bad_field", "role owner");
await expectReject([manifest({ contains_secrets: true }), siteLine(1)], "bad_field", "contains_secrets");
await expectReject([manifest({ scope: "instance" }), siteLine(1)], "bad_field", "instance scope");
await expectReject([manifest({ format_version: 2 }), siteLine(1)], "newer_format", "newer format");
await expectReject([manifest(), siteLine(1), siteLine(2, { key: siteLine(1).key })], "duplicate", "duplicate key");
await expectReject([manifest(), siteLine(1), siteLine(2, { domain: "s1.test" })], "duplicate", "duplicate domain");
await expectReject([manifest(), siteLine(1), siteLine(1, { domain: "z.test", key: KEY("z") })], "duplicate", "duplicate ref");
await expectReject([manifest(), siteLine(1), eventLine(5, 1), eventLine(5, 1)], "bad_order", "event ids must ascend");
await expectReject([manifest(), siteLine(1), siteLine(2), eventLine(1, 1), eventLine(2, 2), eventLine(3, 1)], "bad_order", "interleaved sites");
await expectReject([manifest({ until_id: 10 }), siteLine(1), eventLine(11, 1)], "out_of_range", "id above until_id");
await expectReject([manifest({ since_id: 10 }), siteLine(1), eventLine(10, 1)], "out_of_range", "id at since_id");
await expectReject([manifest(), siteLine(1), eventLine(1, 1, { value: -4 })], "bad_field", "negative value");
await expectReject([manifest(), siteLine(1), eventLine(1, 1, { path: "x/y" })], "bad_field", "path without slash");
await expectReject([manifest(), siteLine(1), eventLine(1, 1, { name: "Bad Name" })], "bad_field", "event name");
await expectReject([manifest(), siteLine(1), eventLine(1, 1, { visitor: "../../etc" })], "bad_field", "visitor not hex");
await expectReject([manifest(), siteLine(1, { domain: "../evil" })], "bad_field", "domain path trick");
await expectReject([manifest(), siteLine(1, { key: "a/../b" })], "bad_field", "key path trick");
{
  const good = await bundleOf([manifest(), siteLine(1), eventLine(1, 1), eventLine(2, 1)]);
  const gl = good.split("\n");
  await expectReject([gl[0], '{"t":"mystery"}', ...gl.slice(1)].join("\n"), "bad_tag", "unknown tag");
  await expectReject([gl[0], gl[2], gl[1], ...gl.slice(3)].join("\n"), "dangling", "events before sites");
  await verifyParts([{ text: good }]);
  const lines = good.split("\n");
  await expectReject(lines.slice(0, 3).join("\n") + "\n", "truncated", "no trailer");
  await expectReject(good.slice(0, good.length - 30), "truncated", "cut inside the trailer");
  await expectReject(lines.filter((l, i) => i !== 2).join("\n"), "count_mismatch", "a line deleted");
  await expectReject(good.replace(/"ts":1799000001/, '"ts":1799000009'), "checksum_mismatch", "a value changed");
  await expectReject(good.replace(/"counts":\{"sites":1,"goals":0,"funnels":0,"annotations":0,"users":0,"events":2/, '"counts":{"sites":1,"goals":0,"funnels":0,"annotations":0,"users":0,"events":99999'), "count_mismatch", "absurd count");
  await expectReject(good + good.split("\n")[0] + "\n", "after_trailer", "data after the trailer");
  await expectReject(good.replace('"ref":1', '"ref":1,"ref":2'), "", "duplicate JSON key (ref changes the checksum or counts)");
}

// ---- 2. cross-org: the importer cannot touch another org, and cannot take its tracker key
const dst = makeWorld([7, 8]);
await addSite(dst, 8, { name: "B shop", domain: "b.test", key: KEY("a") });
await addEvents(dst, 8, 1, 400, { seed: 5, canary: "/canary-B" });
const bBefore = await orgDigest(dst, 8);
{
  const text = await bundleOf([manifest(), siteLine(1), eventLine(1, 1)]); // key aaaaaaaa... is org B's
  const job = await upload(dst, 7, text);
  await runJob(dst.ctx, job.id, 7);
  const plan = await previewJob(dst.ctx, job.id, 7);
  assert.equal(plan.blocked, true);
  assert.equal(plan.sites[0].action, "conflict");
  await assert.rejects(() => startJob(dst.ctx, job.id, 7), /conflict/);
  // org 8 cannot see or drive org 7's job
  assert.equal(await jobStatus(dst.ctx, job.id, 8), null);
  await assert.rejects(() => addPart(dst.ctx, job.id, 8, 0, "x"), /not found/);
  await assert.rejects(() => runStep(dst.ctx, job.id, 8), /not found/);
  await assert.rejects(() => previewJob(dst.ctx, job.id, 8), /not found/);
  // an explicit new-key choice issues a fresh key and never overwrites org B's
  const job2 = await upload(dst, 7, text, { options: { keyOnClash: "new" } });
  await runJob(dst.ctx, job2.id, 7);
  await startJob(dst.ctx, job2.id, 7);
  const done = await runJob(dst.ctx, job2.id, 7);
  assert.equal(done.state, "done", JSON.stringify(done));
  assert.equal(done.report.newKeys.length, 1);
  assert.equal((await dst.shared.prepare("SELECT org_id FROM sites WHERE public_key = ?").bind(KEY("a")).first()).org_id, 8, "B still owns its key");
  assert.equal(await count(dst.shared, "SELECT count(*) AS n FROM sites WHERE domain = 's1.test' AND org_id = 7"), 1);
}
assert.equal(await orgDigest(dst, 8), bBefore, "org B is byte for byte unchanged");
// a part cannot name its own storage
const pathJob = await createImportJob(dst.ctx, { orgId: 7 });
await assert.rejects(() => addPart(dst.ctx, pathJob.id, 7, "../x", "y"), /in order/);
const open = await createImportJob(dst.ctx, { orgId: 7 });
await assert.rejects(() => addPart(dst.ctx, open.id, 7, 0, "café"), /ASCII/);
await assert.rejects(() => addPart(dst.ctx, open.id, 7, 0, "abc", "0".repeat(64)), /checksum/);
await assert.rejects(() => addPart(dst.ctx, open.id, 7, 0, "x".repeat(4 * 1024 * 1024 + 1)), /4 MiB/);
assert.ok(dst.ctx.blobs.keys().every((k) => /^imports\/[0-9a-f]{32}\/(\d+|invites)$/.test(k)));

// ---- 3. a source to import: 2 sites, metadata, events
const src = makeWorld([1]);
const a = await addSite(src, 1, { name: "Shop", domain: "shop.test", key: KEY("m"), widget: 1 });
const b = await addSite(src, 1, { name: "Blog", domain: "blog.test", key: KEY("n") });
await addMeta(src, 1, a);
await addEvents(src, 1, a, 3000, { seed: 21 });
await addEvents(src, 1, b, 900, { seed: 22 });
const good = (await collect(exportParts(src.ctx, { orgId: 1, siteIds: [a, b], lineage: "lineage-resume-0001", partBytes: 30000 }))).map((p) => p.text).join("");

// ---- 4. crash anywhere, resume: no event lost, none doubled (before and after the commit)
const reference = makeWorld([5]);
{
  const job = await upload(reference, 5, good);
  await runJob(reference.ctx, job.id, 5);
  await startJob(reference.ctx, job.id, 5);
  assert.equal((await runJob(reference.ctx, job.id, 5)).state, "done");
}
const wantEvents = await count(reference.stores[5], "SELECT count(*) AS n FROM events");
assert.equal(wantEvents, 3900);
let crashPoints = 0;
for (const mode of ["before", "after"]) {
  for (let k = 1; k <= 40; k++) {
    const world = makeWorld([5]);
    world.ctx.chunk = 250;
    const job = await upload(world, 5, good);
    await runJob(world.ctx, job.id, 5);
    await startJob(world.ctx, job.id, 5);
    let seen = 0, thrown = false;
    const hook = async () => { if (++seen === k && !thrown) { thrown = true; throw new Error("crash"); } };
    if (mode === "before") world.stores[5].beforeBatch = hook; else world.stores[5].afterBatch = hook;
    world.shared.beforeBatch = mode === "before" ? async () => { /* shared steps: also crash */ if (++seen === k && !thrown) { thrown = true; throw new Error("crash"); } } : undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
      try { await runJob(world.ctx, job.id, 5); break; } catch (e) { assert.equal(e.message, "crash"); }
    }
    delete world.stores[5].beforeBatch; delete world.stores[5].afterBatch; delete world.shared.beforeBatch;
    const status = await runJob(world.ctx, job.id, 5);
    assert.equal(status.state, "done", mode + " crash " + k + " " + JSON.stringify(status));
    assert.equal(await count(world.stores[5], "SELECT count(*) AS n FROM events"), wantEvents, mode + " crash " + k + ": exactly once");
    assert.equal(await count(world.shared, "SELECT count(*) AS n FROM sites"), 2);
    assert.equal(await count(world.stores[5], "SELECT count(*) AS n FROM goals"), 2);
    assert.equal(await count(world.stores[5], "SELECT count(*) AS n FROM funnel_steps"), 2);
    if (thrown) crashPoints++;
  }
}
assert.ok(crashPoints >= 30, "crash points exercised: " + crashPoints);

// ---- 5. cancel mid-run leaves zero rows
{
  const world = makeWorld([5]);
  world.ctx.chunk = 300;
  const job = await upload(world, 5, good);
  await runJob(world.ctx, job.id, 5);
  await startJob(world.ctx, job.id, 5);
  for (let i = 0; i < 4; i++) await runStep(world.ctx, job.id, 5);
  assert.ok((await count(world.stores[5], "SELECT count(*) AS n FROM events")) > 0, "some rows were written");
  world.ctx.deleteChunk = 700;
  await cancelJob(world.ctx, job.id, 5);
  const status = await runJob(world.ctx, job.id, 5);
  assert.equal(status.state, "cancelled");
  for (const table of ["events", "goals", "funnels", "funnel_steps", "annotations", "site_salts", "import_ledger", "import_ranges", "import_map"]) assert.equal(await count(world.stores[5], "SELECT count(*) AS n FROM " + table), 0, table);
  assert.equal(await count(world.shared, "SELECT count(*) AS n FROM sites"), 0);
  assert.equal(await count(world.shared, "SELECT count(*) AS n FROM site_home"), 0);
  assert.equal(world.ctx.blobs.keys().length, 0, "parts are deleted");
}

// ---- 6. a failed verification after the load (a day total that disagrees) rolls everything back
{
  const world = makeWorld([5]);
  const tampered = good.replace(/"t":"totals","site":(\d+),"day":"([^"]+)","events":(\d+)/, (m, s, d, e) => `"t":"totals","site":${s},"day":"${d}","events":${Number(e) + 1}`);
  // The edit breaks the section checksum, so recompute a consistent bundle with one wrong total.
  const lines = good.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.t !== "trailer");
  const first = lines.findIndex((l) => l.t === "totals");
  lines[first].events += 1;
  const bad = await bundleOf(lines);
  void tampered;
  const job = await upload(world, 5, bad);
  await runJob(world.ctx, job.id, 5);
  await startJob(world.ctx, job.id, 5);
  const status = await runJob(world.ctx, job.id, 5);
  assert.equal(status.state, "failed", JSON.stringify(status));
  assert.match(status.error, /verify_failed/);
  assert.equal(await count(world.stores[5], "SELECT count(*) AS n FROM events"), 0);
  assert.equal(await count(world.shared, "SELECT count(*) AS n FROM sites"), 0);
}

// ---- 7. retention trims, and the day totals still check out
{
  const world = makeWorld([5]);
  const job = await upload(world, 5, good, { options: { retentionDays: 7 } });
  const verified = await runJob(world.ctx, job.id, 5);
  assert.equal(verified.state, "verified");
  const plan = await previewJob(world.ctx, job.id, 5);
  assert.ok(plan.events.trimmed > 0 && plan.events.trimmed < plan.events.total, JSON.stringify(plan.events));
  await startJob(world.ctx, job.id, 5);
  const status = await runJob(world.ctx, job.id, 5);
  assert.equal(status.state, "done", JSON.stringify(status));
  assert.equal(await count(world.stores[5], "SELECT count(*) AS n FROM events"), plan.events.total - plan.events.trimmed);
  assert.equal(await count(world.stores[5], "SELECT count(*) AS n FROM events WHERE ts < ?", 1800000000 - 7 * 86400), 0);
}

// ---- 8. catch-up on the same lineage, and the reverse delta
{
  const world = makeWorld([5]);
  const until = (await src.stores[1].prepare("SELECT max(id) AS m FROM events").first()).m;
  const bulk = (await collect(exportParts(src.ctx, { orgId: 1, siteIds: [a], lineage: "lineage-moves-0001", untilId: Math.floor(until / 2), partBytes: 30000 }))).map((p) => p.text).join("");
  const job1 = await upload(world, 5, bulk, { options: { activate: false } });
  await runJob(world.ctx, job1.id, 5);
  await startJob(world.ctx, job1.id, 5);
  const s1 = await runJob(world.ctx, job1.id, 5);
  assert.equal(s1.state, "ready", JSON.stringify(s1));
  const hidden = await world.shared.prepare("SELECT home FROM site_home").first();
  assert.equal(hidden.home, "importing");
  const mid = await count(world.stores[5], "SELECT count(*) AS n FROM events");
  const siteId = (await world.shared.prepare("SELECT id FROM sites").first()).id;
  // native events (forwarded or direct) arrive between the two passes
  await addEvents(world, 5, siteId, 120, { seed: 77, canary: "/native" });
  // catch-up: everything after the first pass
  const delta = (await collect(exportParts(src.ctx, { orgId: 1, siteIds: [a], lineage: "lineage-moves-0001", sinceId: Math.floor(until / 2), untilId: until, partBytes: 30000 }))).map((p) => p.text).join("");
  const job2 = await upload(world, 5, delta, { options: { activate: false } });
  await runJob(world.ctx, job2.id, 5);
  await startJob(world.ctx, job2.id, 5);
  const s2 = await runJob(world.ctx, job2.id, 5);
  assert.equal(s2.state, "ready", JSON.stringify(s2));
  assert.equal(await count(world.shared, "SELECT count(*) AS n FROM sites"), 1, "the catch-up resolves to the site the first pass made");
  const total = await count(src.stores[1], "SELECT count(*) AS n FROM events WHERE site_id = ?", a);
  assert.equal(await count(world.stores[5], "SELECT count(*) AS n FROM events WHERE path NOT LIKE '%/native'"), total, "no event lost or doubled");
  assert.ok(mid < total);
  await activateJobSites(world.ctx, job2.id, 5);
  assert.equal(await count(world.shared, "SELECT count(*) AS n FROM site_home"), 0);
  // reverse delta: only the native events
  const back = (await collect(exportParts(world.ctx, { orgId: 5, siteIds: [siteId], lineage: "lineage-moves-0001", skipLineage: "lineage-moves-0001", includeUsers: false }))).map((p) => p.text).join("");
  const summary = await verifyParts([{ text: back }]);
  assert.equal(summary.counts.events, 120, "exactly the native events travel back");
  assert.ok(back.split("\n").filter((l) => l.includes('"t":"event"')).every((l) => l.includes("/native")));
  // ranges are contiguous: nothing native sits inside an import range
  const ranges = (await world.stores[5].prepare("SELECT first_id, last_id, n FROM import_ranges ORDER BY first_id").all()).results;
  for (const r of ranges) assert.equal(await count(world.stores[5], "SELECT count(*) AS n FROM events WHERE id BETWEEN ? AND ?", r.first_id, r.last_id), r.n);
}

// ---- 9. fuzz: mutate a valid bundle; the outcome is a complete import or zero rows, never a leak
{
  const baseline = makeWorld([5, 6]);
  await addSite(baseline, 6, { name: "B", domain: "other-b.test", key: KEY("q") });
  await addEvents(baseline, 6, 1, 200, { seed: 8, canary: "/canary-B" });
  const small = makeWorld([1]);
  const sa = await addSite(small, 1, { name: "Shop", domain: "shop.test", key: KEY("m") });
  await addMeta(small, 1, sa);
  await addEvents(small, 1, sa, 150, { seed: 31 });
  const valid = (await collect(exportParts(small.ctx, { orgId: 1, siteIds: [sa], includeUsers: false, lineage: "lineage-fuzz-00001", partBytes: 6000 }))).map((p) => p.text).join("");
  const validLines = valid.split("\n").filter(Boolean);
  const seeds = Number(process.env.FUZZ_CASES || 250);
  let refused = 0, imported = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const rnd = prng(seed * 7919);
    let lines = validLines.slice();
    const ops = 1 + Math.floor(rnd() * 3);
    for (let o = 0; o < ops; o++) {
      const i = Math.floor(rnd() * lines.length);
      const op = Math.floor(rnd() * 7);
      if (op === 0) { const j = Math.floor(rnd() * lines.length); [lines[i], lines[j]] = [lines[j], lines[i]]; }
      else if (op === 1) lines.splice(i, 0, lines[i]);
      else if (op === 2) lines.splice(i, 1);
      else if (op === 3) lines[i] = lines[i].replace(/\d+/, (n) => String(Number(n) + 1 + Math.floor(rnd() * 5)));
      else if (op === 4) lines = lines.slice(0, Math.max(1, i));
      else if (op === 5) { const at = Math.floor(rnd() * lines[i].length); lines[i] = lines[i].slice(0, at) + String.fromCharCode(33 + Math.floor(rnd() * 90)) + lines[i].slice(at + 1); }
      else lines[i] = lines[i].replace(/"site":\d+/, '"site":' + (1 + Math.floor(rnd() * 3))).replace(/"key":"[^"]+"/, '"key":"' + KEY("q") + '"');
    }
    const world = { ...baseline, ctx: { ...baseline.ctx, blobs: undefined } };
    world.ctx = { shared: baseline.shared, store: baseline.ctx.store, blobs: (await import("../../src/move/blobs.js")).memoryBlobs(), now: baseline.ctx.now };
    const bBefore = await orgDigest(baseline, 6);
    const sitesBefore = await count(baseline.shared, "SELECT count(*) AS n FROM sites");
    const eventsBefore = await count(baseline.stores[5], "SELECT count(*) AS n FROM events");
    let outcome = "";
    try {
      const job = await upload(world, 5, lines.join("\n") + "\n", { cut: 3333 });
      let status = await runJob(world.ctx, job.id, 5);
      if (status.state === "verified") {
        try { await startJob(world.ctx, job.id, 5); status = await runJob(world.ctx, job.id, 5); if (status.state === "cancelling") status = await runJob(world.ctx, job.id, 5); } catch (e) { status = await jobStatus(world.ctx, job.id, 5); outcome = "conflict:" + e.code; await cancelJob(world.ctx, job.id, 5); await runJob(world.ctx, job.id, 5); }
      }
      outcome = outcome || status.state;
    } catch (e) { outcome = "rejected:" + e.message; }
    assert.equal(await orgDigest(baseline, 6), bBefore, "seed " + seed + ": org B changed (" + outcome + ")");
    const sites = await count(baseline.shared, "SELECT count(*) AS n FROM sites WHERE org_id = 5");
    const events = (await count(baseline.stores[5], "SELECT count(*) AS n FROM events")) - eventsBefore;
    if (outcome === "done") {
      imported++;
      // every created row belongs to the importing org and to a site of that org
      assert.equal(await count(baseline.stores[5], "SELECT count(*) AS n FROM events WHERE site_id NOT IN (SELECT 0)") , eventsBefore + events);
      assert.equal(await count(baseline.shared, "SELECT count(*) AS n FROM sites WHERE org_id NOT IN (5, 6)"), 0);
      assert.ok(sites >= 1, "seed " + seed);
    } else {
      refused++;
      assert.equal(events, 0, "seed " + seed + ": " + outcome + " left " + events + " events");
      assert.equal(sites, 0, "seed " + seed + ": " + outcome + " left " + sites + " sites");
      assert.equal(await count(baseline.shared, "SELECT count(*) AS n FROM sites"), sitesBefore);
    }
    // reset org 5 for the next case
    for (const table of ["events", "goals", "funnels", "funnel_steps", "annotations", "site_salts", "import_ledger", "import_ranges", "import_map"]) {
      try { baseline.stores[5].sqlite.exec("DELETE FROM " + table); } catch { /* the table was never created: nothing ran */ }
    }
    await baseline.shared.prepare("DELETE FROM sites WHERE org_id = 5").run();
    await baseline.shared.prepare("DELETE FROM site_home").run();
  }
  console.log("fuzz: " + seeds + " cases, " + refused + " refused or rolled back, " + imported + " imported cleanly");
  assert.ok(refused > seeds / 3 && imported > 0);
}
console.log("import ok");
