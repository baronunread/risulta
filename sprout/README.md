# Risulta Sprout: single-binary analytics for your own sites

One binary, one data directory, no platform. Sign in, add a website, paste
its tracker snippet, and get pageviews, conversions, attribution and bounded
CSV reports behind a polling dashboard that looks like Risulta: same design
tokens, topbar, metric panels, SVG charts and report cards (server-rendered;
htmx swaps a live fragment every 5 seconds, no framework, no-JS fallback
shows the same numbers). It runs from
`sproutboat build --standalone` output (requires sproutboat 0.10.3 or later;
0.10.0 is deprecated upstream) and keeps state in `SB_DATA_DIR`:

```sh
sproutboat build sprout --standalone            # linux-x86_64 -> sprout/dist/risulta-sprout
SB_DATA_DIR=/var/lib/risulta-sprout PORT=8099 ./sprout/dist/risulta-sprout
```

## First run

The first administrator comes from secrets (environment for a standalone
binary). They are read only while the user table is empty; remove the
password from the environment afterwards.

```sh
RISULTA_ADMIN_EMAIL=you@example.com \
RISULTA_ADMIN_DISPLAY_NAME='Your name' \
RISULTA_ADMIN_PASSWORD='use-a-long-unique-password' \
SB_DATA_DIR=/var/lib/risulta-sprout PORT=8099 ./sprout/dist/risulta-sprout
```

Open the printed address, sign in, add a website. Administrators see every
site and manage users; viewers are limited to assigned sites.

## Scope: deliberately small

In:

- Password login with an iterated HMAC-SHA-256 KDF (`h1$`, 20k steps),
  expiring sessions, CSRF protection, login rate limiting, admin/viewer
  roles. Bun-app `scrypt$` rows verify through the runtime and are
  re-hashed to `h1$` on next login, so existing users migrate; previous
  standalone `s2$` rows migrate the same way.
- Daily salted visitor hashes (runtime-resolved client IP + User-Agent,
  neither stored), per-day breakdowns, 30-minute visit boundary, top
  pages/sources, conversion goals with rates, funnels over ordered goal
  sequences (bounded to the 50,000 most recent events in range, so counts
  on huge ranges are approximate), previous-period comparison, explicit
  UTC date ranges (at most 366 days).
- Per-IP ingest limiting (240 events per 60 s window via the INGEST
  rate-limit binding), bounded JSON/CSV reports (100 rows max,
  exact-match filters) plus full HTML report pages with filters and
  pagination, generated synchronously on request.
- Website settings pages (tracker snippet, goal and funnel management),
  account profiles with generated avatars and self-deletion with
  last-admin guard, origin-checked login, favicon and webmanifest assets.
- Loopback `/metrics` in Prometheus exposition (same counter names as the
  Bun app) and one JSON request record per response on stderr (neither
  carries bodies, headers, IPs, user agents, or tokens; set
  `RISULTA_LOG_LEVEL=silent` to disable).
- Online backup: `POST /api/backup` (admin) writes an integrity-checked
  snapshot to `backups/` with a row-count manifest, no downtime.
- Multiple sites under one binary, per-site tracker snippets (MIT),
  embedded static assets, SQLite state in one directory.

Out, by design:

- Scheduled summaries, alerts and queued exports. No cron, queues or
  background jobs exist standalone.
- Historical event import from a Bun deployment. Users migrate
  automatically, but past pageviews need a manual SQLite import.

## Visitor identity and proxies

The collector hashes a daily site salt with the client IP and User-Agent.
The IP is the runtime-resolved `request.cf.clientIp`: the connection's
remote address, or the rightmost untrusted `X-Forwarded-For` hop when the
peer matches `SB_TRUSTED_PROXIES` (comma-separated CIDRs or bare IPs).
With the list unset or the peer not in it, `X-Forwarded-For` is ignored
entirely and direct exposure hashes the peer address (better uniqueness
than before, still no stored IPs). Behind Caddy on the same host:

```sh
SB_TRUSTED_PROXIES=127.0.0.1 SB_DATA_DIR=/var/lib/risulta-sprout PORT=8099 ./sprout/dist/risulta-sprout
```

```caddy
reverse_proxy 127.0.0.1:8099 {
        header_up X-Forwarded-For {http.request.remote.host}
}
```

Your proxy must overwrite that header, not append: appenders let a visitor
prepend a fake hop. The dashboard does not report which mode is on; know
your own setup.

## Layout

- `sproutboat.jsonc`: project `risulta-sprout`, one D1 database (`DB`),
  one rate limiter (`INGEST`, 240 events per 60 s per IP), embedded
  `public/` assets, `vars` and three secrets. No service bindings
  (standalone binaries have no edge).
