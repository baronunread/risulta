# Risulta UI stress test, 6 October 2026

Local standalone Sproutboat 0.15.0 build on the M1 development machine. The final Linux build also passed isolated validation on the production VPS. Its running service and analytics database were not modified by those tests.

## Dataset

`python3 scripts/stress-seed.py --data-dir /tmp/risulta-local-preview-20261006 --events 1000000`

The initialized demo database had five events. The seed added one million across ten sites and 90 days. Another 1,000 same-day returning visits were added to Shop to make the visitor/session distinction visible. Final count: 1,001,005 events, approximately 393 MiB on disk.

Includes twenty goals per site, two funnels per site, Unicode names and paths, paths up to 920 characters, campaign names up to 465 characters, acquisition dimensions and large purchase values. The seeder is deterministic relative to its run date, refuses repeat runs and only accepts disposable temporary preview directories. It preserves existing accounts and data.

## Failures and changes

- Visits had summary counts but no daily/hourly series, producing a flat empty chart. Both series now contain actual session starts. Sessions include custom events, split after more than 30 minutes and at UTC midnight, and remain site-specific.
- Twenty goals and funnels pushed useful page/source reports below the initial screen. The overview now shows three selectable metrics, one chart, top pages and sources. Campaigns are expandable; conversions have an on-demand report rather than running expensive funnel scans on every refresh.
- The previous 30-day dashboard occupied 3,264 CSS pixels on desktop and 4,503 on mobile. The first simplified iteration measured 1,650 and 2,054 respectively. The final mobile chart is taller and readable instead of a scaled-down desktop SVG.
- Historical date charts were anchored to today rather than the selected end date. They now use the selected range. Today and preset date ranges now start at UTC midnight, matching the displayed calendar days.
- Adding backup tables after initial account reads caused native SQLite startup locks on the large WAL database. Backup schema initialization now happens before those reads and only once per process. The large database starts normally.
- Long site names are contained in the header; the site menu wraps names and scrolls inside the viewport. No page overflow at 320 or 390 pixels.
- Numeric rounding in the native runtime produced malformed one-decimal backup sizes. UI values now round via integer tenths, including carry to the next integer.
- Expanded sections stay open across live refreshes.

## Backups

The administration page offers manual, daily and weekly schedules, UTC time, scheduled-copy retention, runner connection status and the last twenty attempts. The local runner is active with daily 02:00 UTC backups and retention of three scheduled copies.

The Python standard-library runner uses SQLite's online backup API, integrity checks, private file permissions, overlap locking and a safe retention policy. Manual snapshots are not removed. Both manual and scheduled large snapshots restored all 1,001,005 events and passed `PRAGMA integrity_check`.

The server runner is separate from the web process. Included systemd service/timer files or cron invoke it once per minute. Setup is described in `public/backup-setup.txt`. Production scheduling has not been installed. Snapshots remain on the server; off-server copying is separate. Old backup files are not deleted or imported into the new history automatically.

## Validation and remaining limits

- Lint, Sproutboat check and the full unit suite passed, including thirteen installer transaction scenarios.
- The exact native binary passed the existing 88 checks and 63 feature HTTP checks, each in both trusted and untrusted proxy modes.
- Scheduling tests cover due times, once-per-day behavior, Mondays, WAL restoration, overlap, retention and preserving unrelated/manual files.
- Automated accessibility checks found no violations on the backup and overview pages. SVG chart contrast was flagged for manual review; chart labels use the muted theme color, with contrast ratios of 5.74:1 in light mode and 8.13:1 in dark mode.
- Browser checks cover desktop, 390px and 320px layouts, menu overflow, empty states, schedule saving and preserving expanded sections across polling.
- Report pages cap at 100 rows. Journey scans cap at 10,000 events and show truncation explicitly. The HTML journey page defaults to ten visits; API defaults remain unchanged.
- Full stats retain goals and funnels for API compatibility. In this intentionally large dataset, their computations are still expensive. Initial measurements are in `results.json`: overview about 2.4 seconds, live fragment about 2.2 seconds, full 30-day stats about 3.6 seconds. After the performance changes, `optimized.json` records overview about 1.2 seconds, live fragment about 1.6 seconds and full stats about 2.7 seconds (three requests per endpoint). These are development observations with live refreshes and verification traffic, not an isolated throughput benchmark. Manual native snapshots take roughly six seconds at this size and block the web process during snapshot creation; scheduled snapshots run in the separate runner.

## Design references

- Plausible metrics: https://plausible.io/docs/metrics-definitions
- Plausible dashboard: https://plausible.io/docs/guided-tour
- Immich backup schedule and retention: https://docs.immich.app/administration/backup-and-restore/
- Matomo server-side backups: https://matomo.org/faq/how-to/how-do-i-backup-and-restore-the-matomo-data/

Before/after screenshots are in `screenshots/stress-ui/`.

## Home and performance follow-up

Home cards now have a consistent 204px minimum height, two-line names, contained domains and an accessible seven-day visitor sparkline. Full names and domains remain in the markup and title attributes. The home query batches authorized site traffic instead of calculating unused visit summaries per card. It returns seven ordered days including zeroes; viewer permissions are applied before aggregation.

The overview previously repeated the expensive session window query in the summary, daily chart and hourly chart. It now scans session starts once and shares the grouped results. A covering `(site_id, ts, visitor)` index avoids fetching large event rows just to read timestamps and visitor hashes. On this database, the standalone SQL session scan changed from 1,245ms to 149ms. The index is additive and increases disk usage; first startup on a large existing installation takes time to create it.

