"""Real systemd installation/upgrade/paired recovery on disposable CI runners."""
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import pty
import select
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request

if os.environ.get('GITHUB_ACTIONS') != 'true' or not os.environ.get('RUNNER_TEMP') or os.geteuid() != 0 or sys.platform != 'linux':
    sys.exit('This drill runs only as root on a disposable GitHub Actions Linux runner.')
paths = ['/var/lib/risulta-sprout', '/etc/risulta-sprout', '/usr/local/bin/risulta-sprout', '/etc/systemd/system/risulta-sprout.service']
if any(Path(path).exists() for path in paths):
    sys.exit('Refusing to modify an existing Risulta installation.')
subprocess.run(['systemctl', 'is-system-running'], capture_output=True)
root = Path.cwd()
new_binary = Path(sys.argv[1]).resolve(strict=True)
artifact = 'risulta-sprout-linux-arm64' if os.uname().machine == 'aarch64' else 'risulta-sprout-linux-x64'
base = 'http://127.0.0.1:18099'
password = 'ci-installer-disposable-password-001'

def http(path, payload=None, csrf=None):
    headers = {'Accept': 'application/json'}
    if payload is not None:
        headers['Content-Type'] = 'application/json'
    if csrf:
        headers['X-CSRF-Token'] = csrf
    req = urllib.request.Request(base + path, data=json.dumps(payload).encode() if payload is not None else None, headers=headers)
    with client.open(req, timeout=15) as response:
        return json.loads(response.read())

def ready(schema):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(base + '/healthz', timeout=2) as response:
                if response.headers['x-risulta-schema-version'] == str(schema):
                    return
        except OSError:
            pass
        time.sleep(.2)
    raise RuntimeError('Native systemd readiness failed')

