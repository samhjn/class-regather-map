import {test, expect} from '@playwright/test';
import {dragSheet, loginAs, unlock} from './helpers.mjs';

const NATIVE = 'select, input[type=date], input[type=time], input[type=month], input[type=color]';
const nativeCount = page => page.locator(NATIVE).count();
// Every tappable thing in a dialog is a real 44px target (spec 4).
const smallButtons = page => page.locator('#modal button:visible').evaluateAll(buttons =>
  buttons.filter(b => b.getBoundingClientRect().height < 44).map(b => b.textContent.trim()));

// 林晓 (member 001) is demo-admin's member, so this login also opens admin dialogs.
async function loginAdmin(page) {
  await loginAs(page, '林晓');
  await dragSheet(page, -700);
}

test('every dialog is free of native pickers', async ({page}) => {
  await unlock(page);
  await dragSheet(page, -700);  // account links live at the end of the home list
  await page.locator('#account [data-act="login"]').click();
  await expect(page.locator('#modal')).toBeVisible();
  expect(await nativeCount(page)).toBe(0);
  await page.locator('#modal-close').click();

  await loginAdmin(page);
  for (const id of ['[data-act="password"]', '[data-act="admin"]']) {
    await page.locator(`#account ${id}`).click();
    await expect(page.locator('#modal')).toBeVisible();
    expect(await nativeCount(page), id).toBe(0);
    expect(await smallButtons(page), id).toEqual([]);
    await page.locator('#modal-close').click();
  }
  await page.locator('#account [data-act="admin"]').click();
  await page.locator('#import-open').click();
  expect(await nativeCount(page), 'import').toBe(0);
  await page.locator('#modal-close').click();

  await page.locator('#account [data-act="profile"]').click();
  await page.locator('#add-location').click();
  await expect(page.locator('#location-form')).toBeVisible();
  expect(await nativeCount(page), 'location').toBe(0);
  expect(await smallButtons(page), 'location').toEqual([]);
});

test('history editing uses the city search and the day picker', async ({page}, info) => {
  // Both device profiles share one database and one admin member: give each its own past stay.
  const [y1, y2] = info.project.name === 'se' ? ['2016', '2017'] : ['2019', '2020'];
  await loginAdmin(page);
  await page.locator('#account [data-act="profile"]').click();
  await page.locator('#add-location').click();
  await page.locator('#location-form #place-input').fill('成都');
  await page.locator('#location-form .sugg [data-place]', {hasText: '成都'}).first().click();
  await page.locator('#location-form [data-date="started_on"]').click();
  await page.locator(`.picker [data-year="${y1}"]`).click();
  await page.locator('.picker [data-month="3"]').click();
  await page.locator(`.picker [data-day="${y1}-03-15"]`).click();
  await page.locator('#location-form [data-date="ended_on"]').click();
  await page.locator(`.picker [data-year="${y2}"]`).click();
  await page.locator('.picker [data-month="7"]').click();
  await page.locator(`.picker [data-day="${y2}-07-01"]`).click();
  await page.locator('#location-form button[type=submit]').click();
  await expect(page.locator('#toast')).toContainText('足迹已保存');
  await expect(page.locator('#member-detail')).toContainText(`${y1}-03-15 → ${y2}-07-01`);
});

test('account links are reachable from the half sheet without scrolling the list', async ({page}) => {
  await unlock(page);
  const {dragSheet: drag} = await import('./helpers.mjs');
  await drag(page, -220);
  await expect(page.locator('#account [data-act="login"]')).toBeInViewport();
});