Reviewed all ten authenticated pages at 1440px and 320px. No page-level horizontal overflow was found; `page-layouts.json` captures checks, and screenshots show the visual review. Account and add-website forms use a narrower reading width. Settings use two columns with expandable configured goals/funnels. Reports use compact expandable labels, preserving full text and all export data. Long journeys initially show twelve events with the rest expandable; long paths expand separately. Conversion cards align at the top rather than stretching short funnels to the full goal list height.

Reproduce HTTP timing without snapshot side effects:

```sh
python3 scripts/benchmark-preview.py --output /tmp/risulta-preview-timings.json
```

This command only accepts a loopback preview. Default credentials are the disposable demo credentials; alternate preview credentials use `RISULTA_BENCH_EMAIL` and `RISULTA_BENCH_PASSWORD`. Background polling and concurrent tests affect results. These numbers are development latency observations, not production throughput measurements.

The final Linux x64 artifact passed 88 existing checks and 63 feature HTTP checks in both proxy modes in `/home/baronunread/risulta-nightly-validation.hHxAil` on the VPS. The nightly workflow now uses the CLI default build for Linux x64 and the explicit host build for native ARM.

Final five-request local observations after closing the automation browser are in `final-timings.json`: home 309ms, 30-day overview 1,159ms, live fragment 1,143ms, full stats 2,351ms. The full stats response also reconciled both visit series with the summary on each request. Earlier and later measurements were not controlled throughput runs.

## Published nightly validation

The first nightly is [nightly-20261006-79e88c783332](https://github.com/baronunread/risulta/releases/tag/nightly-20261006-79e88c783332). Both static Linux x64 and ARM64 artifacts passed the native release tests. Normal CI passed as well, and GitHub's stable latest release remains v0.1.6.

The published x64 artifact was downloaded, checked against its checksum and exact commit metadata, then passed 88 existing checks and 63 feature HTTP checks in each proxy mode on the VPS. A first VPS attempt exposed a false failure in the rate-limit test: 300 requests straddled a minute boundary, with 169 and 131 requests in the adjacent windows. The harness now allows 481 requests (twice the 240-request limit plus one), stopping at the first 429. The limiter itself required no change.


### Visible overview reports (October 7)

The overview now shows five acquisition rows (Sources, Campaigns, Mediums tabs), five top pages, and five configured goals without expanding disclosures. Clicking a report row selects daily visitor identities with matching pageviews; combined filters intersect those identities, so a source can be combined with a page reached later. Filters carry through chart metrics, dates, comparison, polling, full reports, CSV exports, conversions and journeys.

Goal previews refresh independently every 60 seconds and remain in place during five-second traffic updates. The preview uses a bounded goal list and materialized matching events, without a full funnel scan. New overview tests cover cohort intersection, cross-site isolation, parameterized filters, zero-hit goals, session counts and journey scope. The full suite, lint, native check and host build passed. Browser checks covered login, source filtering, tabs, combined-filter comparisons, detailed report links, 320px layout, and preserving the goals node through traffic updates.

On the existing 1,001,005-event disposable dataset, one Bun/SQLite sample of the selected site's seven-day window (37,877 pageviews) measured approximately 1,348ms for initial analytics including goals and 566ms for traffic-only polling. These are local database timings, not HTTP benchmarks or isolated production throughput.

Screenshots: `screenshots/stress-ui/overview-visible-desktop.png` and `screenshots/stress-ui/overview-visible-mobile.png`.

Browser glue now uses the bundled htmx 4 event names and response context, restoring disclosure persistence and poll status handling.

### Overview interaction follow-up (2026-10-07)

Acquisition reports now switch locally using their already-loaded rows. Browser verification measured a 2.2 ms switch without replacing the document; Back restored the previous tab. Selection survives traffic refreshes. JavaScript-disabled links still navigate normally.

A covering event index replaces the narrower site/name/time index, avoiding repeated event-table lookups for overview aggregates. On the same million-event local database, before/after samples were 714/362 ms for initial overview queries and 718/227 ms for traffic-only queries. An empty source cohort was 1186/100 ms initially; a one-visitor path cohort was 1452/99 ms. These are database samples, not production HTTP benchmarks. The larger index adds storage and write work; it is created before the old index is removed.

Full overview polling now runs every 30 seconds, while goal previews retain their independent 60-second refresh. This reduces recurring aggregation load sixfold per open overview.

### Shared overview snapshots (2026-10-07)

Native HTTP measurements on the same dataset identified repeated aggregation as the remaining interaction cost: an overview response took 388 ms, a metric switch 346 ms, a Google-filtered overview 533 ms, and its traffic fragment 199 ms. Each request rebuilt essentially identical aggregates.

Overview routes now share bounded process-local snapshots (32 ranges/filters across DBs and sites). Traffic expires after 15 seconds and goal previews after 60 seconds. Authorization runs before every cache lookup. Goal/funnel creation invalidates the site's entries. Fixed date ranges and live ranges remain distinct; comparison queries are cached separately. Multi-day overviews skip unused hourly aggregation. Read APIs retain their existing fresh query behavior.

After rebuilding, native HTTP samples were: cold seven-day overview 348 ms; subsequent Visits/Pageviews changes 4/3 ms; cold Google-filtered overview 322 ms; filtered metric change 2 ms; warmed traffic and goal fragments 2 ms each. These are local sequential samples, not production concurrency guarantees. Cold aggregation still scales with the selected events.

Tests cover reuse, traffic and goal expiry, filter/site/database separation, bounded eviction, settings invalidation, retained hourly charts for Today, and goal preview preservation across traffic polling. Browser checks confirm filtered metrics of 1,793 visitors, 1,904 visits and 4,799 pageviews and prevent unauthenticated access to warmed snapshots.
