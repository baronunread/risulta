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

## Features

- Multi-site, with per-site tracker keys and isolated SQLite storage
- Cookie-free visitor counts (daily-salted hashes, nothing stored raw)
- Goals and funnels, included, not held back for a paid tier
- JSON/CSV report export, plus full HTML report pages
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

## Docs

- [DESIGN.md](DESIGN.md): visual and interaction rules
- [PROBE-RESULTS.md](PROBE-RESULTS.md): build matrix and runtime probes
- [risulta.pages.dev](https://risulta.pages.dev): the pitch, if you want it

## License

Server and dashboard: AGPL-3.0-or-later. The tracker script served from
`/js/<site-key>.js` is MIT, so it's embeddable anywhere (see
[LICENSE-TRACKER](LICENSE-TRACKER)). No open-core split.
