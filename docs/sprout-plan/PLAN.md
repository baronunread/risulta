# Risulta Sprout fullstack application plan

## Product

A private analytics workspace for a developer managing several product websites. Answer three everyday questions: where visitors came from, which releases/campaigns produced conversions, and whether traffic has unexpectedly dropped. Users add a site, install one small tracker, inspect daily reports, configure conversion events, and receive scheduled summaries.

The end-state exercises every currently exposed binding category for a product reason. Milestones deliver useful workflows progressively; no feature exists only to increment a binding counter. This is an experimental sibling, not a promise of immediate Risulta feature parity.

## Core journeys

1. Administrator signs in, registers a domain and copies its public tracker snippet.
2. Tracker submits bounded pageview/conversion events. The collector validates site/domain, strips unwanted URL data and persists accepted input before reporting success.
3. Dashboard shows live activity through polling and compares date ranges, campaign sources and configured conversion goals.
4. Administrator requests a report; a background job produces bounded CSV/JSON exports and a download link.
5. Daily/weekly schedules produce a summary and optional outbound notification. Traffic-drop alerts combine repeated observations rather than sending one alert per request.
6. Administrator adds a viewer restricted to selected sites. All reports, downloads and cached summaries enforce that scope.

## Deployment shapes

```text
Tracked websites                    Administrator / viewer
       |                                       |
       v                                       v
              Risulta app sprout
       collector + dashboard + public assets
                        |
            D1 authoritative application data
            KV disposable summary/config caches
            Queue durable jobs and retry attempts
            DO per-site alert/debounce state
            R2 generated exports
            Analytics aggregate ingestion/job health
                        |
              hosted notification service sprout
                    via service binding
                        |
              allowlisted notification endpoint
```

Start with one app sprout and ordinary modules, not a microservice per binding. For full hosted capability coverage, isolate notification delivery into one service-bound sprout with its own outbound secrets. Its separate credential boundary justifies the split.

Standalone compiles the same delivery domain module into the app and calls it directly through an explicit adapter. Service bindings are rejected by the current standalone builder because no platform edge exists. Use separate validated hosted/standalone configs sharing domain modules; do not falsely claim one standalone binary exercises service routing or managed domains. Compiled program plus writable data directory is still a standalone application; mutable user data does not belong inside the executable.

## Capability mapping

| Capability | Product use | Contract/qualification |
| --- | --- | --- |
| HTTP native handler | Tracking ingestion, authenticated dashboard/API | Bounded non-streaming requests/responses |
| Assets | Dashboard CSS/JS, tracker and icons | Browser assets prebuilt separately; all standalone embedded assets fit current build cap |
| D1 | Sites, members, events, rollups, goals, report jobs | Authoritative store; parameterized scoped SQL; probe batch/transaction behavior |
| KV | Short-lived site lookup and summary cache | Explicit timestamp expiry until required TTL semantics are verified; safe invalidation |
| R2 | Completed CSV/JSON report objects | Bounded textual exports first; object paths and downloads scoped to site/job |
| Queues | Report generation and notification jobs | Idempotency keys, retry state, bounded chunks; never assume exactly-once |
| Cron | Rollup catch-up, raw retention and scheduled summaries | Incremental persistent cursor; no dependency on dashboard traffic |
| Durable Objects and alarms | Per-site debounce and alert cooldown coordination | Rebuildable state initially; do not depend on unproven global single-writer guarantees |
| Analytics Engine | Ingestion/job volume, rejection and processing-lag diagnostics | Aggregate operational data only; not authoritative visitor reports |
| Secrets | Notification credentials and cryptographic configuration | Never compiled into vars/assets; explicit standalone provisioning |
| Outbound fetch | Deliver opted-in summaries to configured endpoint | Fixed allowlist; bounded payload/time; distinguish provider failure from internal state |
| Service bindings | Separate hosted notification delivery authority | Hosted only; direct module adapter in standalone |
| Vars/compatibility date | Non-secret app settings and stable runtime behavior | Pin and validate both configurations |
| Custom domains | Own analytics hostname | Platform/Caddy feature, not an embedded standalone binding |

## Data model and consistency

One declared D1 database for the first edition: sites, users/site_memberships (after auth gate), goals, events, hourly_rollups, daily_rollups, jobs, job_attempts and an outbox. Every site-owned row, lookup and cache/object key carries site_id. Use composite uniqueness where needed and adversarial two-site fixtures.

A bounded event write and its required outbox record must commit atomically using proven D1 transaction semantics. Only then acknowledge durable ingestion. Queue delivery may be retried; deduplicate report/notification jobs and ensure an old attempt cannot complete a newer job. If notification provider idempotency is unavailable, disclose potential duplicate delivery after ambiguous timeout.

Preserve Risulta's metric definitions: unique visitors reset daily; multi-day totals are visitor-days. Visits use a 30-minute inactivity boundary and reset across days. Do not sum hourly distinct counts to invent daily distinct counts. Test midnight, window boundaries, delayed events and timezone handling. Record acceptance latency and processing lag separately.

Daily salt/hash work is blocked on validated crypto and trustworthy client metadata. Never store raw IP/User-Agent in events, queues, logs or export objects. Strip non-attribution query parameters by policy; avoid making a privacy guarantee solely because the application row omits an IP if the surrounding access logs retain it.

