// HTTP details of the public collector endpoint (POST /api/event/:key).

// The tracker runs on customer sites, so every collector response (accepted or
// rejected) must be readable cross-origin. Without this header browsers log a
// CORS error for each beacon even though the event itself is recorded. The
// endpoint is cookieless and credential-free, so a wildcard origin is safe.
export const INGEST_CORS = { "access-control-allow-origin": "*" };

// Preflight answer for callers that send a non-simple request (for example
// Content-Type: application/json). The bundled tracker uses text/plain and
// never preflights, but custom integrations may.
export function ingestPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    },
  });
}

// Logs which hostname sent events for a site it does not belong to, so the
// operator can spot mirrors and scrapers. Only the claimed hostname is logged,
// never the IP, user agent, path or anything else about the visitor. Each
// (site, hostname) pair is logged at most once per window, and the memory used
// is bounded.
const MISMATCH_WINDOW_MS = 3600000;
const MISMATCH_MAX_ENTRIES = 1000;
// The claimed hostname is client-supplied, so anything that is not a plain
// hostname is logged as a placeholder rather than echoed.
const SAFE_HOSTNAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

export function createDomainMismatchLogger(write, windowMs, maxEntries) {
  const window = windowMs || MISMATCH_WINDOW_MS;
  const max = maxEntries || MISMATCH_MAX_ENTRIES;
  const seen = new Map();
  return function logDomainMismatch(siteDomain, hostname, now) {
    const key = siteDomain + "\n" + hostname;
    const last = seen.get(key);
    if (last !== undefined && now - last < window) return false;
    if (seen.size >= max) {
      for (const [k, t] of seen) if (now - t >= window) seen.delete(k);
      if (seen.size >= max) seen.delete(seen.keys().next().value);
    }
    seen.set(key, now);
    write(JSON.stringify({ time_ms: now, type: "domain_mismatch", site: siteDomain, got: SAFE_HOSTNAME.test(hostname) ? hostname : "(invalid)" }));
    return true;
  };
}
