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
that interval. API reads remain fresh.

## Background processing

Release metadata advertises rollup_schema_version. The installer downloads
the worker, service and timer from the same pinned release and verifies their
checksums before replacing the binary. After health checks confirm the new
schema, it installs the worker in /usr/local/lib/risulta-sprout and enables
risulta-rollups.timer. Older releases without that metadata still work.

The timer runs once a minute and rebuilds up to four days, prioritizing recent
dates and rotating across sites. The worker uses Python 3's standard library,
already required by the installer. Backfill is outside startup.

A day's replacement rows and coverage marker publish in one transaction.
Interruption retains old rows and dirty markers; retry replaces rows without
double counting. Inserts, updates and deletes invalidate affected days,
including site/day moves and removal of a day's last event. Raw events remain
intact. A process lock prevents overlapping workers, and SQLite serializes
each write transaction against collection. Large days can briefly delay
collector writes; readers continue using the WAL.

Inspect processing with systemctl status risulta-rollups.timer and journalctl
-u risulta-rollups.service. For a larger initial backfill or local preview:

    python3 deploy/rollup-runner.py --data-dir /path/to/state --max-days 1000
    python3 deploy/rollup-runner.py --data-dir /path/to/state --watch

The worker requires schema version 3 and refuses to rebuild another version.

## Upgrade recovery

Before backup, the installer stops an active rollup timer/worker and then the
app. Backups retain the data directory, executable, configuration and existing
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
for Overview/Reports while hourly/event facts backfill. The new worker rebuilds
previously covered days in the same bounded batches and publishes both coverage
markers in the day's transaction. Existing dirty-day triggers apply to both
read paths. Incomplete stats coverage uses the previous raw stats query.

Pageview goal facts reuse the existing path summary. A new event table stores
only non-pageview counts and values by day, name, path and visitor. Goal edits
need no backfill: their current definitions query immutable event facts. Hour
rows preserve exact visitor membership across dates, including imported hashes,
and count session starts after inactivity within each UTC day. Custom events
participate in visits, and visits-only hours stay visible.

The release metadata and health header now advertise schema 3. The installer
continues to pause old workers and verify matching health before replacing and
resuming the worker. Previous schema-2 executables and workers reject the newer
schema; recovery requires the saved paired database and executable.
