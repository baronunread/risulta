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

## Persistent cache comparison

Schema 4 uses an isolated copy of the same million-event state. Five sequential requests per case; `fresh=1` bypasses caching. All cached and fresh API response bodies match the previous native build.

| Request | Fresh median | Cached median | First cache-enabled request |
| --- | ---: | ---: | ---: |
| Stats live | 589.4 ms | 2.3 ms | 1192.3 ms |
| Stats closed | 376.6 ms | 2.5 ms | 392.5 ms |
| Report live | 55.1 ms | 1.2 ms | 53.0 ms |
| Report closed | 30.5 ms | 1.6 ms | 34.4 ms |

A newly started binary process reused an existing closed-day SQLite entry in 3.9 ms, without rewriting it; its response matched a fresh query. Unseen/expired queries still calculate their results. Warm live results use process memory for at most five seconds, while closed-day entries survive restart for up to 24 hours. Event/configuration revisions invalidate changed results, including external SQLite writes. Current visitor counts remain fresh. Fresh-request variation between runs is not attributed to caching. Native integration covers fresh-event and historical-edit invalidation, persisted historical entries, bypass parity and revoked bearer access. No events were removed.
