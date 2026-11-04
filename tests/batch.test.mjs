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

test('a round spread over a few months is still one round; a gap of more than six months starts a new one', () => {
  const spread = people([...repeat('2026-10-20', 3), ...repeat('2027-01-15', 3)]);   // three months apart: one round of 6
  assert.equal(latestBatch(spread, '2031-05-15').label, '2026.10');
  const split = people([...repeat('2026-10-20', 3), ...repeat('2027-06-15', 3)]);    // eight months apart: two rounds of 3
  assert.equal(latestBatch(split, '2031-05-15'), null);
});

test('when no round ever had enough people, there is no shortcut (全部 stays the way to see everyone)', () => {
  assert.equal(latestBatch(people(['2015-09-01', '2020-01-01', '2024-01-01']), '2031-05-15'), null);
});
