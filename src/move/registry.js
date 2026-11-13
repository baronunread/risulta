// The site registry lives in the shared database. These helpers are the only
// place the move feature reads or writes `sites`, so the multi-tenant schema
// (an `org_id` column, per-org uniqueness) lands here and nowhere else.
import { tableExists } from "./schema.js";

const DEFAULT_ORG = 1;
const orgColumn = new WeakMap();

async function hasOrgColumn(shared) {
  if (orgColumn.has(shared)) return orgColumn.get(shared);
  const columns = (await shared.prepare("PRAGMA table_info(sites)").all()).results;
  const has = columns.some((column) => column.name === "org_id");
  orgColumn.set(shared, has);
  return has;
}

export function resetRegistryCache(shared) {
  orgColumn.delete(shared);
}

export async function getSite(shared, id) {
  const org = (await hasOrgColumn(shared)) ? "org_id" : String(DEFAULT_ORG) + " AS org_id";
  return await shared.prepare("SELECT id, name, domain, slug, public_key, created_at, " + org + " FROM sites WHERE id = ?").bind(id).first();
}

export async function getSiteByKey(shared, key) {
  const org = (await hasOrgColumn(shared)) ? "org_id" : String(DEFAULT_ORG) + " AS org_id";
  return await shared.prepare("SELECT id, name, domain, slug, public_key, created_at, " + org + " FROM sites WHERE public_key = ?").bind(key).first();
}

export async function widgetEnabled(shared, siteId) {
  if (!(await tableExists(shared, "public_widgets"))) return 0;
  const row = await shared.prepare("SELECT enabled FROM public_widgets WHERE site_id = ?").bind(siteId).first();
  return row && Number(row.enabled) === 1 ? 1 : 0;
}

export function slugBase(domain) {
  const labels = String(domain).toLowerCase().split(".");
  let base = (labels[0] === "www" ? labels[1] : labels[0]) || "site";
  base = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  if (!base || /^[0-9]+$/.test(base) || base === "new") base = "site-" + (base || "website");
  return base;
}

export async function availableSlug(shared, wanted, domain) {
  const base = slugBase(wanted || domain);
  let slug = base;
  let suffix = 2;
  while (await shared.prepare("SELECT id FROM sites WHERE slug = ?").bind(slug).first()) slug = base + "-" + suffix++;
  return slug;
}

// Statements, not executions: the caller batches them with the site_home row so
// a crash cannot leave a site without its `importing` marker.
export async function createSiteStatements(shared, orgId, site, slug, widget, home) {
  const withOrg = await hasOrgColumn(shared);
  const insert = withOrg
    ? shared.prepare("INSERT INTO sites (name, domain, public_key, created_at, slug, org_id) VALUES (?, ?, ?, ?, ?, ?)").bind(site.name, site.domain, site.key, site.created_at, slug, orgId)
    : shared.prepare("INSERT INTO sites (name, domain, public_key, created_at, slug) VALUES (?, ?, ?, ?, ?)").bind(site.name, site.domain, site.key, site.created_at, slug);
  const list = [insert];
  list.push(
    shared.prepare("INSERT INTO site_home (site_id, home, lineage, src_ref, link_id, job_id, updated_at) VALUES ((SELECT id FROM sites WHERE public_key = ?), ?, ?, ?, ?, ?, ?)")
      .bind(site.key, home.home, home.lineage, site.ref, home.link_id || "", home.job_id, home.now),
  );
  if (widget && (await tableExists(shared, "public_widgets"))) {
    list.push(shared.prepare("INSERT OR REPLACE INTO public_widgets (site_id, enabled) VALUES ((SELECT id FROM sites WHERE public_key = ?), 1)").bind(site.key));
  }
  return list;
}

export async function domainTaken(shared, orgId, domain) {
  const withOrg = await hasOrgColumn(shared);
  const row = withOrg
    ? await shared.prepare("SELECT id, org_id FROM sites WHERE domain = ? AND org_id = ?").bind(domain, orgId).first()
    : await shared.prepare("SELECT id FROM sites WHERE domain = ?").bind(domain).first();
  return !!row;
}

export async function keyTaken(shared, key) {
  return !!(await shared.prepare("SELECT id FROM sites WHERE public_key = ?").bind(key).first());
}

export async function siteOrg(shared, siteId) {
  const site = await getSite(shared, siteId);
  return site ? Number(site.org_id) : 0;
}

// Whole-instance moves work on every website of the org. The order is fixed (by id) so a window,
// a manifest and a seal always see the same list.
export async function listOrgSites(shared, orgId) {
  const withOrg = await hasOrgColumn(shared);
  const columns = "id, name, domain, slug, public_key, created_at";
  const rows = withOrg
    ? (await shared.prepare("SELECT " + columns + " FROM sites WHERE org_id = ? ORDER BY id").bind(orgId).all()).results
    : (await shared.prepare("SELECT " + columns + " FROM sites ORDER BY id").all()).results;
  return rows;
}

export async function countOrgSites(shared, orgId) {
  return (await listOrgSites(shared, orgId)).length;
}
