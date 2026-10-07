# Navigation verification and rollup proposal

Local native build, million-event fixture (1,001,005 events), sequential
authenticated HTTP requests for shop, last 7 days. Times are samples in
milliseconds, not throughput benchmarks. OS page-cache state was not controlled.

| Page | Before first / repeat | After first / repeat |
| --- | --- | --- |
| Reports | 956 / 188 | 884 / 2 |
| Journeys | 233 / 355 | 207 / 2 |

Reports already return bounded LIMIT/OFFSET pages (maximum 100 rows).
Their exact total now comes from the same grouped query using a window count,
with a lightweight grouped-label count for offsets beyond the last page.
HTML report snapshots expire after 15 seconds and are bounded to eight report
variants per range, within the shared 32-range cache. API reads remain fresh.
Permission checks precede every cache read.

Site tabs use htmx 4 boosted navigation, selecting and synchronizing main only.
The shared document, header and assets remain loaded. All five tab headers
were checked in the final native build: navigation top was consistently
239 px at 1440 px width and 275 px at 320 px width, with scroll position
unchanged and no page overflow. Keyboard focus moves to the active tab, and
clipboard copying still succeeds after returning to Overview. Native links still work
without JavaScript. Date descriptions use Today, Last N days or an explicit
date range; compact date choices remain Today, 7d and 30d.

## Proposed rollup PR

The cache is an interim improvement. Cold requests still aggregate raw events.
Add persistent daily aggregates for unfiltered overview traffic and acquisition
before extending rollups to arbitrary filters.

1. Backfill completed UTC days in bounded, restartable batches. Store per-site
   daily pageviews, daily unique visitors and visit counts, plus per-day
   dimension totals for paths, sources, mediums and campaigns.
2. Keep daily visitors distinct within each dimension label. Never sum the
   counts of different labels to derive the site's visitor count. Visitor
   hashes usually reset daily, but imported hashes can span dates. Preserve exact
   distinct membership across days rather than summing daily uniques.
3. Build visits with the existing 30-minute gap and UTC midnight rules, including
   custom events in visit boundaries. Validate against the raw session query.
4. Read completed days from rollups and today's data from raw events. Route
   filtered visitor cohorts, journeys and funnels through the existing queries
   initially. A source cohort includes the visitor's later pages and events;
   per-source counters alone cannot represent that behavior.
5. Publish a day's rollups and its coverage marker atomically. Fall back to raw
   data for uncovered days. Rebuild affected days after imports or historical
   data changes. An interrupted or repeated backfill must not double counts.
6. Test raw/rollup parity across midnight, repeat visitors, session gaps,
   direct traffic, multiple source labels and empty days. Benchmark cold reads,
   ingestion overhead, storage size and concurrent collection.

## Suggested review boundaries

- Query performance: covering index, grouped goal queries, bounded snapshots,
  single-pass report pagination and cache isolation/expiry tests.
- Site structure: slug migration, canonical redirects, permissions, dedicated
  Goals/Funnels pages, direct tracker copying and form validation.
- Interface: chart inspection and comparisons, consistent headers, boosted
  navigation, separate acquisition cards and card-header detail links.
- Rollups: a separate follow-up with parity and ingestion benchmarks.

The UI review boundaries are published in PRs #55 through #58. The rollup
follow-up implements this proposal with exact visitor membership; see
[rollup results](rollup-results.md) and the linked migration instructions.
