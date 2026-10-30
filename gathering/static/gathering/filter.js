import {cityKey} from './logic.js';

// Pure helpers for the confirmed-time filter (spec 5.7) and count markers (spec 5.1).
// Months are compared as year*12+month; confirmed_at carries the server's +08:00 offset,
// so its first 7 characters are already the class's local month.

export const monthIndex = iso => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;

const YEARS = {'1y': 1, '3y': 3};
export function presetRange(preset, today, earliest) {
  if (preset === 'all') return {from: monthIndex(earliest), to: null};
  return {from: monthIndex(today) - YEARS[preset] * 12, to: null};
}

export function inRange(confirmedAt, range) {
  if (!confirmedAt) return false;
  const month = monthIndex(confirmedAt);
  return month >= range.from && (range.to === null || month <= range.to);
}

export const bucket = n => n >= 10 ? 3 : n >= 4 ? 2 : n >= 2 ? 1 : 0;
export const dotSize = n => [30, 34, 40, 46][bucket(n)];

// Hong Kong, Macau and Taiwan are stored under CHN (as upstream does) but shown under 境外,
// each as its own place, like a country.
export const REGIONS = {'810000': 'HKG', '820000': 'MAC', '710000': 'TWN'};
export const REGION_NAMES = {HKG: '香港', MAC: '澳门', TWN: '台湾'};

export function memberKey(location, level) {
  if (level === 'world') return REGIONS[location.province_code] && location.country_code === 'CHN' ? REGIONS[location.province_code] : location.country_code;
  return location.city_code ? cityKey(location.city_code, location.province_code) : 'prov:' + location.province_code;
}

export const levelOf = location => location.country_code === 'CHN' && !REGIONS[location.province_code] ? 'china' : 'world';

export function countByKey(members, range, level) {
  const counts = new Map();
  for (const {location} of members) {
    if (!location || levelOf(location) !== level || !inRange(location.confirmed_at, range)) continue;
    const key = memberKey(location, level);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

export function consistentCounts(members, range) {
  let china = 0, world = 0;
  for (const {location} of members) {
    if (location && inRange(location.confirmed_at, range)) levelOf(location) === 'china' ? china++ : world++;
  }
  return {china, world, total: china + world};
}

const newestFirst = (a, b) => (b.location.confirmed_at || '').localeCompare(a.location.confirmed_at || '');

// key === null lists everyone of that level (the home list); a key narrows to one region.
export function splitForRegion(members, key, level, range) {
  const inside = [], others = [];
  for (const member of members) {
    const loc = member.location;
    if (!loc || levelOf(loc) !== level || key !== null && memberKey(loc, level) !== key) continue;
    (inRange(loc.confirmed_at, range) ? inside : others).push(member);
  }
  return {inRange: inside.sort(newestFirst), others: others.sort(newestFirst)};
}

// Greedy screen-space merge of city points: biggest first, so a crowded city absorbs its
// small neighbours instead of being swallowed by them.
export function cluster(points, minGap) {
  const groups = [];
  for (const point of [...points].sort((a, b) => b.n - a.n)) {
    const near = groups.find(g => Math.hypot(g.x - point.x, g.y - point.y) < (dotSize(g.n) + dotSize(point.n)) / 2 + minGap);
    if (!near) {groups.push({keys: [point.key], x: point.x, y: point.y, n: point.n}); continue;}
    const n = near.n + point.n;
    near.x = (near.x * near.n + point.x * point.n) / n;
    near.y = (near.y * near.n + point.y * point.n) / n;
    near.n = n;
    near.keys.push(point.key);
  }
  return groups;
}

export function isStale(confirmedAt, today) {
  if (!confirmedAt) return true;
  return (Date.parse(today) - Date.parse(confirmedAt.slice(0, 10))) / 86400000 > 365;
}
