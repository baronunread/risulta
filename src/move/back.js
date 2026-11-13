// Move back: the whole instance, which lives on risulta.dev, returns.
//
// The same saga with the roles swapped. The instance still drives (it holds the
// link secret) and PULLS: risulta.dev serves the events its sites received
// natively since the move (the ones in no import range of the lineage), in
// windows of one part each. They join the instance's own frozen copies of the
// sites (attach mode), so only the delta travels.
//
//   preflight -> pull (native ids up to N') -> seal (risulta.dev fences at X')
//             -> catchup (N', X'] -> finalize (thaw here, freeze there)
//
// While it runs the instance keeps forwarding; a forward that risulta.dev
// answers with "sealed" is stored locally by the outbox flush, so no event
// of the interval is lost, and a forward it already stored is "duplicate".
import { exportParts } from "./exporter.js";
import { createImportJob, addPart, completeUpload, runJob, startJob, jobStatus, activateJobSites } from "./importer.js";
import { cloudLink } from "./link.js";
import { sealSites, setHomes, siteHome, unsealAll, markMoveActive } from "./gateway.js";
import { ensureSchema, tableExists } from "./schema.js";
import { getSite, listOrgSites } from "./registry.js";
import { sha256 } from "./bundle.js";
import { randomHex } from "../auth.js";

export const BACK_WINDOW = 12000;
const now = (ctx) => (ctx.now ? ctx.now() : Math.floor(Date.now() / 1000));

// --- instance side ------------------------------------------------------------------------------
export async function startMoveBack(ctx, orgId, helpers) {
  await ensureSchema(ctx.shared, "shared");
  const link = await cloudLink(ctx);
  if (!link) throw new helpers.MoveError("not_connected", "connect this instance to risulta.dev first", 409);
  const sites = await listOrgSites(ctx.shared, orgId);
  let lineage = "";
  for (const site of sites) {
    const state = await siteHome(ctx, site.id);
    if (state.home !== "gateway" && state.home !== "frozen") throw new helpers.MoveError("not_moved", "this instance does not live on risulta.dev", 409);
    lineage = state.lineage;
  }
  if (!lineage) throw new helpers.MoveError("not_moved", "this instance does not live on risulta.dev", 409);
  const busy = await ctx.shared.prepare("SELECT id FROM moves WHERE org_id = ? AND state IN ('preflight','pull','seal','catchup','finalize','bulk','needs_attention')").bind(orgId).first();
  if (busy) throw new helpers.MoveError("busy", "a move is in progress", 409);
  const id = randomHex(16);
  const t = now(ctx);
  await ctx.shared.prepare("INSERT INTO moves (id, org_id, direction, lineage, state, options, created_at, updated_at) VALUES (?, ?, 'back', ?, 'preflight', ?, ?, ?)").bind(id, orgId, lineage, JSON.stringify({ sites: sites.map((site) => Number(site.id)) }), t, t).run();
  return await helpers.loadMove(ctx, id).then((m) => ({ id: m.id, state: m.state }));
}

export async function runBackStep(ctx, move, deps, helpers) {
  const { saveMove, call, loadMove } = helpers;
  const link = await cloudLink(ctx);
  if (!link) { await saveMove(ctx, move, { state: "needs_attention", error: "the link to risulta.dev is gone" }); return statusOf(await loadMove(ctx, move.id)); }
  try {
    if (move.state === "preflight") await stepPreflight(ctx, move, link, deps, helpers);
    else if (move.state === "pull" || move.state === "catchup") await stepPull(ctx, move, link, deps, helpers);
    else if (move.state === "seal") await stepSeal(ctx, move, link, deps, helpers);
    else if (move.state === "finalize") await stepFinalize(ctx, move, link, deps, helpers);
  } catch (error) {
    if (error.code === "unreachable") return statusOf(await loadMove(ctx, move.id));
    if (!error.code) throw error;
    await saveMove(ctx, move, { state: "needs_attention", error: error.code + ": " + error.message });
  }
  void call;
  return statusOf(await loadMove(ctx, move.id));
}

function statusOf(m) {
  return { id: m.id, direction: m.direction, sites: (m.options.sites || []).length, lineage: m.lineage, state: m.state, step: m.step, eventsTotal: m.eventsTotal, eventsSent: m.eventsSent, sealedId: m.sealedId, error: m.error, updatedAt: m.updatedAt };
}

