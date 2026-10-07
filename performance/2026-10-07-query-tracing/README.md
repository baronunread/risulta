# Native query tracing

Measured the current native standalone build against the isolated million-event dataset. Each case has five sequential administrator requests with `trace=1`. Every traced response, with its trace removed, matched a fresh untraced response. This is local latency profiling, not a production throughput test. Diagnostic planning adds work and timings have millisecond resolution.

| Case | HTTP | SQL | Plan collection | Serialization | Other analytics work |
| --- | ---: | ---: | ---: | ---: | ---: |
| Stats live | 442.2 ms | 434 ms | 3 ms | 1 ms | 0 ms |
| Stats closed | 131.6 ms | 124 ms | 3 ms | 1 ms | 0 ms |
| Stats 30 live | 853.9 ms | 845 ms | 5 ms | 1 ms | 0 ms |
| Traffic live | 38.4 ms | 37 ms | 1 ms | 0 ms | 0 ms |
| Report live | 108.4 ms | 104 ms | 0 ms | 1 ms | 0 ms |

SQL accounts for almost all measured latency. Serialization takes about one millisecond; other analytics code takes zero to one. Request-local trace timing starts after authorization/site lookup; HTTP timing includes those steps, diagnostic encoding and local transport. Individual query medians need not sum to the median total.

## Hot queries

For seven-day live stats, query medians were approximately 214 ms funnels, 53 ms goals, 44 ms top pages, 29 ms hourly, 18 ms live sessions and 9 ms exact visitor deduplication. Other acquisition queries also contribute. The thirty-day funnel query median was 473 ms in this run. Closed-day funnels measured 25 ms: their range is below the raw-event cap, so indexed name filtering can run immediately.

Plans show site/date range indexes being used. The capped funnel branch must select raw events ordered by visitor/time before pruning, then rank and group matches. SQLite uses temporary sorting structures for that work. Acquisition reports build temporary grouping, distinct-visitor and result-order structures. Live daily sessions and hourly statistics separately sort the live visitor/time stream to find session boundaries. The value-report query uses the existing event-name index without covering all selected columns, so a covering value index is a candidate for a measured experiment.

EXPLAIN QUERY PLAN describes potential branches, not actual row counts or execution counts. It shows both capped and uncapped funnel paths; data and timings establish which branch applies. Reported `rows` are returned rows, not scanned rows. Spans include synchronous database preparation/binding/execution and result decoding at the D1 boundary, rather than CPU stack samples from inside SQLite.

## Next candidates

1. Persist or precompute historical funnel progress for frequently requested ranges, with definition-change invalidation and exact cross-day ordering/cap semantics. This targets the largest query; adding daily funnel totals together would change results.
2. Share the live session-boundary calculation between daily and hourly stats. This avoids one repeated visitor/time sort, while keeping exact hourly unique visitor membership.
3. Measure a covering raw-event index that includes value for report/goal reads, and compare storage and ingestion cost before adopting it.

## Using tracing

Log in as an administrator, then request:

    /api/sites/1/stats?period=7&trace=1
    /api/sites/1/stats?period=7&include=traffic&trace=1
    /api/sites/1/report?period=7&dimension=path&trace=1

Tracing implicitly bypasses full-result and component caches. Responses add a `trace` object and `Server-Timing` metrics for database work, query plans, normal payload serialization and other analytics work. Each span includes a query category, a bounded SQL snippet, returned-row count, timings and bounded query-plan nodes with parent IDs. Bound parameters and returned values are not recorded. Trace collection is request-local: at most 64 query spans and 64 plan nodes per query. A missing plan does not prevent the original query from running. Viewer sessions and bearer read keys cannot enable tracing. Normal requests retain their existing response contract. CSV tracing returns 400; use the equivalent JSON report to inspect its query.

The trace is not stored in analytics result caches. Existing API responses remain private/no-store. No schema migration or extra service is required. Tests cover authorization, bounds, redaction, Unicode, query-plan fallback and native response parity.
