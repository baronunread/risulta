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

## Uncached queries and selective stats

A temporary instrumented host binary measured component wall time directly in the native runtime. Its warm medians were roughly 115 ms traffic/acquisition, 295 ms funnels, 34 ms hourly and 136 ms goals for the live range; closed-day medians were 58/211/9/82 ms. Instrumentation was removed from the final artifact. The recorded native component samples identify funnels as the largest remaining cost before this change.

The final sequential comparison ran after validation finished, using the preceding cache-enabled native binary and the final native artifact on equivalent million-event states. Each case has five samples. All requests use `fresh=1`, bypassing complete-result and historical-component caches; SQLite's own page cache can remain warm. This measures application-cache misses, not cold disk or throughput.

| Full request | Before | After |
| --- | ---: | ---: |
| Stats live | 659.6 ms | 400.7 ms |
| Stats closed | 352.3 ms | 126.3 ms |
| Report live | 51.9 ms | 68.5 ms |
| Report closed | 32.5 ms | 30.3 ms |

| Selective uncached request | Median |
| --- | ---: |
| Traffic live | 37.5 ms |
| Traffic closed | 7.5 ms |
| Traffic and hourly live | 68.1 ms |

Goal calculations now restrict event/path facts before aggregation and omit unused wildcard totals. Funnels count the raw stream in a single SQL snapshot: below the cap they filter by indexed event names immediately; at/above the cap they select the same ordered 50,000 raw events before pruning. This preserves sequential steps, repeated steps and truncation without transferring the event stream into JavaScript. Hourly summaries are not calculated twice.

Completed-day traffic totals and daily rows persist separately from the full live response, so new live events reuse them. Cross-day unique visitors still use an exact historical/live membership query, rather than summing daily unique counts. `fresh=1` bypasses this component cache too.

All complete response bodies matched before/after for seven-day and thirty-day ranges. The thirty-day cases exercise the capped funnel branch (both report truncation). Their before/after medians were 1015.8/712.4 ms live and 769.8/530.3 ms closed. Full large-range requests remain materially slower than traffic-only requests.
