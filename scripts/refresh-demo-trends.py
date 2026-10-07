#!/usr/bin/env python3
"""Redistribute recent disposable demo traffic into distinct website trends."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import random
import sqlite3
import time
from demo_traffic import profile_for

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--data-dir', required=True)
args = parser.parse_args()
spec = importlib.util.spec_from_file_location('stress_seed', Path(__file__).with_name('stress-seed.py'))
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)
path, marker = seed.checked_paths(args.data_dir)
if not marker.is_file():
    parser.error('Only an explicitly stress-seeded disposable preview may be refreshed.')
now = int(time.time())
since = (now // 86400 - 6) * 86400
rng = random.Random(seed.SEED)
with sqlite3.connect(path, timeout=30) as db:
    sites = seed.require_initialized(db)
    before = db.execute('SELECT count(*) FROM events').fetchone()[0]
    db.execute('CREATE TEMP TABLE trend_moves(site_id INTEGER,visitor TEXT,day INTEGER,delta INTEGER,new_visitor TEXT,PRIMARY KEY(site_id,visitor,day)) WITHOUT ROWID')
    moves = []
    for index, (site_id, _, _) in enumerate(sites):
        groups = db.execute('SELECT visitor,cast(ts/86400 AS INTEGER),min(ts),max(ts) FROM events WHERE site_id=? AND ts>=? GROUP BY visitor,cast(ts/86400 AS INTEGER)', (site_id, since)).fetchall()
        for visitor, day, first, last in groups:
            target = since + rng.choices(range(7), weights=profile_for(index), k=1)[0] * 86400
            # A whole daily visitor group must fit before now without crossing midnight.
            if target == (now // 86400) * 86400 and last - first > now % 86400:
                target -= 86400
            delta = target - day * 86400
            if last + delta > now:
                delta -= last + delta - now
            assert target <= first + delta <= last + delta < target + 86400
            identity = hashlib.sha256(f'demo-trend:{site_id}:{target}:{day}:{visitor}'.encode()).hexdigest()[:24]
            moves.append((site_id, visitor, day, delta, identity))
    db.executemany('INSERT INTO trend_moves VALUES(?,?,?,?,?)', moves)
    db.execute('UPDATE events SET ts=ts+(SELECT delta FROM trend_moves m WHERE m.site_id=events.site_id AND m.visitor=events.visitor AND m.day=cast(events.ts/86400 AS INTEGER)),visitor=(SELECT new_visitor FROM trend_moves m WHERE m.site_id=events.site_id AND m.visitor=events.visitor AND m.day=cast(events.ts/86400 AS INTEGER)) WHERE ts>=?', (since,))
    assert db.execute('SELECT count(*) FROM events').fetchone()[0] == before
    assert db.execute('SELECT count(*) FROM events WHERE ts>?', (now,)).fetchone()[0] == 0
    db.commit()
    rows = db.execute("SELECT site_id,date(ts,'unixepoch'),count(DISTINCT visitor) FROM events WHERE ts>=? AND name='pageview' GROUP BY site_id,date(ts,'unixepoch') ORDER BY site_id,ts", (since,)).fetchall()
print(json.dumps({'events_preserved': before, 'visitor_groups_redistributed': len(moves), 'daily_visitors': rows}, indent=2))
