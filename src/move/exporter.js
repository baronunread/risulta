// Export: turn one org's sites into bundle parts. Read only. The same code
// serves "Download your data", the bulk copy and catch-up of a move, and the
// reverse move (which skips the events an earlier import created, so only the
// events the site received natively travel back).
import { BundleWriter, FORMAT, FORMAT_VERSION, PART_BYTES } from "./bundle.js";
import { getSite, siteOrg, widgetEnabled } from "./registry.js";
import { tableExists } from "./schema.js";
import { randomHex } from "../auth.js";
import { asciiJson } from "../util.js";

// One event as a bundle line, built by concatenation: this runs once per event.
function eventLine(row, siteId) {
  return '{"t":"event","id":' + Number(row.id) + ',"site":' + siteId + ',"ts":' + Number(row.ts) + ',"name":' + asciiJson(row.name) + ',"path":' + asciiJson(row.path) +
    ',"referrer":' + asciiJson(row.referrer) + ',"visitor":' + asciiJson(row.visitor) + ',"source":' + asciiJson(row.source) + ',"medium":' + asciiJson(row.medium) +
    ',"campaign":' + asciiJson(row.campaign) + ',"content":' + asciiJson(row.content) + ',"term":' + asciiJson(row.term) + ',"value":' + (row.value === null ? "null" : String(Number(row.value))) + "}";
}

export const APP_VERSION = "0.2.2";
const PAGE = 250;

export class ExportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function skipSql(skipLineage) {
  if (!skipLineage) return "";
  return " AND events.id > coalesce((SELECT r.last_id FROM import_ranges r WHERE r.lineage = ? AND r.site_id = events.site_id AND r.first_id <= events.id ORDER BY r.first_id DESC LIMIT 1), 0)";
}

async function prepare(ctx, opts) {
  const orgId = opts.orgId;
  const db = ctx.store(orgId);
  const siteIds = opts.siteIds.slice();
  if (!siteIds.length) throw new ExportError("no_sites", "choose at least one site");
  const sites = [];
  for (const id of siteIds) {
    const site = await getSite(ctx.shared, id);
    // A site of another org is "not found", never "forbidden": its existence is not ours to confirm.
    if (!site || (await siteOrg(ctx.shared, id)) !== orgId) throw new ExportError("not_found", "site not found");
    sites.push(site);
  }
  const skipLineage = opts.skipLineage && (await tableExists(db, "import_ranges")) ? opts.skipLineage : "";
  let untilId = opts.untilId;
  if (untilId === undefined || untilId === null) {
    const row = await db.prepare("SELECT coalesce(max(id), 0) AS m FROM events").first();
    untilId = Number(row.m);
  }
  return { db, sites, skipLineage, sinceId: opts.sinceId || 0, untilId };
}

// Cheap numbers for the preview, no rows read.
export async function estimateExport(ctx, opts) {
  const { db, sites, skipLineage, sinceId, untilId } = await prepare(ctx, opts);
  let events = 0;
  let minTs = 0;
  let maxTs = 0;
  for (const site of sites) {
    const args = [site.id, sinceId, untilId].concat(skipLineage ? [skipLineage] : []);
    const row = await db.prepare("SELECT count(*) AS n, coalesce(min(ts), 0) AS lo, coalesce(max(ts), 0) AS hi FROM events WHERE site_id = ? AND id > ? AND id <= ?" + skipSql(skipLineage)).bind(...args).first();
    events += Number(row.n);
    if (Number(row.n)) {
      if (!minTs || Number(row.lo) < minTs) minTs = Number(row.lo);
      if (Number(row.hi) > maxTs) maxTs = Number(row.hi);
    }
  }
  return { sites: sites.length, events, minTs, maxTs, untilId, bytes: events * 190 + sites.length * 400 };
}

