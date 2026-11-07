# Risulta as a hosted SaaS (risulta.dev) on Sproutboat Cloud

Status: plan, 2026-11-08. No app code changes in this PR.
Decision (2026-11-08): **shared multi-tenant**, like Plausible. One Risulta app serves every customer, tenant isolation is enforced in app code, and hosted and self-hosted stay **one codebase** (AGPL-3.0, no open-core split).

Tags: **[M]** measured for this plan (Apple M1, macOS 15.3.1, Bun 1.4.4, standalone build of `cbfab15`, sproutboat 0.15.0, embedded SQLite, not Cloud), **[R]** read from the repo or the platform docs, **[E]** estimate or proposal. Nothing tagged [E] has been measured. Scripts for [M] numbers: `performance/2026-11-08-saas-baseline/`.

## 0. What the app is today (facts that shape the plan)

- One D1 database (`DB`), every site-owned row carries `site_id`, every query is written by hand with `WHERE site_id = ?` [R]. About 165 `prepare()`/`exec()` lines across `src/` (51 in `store.js`, 30 in `index.js`) [M, `rg -c`].
- Users have a **global** role (`admin` or `viewer`). An admin sees every site in the database; a viewer sees the sites in `site_users` [R: `listSitesForUser`, `getSiteForUser`, `homeOverviews`].
- Ingest: `POST /api/event/:key`, key to site via an in-process cache, per-IP `INGEST` limiter (240/60 s), one INSERT, visitor = daily salted SHA-256 of IP + UA [R].
- Events table carries **6 secondary indexes and 2 trigger families** (rollup dirty marker, cache revision) [R].
- Every-minute cron forks and execs the **same binary** as a maintenance child, which runs the scheduled backup (`db.backup()` to a file) and up to 4 rollup site-days [R].
- State kept in process memory: login failure counters, site-key cache, salt cache, two analytics caches of up to 128 entries each with payloads up to 262,144 characters [R].
- No email code exists. Users are created by an admin with a password [R: `rg -i mail src/` finds only `normalizeEmail`].

Platform facts used below (Sproutboat Cloud closed alpha): 32 MiB per app, 2 s CPU and 30 s wall per request ([R] `web/src/data/limits.ts`: per-app storage and egress limits are **not enforced yet**), per-account SQLite shard on the app host, LTX backups RPO 60 s / RTO 4 h on host loss (given), bindings `kv d1 r2 queue do ae ratelimit assets secret service` with **no email binding** [R: `sproutboat-cloud/docs/phase1-design.md`], outbound fetch goes through an egress service that blocks private ranges [R: `cloud-plan-2026-09-09.md`].

## 1. Tenancy model

### 1.1 Schema (migration 8, additive, one PR)

```
orgs         (id, slug UNIQUE, name, plan, status, created_at)
memberships  (org_id, user_id, role CHECK IN ('owner','admin','viewer'), PRIMARY KEY (org_id, user_id))
invitations  (id, org_id, email, role, site_ids, token_hash UNIQUE, expires_at, accepted_at, invited_by)
email_tokens (token_hash PRIMARY KEY, user_id, kind CHECK IN ('verify','reset'), expires_at, used_at)
users        + email_verified_at, + disabled_at        (role column kept, ignored when hosted)
sites        + org_id NOT NULL; UNIQUE (org_id, domain); UNIQUE (org_id, slug)   (replaces global UNIQUE on domain and slug)
sessions     + active_org_id, + last_seen
site_users   unchanged: a viewer is limited to the sites listed here
```

- **Roles.** `owner` (plan, delete org), `admin` (members, sites, keys, goals; today's admin), `viewer` (read-only on `site_users` sites; today's viewer). A user can belong to several orgs; the session carries the active org and `/sites/:slug` resolves inside it, so URLs do not change.
- **Why `(org_id, domain)` and `(org_id, slug)` instead of global unique.** Today a second tenant adding `shop.com` gets "domain already registered" and a slug `shop-2`: both leak that another tenant exists and let anyone squat a domain. The tracker key, not the domain, identifies the site at ingest, so duplicates across orgs are harmless. The collector's domain check stays as a spam filter only (the string is client-supplied).
- **Self-hosted mapping.** Migration 8 creates org 1 (`default`), sets `sites.org_id = 1`, turns the first admin into `owner`, other admins into `admin`, viewers into `viewer` with their `site_users` untouched. `RISULTA_MODE` is `selfhosted` by default: no org switcher, no signup, org UI hidden, behaviour identical to v0.2.2. The migration is additive and the "restore the paired pre-upgrade backup to downgrade" rule in `docs/migrations-and-rollups.md` applies.
- **Hosted mode** (`RISULTA_MODE=hosted`): signup on, org switcher on, operator-only routes closed (section 4.1).

