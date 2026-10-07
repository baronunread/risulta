#!/usr/bin/env python3
"""Build completed-day analytics summaries without scanning on web requests."""
import argparse
from contextlib import closing
import fcntl
import os
from pathlib import Path
import sqlite3
import time

DAY = 86400
DIMENSIONS = [('path', 'path'), ('source', "coalesce(nullif(source,''),'Direct / None')"),
              ('medium', "coalesce(nullif(medium,''),'None')"), ('campaign', "coalesce(nullif(campaign,''),'None')")]


def build_day(db, site_id, day, now):
    if day % DAY or day + DAY > (now // DAY) * DAY:
        raise ValueError('Only completed UTC days can be rolled up.')
    db.execute('BEGIN IMMEDIATE')
    try:
        db.execute('DELETE FROM analytics_rollup_visitors WHERE site_id=? AND day=?', (site_id, day))
        for dimension, _ in DIMENSIONS:
            db.execute('DELETE FROM analytics_rollup_dimensions WHERE site_id=? AND dimension=? AND day=?', (site_id, dimension, day))
        db.execute('''INSERT INTO analytics_rollup_visitors
            WITH marked AS (SELECT visitor, name, ts,
                lag(ts) OVER (PARTITION BY visitor ORDER BY ts,id) AS previous
                FROM events WHERE site_id=? AND ts>=? AND ts<?)
            SELECT ?, ?, visitor, sum(name='pageview'),
                sum(CASE WHEN visitor!='' AND (previous IS NULL OR ts-previous>1800) THEN 1 ELSE 0 END)
            FROM marked GROUP BY visitor''', (site_id, day, day + DAY, site_id, day))
        for dimension, expression in DIMENSIONS:
            db.execute('''INSERT INTO analytics_rollup_dimensions
                SELECT ?, ?, ?, ''' + expression + ''', visitor, count(*), coalesce(sum(value),0) FROM events
                WHERE site_id=? AND ts>=? AND ts<? AND name='pageview'
                GROUP BY ''' + expression + ', visitor', (site_id, day, dimension, site_id, day, day + DAY))
        db.execute('INSERT INTO analytics_rollup_days VALUES (?,?,?) ON CONFLICT(site_id,day) DO UPDATE SET built_at=excluded.built_at', (site_id, day, now))
        db.execute('DELETE FROM analytics_rollup_dirty WHERE site_id=? AND day=?', (site_id, day))
        db.commit()
    except BaseException:
        db.rollback()
        raise


def run(data_dir, now=None, max_days=4):
    root = Path(data_dir).resolve()
    database = root / 'd1/DB.sqlite'
    if not database.is_file():
        raise RuntimeError('Start the upgraded Risulta once before running rollups.')
    if not 1 <= max_days <= 1000:
        raise ValueError('max_days must be between 1 and 1000.')
    now = int(time.time() if now is None else now)
    today = (now // DAY) * DAY
    os.umask(0o077)
    with (root / '.rollup-runner.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        with closing(sqlite3.connect(database, timeout=5)) as db:
            version = db.execute('SELECT max(version) FROM schema_migrations').fetchone()[0]
            if version != 2:
                raise RuntimeError('This rollup runner requires schema version 2.')
            sites = db.execute('SELECT id, (SELECT min(ts) FROM events WHERE site_id=sites.id) FROM sites ORDER BY id').fetchall()
            built = 0
            queues = []
            for site_id, first in sites:
                covered = {row[0] for row in db.execute('SELECT day FROM analytics_rollup_days WHERE site_id=?', (site_id,))}
                dirty = {row[0] for row in db.execute('SELECT day FROM analytics_rollup_dirty WHERE site_id=? AND day<?', (site_id, today))}
                missing = [] if first is None else range((first // DAY) * DAY, today, DAY)
                # Dirty days come first, including dates whose last event was deleted.
                candidates = sorted(dirty, reverse=True) + sorted((day for day in missing if day not in covered and day not in dirty), reverse=True)
                queues.append((site_id, candidates))
            # Recent days first, round-robin across sites during initial backfill.
            while any(queue for _, queue in queues):
                for site_id, queue in queues:
                    if not queue:
                        continue
                    build_day(db, site_id, queue.pop(0), now)
                    built += 1
                    if built >= max_days:
                        return built
            return built


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', required=True)
    parser.add_argument('--max-days', type=int, default=4)
    parser.add_argument('--watch', action='store_true', help='Run once a minute; use a systemd timer in production.')
    args = parser.parse_args()
    while True:
        try:
            print(str(run(args.data_dir, max_days=args.max_days)) + ' days rebuilt', flush=True)
        except Exception as error:
            print('Rollup runner failed: ' + str(error), flush=True)
            if not args.watch:
                raise SystemExit(1)
        if not args.watch:
            return
        time.sleep(60)


if __name__ == '__main__':
    main()
