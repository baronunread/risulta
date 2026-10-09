# Risulta

The smallest self-hosted web analytics you can run.

Risulta is a single ~4.7 MB binary. It serves the dashboard, collects
pageviews, and keeps every site in its own SQLite file. No Docker, no
external database, no cookies.

```sh
curl -fsSL https://raw.githubusercontent.com/baronunread/risulta/main/deploy/install.sh | sudo sh
```

That installs (or updates) a systemd service on Debian or Ubuntu, x64 or
arm64, and can configure Caddy for HTTPS. See [`deploy/`](deploy/) for a
manual setup.

For opt-in nightly releases, exact-version installs and unattended update
mode, see [release channels and recovery](deploy/NIGHTLIES.md).

## Features

- Multi-site, with per-site tracker keys and isolated SQLite storage
- Cookie-free visitor counts (daily-salted hashes, nothing stored raw)
- Goals and funnels, included, not held back for a paid tier
- Daily visitor journeys with site-scoped session drilldowns
- JSON/CSV report export, plus full HTML report pages
- Site-scoped bearer keys for read-only stats and report exports
- Password auth, sessions, CSRF, admin/viewer roles
- Online backups: one call, no downtime, integrity-checked manifest
- Prometheus metrics, structured request logging

## Running it

```sh
sproutboat build --standalone            # -> dist/risulta-sprout
SB_DATA_DIR=/var/lib/risulta-sprout PORT=8099 ./dist/risulta-sprout
```

The first admin account comes from `RISULTA_ADMIN_EMAIL` /
`RISULTA_ADMIN_PASSWORD` in the environment, read once while the user table
is empty. Open the printed address and sign in.

## Website navigation

Sites have stable, readable dashboard URLs such as `/sites/shop`. The slug is
assigned from the domain when a site is created or an existing database is
upgraded. Collisions receive a short suffix (`shop-2`); later display-name or
domain changes do not rename existing slugs. Numeric dashboard bookmarks
redirect to the canonical slug. API routes continue to use numeric site IDs.

The site tabs are Overview, Reports, Journeys, Goals and Funnels. Tracker code
copies directly to the clipboard from the button beside the Overview title. Goals and Funnels each show their
results and, for administrators, a creation form. Previous settings and
conversions bookmarks redirect to Goals (funnel validation errors redirect to
Funnels). Date ranges and visitor filters carry between tabs and form returns.

The schema upgrade adds nullable `sites.slug`, backfills existing sites and
creates the unique `idx_sites_slug` index. Existing event data, site IDs and
tracker keys remain unchanged.

## Read API keys

An administrator can create a read-only key for a site with
`POST /api/sites/<site-id>/read-keys`, using the signed-in session and its
CSRF token (`X-CSRF-Token`). The response includes the secret once. Store it
securely, since only its hash is retained and it cannot be retrieved later.
`GET` on the same endpoint lists key IDs and creation times. Revoke a key with
`POST /api/sites/<site-id>/read-keys/<key-id>/revoke`, also with a session and
CSRF token.

Use a key only for `GET /api/sites/<site-id>/stats` and
`GET /api/sites/<site-id>/report` by sending it as an Authorization bearer
token. Each key is limited to its site. Date ranges are capped at 366 days;
report pages are capped at 100 rows with offsets capped at 10,000. Keys in
query parameters are not accepted.

## Docs

- [DESIGN.md](DESIGN.md): visual and interaction rules
- [PROBE-RESULTS.md](PROBE-RESULTS.md): build matrix and runtime probes
- [risulta.pages.dev](https://risulta.pages.dev): the pitch, if you want it

## License

Server and dashboard: AGPL-3.0-or-later. The tracker script served from
`/js/<site-key>.js` is MIT, so it's embeddable anywhere (see
[LICENSE-TRACKER](LICENSE-TRACKER)). No open-core split.

### Backup scheduling and stress preview

Administrators can open `/backups` to create snapshots, choose a manual/daily/weekly schedule and set UTC time and scheduled-copy retention. Automatic backups run from the Risulta executable every minute; the page shows scheduler status. See [backup and recovery instructions](public/backup-setup.txt). Manual snapshots are kept separately from scheduled retention. Snapshots stay on the server, so keep an off-server copy as well.

