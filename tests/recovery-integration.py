"""Exercise a released binary's backup on a separate disposable instance."""
import http.cookiejar
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

base = os.environ['BASE']
source = Path(os.environ['SB_DATA_DIR']) / 'd1/DB.sqlite'
binary = Path(os.environ['RISULTA_VERIFY_BINARY'])
admin = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

def request(opener, origin, path, payload=None, token=None):
    headers = {'Accept': 'application/json'}
    if payload is not None:
        headers['Content-Type'] = 'application/json'
    if token:
        headers['X-CSRF-Token'] = token
    req = urllib.request.Request(origin + path, data=json.dumps(payload).encode() if payload is not None else None, headers=headers)
    with opener.open(req, timeout=15) as response:
        return json.loads(response.read())

request(admin, base, '/login', {'email': os.environ['ADMIN_EMAIL'], 'password': os.environ['ADMIN_PASSWORD']})
csrf = request(admin, base, '/api/session')['csrf']
site = request(admin, base, '/api/sites', {'name': 'Recovery site', 'domain': 'recovery.example.com'}, csrf)
other = request(admin, base, '/api/sites', {'name': 'Other site', 'domain': 'other-recovery.example.com'}, csrf)
request(admin, base, '/api/users', {'email': 'restore-viewer@example.test', 'password': 'restore-viewer-password-001', 'role': 'viewer', 'siteIds': [site['id']]}, csrf)
request(admin, base, f'/api/sites/{site["id"]}/annotations', {'day': time.strftime('%Y-%m-%d', time.gmtime()), 'text': 'Recovery launch'}, csrf)
request(admin, base, f'/api/sites/{site["id"]}/public-widget', {'enabled': True}, csrf)
request(admin, base, '/api/event/' + site['publicKey'], {'domain': site['domain'], 'name': 'pageview', 'path': '/restored'})
backup = request(admin, base, '/api/backup', {}, csrf)
snapshot = Path(backup['path'])
assert snapshot.is_file() and snapshot.stat().st_size == backup['bytes']
assert backup['manifest']['tables']['annotations'] == 1

with sqlite3.connect(snapshot) as db:
    assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    expected = {table: db.execute(f'SELECT count(*) FROM {table}').fetchone()[0] for table in ('users', 'sites', 'site_users', 'events', 'annotations', 'public_widgets')}

with tempfile.TemporaryDirectory(prefix='risulta-restore-drill-') as temporary:
    root = Path(temporary)
    state = root / 'state'
    (state / 'd1').mkdir(parents=True)
    shutil.copy2(snapshot, state / 'd1/DB.sqlite')
    corrupt = root / 'corrupt.sqlite'
    corrupt.write_bytes(snapshot.read_bytes()[:128])
    try:
        with sqlite3.connect(corrupt) as db:
            assert db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok'
    except sqlite3.DatabaseError:
        pass
    else:
        raise AssertionError('Truncated backup must fail validation')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    restored_base = f'http://127.0.0.1:{port}'
    env = os.environ.copy()
    env.update(SB_DATA_DIR=str(state), PORT=str(port), RISULTA_BASE_URL=restored_base)
    env.pop('RISULTA_MAINTENANCE_CHILD', None)
    env.pop('SB_TRUSTED_PROXIES', None)
    env.pop('RISULTA_ADMIN_PASSWORD', None)
    env.pop('RISULTA_ADMIN_EMAIL', None)
    with (root / 'server.log').open('w+') as log:
        process = subprocess.Popen([str(binary)], cwd=root, env=env, stdout=log, stderr=log, start_new_session=True)
        try:
            deadline = time.monotonic() + 30
            while True:
                if process.poll() is not None:
                    raise RuntimeError('Restored binary exited: ' + (root / 'server.log').read_text())
                try:
                    with urllib.request.urlopen(restored_base + '/healthz', timeout=1) as response:
                        if response.status == 200:
                            assert response.headers['x-risulta-schema-version'] == '7'
                            break
                except (OSError, ValueError):
                    pass
                if time.monotonic() > deadline:
                    raise TimeoutError('Restore readiness timed out')
                time.sleep(.1)
            restored = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
            request(restored, restored_base, '/login', {'email': os.environ['ADMIN_EMAIL'], 'password': os.environ['ADMIN_PASSWORD']})
            sites = request(restored, restored_base, '/api/sites')
            assert {row['id'] for row in sites} == {site['id'], other['id']}
            stats = request(restored, restored_base, f'/api/sites/{site["id"]}/stats?include=traffic&fresh=1')
            assert stats['summary']['pageviews'] == 1
            public = request(restored, restored_base, '/public/data/' + site['publicKey'])
            assert public['pageviews'] == 1 and 'annotations' not in public
            viewer = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
            request(viewer, restored_base, '/login', {'email': 'restore-viewer@example.test', 'password': 'restore-viewer-password-001'})
            assert [row['id'] for row in request(viewer, restored_base, '/api/sites')] == [site['id']]
            try:
                request(viewer, restored_base, f'/api/sites/{other["id"]}/stats')
            except urllib.error.HTTPError as error:
                assert error.code == 404
            else:
                raise AssertionError('Restored viewer gained another site')
            with sqlite3.connect(state / 'd1/DB.sqlite') as db:
                for table, count in expected.items():
                    assert db.execute(f'SELECT count(*) FROM {table}').fetchone()[0] == count, table
                assert db.execute('SELECT text FROM annotations').fetchone()[0] == 'Recovery launch'
        finally:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)

print('Native restore OK: integrity, corrupt-copy rejection, login, website permissions, analytics, annotations and public sharing')