async function stepPreflight(ctx, move, link, deps, { saveMove, call }) {
  const info = await call(ctx, link, "POST", "/api/link/moves/" + move.lineage + "/back/preflight", "{}", deps);
  const store = ctx.store(move.orgId);
  await ensureSchema(store, "store");
  markMoveActive(store);
  // Forward first; a "sealed" answer is stored locally (see flushOutbox).
  // The target names its sites by tracker key (kept through the move): pair them with ours.
  const attach = {};
  const local = await listOrgSites(ctx.shared, move.orgId);
  for (const site of local) {
    const remote = (info.sites || []).find((r) => r.key === site.public_key);
    if (!remote) throw new helpers.MoveError("site_missing", "risulta.dev does not know the website " + site.domain, 409);
    attach[remote.id] = Number(site.id);
  }
  await setHomes(ctx, move.options.sites, "moving-back", { lineage: move.lineage, linkId: link.link_id });
  await saveMove(ctx, move, { state: "pull", afterId: 0, bulkUntil: info.max_native_id, eventsTotal: info.native_events, options: { ...move.options, attach } });
}

// One window per call: ask for the next native events, load them into the local site.
async function stepPull(ctx, move, link, deps, { saveMove, call }) {
  const catchup = move.state === "catchup";
  const limit = catchup ? move.sealedId : move.bulkUntil;
  if (move.remoteMove) {
    const status = await jobStatus(ctx, move.remoteMove, move.orgId);
    if (!status) throw Object.assign(new Error("lost the local job"), { code: "lost_job" });
    let s = status;
    if (s.state === "verified") { await startJob(ctx, move.remoteMove, move.orgId); }
    s = await runJob(ctx, move.remoteMove, move.orgId, { budgetMs: 800 });
    if (s.state === "failed" || s.state === "cancelled") throw Object.assign(new Error(s.error || s.state), { code: "local_import_failed" });
    if (s.state !== "ready" && s.state !== "done") return;
    await saveMove(ctx, move, { afterId: Number(move.step.slice(4)), step: "", remoteMove: "" });
    return;
  }
  if (move.afterId >= limit) {
    await saveMove(ctx, move, { state: catchup ? "finalize" : "seal", step: "" });
    return;
  }
  const answer = await call(ctx, link, "GET", "/api/link/moves/" + move.lineage + "/back/export?since_id=" + move.afterId + "&until_id=" + limit + "&limit=" + BACK_WINDOW, "", deps);
  const end = Number(answer.end);
  const job = await createImportJob(ctx, {
    orgId: move.orgId, lineage: move.lineage,
    options: { activate: false, rollbackOnFailure: false, home: "importing", attach: move.options.attach },
  });
  for (let n = 0; n < answer.parts.length; n++) await addPart(ctx, job.id, move.orgId, n, answer.parts[n], await sha256(answer.parts[n]));
  await completeUpload(ctx, job.id, move.orgId);
  await saveMove(ctx, move, { remoteMove: job.id, step: "end:" + end, eventsSent: move.eventsSent + Number(answer.events) });
}

async function stepSeal(ctx, move, link, deps, { saveMove, call }) {
  const answer = await call(ctx, link, "POST", "/api/link/moves/" + move.lineage + "/back/seal", "{}", deps);
  await saveMove(ctx, move, { state: "catchup", step: "", sealedId: Number(answer.sealed_id) });
}

async function stepFinalize(ctx, move, link, deps, { saveMove, call }) {
  // Thaw here: the local site is the owner again and collects directly.
  await unsealAll(ctx, move.orgId, move.options.sites);
  await setHomes(ctx, move.options.sites, "");
  await call(ctx, link, "POST", "/api/link/moves/" + move.lineage + "/back/release", "{}", deps);
  await saveMove(ctx, move, { state: "returned", step: "" });
}

// --- target side (risulta.dev) ---------------------------------------------------------------------------
const placeholders = (n) => Array.from({ length: n }, () => "?").join(",");

function nativeSql() {
  return " AND events.id > coalesce((SELECT r.last_id FROM import_ranges r WHERE r.lineage = ? AND r.site_id = events.site_id AND r.first_id <= events.id ORDER BY r.first_id DESC LIMIT 1), 0)";
}

