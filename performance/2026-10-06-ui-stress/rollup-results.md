# Daily rollup verification

Native macOS standalone build, local SQLite state copied through SQLite backup
from the preceding version without a migration ledger. Fixture: 1,001,005 raw
events. Requests were authenticated and sequential; OS page-cache state was
not controlled. First and immediate repeat samples are milliseconds, not a
throughput or production latency guarantee.

| Request | Before first / repeat | After first / repeat |
| --- | --- | --- |
| Overview, live last 7 days | 393 / 2 | 246 / 2 |
| Reports, live last 7 days | 1234 / 2 | 362 / 3 |
| Overview, September 30 through October 6 | 324 / 2 | 252 / 2 |
| Reports, September 30 through October 6 | 128 / 2 | 33 / 2 |

Live totals matched: 14,192 visitors, 15,192 visits, 37,877 pageviews.
Closed-range totals matched: 11,382 visitors, 12,143 visits, 30,363 pageviews.
All 1,001,005 raw events remained; SQLite integrity_check returned ok.

Backfill completed 900 site-days in 22.259 seconds, producing 241,236 visitor
rows and 1,325,317 dimension rows. Empty dates are included to prove coverage.
This fixture includes old import timestamps; normal installs process up to
four days per minute, rotating across sites and prioritizing recent dates.

Occupied database pages grew from 686.2 MB to 875.1 MB, approximately 189 MB
or 27.5%. The allocated file grew from 864.0 MB to 875.1 MB because existing
free pages were reused. That allocated-file difference understates storage
cost on a database without spare pages.

A five-sample batch microbenchmark of 1,000 inserts, rolled back after each
sample, measured approximately 28.6 ms with invalidation triggers versus
3.6 ms without them, or 25 microseconds per event. This excludes durable
commit costs and is not production ingestion throughput. Each completed-day
rebuild holds SQLite's writer lock and may briefly delay collection; WAL
readers continue. Raw queries handle current-day traffic, filters, goals,
funnels, journeys and API reads. HTML cache entries remain bounded and expire.

See [migration and recovery instructions](../../docs/migrations-and-rollups.md)
for schema versions, worker installation, backfill and paired restore rules.