### 1.2 Sign-up, verification, invitations, reset, sessions

| Flow | Design |
| --- | --- |
| Sign-up | Email + password (12+ chars, existing rule). One transaction creates user, org, owner membership. `RISULTA_SIGNUPS=open|invite|closed`; alpha uses `invite` (signup token required). |
| Verify email | Single-use token, 24 h, hashed at rest (`email_tokens`). Unverified users can log in but cannot create a site and their sites do not accept events. |
| Invitations | Admin enters email + role (+ sites for viewers). 7-day single-use link. Accepting requires login or signup with the same email. Self-hosted without a mailer: the link is shown to the admin to copy. |
| Reset | Token 1 h, single use, revokes every session of that user. Same response whether or not the email exists. |
| Sessions | Keep hashed token + CSRF + `__Host-` cookie. Add last-seen, a sessions list with revoke, and revoke-all on password change (already done) and on reset. |
| Abuse limits | Login and signup counters move out of process memory (they reset on every sleep/wake and are per process): use two new `ratelimiters` bindings (`AUTH_IP`, `AUTH_EMAIL`) plus a D1 failure table for lockout. |
| Password hashing | Today an iterated HMAC-SHA-256 chain, 20,000 rounds [R]. That is not memory-hard. The runtime has verify-only `scryptVerify`, no hash side. Needs a Cloud feature (section 6.2) before a public launch; until then raise rounds and accept the risk for invite-only alpha. Login costs about 77 ms [R, `performance/2026-10-06-cli-comparison`: first login 76.6 ms] so a signup burst of 30/s would saturate one core: keep the `AUTH_IP` limiter strict. |

**Email: the platform has none** [R]. Options for Cloud: a `send_email` binding (not planned) or an HTTPS call to a transactional provider through the egress service. Plan: `src/mailer.js` with one `send({to, template, vars})` that does `fetch` to a provider, provider secret via `secrets`, sends through a Queue (`MAIL`) for retry, falls back to inline send when no queue. Needs verifying on Cloud: egress allowlist for the provider host, TLS handshake (BearSSL) to that host, and that a queue consumer can wake a sleeping app. Provider choice (EU region, SPF/DKIM/DMARC on `risulta.dev`, bounce handling) is a decision for the user (section 8).

## 2. Isolation in code

### 2.1 Audit of `src/` (what must change)

