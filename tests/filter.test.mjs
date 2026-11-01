import test from 'node:test';
import assert from 'node:assert/strict';
import {bucket, cluster, confirmationBucket, confirmationLabel, consistentCounts, countByKey, dotSize, inRange, isStale, memberKey, orderByConfirmation, presetRange, splitForRegion}
  from '../gathering/static/gathering/filter.js';
import {createMemberOrder} from '../gathering/static/gathering/logic.js';

const at = date => `${date}T12:00:00+08:00`;
const person = (id, confirmed, loc = {}) => ({id, name: `同学${id}`, location: {country_code: 'CHN', province_code: '420000', city_code: '420100', confirmed_at: confirmed, ...loc}});
const today = '2026-11-01';

test('confirmation labels cover exact calendar boundaries without revealing a date', () => {
  const cases = [['2026-11-01', 0], ['2026-10-25', 0], ['2026-10-24', 1], ['2026-10-01', 1],
    ['2026-09-30', 2], ['2025-11-01', 2], ['2025-10-31', 3], ['2023-11-01', 3], ['2023-10-31', 4]];
  for (const [day, bucket] of cases) assert.equal(confirmationBucket(at(day), today), bucket, day);
  assert.equal(confirmationLabel(at('2026-10-25'), today), '近1周');
  assert.equal(confirmationLabel(at('2015-01-01'), today), '很久没有来过');
  for (const missing of [null, '', 'invalid', at('2027-01-01')]) assert.equal(confirmationBucket(missing, today), 4);
});

test('calendar cutoffs clamp leap days and short months, using the server local day', () => {
  assert.equal(confirmationBucket(at('2024-02-29'), '2024-03-31'), 1);
  assert.equal(confirmationBucket(at('2024-02-28'), '2024-03-31'), 2);
  assert.equal(confirmationBucket(at('2023-02-28'), '2024-02-29'), 2);
  assert.equal(confirmationBucket(at('2023-02-27'), '2024-02-29'), 3);
  assert.equal(confirmationBucket('2026-10-25T00:30:00+08:00', today), 0);
});

test('only three presets; year filters agree with the display buckets and All includes unconfirmed records', () => {
  assert.deepEqual(presetRange('3y', today), {preset: '3y', today});
  assert.throws(() => presetRange('custom', today), RangeError);
  for (const preset of ['1y', '3y', 'all']) {
    const range = presetRange(preset, today);
    for (const day of ['2026-10-28', '2025-11-01', '2025-10-31', '2023-11-01', '2023-10-31']) {
      assert.equal(inRange(at(day), range), preset === 'all' || confirmationBucket(at(day), today) <= (preset === '1y' ? 2 : 3));
    }
    assert.equal(inRange(null, range), preset === 'all');
  }
});

test('sort by fuzzy bucket, preserving a shuffled order within it across filtering and returning', () => {
  const members = [person(1, at('2026-10-30')), person(2, at('2026-10-26')), person(3, at('2025-11-01')),
    person(4, at('2026-10-27')), person(5, at('2015-01-01')), person(6, at('2026-10-01'))];
  const shuffle = createMemberOrder(() => 0.25);
  const randomized = shuffle(members), ordered = orderByConfirmation(randomized, today);
  for (const bucket of [0, 1, 2, 4]) {
    const ids = list => list.filter(m => confirmationBucket(m.location.confirmed_at, today) === bucket).map(m => m.id);
    assert.deepEqual(ids(ordered), ids(randomized));
  }
  assert.deepEqual(ordered.map(m => confirmationBucket(m.location.confirmed_at, today)), [0, 0, 0, 1, 2, 4]);
  const ids = preset => splitForRegion(randomized, null, null, presetRange(preset, today)).inRange.map(m => m.id);
  assert.deepEqual(ids('1y'), ids('all').filter(id => id !== 5));
  assert.deepEqual(orderByConfirmation(shuffle([...members].reverse()), today), ordered);
  assert.notDeepEqual(ordered.slice(0, 3).map(m => m.id), [1, 4, 2], 'not exact timestamp order');
});

test('bucket boundaries', () => {
  assert.deepEqual([1, 2, 3, 4, 9, 10, 25].map(bucket), [0, 1, 1, 2, 2, 3, 3]);
  assert.deepEqual([1, 3, 4, 10].map(dotSize), [30, 34, 40, 46]);
});


test('all places share the roster, while city/country picks narrow it correctly', () => {
  const members = [person(1, at('2026-10-30')), person(2, at('2015-09-01')), person(3, null),
    person(4, at('2026-10-26'), {province_code: '810000', city_code: ''}),
    person(5, at('2026-10-26'), {country_code: 'SGP', province_code: '', city_code: ''})];
  const range = presetRange('3y', today);
  const ids = (key, level) => splitForRegion(members, key, level, range).inRange.map(m => m.id);
  assert.deepEqual(ids(null, null), [1, 4, 5]);
  assert.deepEqual(ids('810000', 'china'), [4]);
  assert.deepEqual(ids('CHN', 'world'), [1, 4]);
  assert.deepEqual(ids('SGP', 'world'), [5]);
  assert.deepEqual(splitForRegion(members, '420100', 'china', range).others.map(m => m.id), [2, 3]);
  assert.deepEqual(consistentCounts(members, range), {china: 2, world: 1, total: 3});
  assert.deepEqual([...countByKey(members, range, 'world')], [['CHN', 2], ['SGP', 1]]);
});

test('HK/Macau/Taiwan retain province keys in China and count in China on the world layer', () => {
  const members = ['810000', '820000', '710000'].map((province, i) => person(i, at('2026-10-30'), {province_code: province, city_code: ''}));
  const range = presetRange('all', today);
  assert.deepEqual(consistentCounts(members, range), {china: 3, world: 0, total: 3});
  assert.deepEqual([...countByKey(members, range, 'china').keys()], ['810000', '820000', '710000']);
  assert.equal(countByKey(members, range, 'world').get('CHN'), 3);
  assert.equal(memberKey(person(1, null, {city_code: '', province_code: '420000'}).location), 'prov:420000');
  assert.equal(memberKey(person(1, null, {city_code: '110108', province_code: '110000'}).location), '110000');
});

test('cluster merges close points and keeps far ones', () => {
  const merged = cluster([{key: 'a', x: 0, y: 0, n: 5}, {key: 'b', x: 20, y: 0, n: 1}], 8);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].keys, ['a', 'b']);
  assert.equal(merged[0].n, 6);
  assert.ok(merged[0].x > 0 && merged[0].x < 10, 'position is weighted toward the bigger point');
  assert.equal(cluster([{key: 'a', x: 0, y: 0, n: 5}, {key: 'b', x: 200, y: 0, n: 1}], 8).length, 2);
});


test('stale indicator uses the same one-year cutoff as the list', () => {
  assert.equal(isStale(at('2025-11-01'), today), false);
  assert.equal(isStale(at('2025-10-31'), today), true);
  assert.equal(isStale(null, today), true);
});
