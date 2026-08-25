# Risulta engineering priorities

Risulta is a completely open-source, privacy-friendly analytics server for
multiple websites. It stays one deployable Bun-compiled executable and uses
SQLite only. Warren is not part of the current architecture.

Ground rules:

- One process, one port, one binary, zero runtime dependencies.
- One login may access multiple websites; every analytics query is site-bound.
- `control.db` owns users, sessions, sites, and permissions. Each site has an
  independent SQLite database under `sites/`.
- No open-core split, proprietary assets, hidden telemetry, or hosted-only
  features. Server/dashboard license: AGPL-3.0-or-later. Tracker: MIT.
- Keep the browser tracker below 1 KB and the dashboard server-rendered.
- Scale SQLite with indexes, bounded raw retention, and incremental rollups,
  not an embedded OLAP engine such as chDB.

## M0: trackable proof of concept ✅

- [x] Cookie-free pageviews, referrers, SPA navigation, and daily anonymous
      visitor hashes.
- [x] WAL-mode SQLite, dashboard periods, current visitors, top pages/sources.
- [x] Accessible zero-JavaScript dashboard and a Bun-compiled executable.

## M1: authentication and multi-site isolation ✅

This is the top production priority and must remain protected by end-to-end
tests as the product evolves.

- [x] Environment-bootstrapped administrator and scrypt password hashes.
- [x] Opaque, expiring, HttpOnly, SameSite sessions stored by token hash.
- [x] CSRF tokens plus same-origin checks for state-changing forms.
- [x] Failed-login rate limiting and security response headers.
- [x] Administrator and viewer roles; viewers can be limited to selected sites.
- [x] Multiple websites under one login and one process.
- [x] Per-site tracker keys, domain verification, SQLite files, and dashboards.
- [x] Tests prove anonymous redirect, admin boundaries, two-site isolation,
      spoof rejection, viewer permissions, and restart persistence.

## M2: deployable on one VPS ✅

- [x] `/healthz`, clean SIGTERM, Caddy example, hardened systemd unit, and
      documented first-server installation.
- [x] Source and compiled executable run the same end-to-end suite.
- [x] Tracker byte budget: 638 B raw / 441 B gzip at the current revision.
- [x] Bounded LRU cache for open site databases (32 by default).
- [x] Mobile dashboard checked at 390 px; WCAG A/AA automated audit clean.

## M3: production durability (next)

- [ ] SQLite online backup command and documented restore drill.
- [ ] Schema migration framework with fixtures for every released version.
- [ ] Session revocation UI, password changes, and administrator recovery.
- [ ] Configurable trusted-proxy CIDRs rather than a single trust switch.
- [ ] Structured request/error logs and basic operational counters.
- [ ] Graceful overload behavior and explicit per-IP ingest limits.

## M4: sustained analytics performance

- [ ] Benchmark a release build on representative VPS hardware: ingest RPS,
      p50/p95/p99 latency, dashboard latency, RSS, and disk growth.
- [ ] Incremental daily/hourly rollups and bounded raw-event retention.
- [ ] Cache dashboard summaries without weakening site isolation.
- [ ] Define load targets before optimizing: one site burst, many active sites,
      and a long-tail site set sharing one process.
- [ ] Add a reproducible benchmark command and publish results with machine,
      dataset, and concurrency details.

## Deliberate non-goals for now

chDB or an external database, organizations/teams beyond admin and viewer,
custom funnels, GeoIP databases, realtime websockets, and Warren integration.
