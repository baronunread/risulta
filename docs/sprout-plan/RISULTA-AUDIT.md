# Risulta feasibility audit

Reviewed `/Users/andreabruno/Code/Products/risulta`, commit `c61ac50`, and Sproutboat CLI `a00eb3c`. No CodeGraph index was present in Risulta. Its working tree was clean when inspected. Existing database contents and credentials were not inspected.

Verification: `bun test.js` passed with `risulta multi-site self-check OK`, using the suite's temporary data and local ports. The current source was not compiled through Porffor, and the existing compiled binary was not regression-tested in this review. No performance benchmark was run.

## What exists already

Risulta is a real multi-site analytics product: public tracker, anonymous daily visitor identities, pageviews/custom events, attribution, administrator/viewer access, session/CSRF protection, live dashboard, reports/CSV and backups. Its README/PLAN are not completely synchronized: several features still marked pending in PLAN have implementation in source.

`scripts/build.mjs` invokes `bun build --compile --minify`, embeds version metadata and supports release targets. The existing `risulta` file is a roughly 61 MiB macOS arm64 executable. Runtime dependencies declared in package.json are only `blobatar` and `htmx.org`. Most portability work comes from built-in Node/Bun APIs, not a huge third-party dependency graph. Bun bundles its runtime into a standalone executable: https://bun.sh/docs/bundler/executables . That size is not a measured minimum and must not be confused with application source size.

The release workflow builds Linux x64 and arm64 executables. A Sproutboat deployment currently targets Linux x86_64, so ARM deployment parity must not be assumed.

## Portability map

| Current implementation | Native Sprout adaptation | Assessment |
| --- | --- | --- |
| app.js uses node:http server/request/response streams | Export fetch handler using Request/Response and bounded bodies | Rewrite HTTP boundary; retain route behavior |
| lib/db.js uses node:sqlite, direct paths, per-site DB handles and transactions | D1 binding and explicit site_id scopes; fixed declared resources | Significant storage adapter work; preserve query/transaction semantics with probes |
| Dynamic sites/<id>.db files | Logical site partitions in one D1 for the prototype | Explicit change from physical isolation; every query and constraint must enforce site scope |
| Password hashing with scryptSync, timingSafeEqual | Validated cryptographic capability or external authentication | Hard gate for existing password-login parity; no weak hash substitute |
| Daily visitor SHA-256, hashed session tokens, random site salts | Validated digest/HMAC/random API and trusted request metadata | SHA/HMAC is not currently a public equivalent of node:crypto in the Sprout prelude |
| SSE and live subscriber maps | Bounded HTTP polling for dashboard fragments | Intentional UX change because current Sprout response streaming is unsupported |
| Trusted proxy CIDRs and req.socket client address | Trusted edge-provided metadata; configured reverse proxy in standalone | Do not trust browser-supplied IP headers; test spoofing and proxy behavior |
| Filesystem snapshots and online SQLite backup | Platform/standalone operational backup workflow | Exporting CSV is not a full database backup |
| Node crypto for avatars | Prebuilt/generic avatar assets or compiler-proven small implementation | Cosmetic and removable; do not let it gate analytics |
| HTMX and SSE browser assets | Prebuild browser assets; replace SSE extension with polling | Browser dependencies need not compile through Porffor |
| Git subprocess for fallback version | Inject version at build time | Simple separation of build-time from runtime |
| SQL analytics, date windows, attribution | Preserve domain rules; test SQLite functions and JS date handling | Reusable design, not assumed compiler compatibility |

Source anchors: `app.js`, `lib/auth.js`, `lib/db.js`, `lib/visitor.js`, `lib/views.js`, `scripts/build.mjs`, `test.js`. Sprout anchors: `src/standalone-build.ts`, `src/native-fetch-prelude.js`, `src/transport-embedded.js`, `patches/UPSTREAM.md`, kitchen-sink conformance suite.

Existing Risulta passwords cannot simply migrate to a weaker hashing scheme. Current Sprout random UUID support is not a replacement for scrypt or SHA-256. BearSSL primitives used internally by embedded transport are not automatically callable standard application APIs.

## Options

| Option | Useful result | Cost/risk | Recommendation |
| --- | --- | --- | --- |
| Keep Risulta's Bun binary | All current features with no installed JS runtime | Larger executable/runtime; benchmark actual RSS before optimizing | Best if the goal is easy standalone distribution |
| Separate Risulta Sprout edition | Smaller-runtime experiment with real analytics workflows | HTTP/storage rewrite, crypto and metadata gates, polling instead of SSE | Recommended experiment if native Sprout adoption is the goal |
| Incrementally port only the collector | Preserve existing dashboard/auth while evaluating native ingestion | Two services and a transport boundary; not one standalone binary | Useful benchmark spike, not the final simplest product |
| Product monitoring and incident notebook | Scheduled checks, incident history, alerts, public status page | Native cron/queue/egress must be dependable; arbitrary hosts conflict with static allowlists | Strongest alternative for naturally using most capabilities |
| Feedback and release desk | Collect feedback, vote, triage, publish releases, send digests | Auth and attachments need care; start with bounded text/images | Best alternative for a useful fullstack app with less analytics-specific crypto work |

Monitoring maps cron to checks, queues to notifications, D1 to history, KV to current status, R2 to reports, DO to incident coordination, assets to public pages and analytics to service reliability. Restrict monitored endpoints to configured allowlisted product hosts initially.

Feedback maps D1 to boards/items, KV to public summaries, R2 to attachments, queues to notifications, cron to digests, DO to debounced vote summaries, secrets/outbound fetch to delivery and analytics to conversion funnels. Binary attachment support must pass byte-level checks; do not assume every R2/asset API has identical semantics across backends.

Both alternatives still need real authentication. They reduce dependence on visitor hashing and Node-specific analytics infrastructure, but do not bypass platform security gates. No external provider purchases or integrations are selected here.

## Recommendation boundary

Do not rewrite the existing product solely to remove Bun/Node installation requirements: the compiled build already does that. Pursue the separate edition only if lower runtime footprint or running on the Sproutboat platform is a meaningful product goal. Set size/RSS targets after baseline measurements, and stop the port if essential security or storage semantics cannot be preserved without building a second runtime inside the app.
