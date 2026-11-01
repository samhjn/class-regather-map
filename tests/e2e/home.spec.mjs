import {test, expect} from '@playwright/test';
import {markerSum, numberIn, openSheet, unlock} from './helpers.mjs';

test('default filter is three years with only three preset buttons', async ({page}) => {
  await unlock(page); await openSheet(page);
  await expect(page.locator('#range [data-preset="3y"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#range button')).toHaveText(['近一年', '近三年', '全部']);
  await expect(page.locator('#range [data-end], #range [role="slider"]')).toHaveCount(0);
});

test('presets keep list and map counts consistent in both views', async ({page}) => {
  await unlock(page); await openSheet(page);
  for (const preset of ['1y', '3y', 'all']) {
    await page.locator(`#range [data-preset="${preset}"]`).click();
    const total = await numberIn(page.locator('#sheet-title'));
    await expect.poll(() => markerSum(page)).toBe(total);
    for (const scope of ['world', 'china']) {
      await page.locator(`[data-scope="${scope}"]`).click();
      await expect(page.locator('#sheet-title')).toHaveText(`${total} 位同学`);
      await expect.poll(() => markerSum(page)).toBe(total);
    }
    await openSheet(page);
  }
});

test('preset buttons have a touch-friendly hit area', async ({page}) => {
  await unlock(page); await openSheet(page);
  for (const box of await page.locator('#range button').evaluateAll(buttons => buttons.map(b => b.getBoundingClientRect().toJSON()))) {
    expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
  }
});
