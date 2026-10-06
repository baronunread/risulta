"""Check scheduling, consistent restore, overlap and safe retention."""
import datetime as dt
import importlib.util
from pathlib import Path
import sqlite3
import tempfile

spec = importlib.util.spec_from_file_location('runner', Path(__file__).resolve().parents[1] / 'deploy/backup-runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

with tempfile.TemporaryDirectory(prefix='risulta-backup-test-') as scratch:
    root = Path(scratch)
    (root / 'd1').mkdir()
    database = root / 'd1/DB.sqlite'
    with sqlite3.connect(database) as db:
        db.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE backup_settings (id INTEGER PRIMARY KEY, frequency TEXT, hour INTEGER, minute INTEGER, retention INTEGER, runner_seen INTEGER);
        INSERT INTO backup_settings VALUES (1, 'off', 2, 0, 2, 0);
        CREATE TABLE backup_history (id INTEGER PRIMARY KEY, created_at INTEGER, kind TEXT, status TEXT, path TEXT DEFAULT '', bytes INTEGER DEFAULT 0);
        CREATE TABLE events (id INTEGER PRIMARY KEY, path TEXT);
        INSERT INTO events VALUES (1, '/東京'), (2, '/checkout');
        """)
    monday = dt.datetime(2026, 10, 5, 3, 0, tzinfo=dt.timezone.utc)
    assert runner.run(root, monday) == 'not due'
    with sqlite3.connect(database) as db:
        assert db.execute('SELECT runner_seen FROM backup_settings').fetchone()[0] == int(monday.timestamp())
        db.execute("UPDATE backup_settings SET frequency='daily'")
    assert runner.run(root, monday.replace(hour=1)) == 'not due'
    assert runner.run(root, monday) == 'backup created'
    assert runner.run(root, monday) == 'already backed up'
    snapshots = list((root / 'backups').glob('AUTO-*.sqlite'))
    assert len(snapshots) == 1 and snapshots[0].stat().st_mode & 0o077 == 0
    with sqlite3.connect(snapshots[0]) as restored:
        assert restored.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert restored.execute('SELECT path FROM events ORDER BY id').fetchall() == [('/東京',), ('/checkout',)]
    manual = root / 'backups/manual.sqlite'
    manual.write_bytes(b'keep me')
    outside = root / 'outside.sqlite'
    outside.write_bytes(b'keep me too')
    with sqlite3.connect(database) as db:
        db.execute("INSERT INTO backup_history (created_at,kind,status,path,bytes) VALUES (0,'scheduled','success',?,1)", (str(outside),))
        db.execute("INSERT INTO backup_history (created_at,kind,status,path,bytes) VALUES (0,'manual','success',?,1)", (str(manual),))
    for day in (1, 2, 3):
        assert runner.run(root, monday + dt.timedelta(days=day)) == 'backup created'
    assert len(list((root / 'backups').glob('AUTO-*.sqlite'))) == 2
    assert manual.exists() and outside.exists()
    with sqlite3.connect(database) as db:
        db.execute("UPDATE backup_settings SET frequency='weekly'")
    assert runner.run(root, monday + dt.timedelta(days=4)) == 'not due'
    assert runner.run(root, monday + dt.timedelta(days=7)) == 'backup created'
    with (root / '.backup-runner.lock').open('a') as lock:
        runner.fcntl.flock(lock, runner.fcntl.LOCK_EX | runner.fcntl.LOCK_NB)
        assert runner.run(root, monday + dt.timedelta(days=14)) == 'busy'
    with sqlite3.connect(database) as db:
        db.execute('UPDATE backup_settings SET retention=0')
    try:
        runner.run(root, monday)
        raise AssertionError('invalid preferences accepted')
    except RuntimeError:
        pass
print('backup schedule OK (due time, once daily, weekly, WAL restore, private files, overlap, safe retention)')
