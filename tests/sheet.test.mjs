import test from 'node:test';
import assert from 'node:assert/strict';
import {nearestStop, project, rubberband} from '../gathering/static/gathering/sheet.js';

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
