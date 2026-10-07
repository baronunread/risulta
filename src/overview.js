import { siteJourneys } from "./journeys.js";
import { overviewScope, overviewGoals, dashboardTraffic, dashboardSummary, dashboardReport, dashboardGoals, siteFunnels } from "./store.js";

// Bounded per-process snapshots share expensive aggregates across metric clicks
// and open browser tabs. Authorization stays in the route before every lookup.
const entries = [];
const limit = 32;

function snapshot(db, site, range, now) {
  const filters = range.filters || {};
  const end = range.until === Math.floor(now / 1000) + 1 ? "live" : range.until;
  const key = JSON.stringify([site.id, range.since, end, filters.path || "", filters.source || "", filters.medium || "", filters.campaign || ""]);
  let entry = null;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].db === db && entries[i].key === key) { entry = entries[i]; break; }
  }
  if (!entry) {
    if (entries.length >= limit) entries.shift();
    entry = { db, key, siteId: site.id, traffic: null, goals: null, comparison: null };
    entries.push(entry);
  }
  return entry;
}

export function invalidateOverview(db, siteId) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].db === db && entries[i].siteId === siteId) entries.splice(i, 1);
  }
}

function fresh(timestamp, now, ttl) {
  return timestamp !== undefined && now >= timestamp && now - timestamp < ttl;
}

export function overviewAnalytics(db, site, range, includeGoals, now) {
  now = now === undefined ? Date.now() : now;
  const entry = snapshot(db, site, range, now);
  if (!entry.traffic || !fresh(entry.trafficAt, now, 15000)) {
    entry.traffic = dashboardTraffic(db, site, range, Math.floor(now / 1000));
    entry.trafficAt = now;
  }
  if (includeGoals && (!entry.goals || !fresh(entry.goalsAt, now, 60000))) {
    entry.goals = overviewGoals(overviewScope(db, site.id, range.since, range.until, range.filters), site.id, range.since, range.until, Number(entry.traffic.summary.visitors));
    entry.goalsAt = now;
  }
  // A traffic poll must not mutate the cached initial page's goal preview.
  return { ...entry.traffic, goals: includeGoals ? entry.goals : [] };
}

export function overviewComparison(db, site, range, now) {
  now = now === undefined ? Date.now() : now;
  const entry = snapshot(db, site, range, now);
  if (!entry.comparison || !fresh(entry.comparisonAt, now, 15000)) {
    entry.comparison = dashboardSummary(db, site, range, Math.floor(now / 1000));
    entry.comparisonAt = now;
  }
  return entry.comparison;
}

export function measurementAnalytics(db, site, range, kind, now) {
  now = now === undefined ? Date.now() : now;
  const entry = snapshot(db, site, range, now);
  const key = kind === "goals" ? "goalReport" : "funnelReport";
  if (!entry[key] || !fresh(entry[key + "At"], now, 15000)) {
    const scoped = overviewScope(db, site.id, range.since, range.until, range.filters);
    if (kind === "goals") {
      entry[key] = { goals: dashboardGoals(db, site, range, Math.floor(now / 1000)) };
    } else entry[key] = siteFunnels(scoped, site.id, range.since, range.until);
    entry[key + "At"] = now;
  }
  return entry[key];
}


// Report snapshots are bounded per range as well as across sites and filters.
// API responses continue to use fresh reads.
export function reportAnalytics(db, site, range, input, cohort, now) {
  now = now === undefined ? Date.now() : now;
  const entry = snapshot(db, site, range, now);
  const key = JSON.stringify([input.dimension, input.filters, input.limit, input.offset, input.sort, cohort]);
  return cachedReport(entry, key, now, () => dashboardReport(db, site, range, input, cohort, Math.floor(now / 1000)));
}

export function journeyAnalytics(db, site, range, input, now) {
  now = now === undefined ? Date.now() : now;
  const entry = snapshot(db, site, range, now);
  const key = JSON.stringify(["journeys", input.visitor, input.limit, input.offset]);
  return cachedReport(entry, key, now, () => siteJourneys(
    overviewScope(db, site.id, range.since, range.until, range.filters),
    site.id, range.since, range.until, input,
  ));
}

function cachedReport(entry, key, now, read) {
  if (!entry.reports) entry.reports = [];
  for (let i = 0; i < entry.reports.length; i++) {
    const report = entry.reports[i];
    if (report.key === key) {
      if (!fresh(report.at, now, 15000)) { report.value = read(); report.at = now; }
      return { ...report.value };
    }
  }
  if (entry.reports.length >= 8) entry.reports.shift();
  const value = read();
  entry.reports.push({ key, at: now, value });
  return { ...value };
}