async function linkedSitesOf(ctx, link, lineage) {
  const rows = (await ctx.shared.prepare("SELECT site_id FROM site_links WHERE lineage = ? AND link_id = ? ORDER BY site_id").bind(lineage, link.linkId).all()).results;
  const sites = [];
  for (const row of rows) {
    const site = await getSite(ctx.shared, Number(row.site_id));
    if (site && Number(site.org_id) === link.orgId) sites.push(site);
  }
  return sites;
}

export async function targetBackPreflight(ctx, link, lineage, helpers) {
  const sites = await linkedSitesOf(ctx, link, lineage);
  if (!sites.length) throw new helpers.MoveError("not_found", "not found", 404);
  const store = ctx.store(link.orgId);
  await ensureSchema(store, "store");
  const ids = sites.map((site) => site.id);
  const row = (await tableExists(store, "import_ranges"))
    ? await store.prepare("SELECT count(*) AS n, coalesce(max(id), 0) AS m FROM events WHERE site_id IN (" + placeholders(ids.length) + ")" + nativeSql()).bind(...ids, lineage).first()
    : await store.prepare("SELECT count(*) AS n, coalesce(max(id), 0) AS m FROM events WHERE site_id IN (" + placeholders(ids.length) + ")").bind(...ids).first();
  return { ok: true, sites: sites.map((site) => ({ id: Number(site.id), key: site.public_key })), native_events: Number(row.n), max_native_id: Number(row.m) };
}

// One window of native events, as a single bundle part.
export async function targetBackExport(ctx, link, lineage, { sinceId, untilId, limit }, helpers) {
  const sites = await linkedSitesOf(ctx, link, lineage);
  if (!sites.length) throw new helpers.MoveError("not_found", "not found", 404);
  const ids = sites.map((site) => site.id);
  const store = ctx.store(link.orgId);
  const advised = ctx.limits && ctx.limits.move ? ((await ctx.limits.move(link.orgId)) || {}).window || 0 : 0;
  const max = Math.min(Number(limit) || BACK_WINDOW, BACK_WINDOW, advised || BACK_WINDOW);
  const inList = " AND site_id IN (" + placeholders(ids.length) + ")";
  const edge = await store.prepare("SELECT id FROM events NOT INDEXED WHERE id > ? AND id <= ?" + inList + nativeSql() + " ORDER BY id LIMIT 1 OFFSET ?").bind(sinceId, untilId, ...ids, lineage, max - 1).first();
  const end = edge ? Number(edge.id) : untilId;
  const parts = [];
  for await (const part of exportParts(ctx, { orgId: link.orgId, siteIds: ids, lineage, sinceId, untilId: end, skipLineage: lineage, scope: "org", partBytes: 900000 })) parts.push(part.text);
  const eventsRow = await store.prepare("SELECT count(*) AS n FROM events NOT INDEXED WHERE id > ? AND id <= ?" + inList + nativeSql()).bind(sinceId, end, ...ids, lineage).first();
  return { end, events: Number(eventsRow.n), parts };
}

export async function targetBackSeal(ctx, link, lineage, helpers) {
  const sites = await linkedSitesOf(ctx, link, lineage);
  if (!sites.length) throw new helpers.MoveError("not_found", "not found", 404);
  const fence = await sealSites(ctx, link.orgId, sites.map((site) => site.id));
  return { ok: true, sealed_id: Math.max(fence.maxId, 1) };
}

export async function targetBackRelease(ctx, link, lineage, helpers) {
  const sites = await linkedSitesOf(ctx, link, lineage);
  if (!sites.length) throw new helpers.MoveError("not_found", "not found", 404);
  const store = ctx.store(link.orgId);
  if (!(await tableExists(store, "site_fence"))) throw new helpers.MoveError("not_sealed", "seal first", 409);
  for (const site of sites) {
    const fence = await store.prepare("SELECT 1 AS ok FROM site_fence WHERE site_id = ?").bind(site.id).first();
    if (!fence) throw new helpers.MoveError("not_sealed", "seal first", 409);
  }
  await setHomes(ctx, sites.map((site) => site.id), "frozen", { lineage, linkId: link.linkId });
  return { ok: true };
}
export { activateJobSites };
