import {test, expect} from '@playwright/test';
import {bootToday, markerSum, numberIn, openSheet, presetLabel, unlock} from './helpers.mjs';

test('default range is the last 3 years', async ({page}) => {
  await unlock(page);
  const today = await bootToday(page);
  await expect(page.locator('#range [data-end=from] b')).toHaveText(presetLabel(today, 3));
  await expect(page.locator('#range [data-end=to] b')).toHaveText('今天');
  await expect(page.locator('#range [data-preset="3y"]')).toHaveClass(/\bon\b/);
});

test('counts agree across presets and scopes: header, sheet title and map dots', async ({page}) => {
  await unlock(page);
  await openSheet(page);
  for (const preset of ['1y', '3y', 'all']) {
    await page.locator(`#range [data-preset="${preset}"]`).click();
    const china = await numberIn(page.locator('#count-china'));
    await expect(page.locator('#sheet-title')).toHaveText(`${china} 位同学`);
    await expect.poll(() => markerSum(page)).toBe(china);
  }
  await page.locator('#scope-seg [data-scope="world"]').click();
  const world = await numberIn(page.locator('#count-world'));
  await expect(page.locator('#sheet-title')).toHaveText(`${world} 位同学`);
});

test('an empty range offers to widen it', async ({page}) => {
  await unlock(page);
  await openSheet(page);
  await page.locator('#range [data-end=from]').click();
  await page.locator('.picker [data-year="2017"]').click();
  await page.locator('.picker [data-month="1"]').click();
  await page.locator('#range [data-end=to]').click();
  await page.locator('.picker [data-year="2017"]').click();
  await page.locator('.picker [data-month="2"]').click();
  await expect(page.locator('#empty')).toContainText('这个时间段还没有同学确认过位置');
  await expect(page.locator('.pt')).toHaveCount(0);
  await page.locator('#expand-range').click();
  await expect(page.locator('#range [data-preset="all"]')).toHaveClass(/\bon\b/);
  await expect(page.locator('.pt').first()).toBeVisible();
});

test('range handles have a 48px hit area', async ({page}) => {
  await unlock(page);
  for (const box of await page.locator('#range .k').evaluateAll(handles => handles.map(h => h.getBoundingClientRect().toJSON()))) {
    expect(box.width).toBeGreaterThanOrEqual(48);
    expect(box.height).toBeGreaterThanOrEqual(48);
  }
});
