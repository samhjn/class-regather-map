import {test, expect} from '@playwright/test';
import {openSheet, unlock} from './helpers.mjs';

const markerSum = page => page.locator('.pt .d').evaluateAll(dots => dots.reduce((sum, dot) => sum + Number(dot.textContent), 0));

test('count markers sum to the domestic count shown in the header', async ({page}) => {
  await unlock(page);
  await openSheet(page);
  await page.locator('#range [data-preset="all"]').click();
  const expected = await page.evaluate(async () => {
    const {members} = await (await fetch('api/snapshot', {credentials: 'same-origin'})).json();
    // 境内 = mainland only: Hong Kong, Macau and Taiwan are counted under 境外.
    return members.filter(m => m.location?.country_code === 'CHN' && !['810000', '820000', '710000'].includes(m.location.province_code) && m.location.confirmed_at).length;
  });
  await expect(page.locator('#count-china')).toHaveText(String(expected));
  await expect.poll(() => markerSum(page), {timeout: 15_000}).toBe(expected);
});

test('close cities merge into a cluster at the national zoom', async ({page}) => {
  await unlock(page);
  await expect(page.locator('.pt.cl').first()).toBeVisible();
  await expect(page.locator('.pt.cl .nm').first()).toHaveText(/等 \d+ 城$/);
});

test('amap attribution stays visible and city-level fill is captured for review', async ({page}, info) => {
  await unlock(page);
  await expect(page.locator('.amap-logo').first()).toBeVisible();
  await expect(page.locator('.amap-copyright').first()).toBeAttached();
  await page.waitForTimeout(2500);  // district tiles fade in after the markers
  await page.screenshot({path: `artifacts/map-depth2-${info.project.name}.png`});
});
