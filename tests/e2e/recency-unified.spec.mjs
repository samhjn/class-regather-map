import {test, expect} from '@playwright/test';
import {dragSheet} from './helpers.mjs';

// Deterministic UI regression: real app/HTML/CSS, synthetic classmates and SDK.
// Live AMap rendering remains covered by map.spec.mjs with a configured API key.
const date = '2026-11-01';
const stay = (province, city, name, confirmed, longitude, latitude) => ({id: Number(city || province),
  country_code: 'CHN', country_name: '中国', province_code: province, province_name: name,
  city_code: city, city_name: name, confirmed_at: `${confirmed}T12:00:00+08:00`,
  longitude, latitude, label: '', note: '', coordinate_system: 'gcj02', started_on: '2020-01-01', ended_on: null, version: 'v1'});
const records = [
  stay('440000', '440100', '广州市', '2026-10-30', 113.26, 23.13),
  stay('440000', '440300', '深圳市', '2026-10-27', 114.06, 22.54),
  stay('810000', '', '香港特别行政区', '2026-10-01', 114.17, 22.32),
  stay('820000', '', '澳门特别行政区', '2026-04-01', 113.55, 22.20),
  stay('330000', '330100', '杭州市', '2024-05-01', 120.15, 30.27),
  {...stay('', '', '日本', '2015-01-01', 138.25, 36.2), country_code: 'JPN', country_name: '日本'},
];
const members = records.map((location, i) => ({id: i + 1, name: ['林一', '陈二', '许港生', '何澳生', '周五', '李六'][i], bio: '', location}));

async function setup(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    class Map {
      constructor(element) {this.el = document.getElementById(element); this.events = {}; this.markers = []; this.center = [114, 23]; this.scale = 150;}
      on(name, fn) {this.events[name] = fn;}
      off(name) {delete this.events[name];}
      getContainer() {return this.el;}
      getZoom() {return 9;}
      addControl() {}
      add(items) {for (const marker of [].concat(items)) if (marker.content) {this.markers.push(marker); this.el.append(marker.content);} this.position();}
      remove(items) {for (const marker of [].concat(items)) if (marker?.content) {marker.content.remove(); this.markers = this.markers.filter(m => m !== marker);}}
      lngLatToContainer([lng, lat]) {return {x: this.el.clientWidth / 2 + (lng - this.center[0]) * this.scale, y: this.el.clientHeight / 2 - (lat - this.center[1]) * this.scale};}
      position() {for (const marker of this.markers) {const p = this.lngLatToContainer(marker.position); Object.assign(marker.content.style, {position: 'absolute', left: `${p.x}px`, top: `${p.y}px`});}}
      setFitView(points) {if (points.length) {this.center = [0, 1].map(i => points.reduce((sum, p) => sum + p.position[i], 0) / points.length); this.events.moveend?.();}}
      setCenter(center) {this.center = center; this.events.moveend?.();}
      setZoomAndCenter(zoom, center) {this.setCenter(center);}
      destroy() {this.remove(this.markers);}
    }
    class Layer {setStyles() {}}
    const city = (adcode, name) => ({adcode, name, center: {lng: 114, lat: 23}, districtList: []});
    window.AMap = {Map, Scale: class {}, ToolBar: class {}, Geocoder: class {},
      DistrictLayer: {World: Layer, Country: Layer, Province: Layer},
      DistrictSearch: class {search(query, done) {done('complete', {districtList: [{districtList: [
        {...city('440000', '广东省'), districtList: [city('440100', '广州市'), city('440300', '深圳市')]},
        city('810000', '香港特别行政区'), city('820000', '澳门特别行政区')]}]});}},
      LngLat: class extends Array {constructor(lng, lat) {super(lng, lat);}},
      Pixel: class {}, Marker: class {constructor(options) {Object.assign(this, options);}}, Polyline: class {},
    };
  });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.split('/api/')[1];
    const body = path === 'bootstrap' ? {classroom: {name: '测试班'}, unlocked: true, me: {id: 1, name: '林一'},
      authenticated: true, today: date, countries: {CHN: '中国', JPN: '日本'}, provinces: {'440000': '广东省'}, map: {}}
      : path === 'snapshot' ? {members}
      : path === 'members/1' ? {member: members[0], locations: [records[0]], editable: true}
      : {};
    await route.fulfill({json: body});
  });
  await page.goto('/c/demo/');
  await expect(page.locator('#sheet-title')).toHaveText('5 位同学');
  return errors;
}

async function expand(page) {
  await page.locator('#sheet').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {}))));
  await dragSheet(page, -700);
  await expect(page.locator('#sheet')).toHaveAttribute('data-detent', 'full');
}

test('three presets, fuzzy labels and stable classmates across both view shortcuts', async ({page}, info) => {
  const errors = await setup(page);
  await expand(page);
  await expect(page.locator('#range button')).toHaveText(['近一年', '近三年', '全部']);
  await expect(page.locator('#range [role="slider"], #range [data-end]')).toHaveCount(0);
  await expect(page.locator('#list .tag')).toHaveText(['近1周', '近1周', '近1月', '近1年', '近3年', '很久没有来过']);
  const ids = () => page.locator('#list [data-member]').evaluateAll(rows => rows.map(row => row.dataset.member));
  const before = await ids();
  await page.locator('[data-preset="1y"]').click();
  await expect(page.locator('#sheet-title')).toHaveText('4 位同学');
  await page.locator('[data-preset="all"]').click();
  await expect(page.locator('#sheet-title')).toHaveText('6 位同学');
  expect(await ids()).toEqual(before);
  await page.screenshot({path: `artifacts/recency-${info.project.name}.png`});
  await page.locator('.grab').click(); // full -> peek, exposing the top bar
  for (const scope of ['world', 'china']) {
    await page.locator(`[data-scope="${scope}"]`).click(); await expand(page);
    expect(await ids()).toEqual(before);
    await expect(page.locator('.mem', {hasText: '许港生'})).toContainText('香港');
    await expect(page.locator('.mem', {hasText: '何澳生'})).toContainText('澳门');
    await page.locator('.grab').click();
  }
  const boxes = await page.locator('.top button').evaluateAll(buttons => buttons.map(b => b.getBoundingClientRect().toJSON()));
  expect(boxes[1].right).toBeLessThanOrEqual(boxes[2].left);
  expect(errors).toEqual([]);
});

test('location update searches Hong Kong and Japan without choosing a mode', async ({page}) => {
  const errors = await setup(page);
  await page.locator('#me-btn').click();
  await expect(page.locator('#update .card')).toContainText('近1周');
  await page.locator('#update-move').click();
  await expect(page.locator('#update [data-mode]')).toHaveCount(0);
  for (const query of ['深圳', '香港', '澳门', '日本']) {
    await page.locator('#place-input').fill(query);
    await expect(page.locator('.sugg')).toContainText(query);
  }
  await page.locator('#place-input').fill('香港');
  await page.locator('.sugg [data-place]').click();
  const saving = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/members/1/locations'));
  await page.locator('#update-save').click();
  const payload = (await saving).postDataJSON();
  expect(payload.country_code).toBe('CHN'); expect(payload.province_code).toBe('810000');
  expect(payload.city_code).toBe('');
  await expect(page.locator('#toast')).toContainText('已更新到香港');
  expect(errors).toEqual([]);
});
