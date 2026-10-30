import test from 'node:test';
import assert from 'node:assert/strict';
import {bucket, cluster, consistentCounts, countByKey, dotSize, inRange, isStale, memberKey, monthIndex, presetRange, splitForRegion}
  from '../gathering/static/gathering/filter.js';

const at = (date) => `${date}T12:00:00+08:00`;
const person = (id, confirmed, loc = {}) => ({id, name: `同学${id}`, location: {country_code: 'CHN', province_code: '420000', city_code: '420100', confirmed_at: confirmed, ...loc}});

test('presetRange 3y from 2026-10-29 starts 2023-10', () => {
  assert.deepEqual(presetRange('3y', '2026-10-29', '2015-09-01'), {from: monthIndex('2023-10-01'), to: null});
  assert.deepEqual(presetRange('1y', '2026-10-29', '2015-09-01'), {from: monthIndex('2025-10-01'), to: null});
  assert.deepEqual(presetRange('all', '2026-10-29', '2015-09-01'), {from: monthIndex('2015-09-01'), to: null});
});

test('inRange includes whole end month and start month', () => {
  const range = {from: monthIndex('2023-10-01'), to: monthIndex('2024-12-01')};
  assert.equal(inRange(at('2023-10-01'), range), true);
  assert.equal(inRange(at('2023-09-30'), range), false);
  assert.equal(inRange(at('2024-12-31'), range), true);
  assert.equal(inRange(at('2025-01-01'), range), false);
  assert.equal(inRange(null, range), false);
  assert.equal(inRange(at('2026-10-29'), {from: monthIndex('2023-10-01'), to: null}), true);
});

test('confirmed month is read in the server-local offset, not the runtime timezone', () => {
  // 2023-10-01 00:30 Beijing is still September in UTC.
  assert.equal(inRange('2023-10-01T00:30:00+08:00', {from: monthIndex('2023-10-01'), to: null}), true);
});

test('bucket boundaries', () => {
  assert.deepEqual([1, 2, 3, 4, 9, 10, 25].map(bucket), [0, 1, 1, 2, 2, 3, 3]);
  assert.deepEqual([1, 3, 4, 10].map(dotSize), [30, 34, 40, 46]);
});

test('province-only member gets its own key', () => {
  const loc = {country_code: 'CHN', province_code: '420000', city_code: '', confirmed_at: at('2025-01-01')};
  assert.equal(memberKey(loc, 'china'), 'prov:420000');
  const counts = countByKey([person(1, at('2025-01-01'), loc)], presetRange('all', '2026-10-29', '2015-09-01'), 'china');
  assert.equal(counts.get('prov:420000'), 1);
});

test('municipality counts as one city', () => {
  assert.equal(memberKey({country_code: 'CHN', province_code: '110000', city_code: '110108'}, 'china'), '110000');
  assert.equal(memberKey({country_code: 'JPN', province_code: '', city_code: ''}, 'world'), 'JPN');
});

test('consistentCounts total equals china+world', () => {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const countries = ['CHN', 'CHN', 'CHN', 'JPN', 'SGP'];
  const members = Array.from({length: 50}, (_, i) => random() < 0.1 ? {id: i, name: `x${i}`, location: null} :
    person(i, random() < 0.3 ? null : at(`20${15 + Math.floor(random() * 12)}-0${1 + Math.floor(random() * 9)}-15`),
      {country_code: countries[Math.floor(random() * 5)], city_code: random() < 0.2 ? '' : '420100'}));
  const range = presetRange('3y', '2026-10-29', '2015-09-01');
  const result = consistentCounts(members, range);
  const sum = map => [...map.values()].reduce((a, b) => a + b, 0);
  assert.equal(result.total, result.china + result.world);
  assert.equal(result.china, sum(countByKey(members, range, 'china')));
  assert.equal(result.world, sum(countByKey(members, range, 'world')));
});

test('splitForRegion puts out-of-range both sides into others', () => {
  const range = {from: monthIndex('2023-10-01'), to: monthIndex('2024-12-01')};
  const members = [person(1, at('2024-03-01')), person(2, at('2025-03-01')), person(3, at('2015-09-01')),
    person(4, null), person(5, at('2024-06-01')), person(6, at('2024-05-01'), {city_code: '430100', province_code: '430000'})];
  const {inRange: inside, others} = splitForRegion(members, '420100', 'china', range);
  assert.deepEqual(inside.map(m => m.id), [5, 1]);
  assert.deepEqual(others.map(m => m.id), [2, 3, 4]);
  // null key: every located member of that level (the home list), never the other level.
  const abroad = person(9, at('2024-08-01'), {country_code: 'JPN', province_code: '', city_code: ''});
  assert.deepEqual(splitForRegion([...members, abroad], null, 'china', range).inRange.map(m => m.id), [5, 6, 1]);
  assert.deepEqual(splitForRegion([...members, abroad], null, 'world', range).inRange.map(m => m.id), [9]);
});

test('cluster merges close points and keeps far ones', () => {
  const merged = cluster([{key: 'a', x: 0, y: 0, n: 5}, {key: 'b', x: 20, y: 0, n: 1}], 8);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].keys, ['a', 'b']);
  assert.equal(merged[0].n, 6);
  assert.ok(merged[0].x > 0 && merged[0].x < 10, 'position is weighted toward the bigger point');
  assert.equal(cluster([{key: 'a', x: 0, y: 0, n: 5}, {key: 'b', x: 200, y: 0, n: 1}], 8).length, 2);
});

test('isStale 13 months true, 11 months false', () => {
  assert.equal(isStale(at('2025-09-29'), '2026-10-29'), true);
  assert.equal(isStale(at('2025-11-29'), '2026-10-29'), false);
  assert.equal(isStale(null, '2026-10-29'), true);
});

test('Hong Kong, Macau and Taiwan count under 境外, each as its own place', () => {
  const sar = (id, province, name) => ({id, name: 'x', location: {country_code: 'CHN', province_code: province, province_name: name, city_code: province === '710000' ? '' : province, confirmed_at: at('2025-01-01')}});
  const members = [sar(1, '810000', '香港特别行政区'), sar(2, '820000', '澳门特别行政区'), sar(3, '710000', '台湾省'), person(4, at('2025-01-01'))];
  const range = presetRange('all', '2026-10-29', '2015-09-01');
  assert.deepEqual(consistentCounts(members, range), {china: 1, world: 3, total: 4});
  assert.deepEqual([...countByKey(members, range, 'world').keys()].sort(), ['HKG', 'MAC', 'TWN']);
  assert.equal(memberKey(members[0].location, 'world'), 'HKG');
});
