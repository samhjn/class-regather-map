import {test, expect} from '@playwright/test';
import {dragSheet, openSheet, openWuhan, unlock} from './helpers.mjs';

test('home sheet uses fuzzy confirmation buckets in recent-first order', async ({page}) => {
  await unlock(page); await dragSheet(page, -220);
  const labels = ['近1周', '近1月', '近1年', '近3年', '很久没有来过'];
  const tags = await page.locator('#sheet-body .mem:not(.old) .tag').allTextContents();
  expect(tags.length).toBe(3);
  const ranks = tags.map(tag => labels.indexOf(tag));
  expect(ranks.every(rank => rank >= 0)).toBe(true);
  expect([...ranks].sort()).toEqual(ranks);
});

test('city half sheet shows top 3 and an expand row; the dot is selected in place', async ({page}) => {
  await unlock(page);
  await openWuhan(page);
  await expect(page.locator('#sheet-title')).toHaveText(/^武汉 · \d+ 人$/);
  await expect(page.locator('#sheet-body .mem')).toHaveCount(3);
  await expect(page.locator('#sheet-body .more')).toContainText('展开全部');
  const sel = page.locator('.pt.sel .d');
  await expect(sel).toBeVisible();
  const box = await sel.boundingBox();
  const width = await sel.evaluate(el => el.offsetWidth);
  expect(box.width).toBeGreaterThanOrEqual(width * 1.4);
  await expect(sel).toHaveCSS('outline-style', 'none');
  await expect(page.locator('#range-chip')).toBeVisible();
});

test('expand shows both groups, with the older records greyed', async ({page}) => {
  await unlock(page);
  await openWuhan(page);
  await page.locator('#sheet-body .more').click();
  await expect(page.locator('#sheet')).toHaveAttribute('data-detent', 'full');
  await expect(page.locator('#sheet-body .sec').first()).toContainText('这段时间确认过');
  await expect(page.locator('#sheet-body .sec').nth(1)).toContainText('更早的记录');
  await expect(page.locator('#sheet-body .mem.old').first()).toContainText('很久没有来过');
});

test('world shortcut keeps the filter and the whole roster', async ({page}) => {
  await unlock(page); await openSheet(page);
  await page.locator('#range [data-preset="all"]').click();
  const title = await page.locator('#sheet-title').textContent();
  await page.locator('[data-scope="world"]').click();
  await expect(page.locator('#sheet-title')).toHaveText(title);
  await expect(page.locator('#range [data-preset="all"]')).toHaveAttribute('aria-pressed', 'true');
  await dragSheet(page, -700);
  await expect(page.locator('.mem', {hasText: '许港生'})).toContainText('香港');
});

test('a row opens the member detail with the footprint map', async ({page}) => {
  await unlock(page);
  await openWuhan(page);
  await page.locator('#sheet-body .mem').first().click();
  await expect(page.locator('#member-detail h2')).toBeVisible();
  await expect(page.locator('#footprint-map')).toBeVisible();
});

test('search finds anyone, including people with no location yet', async ({page}) => {
  await unlock(page);
  await dragSheet(page, -220);
  await page.locator('#search').fill('夏禾');
  await expect(page.locator('#sheet-body .mem')).toHaveCount(1);
  await expect(page.locator('#sheet-body .mem')).toContainText('还没填位置');
  await page.locator('#search').fill('');
  await dragSheet(page, -700);
  await expect(page.locator('#sheet-body .sec').last()).toContainText('还没填位置 · 1');
});

test('both views keep older and unplaced members reachable', async ({page}) => {
  await unlock(page);
  const total = await page.evaluate(async () => (await (await fetch('api/snapshot', {credentials: 'same-origin'})).json()).members.length);
  for (const scope of ['world', 'china']) {
    await page.locator(`[data-scope="${scope}"]`).click(); await dragSheet(page, -700);
    await expect(page.locator('#sheet-body .sec', {hasText: '更早的记录'})).toBeVisible();
    await expect(page.locator('#sheet-body .mem')).toHaveCount(total);
    await dragSheet(page, 700);
  }
});

test('tapping a row twice quickly builds only one footprint map', async ({page}) => {
  await unlock(page);
  await page.evaluate(() => {
    const Original = window.AMap.Map;
    window.__footprintMaps = 0;
    window.AMap.Map = function (container, options) {
      if (container === 'footprint-map') window.__footprintMaps++;
      return new Original(container, options);
    };
    window.AMap.Map.prototype = Original.prototype;
  });
  await dragSheet(page, -220);
  const row = page.locator('#sheet-body .mem').first();
  await row.evaluate(el => {el.click(); el.click();});  // a true double tap: both land before the first request returns
  await expect(page.locator('#footprint-map')).toBeVisible();
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => window.__footprintMaps)).toBe(1);
});
