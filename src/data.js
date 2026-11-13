// Data-layer handles. Every query goes through one of these two, never through
// env.DB directly, so the hosted design can put each org's events behind its
// own Durable Object without touching a handler:
//
//   shared(env)         users, sessions, sites (the registry that maps a
//                       tracker key to its org), read-API keys, public-widget
//                       flags, backup settings.
//   store(env, orgId)   one org's events, goals, funnels, annotations, daily
//                       salts, rollups, analytics caches and import ledger.
//
// No query may join across the two (SQLite cannot join across databases), and
// no foreign key may cross them. Today both resolve to the one D1 binding.
// `EVENTS_DB` is an optional second binding that tests use to prove the split.
export const DEFAULT_ORG = 1;

export function shared(env) {
  return env.DB;
}

export function store(env, orgId) {
  void orgId;
  return env.EVENTS_DB || env.DB;
}

// Single tenant: every site belongs to org 1. The org column arrives with the
// multi-tenant schema; callers already ask the site, not a constant.
export function orgOfSite(site) {
  void site;
  return DEFAULT_ORG;
}

// The orgs the every-minute tick works through.
export async function listOrgs(db) {
  void db;
  return [DEFAULT_ORG];
}
