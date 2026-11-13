// Extension hooks: the one object a host passes to createRisulta(hooks).
//
// Core is the open application; a hosted deployment wraps it and supplies what
// is specific to running it for other people. A wrapper never patches app code:
// anything it needs becomes a hook or an option here, with a safe default so a
// plain self-hosted install behaves exactly as before.
//
// Implemented in core (each is optional, and each failure is contained):
//   hooksVersion   must equal HOOKS_VERSION; core refuses to start on a mismatch
//   backupFiles    publish and prune backup files (the standalone binary supplies it)
//   quota          { limits(orgId, env) -> { sites, retentionDays, moveWindow, moveMaxEvents, ... } } (fails open;
//                  `env` is the request's bindings, so a host can read its own tables).
//                  Core enforces `sites` (new websites, and the sites a move brings in) and gives `retentionDays`,
//                  `moveWindow` and `moveMaxEvents` to the move feature; the other numbers are the host's
//   ingestGuard    (site, info) -> "allow" | "drop"   synchronous and cheap (fails open)
//   events         { siteCreated({ orgId, site }) }   notification, errors are logged
//   migrations     [{ version, sql }]  extra tables of the host, run after core's own,
//                  kept in their own ledger (`host_migrations`) in the shared store
//   schedule       (info) -> void   runs inside the time-budgeted tick, errors are logged
//   blobs          (env) -> { put(key, text), get(key), delete(key) }  where bundle parts wait (default: the shared
//                  database). A function of env, because a host's storage is a binding that arrives with the request
//
// Accepted and carried, not consumed yet (the features they belong to are not in core):
//   jobs (waking a background step: moves are driven by the tick and the page poll), billing, onSignup,
//   mailer, operator
// Unknown keys are refused, so a typo is not a silently ignored hook.
import { splitStatements } from "./sql.ts";

export const HOOKS_VERSION = 1;

const KNOWN = ["hooksVersion", "backupFiles", "quota", "billing", "onSignup", "mailer", "events", "ingestGuard", "migrations", "schedule", "blobs", "jobs", "operator"];

const UNLIMITED = Object.freeze({ sites: null, pageviews: null, members: null, readKeys: null, retentionDays: null, moveWindow: null, moveMaxEvents: null });

export function resolveHooks(options) {
  const given = options || {};
  for (const key of Object.keys(given)) {
    if (KNOWN.indexOf(key) < 0) throw new Error("createRisulta: unknown hook '" + key + "'");
  }
  if (given.hooksVersion !== undefined && given.hooksVersion !== HOOKS_VERSION) {
    throw new Error("createRisulta: hooksVersion " + String(given.hooksVersion) + " does not match this Risulta (" + HOOKS_VERSION + ")");
  }
  const migrations = given.migrations || [];
  const seen = {};
  let last = 0;
  for (const m of migrations) {
    if (!m || !Number.isInteger(m.version) || m.version <= last || seen[m.version] || String(m.sql) !== m.sql) {
      throw new Error("createRisulta: migrations must be { version, sql } with strictly increasing integer versions");
    }
    seen[m.version] = true;
    last = m.version;
  }
  return {
    hooksVersion: HOOKS_VERSION,
    backupFiles: given.backupFiles || null,
    quota: given.quota || null,
    billing: given.billing || null,
    onSignup: given.onSignup || null,
    mailer: given.mailer || null,
    events: given.events || null,
    ingestGuard: given.ingestGuard || null,
    migrations,
    schedule: given.schedule || null,
    blobs: given.blobs || null,
    jobs: given.jobs || null,
    operator: given.operator || null,
  };
}

// Limits of an org. Fails open: a missing hook, an error or a malformed answer is "unlimited".
export async function orgLimits(hooks, orgId, env) {
  if (!hooks.quota || !hooks.quota.limits) return UNLIMITED;
  try {
    const limits = await hooks.quota.limits(orgId, env);
    return Object(limits) === limits ? { ...UNLIMITED, ...limits } : UNLIMITED;
  } catch (error) {
    console.error("quota hook failed (allowing): " + String(error));
    return UNLIMITED;
  }
}

// True when a collector request may be stored. Synchronous so the hot path pays nothing without a hook.
export function ingestAllowed(hooks, site, info) {
  if (!hooks.ingestGuard) return true;
  try {
    return hooks.ingestGuard(site, info) !== "drop";
  } catch (error) {
    console.error("ingestGuard hook failed (allowing): " + String(error));
    return true;
  }
}

export async function emit(hooks, name, payload) {
  if (!hooks.events || !hooks.events[name]) return;
  try {
    await hooks.events[name](payload);
  } catch (error) {
    console.error("events." + name + " hook failed: " + String(error));
  }
}

export async function runSchedule(hooks, info) {
  if (!hooks.schedule) return;
  try {
    await hooks.schedule(info);
  } catch (error) {
    console.error("schedule hook failed: " + String(error));
  }
}

// The host's own tables. One ledger, one batch per version (statements and ledger row together),
// so a failure leaves the version unrecorded and it is retried whole.
export async function runHostMigrations(db, migrations) {
  if (!migrations.length) return;
  await db.prepare("CREATE TABLE IF NOT EXISTS host_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)").run();
  for (const m of migrations) {
    if (await db.prepare("SELECT version FROM host_migrations WHERE version = ?").bind(m.version).first()) continue;
    const list = splitStatements(m.sql).map((statement) => db.prepare(statement));
    list.push(db.prepare("INSERT OR IGNORE INTO host_migrations (version, applied_at) VALUES (?, ?)").bind(m.version, Math.floor(Date.now() / 1000)));
    await db.batch(list);
  }
}
