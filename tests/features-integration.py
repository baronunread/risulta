"""Exercise new features over HTTP against an isolated standalone server."""
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ['BASE']
checks = 0

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def client():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()), NoRedirect())

admin, viewer, anonymous = client(), client(), client()

def request(opener, path, code=200, method='GET', payload=None, headers=None):
    global checks
    hs = {'Accept': 'application/json', **(headers or {})}
    data = None
    if payload is not None:
        if isinstance(payload, dict):
            data = json.dumps(payload).encode()
            hs.setdefault('Content-Type', 'application/json')
        else:
            data = payload.encode()
    req = urllib.request.Request(BASE + path, data=data, headers=hs, method=method)
    try:
        response = opener.open(req, timeout=15)
    except urllib.error.HTTPError as err:
        response = err
    body = response.read()
    assert response.status == code, (path, response.status, code, body[:200])
    checks += 1
    return response, body

def parsed(*args, **kwargs):
    response, body = request(*args, **kwargs)
    return json.loads(body), response

response, body = request(anonymous, '/healthz')
assert body == b'ok\n' and response.headers['x-risulta-schema-version'] == '3'

request(admin, '/login', method='POST', payload={'email':os.environ['ADMIN_EMAIL'], 'password':os.environ['ADMIN_PASSWORD']})
session, _ = parsed(admin, '/api/session')
csrf = {'X-CSRF-Token': session['csrf']}
site, _ = parsed(admin, '/api/sites', code=201, method='POST', payload={'name':'Feature test','domain':'features.example.com'}, headers=csrf)
other, _ = parsed(admin, '/api/sites', code=201, method='POST', payload={'name':'Other','domain':'other.example.com'}, headers=csrf)
site_id, other_id = site['id'], other['id']
site_slug = site['slug']
request(admin, '/api/users', code=201, method='POST', payload={'email':'feature-viewer@example.com','password':'feature-viewer-password-0001','role':'viewer','siteIds':[site_id]},headers=csrf)
request(viewer, '/login', method='POST', payload={'email':'feature-viewer@example.com','password':'feature-viewer-password-0001'})
vs,_ = parsed(viewer, '/api/session')
vcsrf={'X-CSRF-Token':vs['csrf']}

# The same real route supports JSON and a usable native HTML form.
_, body = request(admin, '/users', headers={'Accept':'text/html'})
assert b'data-backup-form' in body and b'action="/api/backup"' in body
response,_ = request(viewer, '/users',code=303, headers={'Accept':'text/html'})
assert response.headers['Location']=='/'
request(viewer, '/api/backup',code=403,method='POST',payload={},headers=vcsrf)
request(admin, '/api/backup',code=403,method='POST',payload={})
response,_ = request(admin, '/api/backup',code=303,method='POST',payload=urllib.parse.urlencode({'csrf':session['csrf']}),headers={'Accept':'text/html','Content-Type':'application/x-www-form-urlencoded'})
assert response.headers['Location']=='/users?backup=success'
_,body=request(admin, '/users?backup=success',headers={'Accept':'text/html'})
assert b'Database backup created' in body
backup,_=parsed(admin, '/api/backup',method='POST',payload={},headers=csrf)
assert backup['ok'] and backup['bytes']>0 and backup['manifest']['tables']['read_api_keys']==0
assert backup['manifest']['schema_version'] == 3
assert backup['manifest']['tables']['schema_migrations'] == 3
assert backup['manifest']['tables']['analytics_rollup_days'] == 0

# Preferences must be real, bounded, admin-only and protected by CSRF.
settings_path = '/api/backup/settings'
settings, _ = parsed(admin, settings_path)
assert settings['settings']['frequency'] == 'off' and len(settings['history']) == 2
request(viewer, settings_path, code=403)
request(viewer, settings_path, code=403, method='POST', payload={'frequency':'daily','time':'02:00','retention':14}, headers=vcsrf)
request(admin, settings_path, code=403, method='POST', payload={'frequency':'daily','time':'02:00','retention':14})
for invalid in [{'frequency':'hourly','time':'02:00','retention':14}, {'frequency':'daily','time':'25:00','retention':14}, {'frequency':'daily','time':'02:00','retention':0}, {'frequency':'daily','time':'02:00','retention':1.5}]:
    request(admin, settings_path, code=400, method='POST', payload=invalid, headers=csrf)
