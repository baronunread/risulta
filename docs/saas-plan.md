# Risulta as a hosted SaaS (risulta.dev) on Sproutboat Cloud

Status: plan, 2026-11-08. No app code changes in this PR. This doc is to move to the private `risulta-cloud` repo once merged (it stays in PR #92 for now).
Decision (2026-11-08): **shared multi-tenant**, like Plausible. One Risulta app serves every customer, tenant isolation is enforced in app code, and hosted and self-hosted stay **one codebase** (AGPL-3.0, no open-core split).

Tags: **[M]** measured for this plan (Apple M1, macOS 15.3.1, Bun 1.4.4, standalone build of `cbfab15`, sproutboat 0.15.0, embedded SQLite, not Cloud), **[R]** read from the repo or the platform docs, **[E]** estimate or proposal. Work is tagged by repo: **`risulta`** (open core) or **`cloud`** (private `risulta-cloud`), see "Repo split". Nothing tagged [E] has been measured. Scripts for [M] numbers: `performance/2026-11-08-saas-baseline/`.

## 0. What the app is today (facts that shape the plan)

- One D1 database (`DB`), every site-owned row carries `site_id`, every query is written by hand with `WHERE site_id = ?` [R]. About 165 `prepare()`/`exec()` lines across `src/` (51 in `store.js`, 30 in `index.js`) [M, `rg -c`].
- Users have a **global** role (`admin` or `viewer`). An admin sees every site in the database; a viewer sees the sites in `site_users` [R: `listSitesForUser`, `getSiteForUser`, `homeOverviews`].
- Ingest: `POST /api/event/:key`, key to site via an in-process cache, per-IP `INGEST` limiter (240/60 s), one INSERT, visitor = daily salted SHA-256 of IP + UA [R].
- Events table carries **6 secondary indexes and 2 trigger families** (rollup dirty marker, cache revision) [R].
- Every-minute cron forks and execs the **same binary** as a maintenance child, which runs the scheduled backup (`db.backup()` to a file) and up to 4 rollup site-days [R].
- State kept in process memory: login failure counters, site-key cache, salt cache, two analytics caches of up to 128 entries each with payloads up to 262,144 characters [R].
- No email code exists. Users are created by an admin with a password [R: `rg -i mail src/` finds only `normalizeEmail`].

Platform facts used below (Sproutboat Cloud closed alpha): 32 MiB per app, 2 s CPU and 30 s wall per request ([R] `web/src/data/limits.ts`: per-app storage and egress limits are **not enforced yet**), per-account SQLite shard on the app host, LTX backups RPO 60 s / RTO 4 h on host loss (given), bindings `kv d1 r2 queue do ae ratelimit assets secret service` with **no email binding** [R: `sproutboat-cloud/docs/phase1-design.md`], outbound fetch goes through an egress service that blocks private ranges [R: `cloud-plan-2026-09-09.md`].

## Repo split (decided 2026-11-08): core + thin private repo

**`risulta` (open, AGPL-3.0)** keeps the app and everything a self-hoster can use: orgs and memberships, the scoped data layer and isolation harness, quotas and usage counters, sampling, retention and purge mechanisms, the cron rework, tracker and app host handling, auth flows (signup, verify, invitations, reset), the mailer **interface**, and the **extension hooks** below, all with safe self-hosted defaults.

**`risulta-cloud` (private, `baronunread/risulta-cloud`)** holds only what is specific to running risulta.dev: billing, checkout and trial logic; the EU email provider adapter and templates; the risulta.dev marketing site, pricing and legal pages (terms, privacy, DPA, subprocessors); Sproutboat Cloud deploy config and secrets setup; abuse tooling; runbooks and ops notes. Rule: **it never forks or patches app code.** Anything it needs from the app becomes a hook or an option in `risulta`.

### Extension hooks (one object, passed to `createRisulta(hooks)`)

| Hook | Shape | Self-hosted default | Cloud implementation |
| --- | --- | --- | --- |
| `quota` | `limits(org) -> {sites, pageviews, members, readKeys, retentionDays}` | unlimited | plan catalog (Starter, Growth), comped and trial limits |
| `billing` | `state(org) -> {status: active\|trialing\|past_due\|locked\|canceled, banner?}`; optional `routes(app)` mounting `/billing/*` and `/api/billing/webhook` | always `active`, no routes | provider checkout, webhooks, subscription state machine (4.5) |
| `onSignup` | `({email, request}) -> {allow, reason?, plan?, orgName?}` | allow only when `RISULTA_SIGNUPS=open`, plan `default` | invite tokens, trial per domain, abuse checks, set trial |
| `mailer` | `send({to, template, vars})` | none: links shown to the admin | EU provider adapter and templates over the queue |
| `events` | `orgCreated, siteCreated, quotaThreshold(80/100/stored cap/seen cap), samplingStarted, orgLocked` | no-op | owner emails, ops alerts |
| `ingestGuard` | `(site, ctx) -> allow\|drop`, synchronous and cheap | allow | ban list, abuse rules |
| `migrations` | list of `{version, sql}` run after core, own `cloud_*` tables | none | billing and abuse tables |
| `schedule` | `(ctx) -> void`, runs inside the time-budgeted tick (3.5) | none | trial expiry and cancellation purge schedule (4.6), billing reconcile |
| `operator` | `authorize(request) -> boolean` for operator routes | operator token env var | operator token plus audit log |

Hook rules: the interface carries a `hooksVersion`; core refuses to start on a mismatch. Failure policy is fixed in core and tested: `ingestGuard` and `quota.limits` **fail open** (last known limits), `billing.state` failure keeps the last known state, `onSignup` and `mailer` failures **fail closed** with a visible error. Core enforces the states (a `locked` org is read-only, a `canceled` org stops collecting); cloud only says which state an org is in. Hooks are the only extension point, so the isolation harness (2.3) runs against a core build with the default hooks **and** with a fake cloud hook set.

### How risulta-cloud consumes risulta

- **Core change needed:** `src/index.js` today builds a module-level `app` and exports `{fetch, scheduled}`. It becomes `createRisulta(hooks)` returning that same object, plus a default export built with the default hooks, so the self-hosted binary is unchanged. `package.json` gets `exports` for `risulta/app`, `risulta/public` (assets) and types.
- **Recommendation: a package dependency, not a git submodule.** `risulta-cloud/package.json` pins `"risulta": "github:baronunread/risulta#v<x.y.z>"` (a tag, never a branch) and the lockfile records the commit. Reasons: Bun resolves and bundles it like any dependency, the pin and its diff are one reviewable line, there is no second checkout to forget to update, and nothing invites an in-place edit of app code. A submodule would work but makes local edits easy, which is the thing the rule forbids. Verify in M3b that the Sproutboat build bundles the dependency and that `assets.directory` can point at `node_modules/risulta/public` (otherwise a prebuild copy step).
- **Entry point.** `risulta-cloud/src/index.js`: `import { createRisulta } from "risulta/app"; export default createRisulta({quota, billing, onSignup, mailer, events, ingestGuard, migrations, schedule, operator});`. Its `sproutboat.jsonc` (bindings, crons, secrets, hosts) lives in cloud; core's stays the self-hosted one.
- **Release flow.** (1) Change merged in `risulta`, CI green (including the isolation harness). (2) Tag `vX.Y.Z`; the existing release workflow builds the self-hosted binaries as today. (3) A PR in `risulta-cloud` bumps the pin (Renovate or a one-line script) and runs the cloud tests plus a staging deploy and smoke test on Cloud. (4) Merge, then deploy to production (a tag in `risulta-cloud` triggers the deploy). Schema migrations ship inside the pinned core and run at startup, so every core release must keep the additive-migration rule from `docs/migrations-and-rollups.md`, and a rollback pins the previous tag (downgrade needs the paired pre-upgrade backup, as today).
- **License check (needs a lawyer, not engineering).** AGPL section 13 binds licensees who run a modified version for users. The copyright holder is not bound by the AGPL for their own code, but anyone else who contributes to `risulta` under the AGPL makes the combined hosted program subject to it. If outside contributions are accepted, either require a CLA that lets risulta.dev run the combination, or accept offering the combined source. Decide before the first outside PR is merged.



### 1.1 Schema (migration 8, additive, one PR)

```
orgs         (id, slug UNIQUE, name, plan, status, created_at)      (plan is an opaque id; limits come from the quota hook)
org_sampling (org_id, day, rate_permille, PRIMARY KEY (org_id, day))        (4.4)
usage_monthly(org_id, month, seen, stored, dropped, PRIMARY KEY (org_id, month))
```

Billing state (`cloud_subscriptions`, trial end, comped-until, provider refs) is **not** in the core schema: `risulta-cloud` creates its own `cloud_*` tables through the `migrations` hook. All of the above is `risulta`.

```
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
| Sign-up | Email + password (12+ chars, existing rule). One transaction creates user, org, owner membership. `RISULTA_SIGNUPS=open|invite|closed`; Alpha A uses `invite` (signup token required, org created as comped, 4.1); `open` (starts a trial) only once billing exists (M8). |
| Verify email | Single-use token, 24 h, hashed at rest (`email_tokens`). Unverified users can log in but cannot create a site and their sites do not accept events. |
| Invitations | Admin enters email + role (+ sites for viewers). 7-day single-use link. Accepting requires login or signup with the same email. Self-hosted without a mailer: the link is shown to the admin to copy. |
| Reset | Token 1 h, single use, revokes every session of that user. Same response whether or not the email exists. |
| Sessions | Keep hashed token + CSRF + `__Host-` cookie. Add last-seen, a sessions list with revoke, and revoke-all on password change (already done) and on reset. |
| Abuse limits | Login and signup counters move out of process memory (they reset on every sleep/wake and are per process): use two new `ratelimiters` bindings (`AUTH_IP`, `AUTH_EMAIL`) plus a D1 failure table for lockout. |
| Password hashing | Today an iterated HMAC-SHA-256 chain, 20,000 rounds [R]. That is not memory-hard. The runtime has verify-only `scryptVerify`, no hash side. Needs a Cloud feature (section 6.2) before a public launch; until then raise rounds and accept the risk for invite-only alpha. Login costs about 77 ms [R, `performance/2026-10-06-cli-comparison`: first login 76.6 ms] so a signup burst of 30/s would saturate one core: keep the `AUTH_IP` limiter strict. |

**Email (decided 2026-11-08): an EU-based transactional provider over its HTTP API, not a platform binding.** The platform has no email binding [R]. The `mailer` hook (`risulta`) exposes one `send({to, template, vars})` behind a provider interface; the provider adapter and templates are in `risulta-cloud`. The adapter calls the provider with `fetch` through the egress service, keeps the API key in `secrets`, and queues sends (`MAIL` queue) for retry, with inline send as the fallback. It needs verifying on Cloud in M0: egress allowlist for the provider host, a TLS handshake (BearSSL) to it, and that a queue consumer can wake a sleeping app. Self-hosted without a provider keeps today's behaviour (links shown to the admin).

| Provider | EU data location | API | Price (all [E], verify before choosing) | Deliverability |
| --- | --- | --- | --- | --- |
| **Scaleway Transactional Email** | France, EU company | REST + SMTP, pay per message, no monthly minimum | roughly cents per 1,000 messages | Newer service with a shared IP pool; check reputation with a seed test |
| **Brevo** | France, EU company | REST + SMTP, mature | free tier of a few hundred a day, paid tiers by volume | Large shared pools: mixed reports; transactional and marketing share one platform |
| **Lettermint** | Netherlands, EU company | REST + SMTP, transactional only | small monthly plans by volume | Transactional-only positioning, young company with a short track record |

**Recommendation (verify):** start with **Scaleway TEM**: EU company and data location, simple REST, usage pricing, nothing to pay while volume is a few hundred emails a month. Keep the adapter generic and send a deliverability seed test (Gmail, Outlook, a Proton address) in M0; if inbox placement is poor, switch to Lettermint or Brevo. All three need SPF, DKIM and DMARC on `risulta.dev`, bounce handling, and a verified sender domain before any signup email goes out.

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

### 3.2 Volume per plan (proposal, [E])

There is **no free plan**: a time-limited trial, then paid plans by monthly pageviews (4.1). Sizes and prices are proposals, not decisions (section 8).

| Plan | Sites | Pageviews / month | Stored per month at 434 B raw + about 350 B rollup [E] | 90 days of raw + rollups [E] |
| --- | --- | --- | --- | --- |
| Starter | 10 | 10,000 | about 8 MB | about 24 MB |
| Growth | 50 | 100,000 | about 80 MB | about 240 MB |
| Scale (not in the alpha) | 200 | 1,000,000 | about 780 MB | about 2.3 GB for one org |
| **Alpha fleet budget** | about 30 Starter + 12 Growth orgs | about 1.5 M | about 1.2 GB | steady state about **3.5 GB** |

A single 1M-pageview org would use half of the shard ceiling below, so Scale needs time shards or the aggregate tier first (3.4). Trial orgs count against the budget with Starter quotas (4.1).

The rollup size is an estimate: rollups are keyed by visitor (`analytics_rollup_dimensions` has `visitor` in its primary key), so they hold roughly 5 to 8 rows per visitor-day and are **not** much smaller than raw events for low-pageviews-per-visit sites. Measure it in M0 on a realistic seed.

Shard ceiling for planning: **5 GiB** [E] (a guess to be replaced by a restore drill: RTO is 4 h, so measure how long LTX restore takes at 1, 2, 5 GiB in M11).

### 3.3 Index diet, rollups, retention

- **Indexes [E, needs a benchmark before acting].** `site_ts` and `site_ts_visitor` are prefixes of `site_ts_funnels`; `site_visitor_ts` is a prefix of `site_visitor_ts_funnels`. Dropping all three removes about 2.9 of 12.4 MiB (23%, about 100 B per event) and three index writes per ingest. Cost: a wider index scans slower for count queries (the covering `(site,ts,visitor)` index exists because it took a scan from 1,245 ms to 149 ms). Run the stress seed with and without them before deciding.
- **Triggers.** Each insert fires the rollup-dirty check and the cache-revision upsert (a hot row per site-day). Measure ingest with triggers on and off; if the cache-revision write dominates, batch it by moving revision bumps to the cron.
- **Rollups.** Keep daily rollups. Add a hosted **aggregate tier** later (rollups without `visitor`) so raw and visitor-level data can be dropped at 90 days while charts keep 12 months. It costs distinct-visitors-across-days exactness, so it is a product choice and is not in the alpha.
- **Retention job.** Raw `DELETE` fires `analytics_rollup_delete` and the cache trigger **per row**, re-dirtying the day and later wiping its rollup. Retention must delete in day chunks (about 5k rows per tick) behind a guard added to those triggers (`WHEN NOT EXISTS (SELECT 1 FROM maintenance_guard)`), and the same path serves site and org deletion, cancellation purges and retention (4.3, 4.6).
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

### 4.1 Plans, trial, quotas, rate limits, abuse

- **Plans and trial (trial decided, sizes proposed [E]).** Mechanism in `risulta` (the `quota` hook, enforced in core); catalog, trial state and numbers in `cloud`. The plan catalog is code in `risulta-cloud`, not a D1 table, with: sites, pageviews per month, members, read keys, retention. Plan sizes in 3.2. Plausible-style: a **30-day free trial, no card required (decided 2026-11-08)**, on Starter quotas (10 sites capped to 3 during the trial), then a paid plan chosen by monthly pageviews. No card keeps signup friction low but invites abuse: one trial per hashed site domain ever, verified email before the first site, per-IP signup limits, and trial sites that never connect a tracker are purged at day 45.
- **Comped alpha invitees (`cloud`).** Alpha A orgs are created `plan = growth`, `comped_until = <date>`, no subscription, on the **real quotas** of that plan, so quota, sampling and retention code runs against real limits from the first user. The operator can change plan or extend `comped_until` from the operator routes.
- **Usage counting (`risulta`).** In-memory per-site counters of pageviews **seen** (accepted after validation, before sampling) and **stored**, flushed to `usage_monthly` every 10 s and at sleep; an `over_quota` flag per org refreshed by the cron and cached in process. This avoids a second hot-row write per event. Quota is billed on **seen**, not stored.
- **Over quota: sampling (decided), specified in 4.4.**
- **Rate limits per tenant.** Today only per-IP (240/60 s). Add `INGEST_SITE` keyed by site id (a fixed limit per binding means one limiter per plan class, since the limiter takes a static limit), a payload size cap, and caps on distinct paths and distinct event names per site per day (protects the dimension rollups from cardinality bombs).
- **Abuse.** The tracker key is public, so anyone can post to any site that knows its domain string. Mitigations: per-site limits, trial-per-domain limit, `Origin` header must match the site domain when present, referrer-spam list, auto-pause of a site that is 10x over its plan with an owner email, an operator ban list, signup limits, verified email before first site, disposable-email blocklist.
- **Operator routes** (`/metrics`, `trace`, org list, suspend, plan change) behind `RISULTA_OPERATOR` with a separate operator token, never reachable by an org admin.

### 4.2 Operational limits to design for

Unauthenticated login counters and the per-IP limiter must key on the **real client IP**. If the Cloud edge does not supply `request.cf.clientIp` (or the trusted-proxy equivalent), every visitor hashes to the same ID and one limiter bucket blocks everyone. This is the first thing M0 tests.

### 4.3 Export, delete, GDPR (export and delete in `risulta`; privacy, DPA and subprocessor pages in `cloud`)

- **Export (per org).** Cursor-paged JSON Lines for raw events (`/api/sites/:id/export?after=<id>`, 50,000 rows per page, fits 2 s CPU) plus the existing CSV reports; account data as JSON. Later: queue-built archive in R2 with a signed link.
- **Delete.** Site delete and org delete are queued, chunked deletes (about 5k rows per tick, behind the trigger guard in 3.3), with a tombstone so the UI shows "deleting". User deletion keeps the "not last owner" rule. Deleted data leaves LTX backups when the backup retention window expires: state that window in the privacy page.
- **GDPR.** Customers are controllers, risulta.dev is processor: publish a **privacy policy**, a **DPA** with standard clauses, a **subprocessor list** (the hosting provider, the backup object store, the email provider; backup storage must be an EU location, and the Cloud backup backend is still undecided), a **data-location statement** (EU, Falkenstein), a **retention table** (events and visitor-level rollups 90 days in the alpha, then per plan as in 4.6; accounts until deletion plus the backup window; post-cancellation schedule from 4.6; email logs 30 days), a **subprocessor** entry for the billing provider (and, if a merchant of record, who is seller of record), and a breach procedure. The product itself is cookie-free and stores no raw IP or UA, which is the basis for "no consent banner needed", but that statement is the customer's to make and needs a lawyer's review. Legal text is a human task, not an engineering one.
- **Alpha honesty.** A status page on separate infrastructure (not on Sproutboat Cloud itself), a banner and a terms line: "Risulta runs on the Sproutboat Cloud closed alpha: no SLA, backups every 60 s, recovery from host loss can take up to 4 hours, and events sent during an outage are lost (tracker beacons are not retried)." Linking Cloud incidents is a platform ask (6.2).

### 4.4 Over quota: sampling (decided 2026-11-08; all `risulta`, so self-hosters can use quotas too)

Instead of dropping or locking, keep a fraction of pageviews once an org is over quota and scale the numbers up. Specification:

- **Method: deterministic per visitor hash.** A visitor is kept when `u32(first 8 hex of visitor) / 2^32 < rate`. The visitor hash is the existing daily salted hash, so every event of a visitor on a UTC day is kept or dropped together: sessions, journeys and funnels (which are within a day, since sessions reset at UTC midnight) stay coherent. Thresholds are nested (a lower rate keeps a subset of what a higher rate kept), so lowering the rate never invents visitors. The decision is made at ingest before the INSERT, so dropped events cost no storage and no index writes.
- **Rate per org per UTC day, fixed for the whole day** (`org_sampling`). The cron sets tomorrow's rate at 00:00 UTC (and every 5 minutes only to extend a stored-events cap, below): `rate = clamp(overage_budget_remaining / projected_demand, 1/64, 1)`, with the overage budget = 10% of the monthly quota and projected demand = trailing 24 h seen rate times remaining days. Fixing the rate per day keeps scaling exact: a day has one weight, `1 / rate`. Sampling starts the first UTC day after the quota is crossed; the 10% buffer absorbs the rest of that day.
- **Limits that protect the host.** (1) **Stored cap:** stored events per org per month never exceed **1.1 x quota**; beyond it every further event is dropped (a 202, counted as `dropped`), which breaks coherence for the rest of the month and is shown as a gap, not an estimate. (2) **Seen cap: 10 x quota** per month: past it the collector rejects before hashing (cheap 202), the org is flagged for operator review and the owner is told. (3) Per-site and per-IP request limiters (4.1) still apply. Starter at 10,000 therefore stores at most 11,000 events a month however much traffic it gets.
- **Scaling in reads.** Counts are scaled at read time in the DAL, per day, by `1 / rate`: pageviews, visits, goal conversions, custom event counts and values scale linearly; distinct visitors scale as sampled visitors / rate (unbiased because sampling is by visitor); breakdown counts (pages, sources) scale per row and are rounded. Rollups store **sampled** counts, so changing the rate never needs a rebuild. The relative standard error of a visitor estimate is about `sqrt((1 - r) / (r * V))` for V true visitors [E: Bernoulli sampling, to be verified in M11 against seeded ground truth]. Funnel step counts scale the same way; the journeys list shows only the visitors that were kept and says so.
- **Showing it.** Any range that overlaps a sampled day: a persistent banner ("Estimated: X% of visitors were sampled on N days of this range because this account went over its plan"), the numbers prefixed `~`, sampled days hatched on charts, and a tooltip with the rate and the approximate error. The API adds `sampled` (days, lowest rate) and `estimated: true` to stats and report JSON, an `X-Risulta-Sampled` header, and a `sampled` column in CSV only when the range is sampled; existing fields and clients are unchanged. Public widgets show the same `~` marker.
- **Notifying the owner.** Emails at 80% of quota (heads-up), at 100% (sampling starts tomorrow, with an upgrade link), at the stored cap and at the seen cap, plus an in-app banner for owners and admins and a weekly digest while sampling is on. Quota resets on the first of the month (UTC) and sampling returns to 100%.
- **Self-hosted** never samples (no quotas).

### 4.5 Billing: Polar (decided 2026-11-08; all `cloud`, behind the `billing` hook)

Billing is no longer deferred: checkout, subscription state and the trial lifecycle must be live before the waitlist opens (M8). It stays **out of Alpha A**. Provider: **Polar (polar.sh), merchant of record.** Alternatives considered and not chosen: Stripe + Stripe Tax (cheapest, but you register and file EU VAT yourself), Paddle and Lemon Squeezy (also merchants of record).

Facts below were read from the public docs on 2026-11-08 (`polar.sh/docs`, `docs.polar.sh` redirects there). The pages were summarised by a fetch tool, so **everything is unverified until M8 starts and the exact pages are re-read**; items the docs did not cover are marked "not documented".

**Trial without a card: Polar cannot do it, so the trial is ours.** Polar's trials page says customers "won't be charged until the trial period ends" but "We'll still collect their payment information at checkout", and it describes no card-free trial. Therefore:
- The 30-day trial is **our own state** in `risulta-cloud` (`cloud_trials(org_id, started_at, ends_at)`), created by the `onSignup` hook. Polar knows nothing about it.
- Polar is involved **only at conversion**: a "Subscribe" button creates a checkout session and redirects to Polar's hosted checkout. Polar's own trial feature is **not used** (trial override off on every product and link).

**Products and prices.** One Polar product per plan per interval (Starter and Growth, monthly and yearly: four products), each a **fixed recurring price**. Billing cycle and pricing type are locked at product creation (docs), so decide intervals first. The map `polar_product_id -> plan` lives in cloud config, one per environment. Archived products keep renewing for existing subscribers and old subscribers keep their price (docs), which gives clean grandfathering.

**Pageviews are tiered plans, not metered usage: confirmed, no metered billing.** Polar's metered pricing bills consumption (docs cite API calls and tokens) and the docs do not describe volume tiers for it. Our over-quota path is sampling (4.4), so there is nothing to meter or invoice after the fact. Revisit only if overage billing is ever wanted.

**Checkout.** Server side, `POST /v1/checkouts` (SDK `polar.checkouts.create`), fields per the docs: `products` (the one product chosen), `external_customer_id` (**our org id**, which Polar exposes as `customer.external_id`, unique per Polar organization and **immutable once set**, so it must be the stable org id, never a slug), `customer_ip_address` (forward the visitor's IP so Polar picks country and currency), `customer_billing_address.country` (optional with the IP). Prefilled email via `customer_email` and `success_url`, `metadata` (org id, plan) are standard but **not confirmed on the pages read**. Use the hosted checkout redirect. Embedded checkout: not documented on the pages read, treat as a later option.

**Customer portal.** Polar's hosted portal: view subscriptions and orders, download and edit invoices (a customer can add a company name or **VAT number**), download receipts, cancel, **update the payment method** (hosted portal only, the main recovery path from failed renewals), and, if enabled in Polar settings, change plan, pause and resume. Risulta's billing page links to a **pre-authenticated portal link** created through the customer sessions API for the `external_customer_id` (endpoint not confirmed on the pages read). Enable plan change in the portal so upgrades and downgrades need no custom UI; proration behaviour is **not documented** on the pages read, check the proration page.

**Webhooks.** One public endpoint `/api/billing/webhook` (mounted by the `billing.routes` hook):
- **Signature:** the docs say Polar sends `webhook-id`, `webhook-timestamp` and `webhook-signature` (the Standard Webhooks scheme). A twist: secrets created before a cut-over date in 2026 use Polar's own HMAC encoding (key is the base64 of the UTF-8 bytes of the full `whsec_...` string) and newer secrets use plain Standard Webhooks, with the SDK trying both. Our verifier is written on `crypto.subtle` HMAC-SHA-256 (the runtime supports it), tries both key forms, rejects timestamps older than 5 minutes, compares in constant time, and returns 403 on failure. The official `@polar-sh/sdk` `validateEvent` is used **in tests only** (under Bun) as an oracle against our verifier with recorded sandbox payloads. Reason for a hand-written client rather than the SDK in the app: the SDK is an npm package built for Node and the Porffor-compiled runtime has no Node built-ins beyond `path`, `url` and `querystring`; the REST calls we need (create checkout, create customer session, get subscription) are three `fetch` calls.
- **Respond fast:** Polar times out at 10 s and recommends answering within 2 s. The handler verifies, stores the raw event in `cloud_webhook_events` keyed by `webhook-id`, answers 202, and processes through the queue (or the next tick of the `schedule` hook). Unknown event types also get 202.
- **Retries and disablement:** up to 10 retries with exponential backoff; **10 consecutive non-2xx responses disable the endpoint** and re-enabling is manual in Polar's settings, so failure to answer for a few minutes can silently stop billing. Alert on any non-2xx we return, and run a **reconcile job** (hourly, via `schedule`) that lists subscriptions through the API and repairs drift.
- **Idempotency and ordering: not documented.** So: dedupe on `webhook-id`; never trust event order; on **every** subscription event, handle it by re-fetching the subscription (`GET /v1/subscriptions/{id}`) and writing its current status, period end and cancel flag, which makes duplicates and reordering harmless.

**Events mapped to our subscription state machine** (`cloud_subscriptions.status`; core sees only the `billing.state` result):

| Polar event (per docs) | Our transition |
| --- | --- |
| `checkout.expired` | none (stay `trialing` or `locked`) |
| `subscription.created` | store the subscription for the org (by `external_id`); not yet service |
| `subscription.active` | `active`, plan from the product map; end of our own trial |
| `subscription.updated` (catch-all: cancel, uncancel, cycle, past_due, revoke, plan change) | re-fetch and set from the current object |
| `subscription.cycled` and `order.paid` | renewal: extend `period_end`, record the order for the billing page |
| `subscription.past_due` | `past_due` (full service; Polar runs automated payment recovery) |
| status `unpaid` (retries exhausted; revoked benefits unless a grace period is configured) | treat as `canceled`, start the 4.6 clock |
| `subscription.canceled` (cancellation requested, access to period end) | `canceling`: keep `active` service until `period_end`, banner to the owner |
| `subscription.uncanceled` (listed under `subscription.updated`) | back to `active` |
| `subscription.revoked` (ended for good: at period end after cancel, or immediate) | `expired`, start the 4.6 clock |
| `subscription.paused` / `subscription.resumed` | not offered (portal pause disabled); if received, treat as `locked` / `active` |
| `order.refunded`, `refund.*`, `customer.deleted` | notify the operator; no automatic state change |

Our own states in `billing.state`: `trialing` (our trial), `active`, `past_due`, `canceled` (service ended, 4.6), `locked`. Polar's own trial status is never used. Comped orgs have no subscription and never enter the machine. Provider webhooks and the reconcile job are the only writers; a client redirect from checkout is never trusted (the success page only polls our state).

**API and SDK.** REST base `https://api.polar.sh/v1`, **sandbox** `https://sandbox-api.polar.sh/v1`, bearer **Organization Access Token** (kept in `secrets`, never in logs). Rate limit 500 requests per minute per organization in production, 100 in sandbox (429 with `Retry-After`): far above our use. TypeScript SDK is `@polar-sh/sdk` (Python `polar-sdk`); the import path shown in the docs was a dated subpath, unverified. We use plain `fetch` (above).

**Sandbox.** A fully separate server, user account, organization, products and tokens (a production token does not work there). Stripe test cards work (4242 4242 4242 4242), and customer emails in the sandbox go only to organization members. The staging deploy of `risulta-cloud` points at the sandbox with its own webhook secret; production uses the live organization. M8 and M11 run the full flow in the sandbox: checkout, trial conversion, renewal, failed payment, cancel, uncancel, revoke, duplicate and reordered webhooks, refund, endpoint disablement drill.

**What Polar changes in the plan (unverified, check at M8):**
- **Fees are higher for EU buyers than the headline.** Docs: Starter tier 5% + 50 cents per transaction, plus **1.5% on non-US cards** (every EU customer), so about **6.5% + 50 cents**; Pro tier ($20/month) 3.8% + 40 cents. Payout costs pass through from Stripe: $2 a month while payouts are active, 0.25% + 25 cents per payout, 0.25% cross-border conversion for the EU. Chargebacks cost $15 each, refunds do not return the fee. On illustrative prices of 9, 19 and 59 euros a month that is roughly **12%, 9% and 7%** of the price after the fixed part, so cheap plans and monthly-only billing are expensive; offer yearly plans and set the lowest price with this in mind. Currency support (EUR prices): not documented on the pages read.
- **EU VAT: handled by Polar.** As merchant of record Polar takes the liability, registers, collects (Stripe Tax) and remits, has an EU OSS number, and supports B2B reverse charge when the buyer adds a VAT number. **You still owe your own income tax** where you live. Polar issues the invoices and receipts, so the terms and the DPA subprocessor list must name Polar (and Stripe behind it) and say that Polar, not risulta.dev, is seller of record.
- **Payouts:** schedule, minimum, supported payout countries and any reserve on new accounts are **not documented on the pages read**. Confirm for your country and legal entity before committing to Polar.
- **Webhook endpoint disablement after 10 failures** is an operational risk (above) and needs monitoring and a runbook in M10b.
- **No card-free trial** is a product constraint already handled by the own-trial design; conversion therefore needs a visible in-app path, because Polar will not email trial users.

### 4.6 Retention and cancellation (proposal [E]; purge mechanisms in `risulta`, the schedule and policy in `cloud`)

Plausible keeps data while you subscribe. Risulta has one writer shard (ceiling about 5 GiB, 3.2), and visitor-keyed rollups are about as large as raw events (3.3), so "keep everything while subscribed" is not affordable until the aggregate tier or time shards exist.

| Stage | Raw events + visitor-level rollups | Aggregated daily data (aggregate tier, M12) |
| --- | --- | --- |
| Alpha, every plan | 90 days | none yet: charts older than 90 days are empty |
| After aggregate tier | 90 days (Starter), 180 days (Growth) | Starter 12 months, Growth 24 months, Scale 36 months |
| Target, after time shards | Match Plausible: all data while subscribed | |

Raw-scan views (filtered cohorts, funnels, journeys) stay capped at 30 days in hosted mode (M3).

**After the trial or a cancellation (proposal):**

1. **Trial ends without payment:** day 0 dashboard locked (read-only banner with upgrade link), collection continues for 14 days so a late purchase loses nothing, then collection stops (202, discarded). Data and export stay available until day 60, then the org's data is deleted after a reminder email at day 45 and day 55.
2. **Active subscription canceled:** service until `period_end`. Then 30 days of read-only plus **export**, collection off. Reminder emails at 7 and 25 days. Deletion at day 90 after `period_end` (reminders at 60 and 80), unless resubscribed.
3. **Payment failure:** Polar's automated recovery runs while the subscription is `past_due` (full service; the retry schedule is not documented, set a grace period in Polar to match about 14 days). Status `unpaid` is treated as cancel (step 2 clock starts).
4. **Any time:** the owner can export (4.3) and delete immediately. Deletion runs in chunks (3.3) and confirms by email. Deleted data leaves LTX backups when the backup retention window ends: stated on the privacy page (4.3).
5. **Comped orgs** follow step 2 when `comped_until` passes without a subscription.

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
| Sampling accuracy (estimate vs seeded ground truth) and share of orgs sampled | 4.4 error formula | within the stated error; under 10% of orgs sampled |
| Billing webhook latency and failures | Subscription state is webhook-driven | no unprocessed event older than 5 min |
| LTX backup lag and restore time (drill) | RPO 60 s, RTO 4 h claims | measure; restore at 1, 2, 5 GiB |
| 429 / 5xx rate; events dropped | Loss during deploys and host loss | under 0.1% outside incidents |
| Deploy with migration: downtime and failed starts | Schema changes on a live shard | zero failed ingests across a deploy |

### 6.2 Platform features Risulta needs (Cloud backlog)

1. **Trusted client IP** exposed to the app (and the trusted proxy range for tenant-controlled proxies). Blocker.
2. **Outbound HTTPS to the email and billing providers** (EU email API and the billing API): a documented egress allowlist with a working TLS client. A `send_email` binding is no longer needed (decided 2026-11-08). Also inbound signed webhooks reach the app unmodified.
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

Repo column: `risulta` = open core, `cloud` = private `risulta-cloud`.

| # | Repo | Milestone | Size | Depends |
| --- | --- | --- | --- | --- |
| M0 | cloud (scripts in risulta) | **Platform-fit spike**: deploy v0.2.2 unchanged to Cloud as a single org. Verify client IP, fork+exec maintenance in the cgroup, cron delivery, `db.backup()` behaviour, memory under real ingest, wake/sleep, an external site sending real traffic, egress and TLS to an EU email API (with a deliverability seed test). Measure rollup size on a realistic seed and index/trigger variants. Output: a pass/fail list and numbers. | 3 d | none |
| M1 | risulta | **Schema 8**: orgs, memberships, `sites.org_id`, per-org uniqueness, migration of admin/viewer/self-hosted to org 1. No behaviour change in `selfhosted`. | 4 d | M0 |
| M2 | risulta | **Scoped DAL + isolation harness**: `src/data/`, `SiteHandle`, lint rule, route manifest, two-tenant fixture, cross-product and fuzz tests. Fix audit rows 1 to 6. Gate for everything hosted. | 8 d | M1 |
| M3 | risulta | **Hosted mode and extension hooks**: `RISULTA_MODE`, close `/backups`, `/api/backup`, `trace`, `/metrics` to non-operators, host allowlist, `RISULTA_TRACKER_ORIGIN`, byte-capped caches, 30-day cap on raw-scan views, `funnels` out of default stats; **`createRisulta(hooks)`**, the hook interface with self-hosted defaults, `hooksVersion`, failure-policy tests, harness run with a fake hook set. | 5 d | M2 |
| M3b | cloud | **`risulta-cloud` scaffold**: repo layout, pinned `risulta` dependency, entry point, `sproutboat.jsonc`, secrets setup, CI, staging deploy and the release flow (pin bump, smoke test, tag-to-deploy). | 3 d | M3 |
| M4a | risulta | **Accounts**: signup, email verify, invitations, reset, sessions list, auth limiters, `mailer` hook, `onSignup` hook, org and email events. | 6 d | M2, M3 |
| M4b | cloud | **Email provider adapter** (EU, over fetch plus queue), templates, invite-token signup policy for Alpha A, deliverability seed test, SPF/DKIM/DMARC. | 2 d | M4a, M3b, M0 |
| M5a | risulta | **Quota engine**: usage counters, per-site limiter, cardinality caps, stored cap (1.1 x quota) and seen cap (10 x), `quota` hook consumption, operator routes with `operator` hook. | 4 d | M3 |
| M5b | cloud | **Plan catalog and trial state**: Starter and Growth limits, comped orgs, trial record and per-domain trial rule, `quota` and `onSignup` implementations, `cloud_*` migrations. | 2 d | M5a, M3b |
| M6 | risulta | **Sampling (4.4)**: ingest decision, `org_sampling`, cron rate setter, scaled reads in the DAL, banner / `~` / hatched days, API fields, owner events. | 7 d | M5a |
| M7a | risulta | **Data lifecycle**: trigger guard, chunked retention from `quota.limits`, site/org delete, cursor export, purge API, cron rework (3.5): in-process, time-budgeted, staggered, `schedule` hook. | 6 d | M5a |
| M7b | cloud | **Lifecycle policy**: trial-expiry and cancellation schedule (4.6) on the `schedule` hook, reminder emails. | 1 d | M7a, M4b |
| M8 | cloud | **Billing on Polar (4.5)**: thin REST client, product map, checkout and portal-link creation, signed-webhook endpoint with verifier, event store, queue processing, reconcile job, subscription state machine, own-trial to paid conversion, billing page via `billing.routes`, sandbox end-to-end. Merchant of record removes tax setup. | 8 d | M5b, M4b |
| M9a | risulta | **Tracker hosts**: host allowlist for `t.` and custom hosts, snippet origin, trusted-proxy handling for tenant proxies. | 2 d | M3 |
| M9b | cloud | **Domains deploy**: `app.` and `t.` hostnames, DNS, proxy recipes for customers (published on the marketing site). | 1 d | M9a, M3b |
| M10 | cloud | **Trust and marketing pages**: risulta.dev site, pricing, terms, refund policy, privacy, DPA, subprocessors (hosting, backups, email, billing), retention table, status page on separate infra, alpha banner. Legal review is outside the estimate. | 5 d | M4b, M8 |
| M10b | cloud | **Abuse tooling and runbooks**: ban list on `ingestGuard`, trial-abuse report, suspend/unsuspend, incident, restore and deploy runbooks. | 3 d | M5b |
| M11 | cloud (fixes in risulta) | **Drills on Cloud**: two-org load test, restore at 1/2/5 GiB, deploy-with-migration under traffic, abuse test with no-card trials, sampling accuracy against seeded ground truth, billing webhooks in test mode, then close the checklist. | 5 d | M6, M7a, M7b, M8, M9b, M10, M10b |
| M12 | risulta (Scale plan in cloud) | Later, sized after alpha data: aggregate tier and longer retention (4.6), time shards, custom-hostname automation, funnel precompute, Scale plan. | not estimated | alpha data |

Totals [E]: **risulta** about 42 d (M1, M2, M3, M4a, M5a, M6, M7a, M9a), **risulta-cloud** about 33 d (M0, M3b, M4b, M5b, M7b, M8, M9b, M10, M10b, M11), together about **75 working days** (was 77: Polar as merchant of record takes M8 from 10 to 8 days, since there is no tax setup and no Stripe-style dunning to build; M8 still carries the webhook, reconcile and sandbox work). M2, M6 and M8 are the large and risky ones.

Order: M0 to M3, then M3b, then M4a, M5a and M9a in parallel, then M4b, M5b, M6, M7a, M8, M9b, M10b, then M7b, M10, M11. Core work is never blocked on cloud work except through the hook interface fixed in M3.

### What ships for the first real users

- **Alpha A (about 40 d: M0 to M3, M3b, M4a, M4b, M5a, M5b, M9a, M9b):** invite-only, around 10 orgs we know, **comped** on real Growth quotas, with the stored and seen caps live (over-quota beyond the cap is handled by the operator by hand, sampling not yet built), proxy recipes for custom domains, an "alpha, no SLA" banner. No billing, no trial. Isolation harness green is a hard gate.
- **Alpha B / first non-invited customers (about 75 d: through M11):** waitlist signups start a 30-day no-card trial, then pay through the billing provider. Sampling, per-plan retention and cancellation purge, export and delete, trust pages, abuse tooling, restore and abuse drills all passed. Capacity limited to the alpha fleet budget (about 40 orgs, 1.5 M pageviews a month).

## 8. Decisions

**Decided (2026-11-08):**

1. **No free plan, and a 30-day trial without a card** (Plausible does the same). Paid-only: after the trial, paid plans by monthly pageviews. Alpha invitees are comped but on real paid-plan quotas. Billing (provider, checkout, subscription state) must exist before the first non-invited customer, and is not part of Alpha A (M8).
2. **Email:** an EU-based transactional provider through its HTTP API, not a platform binding. Which provider is open below (recommendation: Scaleway TEM, verify).
3. **Over quota: sample**, deterministic per visitor, scaled and clearly marked as estimates, with a hard cap (4.4).
4. **Repo split: core + thin private repo.** Open `risulta` keeps the app and every self-hostable feature plus extension hooks; private `risulta-cloud` holds billing, the email adapter and templates, the marketing and legal site, deploy config, abuse tooling and runbooks, depends on a pinned `risulta` version and never forks app code. This doc moves to `risulta-cloud` once merged.

5. **Billing provider: Polar (polar.sh), merchant of record**, integrated in `risulta-cloud` (4.5). Polar cannot run a trial without a card, so the trial is our own state and Polar is used only at conversion.

**Still open (proposals in the doc):**

- **Consumption method:** package dependency pinned to a tag (recommended) vs git submodule (Repo split).
- **Outside contributions and the AGPL:** CLA or offer the combined source; needs a lawyer before the first outside PR is merged (Repo split).

- Trial quotas: proposal Starter quotas, 3 sites (4.1).
- Plan sizes, site limits and prices: proposal Starter 10k, Growth 100k pageviews a month, Scale only after shards (3.2). Prices are not proposed here.
- Polar prerequisites to verify at M8 start: payout country, schedule and minimum, EUR pricing, and the unverified API details in 4.5. Price points given the fee structure (yearly plans).
- Email provider final pick after the M0 seed test: Scaleway TEM, Brevo or Lettermint (section 1.2).
- Retention per plan and the cancellation schedule (4.6): 90 days of raw data in the alpha, aggregate tier later, 30-day read-only and 90-day deletion after cancellation.
- The hosted cap of 30 days on raw-scan views (filtered cohorts, funnels, journeys).
- Where the status page lives, and who reviews the DPA, terms and privacy text.

## 9. Top risks

1. **Cross-tenant leak.** Today's admin sees every site, `/api/users` accepts unchecked site ids, `/api/backup` dumps the whole database. Mitigation: M2 DAL, route manifest, fuzz suite as a CI gate; no hosted traffic before it is green.
2. **One host, one shard, RTO 4 h.** Host loss drops events for hours and a 5 GiB shard may restore slowly. Mitigation: fleet budget, restore drill in M11, honest status messaging, Cloud ask for buffering or a warm standby.
3. **32 MiB and 2 s against raw-event read paths.** Funnels, journeys and filtered views already hit 2.4 to 2.7 s on 100k events per site. Mitigation: read caps, `funnels` out of default stats, byte-capped caches, precompute later.
4. **Unverified platform behaviours**: client IP, fork+exec in the cgroup, email egress and TLS, cron semantics. A wrong answer on client IP breaks both analytics and the limiter. Mitigation: M0 first, before any hosted code.
5. **Signup abuse (no-card trial), billing readiness and email deliverability.** A no-card trial on a new domain invites spam sites and a blocklisted sender, and the first paying customer cannot arrive before checkout, webhooks and VAT handling work (about 75 days of work, 8 of them billing). Mitigation: invite-only comped alpha first, one trial per domain, verified email before the first site, per-IP and per-site limits, SPF/DKIM/DMARC from day one, merchant of record to remove VAT filing, billing built and drilled in test mode before the waitlist.
