# Risulta Sprout: single-binary analytics for your own sites

One binary, one data directory, no platform, no accounts. You add a website,
paste its tracker snippet, and get pageviews, conversions, attribution and
bounded CSV reports behind a polling dashboard. It runs from `sproutboat
build --standalone` output and keeps state in `SB_DATA_DIR`:

```sh
sproutboat build sprout --standalone            # linux-x86_64 -> sprout/dist/risulta-sprout
SB_DATA_DIR=/var/lib/risulta-sprout PORT=8099 ./sprout/dist/risulta-sprout
```

## Scope: deliberately small

In:

- Multiple sites under one binary, per-site tracker snippets (MIT).
- Collector with domain verification, bounded event validation, UTM
  attribution; junk query parameters are dropped, referrers stored as
  hostnames only.
- Polling dashboard (5-second interval, pauses in hidden tabs), per-day
  breakdowns, top pages/sources, conversion goals with rates.
- Explicit UTC date ranges (at most 366 days) and bounded JSON/CSV reports
  (100 rows max, exact-match filters).
- Embedded static assets; SQLite state in one directory.

Out, by design:

- Login and multi-user access. There is no password auth, and the sprout
  runtime has no scrypt/`crypto.subtle`. Run it on localhost (or behind a
  reverse proxy you control) and treat network access as admin access.
- Salted daily visitor hashes. Visitors are opaque bounded strings the
  tracker sends; counts work, but they are not privacy-preserving hashes.
- Scheduled summaries, alerts and queued exports. No cron, queues or
  background jobs exist standalone; reports are generated synchronously on
  request. If scheduled mail or drop alerts ever matter, that is a hosted
  project with its own design, not a flag on this binary.

## Layout

- `sproutboat.jsonc`: project `risulta-sprout`, one D1 database (`DB`),
  embedded `public/` assets, `vars` only. No service bindings (standalone
  binaries have no edge).
- `src/index.js`: the whole app. Fetch handler, D1 repository with
  per-row `site_id` scoping, no `node:` imports.
- `public/`: dashboard CSS and dependency-free polling JS (static files,
  not compiled through Porffor).
- `seed.sh`, `verify.sh`: fixture seeding and a 25-assertion boundary
  check against a running binary.

## Run it

```sh
sproutboat check sprout                            # validate config + entry
sproutboat dev sprout --port 8080                  # local dev against a broker
sproutboat build sprout --standalone --target host # this machine, for trying it
SB_DATA_DIR=./risulta-sprout.data PORT=8099 ./sprout/dist/risulta-sprout
BASE=http://127.0.0.1:8099 sh sprout/seed.sh       # fixtures
BASE=http://127.0.0.1:8099 sh sprout/verify.sh     # boundary check
```

`GET /healthz` answers `ok`. The site page at `/sites/<id>` shows the
tracker snippet, live stats, goals and report links.

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

Schema changes are additive (`CREATE TABLE IF NOT EXISTS`, `UNIQUE`
goals per site), so a new binary starts against an old data directory.
Keep a backup before upgrading anyway.

Serve it behind Caddy or equivalent for TLS. The standalone server binds
loopback (`http://127.0.0.1:$PORT` in the startup log); confirm that line on
first run and terminate TLS at the proxy.

## Verification

`PROBE-RESULTS.md` records the build matrix and every runtime probe with
actual output. The existing Bun Risulta app is untouched by this branch.
