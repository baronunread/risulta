"""Compare removed Python workers with an isolated native benchmark binary.
Python is only a development harness, never a production dependency.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--fixture', required=True, type=Path)
parser.add_argument('--binary', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--mode', choices=['all', 'rollup-bounded'], default='all')
args = parser.parse_args()
reference = Path(__file__).resolve().parent / 'python-reference'
binary = args.binary.resolve(strict=True)
args.output.mkdir(parents=True, exist_ok=True)
mac = sys.platform == 'darwin'
time_args = ['/usr/bin/time', '-l' if mac else '-v']

def copy_database(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(source) as src, sqlite3.connect(target) as dst:
        src.backup(dst)

with tempfile.TemporaryDirectory(prefix='risulta-worker-benchmark-') as scratch:
    root = Path(scratch)
    fixture = root / 'd1/DB.sqlite'
    copy_database(args.fixture.resolve(strict=True), fixture)
    with sqlite3.connect(fixture) as db:
        for table, in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'analytics_rollup_%'").fetchall():
            db.execute('DELETE FROM ' + table)
        events = db.execute('SELECT count(*) FROM events').fetchone()[0]
        now = (db.execute('SELECT max(ts) FROM events').fetchone()[0] // 86400 + 2) * 86400 + 7200
        db.execute("UPDATE backup_settings SET frequency='daily',hour=0,minute=0,retention=3")
        db.execute('DELETE FROM backup_history')
    # Production initializes these indexes in the web process before workers run.
    # Exclude this one-time startup/migration cost from both steady-state samples.
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    init_env = os.environ.copy()
    init_env.update(SB_DATA_DIR=str(root), PORT=str(port), RISULTA_LOG_LEVEL='silent', BENCH_MODE='initialize', BENCH_NOW=str(now), BENCH_DAYS='4')
    initialization = subprocess.run([str(binary)], env=init_env, capture_output=True, text=True, timeout=180)
    if initialization.returncode:
        raise RuntimeError(initialization.stdout + initialization.stderr)
    initialized = json.loads(next(line for line in (initialization.stdout + initialization.stderr).splitlines() if line.startswith('{')))
    assert initialized['result'] == 'initialized', 'Use the current benchmark binary'
    for implementation in ('python', 'native'):
        results = []
        for mode, count in [('rollup-full', 3), ('rollup-bounded', 5), ('backup', 3)]:
            if args.mode != 'all' and mode != args.mode:
                continue
            sample_now = now - 2 * 86400 if mode == 'rollup-bounded' else now
            for sample in range(count):
                state = root / (implementation + '-' + mode + '-' + str(sample))
                database = state / 'd1/DB.sqlite'
                copy_database(fixture, database)
                days = '1000' if mode == 'rollup-full' else '4'
                env = os.environ.copy()
                if implementation == 'python':
                    script = reference / ('backup-runner.py' if mode == 'backup' else 'rollup-runner.py')
                    code = "import importlib.util,sys,datetime;s=importlib.util.spec_from_file_location('worker',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
                    code += "print(m.run(sys.argv[2],now=datetime.datetime.fromtimestamp(int(sys.argv[3]),datetime.timezone.utc)))" if mode == 'backup' else "print(m.run(sys.argv[2],now=int(sys.argv[3]),max_days=int(sys.argv[4])))"
                    command = [sys.executable, '-c', code, str(script), str(state), str(sample_now), days]
                else:
                    with socket.socket() as probe:
                        probe.bind(('127.0.0.1', 0))
                        port = probe.getsockname()[1]
                    env.update(SB_DATA_DIR=str(state), PORT=str(port), RISULTA_LOG_LEVEL='silent', BENCH_MODE='backup' if mode == 'backup' else 'rollups', BENCH_NOW=str(sample_now), BENCH_DAYS=days)
                    command = [str(binary)]
                started = time.perf_counter()
                process = subprocess.run(time_args + command, env=env, capture_output=True, text=True, timeout=180)
                wall = time.perf_counter() - started
                if process.returncode:
                    raise RuntimeError(process.stdout + process.stderr)
                if mac:
                    rss = int(re.search(r'(\d+)\s+maximum resident set size', process.stderr)[1])
                    cpu = re.search(r'([\d.]+) user\s+([\d.]+) sys', process.stderr)
                    user, system = float(cpu[1]), float(cpu[2])
                else:
                    rss = int(re.search(r'Maximum resident set size \(kbytes\): (\d+)', process.stderr)[1]) * 1024
                    user = float(re.search(r'User time \(seconds\): ([\d.]+)', process.stderr)[1])
                    system = float(re.search(r'System time \(seconds\): ([\d.]+)', process.stderr)[1])
                result = process.stdout.strip() if implementation == 'python' else json.loads(next(line for line in (process.stdout + process.stderr).splitlines() if line.startswith('{')))['result']
                row = dict(mode=mode, sample=sample, now=sample_now, wall_s=wall, user_s=user, system_s=system, peak_rss_bytes=rss, result=result)
                results.append(row)
                print(implementation, json.dumps(row), flush=True)
                if sample == 0 and (mode == 'rollup-full' or args.mode != 'all'):
                    copy_database(database, root / (implementation + '-rolled.sqlite'))
                if mode == 'backup':
                    with sqlite3.connect(database) as db:
                        path = db.execute("SELECT path FROM backup_history WHERE kind='scheduled' AND status='success'").fetchone()[0]
                    with sqlite3.connect(path) as db:
                        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
                        assert db.execute('SELECT count(*) FROM events').fetchone()[0] == events
                    assert Path(path).stat().st_mode & 0o077 == 0
                shutil.rmtree(state)
        output_file = args.output / (implementation + '-results.json')
        if args.mode != 'all' and output_file.exists():
            previous = json.loads(output_file.read_text())['samples']
            results = [row for row in previous if row['mode'] != args.mode] + results
        output_file.write_text(json.dumps(dict(now=now, events=events, samples=results), indent=2) + '\n')
    with sqlite3.connect(root / 'python-rolled.sqlite') as python, sqlite3.connect(root / 'native-rolled.sqlite') as native:
        for table, in python.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'analytics_rollup_%'"):
            columns = len(python.execute('PRAGMA table_info(' + table + ')').fetchall())
            query = 'SELECT * FROM ' + table + ' ORDER BY ' + ','.join(str(i + 1) for i in range(columns))
            a, b = python.execute(query), native.execute(query)
            while True:
                old, new = a.fetchmany(10000), b.fetchmany(10000)
                assert old == new, table
                if not old:
                    break
        assert native.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    print('Exact rollup parity passed; measured snapshots passed restoration checks.', flush=True)
