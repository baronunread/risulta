# Open issue review

Reviewed 2026-10-06 against the source based on `ecbb939` and the 28 issues returned by the read-only public GitHub API for [baronunread/risulta](https://github.com/baronunread/risulta/issues). Source references below point to this checkout. This is a code inspection only: no build, automated checks, live runtime exercise, or visual review was performed. “Present” means source evidence exists, not that acceptance is verified. Bun-era file paths and single-file-per-site assumptions in older issue descriptions are stale for the current Sproutboat/D1 source where noted.

The review was produced in an isolated baseline checkout. Issues #47, #54, and #51 have since been integrated into the working tree; the entries below describe those integrations. Remaining issues are code-review findings, not claims of completed acceptance.

## Issues

### [#1 Add consistent online backup and documented restore workflow](https://github.com/baronunread/risulta/issues/1)

- **Current evidence:** `POST /api/backup` calls `env.DB.backup()`, counts tables, and returns a manifest in [src/index.js:832](src/index.js); README advertises an online backup at [README.md:24](README.md). This is a D1 snapshot endpoint, not an existing binary backup command.
- **Still needed:** Verify snapshot consistency under concurrent writes, preservation and integrity checks on restore, fail-safe destination behavior, and a release-binary restore drill. Document current D1 layout, ownership, permissions, and restore steps. The issue's old per-site SQLite inventory is not the current schema.
- **Dependency:** #2 for version-aware restore guidance; release workflow for binary-level drill.
- **Next bounded task:** Define the backup artifact and restore contract for current D1, then add a temporary-directory backup/restore integration exercise and operator documentation.

### [#2 Introduce versioned, transactional schema migrations](https://github.com/baronunread/risulta/issues/2)

- **Current evidence:** [src/store.js:44](src/store.js) memoizes `ensureSchema`; [src/store.js:49](src/store.js) runs `CREATE TABLE IF NOT EXISTS` and index creation. No schema-version table or versioned migration registry is present in the inspected store source.
- **Still needed:** Separate control/site version tracking as applicable to the current single-D1 design, transactional/idempotent upgrades, historical fixtures, rollback-on-failure evidence, and release upgrade notes. Long-tail per-site discovery requirements from the old layout need re-scoping.
- **Dependency:** Backup/restore contract in #1 should establish recovery expectations.
- **Next bounded task:** Inventory released D1 schemas and add a version table plus one transactional migration path for the current database.

### [#3 Add password changes, session revocation, and administrator recovery](https://github.com/baronunread/risulta/issues/3)

- **Current evidence:** Password change route checks CSRF and current password at [src/index.js:403](src/index.js); account form states that other sessions are signed out at [src/views.js:266](src/views.js). Probe notes report password change and Bun scrypt rehash checks in [PROBE-RESULTS.md:56](PROBE-RESULTS.md).
- **Still needed:** Local administrator recovery command and explicit user/admin session-revocation flows, plus current tests for stale sessions, recovery, wrong current password, and viewer boundaries. Probe notes are prior evidence, not a rerun in this review.
- **Dependency:** None identified.
- **Next bounded task:** Specify a local recovery command and its session invalidation semantics, then implement and cover it independently of the password form.

### [#4 Replace the trusted-proxy switch with trusted CIDR configuration](https://github.com/baronunread/risulta/issues/4)

- **Current evidence:** Installer writes `SB_TRUSTED_PROXIES` based on proxy selection at [deploy/install.sh:229](deploy/install.sh) and [deploy/install.sh:401](deploy/install.sh). `clientIp` reads runtime-resolved `request.cf.clientIp` at [src/store.js:122](src/store.js). Probe notes report trusted/untrusted XFF behavior at [PROBE-RESULTS.md:41](PROBE-RESULTS.md).
- **Still needed:** Confirm CIDR parsing and multi-hop trust semantics are implemented by the runtime and installer configuration, malformed CIDR startup behavior, IPv4/IPv6 edge coverage, and current docs for migration from the legacy switch. Source alone does not establish these acceptance items.
- **Dependency:** Deployment/runtime configuration support.
- **Next bounded task:** Trace `SB_TRUSTED_PROXIES` through the bundled runtime contract and document/test the exact peer and chain resolution rules.

### [#6 Implement graceful overload handling and per-IP ingest limits](https://github.com/baronunread/risulta/issues/6)

- **Current evidence:** A configured `INGEST` limiter uses 240 events per 60 seconds in [sproutboat.jsonc:10](sproutboat.jsonc); request handling returns 429 with `Retry-After` at [src/index.js:131](src/index.js). Probe notes report a 240-event limit at [PROBE-RESULTS.md:59](PROBE-RESULTS.md).
- **Still needed:** Bounded high-cardinality limiter state, concurrent-work caps and 503 behavior, multi-site fairness, overload load evidence, shutdown behavior, and proof rejected tracker requests do not affect host pages. This implementation uses a runtime binding rather than local per-IP state, so its operational bounds need confirmation.
- **Dependency:** #4 trust resolution for safe per-IP keys; capacity workloads in #7.
- **Next bounded task:** Add a bounded overload workload against the release executable and record memory, response codes, fairness, and recovery after load.

### [#7 Define production capacity targets and representative workloads](https://github.com/baronunread/risulta/issues/7)

- **Current evidence:** [PROBE-RESULTS.md:115](PROBE-RESULTS.md) describes a local ingest benchmark and [bench.mjs:1](bench.mjs) labels it dev-only. No supported VPS target matrix was found.
- **Still needed:** Hardware and workload definitions, latency percentiles, dashboard latency, RSS, CPU, disk growth, and pass/fail thresholds for burst, multi-site, long-tail, and concurrent dashboard use.
- **Dependency:** None; targets should precede the representative release benchmark in #8.
- **Next bounded task:** Write a capacity-target table naming one VPS class and measurable thresholds for each workload shape.

### [#8 Make release benchmarks reproducible and publish VPS results](https://github.com/baronunread/risulta/issues/8)

- **Current evidence:** [bench.mjs:1](bench.mjs) is a localhost ingest benchmark; it spawns the built executable and emits JSON near [bench.mjs:139](bench.mjs). Probe notes contain local throughput analysis at [PROBE-RESULTS.md:115](PROBE-RESULTS.md), not a published VPS baseline.
- **Still needed:** Workloads from #7, latency percentiles, dashboard latency, RSS/CPU, database growth, full environment metadata, clear response validation, and a representative VPS report. Source review does not establish reproducibility or current benchmark success.
- **Dependency:** #7 capacity targets; release artifact workflow.
- **Next bounded task:** Extend the benchmark output schema and one workload to capture full environment metadata and latency percentiles, then run that workload on the selected VPS.

### [#9 Add incremental rollups and bounded raw-event retention](https://github.com/baronunread/risulta/issues/9)

- **Current evidence:** The `events` table is raw-event based at [src/store.js:52](src/store.js); analytics query functions begin at [src/store.js:165](src/store.js). No rollup or retention tables/jobs were found.
- **Still needed:** Rollup design, transactional updates/backfill, safe configurable raw retention, UTC/DST and late-event correctness, resumability, and before/after storage/query measurements.
- **Dependency:** #2 migration framework; #7 and #8 representative measurements.
- **Next bounded task:** Specify hourly/daily rollup columns and exact equivalence semantics for one dashboard metric before adding schema or ingestion changes.

### [#10 Cache dashboard summaries without weakening site isolation](https://github.com/baronunread/risulta/issues/10)

- **Current evidence:** `siteAnalytics` computes summaries in [src/store.js:286](src/store.js). There are small salt and public-key caches at [src/store.js:9](src/store.js) and [src/store.js:15](src/store.js), but no bounded dashboard-summary cache was found. Probe notes explicitly say no KV cache was added at [PROBE-RESULTS.md:169](PROBE-RESULTS.md).
- **Still needed:** Measure a meaningful benefit first, then implement fully scoped keys, invalidation, bounded eviction, safe counters, disable control, and poisoning/isolation checks if justified.
- **Dependency:** #8 workload evidence; #9 may change the query cost profile.
- **Next bounded task:** Use benchmark workloads to measure repeated dashboard query cost and record whether caching meets a stated threshold before designing a cache.

### [#11 Publish a minimal multi-arch container image and Caddy Compose deployment](https://github.com/baronunread/risulta/issues/11)

- **Current evidence:** README and deploy assets describe a one-binary systemd installer at [README.md:9](README.md). No Dockerfile, Compose file, or container workflow was found in the checkout.
- **Still needed:** Multi-arch image/build and supply-chain metadata, non-root/read-only runtime, pinned Caddy Compose topology, persistent volumes, health and isolation checks, size/RSS results, and operating docs.
- **Dependency:** Release workflow and #1/#2 backup and migration guidance.
- **Next bounded task:** Prototype the amd64 Alpine runtime image and measure its unpacked/compressed size before adding publishing or Compose automation.

### [#12 Make website cards more compact](https://github.com/baronunread/risulta/issues/12)

- **Current evidence:** Website overview markup is generated in [src/views.js:70](src/views.js); card and responsive rules are in [public/style.css:27](public/style.css). No visual inspection was performed, so current density and viewport behavior are unverified.
- **Still needed:** Demonstrate reduced height while retaining scannable name/domain/traffic and verify narrow and wide viewports.
- **Dependency:** None.
- **Next bounded task:** Capture the current overview at narrow and wide widths, then adjust only card spacing and compare those captures.

### [#15 Make website tracker settings interactive and copyable](https://github.com/baronunread/risulta/issues/15)

- **Current evidence:** Per-site settings renders a tracker snippet and copy control at [src/views.js:445](src/views.js); browser code wires `[data-copy-code]` and feedback at [public/dashboard.js:37](public/dashboard.js). No formatted/one-line toggle was found in the inspected settings markup.
- **Still needed:** Accessible visible snippet toggle, copy success/failure feedback for each variant, and CSP/browser verification. Existing copy support covers only the rendered snippet.
- **Dependency:** None.
- **Next bounded task:** Add the two snippet variants and an accessible toggle to the settings card, reusing the current copy handler for the active variant.

### [#31 Add acquisition attribution with UTM campaigns and source drilldowns](https://github.com/baronunread/risulta/issues/31)

- **Current evidence:** UTM fields are parsed with 128-character bounds in [src/domain.js:31](src/domain.js), stored in event rows at [src/store.js:52](src/store.js), and report dimensions include source, medium, and campaign at [src/views.js:297](src/views.js). Probe notes report UTM parsing and referrer handling at [PROBE-RESULTS.md:42](PROBE-RESULTS.md).
- **Still needed:** Session-entry attribution policy, channel classification/report, drilldown to landing pages and conversions, and tests for SPA/session/campaign boundaries. Existing code appears to attach UTM values to each event rather than a defined session entry.
- **Dependency:** #32 session/entry semantics for coherent landing-page reporting; #50 if campaign conversion analysis depends on custom events.
- **Next bounded task:** Decide and document whether attribution is pageview-scoped or session-entry-scoped, then implement one explicit channel mapping using current stored fields.

### [#32 Add content engagement reports for entry, exit, and page quality](https://github.com/baronunread/risulta/issues/32)

- **Current evidence:** Summary computes pageviews, visitors, and 30-minute visits in [src/store.js:165](src/store.js); top path reports cap at eight rows in [src/store.js:179](src/store.js). No entry/exit, bounce, or duration metric was found. Issue references to `lib/db.js` and `lib/views.js` are stale for this source tree.
- **Still needed:** Entry/exit definitions, bounce and duration semantics, full-list report behavior, SPA and date-boundary behavior, metric docs, and relevant tests. Session journeys are a separate in-progress issue (#54) and are not verified here.
- **Dependency:** #54 journey/session grouping can inform definitions; #9 rollups if scale requires aggregation.
- **Next bounded task:** Define entry, exit, bounce, and duration precisely for current visitor/time events, including range-boundary behavior, before adding report queries.

### [#34 Add privacy-preserving audience dimension reports](https://github.com/baronunread/risulta/issues/34)

- **Current evidence:** Event schema stores a visitor hash and UTM fields, but no device/browser/OS or geographic columns at [src/store.js:52](src/store.js). Visitor identity hashes request inputs at [src/store.js:153](src/store.js); no audience derivation or report dimension was found.
- **Still needed:** Coarse UA classification, privacy decision on screen size, optional GeoIP boundary, no raw identifying storage/logging proof, dimension filters/reports, retention/deletion/fallback rules, and tests.
- **Dependency:** #2 for schema migration; #35 for report filtering surface.
- **Next bounded task:** Select a bounded UA parser/classification strategy and document stored categories and unknown-value behavior without adding GeoIP yet.

### [#35 Add analytics filtering, drilldowns, export, and API access](https://github.com/baronunread/risulta/issues/35)

- **Current evidence:** HTML reports provide path/source/medium/campaign/event dimensions, filters, pagination, and CSV links at [src/views.js:283](src/views.js); authenticated site-scoped stats and report routes are at [src/index.js:769](src/index.js) and [src/index.js:783](src/index.js). This supersedes the issue's old claim that no stats API or report exports exist.
- **Still needed:** Dashboard-wide combined segmentation and clickable row drilldowns, sorting evidence, audience/goal dimensions as they become available, bounded API query behavior and documented response contract. Current API authorization is session-based; #51 tracks API-key access.
- **Dependency:** #31/#34 dimensions; #51 external API key work.
- **Next bounded task:** Add one report-row link that carries the current range and applies that row's dimension as a dashboard filter, after defining dashboard filter semantics.

### [#42 Live dashboard without polling (SSE)](https://github.com/baronunread/risulta/issues/42)

- **Current evidence:** Dashboard explicitly polls the server-rendered fragment every five seconds at [src/views.js:207](src/views.js), and the route is [src/index.js:742](src/index.js). Probe notes report polling was browser-proven at [PROBE-RESULTS.md:63](PROBE-RESULTS.md). Issue itself says upstream streaming capability is a blocker.
- **Still needed:** Upstream handler, broker delivery, and ReadableStream support called out in the issue, then an SSE implementation with reconnect and delivery verification.
- **Dependency:** `sproutboat#152`, `sproutboat#149`, and runtime stream support per issue description.
- **Next bounded task:** Recheck those upstream capability items; until available, keep polling as the documented behavior and do not start an app-level stream rewrite.

### [#43 Historical event import from a Bun deployment](https://github.com/baronunread/risulta/issues/43)

- **Current evidence:** Current schema is a single D1 database with `site_id`-scoped event rows at [src/store.js:49](src/store.js), so the issue's D1 wording applies, while its `lib/db.js`/Bun file layout is historical. Probe notes state historical events still need manual import at [PROBE-RESULTS.md:165](PROBE-RESULTS.md).
- **Still needed:** Offline importer mapping legacy `control.db` site inventory and `sites/<id>.db` event rows into current schema, with copy-then-import docs and validation of IDs, attribution, timestamps, and counts. User/session import remains out of scope per issue.
- **Dependency:** #2 migration/current schema definition; #1 backup of source and destination.
- **Next bounded task:** Document the exact legacy and current columns and create a dry-run importer plan that reports per-site row counts before writing.

### [#44 Revert runtime workarounds when upstream fixes land](https://github.com/baronunread/risulta/issues/44)

- **Current evidence:** Integer date conversion remains in [src/util.js:236](src/util.js), `normalize: false` remains in [src/avatar.js:21](src/avatar.js), and async return workarounds are described in [PROBE-RESULTS.md:83](PROBE-RESULTS.md). The linked upstream fixes are not verified by this source inspection.
- **Still needed:** Confirm each upstream fix ships in the chosen toolchain, remove only the corresponding workaround, and verify standalone behavior for each change.
- **Dependency:** Upstream fixes `sproutboat#168` and `sproutboat#169`, plus String normalization support.
- **Next bounded task:** Check current runtime release notes and a minimal isolated probe for one workaround, then remove it only when that probe passes.

### [#45 Consider Tailwind for the dashboard CSS](https://github.com/baronunread/risulta/issues/45)

- **Current evidence:** Dashboard styles remain in a compact static [public/style.css](public/style.css); README describes the standalone binary and server-rendered dashboard at [README.md:5](README.md). The issue's own current take is to defer Tailwind unless a concrete maintenance pain appears.
- **Still needed:** No product acceptance work is defined. Revisit only if a specific styling maintenance problem justifies a build dependency and revised standalone asset flow.
- **Dependency:** A demonstrated CSS maintenance need.
- **Next bounded task:** Leave implementation idle; if class-string maintenance is the pain, scope that smaller issue with examples before choosing tooling.

### [#47 Expose POST /api/backup in the dashboard (currently API-only)](https://github.com/baronunread/risulta/issues/47)

- **Implemented:** The admin users page exposes a CSRF-protected backup form with accessible browser feedback and a native form fallback. The existing JSON endpoint remains available.
- **Evidence:** `tests/backup-ui-test.mjs` covers rendering, browser submission, authorization, CSRF, and HTML/JSON outcomes. `tests/features-integration.py` exercises the real binary over HTTP.
- **Next step:** Validate the integrated release artifact on Linux and review the button in the deployed dashboard before closing the issue.

### [#48 Geo map: country/city from local GeoLite2 lookup](https://github.com/baronunread/risulta/issues/48)

- **Current evidence:** Visitor IP is used for hashing and not stored at [src/store.js:153](src/store.js); no GeoLite2 data binding, country/city fields, or map report was found. This matches the privacy constraints in the issue, but does not implement the feature.
- **Still needed:** Local offline database packaging/update boundary, country/city lookup and schema, privacy retention, report dimension and map, fallback behavior, and tests. Confirm licensing and distribution constraints for any GeoLite2 database separately.
- **Dependency:** #2 migration framework; deployment packaging decision.
- **Next bounded task:** Write a short data-source and licensing decision for a local GeoIP database before implementing lookups or schema changes.

### [#49 2FA (TOTP) on the existing password/session auth](https://github.com/baronunread/risulta/issues/49)

- **Current evidence:** Existing password/session/CSRF flow is in [src/index.js:311](src/index.js) and [src/auth.js](src/auth.js); no TOTP secret, challenge, or recovery-code table/flow was found.
- **Still needed:** Enrollment and secret protection, login verification, recovery codes, lockout/re-enrollment behavior, viewer/admin coverage, and tests without weakening session/CSRF protections.
- **Dependency:** #2 for schema versioning; #3 account recovery/session lifecycle decisions.
- **Next bounded task:** Define enrollment, recovery, and lost-device state transitions before adding a TOTP dependency or table.

### [#50 Custom events: name + optional properties](https://github.com/baronunread/risulta/issues/50)

- **Current evidence:** Event names are validated by [src/domain.js:20](src/domain.js), event rows store `name` and optional numeric `value` at [src/store.js:52](src/store.js), and the tracker exposes `window.risulta.track` in [src/views.js:11](src/views.js). Arbitrary names appear supported, but arbitrary key/value properties are not represented in the schema or ingest path.
- **Still needed:** Bounded optional properties, safe normalization and storage/query semantics, report/funnel use, and tests. Do not treat the existing numeric `value` as property support.
- **Dependency:** #2 migration framework; #54 journey reporting may consume named events.
- **Next bounded task:** Choose a strict size/key/value schema for event properties and specify which report query will use it before changing ingestion.

### [#51 Promote stats/report endpoints to an authenticated read API with API keys](https://github.com/baronunread/risulta/issues/51)

- **Implemented:** Admin session/CSRF-protected create, list and revoke endpoints manage site-scoped read keys. Only SHA-256 hashes are retained, secrets are returned once, and bearer credentials authorize only GET stats/report for their site. Report limits and date bounds apply identically to session and key callers. README documents usage.
- **Evidence:** `tests/read-api-test.mjs` exercises the production router and SQL against SQLite; `tests/features-integration.py` verifies native-runtime hashing, read-only access, isolation and revocation.
- **Next step:** Validate the integrated release artifact on Linux. A dashboard management UI is a later usability improvement, not included in this first API implementation.

### [#52 Public live-visitor badge endpoint](https://github.com/baronunread/risulta/issues/52)

- **Current evidence:** `siteCurrent` computes a site's current count at [src/store.js:173](src/store.js), but no unauthenticated CORS route or SVG/JSON badge endpoint was found in [src/index.js](src/index.js).
- **Still needed:** Public-key-to-site lookup, narrowly scoped response, CORS/cache policy, invalid-key behavior, and an embedding example. Confirm the endpoint cannot expose broader site data.
- **Dependency:** None; coordinate route policy with #51 if API auth middleware is shared.
- **Next bounded task:** Add a read-only route keyed by public site key that returns only the current count and test its CORS and response shape.

### [#53 Chart annotations](https://github.com/baronunread/risulta/issues/53)

- **Current evidence:** Dashboard chart and date series are rendered by [src/views.js:108](src/views.js) and [src/chart.js](src/chart.js). No annotation table, CRUD routes, or chart markers were found.
- **Still needed:** Site-scoped annotation schema and migration, admin write controls with CSRF, marker rendering/tooltips, edit/delete behavior, date boundaries, and visual/runtime evidence.
- **Dependency:** #2 migration framework; chart coordinate/date mapping in current chart implementation.
- **Next bounded task:** Define annotation timestamp timezone and text limits, then add site-scoped CRUD before integrating markers.

### [#54 Per-visitor session journeys](https://github.com/baronunread/risulta/issues/54)

- **Implemented:** `src/journeys.js` derives session journeys from existing events, with a 10,000-event scan cap, bounded pagination, visitor filtering before scanning, and event-ID ordering for equal timestamps. Authenticated JSON and server-rendered routes enforce site permissions; reports link to the journey view. Sessions split after gaps over 30 minutes and at UTC midnight. No storage was added.
- **Evidence:** `tests/journeys-test.mjs` covers grouping and query bounds; `tests/features-integration.py` exercises site/viewer isolation, ties, gaps and the rendered drilldown on the native binary.
- **Next step:** Validate the integrated release artifact on Linux and inspect the rendered report before closing the issue.
