import {test, expect} from '@playwright/test';
import {dragSheet, openSheet, tapMarker, unlock} from './helpers.mjs';

// Found in the 2026-11-01 adversarial review: each case failed before its fix.

test('「修改」 on the time chip opens the panel on the time controls', async ({page}) => {
  await unlock(page);
  const dot = page.locator('.pt:not(.cl) .d').first();
  await tapMarker(page, dot);
  await expect(page.locator('#range-chip')).toBeVisible();
  await page.locator('#range-chip').click();
  await expect(page.locator('#range [data-preset="3y"]')).toBeInViewport();
});

test.describe('wide screens', () => {
  test.beforeEach(async ({page}, info) => {
    test.skip(info.project.name !== 'iphone', 'one desktop run is enough');
    await page.setViewportSize({width: 1280, height: 800});
  });

  test('看全部 stays clickable beside the open side panel', async ({page}) => {
    await unlock(page);
    await page.locator('#sheet-title').click();
    await expect(page.locator('#sheet')).toHaveAttribute('data-detent', 'full');
    await page.mouse.move(400, 400); await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(400 + i * 15, 400 + i * 8);
    await page.mouse.up();
    await expect(page.locator('#fit-all')).toBeVisible();
    await page.locator('#fit-all').click({timeout: 3000});   // fails if the panel sits on top of it
    await expect(page.locator('#fit-all')).toBeHidden();
  });

  test('a city opened from the map fills the side panel (no half-open panel running off screen)', async ({page}) => {
    await unlock(page);
    await page.waitForTimeout(1200);
    await tapMarker(page, page.locator('.pt:not(.cl) .d').first());
    await expect(page.locator('#sheet')).toHaveAttribute('data-detent', 'full');
    const box = await page.locator('#sheet').boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(800);
  });
});

test('the half-open home sheet shows the list, not only controls', async ({page}, info) => {
  // A short phone (SE) keeps the map usable at half; the list is one pull further up there.
  test.skip(info.project.name === 'se', 'short screens: the map keeps priority at half');
  await unlock(page);
  await openSheet(page);
  await page.waitForTimeout(500);
  await expect(page.locator('#sheet')).toHaveAttribute('data-detent', 'half');
  await expect(page.locator('#list .mem').first()).toBeInViewport({ratio: 1});
});

test('back from a member returns to where the list was scrolled', async ({page}) => {
  await unlock(page);
  await openSheet(page);
  await page.locator('#range [data-preset="all"]').click();
  await dragSheet(page, -700);                               // full: the whole list scrolls
  await expect(page.locator('#sheet')).toHaveAttribute('data-detent', 'full');
  await page.locator('#sheet-body').evaluate(body => {body.scrollTop = 600;});
  await page.locator('#list .mem').filter({visible: true}).nth(8).click();
  await expect(page.locator('#member-detail')).toBeVisible();
  await page.locator('#region-close').click();
  await expect(page.locator('#sheet')).toHaveAttribute('data-detent', 'full');
  expect(await page.locator('#sheet-body').evaluate(body => body.scrollTop)).toBeGreaterThan(400);
});
