# Native stats rollup benchmark

Compared merged TypeScript main (schema v2) with this branch (schema v3), using identical copies of the million-event local dataset. Five sequential requests per case, median wall time, native macOS builds on the same machine. These are local latency samples, not a throughput test.

| Request | TS main | Initial rollups | Optimized rollups |
| --- | ---: | ---: | ---: |
| Stats live | 1175.3 ms | 914.0 ms | 629.3 ms |
| Stats closed | 948.3 ms | 699.2 ms | 396.6 ms |
| Report live | 80.5 ms | 55.9 ms | 55.3 ms |
| Report closed | 60.8 ms | 28.9 ms | 35.0 ms |

All four complete API JSON responses matched both before backfill and after backfill. The worker rebuilt 900 site-days in 53.91 seconds. Migration preserves v2 daily coverage until the separate v3 summaries are ready.

Full stats retain raw ordered funnel queries, including the existing 50,000-event cap. Live-day and filtered queries also retain raw reads. This extension does not remove every source of query cost.

Goals HTML has an existing cache: its median was 1.1 ms in both builds, so repeated requests are not evidence of a rollup improvement. Cold first samples were 207.6 ms before and 181.0 ms after.

The optimized build adds a covering raw-event range index and calculates all funnel steps in a shared SQL pipeline. The prior query plan scanned the site without a timestamp range on its chosen covering index, then transferred up to 50,000 event objects into JavaScript. The new plan uses a timestamp range and returns only step totals and the truncation count. Complete optimized responses also match both previous builds. This is a fresh-response improvement without adding an API cache or dropping funnels. The index is installed transactionally by migration 3 and adds storage and event-write work.
