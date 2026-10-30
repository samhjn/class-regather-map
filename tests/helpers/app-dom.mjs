import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setImmediate as tick} from 'node:timers/promises';
import {JSDOM} from 'jsdom';

const appURL = new URL('../../gathering/static/gathering/app.js', import.meta.url);
const template = await readFile(new URL('../../gathering/templates/gathering/index.html', import.meta.url), 'utf8');
const source = (await readFile(appURL, 'utf8')).replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, appURL)}'`);
let instance = 0;

export const stay = (extra = {}) => ({id: 1, country_code: 'CHN', country_name: '中国', province_code: '330000', province_name: '浙江省',
  city_code: '330100', city_name: '杭州市', label: '', longitude: null, latitude: null, coordinate_system: 'gcj02',
  started_on: '2024-01-01', ended_on: null, note: '', version: 'v1', updated_at: '2026-01-01T00:00:00Z',
  confirmed_at: '2026-01-01T08:00:00+08:00', ...extra});
export const person = (id, location = stay()) => ({id, name: `同学${id}`, bio: '', claimed: true, updated_at: 'm1', location});

export async function eventually(check) {
  for (let i = 0; i < 30; i++) {
    try {check(); return;} catch (error) {if (i === 29) throw error;}
    await tick();
  }
}

// Run the real app entry point against its real HTML. Only browser layout APIs and
// the backend are substituted; no AMap key or network is needed for these UI flows.
export async function openApp(t, {members = [person(1)], wide = true} = {}) {
  const dom = new JSDOM(template.replace(/\{%.*?%\}/g, ''), {url: 'https://example.test/c/demo/'});
  const {window} = dom, {document} = window;
  const $ = selector => {
    const node = document.querySelector(selector);
    assert.ok(node, `Missing element: ${selector}`);
    return node;
  };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLDialogElement.prototype.showModal = function () {this.open = true;};
  window.HTMLDialogElement.prototype.close = function () {this.open = false;};
  Object.defineProperty($('#sheet'), 'offsetHeight', {value: 800});
  const calls = [], timers = new Set(), nativeSetTimeout = globalThis.setTimeout;
  const boot = {classroom: {name: '测试班', description: '', slug: 'demo'}, me: {id: 1, name: '同学1'},
    authenticated: true, unlocked: true, has_password: true, is_admin: true, today: '2026-10-30', map: {},
    countries: {CHN: '中国', JPN: '日本'}, provinces: {'330000': '浙江省', '440000': '广东省'}};
  let imported = [], records = structuredClone(members);
  const fetch = async (url, options = {}) => {
    const route = new URL(url).pathname.split('/api/')[1];
    const data = options.body ? JSON.parse(options.body) : null;
    calls.push({route, method: options.method || 'GET', data});
    let body;
    if (route === 'bootstrap') body = boot;
    else if (route === 'snapshot') body = {members: records};
    else if (/^members\/\d+$/.test(route)) {
      const member = records.find(row => row.id === Number(route.split('/')[1]));
      assert.ok(member, `Unknown member: ${route}`);
      body = {member, locations: member.location ? [member.location] : [], editable: true};
    } else if (/^members\/\d+\/locations\/\d+$/.test(route) && options.method === 'PATCH') {
      const member = records.find(row => row.id === Number(route.split('/')[1]));
      Object.assign(member.location, data);
      body = {location: member.location};
    } else if (route === 'admin/settings') body = {name: '测试班', description: '', has_password: true};
    else if (route === 'admin/import') {
      if (data.commit) records.push(...structuredClone(imported));
      body = {preview_token: 'test-preview', created: imported.length, updated: 0, locations: imported.length, rows: imported.length};
    } else throw new Error(`Unexpected request: ${options.method} ${route}`);
    return {ok: true, json: async () => structuredClone(body)};
  };
  const globals = {window, document, location: window.location, history: window.history, FormData: window.FormData,
    AbortController: window.AbortController, innerHeight: 844, visualViewport: null, fetch,
    matchMedia: query => ({matches: wide && query === '(min-width: 720px)'}),
    addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window), DOMMatrixReadOnly: class {m42 = 0;},
    setTimeout: (fn, delay, ...args) => {const timer = nativeSetTimeout(fn, delay, ...args); timers.add(timer); return timer;}};
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
    window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  // A distinct module URL gives every test a fresh application state, without test exports.
  await import(`data:text/javascript;base64,${Buffer.from(source + `\n// instance ${instance++}`).toString('base64')}`);
  await eventually(() => assert.ok(document.querySelector('[data-preset="all"]')));
  const click = selector => $(selector).click();
  const input = (selector, value) => {$(selector).value = value; $(selector).dispatchEvent(new window.Event('input', {bubbles: true}));};
  const submit = selector => $(selector).dispatchEvent(new window.Event('submit', {bubbles: true, cancelable: true}));
  return {$, document, calls, click, input, submit,
    async importMembers(rows) {
      imported = rows;
      click('#account [data-act="admin"]');
      await eventually(() => assert.ok(document.querySelector('#import-open')));
      click('#import-open');
      input('#import-content', JSON.stringify(rows.map(row => ({student_code: String(row.id), name: row.name}))));
      submit('#import-form');
      await eventually(() => assert.ok(document.querySelector('#import-commit')));
      click('#import-commit');
      await eventually(() => assert.ok(document.querySelector('#import-open')));
      click('#modal-close');
    },
    async openEditor() {
      click('#account [data-act="profile"]');
      await eventually(() => assert.ok(document.querySelector('[data-edit]')));
      click('[data-edit]');
    },
  };
}
