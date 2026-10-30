import test from 'node:test';
import assert from 'node:assert/strict';
import {ClassMap} from '../gathering/static/gathering/map.js';
import {consistentCounts, presetRange} from '../gathering/static/gathering/filter.js';

// Stub of the slice of the AMap 1.4.15 SDK that ClassMap touches. Screen projection is
// a plain scale so tests can push points together or apart by changing `scale`.
function stubSDK() {
  class MapStub {
    constructor(element, options) {this.options = options; this.events = {}; this.scale = 10; this.added = []; this.fits = [];}
    addControl() {}
    on(name, callback) {this.events[name] = callback;}
    off(name) {delete this.events[name];}
    add(items) {this.added.push(...[].concat(items));}
    remove(items) {const gone = new Set([].concat(items)); this.added = this.added.filter(item => !gone.has(item));}
    setZoomAndCenter() {}
    setFitView(markers, immediately, padding, maxZoom) {this.fits.push({markers, padding, maxZoom});}
    lngLatToContainer([lng, lat]) {return {x: lng * this.scale, y: -lat * this.scale};}
    destroy() {this.destroyed = true;}
  }
  class Layer {constructor(options) {this.options = options;} setStyles(styles) {this.options.styles = styles;}}
  return {Map: MapStub, ToolBar: class {}, Scale: class {},
    DistrictLayer: {World: Layer, Country: Layer, Province: Layer},
    LngLat: class extends Array {constructor(lng, lat) {super(lng, lat);}},
    Pixel: class {constructor(x, y) {this.x = x; this.y = y;}},
    Marker: class {constructor(options) {Object.assign(this, options);}}};
}

const divisions = {
  cities: new Map([['420100', {name: '武汉市', center: [114.3, 30.6]}], ['430100', {name: '长沙市', center: [112.9, 28.2]}],
    ['110000', {name: '北京市', center: [116.4, 39.9]}]]),
  provinces: new Map([['420000', {name: '湖北省', center: [114.3, 30.5]}]]),
};
const at = '2026-01-15T12:00:00+08:00';
const loc = (city, extra = {}) => ({country_code: 'CHN', province_code: city.slice(0, 2) + '0000', city_code: city, confirmed_at: at, ...extra});
const people = [
  ...Array.from({length: 5}, (_, i) => ({id: i + 1, name: `汉${i}`, location: loc('420100')})),
  {id: 10, name: '湘', location: loc('430100')},
  {id: 11, name: '京', location: loc('110000', {longitude: '116.40', latitude: '39.90'})},
  {id: 12, name: '鄂', location: loc('', {province_code: '420000'})},
  {id: 13, name: '旧', location: loc('420100', {confirmed_at: '2015-09-01T12:00:00+08:00'})},
  {id: 20, name: '狮城', location: {country_code: 'SGP', country_name: '新加坡', province_code: '', city_code: '', confirmed_at: at}},
  {id: 21, name: '空', location: null},
];
const range = presetRange('3y', '2026-10-29', '2015-09-01');

function withDocument(run) {
  const old = globalThis.document;
  globalThis.document = {createElement: tag => ({tag, setAttribute(k, v) {this[k] = v;}, addEventListener(name, fn) {this['on' + name] = fn;}})};
  const restore = () => {globalThis.document = old;};
  let result;
  try {result = run();} catch (error) {restore(); throw error;}
  if (result?.then) return result.finally(restore);  // async tests keep the stub until they finish
  restore();
  return result;
}
const countOf = marker => Number(marker.content.innerHTML.match(/class="d"[^>]*>(\d+)</)[1]);
const labelOf = marker => marker.content.innerHTML.match(/class="nm">([^<]*)</)[1];

test('count markers sum to the filtered domestic count and drop out-of-range people', () => withDocument(() => {
  const map = new ClassMap(stubSDK(), 'map', {divisions});
  map.update(people, range);
  const total = map.markers.reduce((sum, marker) => sum + countOf(marker), 0);
  assert.equal(total, consistentCounts(people, range).china);
  assert.equal(total, 8);
}));

test('province-only people get their own labelled point', () => withDocument(() => {
  const map = new ClassMap(stubSDK(), 'map', {divisions});
  map.map.scale = 1000;
  map.update(people, range);
  const province = map.markers.find(marker => labelOf(marker) === '湖北 · 未填城市');
  assert.ok(province);
  assert.notDeepEqual([...province.position], [...map.markers.find(marker => labelOf(marker) === '武汉').position],
    'the province-only dot must not sit exactly on the capital');
}));

