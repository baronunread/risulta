# Risulta

Risulta is completely open-source, privacy-friendly web analytics for multiple
websites. One login, one process, one SQLite-based data directory, and one
Bun-compiled executable provide the whole product. The dashboard is
server-rendered and the tracked websites receive no cookies.

## Run from source

Requires [Bun](https://bun.sh/).

```sh
RISULTA_ADMIN_EMAIL=you@example.com \
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

Back up the entire `DATA_DIR`, including `control.db` and `sites/`. SQLite's
online backup API is planned for zero-downtime snapshots; until then, stop Risulta
briefly or use a SQLite-aware backup tool rather than copying active database
files individually.

## Deploy on a Debian/Ubuntu VPS

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
| `RISULTA_ADMIN_PASSWORD` | unset | First administrator password (12+ characters) |
| `RISULTA_SITE_DOMAIN` | `legacy.local` | Domain assigned when migrating an old one-site database |

Risulta recognizes an old `DATA_DIR/risulta.db` or pre-rename `hutch.db` on first
startup, checkpoints it, moves it into the per-site directory, and creates a
matching website entry.

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
