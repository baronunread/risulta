// Import: a verified bundle becomes sites in the importing org.
//
// Every write goes through ctx.shared (the site registry, jobs) or
// ctx.store(orgId) (the org's events and everything about them), never
// through a database the importing org does not own. Ids in the file are
// references only: the target issues its own, and the ledger remembers the
// mapping, so a repeated or resumed step changes nothing.
//
// A job is a list of small steps, each one batch (one transaction) that also
// advances the ledger. A site stays `importing` (hidden, not collecting) until
// the last step flips it. A failed or cancelled job deletes what it created.
import { BundleError, BundleVerifier, sha256 } from "./bundle.js";
import { createSiteStatements, availableSlug, domainTaken, keyTaken, getSite } from "./registry.js";
import { ensureSchema, ROLLUP_TABLES, tableExists } from "./schema.js";
import { randomHex } from "../auth.js";

export const LIMITS = { bundleBytes: 512 * 1024 * 1024, partBytes: 4 * 1024 * 1024, events: 2000000, chunk: 4000, deleteChunk: 5000 };
const ROWS_PER_INSERT = 8;
const DAY = 86400;

export class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const now = (ctx) => (ctx.now ? ctx.now() : Math.floor(Date.now() / 1000));
const partKey = (jobId, n) => "imports/" + jobId + "/" + n;
// oxlint-disable-next-line no-control-regex -- the point is to reject control characters
const NON_ASCII = /[^\x09\x0a\x0d\x20-\x7e]/;
const parse = (text) => { try { return JSON.parse(text); } catch { return {}; } };