request(admin, settings_path, method='POST', payload={'frequency':'daily','time':'03:15','retention':3}, headers=csrf)
settings, _ = parsed(admin, settings_path)
assert settings['settings']['frequency'] == 'daily' and settings['settings']['hour'] == 3 and settings['settings']['minute'] == 15 and settings['settings']['retention'] == 3
_, body = request(admin, '/backups', headers={'Accept':'text/html'})
assert b'Runner disconnected' in body and b'Recent backups' in body
response, _ = request(viewer, '/backups', code=303, headers={'Accept':'text/html'})
assert response.headers['Location'] == '/'

# The HTTP token returned once must match the hash stored by the native runtime.
keys=f'/api/sites/{site_id}/read-keys'
request(anonymous,keys,code=401,method='POST',payload={})
request(viewer,keys,code=403,method='POST',payload={},headers=vcsrf)
request(admin,keys,code=403,method='POST',payload={})
key,response=parsed(admin,keys,code=201,method='POST',payload={},headers=csrf)
assert response.headers['Cache-Control']=='no-store'
assert len(key['token'])==len('risulta_read_')+64
listed,_=parsed(admin,keys)
assert listed[0]['id']==key['id'] and 'token' not in listed[0] and 'token_hash' not in listed[0]
bearer={'Authorization':'Bearer '+key['token']}
for endpoint in ['stats','report']:
    response,_=request(anonymous,f'/api/sites/{site_id}/{endpoint}',headers=bearer)
    assert response.headers['Cache-Control']=='no-store'
    request(anonymous,f'/api/sites/{other_id}/{endpoint}',code=401,headers=bearer)
    request(anonymous,f'/api/sites/{site_id}/{endpoint}',code=401,method='POST',payload={},headers=bearer)
    request(anonymous,f'/api/sites/{site_id}/{endpoint}?from=2020-01-01&to=2026-01-01',code=400,headers=bearer)
for path in [keys,'/api/sites',f'/api/sites/{site_id}/goals',f'/api/sites/{site_id}/journeys']:
    request(anonymous,path,code=401,headers=bearer)
request(anonymous,'/api/backup',code=401,method='POST',payload={},headers=bearer)
request(anonymous,f'/api/sites/{site_id}/stats?key='+key['token'],code=401)
report,_=parsed(anonymous,f'/api/sites/{site_id}/report?limit=999999&offset=999999',headers=bearer)
assert report['limit']==100 and report['offset']==10000
request(anonymous,f'/api/sites/{site_id}/report?format=csv',headers=bearer)

