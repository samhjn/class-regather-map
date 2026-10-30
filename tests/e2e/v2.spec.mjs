import {test, expect} from '@playwright/test';
import {detent, dragSheet, loginAs, unlock} from './helpers.mjs';

// Round-2 feedback (2026-10-30): slim bar, tap-to-open, tap-map-to-close, a collapsible
// desktop panel, pinyin-initial search, and "still here" also updating workplace + note.

const visibleHeight = page => page.locator('#sheet').evaluate(el => innerHeight - el.getBoundingClientRect().top);

test('the closed sheet is a slim bar; tapping it opens the range and list', async ({page}) => {
  await unlock(page);
  expect(await detent(page)).toBe('peek');
  expect(await visibleHeight(page)).toBeLessThanOrEqual(150);
  await expect(page.locator('#range')).not.toBeInViewport();
  await expect(page.locator('#sheet-summary')).toContainText('近 3 年');
  await page.locator('#sheet-title').click();
  expect(await detent(page)).toBe('half');
  await expect(page.locator('#range [data-preset="3y"]')).toBeInViewport();
});

test('tapping empty map closes the sheet back to the bar', async ({page}) => {
  await unlock(page);
  await page.locator('#sheet-title').click();
  expect(await detent(page)).toBe('half');
  await page.mouse.click(30, 200);  // open sea / empty land, no dot there
  await expect(page.locator('#sheet')).toHaveAttribute('data-detent', 'peek');
});

test('desktop: the list is a right-hand panel that folds down to a small card', async ({page}, info) => {
  test.skip(info.project.name !== 'iphone', 'one desktop run is enough');
  await page.setViewportSize({width: 1280, height: 800});
  await unlock(page);
  const box = await page.locator('#sheet').boundingBox();
  expect(box.x + box.width).toBeGreaterThan(1280 - 40);  // right side: AMap's logo (bottom-left) stays clear
  expect(box.width).toBeLessThanOrEqual(420);
  expect(await visibleHeight(page)).toBeLessThanOrEqual(150);
  await page.locator('#sheet-title').click();
  await expect(page.locator('#sheet')).toHaveAttribute('data-detent', 'full');
  await expect.poll(() => visibleHeight(page)).toBeGreaterThanOrEqual(500);  // after the 340 ms slide
});

test('search understands pinyin initials', async ({page}) => {
  await unlock(page);
  await page.locator('#sheet-title').click();
  await page.locator('#search').fill('lx');
  await expect(page.locator('#sheet-body .mem', {hasText: '林晓'})).toBeVisible();
});