Raw event retention and aggregate retention are explicit settings. Build rollups incrementally with a stable cursor and idempotent buckets; handle late events. Limit rows per job, response/export bytes and concurrent jobs. Suggested initial export cap: 1 MiB/chunk, safely below current transport/body limits; tune from actual tests.

## Authentication and UI

Retain server-rendered HTML with small browser enhancements, adapting the existing UX/domain rules rather than introducing a server-side framework dependency graph. Browser libraries can be served as static assets. Replace live SSE with polling visible panels at a proposed 5-second interval, pausing in hidden tabs and backing off on errors.

Authenticated application access is independent of Sproutboat platform login. Full parity requires password KDF verification, token hashing, secure random generation, secure cookies, CSRF checks, session revocation and viewer authorization. Existing scrypt hashes must remain verifiable if a migration is offered. Do not replace scrypt with plain SHA-256, or paste a platform API token into a browser.

Phase-zero options are a vetted supported auth adapter, a deliberate trusted external auth boundary, or a local-only non-public prototype while crypto support is built. An external auth service changes the standalone story and must be labeled accordingly. Public launch remains blocked until one full supported path is proven. No custom cryptographic implementation in application code.

## Planned structure

```text
src/
  app.js                 request routing and response boundary
  domain/                event validation, metrics, reporting, alert rules
  storage/               D1 repository, cache keys, jobs/outbox
  adapters/              hosted service call / standalone direct delivery
  handlers/              fetch, queue, scheduled, per-site alarm handlers
  views/                 bounded server-rendered HTML
web/                     browser tracker and UI source
public/                  compiled browser assets
migrations/              versioned schema changes and fixtures
tests/                   real product journeys and expected report results
config/                  hosted and standalone build configurations
```

No Node/Bun imports in sprout runtime modules. Development scripts may use Bun. Probe each dependency before admitting it into the Porffor bundle; source lint acceptance alone does not establish execution compatibility.

## Milestones and exit gates

### 0. Prove feasibility before porting

Compile and execute small application-derived probes for HTTP/form/cookie handling, D1 scoped SQL/transactions, HTML rendering, required crypto, request metadata, queue scheduling and standalone asset delivery. Test both broker and embedded execution. Verify configuration selection mechanisms before documenting commands.

Exit: a written pass/fail matrix with actual compiler/runtime output. Auth and privacy primitives must have a viable secure implementation path. If they do not, keep current Risulta as the product and choose a smaller non-public experiment; do not silently weaken it.

### 1. Deliver the first useful analytics loop

One administrator, multiple sites, tracker ingestion, daily pageviews/conversions, attribution and polling dashboard using D1/assets. Add KV only for an observed repeated lookup/summary. Use synthetic/imported fixtures until auth/privacy gates pass.

Exit: install tracker on a local fixture website; events appear with correct site isolation and persist across restart. Wrong-domain events fail, cache cannot leak dashboards, malformed input is bounded, and reporting matches reference data.

### 2. Make it useful unattended

Queue-based report generation, report objects in R2, cron summaries/retention and per-site debounced alert coordination. Add aggregate Analytics Engine diagnostics with a visible ingestion/job-health view.

Exit: reports/alerts execute after zero HTTP traffic, survive worker idle/restart, retry without duplicate completed work and expose failures. Depends on platform #142/#144 and queue query indexes as load grows.

### 3. Complete hosted and standalone variants

Hosted service-bound notification sprout; standalone direct-delivery adapter; secure secrets, allowlisted outbound calls, viewer permissions and bounded report downloads. Establish migration/export strategy without accessing existing user databases during development.

Exit: identical functional journeys run in both variants except explicitly hosted-only service routing/domain management. Standalone starts on a clean supported host without Bun/Node installed and uses an explicit persistent data directory. No implied arm64 deploy support.

### 4. Validate operation and performance

Full backup/restore drill, upgrade with prior artifact/data, resource limits and actual traffic-shape benchmarks. Suggested initial test envelope: 10 sites, 100 aggregate events/second, 5 concurrent dashboard users, 1 million historical events and a burst above the limit. These are proposed tests, not measured capacity or promised performance.

Measure comparable Bun Risulta versus native edition using the same host/dataset: binary size, complete runtime/process RSS, cold startup, event p95/p99, report latency, job lag and disk growth. Compare broker-mode total process memory separately from standalone. Do not compare old README loopback numbers to a different machine or workload.

Exit: correctness parity for the agreed subset, documented feature differences, known recovery behavior, no data loss beyond the chosen durability policy, and measured evidence that the port offers a useful benefit. Avoid a hard binary-size promise before bundling assets/TLS/SQLite.

## Platform dependencies and scope control

- Platform #139/#140/#141/#143/#148 protect data, identity, activation, network and cache semantics.
- Platform #142/#144 gate unattended scheduling and durable delivery.
- CLI #23/#24/#18 improve the development loop; #22 improves installation but does not unblock Porffor application compatibility.
- Crypto work in platform #127/#133 is related, but digest/HMAC alone does not supply scrypt password compatibility.
- Platform #128 is related to request metadata; prove trustworthy client IP propagation rather than assuming the planned API exists.
- Existing full Risulta feature parity, funnels beyond proven current rules, SSE/WebSockets, arbitrary uploaded files and dynamic outbound hosts are outside the first milestone.

Keep the existing Risulta runtime, source and data untouched. Reuse its license notices for any copied implementation; the existing server identifies itself as AGPL-3.0-or-later and tracker as MIT. All tests use generated or explicitly exported non-sensitive fixtures. No live traffic switch or production migration is included in this plan.
