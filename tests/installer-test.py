"""Exercise update transactions using disposable paths and fake OS/network boundaries."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

SOURCE = Path('deploy/install.sh').read_text()
BINARY = b'#!/bin/sh\necho nightly-test\n'
OLD = b'#!/bin/sh\necho previous-test\n'
TAG = 'nightly-20261006-0123456789ab'
COMMIT = '0123456789abcdef0123456789abcdef01234567'
MOCK = r'''
import hashlib,json,os,pathlib,shutil,sys
root=pathlib.Path(os.environ['TEST_ROOT'])
name=pathlib.Path(sys.argv[0]).name
args=sys.argv[1:]
with (root/'calls').open('a') as log: log.write(name+' '+json.dumps(args)+'\n')
if name=='id': print('0');sys.exit(0)
if name=='uname': print('Linux' if args==['-s'] else 'x86_64');sys.exit(0)
if name=='sleep': sys.exit(0)
if name=='flock': sys.exit(1 if os.environ.get('LOCK_BUSY') else 0)
if name=='systemctl':
 if args[0]=='is-active': sys.exit(0 if (root/'active').exists() else 3)
 if args[0]=='stop': (root/'active').unlink(missing_ok=True)
 if args[0] in ['restart','start']: (root/'active').touch()
 sys.exit(0)
if name=='cp':
 if os.environ.get('FAIL_BACKUP'): sys.exit(1)
 sys.exit(subprocess_call:=__import__('subprocess').call(['/bin/cp',*args]))
if name=='install':
 mode=0o755;directories=False;paths=[];i=0
 while i<len(args):
  a=args[i]
  if a=='-d':directories=True;i+=1
  elif a=='-m':mode=int(args[i+1],8);i+=2
  elif a in ['-o','-g']:i+=2
  else:paths.append(pathlib.Path(a));i+=1
 if directories:
  for p in paths:p.mkdir(parents=True,exist_ok=True);p.chmod(mode)
 else: shutil.copyfile(paths[0],paths[1]);paths[1].chmod(mode)
 sys.exit(0)
if name=='curl':
 url=next(a for a in args if a.startswith('http'))
 out=pathlib.Path(args[args.index('-o')+1]) if '-o' in args else None
 artifact=b'#!/bin/sh\necho nightly-test\n'
 tag='nightly-20261006-0123456789ab';commit='0123456789abcdef0123456789abcdef01234567'
 if '/healthz' in url:sys.exit(22 if os.environ.get('FAIL_HEALTH') else 0)
 if url.endswith('releases/latest'):data=json.dumps({'tag_name':'v0.1.6','draft':False,'prerelease':False}).encode()
 elif 'releases?per_page=' in url:
  data=json.dumps([{'tag_name':'nightly-ignored','draft':True,'prerelease':True,'published_at':'2099'}, {'tag_name':'v0.1.6','prerelease':False,'published_at':'2026'}, {'tag_name':tag,'draft':False,'prerelease':True,'published_at':'2026-10-06T00:00:00Z'}]).encode()
 elif url.endswith('/release.json'):
  selected=url.split('/download/')[1].split('/')[0]
  if os.environ.get('MISSING_METADATA'):sys.exit(22)
  data=json.dumps({'tag':'wrong' if os.environ.get('BAD_METADATA') else selected,'commit':commit}).encode()
 elif url.endswith('.sha256'):
  data=((('0'*64) if os.environ.get('BAD_CHECKSUM') else hashlib.sha256(artifact).hexdigest())+'  risulta-sprout-linux-x64\n').encode()
 else:data=artifact
 if out:out.write_bytes(data)
 else:sys.stdout.buffer.write(data)
 sys.exit(0)
raise SystemExit('Unexpected mock '+name)
'''


def scenario(options, channel=None, installed=OLD, flags=None, existing=True):
    scratch = tempfile.TemporaryDirectory(prefix='risulta-installer-test-')
    root = Path(scratch.name)
    paths = {'/usr/local/bin/risulta-sprout': root/'bin/risulta-sprout',
             '/etc/risulta-sprout': root/'etc/risulta-sprout',
             '/var/lib/risulta-sprout': root/'data',
             '/etc/systemd/system/risulta-sprout.service': root/'service',
             '/var/backups/risulta-sprout': root/'backups'}
    source=SOURCE
    for old,new in paths.items():source=source.replace(old,str(new))
    script=root/'install.sh';script.write_text(source)
    envdir=root/'etc/risulta-sprout';envdir.mkdir(parents=True)
    binary=root/'bin/risulta-sprout';binary.parent.mkdir()
    data=root/'data/d1';data.mkdir(parents=True)
    original_env=f'PORT="18999"\nSB_DATA_DIR="{root}/data"\nRISULTA_BASE_URL="https://stats.example.com"\nRISULTA_PROXY_MODE="caddy"\nSB_TRUSTED_PROXIES="127.0.0.1"\nCUSTOM_SETTING="keep-me"\n'
    if existing:
        binary.write_bytes(installed);binary.chmod(0o755)
        (envdir/'risulta-sprout.env').write_text(original_env)
        (data/'DB.sqlite').write_bytes(b'database fixture')
        (root/'service').write_text('service unchanged')
    if channel:(envdir/'release.env').write_text(f'CHANNEL="{channel}"\nTAG="previous"\nCOMMIT="unknown"\n')
    (root/'active').touch()
    mocks=root/'mocks';mocks.mkdir()
    for name in ['id','uname','sleep','systemctl','curl','install','cp','flock']:
        p=mocks/name;p.write_text('#!'+sys.executable+'\n'+MOCK);p.chmod(0o755)
    env=os.environ.copy();env.update(TEST_ROOT=str(root),PATH=str(mocks)+os.pathsep+env['PATH'])
    env.update(flags or {})
    result=subprocess.run(['sh',str(script),*options],env=env,text=True,capture_output=True,timeout=30)
    return scratch,root,result,original_env


count=0
for options,saved,target in [(['--update'],None,'v0.1.6'),(['--update'], 'nightly', TAG),(['--update','--channel','nightly'],None,TAG),(['--update','--channel','stable'],'nightly','v0.1.6'),(['--update','--version','v0.1.6'],'nightly','v0.1.6')]:
    scratch,root,result,original_env=scenario(options,saved)
    with scratch:
        assert result.returncode==0,(result.stdout,result.stderr)
        assert (root/'bin/risulta-sprout').read_bytes()==BINARY
        assert (root/'etc/risulta-sprout/risulta-sprout.env').read_text()==original_env
        assert (root/'service').read_text()=='service unchanged'
        state=(root/'etc/risulta-sprout/release.env').read_text()
        assert f'TAG="{target}"' in state
        expected_channel='nightly' if '--channel' in options and options[-1]=='nightly' else ('stable' if '--channel' in options else saved or 'stable')
        assert f'CHANNEL="{expected_channel}"' in state
        backup=next((root/'backups').iterdir())
        assert (backup/'risulta-sprout').read_bytes()==OLD
        assert (backup/'data/d1/DB.sqlite').read_bytes()==b'database fixture'
        calls=(root/'calls').read_text()
        assert '/releases/latest/download/' not in calls
        assert 'daemon-reload' not in calls and 'caddy' not in calls
        assert result.stdout.index('Checksum verified')<result.stdout.index('Stopping Risulta')
        count+=1

for flag in ['BAD_CHECKSUM','BAD_METADATA','MISSING_METADATA','LOCK_BUSY']:
    scratch,root,result,_=scenario(['--update','--channel','nightly'],flags={flag:'1'})
    with scratch:
        assert result.returncode!=0
        assert (root/'bin/risulta-sprout').read_bytes()==OLD
        assert '"stop"' not in (root/'calls').read_text()
        assert not (root/'backups').exists()
        count+=1

scratch,root,result,_=scenario(['--update','--channel','nightly'],installed=BINARY)
with scratch:
    assert result.returncode==0
    assert 'up to date' in result.stdout
    assert not (root/'backups').exists()
    assert 'CHANNEL="nightly"' in (root/'etc/risulta-sprout/release.env').read_text()
    count+=1

for flag in ['FAIL_BACKUP','FAIL_HEALTH']:
    scratch,root,result,_=scenario(['--update','--channel','nightly'],flags={flag:'1'})
    with scratch:
        assert result.returncode!=0
        assert not (root/'etc/risulta-sprout/release.env').exists()
        if flag=='FAIL_BACKUP':
            assert (root/'bin/risulta-sprout').read_bytes()==OLD
            assert (root/'active').exists()
        else:
            assert not (root/'active').exists()
            backup=next((root/'backups').iterdir())
            assert (backup/'risulta-sprout').read_bytes()==OLD
            assert (backup/'data/d1/DB.sqlite').exists()
        count+=1

scratch,root,result,_=scenario(['--update'],existing=False)
with scratch:
    assert result.returncode!=0
    assert not (root/'calls').exists() or 'curl' not in (root/'calls').read_text()
    count+=1
print(f'installer OK ({count} transaction scenarios)')
