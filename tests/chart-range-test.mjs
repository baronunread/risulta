import assert from 'node:assert/strict';
import { dateSeries, chart } from '../src/chart.js';
import { parseRange } from '../src/domain.js';
const now = Date.UTC(2026, 9, 6, 12, 30) / 1000;
assert.equal(parseRange(new URLSearchParams('period=1'), now).since, Date.UTC(2026, 9, 6) / 1000);
assert.equal(parseRange(new URLSearchParams('period=7'), now).since, Date.UTC(2026, 8, 30) / 1000);
const until = Date.UTC(2024, 2, 2) / 1000;
const values = dateSeries(3, [{ day: '2024-02-29', visitors: 123, visits: 200, pageviews: 999 }], until);
assert.deepEqual(values.map(row => row.day), ['2024-02-28', '2024-02-29', '2024-03-01']);
assert.equal(values[1].visits, 200);
assert.equal(values[2].pageviews, 0);
console.log('chart ranges OK (historic period, leap day, empty intervals)');

const mobile = chart(values, 'visits', 'Visits', true);
assert.match(mobile, /viewBox="0 0 320 190"/);
assert.match(mobile, /id="chart-title-mobile"/);
assert.match(mobile, /url\(#area-mobile\)/);
