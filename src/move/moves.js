// Moves: move the whole instance to risulta.dev (out) and back, driven from the instance.
//
// "Everything" is every website of the org with its goals, funnels, notes and events,
// and the list of people with access (as invitations). The instance holds the link
// secret, so it always drives. A move is a saga of small steps, each safe to repeat,
// whose only commit points are the registry `home` of each site on each side:
//
//   preflight -> bulk (windows of ids up to N, the sites keep collecting)
//             -> seal (one fence per site, X = the highest id; the instance becomes the gateway)
//             -> catchup (ids in (N, X]) -> finalize (the target activates every site at once)
//
// One lineage, one id sequence: a window is a range of event ids across all sites, so the
// copy and the delta are exact for the instance as a whole. Windows are independent bundles
// of the same lineage: the target's ledger makes "up to N, then N to X" exact, and every
// window is resumable. The per-site rows (`site_home`, `site_fence`, the import ledger)
// stay: they are what makes the traffic gate of each beacon one statement.
import { exportParts, estimateExport } from "./exporter.js";
import { createImportJob, addPart, completeUpload, runJob, startJob, jobStatus, cancelJob, activateJobSites } from "./importer.js";
import { cloudLink, signRequest } from "./link.js";
import { sealSites, setHomes, markMoveActive, siteHome } from "./gateway.js";
import { ensureSchema, tableExists } from "./schema.js";
import { getSiteByKey, listOrgSites, widgetEnabled } from "./registry.js";
import * as back from "./back.js";
import { randomHex } from "../auth.js";

export const WINDOW = 5000;
// A wire part stays under the standalone binary's default request body limit (SB_REQUEST_BODY_MAX, 1 MiB).
export const WIRE_PART_BYTES = 1000000;
export class MoveError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const now = (ctx) => (ctx.now ? ctx.now() : Math.floor(Date.now() / 1000));
const parse = (text) => { try { return JSON.parse(text); } catch { return {}; } };

// --- calling the other side (instance -> target) ------------------------------------------
async function call(ctx, link, method, path, body = "", { fetch: doFetch = fetch } = {}) {
  const ts = now(ctx);
  let response;
  try {
    response = await doFetch(link.remote_origin + path, {
      method, headers: { authorization: await signRequest({ linkId: link.link_id, secret: link.secret }, method, path, body, ts), "content-type": "application/json" },
      body: method === "GET" ? undefined : body,
    });
  } catch {
    throw new MoveError("unreachable", "risulta.dev cannot be reached from this instance", 502);
  }
  let data = {};
  try { data = await response.json(); } catch { data = {}; }
  // A server error is the other side being busy or restarting: try again later, never abort.
  if (response.status >= 500) throw new MoveError("unreachable", "risulta.dev is busy, retrying", 502);
  if (response.status >= 400) throw new MoveError(data.code || "refused", data.error || "the other side refused (" + response.status + ")", response.status);
  return data;
}

