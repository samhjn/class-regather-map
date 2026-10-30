import test from 'node:test';
import assert from 'node:assert/strict';
import {placeSearch} from '../gathering/static/gathering/update.js';

// Minimal stand-ins for the input and the suggestion list.
const fakeInput = () => ({value: '', handlers: {}, addEventListener(name, fn) {this.handlers[name] = fn;}, type(text) {this.value = text; this.handlers.input();}});
const fakeList = () => ({innerHTML: '', handlers: {}, addEventListener(name, fn) {this.handlers[name] = fn;},
  pick(index) {this.handlers.click({target: {closest: () => ({dataset: {place: String(index)}})}});}});

test('without the AMap city list, domestic search falls back to provinces so a stay can still be saved', () => {
  const input = fakeInput(), list = fakeList();
  let picked;
  placeSearch(input, list, {mode: () => 'china', divisions: () => null, countries: {}, provinces: {'420000': '湖北省', '440000': '广东省'},
    onPick: item => {picked = item;}});
  input.type('湖北');
  assert.match(list.innerHTML, /湖北/);
  list.pick(0);
  assert.equal(picked.kind, 'province');
  assert.equal(picked.code, '420000');
  input.type('gd');  // initials work here too
  assert.match(list.innerHTML, /广东/);
});

test('境外 search offers Hong Kong, Macau and Taiwan; 境内 search does not', () => {
  const input = fakeInput(), list = fakeList();
  let mode = 'world', picked;
  const divisions = {list: [
    {adcode: '420100', name: '武汉市', province: {adcode: '420000', name: '湖北省'}},
    {adcode: '810000', name: '香港特别行政区', province: {adcode: '810000', name: '香港特别行政区'}},
  ]};
  placeSearch(input, list, {mode: () => mode, divisions: () => divisions, countries: {JPN: '日本'}, onPick: item => {picked = item;}});
  input.type('香港');
  assert.match(list.innerHTML, /香港/);
  list.pick(0);
  assert.deepEqual([picked.kind, picked.province], ['region', '810000']);
  mode = 'china';
  input.type('香港');
  assert.doesNotMatch(list.innerHTML, /香港/);
});
