import {test, expect} from '@playwright/test';

test('demo class unlocks with the view code', async ({page}) => {
  await page.goto('/c/demo/');
  await expect(page.locator('#class-title')).toContainText('演示班级');
  const gate = page.locator('#gate');
  await expect(gate).toBeVisible();

  await page.getByLabel('班级查看码').fill('demo-password-123');
  await page.getByRole('button', {name: '打开班级地图'}).click();

  await expect(gate).toBeHidden();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#sheet-title')).toHaveText(/^\d+ 位同学$/);
  await expect(page.locator('#sheet-summary')).toContainText('全班 38 人');
});