test('close cities merge into a cluster that splits when zoomed in', () => withDocument(() => {
  const map = new ClassMap(stubSDK(), 'map', {divisions});
  map.map.scale = 10;  // Wuhan, Changsha and the Hubei point sit within a few pixels
  map.update(people, range);
  const merged = map.markers.find(marker => marker.content.className.includes('cl'));
  assert.ok(merged, 'a cluster marker exists');
  assert.match(labelOf(merged), /等 \d 城$/);
  map.map.scale = 1000; map.map.events.zoomend();
  assert.equal(map.markers.filter(marker => marker.content.className.includes('cl')).length, 0);
  assert.equal(map.markers.length, 4);
}));

test('clicking a city picks it; clicking a cluster zooms to its points', () => withDocument(() => {
  const picks = [], clusters = [];
  const map = new ClassMap(stubSDK(), 'map', {divisions, onPick: (key, level) => picks.push([key, level]), onClusterPick: keys => clusters.push(keys)});
  map.update(people, range);
  map.markers.find(marker => marker.content.className.includes('cl')).content.onclick({stopPropagation() {}});
  assert.equal(clusters.length, 1);
  assert.equal(map.map.fits.length, 1);
  assert.ok(map.map.fits[0].maxZoom <= 9, 'a cluster tap zooms to city level, not street level');
  map.map.scale = 1000; map.map.events.zoomend();
  map.markers.find(marker => labelOf(marker) === '武汉').content.onclick({stopPropagation() {}});
  assert.deepEqual(picks, [['420100', 'china']]);
}));

test('selection marks the point without changing its count colour', () => withDocument(() => {
  const map = new ClassMap(stubSDK(), 'map', {divisions});
  map.map.scale = 1000;
  map.update(people, range);
  const before = map.markers.find(marker => labelOf(marker) === '武汉').content.innerHTML;
  map.select('420100');
  const after = map.markers.find(marker => labelOf(marker) === '武汉');
  assert.match(after.content.className, /\bsel\b/);
  assert.equal(after.content.innerHTML.match(/background:[^;"]+/)[0], before.match(/background:[^;"]+/)[0]);
}));

test('world level counts only overseas people, placed at the country centre', () => withDocument(() => {
  const map = new ClassMap(stubSDK(), 'map', {divisions});
  map.setLevel('world');
  map.update(people, range);
  assert.equal(map.markers.length, 1);
  assert.equal(labelOf(map.markers[0]), '新加坡');
  assert.deepEqual([...map.markers[0].position], [103.82, 1.35]);
}));

test('fit leaves room for the bottom sheet and destroy unhooks events', () => withDocument(() => {
  const map = new ClassMap(stubSDK(), 'map', {divisions});
  map.update(people, range);
  map.setBottomInset(300);
  map.fit();
  assert.equal(map.map.fits.at(-1).padding[1], 320);  // AMap order: top, bottom, left, right
  map.destroy();
  assert.equal(map.map.destroyed, true);
  assert.equal(map.map.events.zoomend, undefined);
}));

test('a world view too wide for one screen centres on the biggest country instead of the midpoint', () => withDocument(() => {
  const sdk = stubSDK();
  const map = new ClassMap(sdk, 'map', {divisions});
  map.map.setZoomAndCenter = (zoom, center) => {map.map.centred = {zoom, center};};
  map.setLevel('world');
  const abroad = (id, code, lng, lat) => ({id, name: code, location: {country_code: code, country_name: code, province_code: '', city_code: '', confirmed_at: at, longitude: String(lng), latitude: String(lat)}});
  map.update([abroad(1, 'USA', -74, 40.7), abroad(2, 'SGP', 103.8, 1.35), abroad(3, 'SGP', 103.8, 1.35)], range);
  map.fit();
  assert.deepEqual(map.map.centred, {zoom: 3, center: [103.8, 1.35]});
}));

test('focus centres the map on a city dot', () => withDocument(() => {
  const map = new ClassMap(stubSDK(), 'map', {divisions});
  map.map.scale = 1000;
  map.map.setCenter = center => {map.map.centre = center;};
  map.update(people, range);
  map.focus('420100');
  assert.deepEqual(map.map.centre, [114.3, 30.6]);
}));

