// The seal, the gateway and the forward receiver.
//
// The seal (source side). A site that is moving gets a row in `site_fence`,
// written in the SAME database as its events. From then on the collector
// inserts events with a guard, one statement:
//
//   INSERT INTO events (...) SELECT ... WHERE NOT EXISTS (SELECT 1 FROM site_fence WHERE site_id = ?)
//
// Zero rows inserted means "sealed": the event goes to the gateway outbox
// instead. The fence returns the highest event id it covers (X), so the
// catch-up of ids up to X is finite and exact, with no wait for in-flight
// requests. A guard across the site registry and the event store is
// impossible (two databases), which is why the fence lives with the events.
//
// The gateway (source side, after the seal). The outbox row is written first
// (durable), then batches go to the target signed by the link. The row is
// deleted only after the target acknowledged its forward id.
//
// The receiver (target side). The visitor address and the visitor hash are
// trusted ONLY from a request signed by an active link whose org owns the
// site and which is the site's gateway link. Each forward id is stored once.
import { signRequest, cloudLink, forwardBase } from "./link.js";
import { ensureSchema, tableExists } from "./schema.js";
import { getSiteByKey, getSite } from "./registry.js";
import { asciiJson } from "../util.js";
import { randomHex } from "../auth.js";

export const OUTBOX_MAX = 5000;
export const OUTBOX_SECONDS = 24 * 3600;
export const BATCH_MAX = 200;
export const FWD_PATH = "/link/fwd/events";
const DEDUPE_SECONDS = 48 * 3600;
const EVENT_COLUMNS = "(site_id, ts, name, path, referrer, visitor, source, medium, campaign, content, term, value)";

const now = (ctx) => (ctx.now ? ctx.now() : Math.floor(Date.now() / 1000));

// --- is the feature in use at all? -------------------------------------------------
// A process that never touched a move keeps the collector's original statement.
const active = new WeakMap();
export async function moveActive(store) {
  const known = active.get(store);
  if (known !== undefined) return known;
  const present = await tableExists(store, "site_fence");
  active.set(store, present);
  return present;
}
export function markMoveActive(store) {
  active.set(store, true);
}

// --- site state -----------------------------------------------------------------------
const homes = new Map();
const HOME_TTL_MS = 3000;
export async function siteHome(ctx, siteId) {
  const hit = homes.get(ctx.shared);
  const cached = hit && hit.get(siteId);
  if (cached && Date.now() - cached.at < HOME_TTL_MS) return cached.value;
  const row = (await tableExists(ctx.shared, "site_home")) ? await ctx.shared.prepare("SELECT home, lineage, link_id FROM site_home WHERE site_id = ?").bind(siteId).first() : null;
  const value = row ? { home: row.home, lineage: row.lineage, linkId: row.link_id } : { home: "", lineage: "", linkId: "" };
  const map = hit || new Map();
  map.set(siteId, { at: Date.now(), value });
  homes.set(ctx.shared, map);
  return value;
}
export function forgetHome(ctx, siteId) {
  const map = homes.get(ctx.shared);
  if (map) map.delete(siteId);
}

export async function setHome(ctx, siteId, home, { lineage = "", linkId = "", jobId = "" } = {}) {
  await ensureSchema(ctx.shared, "shared");
  if (!home) await ctx.shared.prepare("DELETE FROM site_home WHERE site_id = ?").bind(siteId).run();
  else {
    // src_ref is the website's own id when the row is new: the (lineage, src_ref) index must stay unique across a whole instance.
    await ctx.shared.prepare("INSERT INTO site_home (site_id, home, lineage, src_ref, link_id, job_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(site_id) DO UPDATE SET home = excluded.home, lineage = CASE WHEN excluded.lineage != '' THEN excluded.lineage ELSE lineage END, link_id = CASE WHEN excluded.link_id != '' THEN excluded.link_id ELSE link_id END, updated_at = excluded.updated_at")
      .bind(siteId, home, lineage, siteId, linkId, jobId, now(ctx)).run();
  }
  forgetHome(ctx, siteId);
}

// Take the fence. Idempotent: a second call returns the first answer.
export async function sealSite(ctx, orgId, siteId) {
  const store = ctx.store(orgId);
  await ensureSchema(store, "store");
  markMoveActive(store);
  await store.prepare("INSERT OR IGNORE INTO site_fence (site_id, sealed_at, sealed_max_id) SELECT ?, ?, coalesce((SELECT max(id) FROM events WHERE site_id = ?), 0)").bind(siteId, now(ctx), siteId).run();
  const row = await store.prepare("SELECT sealed_at, sealed_max_id FROM site_fence WHERE site_id = ?").bind(siteId).first();
  return { sealedAt: Number(row.sealed_at), maxId: Number(row.sealed_max_id) };
}

