# Risulta Sprout: single-binary analytics for your own sites

One binary, one data directory, no platform. Sign in, add a website, paste
its tracker snippet, and get pageviews, conversions, attribution and bounded
CSV reports behind a polling dashboard that looks like Risulta: same design
tokens, topbar, metric panels, SVG charts and report cards (server-rendered;
live numbers refresh every 5 seconds, no htmx, no framework). It runs from
`sproutboat build --standalone` output and keeps state in `SB_DATA_DIR`:

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

- Password login with an iterated salted SHA-256 KDF (fresh accounts only;
  scrypt rows from the Bun app are never accepted), expiring sessions,
  CSRF protection, login rate limiting, admin/viewer roles.
- Daily salted visitor hashes (IP + User-Agent, neither stored), per-day
  breakdowns, 30-minute visit boundary, top pages/sources, conversion
  goals with rates, explicit UTC date ranges (at most 366 days).
- Bounded JSON/CSV reports (100 rows max, exact-match filters), generated
  synchronously on request.
- Multiple sites under one binary, per-site tracker snippets (MIT),
  embedded static assets, SQLite state in one directory.

Out, by design:

- Scheduled summaries, alerts and queued exports. No cron, queues or
  background jobs exist standalone.
- Migrating Bun-app users or databases. The KDF differs from scrypt by
  necessity (the sprout runtime has no crypto primitives); the standalone
  product starts with its own accounts.

## Visitor identity and proxies

The collector hashes a daily site salt with the client IP and User-Agent.
The IP is only taken from `X-Forwarded-For` when `RISULTA_TRUST_PROXY=1`,
and your proxy must overwrite that header or any visitor can spoof it.
Behind Caddy:

```caddy
reverse_proxy 127.0.0.1:8099 {
        header_up X-Forwarded-For {http.request.remote.host}
}
```

Direct exposure (trust off) hashes the User-Agent alone: counts keep
working, uniqueness degrades. The dashboard does not report which mode is
on; know your own setup.

## Layout

- `sproutboat.jsonc`: project `risulta-sprout`, one D1 database (`DB`),
  embedded `public/` assets, `vars` and four secrets. No service bindings
  (standalone binaries have no edge).
- `src/index.js`: request router only. Domain rules live in `domain.js`,
  storage in `store.js`, auth in `auth.js`, pages in `views.js`, charts
  in `chart.js`, crypto in `sha256.js`. No `node:` imports anywhere
  in sprout modules.
- `src/sha256.js`: vendored pure-JS SHA-256 (no runtime crypto exists).
  Vectors in `tests/sha256-test.mjs` (`bun sprout/tests/sha256-test.mjs`).
- `public/`: dashboard CSS and dependency-free polling JS (static files,
  not compiled through Porffor).
- `seed.sh`, `verify.sh`: fixture seeding and a 48-assertion boundary
  check against a running binary (both trust modes covered).

## Run it

```sh
sproutboat check sprout                            # validate config + entry
sproutboat dev sprout --port 8080                  # local dev against a broker
sproutboat build sprout --standalone --target host # this machine, for trying it
SB_DATA_DIR=./risulta-sprout.data PORT=8099 ./sprout/dist/risulta-sprout
BASE=http://127.0.0.1:8099 ADMIN_EMAIL=... ADMIN_PASSWORD=... sh sprout/seed.sh
BASE=http://127.0.0.1:8099 ADMIN_EMAIL=... ADMIN_PASSWORD=... EXPECT_TRUST=0 sh sprout/verify.sh
```

`GET /healthz` answers `ok`. The site page at `/sites/<id>` shows the
tracker snippet, live stats, goals and report links.

## Performance

Same-machine loopback ingest (concurrency 25, 5 s): 2.6 MB binary (24x
smaller than the Bun build), 2.7 MB idle RSS, 0.03 s cold start, tracker
byte-identical in spirit (760 B raw). Sustained ingest is ~1,265 RPS at
p50 ~19 ms, about 8x slower than Bun: the runtime serves serially and
each event pays one JS hash plus one D1 round-trip. Full table, method
and caveats in `PROBE-RESULTS.md`; reproduce with `bun sprout/bench.mjs`.

## Operate it

The data directory holds `store.sqlite` and `d1/DB.sqlite` (plus WAL
files). Writable user data lives there, never inside the binary.

```sh
# back up (stop first so the WAL checkpoints cleanly)
kill <pid>  # or systemctl stop risulta-sprout
cp -r /var/lib/risulta-sprout "/var/backups/risulta-sprout-$(date +%F)"

# restore
systemctl stop risulta-sprout
rm -rf /var/lib/risulta-sprout
cp -r /var/backups/risulta-sprout-<date> /var/lib/risulta-sprout
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
on first run and terminate TLS at the proxy.

## Verification

`PROBE-RESULTS.md` records the build matrix and every runtime probe with
actual output. The existing Bun Risulta app is untouched by this branch.