test('people without a known position are reported, never dropped silently or thrown on', () => withDocument(() => {
  const reports = [];
  const map = new ClassMap(stubSDK(), 'map', {divisions: null, onUnplaced: n => reports.push(n)});
  map.map.scale = 1000;
  map.update([{id: 1, name: 'a', location: loc('420100')}, {id: 2, name: 'b', location: loc('110000', {longitude: '116.4', latitude: '39.9'})}], range);
  assert.equal(map.markers.length, 1);
  assert.deepEqual(reports.at(-1), 1);
  map.setLevel('world');
  assert.doesNotThrow(() => map.update([{id: 3, name: 'c', location: {country_code: 'XXX', country_name: '某地', confirmed_at: at}}], range));
  assert.deepEqual(reports.at(-1), 1);
  map.setDivisions(divisions);
  map.setLevel('china');
  map.update([{id: 1, name: 'a', location: loc('420100')}], range);
  assert.deepEqual(reports.at(-1), 0);
}));

test('the first view re-frames once district centres arrive, unless the user already moved the map', async () => {
  await withDocument(async () => {
    let resolve;
    const later = new Promise(r => {resolve = r;});
    const map = new ClassMap(stubSDK(), 'map', {divisions: later});
    const coordless = [{id: 1, name: 'a', location: loc('420100')}, {id: 2, name: 'b', location: loc('430100')}];
    map.update(coordless, range);
    map.fit();
    assert.equal(map.map.fits.length, 0, 'nothing placeable yet');
    resolve(divisions); await later; await null;
    assert.equal(map.map.fits.length, 1);

    let resolve2;
    const later2 = new Promise(r => {resolve2 = r;});
    const touched = new ClassMap(stubSDK(), 'map', {divisions: later2});
    touched.update(coordless, range);
    touched.fit();
    touched.map.events.dragstart();
    resolve2(divisions); await later2; await null;
    assert.equal(touched.map.fits.length, 0);
  });
});

test('the base map shows no place labels of its own, so our dot names are never doubled', () => withDocument(() => {
  const map = new ClassMap(stubSDK(), 'map', {divisions});
  assert.ok(Array.isArray(map.map.options.features));
  assert.ok(!map.map.options.features.includes('point'));
}));

test('a tap on the map away from any dot or populated district reports a blank tap', () => withDocument(() => {
  let blanks = 0;
  const map = new ClassMap(stubSDK(), 'map', {divisions, onBlank: () => blanks++});
  map.update(people, range);
  map.map.events.click({pixel: {x: 1, y: 1}});
  assert.equal(blanks, 1);
}));

test('provinces the provider lists without cities (e.g. Taiwan) are still searchable as one place', async () => {
  const {chinaDivisions} = await import(`../gathering/static/gathering/map.js?divisions=${Date.now()}`);
  const district = (adcode, name, children = []) => ({adcode, name, center: {lng: 1, lat: 1}, districtList: children});
  const A = {DistrictSearch: class {search(keyword, done) {done('complete', {districtList: [district('100000', '中国', [
    district('420000', '湖北省', [district('420100', '武汉市')]),
    district('110000', '北京市', [district('110101', '东城区')]),
    district('710000', '台湾省'),
  ])]});}}};
  const loaded = await chinaDivisions(A);
  assert.deepEqual(loaded.list.map(c => c.adcode).sort(), ['110000', '420100', '710000']);
});

test('focus keeps the city clear of a right-hand panel; a bare touch is not a pan', () => withDocument(() => {
  const moved = [];
  const map = new ClassMap(stubSDK(), 'map', {divisions, onUserMoved: () => moved.push(1)});
  map.map.scale = 1000;
  map.map.getZoom = () => 9;
  map.update(people, range);
  map.setRightInset(420);
  map.focus('420100');
  const fit = map.map.fits.at(-1);
  assert.equal(fit.padding[3], 460, 'right padding covers the panel');
  assert.equal(fit.maxZoom, 9, 'focus keeps the current zoom');
  map.map.events.touchstart?.();
  assert.equal(moved.length, 0);
  assert.equal(map.userMoved, undefined);
  map.map.events.dragstart();
  assert.equal(moved.length, 1);
}));

test('境外 shows Hong Kong as its own dot; 境内 does not count it', () => withDocument(() => {
  const hk = {id: 30, name: '港', location: {country_code: 'CHN', province_code: '810000', province_name: '香港特别行政区', city_code: '810000', city_name: '香港特别行政区', confirmed_at: at}};
  const map = new ClassMap(stubSDK(), 'map', {divisions});
  map.map.scale = 1000;
  map.update([hk, ...people], range);
  assert.ok(!map.markers.some(marker => labelOf(marker) === '香港'));
  map.setLevel('world');
  const dot = map.markers.find(marker => labelOf(marker) === '香港');
  assert.ok(dot);
  assert.deepEqual([...dot.position], [114.17, 22.32]);
}));