// --- jobs ----------------------------------------------------------------------
async function loadJob(ctx, id, orgId) {
  const row = await ctx.shared.prepare("SELECT * FROM move_jobs WHERE id = ?").bind(String(id)).first();
  if (!row) return null;
  // Another org's job is "not found", not "forbidden".
  if (orgId !== undefined && Number(row.org_id) !== Number(orgId)) return null;
  return {
    id: row.id, orgId: Number(row.org_id), kind: row.kind, lineage: row.lineage, state: row.state, phase: row.phase,
    parts: Number(row.parts), verifiedParts: Number(row.verified_parts), verify: parse(row.verify_state),
    options: parse(row.options), report: parse(row.report), error: row.error, linkId: row.link_id,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

async function saveJob(ctx, job, patch = {}) {
  Object.assign(job, patch);
  job.updatedAt = now(ctx);
  await ctx.shared.prepare("UPDATE move_jobs SET state = ?, phase = ?, parts = ?, verified_parts = ?, verify_state = ?, options = ?, report = ?, error = ?, updated_at = ? WHERE id = ?")
    .bind(job.state, job.phase, job.parts, job.verifiedParts, JSON.stringify(job.verify), JSON.stringify(job.options), JSON.stringify(job.report), job.error, job.updatedAt, job.id).run();
  return job;
}

export async function createImportJob(ctx, { orgId, lineage, options = {}, linkId = "" }) {
  await ensureSchema(ctx.shared, "shared");
  const id = randomHex(16);
  const t = now(ctx);
  const opts = {
    retentionDays: options.retentionDays || 0, maxEvents: options.maxEvents || LIMITS.events, maxBytes: options.maxBytes || LIMITS.bundleBytes,
    onDomainConflict: options.onDomainConflict === "fail" ? "fail" : "skip", keyOnClash: options.keyOnClash === "new" ? "new" : "fail",
    activate: options.activate !== false, rollbackOnFailure: options.rollbackOnFailure !== false, home: options.home || "importing",
    skip: Array.isArray(options.skip) ? options.skip.map(Number) : [],
    attach: Object(options.attach) === options.attach ? options.attach : {},
  };
  if (options.windowKey) opts.windowKey = String(options.windowKey);
  opts.cutoff = opts.retentionDays ? t - opts.retentionDays * DAY : 0;
  await ctx.shared.prepare("INSERT INTO move_jobs (id, org_id, kind, lineage, state, options, link_id, created_at, updated_at) VALUES (?, ?, 'import', ?, 'uploading', ?, ?, ?, ?)")
    .bind(id, orgId, lineage || "", JSON.stringify(opts), linkId, t, t).run();
  return await loadJob(ctx, id, orgId);
}

// Parts arrive in order. Re-sending a part with the same checksum is a no-op,
// which makes an upload retry safe; a different body for a stored part is not.
export async function addPart(ctx, jobId, orgId, n, body, claimedSha) {
  const job = await loadJob(ctx, jobId, orgId);
  if (!job) throw new ImportError("not_found", "job not found");
  if (!Number.isInteger(n) || n < 0 || n > job.parts) throw new ImportError("bad_part", "parts must be sent in order");
  const text = String(body);
  if (text.length > LIMITS.partBytes) throw new ImportError("part_too_large", "a part is larger than 4 MiB");
  if (NON_ASCII.test(text)) throw new ImportError("not_ascii", "a bundle part must be ASCII");
  // The part digest is optional (a browser sends it); the trailer's section digests are the end-to-end check.
  if (claimedSha && claimedSha !== (await sha256(text))) throw new ImportError("part_checksum", "part " + n + " fails its checksum");
  if (n < job.parts) {
    // A repeat of a part that is already stored is a no-op, whatever the job is doing now.
    const stored = await ctx.blobs.get(partKey(job.id, n));
    if (stored !== null && stored === text) return job;
    throw new ImportError("part_conflict", "part " + n + " was already sent with different content");
  }
  if (job.state !== "uploading") throw new ImportError("bad_state", "the job is not accepting parts");
  if (job.report.bytes && job.report.bytes + text.length > job.options.maxBytes) throw new ImportError("too_large", "the bundle is larger than the limit");
  await ctx.blobs.put(partKey(job.id, n), text);
  return await saveJob(ctx, job, { parts: job.parts + 1, report: { ...job.report, bytes: (job.report.bytes || 0) + text.length } });
}

export async function completeUpload(ctx, jobId, orgId) {
  const job = await loadJob(ctx, jobId, orgId);
  if (!job) throw new ImportError("not_found", "job not found");
  if (job.state !== "uploading") return job;
  if (!job.parts) throw new ImportError("empty", "no parts were uploaded");
  return await saveJob(ctx, job, { state: "verifying" });
}

export async function jobStatus(ctx, jobId, orgId) {
  const job = await loadJob(ctx, jobId, orgId);
  if (!job) return null;
  const per = job.verify && job.verify.perSite ? job.verify.perSite : {};
  let total = 0;
  for (const ref of Object.keys(per)) total += per[ref].events - per[ref].trimmed;
  return {
    id: job.id, state: job.state, phase: job.phase, lineage: job.lineage, error: job.error, linkId: job.linkId,
    parts: job.parts, verifiedParts: job.verifiedParts, events: { total, done: (job.report.progress && job.report.progress.imported) || 0 },
    report: { ...job.report, progress: undefined }, updatedAt: job.updatedAt,
  };
}

// --- reading the stored parts -----------------------------------------------------
async function* readLines(ctx, job, cursor) {
  let part = cursor.part;
  let offset = cursor.offset;
  let carry = "";
  while (part < job.parts) {
    const text = await ctx.blobs.get(partKey(job.id, part));
    if (text === null) throw new ImportError("missing_part", "a stored part is missing");
    let pos = offset;
    offset = 0;
    for (;;) {
      const nl = text.indexOf("\n", pos);
      if (nl < 0) { carry += text.slice(pos); break; }
      const line = carry + text.slice(pos, nl);
      carry = "";
      pos = nl + 1;
      yield { line, next: pos < text.length ? { part, offset: pos } : { part: part + 1, offset: 0 } };
    }
    part++;
  }
}

async function dropParts(ctx, job) {
  for (let n = 0; n < job.parts; n++) await ctx.blobs.delete(partKey(job.id, n));
  await ctx.blobs.delete("imports/" + job.id + "/invites");
}

// --- the step loop -------------------------------------------------------------------
// One call = one small step. Returns the job status. Call until `settled`.
export async function runStep(ctx, jobId, orgId) {
  const job = await loadJob(ctx, jobId, orgId);
  if (!job) throw new ImportError("not_found", "job not found");
  try {
    if (job.state === "verifying") await stepVerify(ctx, job);
    else if (job.state === "running") await stepRun(ctx, job);
    else if (job.state === "cancelling") await stepCancel(ctx, job);
  } catch (error) {
    if (!(error instanceof BundleError) && !(error instanceof ImportError)) throw error;
    await failJob(ctx, job, error);
  }
  return await jobStatus(ctx, job.id, orgId);
}

export const SETTLED = ["uploading", "verified", "ready", "done", "failed", "cancelled"];

export async function runJob(ctx, jobId, orgId, { maxSteps = 100000, budgetMs = 0 } = {}) {
  const started = Date.now();
  let status = await jobStatus(ctx, jobId, orgId);
  for (let i = 0; i < maxSteps && status && SETTLED.indexOf(status.state) < 0; i++) {
    status = await runStep(ctx, jobId, orgId);
    if (budgetMs && Date.now() - started > budgetMs) break;
  }
  return status;
}

async function failJob(ctx, job, error) {
  const code = error.code || "failed";
  const message = code + ": " + error.message;
  const wrote = job.state === "running";
  if (wrote && job.options.rollbackOnFailure) {
    await saveJob(ctx, job, { state: "cancelling", error: message, phase: "cleanup" });
    return;
  }
  await saveJob(ctx, job, { state: "failed", error: message });
  // A running job that may not roll back keeps its parts: a retry resumes it.
  if (!wrote) await dropParts(ctx, job);
}

async function stepVerify(ctx, job) {
  const verifier = new BundleVerifier({ maxBytes: job.options.maxBytes, maxEvents: job.options.maxEvents, cutoff: job.options.cutoff }, job.verifiedParts ? job.verify : null);
  if (job.verifiedParts < job.parts) {
    const text = await ctx.blobs.get(partKey(job.id, job.verifiedParts));
    if (text === null) throw new ImportError("missing_part", "a stored part is missing");
    await verifier.feed(text);
    await saveJob(ctx, job, { verifiedParts: job.verifiedParts + 1, verify: verifier.state });
    if (job.verifiedParts < job.parts) return;
  }
  const summary = await verifier.end();
  if (job.lineage && job.lineage !== summary.manifest.lineage) throw new ImportError("lineage_mismatch", "the bundle belongs to a different move");
  await saveJob(ctx, job, { state: "verified", lineage: summary.manifest.lineage, verify: verifier.state });
  await ctx.shared.prepare("UPDATE move_jobs SET lineage = ? WHERE id = ?").bind(summary.manifest.lineage, job.id).run();
}

// --- preview and start ---------------------------------------------------------------
// What would happen to each site, with nothing written.
export async function previewJob(ctx, jobId, orgId) {
  const job = await loadJob(ctx, jobId, orgId);
  if (!job) throw new ImportError("not_found", "job not found");
  if (job.state !== "verified") throw new ImportError("bad_state", "the bundle is not verified yet");
  await ensureSchema(ctx.shared, "shared");
  await ensureSchema(ctx.store(job.orgId), "store");
  const summary = new BundleVerifier({}, job.verify).summary();
  const plan = [];
  for (const site of summary.sites) {
    const per = summary.perSite[site.ref];
    const entry = { ref: site.ref, name: site.name, domain: site.domain, key: site.key, events: per.events - per.trimmed, trimmed: per.trimmed, action: "create", reason: "" };
    const existing = (await ledgerRow(ctx.store(job.orgId), job.lineage, site.ref)) || (job.options.attach[site.ref] ? { site_id: job.options.attach[site.ref] } : null) || (await ctx.shared.prepare("SELECT site_id FROM site_home WHERE lineage = ? AND src_ref = ?").bind(job.lineage, site.ref).first());
    if (existing) entry.action = "resume";
    else if (job.options.skip.indexOf(site.ref) >= 0) { entry.action = "skip"; entry.reason = "left out by you"; }
    else if (await domainTaken(ctx.shared, job.orgId, site.domain)) {
      entry.action = job.options.onDomainConflict === "fail" ? "conflict" : "skip";
      entry.reason = "this domain is already registered";
    } else if (await keyTaken(ctx.shared, site.key)) {
      entry.action = job.options.keyOnClash === "new" ? "create" : "conflict";
      entry.reason = job.options.keyOnClash === "new" ? "the tracker key is in use: a new key is issued and the snippet must change" : "the tracker key is already in use";
      entry.newKey = job.options.keyOnClash === "new";
    }
    plan.push(entry);
  }
  const invites = await readInvites(ctx, job);
  return {
    lineage: job.lineage, scope: summary.manifest.scope, sites: plan, invitations: invites.length, bytes: summary.bytes,
    events: { total: summary.events.total, trimmed: summary.events.trimmed, minTs: summary.events.minTs, maxTs: summary.events.maxTs },
    blocked: plan.some((entry) => entry.action === "conflict"),
  };
}

async function readInvites(ctx, job) {
  const raw = await ctx.blobs.get("imports/" + job.id + "/invites");
  if (raw !== null) return parse(raw).list || [];
  const list = [];
  const counts = job.verify.counts || {};
  if (counts.users) {
    for await (const { line } of readLines(ctx, job, { part: 0, offset: 0 })) {
      const obj = JSON.parse(line);
      if (obj.t === "user") list.push({ email: obj.email, display_name: obj.display_name, role: obj.role, sites: obj.sites });
      if (obj.t === "event" || obj.t === "totals" || obj.t === "trailer") break;
    }
  }
  await ctx.blobs.put("imports/" + job.id + "/invites", JSON.stringify({ list }));
  return list;
}

export async function listInvitations(ctx, jobId, orgId) {
  const job = await loadJob(ctx, jobId, orgId);
  if (!job) throw new ImportError("not_found", "job not found");
  return await readInvites(ctx, job);
}

export async function startJob(ctx, jobId, orgId, choices = {}) {
  const job = await loadJob(ctx, jobId, orgId);
  if (!job) throw new ImportError("not_found", "job not found");
  if (job.state !== "verified") throw new ImportError("bad_state", "the bundle is not verified yet");
  if (Array.isArray(choices.skip)) job.options.skip = choices.skip.map(Number);
  if (choices.onDomainConflict) job.options.onDomainConflict = choices.onDomainConflict === "fail" ? "fail" : "skip";
  if (choices.keyOnClash) job.options.keyOnClash = choices.keyOnClash === "new" ? "new" : "fail";
  await saveJob(ctx, job);
  const plan = await previewJob(ctx, jobId, orgId);
  if (plan.blocked) throw new ImportError("conflict", "resolve the conflicts first");
  await saveJob(ctx, job, { state: "running", phase: "meta", report: { ...job.report, progress: { cursor: null, imported: 0, trimmed: 0 }, renames: [], skipped: [], newKeys: [] } });
  return await jobStatus(ctx, jobId, orgId);
}

// --- writing --------------------------------------------------------------------------
async function stepRun(ctx, job) {
  const store = ctx.store(job.orgId);
  await ensureSchema(ctx.shared, "shared");
  await ensureSchema(store, "store");
  if (job.phase === "meta") return await stepMeta(ctx, job, store);
  if (job.phase === "events") return await stepEvents(ctx, job, store);
  if (job.phase === "finalize") return await stepFinalize(ctx, job, store);
  throw new ImportError("bad_phase", "unknown phase");
}

async function ledgerRow(store, lineage, srcSite) {
  return await store.prepare("SELECT site_id, meta_done, last_src_event_id, imported, created_job FROM import_ledger WHERE lineage = ? AND src_site = ?").bind(lineage, srcSite).first();
}

async function stepMeta(ctx, job, store) {
  const sites = [];
  const goals = [];
  const funnels = [];
  const notes = [];
  let cursor = { part: 0, offset: 0 };
  for await (const { line, next } of readLines(ctx, job, cursor)) {
    const obj = JSON.parse(line);
    if (obj.t === "event" || obj.t === "totals" || obj.t === "trailer") break;
    if (obj.t === "site") sites.push(obj);
    else if (obj.t === "goal") goals.push(obj);
    else if (obj.t === "funnel") funnels.push(obj);
    else if (obj.t === "annotation") notes.push(obj);
    cursor = next;
  }
  const t = now(ctx);
  const report = job.report;
  for (const site of sites) {
    if (job.options.skip.indexOf(site.ref) >= 0) { report.skipped.push({ ref: site.ref, domain: site.domain, reason: "left out by you" }); continue; }
    const ledger = await ledgerRow(store, job.lineage, site.ref);
    if (!ledger && job.options.attach[site.ref]) {
      // Attach: the events join a site that already exists (a move back). Nothing is created.
      const target = await getSite(ctx.shared, Number(job.options.attach[site.ref]));
      if (!target || Number(target.org_id) !== job.orgId || target.public_key !== site.key) throw new ImportError("attach_mismatch", "the site to attach to does not match the bundle");
      await store.prepare("INSERT INTO import_ledger (lineage, src_site, site_id, meta_done, created_job) VALUES (?, ?, ?, 1, '')").bind(job.lineage, site.ref, target.id).run();
      continue;
    }
    let home = ledger ? { site_id: ledger.site_id } : await ctx.shared.prepare("SELECT site_id FROM site_home WHERE lineage = ? AND src_ref = ?").bind(job.lineage, site.ref).first();
    if (!home) {
      if (await domainTaken(ctx.shared, job.orgId, site.domain)) {
        if (job.options.onDomainConflict === "fail") throw new ImportError("conflict", "the domain " + site.domain + " is already registered");
        report.skipped.push({ ref: site.ref, domain: site.domain, reason: "domain already registered" });
        continue;
      }
      let key = site.key;
      if (await keyTaken(ctx.shared, key)) {
        if (job.options.keyOnClash !== "new") throw new ImportError("key_taken", "the tracker key is already in use");
        key = randomHex(16);
        report.newKeys.push({ ref: site.ref, domain: site.domain, key });
      }
      const slug = await availableSlug(ctx.shared, site.slug, site.domain);
      if (slug !== site.slug) report.renames.push({ ref: site.ref, from: site.slug, to: slug });
      const list = await createSiteStatements(ctx.shared, job.orgId, { ...site, key }, slug, site.widget === 1, { home: job.options.home, lineage: job.lineage, job_id: job.id, link_id: job.linkId, now: t });
      try {
        await ctx.shared.batch(list);
      } catch (error) {
        if (!/constraint|unique/i.test(String(error && error.message))) throw error; // a crash is not a conflict
        // A unique constraint decided (a domain or key in another org): say nothing about whose.
        throw new ImportError("conflict", "the domain or tracker key of " + site.domain + " is not available");
      }
      home = await ctx.shared.prepare("SELECT site_id FROM site_home WHERE lineage = ? AND src_ref = ?").bind(job.lineage, site.ref).first();
    }
    const siteId = Number(home.site_id);
    if (ledger && Number(ledger.meta_done)) continue;
    await store.batch(metaStatements(store, job, site, siteId, goals.filter((g) => g.site === site.ref), funnels.filter((f) => f.site === site.ref), notes.filter((n) => n.site === site.ref), t));
  }
  await saveJob(ctx, job, { phase: "events", report: { ...report, progress: { ...report.progress, cursor } } });
}

function metaStatements(store, job, site, siteId, goals, funnels, notes, t) {
  const list = [];
  const lineage = job.lineage;
  for (const goal of goals) {
    list.push(store.prepare("INSERT OR IGNORE INTO goals (site_id, name, event_name, path, created_at) VALUES (?, ?, ?, ?, ?)").bind(siteId, goal.name, goal.event_name, goal.path, goal.created_at));
    list.push(store.prepare("INSERT OR IGNORE INTO import_map (lineage, kind, source_id, new_id) VALUES (?, 'goal', ?, (SELECT id FROM goals WHERE site_id = ? AND name = ?))").bind(lineage, goal.ref, siteId, goal.name));
  }
  for (const funnel of funnels) {
    list.push(store.prepare("INSERT INTO funnels (site_id, name, created_at) VALUES (?, ?, ?)").bind(siteId, funnel.name, funnel.created_at));
    list.push(store.prepare("INSERT OR IGNORE INTO import_map (lineage, kind, source_id, new_id) VALUES (?, 'funnel', ?, (SELECT max(id) FROM funnels WHERE site_id = ?))").bind(lineage, funnel.ref, siteId));
    funnel.steps.forEach((goalRef, position) => {
      list.push(store.prepare("INSERT INTO funnel_steps (funnel_id, position, goal_id) VALUES ((SELECT max(id) FROM funnels WHERE site_id = ?), ?, (SELECT new_id FROM import_map WHERE lineage = ? AND kind = 'goal' AND source_id = ?))").bind(siteId, position, lineage, goalRef));
    });
  }
  for (const note of notes) list.push(store.prepare("INSERT INTO annotations (site_id, ts, text) VALUES (?, ?, ?)").bind(siteId, note.ts, note.text));
  for (const salt of site.salts) list.push(store.prepare("INSERT OR IGNORE INTO site_salts (site_id, day, value) VALUES (?, ?, ?)").bind(siteId, salt.day, salt.value));
  list.push(store.prepare("INSERT INTO import_ledger (lineage, src_site, site_id, meta_done, created_job) VALUES (?, ?, ?, 1, ?) ON CONFLICT(lineage, src_site) DO UPDATE SET meta_done = 1").bind(lineage, site.ref, siteId, job.id));
  void t;
  return list;
}

const EVENT_COLUMNS = "(site_id, ts, name, path, referrer, visitor, source, medium, campaign, content, term, value)";

async function stepEvents(ctx, job, store) {
  const progress = job.report.progress;
  const cursor = progress.cursor || { part: 0, offset: 0 };
  const ledgers = {};
  const rows = [];
  let site = 0;
  let pos = cursor;
  let reachedEnd = true;
  let lines = 0;
  for await (const { line, next } of readLines(ctx, job, cursor)) {
    const obj = JSON.parse(line);
    if (obj.t !== "event") {
      if (obj.t === "totals" || obj.t === "trailer") break;
      pos = next;
      continue;
    }
    if (!(obj.site in ledgers)) ledgers[obj.site] = await ledgerRow(store, job.lineage, obj.site) || null;
    const ledger = ledgers[obj.site];
    if (!ledger) { pos = next; continue; } // a site that was skipped
    if (obj.id <= Number(ledger.last_src_event_id)) { pos = next; continue; } // applied by an earlier step
    if (site && obj.site !== site) { reachedEnd = false; break; }
    site = obj.site;
    rows.push(obj);
    pos = next;
    if (++lines >= (ctx.chunk || LIMITS.chunk)) { reachedEnd = false; break; }
  }
  if (rows.length) {
    const ledger = ledgers[site];
    const trimmed = rows.filter((row) => job.options.cutoff && row.ts < job.options.cutoff);
    const keep = rows.filter((row) => !(job.options.cutoff && row.ts < job.options.cutoff));
    const siteId = Number(ledger.site_id);
    const list = [];
    const first = rows[0].id;
    const last = rows[rows.length - 1].id;
    if (keep.length) {
      list.push(store.prepare("INSERT INTO import_ranges (job_id, lineage, site_id, first_id, last_id, src_first, src_last, n) VALUES (?, ?, ?, coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0) + 1, 0, ?, ?, ?)").bind(job.id, job.lineage, siteId, first, last, keep.length));
      for (let i = 0; i < keep.length; i += ROWS_PER_INSERT) {
        const group = keep.slice(i, i + ROWS_PER_INSERT);
        const args = [];
        for (const row of group) args.push(siteId, row.ts, row.name, row.path, row.referrer, row.visitor, row.source, row.medium, row.campaign, row.content, row.term, row.value);
        list.push(store.prepare("INSERT INTO events " + EVENT_COLUMNS + " VALUES " + group.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")).bind(...args));
      }
      list.push(store.prepare("UPDATE import_ranges SET last_id = (SELECT seq FROM sqlite_sequence WHERE name = 'events') WHERE job_id = ? AND site_id = ? AND src_last = ?").bind(job.id, siteId, last));
    }
    list.push(store.prepare("UPDATE import_ledger SET last_src_event_id = ?, imported = imported + ? WHERE lineage = ? AND src_site = ?").bind(last, keep.length, job.lineage, site));
    await store.batch(list);
    progress.imported += keep.length;
    progress.trimmed += trimmed.length;
  }
  progress.cursor = pos;
  if (reachedEnd) {
    await saveJob(ctx, job, { phase: "finalize", report: { ...job.report, progress } });
  } else {
    await saveJob(ctx, job, { report: { ...job.report, progress } });
  }
}

// Check what landed against what the bundle said, then flip the sites live.
async function stepFinalize(ctx, job, store) {
  const progress = job.report.progress;
  const cursor = progress.cursor || { part: 0, offset: 0 };
  const have = {};
  const mismatches = [];
  const cutoffDay = job.options.cutoff ? new Date(job.options.cutoff * 1000).toISOString().slice(0, 10) : "";
  const ledgers = {};
  for await (const { line } of readLines(ctx, job, cursor)) {
    const obj = JSON.parse(line);
    if (obj.t !== "totals") continue;
    if (!(obj.site in ledgers)) ledgers[obj.site] = (await ledgerRow(store, job.lineage, obj.site)) || null;
    const ledger = ledgers[obj.site];
    if (!ledger) continue;
    if (cutoffDay && obj.day <= cutoffDay) continue; // a day cut by retention cannot match
    if (!have[obj.site]) have[obj.site] = await jobDayCounts(store, job, Number(ledger.site_id));
    if (have[obj.site] === null) continue; // an earlier job applied this site; completeness is checked below
    const got = have[obj.site][obj.day] || { events: 0, pageviews: 0, visitors: 0 };
    if (got.events !== obj.events || got.pageviews !== obj.pageviews || got.visitors !== obj.visitors) mismatches.push({ site: obj.site, day: obj.day, expected: [obj.events, obj.pageviews, obj.visitors], got: [got.events, got.pageviews, got.visitors] });
    if (mismatches.length >= 20) break;
  }
  if (mismatches.length) throw new ImportError("verify_failed", "the imported day totals do not match the bundle (" + JSON.stringify(mismatches.slice(0, 3)) + ")");
  for (const ref of Object.keys(job.verify.perSite || {})) {
    const ledger = ledgers[ref] || (await ledgerRow(store, job.lineage, Number(ref)));
    const per = job.verify.perSite[ref];
    if (ledger && per.events && Number(ledger.last_src_event_id) < per.maxId) throw new ImportError("verify_failed", "not every event of a site was applied");
  }
  const created = (await store.prepare("SELECT site_id FROM import_ledger WHERE lineage = ?").bind(job.lineage).all()).results;
  const report = { ...job.report, progress, created: created.length };
  if (job.options.activate) {
    await ctx.shared.prepare("DELETE FROM site_home WHERE job_id = ? AND home = 'importing'").bind(job.id).run();
    await saveJob(ctx, job, { state: "done", phase: "done", report });
  } else {
    await saveJob(ctx, job, { state: "ready", phase: "ready", report });
  }
  await keepInvitations(ctx, job);
  await dropParts(ctx, job);
}

// The list of people of a moved instance outlives the bundle's parts: it waits for the owner on the target.
async function keepInvitations(ctx, job) {
  if (!(job.verify.counts || {}).users) return;
  const list = await readInvites(ctx, job);
  const t = ctx.now ? ctx.now() : Math.floor(Date.now() / 1000);
  if (list.length) await ctx.shared.batch(list.map((p) => ctx.shared.prepare("INSERT OR IGNORE INTO move_invitations (org_id, lineage, email, display_name, role, sites, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(job.orgId, job.lineage, String(p.email).toLowerCase(), p.display_name, p.role, JSON.stringify(p.sites), t)));
}

export async function pendingInvitations(ctx, orgId) {
  if (!(await tableExists(ctx.shared, "move_invitations"))) return [];
  return (await ctx.shared.prepare("SELECT id, email, display_name, role, sites FROM move_invitations WHERE org_id = ? ORDER BY id").bind(orgId).all()).results.map((row) => ({ id: Number(row.id), email: row.email, display_name: row.display_name, role: row.role, sites: parse(row.sites) }));
}
export async function dismissInvitation(ctx, orgId, id) {
  if (!(await tableExists(ctx.shared, "move_invitations"))) return false;
  const result = await ctx.shared.prepare("DELETE FROM move_invitations WHERE org_id = ? AND id = ?").bind(orgId, id).run();
  return result.meta.changes > 0;
}

async function jobDayCounts(store, job, siteId) {
  const rows = (await store.prepare(
    "SELECT date(ts, 'unixepoch') AS day, count(*) AS events, coalesce(sum(name = 'pageview'), 0) AS pageviews, count(DISTINCT CASE WHEN name = 'pageview' THEN visitor END) AS visitors FROM events " +
      "WHERE site_id = ? AND id BETWEEN (SELECT coalesce(min(first_id), 1) FROM import_ranges WHERE job_id = ? AND site_id = ?) AND (SELECT coalesce(max(last_id), 0) FROM import_ranges WHERE job_id = ? AND site_id = ?) " +
      "AND EXISTS (SELECT 1 FROM import_ranges r WHERE r.job_id = ? AND r.site_id = events.site_id AND events.id BETWEEN r.first_id AND r.last_id) GROUP BY day",
  ).bind(siteId, job.id, siteId, job.id, siteId, job.id).all()).results;
  if (!rows.length) return null;
  const out = {};
  for (const row of rows) out[row.day] = { events: Number(row.events), pageviews: Number(row.pageviews), visitors: Number(row.visitors) };
  return out;
}

// --- activation and cancel -------------------------------------------------------------
// A move keeps its sites `importing` until the catch-up is verified; this flips them.
export async function activateJobSites(ctx, jobId, orgId) {
  const job = await loadJob(ctx, jobId, orgId);
  if (!job) throw new ImportError("not_found", "job not found");
  await ctx.shared.prepare("DELETE FROM site_home WHERE lineage = ? AND home = 'importing'").bind(job.lineage).run();
}

export async function cancelJob(ctx, jobId, orgId) {
  const job = await loadJob(ctx, jobId, orgId);
  if (!job) throw new ImportError("not_found", "job not found");
  if (job.state === "done" || job.state === "cancelled") return await jobStatus(ctx, jobId, orgId);
  if (job.state === "uploading" || job.state === "verifying" || job.state === "verified" || job.state === "failed") {
    await dropParts(ctx, job);
    await saveJob(ctx, job, { state: "cancelled", phase: "" });
    return await jobStatus(ctx, jobId, orgId);
  }
  await saveJob(ctx, job, { state: "cancelling", phase: "cleanup" });
  return await jobStatus(ctx, jobId, orgId);
}

async function stepCancel(ctx, job) {
  const store = ctx.store(job.orgId);
  await ensureSchema(store, "store");
  // 1. this job's events, in chunks
  const range = await store.prepare("SELECT site_id, first_id, last_id, src_last FROM import_ranges WHERE job_id = ? ORDER BY first_id LIMIT 1").bind(job.id).first();
  if (range) {
    await store.prepare("DELETE FROM events WHERE id IN (SELECT id FROM events WHERE site_id = ? AND id BETWEEN ? AND ? LIMIT ?)").bind(range.site_id, range.first_id, range.last_id, LIMIT_DELETE(ctx)).run();
    const left = await store.prepare("SELECT 1 AS n FROM events WHERE site_id = ? AND id BETWEEN ? AND ? LIMIT 1").bind(range.site_id, range.first_id, range.last_id).first();
    if (!left) await store.prepare("DELETE FROM import_ranges WHERE job_id = ? AND site_id = ? AND src_last = ?").bind(job.id, range.site_id, range.src_last).run();
    return;
  }
  // 2. the sites this job created, and everything about them
  const made = (await store.prepare("SELECT site_id, src_site FROM import_ledger WHERE lineage = ? AND created_job = ?").bind(job.lineage, job.id).all()).results;
  for (const row of made) {
    const id = row.site_id;
    const list = [
      store.prepare("DELETE FROM funnel_steps WHERE funnel_id IN (SELECT id FROM funnels WHERE site_id = ?)").bind(id),
      store.prepare("DELETE FROM funnels WHERE site_id = ?").bind(id),
      store.prepare("DELETE FROM goals WHERE site_id = ?").bind(id),
      store.prepare("DELETE FROM site_salts WHERE site_id = ?").bind(id),
      store.prepare("DELETE FROM import_map WHERE lineage = ?").bind(job.lineage),
      store.prepare("DELETE FROM import_ledger WHERE lineage = ? AND src_site = ?").bind(job.lineage, row.src_site),
    ];
    if (await tableExists(store, "annotations")) list.push(store.prepare("DELETE FROM annotations WHERE site_id = ?").bind(id));
    for (const table of ROLLUP_TABLES) if (await tableExists(store, table)) list.push(store.prepare("DELETE FROM " + table + " WHERE site_id = ?").bind(id));
    await store.batch(list);
    const shared = [ctx.shared.prepare("DELETE FROM site_home WHERE site_id = ?").bind(id)];
    if (await tableExists(ctx.shared, "public_widgets")) shared.push(ctx.shared.prepare("DELETE FROM public_widgets WHERE site_id = ?").bind(id));
    shared.push(ctx.shared.prepare("DELETE FROM sites WHERE id = ?").bind(id));
    await ctx.shared.batch(shared);
  }
  await ctx.shared.prepare("DELETE FROM move_invitations WHERE org_id = ? AND lineage = ?").bind(job.orgId, job.lineage).run();
  await dropParts(ctx, job);
  await saveJob(ctx, job, { state: job.error ? "failed" : "cancelled", phase: "" });
}
const LIMIT_DELETE = (ctx) => (ctx.deleteChunk || LIMITS.deleteChunk);
