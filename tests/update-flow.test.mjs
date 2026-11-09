import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {JSDOM} from 'jsdom';

// The update form against a real DOM, with the backend, device location and app callbacks
// stubbed so in-flight requests can be held and released in any order.
const {window} = new JSDOM('<!doctype html><div id="root"></div>');
Object.assign(globalThis, {window, document: window.document, AbortController: window.AbortController, requestAnimationFrame: fn => setTimeout(fn, 0)});
window.HTMLElement.prototype.scrollIntoView = function () {};
const {renderUpdate, closeUpdate} = await import('../gathering/static/gathering/update.js');

const deferred = () => {let resolve, reject; const promise = new Promise((res, rej) => {resolve = res; reject = rej;}); return {promise, resolve, reject};};
const hangzhou = () => ({id: 7, country_code: 'CHN', country_name: '中国', province_code: '330000', province_name: '浙江省', city_code: '330100', city_name: '杭州市',
  label: '', longitude: null, latitude: null, coordinate_system: 'gcj02', started_on: '2024-01-01', ended_on: null, note: '', version: 'v1', confirmed_at: '2026-01-01T08:00:00+08:00'});
const city = (adcode, name, province) => ({adcode, name, province: {adcode: province, name: ''}});

function mount({current = hangzhou(), api, locate = () => new Promise(() => {}), onDone = async () => {}} = {}) {
  const root = document.querySelector('#root');
  const toasts = [];
  renderUpdate(root, {me: {id: 1, name: '林晓'}, current, bio: '', memberVersion: 'm1', today: '2026-11-01', api,
    notify: (message, error) => toasts.push({message, error}), countries: {JPN: '日本'}, provinces: {'440000': '广东省'},
    divisions: () => ({list: [city('440300', '深圳市', '440000'), city('440100', '广州市', '440000')], cities: new Map()}),
    locate, todayInRange: () => true, onDone, onNotMe: () => {}});
  const $ = selector => root.querySelector(selector);
  const type = (selector, value) => {$(selector).value = value; $(selector).dispatchEvent(new window.Event('input', {bubbles: true}));};
  return {root, $, type, toasts};
}
const settle = async () => {for (let i = 0; i < 20; i++) await tick();};

test('after a conflict reveals the stay moved elsewhere, the form names the new place before confirming it', async () => {
  const calls = [];
  const api = async (path, method, data) => {
    calls.push({path, method, data});
    if (path.endsWith('/confirm') && calls.filter(call => call.path.endsWith('/confirm')).length === 1) throw Object.assign(new Error('记录已被更新'), {status: 409});
    if (path === 'members/1') return {member: {bio: '', updated_at: 'm2'}, locations: [{...hangzhou(), city_code: '440300', city_name: '深圳市', province_code: '440000', province_name: '广东省', version: 'v2'}]};
    return {};
  };
  const ui = mount({api});
  ui.$('#update-confirm').click();
  ui.$('#update-still-save').click();
  await settle();
  assert.match(ui.$('#update-still-save').textContent, /深圳/);
  assert.match(ui.$('.card .big').textContent, /深圳/);
});

test('a save that lands after the form was closed and reopened does not wipe the new draft', async () => {
  const first = deferred();
  let done = 0;
  const api = async path => path.endsWith('/confirm') ? first.promise : {};
  mount({api, onDone: async () => {done++;}}).$('#update-confirm').click();
  document.querySelector('#update-still-save').click();
  closeUpdate();                                    // leave the page while the save is in flight
  const again = mount({api: async () => ({}), onDone: async () => {done++;}});
  again.$('#update-confirm').click();
  again.type('#update-label', '新单位');
  first.resolve({});
  await settle();
  assert.equal(done, 0, 'the old save must not run the page-leaving callback');
  assert.equal(again.$('#update-label').value, '新单位');
});

test('a device location that arrives while saving cannot change the place or re-enable saving', async () => {
  const where = deferred(), posted = [];
  const api = async (path, method, data) => {if (method === 'POST') {posted.push(data); return new Promise(() => {});} return {};};
  const ui = mount({api, locate: () => where.promise});
  ui.$('#update-move').click();
  ui.type('#place-input', '深圳');
  ui.$('.sugg [data-place]').click();
  ui.$('#locate').click();                          // location still pending…
  ui.$('#update-save').click();                     // …when the save starts
  where.resolve(city('440100', '广州市', '440000'));
  await settle();
  assert.equal(ui.$('#update-save').disabled, true);
  ui.$('#update-save').click();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].city_code, '440300');
});

test('when the save succeeds but the page cannot refresh, the form says so instead of hanging on 正在保存', async () => {
  const ui = mount({api: async () => ({}), onDone: async () => {throw new Error('网络断开');}});
  ui.$('#update-confirm').click();
  ui.$('#update-still-save').click();
  await settle();
  assert.notEqual(ui.$('#update-still-save').textContent, '正在保存…');
  assert.ok(ui.toasts.some(toast => toast.error && /已保存/.test(toast.message)), JSON.stringify(ui.toasts));
});

test('a device location that cannot be matched to a city says so instead of doing nothing', async () => {
  const ui = mount({api: async () => ({}), locate: async () => null});
  ui.$('#update-move').click();
  ui.$('#locate').click();
  await settle();
  assert.ok(ui.toasts.some(toast => toast.error && /直接输入/.test(toast.message)), JSON.stringify(ui.toasts));
});

test('a second move on the same day corrects today\'s stay instead of being refused as "earlier"', async () => {
  const calls = [];
  const api = async (path, method, data) => {calls.push({path, method, data}); return {};};
  const ui = mount({api, current: {...hangzhou(), started_on: '2026-11-01'}});
  ui.$('#update-move').click();
  ui.type('#place-input', '深圳');
  ui.$('.sugg [data-place]').click();
  ui.$('#update-save').click();
  await settle();
  assert.equal(ui.$('.field-error').textContent, '');
  const write = calls.find(call => call.method !== 'GET');
  assert.deepEqual([write.method, write.path], ['PATCH', 'members/1/locations/7']);
  assert.deepEqual([write.data.city_code, write.data.province_code, write.data.started_on, write.data.version], ['440300', '440000', '2026-11-01', 'v1']);
  assert.equal(write.data.longitude, '');                  // the old city's point must not travel with the new city
});

test('a failed save keeps its message in place while retrying, and the reason reads without a doubled 。', async () => {
  let attempt = 0;
  const api = async path => {
    if (path.endsWith('/confirm')) {attempt++; throw Object.assign(new Error('服务暂时不可用，请稍后重试。'), {status: 500});}
    return {};
  };
  const ui = mount({api});
  ui.$('#update-confirm').click();
  ui.$('#update-still-save').click();
  await settle();
  const message = ui.$('.field-error').textContent;
  assert.doesNotMatch(message, /。。/);
  ui.$('#update-still-save').click();
  assert.equal(ui.$('.field-error').textContent, message);  // no jump: the button must not move under a second tap
  await settle();
  assert.equal(attempt, 2);
});