| # | Where | Today | Problem when shared | Fix |
| --- | --- | --- | --- | --- |
| 1 | `listSitesForUser`, `getSiteForUser`, `homeOverviews` (`store.js` 89, 121, 201) | `role === 'admin'` returns every site in the DB | **P0 cross-tenant read and write** for any org admin | Rewrite on memberships: org-bounded for all roles |
| 2 | `POST /api/users`, `createUser`, `GET /users`, `account/delete`, `adminCount` | Users and `siteIds` global; `/users` lists all users and all sites; `siteIds` from the client are inserted into `site_users` unchecked | **P0**: admin of org A can grant themselves or others org B sites and list B users | Memberships API; verify every `siteId` belongs to the caller's org |
| 3 | `POST /api/backup`, `/backups`, `/api/backup/settings`, maintenance `runScheduledBackup` | `db.backup()` of the whole database including every tenant and every password hash | **P0** | Hidden and 404 in hosted mode; backups are the platform's LTX; per-org export instead (4.3) |
| 4 | `/api/sites/:id/*` and `/sites/:slug/*` (about 30 routes) | All call `getSiteForUser` first, then pass a **raw numeric `siteId`** to data functions | Safe only while every route remembers the call; one miss is a leak | Opaque `SiteHandle` (2.2) |
| 5 | `POST /api/sites`, `availableSiteSlug` | Global unique domain and slug | Existence leak, squatting | `(org_id, ...)` uniqueness (1.1) |
| 6 | `funnel_steps.goal_id` | FK to `goals(id)` with no site scope; checked only in the route | A missed check links to another tenant's goal | Composite FK `(site_id, goal_id)` or insert via DAL that joins on `site_id` |
| 7 | Read keys (`read-api.js`) | Bound to one site, GET `stats` and `report` only | Safe; keep. Add per-key last-used and an org key cap | Test as an actor in the fuzz suite |
| 8 | Public key paths: `/api/event/:key`, `/js/:key.js`, `/public/*` | Key identifies the site | Safe by design; the rate limiter is per IP only | Add per-site limiter (4.2) |
| 9 | `/metrics`, `trace=1` | `/metrics` unauthenticated, process-global; `trace` exposes SQL plans to admins | Not tenant data, but must not be public or org-admin reachable | Operator only: `/metrics` off the public host, `trace` needs `RISULTA_OPERATOR` |
| 10 | Analytics caches, rollups, maintenance | Keyed by `site_id`; maintenance is a global job over all sites | Safe. Maintenance must stay a system job with no request identity | Keep outside the DAL, in `src/system/` |
| 11 | In-process maps (`failures`, `siteByKey`, `saltCache`) | Keyed by email or site id | Safe but wrong for multi-instance and sleep (login counters) | 1.2 |
| 12 | Logs (`logDomainMismatch` logs claimed hostnames) | No tenant data beyond claimed hostname | Fine; keep "never IP or UA" rule | None |

Rows 1 to 3 are the hosted blockers; rows 4 to 6 are structural.

### 2.2 Enforcement pattern: a scoped data-access layer

- New `src/data/` is the **only** place allowed to call `db.prepare` for tenant tables. `scope.ts` exports `tenant(db, session)`, which returns `{ orgId, role, sites() , site(idOrSlug) }`. `site()` runs the one membership query and returns a branded `SiteHandle` (`{ readonly __brand: 'site', id }`), constructible only inside `scope.ts`. Every other function in `src/data/` takes a `SiteHandle`, never a number, so a route cannot query a site it did not authorize (the type checker rejects it; repo runs `tsc --noEmit` already).
- Public-key paths use a second constructor, `siteFromKey(db, key)`, also returning a `SiteHandle`. Read keys use `siteFromReadKey`. Maintenance uses `system(db)` which returns handles for all sites and is importable only from `src/system/`.
- Convert `store.js` and the SQL-bearing parts of `index.js` to TypeScript module by module (`docs/typescript.md` already plans this). The 30 `prepare()` calls in `index.js` move behind DAL methods.
- Lint: a custom oxlint rule (the repo has `@oxlint/plugins`) fails on `.prepare(` or `.exec(` outside `src/data/**`, `src/system/**`, `src/migrations.ts`.
- Defense in depth: composite FKs where a child references a tenant row (row 6); `org_id` is **not** denormalised onto `events` (cost: 8 bytes + index space on the hottest table).

### 2.3 Test strategy: prove cross-tenant access fails

1. **Route manifest test.** Enumerate `app.routes` from Hono and compare to `tests/tenancy/routes.json`, where each route is classified `public-key`, `org-scoped`, `operator`, or `static`. A new route that is not classified fails CI. This is what keeps the guarantee as the app grows.
2. **Two-tenant fixture.** Orgs A and B, each with an owner, an admin, a viewer, two sites, goals, funnels, annotations, a read key, a public widget, and events whose paths contain a unique canary (`/canary-B-<random>`).
3. **Exhaustive cross-product.** For every `org-scoped` route x every actor of A (owner, admin, viewer, read key, no session) x every identifier kind of B (site id, slug, goal id, funnel id, annotation id, read-key id, user id, tracker key), substitute B's identifier in the path, query and body. Assert: status is 404 or 403 (never 200), the body contains no B canary, and a hash of B's rows is unchanged after the request.
4. **Property/fuzz layer.** Seeded generator (`fast-check` style, seed printed on failure) that mixes identifiers: A's site with B's goal in a funnel, A's `siteIds` list holding B's sites in `/api/users`, numeric vs slug confusion, `fresh=1`, `include=`, `trace=1`, cache-key reuse across tenants, same domain registered by both orgs, partial HTML routes (`/partials/*`). Runs a few thousand cases per CI run and a larger nightly run.
5. **Canary sweep.** After the whole fuzz run, scan every captured response and every log line for any B canary.
6. **Ingest isolation.** Same key and different `domain`; two orgs with the same domain; both must write only to their own site.
7. **Migration test.** Legacy fixtures (already in `tests/rollup-test.mjs`) upgrade to schema 8 with `selfhosted` behaviour unchanged: existing suite must pass untouched.

