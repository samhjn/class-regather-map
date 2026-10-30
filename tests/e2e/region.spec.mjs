import {test, expect} from '@playwright/test';
import {dragSheet, openSheet, openWuhan, unlock} from './helpers.mjs';

const months = page => page.locator('#sheet-body .mem:not(.old) .tag').evaluateAll(tags => tags.map(t => t.textContent.match(/\d{4}\.\d{2}/)?.[0]));

test('home sheet lists recent updates newest first', async ({page}) => {
  await unlock(page);
  await dragSheet(page, -220);
  const seen = (await months(page)).slice(0, 3);
  expect(seen.length).toBe(3);
  expect([...seen].sort().reverse()).toEqual(seen);
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
  await expect(page.locator('#sheet-body .mem.old').first()).toContainText('年的信息');
});

test('overseas scope keeps the range and groups by country', async ({page}) => {
  await unlock(page);
  await openSheet(page);
  await page.locator('#range [data-preset="all"]').click();
  await page.locator('#scope-seg [data-scope="world"]').click();
  await expect(page.locator('#range [data-preset="all"]')).toHaveClass(/\bon\b/);
  await dragSheet(page, -220);
  await expect(page.locator('#count-world')).toHaveText('4');  // 3 countries + Hong Kong (境外)
  await expect(page.locator('#sheet-body .sec', {hasText: '香港'})).toBeVisible();
  await expect(page.locator('#sheet-body .sec').first()).toContainText(/新加坡|日本|美国|香港/);
  // Continents apart cannot share one zoom-3 phone screen; at least one country dot is in view.
  await expect(page.locator('.pt').first()).toBeVisible();
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

test('the overseas home list also shows overseas classmates confirmed before the range', async ({page}) => {
  await unlock(page);
  await page.locator('#scope-seg [data-scope="world"]').click();
  await dragSheet(page, -700);
  const inRange = await page.locator('#count-world').textContent();
  const total = await page.evaluate(async () => (await (await fetch('api/snapshot', {credentials: 'same-origin'})).json())
    .members.filter(m => m.location && (m.location.country_code !== 'CHN' || ['810000', '820000', '710000'].includes(m.location.province_code))).length);  // 境外 includes HK/MO/TW
  expect(total).toBeGreaterThan(Number(inRange));  // the demo data has at least one older overseas stay
  await expect(page.locator('#sheet-body .sec', {hasText: '更早的记录'})).toBeVisible();
  const missing = await page.evaluate(async () => (await (await fetch('api/snapshot', {credentials: 'same-origin'})).json()).members.filter(m => !m.location).length);
  await expect(page.locator('#sheet-body .mem')).toHaveCount(total + missing);  // + the 还没填位置 group
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
