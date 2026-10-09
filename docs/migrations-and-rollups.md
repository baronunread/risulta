# Upgrades and daily rollups

Schema upgrades run automatically at startup. Databases from v0.1.6 and earlier
nightlies retain site IDs, public tracker keys, accounts, password hashes,
sessions and raw events. Empty databases follow the same path after core
table creation.

| Schema version | Change |
| --- | --- |
| 1 | Stable site slugs and their unique index |
| 2 | Completed-day summaries, coverage and invalidation triggers |
| 3 | Hourly traffic, custom-event goal facts and separate stats coverage |
| 4 | Persistent analytics cache and event/configuration revision triggers |
| 5 | Ordered covering funnel index |
| 6 | Opt-in public widget settings |
| 7 | Site-owned chart annotations |

Each migration and its schema_migrations marker commit atomically. Failed
steps roll back and retry at the next start; completed steps are not replayed.
Databases newer than the binary supports are rejected. Core table/index
creation remains idempotent for releases without a ledger. Health checks
preserve the existing response body and advertise x-risulta-schema-version
only after initialization. Backup manifests include that version and rollups.

## Reads and exactness

Unfiltered Overview totals, daily charts, comparisons and paginated Reports
for paths, sources, mediums and campaigns read completed UTC days from
summaries. Today's data and partial final days remain live. Filtered visitor
cohorts, Events reports, overview goal previews, funnels and journeys keep
their raw-event queries. Fresh stats API traffic/hourly breakdowns and goals,
plus unfiltered acquisition JSON/CSV reports and the dedicated Goals page,
use clean completed-day facts with a live tail. API reads do not use HTML
snapshots. Funnel results in the full stats response still use the ordered
raw-event query with its existing 50,000-event cap and truncation flag.

Visitor membership remains distinct across days and labels, even for imported
hashes that do not reset daily. Visits include custom events and retain the
30-minute inactivity rule and UTC midnight boundary. Reports preserve values,
sorting, exact totals and pagination.

Every completed day in a range must have clean coverage, otherwise the read
falls back to raw events. HTML snapshots still expire after 15 seconds (goal
previews after 60), so warm pages can lag mutations or completed backfill by
that interval. Stats and report result caching is described below; `fresh=1` bypasses it.

## Background processing

Release metadata advertises `rollup_schema_version` and `builtin_maintenance`.
After matching schema and maintenance health checks, the installer disables old
external worker timers. No Python runtime or separate worker package is needed.

Every minute the web process starts a separate process of the same executable,
with fresh SQLite connections. Only one maintenance child runs at a time. It
checks the saved backup schedule and processes up to four completed site-days,
prioritizing recent dirty days and rotating across sites. Backfill is outside
startup. Inspect errors with `journalctl -u risulta-sprout`.

A day's replacement rows and coverage markers publish in one transaction.
Interruption retains old rows and dirty markers; retry replaces rows without
double counting. Inserts, updates and deletes invalidate affected days,
including site/day moves and removal of a day's last event. Raw events remain
intact. SQLite serializes writes against collection. Large days can briefly
delay collector writes; readers continue using WAL. Backups run in the child
so snapshot I/O does not occupy the web process event loop.

## Upgrade recovery

Before backup, the installer stops active external backup and rollup timers
and workers, then the app. Backups retain the data directory, executable, configuration and existing
worker/unit files. They include the ledger and all rollup tables.

Success resumes processing. Backup failure before executable replacement
resumes the previous app/timer. Startup or schema failure after replacement
keeps all writers stopped and does not advance release state. Restore the
complete saved data directory and its paired executable, configuration and
worker/unit files before restarting. Do not restore individual tables or copy
an open database without its WAL. Rollups can be rebuilt from retained events.

Tests cover legacy adoption, empty schemas, restart, migration rollback/retry,
future versions, partial/failed backfills, raw parity, exact identities,
pagination/sorting/values, site isolation, empty days, midnight, session gaps,
custom-event-only visits, historical mutations and installer recovery.

## Upgrading daily rollups from schema 2

Schema 3 adds tables without rewriting events or existing daily summaries.
The stats coverage table is separate, so old daily coverage remains available
for Overview/Reports while hourly/event facts backfill. The built-in maintenance process rebuilds
previously covered days in the same bounded batches and publishes both coverage
markers in the day's transaction. Existing dirty-day triggers apply to both
read paths. Incomplete stats coverage uses the previous raw stats query.