## 3. Data scale on one D1 under 32 MiB / 2 s

### 3.1 Measured baseline

| Measurement | Result | Note |
| --- | --- | --- |
| Ingest, concurrency 1 [M] | **3,353 req/s**, p50 0.25 ms, p95 0.35 ms, p99 2.32 ms | `bench.mjs`, 8 s, loopback, 256 rotating IPs, standalone binary |
| Ingest, concurrency 25 [M] | **4,459 req/s**, p50 4.37 ms, p95 10.6 ms, p99 12.86 ms | same |
| RSS [M] | idle 17 to 19 MiB, load peak 19.2 to 21.9 MiB | headroom under 32 MiB is about 10 MiB (Cloud may count memory differently: verify) |
| CPU per accepted event [E] | about 0.3 ms (1 / 3,353 s at concurrency 1) | add roughly 25 us per binding call on Cloud [given], 1 to 2 calls |
| Bytes per stored event [M] | **434 B** (30,000 pageviews: table 84 B, indexes 350 B; 12.4 MiB total) | `event-size.mjs` then `dbstat` |
| Index share [M] | `name_ts_overview` 2.44 MiB, `visitor_ts_funnels` 2.30, `site_ts_funnels` 2.30, `site_visitor_ts` 1.22, `site_ts_visitor` 1.21, `site_ts` 0.43 (of 12.4 MiB) | |
| Rollup tick, idle, 90 days history [M, bun:sqlite] | 10 sites 0.11 ms, 100 sites 0.86 ms, **1,000 sites 8.8 ms** | linear, about 9 us per site |
| Rollup build of one day [M, bun:sqlite] | 3,300 events 17.6 ms; 33,000 events 208 ms | about 6 ms per 1,000 events |
| Dashboard on a 1M-event, 10-site, 393 MiB database [R, dev observation, not controlled] | overview about 1.2 s, live fragment about 1.6 s, full 30-day stats about 2.4 to 2.7 s | `performance/2026-10-06-ui-stress/`; wall clock on M1 |

Reading these: ingest is not the constraint (hundreds of millions of events per day of headroom on one writer); **storage growth, restore time, and raw-event read paths are**.

### 3.2 Volume per tier (proposal, [E])

| Tier (alpha) | Sites | Pageviews / month | Raw + rollup retention | Stored per month at 434 B raw + about 350 B rollup [E] |
| --- | --- | --- | --- | --- |
| Free | 3 | 10,000 | 90 days | about 8 MB |
| Pro (alpha, free of charge) | 20 | 100,000 | 90 days | about 80 MB |
| Fleet budget for the alpha | about 60 free + 10 pro orgs | about 1.6 M | 90 days | steady state about 3.7 GB |

The rollup size is an estimate: rollups are keyed by visitor (`analytics_rollup_dimensions` has `visitor` in its primary key), so they hold roughly 5 to 8 rows per visitor-day and are **not** much smaller than raw events for low-pageviews-per-visit sites. Measure it in M0 on a realistic seed.

Shard ceiling for planning: **5 GiB** [E] (a guess to be replaced by a restore drill: RTO is 4 h, so measure how long LTX restore takes at 1, 2, 5 GiB in M9).

### 3.3 Index diet, rollups, retention

