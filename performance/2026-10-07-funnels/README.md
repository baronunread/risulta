# Native uncached funnel optimization

The capped funnel path previously scanned and sorted the date range before taking 50,000 events. Schema 5 adds `idx_events_site_visitor_ts_funnels(site_id,visitor,ts,name,path)`. The capped query disables timestamp range index selection with unary `+ts`, so SQLite can read the ordered covering index until the cap. Its site lookup is gated by the counted branch, avoiding an unnecessary site-index scan below the cap. The uncapped event-name/date path remains available.

## Controlled comparison

Before: commit `6ae64e5`, native standalone host build on port 8119. After: final schema-5 native standalone host build on port 8121. Both processes read the same disposable million-event database; the experimental covering index is available to both, isolating the query change. The final executable builds the index through migration 5 on upgrade.

Seven sequential requests per version and range, alternating which version runs first. Requests use `trace=1`, bypassing whole-result and component caches. Complete response bodies with the diagnostic trace removed must match for every pair, including funnel steps and truncation. Final samples were collected after the test workloads finished. Timings are local measurements, not production guarantees.

| Range | Funnel before | Funnel after | Full stats before | Full stats after |
| --- | ---: | ---: | ---: | ---: |
| Live seven days | 205 ms | 59 ms | 431.7 ms | 299.2 ms |
| Live thirty days | 307 ms | 51 ms | 774.7 ms | 412.9 ms |
| Closed seven days | 25 ms | 21 ms | 126.1 ms | 124.6 ms |

Medians are calculated separately for funnel execution and HTTP duration. Query-plan trees and all samples are in `comparison.json`. The capped branch uses the covering visitor/time index and no longer sorts the entire raw range; ranking selected relevant events and aggregating funnel steps still use temporary structures. EXPLAIN plans describe possible branches rather than observed row counts.

## Upgrade and limits

The experimental index took approximately 3.95 seconds to build on the local dataset. Index creation adds startup time, disk space and event-write maintenance. Ingestion throughput and storage overhead are not benchmarked here. Very long site histories with sparse in-range events may require inspecting many out-of-range index entries before reaching the cap; the range index remains available for uncapped reads. No raw events are removed.

The 50,000-event cap, ordering, paths and repeated-step semantics remain unchanged. Tests cover mixed visitors, irrelevant events, timestamp ties, bounded/unbounded ranges, site isolation, transaction rollback/retry from schema 4, data preservation, and matching worker/release/health/backup metadata. Strict lint/typecheck, full tests and exact native verification pass, including 94 HTTP feature checks in both proxy modes.