The [UI stress report](performance/2026-10-06-ui-stress/README.md) covers the million-event local dataset, before/after screenshots, backup restoration and remaining performance limits. To generate disposable preview traffic, use `python3 scripts/stress-seed.py --data-dir /tmp/risulta-stress-your-preview --events 1000000` after initializing a standalone demo instance. The script refuses production directories and repeat runs.

Demo websites use distinct recent traffic profiles: growth, decline, steady traffic, campaigns and recovery. To refresh an existing stress-seeded preview, run `python3 scripts/refresh-demo-trends.py --data-dir /tmp/risulta-local-preview-20261006`. This redistributes recent visitor groups while preserving event count and within-group timing. It only accepts marked disposable preview directories.

Daily and hourly rollups accelerate unfiltered Overview, Reports, Goals and
fresh stats/acquisition API reads. Full stats still compute ordered funnels
from raw events. Schema upgrades run
automatically. The binary processes up to four completed days per minute in
a separate maintenance process. Uncovered or changed days fall back to raw events during
backfill. See [upgrade and recovery details](docs/migrations-and-rollups.md).

TypeScript migration and validation commands: [docs/typescript.md](docs/typescript.md).

Stats and acquisition reports cache completed historical results in SQLite for up to 24 hours, surviving restarts. Day/configuration revisions invalidate results on event or goal/funnel changes, including external imports. Live results use a five-second memory cache; current visitor counts remain fresh. Add `fresh=1` to stats/report API requests to bypass caching. See [cache and migration details](docs/migrations-and-rollups.md).

Stats always include traffic totals, current visitors and daily rows. Clients can request just the optional sections they need with `include=traffic`, `include=traffic,hourly`, or a comma-separated combination of `hourly`, `acquisition`, `goals` and `funnels`. Omitting `include` retains the complete existing response. Unknown sections return 400. `fresh=1` also bypasses historical component caching.

Administrators can add `trace=1` to stats or JSON report API requests for native query timings, SQLite plans and `Server-Timing` headers. Tracing bypasses caches. See [the native trace report](performance/2026-10-07-query-tracing/README.md) for measurements and usage.

## Stable v0.1.8

v0.1.7 replaced the withdrawn build with rollups and scheduled backups running
from the Risulta binary, without external Python workers. The installer also
requires no Python runtime. See [before/after measurements](performance/2026-10-08-builtin-workers/README.md).

### Command-line updates

The installer creates `/usr/local/bin/risulta` and keeps a private copy of the
installer at `/etc/risulta-sprout/installer.sh`. Run `sudo risulta update` to
update on the saved channel. Use `sudo risulta update --channel stable`,
`sudo risulta update --channel nightly`, or `sudo risulta update --version TAG`
to select a channel or a specific release. The wrapper forwards arguments to
the installer and needs no Python runtime. To refresh the installer itself,
download the current website installer and run it with `--update`.

### Public traffic widgets

Public sharing is off by default. An administrator can enable it for an
individual website under Settings. Widgets expose only the hostname, current
visitor count, pageviews and daily visitor counts for the last seven UTC days.
Visitors across this period are the sum of daily visitor counts, matching the
cookie-free daily identity model. No raw events, paths or visitor identities
are public. Disable sharing to revoke the endpoint immediately; existing
embeds clear their data at their next refresh.

```html
<script async src="https://your-risulta-host/widget.js"
  data-site="YOUR_TRACKER_KEY" data-size="wide" data-theme="auto"></script>
```

Sizes: `small`, `medium`, `wide`. Themes: `light`, `dark`, `auto` (the embedding
page's `dark` class or `data-theme` attribute). Frames poll every 60 seconds,
update in place, pause while hidden or offscreen, and refresh on return.
Snapshots are cached for 30 seconds with at most 64 entries. Public endpoints
are limited to 120 requests per IP per minute and 1,200 requests per instance
per minute, with bounded limiter state. Failed refreshes retain the last
result and show delayed status. The aggregate JSON endpoint is
`/public/data/YOUR_TRACKER_KEY` and supports anonymous cross-origin reads.