client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
with tempfile.TemporaryDirectory(prefix='risulta-systemd-', dir=os.environ['RUNNER_TEMP']) as temporary:
    scratch = Path(temporary)
    fixture = scratch / 'assets'
    fixture.mkdir()
    for tag, source, schema in [('v0.1.8', None, 6), ('v0.2.0-ci', new_binary, 7)]:
        release = fixture / tag
        release.mkdir()
        if source:
            shutil.copy2(source, release / artifact)
        else:
            urllib.request.urlretrieve('https://github.com/baronunread/risulta/releases/download/v0.1.8/' + artifact, release / artifact)
        (release / (artifact + '.sha256')).write_text(hashlib.sha256((release / artifact).read_bytes()).hexdigest() + '  ' + artifact + '\n')
        (release / 'release.json').write_text(json.dumps({'tag': tag, 'commit': 'a' * 40, 'rollup_schema_version': schema, 'builtin_maintenance': True}))
    tools = scratch / 'bin'
    tools.mkdir()
    # Only release downloads are staged. Health checks, filesystem operations,
    # user creation and systemd lifecycle run against the real runner.
    (tools / 'curl').write_text('''#!/usr/bin/python3
import os
from pathlib import Path
import subprocess
import sys
args=sys.argv[1:]
url=next((value for value in args if value.startswith('http')), '')
if '/releases/download/' not in url:
 sys.exit(subprocess.call(['/usr/bin/curl',*args]))
relative=url.split('/releases/download/',1)[1]
file=Path(os.environ['RISULTA_TEST_ASSETS'])/relative
if not file.is_file():sys.exit(22)
output=args[args.index('-o')+1] if '-o' in args else None
if output:Path(output).write_bytes(file.read_bytes())
else:sys.stdout.buffer.write(file.read_bytes())
''')
    (tools / 'curl').chmod(0o755)
    env = os.environ.copy()
    env.update(PATH=str(tools) + ':' + env['PATH'], RISULTA_TEST_ASSETS=str(fixture), RISULTA_PORT='18099')
    try:
        pid, fd = pty.fork()
        if pid == 0:
            os.execvpe('sh', ['sh', str(root / 'deploy/install.sh'), '--version', 'v0.1.8'], env)
        prompts = [('Analytics domain', '127.0.0.1'), ('Choose 1, 2, or 3', '3'), ('Administrator email', 'ci-admin@example.test'), ('Administrator display name', 'CI Admin'), ('Administrator password', password), ('Confirm administrator password', password)]
        sent = 0
        reaped = False
        output = ''
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if select.select([fd], [], [], .2)[0]:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                output += data.decode(errors='replace')
                if sent < len(prompts) and prompts[sent][0] in output:
                    os.write(fd, (prompts[sent][1] + '\n').encode())
                    sent += 1
                    output = ''
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                reaped = True
                assert os.waitstatus_to_exitcode(status) == 0, output[-2000:]
                break
        else:
            os.kill(pid, 9)
            raise TimeoutError('Interactive installer exceeded 90 seconds')
        os.close(fd)
        if not reaped:
            _, status = os.waitpid(pid, 0)
            assert os.waitstatus_to_exitcode(status) == 0, output[-2000:]
        ready(6)
        assert Path('/usr/local/bin/risulta').is_file()
        assert 'RISULTA_ADMIN_PASSWORD' not in Path('/etc/risulta-sprout/risulta-sprout.env').read_text()
        http('/login', {'email': 'ci-admin@example.test', 'password': password})
        csrf = http('/api/session')['csrf']
        site = http('/api/sites', {'name': 'Upgrade smoke', 'domain': 'upgrade.example.test'}, csrf)
        http('/api/event/' + site['publicKey'], {'name': 'pageview', 'path': '/before-upgrade', 'domain': site['domain']})
        subprocess.run(['/usr/local/bin/risulta', 'update', '--version', 'v0.2.0-ci'], env=env, check=True, timeout=90)
        ready(7)
        assert http(f'/api/sites/{site["id"]}/stats?include=traffic&fresh=1')['summary']['pageviews'] == 1
        http(f'/api/sites/{site["id"]}/annotations', {'day': time.strftime('%Y-%m-%d', time.gmtime()), 'text': 'Systemd upgrade'}, csrf)
        recovery = sorted(Path('/var/backups/risulta-sprout').glob('pre-update-*'))
        assert len(recovery) == 1
        subprocess.run(['/usr/local/bin/risulta', 'update', '--version', 'v0.2.0-ci'], env=env, check=True, timeout=90)
        assert len(list(Path('/var/backups/risulta-sprout').glob('pre-update-*'))) == 1
        subprocess.run(['systemctl', 'stop', 'risulta-sprout'], check=True)
        shutil.rmtree('/var/lib/risulta-sprout')
        subprocess.run(['cp', '-a', str(recovery[0] / 'data'), '/var/lib/risulta-sprout'], check=True)
        shutil.copy2(recovery[0] / 'risulta-sprout', '/usr/local/bin/risulta-sprout')
        shutil.copy2(recovery[0] / 'risulta-sprout.env', '/etc/risulta-sprout/risulta-sprout.env')
        if (recovery[0] / 'release.env').exists():
            shutil.copy2(recovery[0] / 'release.env', '/etc/risulta-sprout/release.env')
        subprocess.run(['systemctl', 'start', 'risulta-sprout'], check=True)
        ready(6)
        assert http(f'/api/sites/{site["id"]}/stats?include=traffic&fresh=1')['summary']['pageviews'] == 1
        with sqlite3.connect('/var/lib/risulta-sprout/d1/DB.sqlite') as db:
            assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
            assert db.execute('SELECT max(version) FROM schema_migrations').fetchone()[0] == 6
        print('Real systemd installer OK: released v0.1.8 fresh install, CLI update to schema 7, no-op update and paired rollback')
    finally:
        subprocess.run(['systemctl', 'stop', 'risulta-sprout'], check=False)
        subprocess.run(['systemctl', 'disable', 'risulta-sprout'], check=False)
        subprocess.run(['journalctl', '-u', 'risulta-sprout', '--no-pager', '-n', '15'], check=False)
