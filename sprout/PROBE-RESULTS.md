# Probe results: single standalone Risulta sprout

2026-09-10, branch `sprout/standalone-single`, sproutboat 0.8.0 (0.9.0
available), Porffor alpha-4 toolchain. Scope is the standalone product in
`README.md`: password login with admin/viewer roles, tracker ingestion with
daily salted visitor hashes, goals, attribution, polling dashboard, bounded
reports (JSON + CSV), embedded static assets. No scheduling exists
standalone (no cron/queues/alarms); summaries and exports run on request.

## Build matrix

| Check | Result |
| --- | --- |
| `bun sprout/tests/sha256-test.mjs` | PASS: 4 NIST vectors + utf8 smoke (one remembered vector was 3 chars short; fixed against WebCrypto) |
| `sproutboat check sprout` | PASS: `check passed — risulta-sprout (src/index.js, native-fetch)` |
| `sproutboat build sprout --standalone` (linux-x86_64) | PASS: `built sprout/dist/risulta-sprout (3.2 MB)`, assets baked in |
| `sproutboat build sprout --standalone --target host` (darwin-arm64) | PASS: `built sprout/dist/risulta-sprout (2.5 MB)`, serves on `$PORT` |
| `bun run lint` | PASS (only the two pre-existing `lib/views.js` warnings) |
| `bun run test` (existing Bun app) | Untouched (still passing from the previous commit; no app code changed since) |
| `sh sprout/verify.sh` (48 assertions, fresh state) | PASS: `pass=48 fail=0` with `EXPECT_TRUST=0` and again with `EXPECT_TRUST=1` |

## Runtime matrix (host binary)

Covered by `sprout/verify.sh`:

| Probe | Result |
| --- | --- |
| Bootstrap admin from secrets; anonymous HTML redirects to login, API 401s | PASS |
| Wrong password 401, rate limit 429 after 5 failures | PASS |
| Admin login, session role, CSRF-gated writes (403 without token) | PASS |
| Login cost ~0.5s per attempt (20k-iteration KDF in the Porffor build) | Measured, accepted |
| `POST /api/sites`, duplicate 409, invalid 400, viewer create 403 | PASS |
| Tracker serves, unknown keys 404, collector stays public (202) | PASS |
| Wrong-domain event 403, bad name/value/body 400 | PASS |
| Two-site isolation, including viewer scoped to one site (404 on the other) | PASS |
| Same-UA repeat visits share one identity; XFF ignored untrusted, honored trusted | PASS (2 vs 3 visitors) |
| UTM attribution, junk params dropped, referrer as hostname only | PASS |
| Goals CRUD, duplicate 409, conversions + value in stats | PASS |
| Stats summary, byDay, top paths/sources, 30-minute visit boundary | PASS |
| Explicit `from`/`to` ranges, reversed range 400 | PASS |
| Bounded report JSON and CSV download | PASS |
| Users page (admin), viewer creation, deletion and self/last-admin guards | PASS |
| Password change revokes other sessions, old password dies, restore works | PASS |
| Logout kills the session; static assets stay public | PASS |
| Visual parity with the Bun app (login, sites, dashboard, users pages) | PASS, screenshot-compared in browser dark mode |
| Restart persistence | PASS (previous commit; schema additive since) |

## Runtime findings (upstream-worthy)

1. Stats window used strict `ts < now`, hiding same-second events.
   Fix: `until = now + 1`. Keep this rule if the queries are reused.
2. Asset URLs must not use a `/static/` prefix: the assets directory is the
   URL root. Unknown GETs fall through to `env.ASSETS.fetch`.
