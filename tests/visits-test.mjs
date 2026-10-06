import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { siteAnalytics, siteSummary } from "../src/store.js";
import { dateSeries, hourSeries } from "../src/chart.js";

const sqlite = new Database(":memory:");
sqlite.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, ts INTEGER NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL DEFAULT '', visitor TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', medium TEXT NOT NULL DEFAULT '', campaign TEXT NOT NULL DEFAULT '', value REAL);");
sqlite.exec("CREATE TABLE goals (id INTEGER PRIMARY KEY, site_id INTEGER, name TEXT, event_name TEXT, path TEXT);");
sqlite.exec("CREATE TABLE funnels (id INTEGER PRIMARY KEY, site_id INTEGER, name TEXT);");
sqlite.exec("CREATE TABLE funnel_steps (funnel_id INTEGER, position INTEGER, goal_id INTEGER);");
const db = {
  prepare(sql) {
    let params = [];
    const statement = sqlite.prepare(sql);
    return {
      bind(...values) { params = values; return this; },
      first() { return statement.get(...params); },
      all() { return { results: statement.all(...params) }; },
    };
  },
};
const insert = sqlite.prepare("INSERT INTO events (site_id, ts, name, path, visitor) VALUES (?, ?, ?, ?, ?)");
const add = (site, ts, name = "pageview", visitor = "a", path = "/") => insert.run(site, ts, name, path, visitor);

try {
  const empty = siteSummary(db, 1, 0, 172800);
  assert.deepEqual(empty, { pageviews: 0, visitors: 0, visits: 0 });
  let analytics = siteAnalytics(db, { id: 1 }, 0, 172800);
  assert.deepEqual(analytics.summary, empty);
  assert.deepEqual(analytics.byDay, []);
  assert.deepEqual(analytics.byHour, []);

  // Same UTC day: an exact 30-minute gap remains in-session, a larger gap starts one.
  add(1, 100);
  add(1, 1900);
  add(1, 3701);
  add(1, 4000, "signup", "a", "/done"); // Custom events extend the journey session without adding pageviews.
  add(1, 86400); // UTC midnight always starts a new daily visitor session.
  add(1, 86401, "signup", "b", "/done");
  add(1, 90000, "pageview", "b");
  add(1, 50000, "signup", "c", "/custom-only"); // Custom-event-only journeys count as sessions.
  add(2, 101); // Same visitor on another site must not affect site 1.

  const summary = siteSummary(db, 1, 0, 172800);
  assert.deepEqual(summary, { pageviews: 5, visitors: 2, visits: 6 });
  analytics = siteAnalytics(db, { id: 1 }, 0, 172800);
  assert.deepEqual(analytics.summary, summary);
  assert.deepEqual(analytics.byDay.map(({ day, pageviews, visitors, visits }) => ({ day, pageviews, visitors, visits })), [
    { day: "1970-01-01", pageviews: 3, visitors: 1, visits: 3 },
    { day: "1970-01-02", pageviews: 2, visitors: 2, visits: 3 },
  ]);
  assert.deepEqual(analytics.byHour.map(({ hour, visits }) => [hour, visits]), [[0, 3], [1, 2], [13, 1]]);
  assert.equal(analytics.byDay.reduce((sum, row) => sum + row.pageviews, 0), summary.pageviews);
  assert.equal(analytics.byDay.reduce((sum, row) => sum + row.visits, 0), summary.visits);
  assert.equal(analytics.byHour.reduce((sum, row) => sum + row.visits, 0), summary.visits);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(dateSeries(1, [{ day: today, visits: 4 }])[0].visits, 4);
  assert.deepEqual(hourSeries(analytics.byHour).slice(0, 3).map((row) => row.visits), [3, 2, 0]);
  assert.deepEqual(siteSummary(db, 2, 0, 172800), { pageviews: 1, visitors: 1, visits: 1 });

  // The range start does not invent a visit; only the later 1801-second gap does.
  assert.deepEqual(siteSummary(db, 1, 1900, 3702), { pageviews: 2, visitors: 1, visits: 1 });
  // Strict threshold: a gap of 1801 seconds starts a session.
  assert.deepEqual(siteSummary(db, 1, 3701, 4000), { pageviews: 1, visitors: 1, visits: 1 });
} finally {
  sqlite.close();
}

console.log("visits OK");
