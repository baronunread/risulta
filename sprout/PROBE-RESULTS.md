# Probe results: single standalone Risulta sprout

2026-09-11, branch `sprout/standalone-single`, sproutboat **0.10.3**
(retested after the 0.9.0 -> 0.10.3 bump; 0.10.0 brought the
crypto/ratelimit/cf surface, 0.10.3 adds the rate-limiter `resetAt`).
Scope is the standalone product in `README.md`: password login with
admin/viewer roles, tracker ingestion with daily salted visitor hashes,
goals, funnels, attribution, comparison mode, polling dashboard, bounded
reports (JSON + CSV + HTML pages), settings pages, account profiles,
per-IP ingest limiting, `/metrics`, request logs, online backup with
manifest, embedded static assets. No scheduling exists standalone (no
cron/queues/alarms); summaries and exports run on request.

## Build matrix

| Check | Result |
| --- | --- |
| `bun sprout/tests/daystring-test.mjs` | PASS: 2011 cases (epoch, leap days/centuries, 2000 random dates) for the integer day-label math that replaces `toISOString` |
| `sproutboat check sprout` | PASS: `check passed — risulta-sprout (src/index.js, native-fetch)` |
| `sproutboat build sprout --standalone` (linux-x86_64) | PASS: `built sprout/dist/risulta-sprout (3.6 MB)`, assets baked in |
| `sproutboat build sprout --standalone --target host` (darwin-arm64) | PASS: `built sprout/dist/risulta-sprout (2.9 MB)`, serves on `$PORT` |
| Boot with no secrets set | PASS (optional reads still work; only declared secrets gate boot) |
| `bun run lint` | PASS (only the two pre-existing `lib/views.js` warnings) |
| `bun run test` (existing Bun app) | PASS, untouched |
| `sh sprout/verify.sh` (80 assertions, fresh state) | PASS: `pass=80 fail=0` with `EXPECT_TRUST=0` and again with `EXPECT_TRUST=1` |

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
| Funnels CRUD, step validation, foreign-goal rejection, conversions | PASS |
| Previous-period comparison label on `?compare=1` | PASS |
| Full HTML report page (tabs, filters, table, pagination, CSV link) | PASS |
| Website settings page (tracker, goals, funnel management) | PASS |
| Account profile update, duplicate-email 409, self-deletion | PASS |
| Cross-origin login 403 (host comparison) | PASS |
| Favicon and webmanifest served publicly | PASS |
| Stats summary, byDay, top paths/sources, 30-minute visit boundary | PASS |
| Explicit `from`/`to` ranges, reversed range 400 | PASS |
| Bounded report JSON and CSV download | PASS |
| Users page (admin), viewer creation, deletion and self/last-admin guards | PASS |
| Password change revokes other sessions, old password dies, restore works | PASS |
| Bun `scrypt$` fixture logs in and is re-hashed to `h1$` | PASS (proves user migration) |
| Online backup returns integrity-checked snapshot plus row-count manifest; CSRF/viewer guards | PASS |
| Ingest throttle 429s after 240 events per 60 s window | PASS (throwaway site) |
| Operational counters (`/metrics`, Prometheus exposition) | PASS (5 accepted, 4 rejected on the fixture traffic) |
| Logout kills the session; static assets stay public | PASS |
| Visual parity with the Bun app (login, sites, dashboard, users pages) | PASS, screenshot-compared in browser dark mode |
| htmx 4 polling (fragment swap, live update without reload) | PASS, proven in browser (3→4 pageviews on event) |
| Restart persistence | PASS (previous commit; schema additive since) |

## Runtime findings (upstream-worthy)

1. Stats window used strict `ts < now`, hiding same-second events.
   Fix: `until = now + 1`. Keep this rule if the queries are reused.
2. Asset URLs must not use a `/static/` prefix: the assets directory is the
   URL root. Unknown GETs fall through to `env.ASSETS.fetch`.
