import {expect} from '@playwright/test';

// The app throttles unlock attempts per IP; a full two-device run would trip it, so one
// unlocked session is reused until it stops working (a login rotates the session key).
let gateSession = null;
export async function unlock(page) {
  const shown = () => expect(page.locator('#gate, #app').filter({visible: true}).first()).toBeVisible();
  if (gateSession && !(await page.context().cookies()).some(cookie => cookie.name === 'sessionid')) await page.context().addCookies(gateSession);
  await page.goto('/c/demo/');
  await shown();
  if (await page.locator('#gate').isVisible()) {
    await page.getByLabel('班级查看码').fill('demo-password-123');
    await page.getByRole('button', {name: '打开班级地图'}).click();
    await expect(page.locator('#app')).toBeVisible();
    gateSession = (await page.context().cookies()).filter(cookie => cookie.name === 'sessionid');
  }
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('.pt .d').first()).toBeVisible({timeout: 30_000});
}

export const bootToday = page => page.evaluate(async () => (await (await fetch('api/bootstrap', {credentials: 'same-origin'})).json()).today);

// Same arithmetic as filter.js presetRange, kept independent on purpose.
export function presetLabel(today, years) {
  const index = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1 - years * 12;
  return `${Math.floor(index / 12)}.${String(index % 12 + 1).padStart(2, '0')}`;
}

export async function dragSheet(page, dy) {
  const grab = await page.locator('#sheet .grab').boundingBox();
  const x = grab.x + grab.width / 2, y = grab.y + grab.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // A slow drag that settles before release: no flick, so the nearest stop wins.
  for (let i = 1; i <= 8; i++) {await page.mouse.move(x, y + dy * i / 8); await page.waitForTimeout(40);}
  await page.waitForTimeout(150);
  await page.mouse.move(x, y + dy);
  await page.mouse.up();
  await page.waitForTimeout(500);
}

export const detent = page => page.locator('#sheet').getAttribute('data-detent');
export const markerSum = page => page.locator('.pt .d').evaluateAll(dots => dots.reduce((sum, dot) => sum + Number(dot.textContent), 0));
export const numberIn = async locator => Number((await locator.textContent()).match(/\d+/)[0]);

// AMap's 3D mode nudges HTML markers by sub-pixels every frame, so Playwright's
// "stable" wait never settles; tap the dot's centre through the real input path.
export async function tapMarker(page, locator) {
  await page.waitForTimeout(400);
  const box = await locator.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

export async function openWuhan(page) {
  const wuhan = page.locator('.pt', {has: page.locator('.nm', {hasText: /^武汉$/})});
  const wuhanCluster = page.locator('.pt.cl', {has: page.locator('.nm', {hasText: /^武汉等/})});
  await page.waitForTimeout(1200);  // initial fit animation
  for (let i = 0; i < 4 && !(await wuhan.count()); i++) {
    if (await wuhanCluster.count()) await tapMarker(page, wuhanCluster.locator('.d'));
    await page.waitForTimeout(1000);
  }
  await tapMarker(page, wuhan.locator('.d'));
  await expect(page.locator('#sheet')).toHaveAttribute('data-detent', 'half');
}

// Real touch input (CDP), for gestures where the browser's own touch handling matters.
export async function touchDrag(page, locator, dy) {
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, py) => cdp.send('Input.dispatchTouchEvent', {type, touchPoints: type === 'touchEnd' ? [] : [{x, y: py}]});
  await touch('touchStart', y);
  for (let i = 1; i <= 10; i++) {await touch('touchMove', y + dy * i / 10); await page.waitForTimeout(40);}
  await page.waitForTimeout(150);
  await touch('touchEnd', y + dy);
  await page.waitForTimeout(500);
}

// Log in as a demo member, reusing one session per account across tests: the app's own
// login throttle (15 tries per account / 15 min) would otherwise trip during a full run.
const sessions = new Map();
export async function loginAs(page, name) {
  await unlock(page);
  const cached = sessions.get(name);
  if (cached) {
    await page.context().addCookies(cached);
    await page.reload();
    const me = await page.evaluate(async () => (await (await fetch('api/bootstrap', {credentials: 'same-origin'})).json()).me);
    if (me?.name === name) {await expect(page.locator('.pt .d').first()).toBeVisible({timeout: 30_000}); return;}
    sessions.delete(name);  // logged out by an earlier test ("不是我"): log in again
    await page.context().clearCookies();
    await unlock(page);
  }
  await page.evaluate(async name => {
    const token = document.cookie.split('; ').find(c => c.startsWith('csrftoken='))?.split('=')[1] || '';
    const response = await fetch('api/login', {method: 'POST', credentials: 'same-origin',
      headers: {'Content-Type': 'application/json', 'X-CSRFToken': decodeURIComponent(token)},
      body: JSON.stringify({name, password: 'demo-password-123'})});
    if (!response.ok) throw new Error(await response.text());
  }, name);
  sessions.set(name, (await page.context().cookies()).filter(cookie => cookie.name === 'sessionid'));
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('.pt .d').first()).toBeVisible({timeout: 30_000});
}

// The closed sheet is a slim bar; tap its title to open it (range, legend, list).
export async function openSheet(page) {
  if ((await page.locator('#sheet').getAttribute('data-detent')) === 'peek') await page.locator('#sheet-title').click();
  await expect(page.locator('#range [data-preset="3y"]')).toBeInViewport();
}
