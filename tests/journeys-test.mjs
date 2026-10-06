// Journey sessions are derived from bounded, site-scoped event reads.
import { journeyInput, siteJourneys, JOURNEY_EVENT_LIMIT } from "../src/journeys.js";

const events = [
  { id: 1, visitor: "a", ts: 100, name: "pageview", path: "/", value: null },
  { id: 2, visitor: "a", ts: 1900, name: "signup", path: "/done", value: 1 }, // exactly 30 minutes
  { id: 3, visitor: "a", ts: 3701, name: "click", path: "/next", value: null },
  { id: 4, visitor: "a", ts: 86400, name: "pageview", path: "/", value: null }, // UTC day boundary
  { id: 5, visitor: "b", ts: 86401, name: "pageview", path: "/", value: null },
];
let query;
const db = {
  prepare(sql) {
    query = { sql, values: [] };
    return { bind(...values) { query.values = values; return this; }, all() {
      const siteId = query.values[0];
      const since = query.values[1];
      const until = query.values[2];
      const visitor = query.sql.includes("visitor = ?") ? query.values[3] : null;
      const limit = query.values.at(-1);
      return { results: events.filter((event) => event.ts >= since && event.ts < until &&
        (!visitor || visitor === event.visitor)).slice(0, limit).map((event) => ({ ...event, site_id: siteId })) };
    } };
  },
};

const result = siteJourneys(db, 7, 0, 100000, { visitor: "", limit: 50, offset: 0 });
if (result.total !== 4) throw new Error(`expected 4 sessions, got ${result.total}`);
if (result.rows[0].events.length !== 2 || result.rows[0].events[1].id !== 2) throw new Error("30-minute boundary must remain in the session");
if (result.rows[1].events[0].id !== 3) throw new Error("a gap over 30 minutes must start a session");
if (result.rows[2].events[0].id !== 4) throw new Error("UTC midnight must start a session");
if (result.rows[3].visitor !== "b") throw new Error("different visitors must remain separate");
if (!query.sql.includes("site_id = ?") || !query.sql.includes("ORDER BY visitor, ts, id") || query.values.at(-1) !== JOURNEY_EVENT_LIMIT + 1) {
  throw new Error("query must be site-scoped, deterministically ordered, and bounded");
}

siteJourneys(db, 7, 0, 100000, { visitor: "a", limit: 5, offset: 0 });
if (!query.sql.includes("AND visitor = ?") || query.values[3] !== "a") throw new Error("visitor drilldown must filter before the bounded scan");
if (!journeyInput(new URLSearchParams("visitor=xyz")).error) throw new Error("invalid visitor hash must be rejected");
if (journeyInput(new URLSearchParams("limit=1000")).limit !== 100) throw new Error("page size must be capped");
console.log("journeys OK");

// A long timeline keeps every event available while limiting the initial view.
const { journeysPage } = await import("../src/views.js");
const longEvents = Array.from({ length: 30 }, (_, i) => ({ ts: 100 + i, name: "pageview", path: i === 0 ? "/" + "long-path/".repeat(20) : "/event-" + i, value: null }));
const html = journeysPage({ role: "viewer", email: "demo@example.com", csrf: "demo" }, { id: 1, name: "Shop", domain: "shop.example" }, [],
  { rows: [{ visitor: "abc123", session: "long", start: 100, end: 129, events: longEvents }], total: 1, limit: 10, offset: 0, visitor: "", truncated: false },
  { days: 7, label: "Last 7 days" });
if (!html.includes('class="journey-more"><summary>Show 18 more events')) throw new Error("long timeline must offer remaining events");
if (!html.includes('/event-29')) throw new Error("remaining events must not be discarded");
if (!html.includes('class="report-label"')) throw new Error("long paths must be expandable");
