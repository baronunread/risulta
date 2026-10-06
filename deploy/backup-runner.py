#!/usr/bin/env python3
"""Run scheduled SQLite snapshots using the preferences saved in Risulta."""
import argparse
from contextlib import closing
import datetime as dt
import fcntl
import os
from pathlib import Path
import secrets
import sqlite3
import time


def run(data_dir, now=None):
    root = Path(data_dir).resolve()
    database = root / 'd1/DB.sqlite'
    if not database.is_file():
        raise RuntimeError('Initialize Risulta before starting the backup runner.')
    now = now or dt.datetime.now(dt.timezone.utc)
    stamp = int(now.timestamp())
    os.umask(0o077)
    with (root / '.backup-runner.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 'busy'
        with closing(sqlite3.connect(database, timeout=30)) as source:
            setting = source.execute('SELECT frequency, hour, minute, retention FROM backup_settings WHERE id=1').fetchone()
            if not setting:
                raise RuntimeError('Initialize backup settings in Risulta first.')
            source.execute('UPDATE backup_settings SET runner_seen=? WHERE id=1', (stamp,))
            source.commit()
            frequency, hour, minute, retention = setting
            if frequency not in ('off', 'daily', 'weekly') or not (0 <= hour <= 23 and 0 <= minute <= 59 and 1 <= retention <= 90):
                raise RuntimeError('Invalid backup preferences.')
            if frequency == 'off' or (frequency == 'weekly' and now.weekday() != 0) or (now.hour, now.minute) < (hour, minute):
                return 'not due'
            last = source.execute("SELECT created_at FROM backup_history WHERE kind='scheduled' AND status='success' ORDER BY created_at DESC LIMIT 1").fetchone()
            midnight = int(now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
            if last and last[0] >= midnight:
                return 'already backed up'
            directory = root / 'backups'
            directory.mkdir(mode=0o700, exist_ok=True)
            filename = 'AUTO-' + now.strftime('%Y-%m-%dT%H-%M-%S') + '-' + secrets.token_hex(4) + '.sqlite'
            snapshot = directory / filename
            temporary = directory / (filename + '.partial')
            try:
                with closing(sqlite3.connect(temporary)) as target:
                    source.backup(target, pages=256)
                    if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                        raise RuntimeError('Backup integrity check failed.')
                with temporary.open('rb') as file:
                    os.fsync(file.fileno())
                temporary.replace(snapshot)
                source.execute("INSERT INTO backup_history (created_at, kind, status, path, bytes) VALUES (?, 'scheduled', 'success', ?, ?)",
                               (stamp, str(snapshot), snapshot.stat().st_size))
                source.commit()
            except Exception:
                temporary.unlink(missing_ok=True)
                source.execute("INSERT INTO backup_history (created_at, kind, status) VALUES (?, 'scheduled', 'failed')", (stamp,))
                source.commit()
                raise
            # Retention applies only to scheduled files recorded by this runner.
            old = source.execute("SELECT id, path FROM backup_history WHERE kind='scheduled' AND status='success' ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?", (retention,)).fetchall()
            for ident, path in old:
                candidate = Path(path)
                if candidate.parent.resolve() == directory.resolve() and candidate.name.startswith('AUTO-') and candidate.suffix == '.sqlite' and not candidate.is_symlink():
                    candidate.unlink(missing_ok=True)
                    source.execute('UPDATE backup_history SET status=? WHERE id=?', ('expired', ident))
            source.commit()
            return 'backup created'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', required=True)
    parser.add_argument('--watch', action='store_true', help='Check once a minute for a local preview; use a timer in production.')
    args = parser.parse_args()
    while True:
        try:
            result = run(args.data_dir)
            if result not in ('not due', 'already backed up'):
                print(result, flush=True)
        except Exception as error:
            print('Backup runner failed: ' + str(error), flush=True)
            if not args.watch:
                raise SystemExit(1)
        if not args.watch:
            break
        time.sleep(60)


if __name__ == '__main__':
    main()
