import assert from 'node:assert/strict';
import { INGEST_CORS, ingestPreflight, createDomainMismatchLogger } from '../src/ingest-http.js';

// CORS: every collector response must be readable from a customer site.
assert.equal(INGEST_CORS['access-control-allow-origin'], '*');
const preflight = ingestPreflight();
assert.equal(preflight.status, 204);
assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
assert.match(preflight.headers.get('access-control-allow-headers'), /content-type/i);
assert.equal(preflight.headers.get('access-control-max-age'), '86400');
assert.equal(preflight.headers.get('set-cookie'), null);

// Mismatch logging: hostname only, once per (site, hostname) per hour.
const lines = [];
const log = createDomainMismatchLogger((line) => lines.push(line), 3600000, 3);
const t0 = 1000000;
assert.equal(log('rdyrct.com', 'mirror.example', t0), true);
assert.equal(log('rdyrct.com', 'mirror.example', t0 + 1000), false);
assert.equal(log('rdyrct.com', 'mirror.example', t0 + 3599999), false);
assert.equal(log('other.com', 'mirror.example', t0 + 1000), true, 'distinct site logs separately');
assert.equal(log('rdyrct.com', 'second.example', t0 + 1000), true, 'distinct hostname logs separately');
assert.equal(log('rdyrct.com', 'mirror.example', t0 + 3600000), true, 'logs again after the hour');
assert.equal(lines.length, 4);
const first = JSON.parse(lines[0]);
assert.deepEqual(Object.keys(first).sort(), ['got', 'site', 'time_ms', 'type']);
assert.equal(first.type, 'domain_mismatch');
assert.equal(first.site, 'rdyrct.com');
assert.equal(first.got, 'mirror.example');

// Client-supplied junk is never echoed.
const junk = [];
const logJunk = createDomainMismatchLogger((line) => junk.push(line));
logJunk('rdyrct.com', 'a b\n{"x":1}', t0);
logJunk('rdyrct.com', '', t0);
assert.equal(JSON.parse(junk[0]).got, '(invalid)');
assert.equal(JSON.parse(junk[1]).got, '(invalid)');

// Memory stays bounded.
const bounded = createDomainMismatchLogger(() => {}, 3600000, 3);
for (let i = 0; i < 50; i++) bounded('s.test', 'h' + i + '.example', t0 + i);
assert.equal(bounded('s.test', 'h49.example', t0 + 60), false, 'recent entries survive eviction');
console.log('Ingest HTTP OK (CORS headers, preflight, hostname-only mismatch log, hourly dedupe, bounded memory)');
