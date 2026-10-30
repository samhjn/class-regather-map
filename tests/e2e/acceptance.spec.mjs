import {test, expect} from '@playwright/test';
import {dragSheet, loginAs, openSheet, openWuhan, unlock} from './helpers.mjs';

// Screens compared by hand against the B v3 mockups (design mockups, not in the repo).
// Read-only: nothing here saves, so later specs still see the seeded data.
const shot = (page, info, n) => page.screenshot({path: `artifacts/acceptance/${info.project.name}-${n}.png`});
const settle = page => page.waitForTimeout(1800);

test('six screens for visual review', async ({page}, info) => {
  test.setTimeout(120_000);  // six screens, two logins and map settling
  await unlock(page);
  await settle(page);
  await shot(page, info, 1);                        // ① home
  await openWuhan(page);
  await settle(page);
  await shot(page, info, 2);                        // ② Wuhan half
  await page.locator('#sheet-body .more').click();
  await settle(page);
  await shot(page, info, 3);                        // ③ Wuhan full
  await page.locator('#region-close').click();
  await openSheet(page);
  await page.locator('#range [data-preset="all"]').click();
  await page.locator('#scope-seg [data-scope="world"]').click();
  await dragSheet(page, -220);
  await settle(page);
  await shot(page, info, 4);                        // ④ overseas

  await loginAs(page, info.project.name === 'se' ? '陈雨' : '林晓');
  await page.locator('#me-btn').click();
  await settle(page);
  await shot(page, info, 5);                        // ⑤ update: still here?
  await page.locator('#update-move').click();
  await page.locator('#place-input').fill('深');
  const {width, height} = page.viewportSize();
  await page.setViewportSize({width, height: height - 291});  // on-screen keyboard
  await settle(page);
  await shot(page, info, 6);                        // ⑥ moving, keyboard up
  await expect(page.locator('#update-save')).toBeInViewport();
  // The suggestion must stay tappable above the save bar while the keyboard is up.
  const suggestion = await page.locator('.sugg [data-place]').first().boundingBox();
  const bar = await page.locator('#update .savebar').boundingBox();
  expect(suggestion.y + suggestion.height).toBeLessThanOrEqual(bar.y + 1);
});

test('desktop stays usable', async ({page}, info) => {
  test.skip(info.project.name !== 'iphone', 'one desktop shot is enough');
  await page.setViewportSize({width: 1440, height: 900});
  await unlock(page);
  await settle(page);
  await page.screenshot({path: 'artifacts/acceptance/desktop-1.png'});
  await expect(page.locator('#sheet')).toBeInViewport();
  await expect(page.locator('.pt .d').first()).toBeInViewport();
});
