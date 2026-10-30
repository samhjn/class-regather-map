import test from 'node:test';
import assert from 'node:assert/strict';
import {eventually, openApp, person, stay} from './helpers/app-dom.mjs';

const writes = app => app.calls.filter(call => call.method === 'PATCH');

test('editing place text cannot save the previous place; picking a result allows saving', async t => {
  const app = await openApp(t);
  await app.openEditor();
  app.input('#place-input', '广东');
  app.submit('#location-form');
  await eventually(() => assert.match(app.$('#location-form .form-error').textContent, /点选/));
  assert.equal(writes(app).length, 0);
  assert.equal(app.$('#province-code').value, '');
  assert.equal(app.$('#city-code').value, '');
  app.click('#location-form [data-place="0"]'); // province fallback when AMap is unavailable
  app.submit('#location-form');
  await eventually(() => assert.equal(writes(app).length, 1));
  assert.equal(writes(app)[0].data.province_code, '440000');
  assert.equal(writes(app)[0].data.city_code, '');
  assert.equal(writes(app)[0].data.city_name, '');
  await eventually(() => assert.match(app.$('#toast').textContent, /足迹已保存/));
});

test('editing only a note preserves the existing place without requiring another selection', async t => {
  const app = await openApp(t);
  await app.openEditor();
  app.input('#location-form [name="note"]', '周末有空');
  app.submit('#location-form');
  await eventually(() => assert.match(app.$('#toast').textContent, /足迹已保存/));
  assert.equal(writes(app)[0].data.city_code, '330100');
  assert.equal(writes(app)[0].data.note, '周末有空');
});

for (const alreadyAll of [false, true]) test(`importing an older location updates All and its axis (already selected: ${alreadyAll})`, async t => {
  const app = await openApp(t);
  if (alreadyAll) app.click('[data-preset="all"]');
  await app.importMembers([person(2, stay({id: 2, confirmed_at: '2015-09-01T00:00:00+08:00'}))]);
  if (!alreadyAll) app.click('[data-preset="all"]');
  assert.equal(app.$('[data-end="from"] b').textContent, '2015.09');
  assert.equal(app.$('#count-china').textContent, '2');
  assert.equal(app.$('[data-handle="from"]').style.left, '0%');
});

test('import refresh preserves a custom time range', async t => {
  const app = await openApp(t);
  app.click('[data-end="from"]');
  app.click('.picker [data-year="2025"]');
  app.click('.picker [data-month="1"]');
  await app.importMembers([person(2, stay({id: 2, confirmed_at: '2015-09-01T00:00:00+08:00'}))]);
  assert.equal(app.$('[data-end="from"] b').textContent, '2025.01');
  assert.equal(app.$('#count-china').textContent, '1');
});

for (const scope of ['china', 'world']) test(`unplaced members remain reachable when no location is in range (${scope})`, async t => {
  const app = await openApp(t, {members: [person(1, null)], wide: false});
  app.click(`[data-scope="${scope}"]`);
  app.click('[data-preset="all"]');
  app.click('.grab'); // phone half sheet
  assert.match(app.$('#list [data-more]').textContent, /展开全部/);
  app.click('#list [data-more]');
  assert.equal(app.$('#sheet').dataset.detent, 'full');
  assert.match(app.$('#list').textContent, /还没填位置/);
  assert.equal(app.document.querySelectorAll('#list [data-member]').length, 1);
  app.click('#list [data-member="1"]');
  await eventually(() => assert.ok(app.document.querySelector('#member-detail')));
});

test('older locations remain listed when the selected period contains nobody', async t => {
  const app = await openApp(t, {members: [person(1, stay({confirmed_at: '2015-09-01T00:00:00+08:00'}))]});
  app.click('.grab'); // desktop full sheet
  assert.match(app.$('#list').textContent, /这个时间段还没有同学确认过位置/);
  assert.match(app.$('#list').textContent, /更早的记录/);
  assert.equal(app.document.querySelectorAll('#list [data-member]').length, 1);
});

test('update -> own footprint -> back rebuilds the update page and can return home', async t => {
  const app = await openApp(t);
  app.click('#me-btn');
  await eventually(() => assert.ok(app.document.querySelector('#update-confirm')));
  app.click('#update-account [data-act="profile"]');
  await eventually(() => assert.ok(app.document.querySelector('#member-detail')));
  app.click('#region-close');
  await eventually(() => assert.ok(app.document.querySelector('#update-confirm')));
  assert.equal(app.document.querySelector('#member-detail'), null);
  assert.equal(app.$('#sheet-title').textContent, '更新我的位置');
  assert.equal(app.$('#sheet').dataset.detent, 'full');
  app.click('#region-close');
  assert.equal(app.$('#range').hidden, false);
  assert.equal(app.$('#region-close').hidden, true);
});

test('footprint -> update -> back still restores the footprint', async t => {
  const app = await openApp(t);
  app.click('#account [data-act="profile"]');
  await eventually(() => assert.ok(app.document.querySelector('#member-detail')));
  app.click('#me-btn');
  await eventually(() => assert.ok(app.document.querySelector('#update-confirm')));
  app.click('#region-close');
  await eventually(() => assert.ok(app.document.querySelector('#member-detail')));
  assert.equal(app.$('#sheet-title').textContent, '同学1');
});