test.describe('updating, as each device profile\'s own member', () => {
  test.describe.configure({mode: 'serial'});
  const who = info => info.project.name === 'se' ? {name: '陈雨', city: '杭州'} : {name: '林晓', city: '上海'};

  test('the city search takes initials too', async ({page}, info) => {
    await loginAs(page, who(info).name);
    await page.locator('#me-btn').click();
    await page.locator('#update-move').click();
    await expect(page.locator('#update-label')).toBeVisible();
    await expect(page.locator('#update-bio')).toBeVisible();
    await page.locator('#place-input').fill('sz');
    await expect(page.locator('.sugg [data-place]', {hasText: '深圳'}).first()).toBeVisible();
  });

  test('a conflict keeps what you typed, and one more tap saves it', async ({page}, info) => {
    await loginAs(page, who(info).name);
    await page.locator('#me-btn').click();
    await page.locator('#update-confirm').click();
    await page.locator('#update-label').fill('冲突测试单位');
    await page.locator('#update-bio').fill('冲突测试备注');
    let sent = 0, bodies = [];
    await page.route(/\/api\/members\/\d+\/locations\/\d+$/, async route => {
      sent++; bodies.push(route.request().postDataJSON());
      if (sent === 1) return route.fulfill({status: 409, contentType: 'application/json', body: '{"error":"个人备注已被更新，请重新打开再改"}'});
      return route.continue();
    });
    await page.locator('#update-still-save').click();
    await expect(page.locator('#update .field-error')).toContainText('已被更新');
    await expect(page.locator('#update-label')).toHaveValue('冲突测试单位');
    await expect(page.locator('#update-bio')).toHaveValue('冲突测试备注');
    await page.locator('#update-still-save').click();
    await expect(page.locator('#toast')).toContainText('已确认还在');
    expect(sent).toBe(2);
    expect(bodies[1].bio).toBe('冲突测试备注');
    expect(bodies[1].member_version).toBeTruthy();  // one request carries the note and its version
    await page.unroute(/\/api\/members\/\d+\/locations\/\d+$/);
  });

  test('after a real conflict the retry keeps the other device\'s workplace and saves only my note', async ({page}, info) => {
    await loginAs(page, who(info).name);
    await page.locator('#me-btn').click();
    await page.locator('#update-confirm').click();
    // "Another device" edits the workplace of the same stay while this form is open.
    await page.evaluate(async () => {
      const token = document.cookie.split('; ').find(c => c.startsWith('csrftoken='))?.split('=')[1] || '';
      const me = (await (await fetch('api/bootstrap', {credentials: 'same-origin'})).json()).me;
      const detail = await (await fetch(`api/members/${me.id}`, {credentials: 'same-origin'})).json();
      const stay = detail.locations.find(loc => !loc.ended_on);
      const keys = ['country_code', 'province_code', 'city_code', 'city_name', 'longitude', 'latitude', 'coordinate_system', 'started_on', 'ended_on', 'note'];
      const body = Object.fromEntries(keys.map(k => [k, stay[k] ?? '']));
      await fetch(`api/members/${me.id}/locations/${stay.id}`, {method: 'PATCH', credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRFToken': decodeURIComponent(token)},
        body: JSON.stringify({...body, label: '另一台设备改的单位', version: stay.version})});
    });
    await page.locator('#update-bio').fill('只改了备注');
    await page.locator('#update-still-save').click();
    await expect(page.locator('#update .field-error')).toContainText('已刷新');
    await expect(page.locator('#update-label')).toHaveValue('另一台设备改的单位');  // untouched field follows the server
    await page.locator('#update-still-save').click();
    await expect(page.locator('#toast')).toContainText('已确认还在');
    const saved = await page.evaluate(async () => {
      const me = (await (await fetch('api/bootstrap', {credentials: 'same-origin'})).json()).me;
      const detail = await (await fetch(`api/members/${me.id}`, {credentials: 'same-origin'})).json();
      return {label: detail.locations.find(loc => !loc.ended_on).label, bio: detail.member.bio};
    });
    expect(saved).toEqual({label: '另一台设备改的单位', bio: '只改了备注'});
  });

  test('if refreshing after a conflict fails, it says so and saving waits for a working retry', async ({page}, info) => {
    await loginAs(page, who(info).name);
    await page.locator('#me-btn').click();
    await page.locator('#update-confirm').click();
    await page.route('**/locations/*/confirm', route => route.fulfill({status: 409, contentType: 'application/json', body: '{"error":"记录已被更新，请刷新后再确认。"}'}));
    await page.route(/\/api\/members\/\d+$/, route => route.abort());
    await page.locator('#update-still-save').click();
    await expect(page.locator('#update .field-error')).toContainText('没刷新成功');
    await expect(page.locator('#update .field-error')).not.toContainText('已刷新');
    await page.unroute('**/locations/*/confirm');
    await page.unroute(/\/api\/members\/\d+$/);
  });

  test('two quick taps on 我 never wipe what I have started typing', async ({page}, info) => {
    await loginAs(page, who(info).name);
    let first = true;
    await page.route(/\/api\/members\/\d+$/, async route => {
      if (first) {first = false; await new Promise(r => setTimeout(r, 1500));}
      return route.continue();
    });
    await page.locator('#me-btn').evaluate(button => {button.click(); button.click();});  // both land before the sheet rises
    await page.locator('#update-confirm').click();
    await page.locator('#update-label').fill('正在输入');
    await page.waitForTimeout(2000);  // the slow first response lands now
    await expect(page.locator('#update-label')).toHaveValue('正在输入');
    await page.unroute(/\/api\/members\/\d+$/);
  });

  test('"still here" also asks for workplace and a personal note, then shows them', async ({page}, info) => {
    const me = who(info);
    await loginAs(page, me.name);
    await page.locator('#me-btn').click();
    const where = (await page.locator('#update .card .big').textContent()).trim();  // earlier specs may have moved this member
    await expect(page.locator('#search-box')).toBeHidden();  // the list search belongs to the home list only
    await page.locator('#update-confirm').click();
    await expect(page.locator('#update-label')).toBeVisible();
    await page.locator('#update-label').fill('华为 · 坂田');
    await page.locator('#update-bio').fill('周末有空，来了喊我');
    await page.locator('#update-still-save').click();
    await expect(page.locator('#toast')).toContainText(`已确认还在${where}`);
    await dragSheet(page, -220);
    await page.locator('#search').fill(me.name);
    const row = page.locator('#sheet-body .mem', {hasText: me.name});
    await expect(row).toContainText('华为 · 坂田');
    await expect(row).toContainText('周末有空，来了喊我');
    await expect(page.locator('#me-btn .dot')).toBeHidden();
  });
});