// --- the move record (instance side) -------------------------------------------------------
async function loadMove(ctx, id) {
  const row = await ctx.shared.prepare("SELECT * FROM moves WHERE id = ?").bind(String(id)).first();
  if (!row) return null;
  return { id: row.id, orgId: Number(row.org_id), direction: row.direction, lineage: row.lineage, state: row.state, step: row.step, afterId: Number(row.after_id), bulkUntil: Number(row.bulk_until), sealedId: Number(row.sealed_id), remoteMove: row.remote_move, eventsTotal: Number(row.events_total), eventsSent: Number(row.events_sent), error: row.error, options: parse(row.options), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
async function saveMove(ctx, move, patch = {}) {
  Object.assign(move, patch);
  move.updatedAt = now(ctx);
  await ctx.shared.prepare("UPDATE moves SET state = ?, step = ?, after_id = ?, bulk_until = ?, sealed_id = ?, remote_move = ?, events_total = ?, events_sent = ?, error = ?, options = ?, updated_at = ? WHERE id = ?")
    .bind(move.state, move.step, move.afterId, move.bulkUntil, move.sealedId, move.remoteMove, move.eventsTotal, move.eventsSent, move.error, JSON.stringify(move.options), move.updatedAt, move.id).run();
  return move;
}
export async function moveStatus(ctx, id) {
  const m = await loadMove(ctx, id);
  if (!m) return null;
  return { id: m.id, direction: m.direction, sites: (m.options.sites || []).length, lineage: m.lineage, state: m.state, step: m.step, eventsTotal: m.eventsTotal, eventsSent: m.eventsSent, sealedId: m.sealedId, error: m.error, updatedAt: m.updatedAt };
}
export async function listMoves(ctx) {
  if (!(await tableExists(ctx.shared, "moves"))) return [];
  const rows = (await ctx.shared.prepare("SELECT id FROM moves ORDER BY created_at DESC LIMIT 20").all()).results;
  const out = [];
  for (const row of rows) out.push(await moveStatus(ctx, row.id));
  return out;
}

const LIVE = ["preflight", "bulk", "seal", "catchup", "finalize"];

// --- starting a move out --------------------------------------------------------------------------
// The manifest the target is asked about: every site of the org, by name, domain and key.
async function manifestSites(ctx, sites) {
  const out = [];
  for (const site of sites) out.push({ name: site.name, domain: site.domain, slug: site.slug || "", key: site.public_key, widget: await widgetEnabled(ctx.shared, site.id) });
  return out;
}
const idsOf = (sites) => sites.map((site) => Number(site.id));

export async function previewMoveOut(ctx, orgId, deps = {}) {
  const link = await cloudLink(ctx);
  if (!link) throw new MoveError("not_connected", "connect this instance to risulta.dev first", 409);
  const sites = await listOrgSites(ctx.shared, orgId);
  if (!sites.length) throw new MoveError("no_sites", "this instance has no websites to move", 409);
  const est = await estimateExport(ctx, { orgId, siteIds: idsOf(sites) });
  const lineage = randomHex(16);
  const remote = await call(ctx, link, "POST", "/api/link/moves/preflight", JSON.stringify({ lineage, sites: await manifestSites(ctx, sites), events: est.events, minTs: est.minTs, maxTs: est.maxTs }), deps);
  const perSite = [];
  for (const site of sites) {
    const one = await estimateExport(ctx, { orgId, siteIds: [site.id] });
    perSite.push({ id: site.id, name: site.name, domain: site.domain, key: site.public_key, events: one.events });
  }
  const people = await countPeople(ctx);
  return { sites: perSite, events: est.events, minTs: est.minTs, maxTs: est.maxTs, people, remote, bytes: est.bytes };
}

async function countPeople(ctx) {
  if (!(await tableExists(ctx.shared, "users"))) return 0;
  // The people the bundle carries: admins, and members who can see at least one website.
  return Number((await ctx.shared.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin' OR id IN (SELECT user_id FROM site_users)").first()).n);
}

export async function startMoveOut(ctx, orgId, options = {}, deps = {}) {
  await ensureSchema(ctx.shared, "shared");
  const link = await cloudLink(ctx);
  if (!link) throw new MoveError("not_connected", "connect this instance to risulta.dev first", 409);
  const sites = await listOrgSites(ctx.shared, orgId);
  if (!sites.length) throw new MoveError("no_sites", "this instance has no websites to move", 409);
  // One move per instance: a started, settled-by-move-back or failed move may be followed by a new one.
  const live = await ctx.shared.prepare("SELECT id FROM moves WHERE org_id = ? AND ((direction = 'out' AND state IN ('preflight','bulk','seal','catchup','finalize','needs_attention')) OR (direction = 'back' AND state IN ('preflight','pull','seal','catchup','finalize','needs_attention')))").bind(orgId).first();
  if (live) throw new MoveError("busy", "a move is already in progress", 409);
  for (const site of sites) {
    const state = await siteHome(ctx, site.id);
    if (state.home) throw new MoveError("busy", "this instance has already moved (or is moving)", 409);
  }
  const lineage = options.lineage || randomHex(16);
  const est = await estimateExport(ctx, { orgId, siteIds: idsOf(sites) });
  const id = randomHex(16);
  const t = now(ctx);
  await ctx.shared.prepare("INSERT INTO moves (id, org_id, direction, lineage, state, step, events_total, options, created_at, updated_at) VALUES (?, ?, 'out', ?, 'preflight', '', ?, ?, ?, ?)")
    .bind(id, orgId, lineage, est.events, JSON.stringify({ window: options.window || WINDOW, chunk: options.chunk || 0 }), t, t).run();
  void deps;
  return await moveStatus(ctx, id);
}

// --- the step loop ------------------------------------------------------------------------------------
// One driver per move at a time, in this process: a poll, the tick and the page can all ask for a step.
const running = new Set();
export async function runMoveStep(ctx, id, deps = {}) {
  if (running.has(id)) return await moveStatus(ctx, id);
  running.add(id);
  try {
    return await runMoveStepOnce(ctx, id, deps);
  } finally {
    running.delete(id);
  }
}

async function runMoveStepOnce(ctx, id, deps) {
  const move = await loadMove(ctx, id);
  if (!move) throw new MoveError("not_found", "move not found", 404);
  if (move.direction === "back") return await runBackStep(ctx, move, deps);
  const link = await cloudLink(ctx);
  if (!link && LIVE.indexOf(move.state) >= 0) { await saveMove(ctx, move, { state: "needs_attention", error: "the link to risulta.dev is gone" }); return await moveStatus(ctx, id); }
  try {
    if (move.state === "preflight") await stepPreflight(ctx, move, link, deps);
    else if (move.state === "bulk" || move.state === "catchup") await stepWindow(ctx, move, link, deps);
    else if (move.state === "seal") await stepSeal(ctx, move);
    else if (move.state === "finalize") await stepFinalize(ctx, move, link, deps);
  } catch (error) {
    if (!(error instanceof MoveError)) throw error;
    if (error.code === "unreachable") return await moveStatus(ctx, id); // transient: the next call retries
    const sealed = move.sealedId > 0;
    if (!sealed) {
      await abortBeforeSeal(ctx, move, link, deps);
      await saveMove(ctx, move, { state: "failed", error: error.code + ": " + error.message });
    } else {
      await saveMove(ctx, move, { state: "needs_attention", error: error.code + ": " + error.message });
    }
  }
  return await moveStatus(ctx, id);
}

export const MOVE_SETTLED = ["done", "failed", "cancelled", "needs_attention", "returned"];
export async function runMove(ctx, id, deps = {}, { maxSteps = 100000, budgetMs = 0 } = {}) {
  const started = Date.now();
  let s = await moveStatus(ctx, id);
  for (let i = 0; i < maxSteps && s && MOVE_SETTLED.indexOf(s.state) < 0; i++) {
    s = await runMoveStep(ctx, id, deps);
    if (budgetMs && Date.now() - started > budgetMs) break;
  }
  return s;
}

async function abortBeforeSeal(ctx, move, link, deps) {
  try { if (link) await call(ctx, link, "POST", "/api/link/moves/" + move.lineage + "/cancel", "{}", deps); } catch { /* the target may be unreachable: a retry of cancel cleans it */ }
  await setHomes(ctx, move.options.sites || [], "");
}

async function stepPreflight(ctx, move, link, deps) {
  // The list of sites is fixed here: from now on none can be added or removed (instanceLocked).
  const sites = await listOrgSites(ctx.shared, move.orgId);
  if (!sites.length) throw new MoveError("no_sites", "this instance has no websites to move", 409);
  const est = await estimateExport(ctx, { orgId: move.orgId, siteIds: idsOf(sites) });
  const remote = await call(ctx, link, "POST", "/api/link/moves/preflight", JSON.stringify({ lineage: move.lineage, sites: await manifestSites(ctx, sites), events: est.events, minTs: est.minTs, maxTs: est.maxTs }), deps);
  const windowSize = remote.window ? Math.min(move.options.window || WINDOW, remote.window) : move.options.window || WINDOW;
  move.options = { ...move.options, window: windowSize, sites: idsOf(sites) };
  const store = ctx.store(move.orgId);
  await ensureSchema(store, "store");
  markMoveActive(store);
  // From here the collector uses the guarded insert for every site.
  await setHomes(ctx, idsOf(sites), "moving", { lineage: move.lineage, linkId: link.link_id });
  await saveMove(ctx, move, { state: "bulk", step: "", afterId: 0, bulkUntil: est.untilId, eventsTotal: est.events });
}

// One window per call: export (after, end], upload its parts, then (next calls) wait for the target to load it.
async function stepWindow(ctx, move, link, deps) {
  const catchup = move.state === "catchup";
  const limit = catchup ? move.sealedId : move.bulkUntil;
  if (move.remoteMove) {
    // A window is uploaded: one poll per call, and the poll is what advances the target.
    const status = await call(ctx, link, "GET", "/api/link/jobs/" + move.remoteMove, "", deps);
    if (status.state === "failed" || status.state === "cancelled") throw new MoveError("target_failed", "the target could not load the data: " + (status.error || status.state));
    if (status.state !== "ready" && status.state !== "done") return;
    await saveMove(ctx, move, { afterId: Number(move.step.slice(4)), step: "", remoteMove: "" });
    return;
  }
  if (move.afterId >= limit) {
    await saveMove(ctx, move, { state: catchup ? "finalize" : "seal", step: "" });
    return;
  }
  const store = ctx.store(move.orgId);
  let end = limit;
  const edge = await store.prepare("SELECT id FROM events NOT INDEXED WHERE id > ? AND id <= ? ORDER BY id LIMIT 1 OFFSET ?").bind(move.afterId, limit, (move.options.window || WINDOW) - 1).first();
  if (edge) end = Number(edge.id);
  // Opening is idempotent per window: a crash after the open reuses the same job.
  const attempt = move.options.attempt || 0;
  const open = await call(ctx, link, "POST", "/api/link/moves/" + move.lineage + "/windows", JSON.stringify({ sealed: catchup, key: move.afterId + ":" + end + (attempt ? ":" + attempt : "") }), deps);
  const jobId = String(open.job_id);
  if (open.state === "uploading") {
    try {
      for await (const part of exportParts(ctx, { orgId: move.orgId, siteIds: move.options.sites, lineage: move.lineage, sinceId: move.afterId, untilId: end, includeUsers: move.afterId === 0, scope: "org", partBytes: WIRE_PART_BYTES, createdAt: move.createdAt })) {
        await call(ctx, link, "PUT", "/api/link/jobs/" + jobId + "/parts/" + part.n, part.text, deps);
      }
    } catch (error) {
      // The window came out different from an earlier try (a salt rotated): start it again as a new job.
      if (error instanceof MoveError && error.code === "part_conflict") { await saveMove(ctx, move, { options: { ...move.options, attempt: attempt + 1 } }); return; }
      throw error;
    }
    await call(ctx, link, "POST", "/api/link/jobs/" + jobId + "/complete", "{}", deps);
  }
  const sent = await estimateExport(ctx, { orgId: move.orgId, siteIds: move.options.sites, sinceId: move.afterId, untilId: end });
  await saveMove(ctx, move, { remoteMove: jobId, step: "end:" + end, eventsSent: move.eventsSent + sent.events });
}

// The fence: one statement in the event store. From here the collector queues for the gateway.
async function stepSeal(ctx, move) {
  const link = await cloudLink(ctx);
  // One fence per site, then X = the highest id any of them covers: every event stored before its
  // site's fence has an id up to X, and none is stored after it.
  const fence = await sealSites(ctx, move.orgId, move.options.sites);
  await setHomes(ctx, move.options.sites, "gateway", { lineage: move.lineage, linkId: link ? link.link_id : "" });
  await saveMove(ctx, move, { state: "catchup", step: "", sealedId: Math.max(fence.maxId, 1) });
}

async function stepFinalize(ctx, move, link, deps) {
  await call(ctx, link, "POST", "/api/link/moves/" + move.lineage + "/finalize", "{}", deps);
  await saveMove(ctx, move, { state: "done", step: "" });
}

export async function cancelMove(ctx, id, deps = {}) {
  const move = await loadMove(ctx, id);
  if (!move) throw new MoveError("not_found", "move not found", 404);
  if (move.sealedId > 0 || move.state === "done") throw new MoveError("sealed", "traffic already moves through the gateway: use Move back", 409);
  if (MOVE_SETTLED.indexOf(move.state) >= 0) return await moveStatus(ctx, id);
  const link = await cloudLink(ctx);
  await abortBeforeSeal(ctx, move, link, deps);
  await saveMove(ctx, move, { state: "cancelled", step: "", remoteMove: "" });
  return await moveStatus(ctx, id);
}

// Retire the gateway after the DNS flip: the site stops forwarding and the local copy becomes the rollback copy.
export async function retireGateway(ctx, orgId) {
  const sites = await listOrgSites(ctx.shared, orgId);
  let forwarding = 0;
  for (const site of sites) if ((await siteHome(ctx, site.id)).home === "gateway") forwarding++;
  if (!forwarding) throw new MoveError("not_gateway", "this instance is not forwarding", 409);
  await setHomes(ctx, idsOf(sites), "frozen");
}

// --- the target side -------------------------------------------------------------------------------------
const checkSite = (s) => {
  if (!(Object(s) === s && String(s.name) === s.name && s.name.length >= 1 && s.name.length <= 120 && /^[A-Za-z0-9_-]{8,64}$/.test(String(s.key)) && /^[a-z0-9.-]{1,253}$/.test(String(s.domain)))) throw new MoveError("bad_manifest", "bad site");
};
const checkManifest = (m) => {
  if (Object(m) !== m || !/^[a-z0-9._-]{8,64}$/.test(String(m.lineage)) || !Array.isArray(m.sites) || m.sites.length < 1 || m.sites.length > 500) throw new MoveError("bad_manifest", "bad manifest");
  const keys = new Set();
  const domains = new Set();
  for (const s of m.sites) {
    checkSite(s);
    if (keys.has(s.key) || domains.has(s.domain)) throw new MoveError("bad_manifest", "duplicate site");
    keys.add(s.key);
    domains.add(s.domain);
  }
};

// Everything the instance sends is one lineage; a site already tied to it (a repeat of the preflight) is not new.
export async function targetPreflight(ctx, link, manifest) {
  checkManifest(manifest);
  await ensureSchema(ctx.shared, "shared");
  let fresh = 0;
  for (const s of manifest.sites) {
    const tie = await getSiteByKey(ctx.shared, s.key);
    if (!tie) { fresh++; continue; }
    const mine = await ctx.shared.prepare("SELECT lineage FROM site_links WHERE site_id = ? AND link_id = ?").bind(tie.id, link.linkId).first();
    const home = await ctx.shared.prepare("SELECT lineage FROM site_home WHERE site_id = ?").bind(tie.id).first();
    const lineage = (mine && mine.lineage) || (home && home.lineage);
    if (lineage !== manifest.lineage) throw new MoveError("key_taken", "a tracker key of this instance is already in use on risulta.dev (" + s.domain + "); regenerate that key on the instance and try again", 409);
  }
  const busy = await ctx.shared.prepare("SELECT count(DISTINCT lineage) AS n FROM move_jobs WHERE org_id = ? AND link_id != '' AND state IN ('uploading','verifying','verified','running','cancelling') AND lineage != ?").bind(link.orgId, manifest.lineage).first();
  if (Number(busy.n) > 0) throw new MoveError("busy", "another move is in progress for this org", 409);
  if (ctx.limits && ctx.limits.canAddSite && !(await ctx.limits.canAddSite(link.orgId, fresh))) throw new MoveError("site_quota", "this org's plan has no room for " + fresh + " more website" + (fresh === 1 ? "" : "s"), 402);
  const limits = (ctx.limits && ctx.limits.move && (await ctx.limits.move(link.orgId))) || {};
  // The target advises a window size: the memory of a step is the size of a window (see the PR notes).
  return { ok: true, retentionDays: limits.retentionDays || 0, maxEvents: limits.maxEvents || 0, window: limits.window || 0 };
}

export async function targetOpenWindow(ctx, link, lineage, { sealed, key }) {
  await ensureSchema(ctx.shared, "shared");
  if (!/^\d{1,16}:\d{1,16}(:\d{1,3})?$/.test(String(key))) throw new MoveError("bad_window", "bad window", 400);
  const again = await ctx.shared.prepare("SELECT id, state FROM move_jobs WHERE lineage = ? AND org_id = ? AND link_id = ? AND json_extract(options, '$.windowKey') = ? AND state != 'failed' AND state != 'cancelled'").bind(lineage, link.orgId, link.linkId, key).first();
  if (again) return { job_id: again.id, state: again.state };
  // An earlier attempt at another window that never finished uploading is abandoned.
  await ctx.shared.prepare("UPDATE move_jobs SET state = 'cancelled' WHERE lineage = ? AND org_id = ? AND link_id = ? AND state = 'uploading'").bind(lineage, link.orgId, link.linkId).run();
  const limits = (ctx.limits && ctx.limits.move && (await ctx.limits.move(link.orgId))) || {};
  const job = await createImportJob(ctx, {
    orgId: link.orgId, lineage, linkId: link.linkId,
    options: { windowKey: key, activate: false, rollbackOnFailure: !sealed, home: "importing", retentionDays: limits.retentionDays || 0, maxEvents: limits.maxEvents || 0, onDomainConflict: "fail", keyOnClash: "fail" },
  });
  return { job_id: job.id, state: "uploading" };
}

async function ownedJob(ctx, link, jobId) {
  const status = await jobStatus(ctx, jobId, link.orgId);
  if (!status) return null;
  const row = await ctx.shared.prepare("SELECT link_id FROM move_jobs WHERE id = ?").bind(jobId).first();
  return row && row.link_id === link.linkId ? status : null;
}

export async function targetJobPart(ctx, link, jobId, n, body, sha) {
  if (!(await ownedJob(ctx, link, jobId))) throw new MoveError("not_found", "not found", 404);
  await addPart(ctx, jobId, link.orgId, n, body, sha);
  return { ok: true };
}
export async function targetJobComplete(ctx, link, jobId) {
  if (!(await ownedJob(ctx, link, jobId))) throw new MoveError("not_found", "not found", 404);
  await completeUpload(ctx, jobId, link.orgId);
  return { ok: true };
}

// The poll is also what advances the job: a sleeping app, or a queue that has not woken it, still makes progress.
export async function targetJobStatus(ctx, link, jobId, { budgetMs = 800 } = {}) {
  if (!(await ownedJob(ctx, link, jobId))) throw new MoveError("not_found", "not found", 404);
  let status = await runJob(ctx, jobId, link.orgId, { budgetMs });
  if (status.state === "verified") {
    await startJob(ctx, jobId, link.orgId);
    status = await runJob(ctx, jobId, link.orgId, { budgetMs });
  }
  if (status.state === "ready" || status.state === "done") await tieSites(ctx, link, status.lineage);
  return { state: status.state, phase: status.phase, error: status.error, events: status.events };
}

async function tieSites(ctx, link, lineage) {
  const rows = (await ctx.shared.prepare("SELECT site_id FROM site_home WHERE lineage = ? AND link_id = ?").bind(lineage, link.linkId).all()).results;
  for (const row of rows) await ctx.shared.prepare("INSERT OR IGNORE INTO site_links (site_id, link_id, lineage, created_at) VALUES (?, ?, ?, ?)").bind(row.site_id, link.linkId, lineage, now(ctx)).run();
}

export async function targetFinalize(ctx, link, lineage) {
  const jobs = (await ctx.shared.prepare("SELECT id, state FROM move_jobs WHERE lineage = ? AND org_id = ? AND link_id = ?").bind(lineage, link.orgId, link.linkId).all()).results;
  if (!jobs.length) throw new MoveError("not_found", "no data was sent", 404);
  if (jobs.some((j) => j.state !== "ready" && j.state !== "done")) throw new MoveError("not_ready", "a window is not loaded yet", 409);
  await tieSites(ctx, link, lineage);
  await activateJobSites(ctx, jobs[0].id, link.orgId);
  const sites = (await ctx.shared.prepare("SELECT site_id FROM site_links WHERE lineage = ? AND link_id = ?").bind(lineage, link.linkId).all()).results;
  for (const j of jobs) if (j.state === "ready") await ctx.shared.prepare("UPDATE move_jobs SET state = 'done', phase = 'done' WHERE id = ?").bind(j.id).run();
  return { ok: true, sites: sites.map((s) => Number(s.site_id)) };
}

export async function targetCancel(ctx, link, lineage) {
  const jobs = (await ctx.shared.prepare("SELECT id, state FROM move_jobs WHERE lineage = ? AND org_id = ? AND link_id = ?").bind(lineage, link.orgId, link.linkId).all()).results;
  if (!jobs.length) throw new MoveError("not_found", "not found", 404);
  for (const j of jobs) {
    if (j.state === "done") continue;
    await cancelJob(ctx, j.id, link.orgId);
    await runJob(ctx, j.id, link.orgId);
  }
  await ctx.shared.prepare("DELETE FROM site_links WHERE lineage = ? AND link_id = ?").bind(lineage, link.linkId).run();
  return { ok: true };
}

// --- move back: implemented in back.js to keep this file readable ----------------------------------------
const helpers = () => ({ saveMove, call, loadMove, MoveError });
async function runBackStep(ctx, move, deps) {
  return await back.runBackStep(ctx, move, deps, helpers());
}
export async function startMoveBack(ctx, orgId) {
  return await back.startMoveBack(ctx, orgId, helpers());
}
export const targetBack = {
  preflight: (ctx, link, lineage) => back.targetBackPreflight(ctx, link, lineage, helpers()),
  export: (ctx, link, lineage, q) => back.targetBackExport(ctx, link, lineage, q, helpers()),
  seal: (ctx, link, lineage) => back.targetBackSeal(ctx, link, lineage, helpers()),
  release: (ctx, link, lineage) => back.targetBackRelease(ctx, link, lineage, helpers()),
};
export { loadMove, saveMove, call };