3. The runtime cannot serialize status **303**: every 303 shape (empty,
   body, cookie) resets the connection. Mapped with a one-build probe
   (`302`/`307`/`201`/`429`/`204` all fine). Worse, **302 + Set-Cookie**
   fails the same way (302 alone and 200 + Set-Cookie both work), which
   broke browser form login into a blank page. The app uses 302 for
   cookie-less navigation and a 200 page with a meta refresh for login
   and logout forms. Filed upstream as
   [sproutboat-cli#27](https://github.com/baronunread/sproutboat-cli/issues/27)
   and [#28](https://github.com/baronunread/sproutboat-cli/issues/28) with
   a one-build repro snippet each.

## Performance (same machine, same workload, 2026-09-10)

Loopback ingest, concurrency 25, 5 seconds, one site, identical event
bodies. Bun ran with `RISULTA_INGEST_RATE_LIMIT=1000000` (its default
240/min 429s the benchmark itself); the sprout has no ingest limiter yet.

| | Bun `./risulta` (main code) | Sprout standalone (this branch) |
| --- | --- | --- |
| Binary | 62.5 MB | 2.6 MB (24x smaller) |
| Idle RSS | 21.8 MB | 2.7 MB (8x smaller) |
| Cold start to ready | 0.15 s | 0.03 s (5x; +~0.5 s once when admin bootstrap hashes) |
| Ingest | 10,012 RPS | 1,265 RPS |
| Latency p50/p95/p99 | 1.98 / 4.73 / 6.99 ms | 18.6 / 33.9 / 42.8 ms |
| RSS after load | 89.9 MB | ~137 MB, flat (no per-request growth) |
| Tracker raw / gzip | 752 / 479 B | 760 / 487 B (8 B is the longer public key) |

Three app-level caches took the sprout from 273 to 1,265 RPS: daily-salt
cache, once-per-process schema/bootstrap, immutable site-key cache. The
remaining gap is structural, not algorithmic: the Porffor server handles
requests serially (~0.8 ms/event floor: one JS SHA-256 plus one D1
round-trip), while Bun parallelizes I/O. At 1,265 RPS the sprout still
clears ~100M events/day on loopback, far past small-product traffic.

Honest caveats: ingest is ~8x slower than Bun; loaded RSS is higher
(retained GC heap after the KDF bootstrap, stable under load); Bun ships
per-IP ingest rate limiting the sprout has not ported.

Decomposition of the ingest gap (serial probes, no queueing): the HTTP
layer itself does ~9.5k serial RPS (0.11 ms), one collector POST costs
~2.7 ms, one 6-select stats GET ~3.9 ms. Raw SQLite on the same file
does sub-millisecond autocommit writes, so the cost is ~0.6 ms per
D1 boundary crossing (JSON-marshalled op out, reply parsed back, no
prepared-statement caching) plus low-single-digit-ms serial write
commits (WAL fsync on macOS). Under 25-way concurrency those serial
costs queue up (Little's law: 1,265 RPS x ~20 ms ~= 25 in flight),
which is the p50; the p99 adds GC pauses and checkpoint stalls. Bun
wins by overlapping 25 concurrent fsyncs and calling SQLite natively.
Nothing left to cache app-side; closing it needs batch commits (a
durability tradeoff) or runtime-side prepare caching and concurrency.

## Out of scope (by design, not deferred)

- Scheduled summaries, alerts and queued exports. Nothing standalone runs
  unattended; if that ever matters it is a hosted project, not a flag here.
- Migrating Bun-app users/databases. The KDF is iterated salted SHA-256
  (`s2$`, count encoded per row), not scrypt: scrypt rows are never
  accepted, and comparison is plain `===` (no constant-time primitive in
  the runtime). Threat model is localhost or a controlled proxy.
- KV cache: deliberately not added. A cache is admitted only for a measured
  repeated lookup/summary hotspot; none has been observed.
- `crypto.subtle` via [sproutboat-cli#26](https://github.com/baronunread/sproutboat-cli/issues/26)
  would let this drop the vendored SHA-256 and use standard primitives, but
  nothing here waits on it.

## Notes

- `sprout/dist/` is gitignored (binaries currently on disk); the committed
  surface is `sproutboat.jsonc`, `src/`, `public/`, `tests/`, `seed.sh`,
  `verify.sh`, `README.md`, this file.