test.describe('features carried over from the original', () => {
  test('the summary says how many have no location, and overseas lists them too', async ({page}) => {
    await unlock(page);
    await expect(page.locator('#sheet-summary')).toContainText('另有 1 人未填位置');
    await page.locator('#scope-seg [data-scope="world"]').click();
    await dragSheet(page, -700);
    await expect(page.locator('#sheet-body .sec', {hasText: '还没填位置'})).toBeVisible();
  });

  test('after moving the map, a 看全部 button brings every dot back into view', async ({page}) => {
    await unlock(page);
    await expect(page.locator('#fit-all')).toBeHidden();
    const map = await page.locator('#map').boundingBox();
    await page.mouse.move(map.x + 200, map.y + 300);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(map.x + 200 + i * 15, map.y + 300 + i * 10);
    await page.mouse.up();
    await expect(page.locator('#fit-all')).toBeVisible();
    await page.locator('#fit-all').click();
    await expect(page.locator('#fit-all')).toBeHidden();
  });

  test('account links sit at the bottom of the 我 page; my own row is marked 我', async ({page}, info) => {
    const name = info.project.name === 'se' ? '陈雨' : '林晓';
    await loginAs(page, name);
    await page.locator('#me-btn').click();
    await expect(page.locator('#update-account')).toContainText('改密码');
    await page.locator('#region-close').click();
    await dragSheet(page, -220);
    await page.locator('#search').fill(name);
    await expect(page.locator('#sheet-body .mem', {hasText: name}).locator('.me')).toHaveText('我');
  });

  test('a footprint shows when it was last updated and explains the leave date', async ({page}) => {
    await loginAs(page, '林晓');
    await dragSheet(page, -700);
    await page.locator('#account [data-act="profile"]').click();
    await expect(page.locator('#member-detail')).toContainText('资料更新于');
    await expect(page.locator('#member-detail')).toContainText('离开当天起不计入');
  });
});

test('the scope switch reads 境内 / 境外, and Hong Kong is counted under 境外', async ({page}) => {
  await unlock(page);
  await expect(page.locator('#scope-seg [data-scope="china"]')).toContainText('境内');
  await expect(page.locator('#scope-seg [data-scope="world"]')).toContainText('境外');
  await page.locator('#sheet-title').click();
  await page.locator('#range [data-preset="all"]').click();
  await page.locator('#scope-seg [data-scope="world"]').click();
  await dragSheet(page, -700);
  const group = page.locator('#sheet-body .sec', {hasText: '香港'});
  await expect(group).toBeVisible();
  // The person sits right under the 香港 group header.
  expect(await group.evaluate(sec => sec.nextElementSibling?.textContent)).toContain('许港生');
});