- **Indexes [E, needs a benchmark before acting].** `site_ts` and `site_ts_visitor` are prefixes of `site_ts_funnels`; `site_visitor_ts` is a prefix of `site_visitor_ts_funnels`. Dropping all three removes about 2.9 of 12.4 MiB (23%, about 100 B per event) and three index writes per ingest. Cost: a wider index scans slower for count queries (the covering `(site,ts,visitor)` index exists because it took a scan from 1,245 ms to 149 ms). Run the stress seed with and without them before deciding.
- **Triggers.** Each insert fires the rollup-dirty check and the cache-revision upsert (a hot row per site-day). Measure ingest with triggers on and off; if the cache-revision write dominates, batch it by moving revision bumps to the cron.
- **Rollups.** Keep daily rollups. Add a hosted **aggregate tier** later (rollups without `visitor`) so raw and visitor-level data can be dropped at 90 days while charts keep 12 months. It costs distinct-visitors-across-days exactness, so it is a product choice and is not in the alpha.
- **Retention job.** Raw `DELETE` fires `analytics_rollup_delete` and the cache trigger **per row**, re-dirtying the day and later wiping its rollup. Retention must delete in day chunks (about 5k rows per tick) behind a guard added to those triggers (`WHEN NOT EXISTS (SELECT 1 FROM maintenance_guard)`), and the same path serves site and org deletion (4.3).
- **Read budgets.** Synchronous SQLite cannot be interrupted, so cost is bounded by shape: hosted mode caps filtered, funnel and journey views to 30 days, keeps the existing 50,000-event funnel cap and 10,000-event journey cap, and removes `funnels` from the default `include` of full stats (compute on the Funnels page only). Without this, a 100k-pageview/month site is already near the 2 s wall measured above.
- **Caches.** 128 entries x 262,144 characters can exceed 32 MiB by itself. Hosted: cap by bytes (about 2 MiB each) not entries.

### 3.4 Sharding later

Triggers to shard: shard above the ceiling, restore drill over budget, or writer p99 above about 50 ms under load.

| Option | For | Against |
| --- | --- | --- |
| Time shards (one events DB per month) | Retention becomes "drop a database": no DELETE storm, LTX shrinks, writes hit only the newest DB | Reads cross up to 13 DBs, no joins across them, needs runtime-named databases (Cloud feature, 6.2) |
| Per-tenant DB for big tenants | Isolation by construction, easy per-tenant export and delete | Many databases per app, and routing in app code |
| Keep one DB, add the aggregate tier | No platform feature needed | Postpones, does not solve write growth |

Plan: ship one DB, keep the DAL as the only SQL owner (so sharding is a change inside `src/data/`), and write the shard decision with real alpha numbers.

### 3.5 The every-minute cron

What it does today [R]: `scheduled()` forks and execs the full binary; the child opens SQLite, checks the backup schedule, runs `runRollups` (up to 4 completed site-days, round-robin across sites), exits.

- **Cost at N sites [M]:** the scan itself is trivial (0.11 ms at 10 sites, 8.8 ms at 1,000). The real cost is **1,440 process spawns a day**: child startup measured 93 to 304 ms on the Mac [M], so about 2 to 7 CPU-minutes a day for **zero** work most minutes.
- **Hosted-specific problems:** (a) fork+exec of the same binary in a 32 MiB cgroup doubles resident memory (17 to 22 MiB each [M]) and may hit task or memory caps: must be tested in M0; (b) `db.backup()` and its file output do not apply because LTX replaces them; (c) rollups only matter for completed UTC days, and today's data is read live, so most ticks have nothing to do; (d) **midnight herd**: at 00:00 UTC every site has one new day to build; at 4 days per tick, 1,000 sites need 250 minutes.
- **Better schedule [E]:** cron `*/5 * * * *`, run **in-process** (no fork) under a time budget (stop after about 1.2 s) instead of a day count, order sites by recent dashboard activity then volume, and stagger per-site start by a hash of the site id so there is no herd. Backup code is excluded in hosted mode. A single large day (1M events would take about 6 s [E from 208 ms per 33k]) needs the build split by hour so no tick exceeds the CPU limit; this only matters above the alpha caps.

## 4. Hosted-only concerns

### 4.1 Plans, quotas, rate limits, abuse

