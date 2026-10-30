import {REGIONS, REGION_NAMES, inRange} from './filter.js';

// HTML builders for the sheet lists (spec 5.1–5.4). Pure: data in, escaped HTML out.

export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
export const shortName = name => String(name || '').replace(/(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|自治州|地区|盟|省|市)$/, '');
const TONES = ['#ffd84d', '#ffa9cf', '#86e3bd', '#a8cbff', '#ffbd8a', '#cdb2ff'];
const CHEVRON = '<svg class="chev" width="8" height="14" viewBox="0 0 8 14" aria-hidden="true"><path d="M1 1l6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export const regionTitle = (name, n) => `${name} · ${n} 人`;
export const sectionTitle = fresh => fresh ? '这段时间确认过' : '更早的记录';
// Name of the second group on any list: "older" only when the range runs to today.
export const otherGroup = (toToday, place = '') => toToday
  ? {title: '更早的记录', note: place ? `可能已经不在${place}了` : '可能已经搬走了'}
  : {title: '其他记录', note: '不在这段时间里'};
export const summaryLine = total => `这段时间确认过位置 · 全班 ${total} 人`;

export function placeOf(loc) {
  if (!loc) return '';
  if (loc.country_code === 'CHN' && REGIONS[loc.province_code]) return REGION_NAMES[REGIONS[loc.province_code]];
  return loc.country_code === 'CHN' ? shortName(loc.city_name) || `${shortName(loc.province_name)} · 未填城市` : loc.country_name || loc.country_code;
}

export function memberRow(member, range, {showPlace = false, meId = null} = {}) {
  const loc = member.location;
  const fresh = loc && inRange(loc.confirmed_at, range);
  const tag = !loc ? '还没填位置' : !loc.confirmed_at ? '还没确认过' : fresh ? `${loc.confirmed_at.slice(0, 4)}.${loc.confirmed_at.slice(5, 7)} 确认` : `${loc.confirmed_at.slice(0, 4)} 年的信息`;
  const line = [showPlace ? placeOf(loc) : '', loc?.label].filter(Boolean).join(' · ');  // empty stays empty
  const note = member.bio;  // only the personal note: clearing it clears the line (old stay notes stay in the footprint)
  return `<button type="button" class="mem${fresh ? '' : ' old'}" data-member="${member.id}">` +
    `<span class="av" style="background:${TONES[member.id % TONES.length]}" aria-hidden="true">${escapeHTML(member.name.slice(0, 1))}</span>` +
    `<span class="tx"><b>${escapeHTML(member.name)}</b>${member.id === meId ? '<span class="me">我</span>' : ''}<span class="tag">${tag}</span>${line ? `<span class="s">${escapeHTML(line)}</span>` : ''}` +
    `${note ? `<span class="bio">${escapeHTML(note)}</span>` : ''}</span>${CHEVRON}</button>`;
}

// Pinyin initials without a dictionary: the zh collator sorts hanzi by pinyin, so each
// character falls between the first characters of two initial letters (no I, U, V).
const LETTERS = 'abcdefghjklmnopqrstwxyz';
const BOUNDS = '阿八嚓哒妸发旮哈讥咔垃妈拏噢妑七呥仨他屲夕丫帀';
// No zh collation (very old engines): hanzi then match by characters only, never throw.
const collator = (() => {
  try {return typeof Intl !== 'undefined' && Intl.Collator?.supportedLocalesOf?.(['zh-Hans-CN', 'zh']).length ? new Intl.Collator('zh-Hans-CN') : null;}
  catch {return null;}
})();
// Where the collator's reading is not the one people type: polyphonic place names and surnames.
const PLACE_READINGS = {'重庆': 'cq', '长沙': 'cs', '长春': 'cc', '长治': 'cz', '长安': 'ca', '厦门': 'xm', '蚌埠': 'bb', '六安': 'la', '乐山': 'ls', '番禺': 'py', '朝阳': 'cy'};
const SURNAME_READINGS = {'曾': 'z', '单': 's', '解': 'x', '区': 'o', '仇': 'q', '朴': 'p', '查': 'z', '翟': 'z', '盖': 'g', '尉': 'y', '缪': 'm', '覃': 'q', '乐': 'y', '种': 'c'};
export function initials(text) {
  return [...String(text || '')].map(char => {
    if (!/[\u4e00-\u9fff]/.test(char)) return char.toLowerCase();
    if (!collator) return '';
    let letter = '';
    for (let i = 0; i < BOUNDS.length && collator.compare(char, BOUNDS[i]) >= 0; i++) letter = LETTERS[i];
    return letter;
  }).join('');
}

// The collator's initials plus the common alternative readings (重庆 → cq, 曾 → z).
function readings(value) {
  const plain = initials(value), out = [plain];
  for (const [place, letters] of Object.entries(PLACE_READINGS)) {
    const at = value.indexOf(place);
    if (at >= 0) out.push(plain.slice(0, at) + letters + plain.slice(at + place.length));
  }
  if (SURNAME_READINGS[value[0]]) out.push(SURNAME_READINGS[value[0]] + plain.slice(1));
  return out;
}

// A query matches text directly ("晓", "深圳") or by pinyin initials ("lx", "sz").
export function textMatches(text, query) {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const value = String(text || '');
  if (value.toLowerCase().includes(q)) return true;
  if (!/^[a-z]+$/.test(q)) return false;
  return readings(value).some(reading => reading.includes(q));
}

// Search over what a classmate would type: name, place, label, note, bio.
export function matches(member, query) {
  const loc = member.location || {};
  return [member.name, member.bio, loc.city_name, loc.province_name, loc.country_name, loc.label, loc.note].some(text => textMatches(text, query));
}

export const section = (title, count, note = '') => `<div class="sec"><span>${title} · ${count}</span>${note ? `<small>${note}</small>` : ''}</div>`;