- `src/index.js`: request router only. Domain rules live in `domain.js`,
  storage in `store.js`, auth in `auth.js`, pages in `views.js`, charts
  in `chart.js`, counters and logging in `metrics.js`, generated avatars
  in `avatar.js` (the same blobatar bundle as the Bun app, called with
  `normalize: false` because the runtime has no
  `String.prototype.normalize`; seeds are trimmed and lowercased
  app-side, so names with combining marks render differently across the
  two deployments). No `node:` imports anywhere in sprout modules.
  Hashing and password verification run through the runtime's
  `crypto.subtle` and `crypto.scryptVerify`, so the old vendored SHA-256
  is gone.
- `public/`: Risulta stylesheet, htmx 4 (BSD-0-Clause, vendored from the
  repo's `node_modules` for dashboard polling), and a small glue script
  (tracker copy button, poll status). Static files, not compiled through
  Porffor.
- `seed.sh`, `verify.sh`: fixture seeding and a boundary check against a
  running binary (both trust modes covered, plus metrics, backup with
  manifest, ingest throttle, scrypt migration, comparison, HTML reports,
  settings, funnels, account profile and deletion, origin checks, and
  static assets). Run both
  from the repo root; the scrypt check needs `SB_DATA_DIR` pointing at
  the server's data directory and is skipped otherwise.

## Run it

```sh
sproutboat check sprout                            # validate config + entry (0.10.3+)
sproutboat dev sprout --port 8080                  # local dev against a broker
sproutboat build sprout --standalone --target host # this machine, for trying it
SB_DATA_DIR=./risulta-sprout.data PORT=8099 ./sprout/dist/risulta-sprout
BASE=http://127.0.0.1:8099 ADMIN_EMAIL=... ADMIN_PASSWORD=... sh sprout/seed.sh
SB_DATA_DIR=./risulta-sprout.data BASE=http://127.0.0.1:8099 ADMIN_EMAIL=... ADMIN_PASSWORD=... EXPECT_TRUST=0 sh sprout/verify.sh
```

For `EXPECT_TRUST=1`, start the binary with `SB_TRUSTED_PROXIES=127.0.0.1`.
`GET /healthz` answers `ok`; `GET /metrics` (loopback only, do not proxy
it) exposes the operational counters. The site page at `/sites/<id>` shows
the tracker snippet, live stats, goals and report links. `POST /api/backup`
(admin, CSRF) writes an integrity-checked D1 snapshot to `backups/`.

## Performance

Same-machine loopback ingest (concurrency 25, 5 s): 2.9 MB binary (21x
smaller than the Bun build), 0.09 s cold start, tracker byte-identical
in spirit (760 B raw). Sustained ingest is ~5,024 RPS at p50 ~4.3 ms,
about 2x slower than Bun: the runtime serves serially and each event
pays one C hash plus one cached-statement D1 round-trip plus a serial
write commit. Full table, method and caveats in `PROBE-RESULTS.md`;
reproduce with `bun sprout/bench.mjs` (it rotates test-net source IPs so
the per-IP throttle does not cap the measurement).

## Operate it

The data directory holds `store.sqlite` and `d1/DB.sqlite` (plus WAL
files), with integrity-checked snapshots under `backups/` written by
`POST /api/backup`. Writable user data lives there, never inside the
binary.

```sh
# back up online (admin session): snapshot lands in backups/
curl -X POST http://127.0.0.1:8099/api/backup -b admin.jar -H 'x-csrf-token: ...'
cp -r /var/lib/risulta-sprout/backups /var/backups/risulta-sprout-$(date +%F)

# cold copy also works, but stop first so the WAL checkpoints cleanly
kill <pid>  # or systemctl stop risulta-sprout
cp -r /var/lib/risulta-sprout "/var/backups/risulta-sprout-$(date +%F)"

# restore
systemctl stop risulta-sprout
cp /var/backups/risulta-sprout-<date>/<snapshot-file> /var/lib/risulta-sprout/d1/DB.sqlite
systemctl start risulta-sprout

# upgrade: replace the binary, keep the data directory
install -m 0755 sprout/dist/risulta-sprout /usr/local/bin/risulta-sprout
systemctl restart risulta-sprout
```

Schema changes are additive (`CREATE TABLE IF NOT EXISTS`), so a new
binary starts against an old data directory. Keep a backup before
upgrading anyway.

Serve it behind Caddy or equivalent for TLS. The standalone server binds
loopback (`http://127.0.0.1:$PORT` in the startup log); confirm that line
on first run and terminate TLS at the proxy. On Linux, scale past one
core by running several copies on the same `$PORT` and `SB_DATA_DIR`
(`SO_REUSEPORT` load-balances; WAL plus the runtime write timeout keep
the shared databases safe), fronted by the same proxy.
Serve it behind Caddy or equivalent for TLS. The standalone server binds
loopback (`http://127.0.0.1:$PORT` in the startup log); confirm that line
on first run and terminate TLS at the proxy.

## Verification

`PROBE-RESULTS.md` records the build matrix and every runtime probe with
actual output. The existing Bun Risulta app is untouched by this branch.