- **Plans.** `orgs.plan` plus a `plans` table in code (not D1): sites, pageviews per month, members, read keys, retention. Proposal in 3.2. Billing is a seam only: `plan` is set by hand or an operator route; a `billing` module with an interface (`entitlements(org)`, `onPlanChange`) and a no-op implementation. No provider.
- **Usage counting.** In-memory per-site counters flushed to `usage_monthly(org_id, month, pageviews, rejected)` every 10 s and at sleep; an `over_quota` flag per org refreshed by the cron and cached in process. This avoids a second hot-row write per event.
- **Over quota (decision needed).** Proposal [E]: at 100% email the owner and keep collecting; at 200% stop storing (return 202, count as `dropped`) and show a banner; never delete data. Dashboards stay readable.
- **Rate limits per tenant.** Today only per-IP (240/60 s). Add `INGEST_SITE` keyed by site id (a fixed limit per binding means one limiter per plan class, since the limiter takes a static limit), a payload size cap, and caps on distinct paths and distinct event names per site per day (protects the dimension rollups from cardinality bombs).
- **Abuse.** The tracker key is public, so anyone can post to any site that knows its domain string. Mitigations: per-site limits, `Origin` header must match the site domain when present, referrer-spam list, auto-pause of a site that is 10x over its plan with an owner email, an operator ban list, signup limits, verified email before first site, disposable-email blocklist.
- **Operator routes** (`/metrics`, `trace`, org list, suspend, plan change) behind `RISULTA_OPERATOR` with a separate operator token, never reachable by an org admin.

### 4.2 Operational limits to design for

Unauthenticated login counters and the per-IP limiter must key on the **real client IP**. If the Cloud edge does not supply `request.cf.clientIp` (or the trusted-proxy equivalent), every visitor hashes to the same ID and one limiter bucket blocks everyone. This is the first thing M0 tests.

### 4.3 Export, delete, GDPR

- **Export (per org).** Cursor-paged JSON Lines for raw events (`/api/sites/:id/export?after=<id>`, 50,000 rows per page, fits 2 s CPU) plus the existing CSV reports; account data as JSON. Later: queue-built archive in R2 with a signed link.
- **Delete.** Site delete and org delete are queued, chunked deletes (about 5k rows per tick, behind the trigger guard in 3.3), with a tombstone so the UI shows "deleting". User deletion keeps the "not last owner" rule. Deleted data leaves LTX backups when the backup retention window expires: state that window in the privacy page.
- **GDPR.** Customers are controllers, risulta.dev is processor: publish a **privacy policy**, a **DPA** with standard clauses, a **subprocessor list** (the hosting provider, the backup object store, the email provider; backup storage must be an EU location, and the Cloud backup backend is still undecided), a **data-location statement** (EU, Falkenstein), a **retention table** (events 90 days in the alpha, accounts until deletion plus the backup window, email logs 30 days), and a breach procedure. The product itself is cookie-free and stores no raw IP or UA, which is the basis for "no consent banner needed", but that statement is the customer's to make and needs a lawyer's review. Legal text is a human task, not an engineering one.
- **Alpha honesty.** A status page on separate infrastructure (not on Sproutboat Cloud itself), a banner and a terms line: "Risulta runs on the Sproutboat Cloud closed alpha: no SLA, backups every 60 s, recovery from host loss can take up to 4 hours, and events sent during an outage are lost (tracker beacons are not retried)." Linking Cloud incidents is a platform ask (6.2).

## 5. Domains

| Host | Serves | Notes |
| --- | --- | --- |
| `risulta.dev` | Marketing and docs (stays static as today) | not the app |
| `app.risulta.dev` | Dashboard, auth, API | `__Host-` session cookie, CSRF same-origin check, `RISULTA_BASE_URL` |
| `t.risulta.dev` | `/js/<key>.js`, `POST /api/event/<key>`, `/widget.js`, `/public/*` | cookie-free, `access-control-allow-origin: *` as today (`ingest-http.js`) |

