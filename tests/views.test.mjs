import test from 'node:test';
import assert from 'node:assert/strict';
import {initials, matches, memberRow, otherGroup, placeOf, regionTitle, sectionTitle, summaryLine, textMatches} from '../gathering/static/gathering/views.js';
import {monthIndex} from '../gathering/static/gathering/filter.js';

const person = (confirmed, loc = {}) => ({id: 7, name: '林<小满>', bio: '', location: {country_code: 'CHN', country_name: '中国', province_code: '420000',
  province_name: '湖北省', city_code: '420100', city_name: '武汉市', label: '光谷', note: '做芯片', confirmed_at: confirmed, ...loc}});
const range = {from: monthIndex('2023-10-01'), to: null};

test('fresh row shows the confirm month tag; text is escaped', () => {
  const html = memberRow(person('2026-10-03T12:00:00+08:00'), range, {showPlace: true});
  assert.match(html, /2026\.10 确认/);
  assert.match(html, /林&lt;小满&gt;/);
  assert.match(html, /武汉 · 光谷</);
  assert.doesNotMatch(html, /class="bio"/);  // an old stay note is not a personal note (it stays in the footprint)
  assert.doesNotMatch(html, /class="mem old"/);
});

test('out-of-range row is greyed and says which year the info is from', () => {
  const html = memberRow(person('2015-09-01T12:00:00+08:00'), range, {});
  assert.match(html, /class="mem old"/);
  assert.match(html, /2015 年的信息/);
  assert.match(memberRow(person(null), range, {}), /还没确认过/);
});

test('region and section copy follow the spec', () => {
  assert.equal(regionTitle('武汉', 5), '武汉 · 5 人');
  assert.equal(sectionTitle(true), '这段时间确认过');
  assert.equal(summaryLine(66), '这段时间确认过位置 · 全班 66 人');
});

test('a member without a location says so instead of a confirm date', () => {
  const html = memberRow({id: 3, name: '夏禾', bio: '', location: null}, range, {showPlace: true});
  assert.match(html, /还没填位置/);
});

test('the second group is named for the chosen range, on every list', () => {
  assert.deepEqual(otherGroup(true, '武汉'), {title: '更早的记录', note: '可能已经不在武汉了'});
  assert.deepEqual(otherGroup(true), {title: '更早的记录', note: '可能已经搬走了'});
  assert.deepEqual(otherGroup(false, '武汉'), {title: '其他记录', note: '不在这段时间里'});
});

test('pinyin initials of Chinese names and places', () => {
  assert.equal(initials('林晓'), 'lx');
  assert.equal(initials('深圳市'), 'szs');
  assert.equal(initials('夏禾'), 'xh');
  assert.equal(initials('陈雨'), 'cy');
  assert.equal(initials('Tokyo 东京'), 'tokyo dj');
});

test('search matches initials, partial names and places', () => {
  const linxiao = {id: 1, name: '林晓', bio: '', location: {city_name: '上海市', province_name: '上海市', country_name: '中国', label: '', note: ''}};
  assert.ok(matches(linxiao, 'lx'));
  assert.ok(matches(linxiao, 'LX'));
  assert.ok(matches(linxiao, '晓'));
  assert.ok(matches(linxiao, 'sh'));          // 上海
  assert.ok(!matches(linxiao, 'zz'));
  assert.ok(textMatches('深圳市', 'sz'));
  assert.ok(textMatches('深圳市', '深'));
  assert.ok(!textMatches('深圳市', 'gz'));
});

test('a row shows place and workplace, then the personal note on its own line', () => {
  const html = memberRow({id: 7, name: '林晓', bio: '周末有空', location: {country_code: 'CHN', city_name: '上海市', province_name: '上海市', label: '华为', note: '', confirmed_at: '2026-10-03T12:00:00+08:00'}}, range, {showPlace: true});
  assert.match(html, /上海 · 华为/);
  assert.match(html, /class="bio">周末有空</);
});

test('nothing filled in means nothing shown: no placeholder text', () => {
  const html = memberRow({id: 8, name: '何以南', bio: '', location: {country_code: 'CHN', city_name: '武汉市', label: '', note: '', confirmed_at: '2026-01-03T12:00:00+08:00'}}, range, {});
  assert.doesNotMatch(html, /没写/);
  assert.doesNotMatch(html, /class="s"/);
  assert.doesNotMatch(html, /class="bio"/);
});

test('searching a province name or its initials finds the people there', () => {
  const hubei = {id: 2, name: '周一禾', bio: '', location: {country_code: 'CHN', city_name: '武汉市', province_name: '湖北省', country_name: '中国', label: '', note: ''}};
  const beijing = {id: 3, name: '周宁', bio: '', location: {country_code: 'CHN', city_name: '北京市', province_name: '北京市', country_name: '中国', label: '', note: ''}};
  assert.ok(matches(hubei, '湖北'));
  assert.ok(matches(hubei, 'hb'));
  assert.ok(!matches(beijing, '湖北'));
});

test('common polyphonic place names and surnames get the initials people actually type', () => {
  for (const [text, query] of [['重庆市', 'cq'], ['长沙市', 'cs'], ['长春市', 'cc'], ['厦门市', 'xm'], ['曾静', 'zj'], ['单磊', 'sl']]) {
    assert.ok(textMatches(text, query), `${text} ~ ${query}`);
  }
});

test('the note line shows only the personal note: clearing it clears the line', () => {
  const html = memberRow({id: 9, name: '甲', bio: '', location: {country_code: 'CHN', city_name: '武汉市', label: '', note: '2015 年的旧近况', confirmed_at: '2026-01-03T12:00:00+08:00'}}, range, {});
  assert.doesNotMatch(html, /class="bio"/);
});

test('Hong Kong, Macau and Taiwan are named as such, never "· 未填城市"', () => {
  assert.equal(placeOf({country_code: 'CHN', province_code: '810000', province_name: '香港特别行政区', city_name: '香港特别行政区'}), '香港');
  assert.equal(placeOf({country_code: 'CHN', province_code: '710000', province_name: '台湾省', city_name: ''}), '台湾');
});
