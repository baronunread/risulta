// Derived journeys only: no identities, sessions or additional storage.
export const JOURNEY_EVENT_LIMIT = 10000;

function boundedInteger(value, fallback, minimum, maximum) {
  const n = Number(value);
  return Number.isFinite(n) && value !== null && value !== ""
    ? Math.max(minimum, Math.min(maximum, Math.floor(n)))
    : fallback;
}

export function journeyInput(params) {
  const visitor = params.get("visitor") || "";
  if (visitor && !/^[a-f0-9]{24}$/.test(visitor)) return { error: "visitor must be a 24-character daily visitor hash" };
  return {
    visitor,
    limit: boundedInteger(params.get("limit"), 50, 1, 100),
    offset: boundedInteger(params.get("offset"), 0, 0, 10000),
  };
}

// Call only after getSiteForUser. Filter before scanning so a visitor
// drilldown has its own bounded scan, independent of the site's traffic.
// The extra row detects truncation without an unbounded count query.
export function siteJourneys(db, siteId, since, until, input) {
  const values = [siteId, since, until];
  let where = "site_id = ? AND ts >= ? AND ts < ? AND visitor != ''";
  if (input.visitor) {
    where += " AND visitor = ?";
    values.push(input.visitor);
  }
  const events = db.prepare(
    "SELECT id, visitor, ts, name, path, value FROM events WHERE " + where + " ORDER BY visitor, ts, id LIMIT ?",
  ).bind(...values, JOURNEY_EVENT_LIMIT + 1).all().results;
  const truncated = events.length > JOURNEY_EVENT_LIMIT;
  if (truncated) events.pop();
  const journeys = [];
  let current = null;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!current || current.visitor !== event.visitor || event.ts - current.end > 1800 ||
        Math.floor(event.ts / 86400) !== Math.floor(current.end / 86400)) {
      current = { visitor: event.visitor, session: event.id, start: event.ts, end: event.ts, events: [] };
      journeys.push(current);
    }
    current.end = event.ts;
    current.events.push({ id: event.id, ts: event.ts, name: event.name, path: event.path, value: event.value });
  }
  return {
    visitor: input.visitor,
    rows: journeys.slice(input.offset, input.offset + input.limit),
    total: journeys.length,
    limit: input.limit,
    offset: input.offset,
    scanned: events.length,
    eventLimit: JOURNEY_EVENT_LIMIT,
    truncated,
  };
}
