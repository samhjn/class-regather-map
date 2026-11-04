import {cityKey} from './logic.js';

// Use the server's Beijing-local date, independent of the browser timezone.
export const CONFIRMATION_LABELS = ['近1周', '近1月', '近1年', '近3年', '很久没有来过'];
export const PRESET_LABELS = {'1y': '近一年', '3y': '近三年', all: '全部'};
function monthsAgo(today, months) {
  const [year, month, day] = today.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1 - months, 1));
  const last = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  start.setUTCDate(Math.min(day, last));
  return start.toISOString().slice(0, 10);
}

export function confirmationBucket(confirmedAt, today) {
  const date = confirmedAt?.slice(0, 10);
  if (!date || !Number.isFinite(Date.parse(date)) || date > today) return 4;
  const week = new Date(Date.parse(today + 'T00:00:00Z') - 7 * 86400000).toISOString().slice(0, 10);
  const index = [week, monthsAgo(today, 1), monthsAgo(today, 12), monthsAgo(today, 36)]
    .findIndex(cutoff => date >= cutoff);
  return index < 0 ? 4 : index;
}

export const confirmationLabel = (confirmedAt, today) => CONFIRMATION_LABELS[confirmationBucket(confirmedAt, today)];
export function presetRange(preset, today) {
  if (!Object.hasOwn(PRESET_LABELS, preset)) throw new RangeError('Unknown confirmation preset');
  return {preset, today};
}

export function inRange(confirmedAt, range) {
  if (range.preset === 'batch') {const date = confirmedAt?.slice(0, 10); return !!date && date >= range.from && date <= range.today;}
  return range.preset === 'all' || confirmationBucket(confirmedAt, range.today) <= (range.preset === '1y' ? 2 : 3);
}

// When 近三年 holds too few people (years after the last class-wide update), offer — and open
// on — the last round of updates. A round is a burst: at least five confirmations within three
// months (a launch gets everyone updating within weeks). Old imported stays, whose confirmation
// is their move-in date, trickle in too thinly to form one, so they never chain into a round.
// Null while 近三年 is busy enough: the three presets suffice.
export const BATCH_MIN = 5;
const BURST_MONTHS = 3;
const monthOf = date => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
export function latestBatch(members, today) {
  const recent = presetRange('3y', today);
  if (members.filter(({location}) => location && inRange(location.confirmed_at, recent)).length >= BATCH_MIN) return null;
  const dates = members.map(({location}) => location?.confirmed_at?.slice(0, 10)).filter(date => date && date <= today).sort();
  const months = dates.map(monthOf);
  // A month opens a burst if it and the next two months hold enough confirmations.
  const opens = [...new Set(months)].filter(m => months.filter(n => n >= m && n < m + BURST_MONTHS).length >= BATCH_MIN);
  if (!opens.length) return null;
  // The latest burst, followed back to where it began (bursting months that touch it).
  let start = opens.at(-1);
  for (let i = opens.length - 2; i >= 0 && start - opens[i] < BURST_MONTHS; i--) start = opens[i];
  // A month counts as "opening" when the burst merely lies ahead of it: a lone confirmation a
  // month or two before the launch must not become the start.
  const count = m => months.filter(n => n === m).length;
  while (start < opens.at(-1) && count(start) < 2) start = months.find(n => n > start);
  const from = `${Math.floor(start / 12)}-${String(start % 12 + 1).padStart(2, '0')}-01`;
  return {from, label: `${from.slice(0, 4)}.${from.slice(5, 7)}`, count: dates.filter(date => date >= from).length};
}
export const batchRange = (batch, today) => ({preset: 'batch', today, from: batch.from});
export const batchName = batch => `${batch.label} 那批`;

// Stable sort preserves the page's shuffled order inside each fuzzy time bucket.
export const orderByConfirmation = (members, today) => [...members].sort((a, b) =>
  confirmationBucket(a.location?.confirmed_at, today) - confirmationBucket(b.location?.confirmed_at, today));

export const bucket = n => n >= 10 ? 3 : n >= 4 ? 2 : n >= 2 ? 1 : 0;
export const dotSize = n => [30, 34, 40, 46][bucket(n)];

// These province-level places keep their own labels and dots within the same map.
export const REGIONS = {'810000': 'HKG', '820000': 'MAC', '710000': 'TWN'};
export const REGION_NAMES = {HKG: '香港', MAC: '澳门', TWN: '台湾'};

export function memberKey(location, level = levelOf(location)) {
  if (level === 'world') return location.country_code;
  if (REGIONS[location.province_code]) return location.province_code;
  return location.city_code ? cityKey(location.city_code, location.province_code) : 'prov:' + location.province_code;
}

export const levelOf = location => location.country_code === 'CHN' ? 'china' : 'world';

export function countByKey(members, range, level) {
  const counts = new Map();
  for (const {location} of members) {
    if (!location || (level === 'china' && levelOf(location) !== 'china') || !inRange(location.confirmed_at, range)) continue;
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

// A null key lists everyone; viewport shortcuts never filter the roster.
export function splitForRegion(members, key, level, range) {
  const inside = [], others = [];
  for (const member of members) {
    const loc = member.location;
    if (!loc || key !== null && ((level === 'china' && levelOf(loc) !== 'china') || memberKey(loc, level) !== key)) continue;
    (inRange(loc.confirmed_at, range) ? inside : others).push(member);
  }
  return {inRange: orderByConfirmation(inside, range.today), others: orderByConfirmation(others, range.today)};
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
  return confirmationBucket(confirmedAt, today) >= 3;
}
