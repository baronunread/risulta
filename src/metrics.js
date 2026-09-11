// Operational counters, the /metrics exposition, and request logging.
// Same counter names as the Bun app so dashboards transfer. No node:
// imports; module-level state is per-process. Multi-process deployments
// (SO_REUSEPORT) carry per-process counters; scrape every copy.
import { asciiJson } from "./util.js";

const counters = new Map([
  ["events_accepted_total", 0],
  ["events_rejected_total", 0],
  ["auth_failures_total", 0],
  ["database_errors_total", 0],
  ["rate_limits_total", 0],
]);

export function incrementCounter(name) {
  counters.set(name, (counters.get(name) || 0) + 1);
}

export function counterValue(name) {
  return counters.get(name) || 0;
}

// Prometheus text exposition, matching the Bun app's /metrics body plus a
// login-throttle key count (the Bun app reports ingest keys instead; the
// sprout has no ingest map, its throttle state lives in auth.js).
export function metricsText(loginRateLimitKeys) {
  const lines = [];
  for (const [name, value] of counters) lines.push(name + " " + value);
  lines.push("login_rate_limit_keys " + loginRateLimitKeys);
  return lines.join("\n") + "\n";
}

export function logLevel() {
  try {
    return env["RISULTA_LOG_LEVEL"] || "info";
  } catch {
    return "info";
  }
}

// One JSON record per response: method, normalized route, status, duration.
// Never includes bodies, headers, IPs, user agents, emails, tokens, or keys.
// Console output reaches stderr unbuffered on standalone builds (0.10.0+);
// set RISULTA_LOG_LEVEL=silent to disable. The timestamp is epoch
// milliseconds (not ISO): `new Date().toISOString()` livelocks this runtime
// inside async handler turns.
export function logRequest(method, route, status, durationMs) {
  if (logLevel() === "silent") return;
  try {
    console.error(asciiJson({
      time_ms: Date.now(),
      type: "request",
      method,
      route,
      status,
      duration_ms: durationMs,
    }));
  } catch {
    /* logging must never break a response */
  }
}

// Normalized route names collapse per-site and per-key identifiers so logs
// stay bounded and key-free, mirroring the Bun app's safeRoute.
export function safeRoute(path) {
  if (/^\/js\/[A-Za-z0-9_-]+\.js$/.test(path)) return "/js/:key.js";
  if (/^\/api\/event\/[A-Za-z0-9_-]+$/.test(path)) return "/api/event/:key";
  if (/^\/api\/sites\/\d+\/stats$/.test(path)) return "/api/sites/:id/stats";
  if (/^\/api\/sites\/\d+\/report$/.test(path)) return "/api/sites/:id/report";
  if (/^\/api\/sites\/\d+\/goals$/.test(path)) return "/api/sites/:id/goals";
  if (/^\/sites\/\d+\/partials\/live$/.test(path)) return "/sites/:id/partials/live";
  if (/^\/sites\/\d+$/.test(path)) return "/sites/:id";
  if (/^\/api\/users\/\d+\/delete$/.test(path)) return "/api/users/:id/delete";
  return path;
}