- **Host allowlist.** One app, several hostnames. On `t.risulta.dev` and on any custom host, only the tracker/collector/widget routes exist; everything else returns 404. This keeps the session cookie and login off hosts a tenant controls (phishing) and keeps the CORS wildcard off authenticated routes. Needs a new `RISULTA_TRACKER_ORIGIN` for the snippet (today the snippet origin comes from `RISULTA_BASE_URL`).
- **Custom domains, two steps.** (1) Alpha: documented **proxy recipes** (Cloudflare Worker, nginx, Caddy, Next rewrites) mapping `https://stats.customer.com/js/<key>.js` and `/api/event/<key>` to `t.risulta.dev`. The collector sees the proxy IP, so the proxy must forward the client IP in `X-Forwarded-For` and the collector must trust it **only** for configured proxy ranges, otherwise visitors collapse to one hash. This needs a design note in M7. (2) Later: customer CNAME to a platform custom hostname. Cloud's planned custom domains (DNS TXT proof for free accounts) bind a domain to the **owner account**; Risulta needs the same for **its customers' domains**, which is a platform feature (6.2).
- **CORS.** Collector: unchanged (wildcard, preflight 204). Dashboard API: same-origin only, no CORS. Read API: bearer, server to server, no CORS. Widget data: `*` as today.

## 6. What this validates on Sproutboat Cloud

### 6.1 Metrics to watch

| Metric | Why | Target [E] |
| --- | --- | --- |
| Ingest p50 / p99 at the app and at the edge | A real second-order test of the 25 us binding cost | p99 under 25 ms at 500 req/s |
| Wake rate, wake latency | An analytics app with traffic should rarely sleep; each wake loses in-process caches | under 1 wake/h after traffic |
| CPU per request, by route class (ingest, dashboard, rollup tick, login) | 2 s limit; dashboards near it | ingest under 1 ms, dashboard p99 under 1.5 s |
| Memory high-water per app | 32 MiB cap, 10 MiB headroom | under 28 MiB |
| Shard size growth per day vs plan | The scale model in 3.2 | within 20% of the estimate |
| LTX backup lag and restore time (drill) | RPO 60 s, RTO 4 h claims | measure; restore at 1, 2, 5 GiB |
| 429 / 5xx rate; events dropped | Loss during deploys and host loss | under 0.1% outside incidents |
| Deploy with migration: downtime and failed starts | Schema changes on a live shard | zero failed ingests across a deploy |

### 6.2 Platform features Risulta needs (Cloud backlog)

1. **Trusted client IP** exposed to the app (and the trusted proxy range for tenant-controlled proxies). Blocker.
2. **Outbound email**: a `send_email` binding, or a documented egress allowlist with a working TLS client to a transactional provider.
3. **Cron without fork**: durable, single-flight cron with a stated CPU budget; confirm fork+exec of the app binary is permitted (or forbid it and say so).
4. **Memory**: per-app limit above 32 MiB (64 MiB) or at least visible memory telemetry; 32 MiB leaves about 10 MiB.
5. **Custom hostnames API** for apps: customer-owned domains with delegated verification (TXT or CNAME), certificate issuance, and a raised per-app host quota.
6. **Runtime-named databases**: create, open and drop D1 databases by name at runtime (for time or tenant shards).
7. **Shard observability and quotas**: per-account shard size, LTX lag, last restore drill, storage quota enforcement and alerts (storage and egress limits are not enforced today).
8. **Backup access**: download or restore-to-new-database of the account shard, for tenant export, disaster rehearsal and staging copies (`db.backup()` is standalone only).
9. **Per-request CPU and memory in logs/metrics** for the app owner (so 6.1 can be measured on Cloud, not only on a Mac).
10. **Rate limiter with a dynamic limit** (the `ratelimiters` binding has one static limit and period): per-plan limits otherwise need one binding each.
11. **Password hashing primitive**: a scrypt or PBKDF2 **hash** side (today verify-only `scryptVerify`).
12. **Outage ingest buffering** or a warm standby host: with RTO 4 h, every beacon during host loss is lost.
13. **Platform status feed** to link from the Risulta status page.

## 7. Milestones (PR-sized, estimates are [E], one engineer with agent help, working days)

