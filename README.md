# Risulta

Risulta is completely open-source, privacy-friendly web analytics for multiple
websites. One login, one process, one SQLite-based data directory, and one
Bun-compiled executable provide the whole product. The dashboard is
server-rendered and the tracked websites receive no cookies.

## Run from source

Requires [Bun](https://bun.sh/).

```sh
RISULTA_ADMIN_EMAIL=you@example.com \
RISULTA_ADMIN_DISPLAY_NAME='Your name' \
RISULTA_ADMIN_PASSWORD='use-a-long-unique-password' \
bun run dev
```

Open <http://localhost:3000>, sign in, and choose **Add website**. The new
website dashboard contains its permanent tracker snippet.

```sh
bun run test       # multi-site authentication and isolation self-check
bun run build      # writes the single executable to ./risulta
```

Tagged releases publish checksum-protected Linux binaries for x64 and arm64.
The release workflow uses Bun 1.4.0, runs the source and compiled test suites,
and attaches build provenance to each executable.

The compiled executable needs no Bun installation at runtime:

```sh
PORT=3000 DATA_DIR=./data \
RISULTA_ADMIN_EMAIL=you@example.com \
RISULTA_ADMIN_DISPLAY_NAME='Your name' \
RISULTA_ADMIN_PASSWORD='use-a-long-unique-password' \
./risulta
```

The bootstrap credentials are read only when there are no users. After the
first successful start, remove the password from the environment.

## How multi-site storage works

`DATA_DIR/control.db` contains users, sessions, website definitions, and access
rules. Analytics are isolated in `DATA_DIR/sites/<id>.db`, one WAL-mode SQLite
database per website. An administrator sees every website through the same
login and can create viewer accounts limited to selected websites.

Each website receives an unguessable public tracker URL. The public key selects
the website; it is not treated as a secret. Risulta also verifies the hostname
reported by the browser before accepting an event. Daily salted visitor hashes
provide unique counts without retaining IP addresses or allowing visitors to be
linked across days.

## Analytics metric definitions

- **Unique visitor**: one browser identity, derived from the visitor's IP address
  and User-Agent with a random, site-local salt for the current UTC day. Neither
  input is stored.
- **Unique visitor-day**: a unique visitor counted within one UTC day. Seven and
  thirty-day totals use this metric because daily salts intentionally prevent
  people from being linked across days.
- **Visit**: a sequence of pageviews by one daily visitor identity, where a gap
  of more than 30 minutes starts a new visit. A visit spanning midnight starts
  again because the visitor identity resets.
- **Current visitor**: a distinct daily visitor identity with a pageview in the
  last five minutes.

Daily and hourly chart points count unique visitors within their individual UTC
intervals. Never add them together to derive a period total.

## Acquisition attribution

Risulta reads standard `utm_source`, `utm_medium`, `utm_campaign`,
`utm_content`, and `utm_term` parameters from the landing page URL. Attribution
is fixed when a visit starts and remains with subsequent pageviews in that
30-minute visit. Untagged external landings use the referrer's hostname as the
source. Direct visits are reported as **Direct / None**. Values are trimmed and
bounded before storage.

## Custom events

The tracker exposes `window.risulta.track(name, value)`. Event names must use
lowercase letters, numbers, and underscores, begin with a letter, and be at
most 64 characters. `value` is optional and must be a finite number from zero
to 1,000,000,000. Risulta sends the current page context automatically; direct
API callers must provide a path and the configured website domain. Events are
best effort, deduplicated only by the reporting model, and retries can create
another event.

## Reports and API access

The dashboard links to a full report for pages, sources, mediums, campaigns,
and events. Reports support exact filters for `path`, `source`, `medium`,
`campaign`, and `event`, pagination up to 100 rows, and CSV download.

Signed-in users can also request `GET /api/sites/<id>/stats`. It accepts
`period` (`1`, `7`, or `30`), or a UTC `from` and `to` date range up to 366
days, plus `dimension` (`path`, `source`, `medium`, `campaign`, or `event`),
the same exact-match filters, `limit`, `offset`, and `sort` (`visitors`,
`pageviews`, or `value`). The response is JSON with the site, selected range,
unfiltered traffic summary, and bounded report rows. Website access rules apply
to both the API and CSV export.

Back up the entire `DATA_DIR`, including `control.db` and `sites/`. SQLite's
online backup command creates a consistent snapshot without stopping Risulta:

```sh
./risulta backup /var/backups/risulta
```

To test a restore, stop Risulta, move the current data directory aside, copy the
contents of one snapshot into the empty data directory, start Risulta, and sign
in to verify websites and recent events. Keep backups outside `DATA_DIR`; the
command creates one timestamped directory containing `control.db` and `sites/`.

## Deploy on a Debian/Ubuntu VPS

For a guided Debian or Ubuntu installation or update, run:

```sh
curl -fsSL https://raw.githubusercontent.com/baronunread/risulta/main/deploy/install.sh | sudo sh
```

The installer downloads and verifies the latest release, creates the systemd
service, and can configure Caddy for HTTPS.

Build on Linux for the target server, then copy `risulta` and the provided
deployment files:

```sh
bun run build
sudo install -m 0755 risulta /usr/local/bin/risulta
sudo useradd --system --home /var/lib/risulta --shell /usr/sbin/nologin risulta
sudo install -d -m 0750 -o risulta -g risulta /var/lib/risulta /etc/risulta
sudo install -m 0644 deploy/risulta.service /etc/systemd/system/risulta.service
sudo install -m 0600 deploy/risulta.env.example /etc/risulta/risulta.env
```

Edit `/etc/risulta/risulta.env` with the public analytics URL and initial admin
credentials. Replace `analytics.example.com` in `deploy/Caddyfile`, install
Caddy, and then:

```sh
sudo install -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now risulta caddy
curl https://analytics.example.com/healthz
```

When the first administrator exists, remove `RISULTA_ADMIN_PASSWORD` and
`RISULTA_ADMIN_EMAIL` from `/etc/risulta/risulta.env`, then restart Risulta. Caddy
terminates HTTPS and compresses the tracker. Set `RISULTA_TRUST_PROXY_CIDRS` to
the IP ranges of proxies that connect directly to Risulta, so it can safely use
their forwarding headers for anonymous daily visitor counts.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Local HTTP port |
| `HOST` | `0.0.0.0` | Listen address; use `127.0.0.1` behind Caddy |
| `DATA_DIR` | `.` | Durable databases and site directory |
| `RISULTA_BASE_URL` | request origin | Public HTTPS URL used in tracker snippets |
| `RISULTA_TRUST_PROXY_CIDRS` | unset | Comma-separated CIDRs allowed to supply forwarding headers |
| `RISULTA_TRUST_PROXY` | unset | Deprecated compatibility switch, trusts loopback proxies only |
| `RISULTA_MAX_OPEN_SITES` | `32` | LRU limit for simultaneously open site databases |
| `RISULTA_INGEST_RATE_LIMIT` | `240` | Maximum accepted analytics events per IP address per minute |
| `RISULTA_ADMIN_EMAIL` | unset | First administrator email |
| `RISULTA_ADMIN_DISPLAY_NAME` | unset | First administrator display name |
| `RISULTA_ADMIN_PASSWORD` | unset | First administrator password (12+ characters) |

## Database migrations

Risulta applies numbered SQLite migrations at startup, independently for the
control database and every website database. A migration runs once in a SQLite
transaction and records its version with `PRAGMA user_version`. Keep a recent
snapshot before upgrading, then verify the migration through the normal startup
and dashboard checks.

## Performance baseline

Run `bun run build && RISULTA_BENCH_BINARY=./risulta bun run bench` on the target
server. The benchmark creates temporary data, warms the process, and reports
ingest throughput, latency percentiles, post-load RSS, and tracker size.

On the current Apple Silicon development machine, the compiled binary accepted
8,199 events/second at concurrency 25 over five seconds: p50 2.57 ms, p95
5.52 ms, p99 7.66 ms, and 83.9 MB RSS after load. The keyed tracker is currently
638 bytes raw and 441 bytes gzip. This is a loopback baseline, not a VPS capacity
promise; disk, CPU, TLS, traffic shape, dashboard queries, and retention all
matter. Re-run it on the actual VPS before setting production limits.

## License

Risulta's server and dashboard are licensed under AGPL-3.0-or-later. The browser
tracker returned from `/js/<site-key>.js` is licensed under MIT so it can be
embedded on any website. There is no open-core or proprietary edition.

Visual rules live in [DESIGN.md](DESIGN.md); engineering priorities live in
[PLAN.md](PLAN.md).
