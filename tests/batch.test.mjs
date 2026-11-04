import test from 'node:test';
import assert from 'node:assert/strict';
import {batchRange, inRange, latestBatch, presetRange} from '../gathering/static/gathering/filter.js';

// One member per confirmation date (each member's current location).
const people = dates => dates.map((date, id) => ({id, location: {country_code: 'CHN', province_code: '420000', city_code: '420100', confirmed_at: `${date}T12:00:00+08:00`}}));
const repeat = (date, n) => Array(n).fill(date);

test('with enough people confirmed in 近三年 there is no batch shortcut: the three presets stay as they are', () => {
  assert.equal(latestBatch(people([...repeat('2015-09-01', 16), ...repeat('2026-10-20', 18)]), '2026-11-04'), null);
});

test('years later, the shortcut starts at the last round of updates that had enough people (the 2026.10 round)', () => {
  const members = people([...repeat('2015-09-01', 16), ...repeat('2026-10-20', 9), ...repeat('2026-11-03', 9), '2029-05-10', '2030-03-02']);
  const batch = latestBatch(members, '2031-05-15');
  assert.deepEqual({from: batch.from, label: batch.label, count: batch.count}, {from: '2026-10-01', label: '2026.10', count: 20});
  const range = batchRange(batch, '2031-05-15');
  assert.equal(members.filter(member => inRange(member.location.confirmed_at, range)).length, 20);  // the round plus the two later ones
  assert.equal(members.filter(member => inRange(member.location.confirmed_at, presetRange('3y', '2031-05-15'))).length, 2);
});

test('a round is a burst: at least five people within three months; the burst may run on for a while', () => {
  const burst = people([...repeat('2026-10-20', 3), ...repeat('2026-12-10', 3)]);       // six within three months
  assert.equal(latestBatch(burst, '2031-05-15').label, '2026.10');
  const thin = people([...repeat('2026-10-20', 3), ...repeat('2027-03-15', 3)]);        // five months apart: two thin groups
  assert.equal(latestBatch(thin, '2031-05-15'), null);
});

test('old stays trickling in every couple of months never chain into one huge round: the 2026.10 burst wins', () => {
  // Imported records carry their move-in dates as confirmations: one every two months, 2016–2026.
  const trickle = Array.from({length: 60}, (_, i) => `${2016 + Math.floor(i / 6)}-${String(1 + (i % 6) * 2).padStart(2, '0')}-15`);
  assert.equal(latestBatch(people(trickle), '2031-05-15'), null);
  const withLaunch = people([...trickle, ...repeat('2026-10-25', 12), ...repeat('2026-11-05', 6)]);
  assert.equal(latestBatch(withLaunch, '2031-05-15').label, '2026.10');
});

test('a lone confirmation a month or two before the launch does not pull the start earlier', () => {
  const members = people(['2026-08-15', ...repeat('2026-10-25', 12), ...repeat('2026-11-05', 6)]);
  assert.equal(latestBatch(members, '2031-05-15').label, '2026.10');
});

test('when no round ever had enough people, there is no shortcut (全部 stays the way to see everyone)', () => {
  assert.equal(latestBatch(people(['2015-09-01', '2020-01-01', '2024-01-01']), '2031-05-15'), null);
});