| # | Milestone | Size | Depends |
| --- | --- | --- | --- |
| M0 | **Platform-fit spike**: deploy v0.2.2 unchanged to Cloud as a single org. Verify client IP, fork+exec maintenance in the cgroup, cron delivery, `db.backup()` behaviour, memory under real ingest, wake/sleep, an external site sending real traffic. Measure rollup size on a realistic seed and index/trigger variants. Output: a pass/fail list and numbers. | 3 d | none |
| M1 | **Schema 8**: orgs, memberships, `sites.org_id`, per-org uniqueness, migration of admin/viewer/self-hosted to org 1. No behaviour change in `selfhosted`. | 4 d | M0 |
| M2 | **Scoped DAL + isolation harness**: `src/data/`, `SiteHandle`, lint rule, route manifest, two-tenant fixture, cross-product and fuzz tests. Fix audit rows 1 to 6. This PR is the gate for everything hosted. | 8 d | M1 |
| M3 | **Hosted mode flags**: `RISULTA_MODE`, close `/backups`, `/api/backup`, `trace`, `/metrics` to non-operators, host allowlist, `RISULTA_TRACKER_ORIGIN`, byte-capped caches, 30-day cap on raw-scan views, `funnels` out of default stats. | 3 d | M2 |
| M4 | **Accounts**: signup (`invite` mode), email verify, invitations, reset, sessions list, auth limiters, `mailer.js` + queue. | 8 d | M2, platform email (6.2) |
| M5 | **Plans and quotas**: plan table, usage counters, per-site limiter, cardinality caps, over-quota behaviour, operator routes, billing seam. | 5 d | M3 |
| M6 | **Data lifecycle**: trigger guard, chunked retention, site/org delete, cursor export. Also the cron change (3.5): in-process, time-budgeted, staggered. | 5 d | M3 |
| M7 | **Domains and tracker**: `app.` and `t.` hosts, snippet origin, proxy recipes with trusted-proxy handling, docs. | 3 d | M3 |
| M8 | **Trust pages**: privacy, DPA, subprocessors, terms, retention table, status page on separate infra, alpha banner. Legal review is outside the estimate. | 4 d | M4 |
| M9 | **Drills on Cloud**: two-org load test, restore at 1/2/5 GiB, deploy-with-migration under traffic, abuse test, then close the alpha checklist. | 4 d | M5, M6, M7, M8 |
| M10 | Later, sized after alpha data: custom-hostname automation, time shards or aggregate tier, funnel precompute, billing provider. | not estimated | alpha data |

Total M0 to M9: about **47 working days** [E]. M2 and M4 are the large and risky ones.

Order: M0, M1, M2, M3, then M4 and M7 in parallel with M5 and M6, then M8, M9.

### What ships for the first real users

- **Alpha A (about 29 d: M0 to M4 + M7):** invite-only, around 10 orgs we know, Free plan only, manual quota checks by the operator, proxy recipes for custom domains, an "alpha, no SLA" banner. Isolation harness green is a hard gate.
- **Alpha B (about 47 d: through M9):** a waitlist of up to the fleet budget (about 70 orgs, 1.6 M pageviews a month), automatic quotas and retention, export and delete, the trust pages, restore and abuse drills passed. No billing.

## 8. Decisions needed from the user

1. Transactional email provider (EU region, deliverability, price).
2. Alpha plan numbers (sites, pageviews, retention, fleet budget) from 3.2.
3. Over-quota behaviour (3.2 proposal: keep at 100%, drop at 200%, never delete).
4. Alpha retention of 90 days for all plans, and the hosted cap of 30 days on raw-scan views.
5. Where the status page lives, and who reviews the DPA and privacy text.

## 9. Top risks

1. **Cross-tenant leak.** Today's admin sees every site, `/api/users` accepts unchecked site ids, `/api/backup` dumps the whole database. Mitigation: M2 DAL, route manifest, fuzz suite as a CI gate; no hosted traffic before it is green.
2. **One host, one shard, RTO 4 h.** Host loss drops events for hours and a 5 GiB shard may restore slowly. Mitigation: fleet budget, restore drill in M9, honest status messaging, Cloud ask for buffering or a warm standby.
3. **32 MiB and 2 s against raw-event read paths.** Funnels, journeys and filtered views already hit 2.4 to 2.7 s on 100k events per site. Mitigation: read caps, `funnels` out of default stats, byte-capped caches, precompute later.
4. **Unverified platform behaviours**: client IP, fork+exec in the cgroup, email egress and TLS, cron semantics. A wrong answer on client IP breaks both analytics and the limiter. Mitigation: M0 first, before any hosted code.
5. **Signup abuse and email deliverability.** Open signup on a new domain invites spam sites and a blocklisted sender. Mitigation: invite-only alpha, verified email before first site, per-IP and per-site limits, SPF/DKIM/DMARC from day one.
