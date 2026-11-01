import {test, expect} from '@playwright/test';
import {openSheet, tapMarker, unlock} from './helpers.mjs';

// Found in the 2026-11-01 adversarial review: each case failed before its fix.

test('a quick fling of the range handle lands where the finger stopped, and the handle lets go afterwards', async ({page}) => {
  await unlock(page);
  await openSheet(page);
  await page.waitForTimeout(500);                            // let the sheet finish sliding before measuring the handle
  const handle = page.locator('#range [data-handle="from"]'), track = await page.locator('#range .rng').boundingBox();
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 3; i++) await page.mouse.move(box.x + box.width / 2 - (box.x - track.x + 40) * i / 3, box.y + box.height / 2);  // three big steps, past the left end
  await page.mouse.up();
  const from = await page.locator('#range [data-end="from"] b').textContent();
  expect(from).toBe('2015.09');                              // the earliest month in the demo data
  await page.mouse.move(track.x + track.width * 0.6, box.y + box.height / 2);  // hover, no button pressed
  await page.waitForTimeout(200);
  await expect(page.locator('#range [data-end="from"] b')).toHaveText(from);
});

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
