# Probe results: single standalone Risulta sprout

2026-09-09, branch `sprout/standalone-single`, sproutboat 0.8.0 (0.9.0
available), Porffor alpha-4 toolchain. Scope is the standalone product in
`README.md`: site registration, tracker ingestion, goals, attribution,
polling dashboard, bounded reports (JSON + CSV), embedded static assets.
Login, salted visitor hashes and scheduled jobs are out of scope by design,
not deferred blockers.

## Build matrix

| Check | Result |
| --- | --- |
| `sproutboat check sprout` | PASS: `check passed — risulta-sprout (src/index.js, native-fetch)` |
| `sproutboat build sprout --standalone` (linux-x86_64) | PASS: `built sprout/dist/risulta-sprout (3.0 MB)`, assets baked in |
| `sproutboat build sprout --standalone --target host` (darwin-arm64) | PASS: `built sprout/dist/risulta-sprout (2.3 MB)`, serves on `$PORT` |
| `bun run lint` | PASS (only the two pre-existing `lib/views.js` warnings) |
| `bun run test` (existing Bun app) | PASS: `risulta multi-site self-check OK`, untouched |
| `sh sprout/verify.sh` (25 assertions, fresh state) | PASS: `pass=25 fail=0` |

## Runtime matrix (host binary)

Covered by `sprout/verify.sh` plus manual probes:

| Probe | Result |
| --- | --- |
| `GET /healthz`, favicon 204 | 200 `ok` |
| `POST /api/sites` valid (JSON 201, form 303) | PASS |
| Duplicate domain 409, invalid domain 400 | PASS |
| `GET /js/<key>.js` | 200, tracker body matches `lib/tracker.js`, MIT header kept |
| Unknown site key (`/js/`, `/api/event/`, stats) | 404 |
| `POST /api/event/<key>` valid pageview + conversion | 202 |
| Wrong-domain event 403 before any write | PASS |
| Bad event name / out-of-range value / non-JSON body | 400 |
| Two-site isolation | PASS |
| UTM attribution, junk params dropped, referrer as hostname only | PASS |
| Goals CRUD, duplicate name 409, bad event 400, conversions + value in stats | PASS |
| Stats summary, byDay, top paths/sources, 30-minute visit boundary | PASS |
| Explicit `from`/`to` ranges, reversed range 400, over-366-day range 400 | PASS |
| Bounded report JSON (filters, sort, pagination, total) and CSV download | PASS |
| Embedded assets `/dashboard.js` (JS content type) and `/style.css` | PASS |
| Per-site dashboard page with snippet, goals form, report links, poll root | PASS |
| Same-second post-then-read visibility | PASS (`until = now + 1`; strict `ts < now` excluded same-second rows) |
| Restart persistence (kill, restart, same `SB_DATA_DIR`) | PASS, counts intact |

Two bugs found and fixed during probing:

1. Stats window used strict `ts < now`, hiding same-second events.
   Fix: `until = now + 1`. Keep this rule if the queries are reused.
2. Asset URLs used a `/static/` prefix the bundler does not create (the
   assets directory is the URL root). Fix: serve `/dashboard.js` and
   `/style.css`, fall unknown GETs through to `env.ASSETS.fetch`.

## Out of scope (by design, not deferred)

- Login and multi-user access. No password auth exists, and the sprout
  runtime has no scrypt/`crypto.subtle`. Deployment assumption is
  localhost or a controlled reverse proxy; network access is admin access.
- Salted daily visitor SHA-256. Blocked on `crypto.subtle` (tracked as
  [sproutboat-cli#26](https://github.com/baronunread/sproutboat-cli/issues/26))
  plus trustworthy client metadata (platform #128). The probe uses opaque
  bounded visitor strings; counts are functional, not privacy-preserving.
- Scheduled summaries, alerts and queued exports. No cron, queues or
  background jobs exist standalone; CSV is generated synchronously.
- KV cache: deliberately not added. A cache is admitted only for a measured
  repeated lookup/summary hotspot; none has been observed.

## Notes

- `sprout/dist/` is gitignored (binaries currently on disk); the committed
  surface is `sproutboat.jsonc`, `src/index.js`, `public/`, `seed.sh`,
  `verify.sh`, `README.md`, this file.
