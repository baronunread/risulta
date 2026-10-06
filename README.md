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

Administrators can open `/backups` to create snapshots, choose a manual/daily/weekly schedule and set UTC time and scheduled-copy retention. Automatic backups require the included [server runner and timer setup](public/backup-setup.txt); the page shows whether the runner is connected. Manual snapshots are kept separately from scheduled retention. Snapshots stay on the server, so keep an off-server copy as well.

The [UI stress report](performance/2026-10-06-ui-stress/README.md) covers the million-event local dataset, before/after screenshots, backup restoration and remaining performance limits. To generate disposable preview traffic, use `python3 scripts/stress-seed.py --data-dir /tmp/risulta-stress-your-preview --events 1000000` after initializing a standalone demo instance. The script refuses production directories and repeat runs.