Pageview goal facts reuse the existing path summary. A new event table stores
only non-pageview counts and values by day, name, path and visitor. Goal edits
need no backfill: their current definitions query immutable event facts. Hour
rows preserve exact visitor membership across dates, including imported hashes,
and count session starts after inactivity within each UTC day. Custom events
participate in visits, and visits-only hours stay visible.

Current metadata and the health header advertise schema 7. The installer
verifies matching schema and built-in maintenance health. Previous binaries
reject newer schemas; recovery requires the saved paired database and executable.

Migration 3 also adds `idx_events_site_ts_funnels`, a covering index on site, timestamp, visitor, event name and path. Funnel calculations keep their capped ordered raw stream inside SQLite and return aggregate step counts, preserving repeated-step behavior and the truncation flag. This index adds storage and maintenance on event writes; no raw events are removed.

## Persistent result caching (schema 4)

Authorized stats API and acquisition reports share calculated results. Completed historical ranges are cached in SQLite for up to 24 hours, surviving a binary restart. Live ranges use a bounded five-second process cache. Current visitor counts are read fresh, even on a historical stats cache hit. HTML acquisition reports share the same cache as their JSON/CSV counterparts. Existing Overview, Goals and Journeys snapshots retain their previous lifetimes.

Every lookup checks per-day event revisions and the site's goal/funnel configuration revision. SQLite triggers track inserts, updates and deletes, including external imports and site/day moves. New traffic outside a historical range does not invalidate that range. The worker can replace rollup facts without invalidating results because raw and rolled calculations are equivalent. Authorization happens before each lookup; cached payloads contain analytics only, not sessions or bearer tokens. API responses keep `Cache-Control: no-store` for browser/proxy caches.

Append `fresh=1` to stats or report API requests to bypass both caches. Cache keys include site, range, report dimension, filters, pagination, sorting and cohort selection. Persistent and memory caches each retain at most 128 entries, and payloads over 262,144 characters are not stored. Persistent eviction retains the newest calculated entries. The first uncached request still computes the query; this does not precompute arbitrary reports. Cache/revision tables are included in backups. Data is retained indefinitely; no event retention or deletion policy is introduced.

Migration 4 is additive and transactional. Interrupted upgrades roll back the cache tables, triggers and migration marker together. The matching release binary requires at least schema 4; restore their paired backup to downgrade.

Historical traffic totals and daily rows are also cached as a separate component. A new live event invalidates the complete live result but preserves that historical component. Exact visitor membership is still deduplicated across the historical/live boundary. Uncovered or dirty historical ranges retain raw fallback. No additional schema migration is required for component caching or selective stats.

Stats requests may select optional `hourly`, `acquisition`, `goals` and `funnels` sections via `include`; traffic is always present, and omitting the parameter preserves the complete default response. Cache keys include this selection. `fresh=1` bypasses both the full-result and component caches. Funnel queries use a single SQLite snapshot to count the capped stream and choose between indexed name filtering below the cap and ordered capped selection before filtering at the cap. Pruned events still count toward truncation.

Administrator stats/report requests support `trace=1`. This bypasses full-result and component caches and returns request-local query timings and bounded SQLite query-plan trees, with no bound values in trace records. Normal requests retain the same contract. See [native query tracing](../performance/2026-10-07-query-tracing/README.md). No additional migration is needed.

## Ordered funnel index (schema 5)

Migration 5 adds `idx_events_site_visitor_ts_funnels` on site, visitor, timestamp, event name and path. Large funnel ranges read the existing 50,000-event cap in visitor/time order directly from the covering index, avoiding a full-range sort and event-table lookups. Small ranges retain the event-name/date index path. Funnel order, repeated steps and truncation are preserved.

The index is built transactionally during startup. This adds startup time, storage and index maintenance on ingestion; no events or rollup tables are removed. An interrupted build rolls back its migration marker and retries on restart. The release metadata, binary health header include schema 5 or later. Downgrades require restoring the paired pre-upgrade database and binary backup.


## Annotations (schema 7)

The annotations table is indexed by website and UTC date. Notes reference the
website with a cascading foreign key, and do not change events, rollups or
cached analytics. Every dashboard refresh reads its notes independently of
the analytics cache. Manual and scheduled database snapshots include them.
Migration 7 commits the table, index and ledger marker together. A failed
migration rolls back and retries on restart. Older schema-6 binaries reject
this database, so restore a complete paired recovery backup when downgrading.
