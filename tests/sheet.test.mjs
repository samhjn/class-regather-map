import test from 'node:test';
import assert from 'node:assert/strict';
import {nearestStop, project, rubberband} from '../gathering/static/gathering/sheet.js';
import {axisStart, monthLabel, tickPercent} from '../gathering/static/gathering/range.js';
import {monthIndex} from '../gathering/static/gathering/filter.js';

test('momentum projection follows the exponential-decay form (d = 0.998)', () => {
  assert.equal(Math.round(project(1000)), 499);
  assert.equal(project(0), 0);
  assert.ok(project(-800) < 0);
});

test('a flick lands on the stop nearest the projected point, not the release point', () => {
  const stops = {peek: 300, half: 460, full: 800};
  assert.equal(nearestStop(320, stops), 'peek');
  assert.equal(nearestStop(320 + project(1500), stops), 'full');
  assert.equal(nearestStop(700 + project(-2500), stops), 'peek');
});

test('rubber band resists more the further it is pulled', () => {
  const small = rubberband(20, 800), big = rubberband(200, 800);
  assert.ok(small < 20 && big < 200);
  assert.ok(big / 200 < small / 20);
});

test('range ticks sit at their real-time proportion', () => {
  const earliest = monthIndex('2015-01-01'), now = monthIndex('2026-10-01');
  assert.equal(tickPercent(monthIndex('2015-01-01'), earliest, now), 0);
  assert.equal(tickPercent(now, earliest, now), 100);
  assert.equal(tickPercent(monthIndex('2021-01-01'), earliest, now), 51.1);  // 72 of 141 months
  assert.equal(monthLabel(monthIndex('2023-10-01')), '2023.10');
});

test('the axis always covers the default 3-year start, even when all data is recent', () => {
  const now = monthIndex('2026-10-01');
  assert.equal(axisStart(monthIndex('2025-10-01'), now, monthIndex('2023-10-01')), monthIndex('2023-10-01'));
  assert.equal(axisStart(monthIndex('2026-10-01'), now, now), now - 36);       // a single month of data
  assert.equal(axisStart(monthIndex('2015-09-01'), now, monthIndex('2023-10-01')), monthIndex('2015-09-01'));
});