3. Status **303** works on 0.10.2 (fixed upstream as
   [sproutboat#156](https://github.com/baronunread/sproutboat/issues/156),
   root-caused to Porffor's embedded `lookup_status_line()` missing
   `case 303`). The app is back to 303 POST-redirect-GET like the Bun app;
   the 302 era is over. The companion 302 + Set-Cookie failure was fixed
   by 0.9 with no open issue.
4. Async handlers must resolve to plain values: an async function doing a
   bare `return <promise>` never resolves (no promise adoption). Every
   helper here awaits before returning; the top-level fetch returns its
   own promise directly with no `.then()` chaining (that shape hangs).
5. `new Date().toISOString()` livelocks the runtime when called inside
   async handler turns (100% CPU, permanent, nondeterministic onset after
   a few requests). Bisected to a minimal trigger and filed as
   [sproutboat#168](https://github.com/baronunread/sproutboat/issues/168).
   Workarounds in this tree: log timestamps are epoch millis via
   `Date.now()`, and day labels use integer civil-date math in
   `src/util.js` (`dayStringFromMs`, 2011 bun-checked cases). The
   collector called `toISOString` on every event, so this was a
   production blocker, not a cosmetic dodge.
6. `x-sb-cpu-ms` never appears on the wire, even for synchronously
   returned string-body responses. The prelude stamps it only for sync
   returns (this router always returns a promise), and observation
   suggests the tag does not fire regardless. Noted on #168; per-request
   durations come from the app's own stderr logs instead.
7. `sproutboat build` succeeded while printing `"url" has already been
   declared` for a duplicate `const` (a hard SyntaxError everywhere
   else) and still wrote dist output. Noted on #168; a build should fail
   loudly here instead of shipping a silently reinterpreted bundle.

## Performance (same machine, same workload, 2026-09-11)

Loopback ingest, concurrency 25, 5 seconds, one site, identical event
bodies. The bench spawns the binary with `SB_TRUSTED_PROXIES=127.0.0.1`
and rotates 512 test-net `X-Forwarded-For` addresses: the INGEST binding
limits per IP (240/60s like production), so the rotation keeps the
aggregate quota far above what 5 seconds can spend and the number measures
server capacity, not the throttle. Bun ran with
`RISULTA_INGEST_RATE_LIMIT=1000000` (its default 240/min 429s the
benchmark itself).

| | Bun `./risulta` (main code) | Sprout standalone (this branch) |
| --- | --- | --- |
| Binary | 62.5 MB | 2.9 MB (21x smaller) |
| Idle RSS | 21.8 MB | not re-measured (2.7 MB on 0.9.0) |
| Cold start to ready | 0.15 s | 0.09 s (88 ms measured; +~0.1 s once when admin bootstrap hashes) |
| Ingest | 10,012 RPS | 5,024 RPS (0.10.2; 1,265 on 0.9.0) |
| Latency p50/p95/p99 | 1.98 / 4.73 / 6.99 ms | 4.29 / 8.21 / 11.39 ms |
| RSS after load | 89.9 MB | 65 MB |
| Tracker raw / gzip | 752 / 479 B | 760 / 489 B (8 B is the longer public key) |

The 0.9.0 -> 0.10.2 jump (1,265 to 5,024 RPS) is the embedded prepare
cache plus C hashing: daily-salt cache, once-per-process
schema/bootstrap, immutable site-key cache, one C digest per event, one
cached-statement D1 round-trip. The remaining gap is still structural:
Little's law holds exactly (5,024 RPS x ~4.3 ms ~= 25 in flight), so the
Porffor server handles requests serially while Bun overlaps 25 concurrent
fsyncs. At 5,024 RPS the sprout clears ~400M events/day on loopback.

Honest caveats: ingest is ~2x slower than Bun (was ~8x); loaded RSS is
lower than Bun now (65 vs 90 MB); multi-core needs the documented
`SO_REUSEPORT` multi-process recipe (macOS does not load-balance it, so
scale only on the Linux deploy target).

Decomposition of the remaining gap: the HTTP layer does ~9.5k serial RPS,
the per-event floor is now one C digest plus one cached-statement D1
round-trip plus a serial write commit, and Little's law shows the p50 is
queueing behind 25 in flight. Bun wins by overlapping 25 concurrent
fsyncs and calling SQLite natively. Nothing left to cache app-side; the
open runtime items are batch commits (a durability tradeoff) and
execution-model concurrency, tracked as
[sproutboat#155](https://github.com/baronunread/sproutboat/issues/155)
follow-ups and
[#154](https://github.com/baronunread/sproutboat/issues/154)
(documented as the model, with the `SO_REUSEPORT` recipe).

## Out of scope (by design, not deferred)

- Scheduled summaries, alerts and queued exports. Nothing standalone runs
  unattended; if that ever matters it is a hosted project, not a flag here.
- Migrating Bun-app users: solved for credentials. Bun `scrypt$` rows
  verify through the runtime's verify-only scrypt and are re-hashed to
  the current `h1$` KDF on next login (proven in `verify.sh`); previous
  standalone `s2$` rows migrate the same way. Historical events still
  need a manual SQLite import. New credentials use iterated
  HMAC-SHA-256 (`h1$`, count encoded per row) with constant-time
  comparison via `subtle.verify`.
- KV cache: deliberately not added. A cache is admitted only for a measured
  repeated lookup/summary hotspot; none has been observed.
- `crypto.subtle` is now used directly (digest for visitor hashes and
  session tokens, HMAC for the password KDF, `scryptVerify` for Bun
  rows); the vendored SHA-256 is deleted. `subtle` is async-only, so the
  router is async end to end and every helper resolves to a plain value
  (a bare `return <promise>` from an async function never resolves
  here).

## Notes

- `sprout/dist/` is gitignored (binaries currently on disk); the committed
  surface is `sproutboat.jsonc`, `src/`, `public/`, `tests/`, `seed.sh`,
  `verify.sh`, `README.md`, this file.