# Real SQLite fixtures prove site isolation, event-ID tie ordering and session gaps.
db_path=Path(os.environ['SB_DATA_DIR'])/'d1/DB.sqlite'
visitor='a'*24
now=int(time.time())
anchor=((now-4000)//86400)*86400+100
with sqlite3.connect(db_path,timeout=10) as db:
    stored=db.execute('SELECT token_hash FROM read_api_keys WHERE id=?',(key['id'],)).fetchone()[0]
    assert stored==hashlib.sha256(key['token'].encode()).hexdigest()
    rows=[(site_id,anchor,'pageview','/first',visitor),(site_id,anchor,'signup','/second',visitor),(site_id,anchor+1800,'pageview','/third',visitor),(site_id,anchor+3601,'pageview','/fourth',visitor),(other_id,anchor,'pageview','/private',visitor)]
    db.executemany('INSERT INTO events (site_id,ts,name,path,visitor) VALUES (?,?,?,?,?)',rows)
journeys=f'/api/sites/{site_id}/journeys'
request(anonymous,journeys,code=401)
request(viewer,f'/api/sites/{other_id}/journeys',code=404)
report,_=parsed(viewer,journeys+'?period=7&visitor='+visitor)
assert report['total']==2 and len(report['rows'][0]['events'])==3
assert [e['path'] for e in report['rows'][0]['events']]==['/first','/second','/third']
assert report['rows'][1]['events'][0]['path']=='/fourth'
assert '/private' not in json.dumps(report)
request(admin,journeys+'?visitor=invalid',code=400)
report,_=parsed(admin,journeys+'?limit=99999&offset=99999')
assert report['limit']==100 and report['offset']==10000
_,body=request(viewer,f'/sites/{site_slug}/reports/journeys?period=7&visitor='+visitor,headers={'Accept':'text/html'})
assert b'/first' in body and b'/fourth' in body and b'/private' not in body
request(viewer, f'/sites/{other_id}/conversions', code=404)
request(anonymous, f'/sites/{site_slug}/conversions', code=303, headers={'Accept':'text/html'})
response,_ = request(viewer, f'/sites/{site_slug}/conversions', code=308, headers={'Accept':'text/html'})
assert response.headers['Location'].startswith(f'/sites/{site_slug}/goals')
request(viewer, f'/sites/{site_slug}/goals', headers={'Accept':'text/html'})
_,body=request(admin,f'/sites/{site_slug}/reports',headers={'Accept':'text/html'})
assert b'/reports/journeys' in body and b'Journeys</a>' in body

stats, _ = parsed(admin, f'/api/sites/{site_id}/stats?period=7')
assert stats['summary']['visits'] == 2
assert sum(row['visits'] for row in stats['byDay']) == stats['summary']['visits']
assert sum(row['visits'] for row in stats['byHour']) == stats['summary']['visits']
_, body = request(admin, f'/sites/{site_slug}?period=7&metric=visits', headers={'Accept':'text/html'})
assert b'Visits over time' in body and b'Unique visitor-days' not in body

# Exercise the native rolled-up API against its pre-backfill raw response.
import subprocess
import sys
state = Path(os.environ['SB_DATA_DIR'])
today = int(time.time()) // 86400 * 86400
with sqlite3.connect(state / 'd1/DB.sqlite') as historical:
    for day in (today - 2 * 86400, today - 86400):
        historical.execute("INSERT INTO events(site_id,ts,name,path,visitor,value) VALUES(?,?,'pageview','/historical','imported-repeat',10)", (site_id, day + 3600))
        historical.execute("INSERT INTO events(site_id,ts,name,path,visitor,value) VALUES(?,?,'signup','/thanks','imported-repeat',-3)", (site_id, day + 5401))
    historical.execute("INSERT INTO goals(site_id,name,event_name,path,created_at) VALUES(?,'Historical signup','signup','',0)", (site_id,))
    historical.execute("INSERT INTO goals(site_id,name,event_name,path,created_at) VALUES(?,'Historical views','pageview','/historical',0)", (site_id,))
query = 'from=' + time.strftime('%Y-%m-%d', time.gmtime(today - 2 * 86400)) + '&to=' + time.strftime('%Y-%m-%d', time.gmtime(today))
raw_stats, _ = parsed(admin, f'/api/sites/{site_id}/stats?' + query)
report_queries = ['dimension=path', 'dimension=source', 'dimension=path&sort=value&limit=1&offset=1', 'dimension=path&path=/historical', 'dimension=event']
raw_reports = [parsed(admin, f'/api/sites/{site_id}/report?' + query + '&' + suffix)[0] for suffix in report_queries]
_, raw_csv = request(admin, f'/api/sites/{site_id}/report?' + query + '&dimension=path&format=csv')
subprocess.run([sys.executable, 'deploy/rollup-runner.py', '--data-dir', str(state), '--max-days', '1000'], check=True, capture_output=True)
rolled_stats, _ = parsed(anonymous, f'/api/sites/{site_id}/stats?' + query, headers=bearer)
assert rolled_stats == raw_stats
for suffix, raw_report in zip(report_queries, raw_reports):
    rolled_report, _ = parsed(viewer, f'/api/sites/{site_id}/report?' + query + '&' + suffix)
    assert rolled_report == raw_report
_, rolled_csv = request(viewer, f'/api/sites/{site_id}/report?' + query + '&dimension=path&format=csv')
assert rolled_csv == raw_csv
request(anonymous, '/api/event/' + site['publicKey'], code=202, method='POST', payload={'name':'pageview','path':'/fresh','domain':'features.example.com'})
fresh_stats, _ = parsed(admin, f'/api/sites/{site_id}/stats?' + query)
assert fresh_stats['summary']['pageviews'] == raw_stats['summary']['pageviews'] + 1
with sqlite3.connect(state / 'd1/DB.sqlite') as historical:
    historical.execute("UPDATE events SET value=4 WHERE site_id=? AND ts<? AND name='signup'", (site_id,today))
dirty_stats, _ = parsed(admin, f'/api/sites/{site_id}/stats?' + query)
assert next(g for g in dirty_stats['goals'] if g['name']=='Historical signup')['value'] == 8

revoke=keys+'/'+str(key['id'])+'/revoke'
request(viewer,revoke,code=403,method='POST',payload={},headers=vcsrf)
request(admin,revoke,code=403,method='POST',payload={})
request(admin,revoke,method='POST',payload={},headers=csrf)
request(anonymous,f'/api/sites/{site_id}/stats',code=401,headers=bearer)
print(f'feature integration OK ({checks} HTTP checks: backup settings, visits charts, journeys, read API)')
