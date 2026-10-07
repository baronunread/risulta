import type { Database, SiteAddress } from "./types.ts";

// Site slugs are stable, unique UI addresses. Numeric IDs remain API identifiers.
export function siteSlug(site: SiteAddress): string {
  return site.slug || String(site.id);
}

export function availableSiteSlug(db: Database, domain: string): string {
  const labels = String(domain).toLowerCase().split(".");
  let base = (labels[0] === "www" ? labels[1] : labels[0]) || "site";
  base = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  if (!base || /^[0-9]+$/.test(base) || base === "new") base = "site-" + (base || "website");
  let slug = base;
  let suffix = 2;
  while (db.prepare("SELECT id FROM sites WHERE slug = ?").bind(slug).first()) slug = base + "-" + suffix++;
  return slug;
}

export function ensureSiteSlugs(db: Database): void {
  const columns = db.prepare("PRAGMA table_info(sites)").all<{ name: string }>().results;
  if (!columns.some((column) => column.name === "slug")) db.exec("ALTER TABLE sites ADD COLUMN slug TEXT");
  const missing = db.prepare("SELECT id, domain FROM sites WHERE slug IS NULL OR slug = '' ORDER BY id").all<{ id: number; domain: string }>().results;
  for (let i = 0; i < missing.length; i++) {
    const slug = availableSiteSlug(db, missing[i].domain);
    db.prepare("UPDATE sites SET slug = ? WHERE id = ?").bind(slug, missing[i].id).run();
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_slug ON sites(slug)");
}
