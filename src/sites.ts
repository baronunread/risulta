import type { Database, DatabaseStatement, SiteAddress } from "./types.ts";

// Site slugs are stable, unique UI addresses. Numeric IDs remain API identifiers.
export function siteSlug(site: SiteAddress): string {
  return site.slug || String(site.id);
}

// `taken` holds slugs chosen earlier in the same pass that are not stored yet;
// `stored` is false while the slug column does not exist, so only `taken` counts.
export async function availableSiteSlug(db: Database, domain: string, taken?: Set<string>, stored = true): Promise<string> {
  const labels = String(domain).toLowerCase().split(".");
  let base = (labels[0] === "www" ? labels[1] : labels[0]) || "site";
  base = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  if (!base || /^[0-9]+$/.test(base) || base === "new") base = "site-" + (base || "website");
  let slug = base;
  let suffix = 2;
  while ((taken && taken.has(slug)) || (stored && await db.prepare("SELECT id FROM sites WHERE slug = ?").bind(slug).first())) slug = base + "-" + suffix++;
  return slug;
}

// The statements that give every site a slug and index it. The caller runs
// them in one batch with its ledger row.
export async function siteSlugStatements(db: Database): Promise<DatabaseStatement[]> {
  const columns = (await db.prepare("PRAGMA table_info(sites)").all<{ name: string }>()).results;
  const statements: DatabaseStatement[] = [];
  const hasSlug = columns.some((column) => column.name === "slug");
  if (!hasSlug) statements.push(db.prepare("ALTER TABLE sites ADD COLUMN slug TEXT"));
  const missing = hasSlug
    ? (await db.prepare("SELECT id, domain FROM sites WHERE slug IS NULL OR slug = '' ORDER BY id").all<{ id: number; domain: string }>()).results
    : (await db.prepare("SELECT id, domain FROM sites ORDER BY id").all<{ id: number; domain: string }>()).results;
  const taken = new Set<string>();
  for (let i = 0; i < missing.length; i++) {
    const slug = await availableSiteSlug(db, missing[i].domain, taken, hasSlug);
    taken.add(slug);
    statements.push(db.prepare("UPDATE sites SET slug = ? WHERE id = ?").bind(slug, missing[i].id));
  }
  statements.push(db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_slug ON sites(slug)"));
  return statements;
}