// Lift the fence (a move back thaws the frozen copy).
export async function unseal(ctx, orgId, siteId) {
  const store = ctx.store(orgId);
  if (await tableExists(store, "site_fence")) await store.prepare("DELETE FROM site_fence WHERE site_id = ?").bind(siteId).run();
}

// --- the collector's store step ------------------------------------------------------------
// row: { ts, name, path, referrer, visitor, source, medium, campaign, content, term, value }
// meta: { ip, ua, origin, host, key } for the envelope when the event is forwarded.
// Returns "stored", "queued" (sealed: in the outbox) or "dropped".
export async function collectEvent(ctx, orgId, site, row, meta) {
  const store = ctx.store(orgId);
  const insertArgs = [site.id, row.ts, row.name, row.path, row.referrer, row.visitor, row.source, row.medium, row.campaign, row.content, row.term, row.value];
  if (!(await moveActive(store))) {
    await store.prepare("INSERT INTO events " + EVENT_COLUMNS + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(...insertArgs).run();
    return "stored";
  }
  const state = await siteHome(ctx, site.id);
  if (state.home === "frozen" || state.home === "importing") return "dropped";
  if (state.home !== "gateway" && state.home !== "moving-back") {
    const result = await store.prepare("INSERT INTO events " + EVENT_COLUMNS + " SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM site_fence WHERE site_id = ?)").bind(...insertArgs, site.id).run();
    if (result.meta.changes > 0) return "stored";
  }
  await enqueue(ctx, orgId, site, row, meta);
  return "queued";
}

async function enqueue(ctx, orgId, site, row, meta) {
  const store = ctx.store(orgId);
  const t = now(ctx);
  const envelope = {
    fid: randomHex(16), key: meta.key, ts: row.ts, day: Math.floor(row.ts / 86400), ip: meta.ip || "", ua: meta.ua || "", vh: row.visitor, origin: meta.origin, host: meta.host || "",
    ev: { name: row.name, path: row.path, referrer: row.referrer, source: row.source, medium: row.medium, campaign: row.campaign, content: row.content, term: row.term, value: row.value },
  };
  await store.prepare("INSERT INTO gateway_outbox (fid, site_id, created_at, envelope) VALUES (?, ?, ?, ?)").bind(envelope.fid, site.id, t, asciiJson(envelope)).run();
}

// --- flushing the outbox (source side) ---------------------------------------------------------
// One signed batch per call. Safe to call from any request or from the tick; calls overlap harmlessly
// because rows are deleted only after an acknowledgement and the target dedupes by forward id.
let flushing = false;
export async function flushOutbox(ctx, orgId, { fetch: doFetch = fetch, limit = BATCH_MAX } = {}) {
  const store = ctx.store(orgId);
  if (!(await moveActive(store)) || flushing) return { sent: 0, left: 0, error: "" };
  flushing = true;
  try {
    const link = await cloudLink(ctx);
    const t = now(ctx);
    // Bounded: too old or too many rows are dropped, counted and shown to the owner.
    await store.prepare("DELETE FROM gateway_outbox WHERE created_at < ? OR id <= (SELECT coalesce(max(id), 0) - ? FROM gateway_outbox)").bind(t - OUTBOX_SECONDS, OUTBOX_MAX).run();
    const rows = (await store.prepare("SELECT id, fid, site_id, envelope FROM gateway_outbox ORDER BY id LIMIT ?").bind(limit).all()).results;
    if (!rows.length) return { sent: 0, left: 0, error: "" };
    if (!link) return { sent: 0, left: rows.length, error: "not connected" };
    const body = '{"envelopes":[' + rows.map((r) => r.envelope).join(",") + "]}";
    const ts = t;
    const path = FWD_PATH;
    let response;
    try {
      response = await doFetch(forwardBase(link) + path, { method: "POST", headers: { "content-type": "application/json", authorization: await signRequest({ linkId: link.link_id, secret: link.secret }, "POST", path, body, ts) }, body });
    } catch {
      return { sent: 0, left: rows.length, error: "unreachable" };
    }
    if (response.status !== 200) return { sent: 0, left: rows.length, error: "refused " + response.status };
    const data = await response.json();
    const status = {};
    for (const result of data.results || []) status[result.fid] = result.status;
    const settle = [];
    let sent = 0;
    for (const row of rows) {
      const s = status[row.fid];
      if (s === "stored" || s === "duplicate" || s === "dropped" || s === "invalid" || s === "unknown") { settle.push(store.prepare("DELETE FROM gateway_outbox WHERE id = ?").bind(row.id)); sent++; }
      else if (s === "sealed") {
        // The other side no longer owns this site (a move back): keep the event here.
        const env = JSON.parse(row.envelope);
        settle.push(store.prepare("INSERT INTO events " + EVENT_COLUMNS + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(row.site_id, env.ts, env.ev.name, env.ev.path, env.ev.referrer, env.vh, env.ev.source, env.ev.medium, env.ev.campaign, env.ev.content, env.ev.term, env.ev.value));
        settle.push(store.prepare("DELETE FROM gateway_outbox WHERE id = ?").bind(row.id));
        sent++;
      }
    }
    if (settle.length) await store.batch(settle);
    const left = Number((await store.prepare("SELECT count(*) AS n FROM gateway_outbox").first()).n);
    return { sent, left, error: "" };
  } finally {
    flushing = false;
  }
}

// After a beacon was queued: deliver in the background, right after the response, in this process
// (ctx.waitUntil, up to 25 s). One loop at a time; beacons that arrive while it runs are picked up by its
// next round, so a busy site is delivered in batches without any timer. The minute tick is the fallback.
let kicked = false;
export function kickFlush(ctx, orgId, waitUntil, doFetch = fetch) {
  if (kicked || !waitUntil) return;
  kicked = true;
  waitUntil((async () => {
    try {
      for (let i = 0; i < 40; i++) {
        const r = await flushOutbox(ctx, orgId, { fetch: doFetch });
        if (!r.left || (!r.sent && r.error)) break;
      }
    } catch {
      /* the tick retries */
    } finally {
      kicked = false;
    }
  })());
}

export async function outboxStats(ctx, orgId) {
  const store = ctx.store(orgId);
  if (!(await tableExists(store, "gateway_outbox"))) return { queued: 0, oldest: 0 };
  const row = await store.prepare("SELECT count(*) AS n, coalesce(min(created_at), 0) AS oldest FROM gateway_outbox").first();
  return { queued: Number(row.n), oldest: Number(row.oldest) };
}

// --- the receiver (target side) -----------------------------------------------------------------
const IP = /^[0-9a-fA-F:.]{0,45}$/;
const HEX24 = /^[0-9a-f]{24}$/;
const FID = /^[0-9a-f]{32}$/;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const text = (v, max) => String(v) === v && v.length <= max;

function checkEnvelope(env, link, t) {
  if (Object(env) !== env || Array.isArray(env)) return false;
  const keys = Object.keys(env).sort().join(",");
  if (keys !== "day,ev,fid,host,ip,key,origin,ts,ua,vh") return false;
  if (!FID.test(String(env.fid)) || !KEY.test(String(env.key))) return false;
  if (!Number.isInteger(env.ts) || env.ts > t + 300 || env.ts < t - 8 * 86400) return false;
  if (env.day !== Math.floor(env.ts / 86400)) return false;
  if (!text(env.ip, 45) || !IP.test(env.ip) || !text(env.ua, 512) || !text(env.host, 253) || !(env.vh === "" || HEX24.test(String(env.vh)))) return false;
  if (env.origin !== link.instanceOrigin) return false;
  const e = env.ev;
  if (Object(e) !== e || Object.keys(e).sort().join(",") !== "campaign,content,medium,name,path,referrer,source,term,value") return false;
  if (!NAME.test(String(e.name)) || !text(e.path, 2048) || e.path.charAt(0) !== "/" || !text(e.referrer, 253)) return false;
  for (const f of ["source", "medium", "campaign", "content", "term"]) if (!text(e[f], 128)) return false;
  if (!(e.value === null || (Number.isFinite(e.value) && e.value >= 0 && e.value <= 1000000000))) return false;
  return true;
}

// Token bucket per link: sustained rate and burst, in process.
const buckets = new Map();
export function takeBudget(linkId, count, { rate = 200, burst = 600, nowMs = Date.now() } = {}) {
  let b = buckets.get(linkId);
  if (!b) { b = { tokens: burst, at: nowMs }; buckets.set(linkId, b); }
  b.tokens = Math.min(burst, b.tokens + ((nowMs - b.at) / 1000) * rate);
  b.at = nowMs;
  if (b.tokens < count) return false;
  b.tokens -= count;
  return true;
}

// ctx.visitorFor(db, siteId, ip, ua) hashes with the target's own salt when the instance sent no hash.
export async function receiveForwarded(ctx, link, bodyText, options = {}) {
  let data;
  try { data = JSON.parse(bodyText); } catch { return { status: 400, results: [] }; }
  const list = data && Array.isArray(data.envelopes) ? data.envelopes : null;
  if (!list || list.length > BATCH_MAX || Object.keys(data).length !== 1) return { status: 400, results: [] };
  if (!takeBudget(link.linkId, list.length, options.budget)) return { status: 429, results: [] };
  await ensureSchema(ctx.shared, "shared");
  const t = now(ctx);
  const siteCache = {};
  const results = Array.from({ length: list.length });
  const pending = [];
  const fenced = {};
  for (let i = 0; i < list.length; i++) {
    const env = list[i];
    if (!checkEnvelope(env, link, t)) { results[i] = { fid: Object(env) === env ? String(env.fid) : "", status: "invalid" }; continue; }
    let site = siteCache[env.key];
    if (site === undefined) {
      const found = await getSiteByKey(ctx.shared, env.key);
      let allowed = null;
      if (found && Number(found.org_id) === link.orgId) {
        const tie = await ctx.shared.prepare("SELECT link_id FROM site_links WHERE site_id = ?").bind(found.id).first();
        if (tie && tie.link_id === link.linkId) allowed = found;
      }
      siteCache[env.key] = site = allowed;
    }
    // One answer for "no such site" and "not yours": a link cannot probe keys.
    if (!site) { results[i] = { fid: env.fid, status: "unknown" }; continue; }
    const store = ctx.store(link.orgId);
    if (fenced[site.id] === undefined) {
      await ensureSchema(store, "store");
      fenced[site.id] = !!(await store.prepare("SELECT 1 AS ok FROM site_fence WHERE site_id = ?").bind(site.id).first());
    }
    if (fenced[site.id]) {
      // A forward that was stored before the fence (and whose acknowledgement was lost) is a duplicate, not "sealed".
      const seen = await store.prepare("SELECT 1 AS ok FROM fwd_dedupe WHERE fid = ?").bind(env.fid).first();
      results[i] = { fid: env.fid, status: seen ? "duplicate" : "sealed" };
      continue;
    }
    let visitor = env.vh;
    if (!visitor) visitor = await ctx.visitorFor(store, site.id, env.ip, env.ua);
    pending.push({ i, env, site, visitor });
  }
  if (pending.length) {
    const store = ctx.store(link.orgId);
    const statements = [];
    for (const p of pending) {
      const e = p.env.ev;
      statements.push(store.prepare("INSERT OR IGNORE INTO fwd_dedupe (fid, day) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM site_fence WHERE site_id = ?)").bind(p.env.fid, p.env.day, p.site.id));
      statements.push(store.prepare("INSERT INTO events " + EVENT_COLUMNS + " SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1").bind(p.site.id, p.env.ts, e.name, e.path, e.referrer, p.visitor, e.source, e.medium, e.campaign, e.content, e.term, e.value));
    }
    const outcome = await store.batch(statements);
    pending.forEach((p, k) => { results[p.i] = { fid: p.env.fid, status: outcome[k * 2].meta.changes === 1 ? "stored" : "duplicate" }; });
    // Housekeeping, cheap and occasional.
    if (t % 17 === 0) await store.prepare("DELETE FROM fwd_dedupe WHERE day < ?").bind(Math.floor((t - DEDUPE_SECONDS) / 86400)).run();
  }
  return { status: 200, results };
}

export async function linkedSite(ctx, linkId, siteId) {
  const row = await ctx.shared.prepare("SELECT link_id FROM site_links WHERE site_id = ?").bind(siteId).first();
  return !!row && row.link_id === linkId;
}
export { getSite };

// --- whole-instance helpers ------------------------------------------------------------------------
// A move covers every website of the org, so the seal and the site states are taken for the whole
// list. Each call is idempotent per site: a crash half way is finished by the next call.
export async function sealSites(ctx, orgId, siteIds) {
  let maxId = 0;
  for (const siteId of siteIds) maxId = Math.max(maxId, (await sealSite(ctx, orgId, siteId)).maxId);
  return { maxId };
}
export async function setHomes(ctx, siteIds, home, extra = {}) {
  for (const siteId of siteIds) await setHome(ctx, siteId, home, extra);
}
export async function unsealAll(ctx, orgId, siteIds) {
  for (const siteId of siteIds) await unseal(ctx, orgId, siteId);
}

// True while the instance is moving or has moved: websites cannot be added, renamed or removed then,
// because the target holds the list the move sent. Cheap: two lookups, only when the feature has tables.
export async function instanceLocked(ctx) {
  if (await tableExists(ctx.shared, "site_home")) {
    const row = await ctx.shared.prepare("SELECT 1 AS ok FROM site_home WHERE home IN ('moving','gateway','moving-back','frozen') LIMIT 1").first();
    if (row) return true;
  }
  if (await tableExists(ctx.shared, "moves")) {
    const row = await ctx.shared.prepare("SELECT 1 AS ok FROM moves WHERE direction = 'out' AND state IN ('preflight','bulk','seal','catchup','finalize','needs_attention') LIMIT 1").first();
    if (row) return true;
  }
  return false;
}
