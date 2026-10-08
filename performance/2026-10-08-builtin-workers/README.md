# Built-in maintenance: Python versus standalone binary

Measured on 2026-10-08, on an Apple Silicon Mac using a disposable schema-5
preview database containing 1,001,005 events and 920 completed site-days.
The production VPS was not used for these benchmarks or changed.
The host ran macOS 15.3.1, Bun 1.4.1 and Python 3.13.5. Python used SQLite
3.49.1; the embedded native SQLite was 3.50.4. This compares the shipped
implementations and does not isolate interpreter cost from SQLite changes.

## What changed

Rollup SQL and scheduled-backup policy now run from the Risulta executable.
Every minute the server starts a fresh process of the same binary, with its
own SQLite connections. A running child prevents another child from starting.
This isolates snapshot I/O from the web process event loop. The web process
initializes schemas; a child refuses a mismatched schema and runs synchronously
before opening an HTTP listener. The child checks
backup preferences, then builds up to four completed site-days, and exits.

Release assets contain the executable, installer and metadata. Production
Python workers and their systemd units have been removed. The installer uses
POSIX awk for release JSON and disables old external maintenance timers after
checking the new binary's schema and maintenance health headers. Existing
worker files are only retained for recovery of older releases. The main
systemd service still owns the web process and its maintenance children.

Python remains in development fixtures, verification harnesses and the frozen
reference workers below. These files are not deployed or executed by Risulta.

## Measurements

Final results and resource counters are in `python-results.json` and
`native-results.json`. The Python version was measured first, before the native
version. Each sample uses a fresh SQLite copy with empty rollup tables and
backup history. Both implementations use the same fixed UTC timestamp for each workload.
The four-day samples use an earlier completed day with actual traffic; their
`now` fields record this timestamp. The source database occupies 1.24 GB,
including free pages left by cleared rollups. Both implementations copy the
same allocated layout, so backup timing includes these free pages.

Timing includes process startup, initialization, work and process exit.
Three samples cover a complete 920-day backfill and scheduled backup; five
cover the normal four-day batch. CPU time and peak process RSS come from
`/usr/bin/time`. The native benchmark executable uses the production
maintenance modules with a one-shot entry point. Its resource measurements
exclude the idle web parent. The fixture's schema was already upgraded, so
migration and first-admin bootstrap cost are excluded. The harness explicitly
initializes the copied fixture before either implementation is measured.
The full-backfill and snapshot fixture already contained the current indexes;
a check confirmed the initialization does not add missing event indexes.

| Work | Python median | Native median | Python / native CPU | Python / native peak RSS |
| --- | ---: | ---: | ---: | ---: |
| Full backfill, 920 site-days | 21.67 s | 20.75 s | 11.91 / 11.80 s | 29.8 / 42.4 MiB |
| Four populated site-days | 0.89 s | 0.84 s | 0.35 / 0.26 s | 23.6 / 18.9 MiB |
| Scheduled snapshot | 19.98 s | 20.86 s | 15.02 / 14.98 s | 22.1 / 17.7 MiB |

Final elapsed-time medians are close to the Python baseline. Full-backfill
peak memory increases; bounded batches and snapshots use less memory in the
isolated benchmark process. This does not measure combined web-parent and
maintenance-child RSS. One native full-backfill sample took 51.01 s, while the
other two took 20.75 s and 20.23 s. That spread limits any speed claim.

The initial native port deleted dimension facts using only site/day. The
primary key is (site, dimension, day, label, visitor), so that scanned existing
site summaries during backfill. Matching Python's four indexed dimension
queries reduced median backfill time from 27.70 s to 20.75 s. Initial results
are preserved in `native-initial-results.json`; populated batches and snapshots
were also remeasured after the correction. The recreated fixture has identical
event count and allocated page count (303,797 pages of 4,096 bytes).

These are local measurements, not a VPS throughput prediction. Filesystem and
OS caches were not flushed, background load was not controlled, and short
samples show scheduling noise. Full backfill exposes the native runtime's SQL
and allocation costs; removing an interpreter does not guarantee every task
gets faster. Production bounds work to four days per minute. SQLite writers
can still wait behind a large rollup transaction, even with a separate child.

## Correctness and responsiveness

Every column and row matched the Python output across all seven rollup tables:
920 coverage days, 920 statistics days, 250,270 visitor facts, 257,435 hourly
facts, 350,711 custom-event facts and 1,374,486 dimension facts. Neither version
left dirty days. Raw event count remained 1,001,005 and SQLite integrity passed.

Every native scheduled snapshot passed SQLite integrity and restored all
1,001,005 events. Snapshot permissions were 0600. Unit tests cover due time,
Monday schedules, once-per-day checks after restart, retention, symlink and
outside-directory protection, failure cleanup and retry. Rollup tests cover
mutations, exact identities, cross-site isolation, atomic replacement and raw
query parity.

A separate run used the full production binary, a due scheduled backup and
concurrent health requests every 100 ms. The backup completed; 350 successful
health responses had a maximum measured latency of 51.1 ms. This checks event
loop responsiveness during snapshot I/O, not sustained ingestion throughput.
The standalone integration suite also exercises native scheduled backups and
rollups, alongside login, authorization and report parity in both proxy modes.

## Reproduce

Use a disposable initialized schema-5 database. The harness only modifies its
own temporary copies. From the repository root, build an isolated benchmark:

```sh
benchmark_dir="$(mktemp -d /tmp/risulta-benchmark.XXXXXX)"
mkdir "$benchmark_dir/src"
ln -s "$PWD/src" "$benchmark_dir/src/app"
sed 's|../../src/|./app/|g' performance/2026-10-08-builtin-workers/worker-entry.js \
  > "$benchmark_dir/src/index.js"
cat > "$benchmark_dir/sproutboat.jsonc" <<'JSON'
{
  "name": "risulta-worker-benchmark",
  "main": "src/index.js",
  "compatibility_date": "2026-09-07",
  "d1_databases": ["DB"],
  "secrets": ["BENCH_MODE", "BENCH_NOW", "BENCH_DAYS", "RISULTA_LOG_LEVEL"]
}
JSON
node_modules/.bin/sproutboat build "$benchmark_dir" --standalone --target host
python3 performance/2026-10-08-builtin-workers/measure.py \
  --fixture /path/to/disposable/d1/DB.sqlite \
  --binary "$benchmark_dir/dist/risulta-worker-benchmark" \
  --output /tmp/risulta-benchmark-results
```

The recorded benchmark entry was validated on macOS. The harness parses macOS
`time -l` and Linux GNU `time -v` counters. Production workers use synchronous
startup, which is separately tested on Linux x64 and ARM64. The isolated
benchmark entry includes schema initialization overhead and differs from that
production startup path. It checks exact
rollup parity, snapshot integrity, event count and permissions after measuring.
The fixture is deliberately not committed because it contains over a million
synthetic events and is large. `python-reference/` freezes the deleted workers
from main commit `67485c0caf7e8d3fb7946f598347db6ba983a1a0` for comparison only.
