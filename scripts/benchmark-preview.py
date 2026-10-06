#!/usr/bin/env python3
"""Measure authenticated local preview responses without creating backups."""
import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import statistics
import time
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--base', default='http://127.0.0.1:8106')
parser.add_argument('--site', type=int, default=1)
parser.add_argument('--requests', type=int, default=5)
parser.add_argument('--output', type=Path)
args = parser.parse_args()
if urllib.parse.urlparse(args.base).hostname not in ('127.0.0.1', 'localhost', '::1'):
    parser.error('This benchmark is restricted to a local disposable preview.')
if not 1 <= args.requests <= 20:
    parser.error('Use between 1 and 20 requests per endpoint.')
client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
credentials = json.dumps({'email': os.getenv('RISULTA_BENCH_EMAIL', 'demo@example.com'),
                          'password': os.getenv('RISULTA_BENCH_PASSWORD', 'risulta-local-demo-2026')}).encode()
with client.open(urllib.request.Request(args.base + '/login', data=credentials,
                                       headers={'Content-Type': 'application/json'}), timeout=120) as response:
    login = json.load(response)
    if not login.get('ok'):
        raise RuntimeError('Preview login failed')
site = str(args.site)
paths = ['/', '/sites/' + site + '?period=30',
         '/sites/' + site + '/partials/live?period=30&metric=visits',
         '/api/sites/' + site + '/stats?period=30']
results = {}
for path in paths:
    timings = []
    for _ in range(args.requests):
        start = time.perf_counter()
        with client.open(args.base + path, timeout=120) as response:
            body = response.read()
            if urllib.parse.urlparse(response.url).path == '/login':
                raise RuntimeError('Benchmark session expired')
            if path.startswith('/api/'):
                data = json.loads(body)
                for series in ('byDay', 'byHour'):
                    if sum(int(row['visits']) for row in data[series]) != int(data['summary']['visits']):
                        raise RuntimeError('Visit series does not reconcile with summary')
        timings.append(round((time.perf_counter() - start) * 1000, 1))
    results[path] = {'requests_ms': timings, 'median_ms': statistics.median(timings)}
    print(path, results[path], flush=True)
if args.output:
    args.output.write_text(json.dumps(results, indent=2) + '\n')
