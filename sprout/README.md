# Risulta Sprout (single standalone sprout)

Experimental sibling of the Bun Risulta app, kept as one Sproutboat project
under `sprout/`. The existing server, source and data are untouched.

## Layout

- `sproutboat.jsonc`: project `risulta-sprout`, one D1 database (`DB`),
  embedded static assets (`public/` via `ASSETS`), no service bindings
  (standalone binaries have no edge, so the builder rejects them;
  notification delivery stays a direct module call, per
  `docs/sprout-plan/PLAN.md`).
- `src/index.js`: fetch handler only. HTTP boundary, event validation,
  tracker snippet, D1 repository with per-row `site_id` scoping, goals,
  bounded reports, and polling-friendly stats. No `node:` imports anywhere
  in sprout modules.
- `public/`: dashboard CSS and dependency-free polling JS (static files,
  not compiled through Porffor).
- `seed.sh`, `verify.sh`: fixture seeding and a 25-assertion boundary
  check against a running binary.

## Routes

- `GET /`, `GET /sites/<id>`: server-rendered pages; the site page polls
  `GET /api/sites/<id>/stats` every 5 seconds, pausing in hidden tabs.
- `POST /api/sites`, `GET /api/sites`: register and list websites.
  Browser form posts redirect; JSON posts return 201.
- `POST /api/sites/<id>/goals`, `GET /api/sites/<id>/goals`: conversion
  goals (`eventName` plus optional `path`).
- `GET /js/<key>.js`: per-site tracker (MIT, same behavior as the Bun
  app's `lib/tracker.js`).
- `POST /api/event/<key>`: collector. Validates site key and hostname,
  strips non-UTM query data, persists, answers 202.
- `GET /api/sites/<id>/stats`: summary (30-minute visit boundary),
  per-day rows, top pages/sources, goal conversions. `period=1|7|30` or
  explicit UTC `from`/`to` (YYYY-MM-DD, at most 366 days).
- `GET /api/sites/<id>/report`: bounded report (exact filters, pagination
  to 100 rows) as JSON or `&format=csv` download.

## Probe limits (not product claims)

- Open routes, no login: scrypt password verification and SHA-256 session
  digests have no validated sprout implementation (`crypto.subtle` is absent;
  the prelude only provides `randomUUID`/`getRandomValues`). Launch stays
  blocked until one full supported auth path is proven.
- Opaque `visitor` strings (bounded to 64 chars), not salted daily hashes.
  Never store raw IP/User-Agent; the probe stores neither because it never
  sees them as trustworthy metadata.
- One logical D1, not one SQLite file per site. Every query scopes on
  `site_id`; wrong-domain events are rejected before the write.
- Synchronous bounded CSV export. Queue-based reports, cron summaries and
  alerting are Milestone 2 and need durable scheduling first.

## Run

```sh
sproutboat check sprout
sproutboat dev sprout --port 8080
sproutboat build sprout --standalone            # linux-x86_64 -> sprout/dist/risulta-sprout
sproutboat build sprout --standalone --target host  # this machine, for local runs
SB_DATA_DIR=./risulta-sprout.data ./sprout/dist/risulta-sprout
BASE=http://127.0.0.1:8099 sh sprout/seed.sh    # fixtures
BASE=http://127.0.0.1:8099 sh sprout/verify.sh  # 25-assertion boundary check
```

Standalone keeps its state in `SB_DATA_DIR` (SQLite compiled in, about
3 MB with assets before the app). Writable user data lives there, never
inside the binary.