// Async generator of parts { n, text, bytes, sha256 }.
export async function* exportParts(ctx, opts) {
  const { db, sites, skipLineage, sinceId, untilId } = await prepare(ctx, opts);
  const queue = [];
  const writer = new BundleWriter((part) => { queue.push(part); }, opts.partBytes || PART_BYTES, true, !!opts.partDigest);
  const lineage = opts.lineage || randomHex(16);
  // A window that is generated again after a retry carries the same creation time.
  const now = opts.createdAt || (ctx.now ? ctx.now() : Math.floor(Date.now() / 1000));
  const schema = await db.prepare("SELECT coalesce(max(version), 0) AS v FROM schema_migrations").first().then((row) => Number(row.v), () => 0);
  await writer.line({
    t: "manifest", format: FORMAT, format_version: FORMAT_VERSION, schema_version: schema, app_version: APP_VERSION,
    created_at: now, scope: opts.scope === "org" ? "org" : "site", lineage, since_id: sinceId, until_id: untilId, contains_secrets: false,
  });
  const salts = {};
  for (const site of sites) {
    salts[site.id] = (await db.prepare("SELECT day, value FROM site_salts WHERE site_id = ? ORDER BY day DESC LIMIT 3").bind(site.id).all()).results;
    await writer.line({
      t: "site", ref: site.id, name: site.name, domain: site.domain, slug: site.slug || "", key: site.public_key,
      created_at: Number(site.created_at), widget: await widgetEnabled(ctx.shared, site.id),
      salts: salts[site.id].map((row) => ({ day: row.day, value: row.value })),
    });
  }
  yield* drain(queue);
  for (const site of sites) {
    for (const row of (await db.prepare("SELECT id, name, event_name, path, created_at FROM goals WHERE site_id = ? ORDER BY id").bind(site.id).all()).results) {
      await writer.line({ t: "goal", site: site.id, ref: Number(row.id), name: row.name, event_name: row.event_name, path: row.path, created_at: Number(row.created_at) });
    }
  }
  for (const site of sites) {
    for (const row of (await db.prepare("SELECT id, name, created_at FROM funnels WHERE site_id = ? ORDER BY id").bind(site.id).all()).results) {
      const steps = (await db.prepare("SELECT goal_id FROM funnel_steps WHERE funnel_id = ? ORDER BY position").bind(row.id).all()).results;
      if (!steps.length) continue;
      await writer.line({ t: "funnel", site: site.id, ref: Number(row.id), name: row.name, created_at: Number(row.created_at), steps: steps.map((step) => Number(step.goal_id)) });
    }
  }
  if (await tableExists(db, "annotations")) {
    for (const site of sites) {
      for (const row of (await db.prepare("SELECT ts, text FROM annotations WHERE site_id = ? ORDER BY ts, id").bind(site.id).all()).results) {
        await writer.line({ t: "annotation", site: site.id, ts: Number(row.ts), text: row.text });
      }
    }
  }
  if (opts.includeUsers) {
    for await (const line of inviteLines(ctx, sites)) await writer.line(line);
  }
  yield* drain(queue);
  const args = (siteId, after) => [siteId, after, untilId].concat(skipLineage ? [skipLineage] : []);
  for (const site of sites) {
    let after = sinceId;
    for (;;) {
      const rows = (await db.prepare(
        "SELECT id, ts, name, path, referrer, visitor, source, medium, campaign, content, term, value FROM events NOT INDEXED WHERE site_id = ? AND id > ? AND id <= ?" + skipSql(skipLineage) + " ORDER BY id LIMIT " + PAGE,
      ).bind(...args(site.id, after)).all()).results;
      for (const row of rows) {
        await writer.raw("event", eventLine(row, site.id));
        after = Number(row.id);
      }
      yield* drain(queue);
      if (rows.length < PAGE) break;
    }
  }
  for (const site of sites) {
    const totals = (await db.prepare(
      "SELECT date(ts, 'unixepoch') AS day, count(*) AS events, coalesce(sum(name = 'pageview'), 0) AS pageviews, count(DISTINCT CASE WHEN name = 'pageview' THEN visitor END) AS visitors FROM events NOT INDEXED WHERE site_id = ? AND id > ? AND id <= ?" + skipSql(skipLineage) + " GROUP BY day ORDER BY day",
    ).bind(...args(site.id, sinceId)).all()).results;
    for (const row of totals) {
      await writer.line({ t: "totals", site: site.id, day: row.day, events: Number(row.events), pageviews: Number(row.pageviews), visitors: Number(row.visitors) });
    }
  }
  await writer.finish();
  yield* drain(queue);
}

function* drain(queue) {
  while (queue.length) yield queue.shift();
}

// Invitations, never accounts: email, name, role and the slugs the person sees.
// Password hashes are not selected, so they cannot reach a bundle.
async function* inviteLines(ctx, sites) {
  if (!(await tableExists(ctx.shared, "users"))) return;
  const slugs = {};
  for (const site of sites) slugs[site.id] = site.slug || String(site.id);
  const users = (await ctx.shared.prepare("SELECT id, email, display_name, role FROM users ORDER BY id").all()).results;
  for (const user of users) {
    let list = [];
    if (user.role === "admin") list = sites.map((site) => slugs[site.id]);
    else {
      const rows = (await ctx.shared.prepare("SELECT site_id FROM site_users WHERE user_id = ?").bind(user.id).all()).results;
      list = rows.filter((row) => slugs[row.site_id]).map((row) => slugs[row.site_id]);
    }
    if (!list.length) continue;
    yield { t: "user", email: String(user.email), display_name: String(user.display_name || ""), role: user.role, sites: list };
  }
}
