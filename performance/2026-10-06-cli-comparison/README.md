# Sproutboat 0.11.11 versus 0.15.0

Measured 2026-10-06 on an Apple M1, 16 GiB RAM, macOS 15.3.1, Bun 1.4.1.
Both executables are native darwin-arm64 standalone builds. The application
source and application dependency versions match; only the CLI/toolchain
differs. Source includes the current login-prefix and CSV compatibility
fixes, so this isolates the toolchain rather than comparing different app
implementations. This is a local baseline, not a production capacity claim.

## Results

Each entry is the median of three runs. Latency percentiles are medians
of per-run percentiles, not pooled request samples. MB below means decimal
MB; RSS values are MiB, although the raw benchmark field is named `rss_mb`.

| Metric, concurrency 25 | 0.11.11 | 0.15.0 | Change |
| --- | ---: | ---: | ---: |
| Accepted ingest requests/second | 4,128 | 5,841 | +41.5% |
| Ingest p50 | 4.99 ms | 3.50 ms | -29.9% |
| Ingest p95 | 10.06 ms | 6.99 ms | -30.5% |
| Ingest p99 | 16.05 ms | 11.41 ms | -28.9% |
| RSS after ingest | 67.0 MiB | 26.5 MiB | -60.4% |
| First successful login | 74.78 ms | 76.60 ms | +2.4% |
| Startup to health response | 96 ms | 98 ms | +2.1% |
| Dashboard p50, 1,000 stored events | 4.62 ms | 4.71 ms | +1.9% |
| Dashboard p95, 1,000 stored events | 5.44 ms | 9.56 ms | +75.7% |
| Executable size | 4.935 MB | 4.459 MB | -9.6% |

At concurrency 1, median ingest improved from 2,969 to 4,845 RPS
(+63.2%), and loaded RSS decreased from 66.6 to 21.9 MiB. Median
ingest p95 decreased from 0.89 to 0.33 ms.

The main result is faster ingest and substantially lower loaded memory.
Login and startup are effectively similar in these short runs. Dashboard
reads show no consistent improvement: concurrency-1 runs favored 0.15.0,
while the concurrency-25 group had worse dashboard tail samples. Dashboard
measurement occurs before the load phase in both groups, so the latter
is not evidence of concurrency causing a read regression. Each dashboard
sample has only 30 measured reads; a longer, dedicated read benchmark is
needed to distinguish tail regression from workstation noise.

Concurrency-25 throughput ranged from 3,530 to 4,738 RPS for 0.11.11 and
5,150 to 6,070 for 0.15.0. RSS was sampled once after each load phase,
not tracked as a peak; the two binaries completed different numbers of
events in the fixed time. These are fresh-process, fresh-database runs,
not sustained-load or large-dataset tests. No Linux runtime performance
measurement was performed.

## Method

- Three runs per version at concurrency 1 and 25, alternating version order
  across repetitions, one executable running at a time.
- Fresh temporary database and free loopback port for every run.
- Identical event body, trusted loopback proxy, 256 rotating test-net IPs.
  The normal 240/IP/minute ingest limit remains enabled and was not hit.
- Request logging disabled on both binaries to isolate application/runtime
  work; stdout ignored to prevent a filled pipe from stalling the server.
- Login, session lookup and site creation must succeed before measurement.
- 1,000 sequential accepted warmup events, then five dashboard warmup reads
  and 30 measured authenticated HTML dashboard reads.
- Five seconds of ingest at fixed concurrency. Every status must be 202
  and every response body is consumed.
- Authenticated stats must report exactly warmup plus completed events.
- Capture loaded RSS with `ps`, and tracker byte size after load.

Application dependencies: blobatar 2.7.0, cookie 2.0.1, hono 4.13.7,
valibot 1.5.0. The old CLI was installed in an isolated temporary project;
the repository remains on 0.15.0. Binary hashes and machine metadata are in
[machine.json](machine.json); all 12 measured samples are in
[results.json](results.json).

Run a sample with an already built native executable:

```sh
SPROUT_BENCH_BINARY=/absolute/path/to/risulta-sprout \
  CONCURRENCY=25 DURATION=5 \
  bun performance/2026-10-06-cli-comparison/benchmark.mjs
```

Repeat three times per version and concurrency, alternating order. Use
the same application source and dependencies when rebuilding each CLI.
The benchmark writes only disposable local state; it never targets a
deployed instance.

## Login verification

All 12 performance runs authenticated successfully and fetched protected
session, dashboard and stats endpoints. Independently, the 0.15.0 upgrade
passed 88 integration checks in each trusted/untrusted proxy configuration,
including wrong-password rejection, password changes, logout, H1 fixture
verification and Bun scrypt migration. Login works with the prefix
compatibility fix in the working tree; unmodified prefix checks failed on
the new runtime. See [PROBE-RESULTS.md](../../PROBE-RESULTS.md).
