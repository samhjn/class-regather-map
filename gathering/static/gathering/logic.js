export const municipalities = new Set(['110000', '120000', '310000', '500000', '810000', '820000']);
export const chinaCountry = code => ['CHN', 'CN', 'TWN', 'HKG', 'MAC', 'TW', 'HK', 'MO'].includes(code) ? 'CHN' : code;
export const provinceKey = props => String(props.adcode_pro || props.adcode || '').slice(0, 2) + '0000';
export const cityKey = (code, province) => municipalities.has(province) ? province : String(code || '');
// The prefecture an adcode belongs to. County-level cities run directly by a province
// (仙桃 429004, 济源 419001, 五指山 469001 …) carry 90 in digits 3–4 and are their own entry.
export const prefectureCode = adcode => String(adcode).slice(2, 4) === '90' ? String(adcode) : String(adcode).slice(0, 4) + '00';
export const regionKey = (location, level) => level === 'world' ? location.country_code : level === 'china' ? location.province_code : location.city_code || 'unknown-city';
export function inScope(location, state) {
  if (!location) return state.unknown || (state.level === 'world' && !state.selected);
  if (state.unknown) return false;
  if (state.level !== 'world' && location.country_code !== 'CHN') return false;
  if (state.level === 'province' && location.province_code !== state.province) return false;
  return !state.selected || regionKey(location, state.level) === state.selected;
}
export function scopeMembers(members, state) {
  const search = (state.search || '').trim().toLocaleLowerCase();
  return members.filter(member => inScope(member.location, state) && (!search ||
    [member.name, member.bio, member.location?.city_name, member.location?.province_name, member.location?.country_name, member.location?.label]
      .some(text => String(text || '').toLocaleLowerCase().includes(search))));
}
export function regionCounts(members, state) {
  const counts = new Map();
  for (const member of members) {
    if (!member.location || !inScope(member.location, {...state, selected: '', unknown: false})) continue;
    const key = regionKey(member.location, state.level);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}
export const dayNumber = date => Math.floor(Date.parse(date + 'T00:00:00Z') / 86400000);
export const dayString = day => new Date(day * 86400000).toISOString().slice(0, 10);
export const placeName = loc => loc ? [loc.country_code === 'CHN' ? loc.province_name : loc.country_name,
  loc.city_name !== loc.province_name ? loc.city_name : '', loc.label].filter(Boolean).join(' · ') : '还没有填写位置';

// Shuffle once per page load; filtering and history navigation keep that order.
export function createMemberOrder(random = Math.random) {
  const ranks = new Map();
  return members => {
    const unseen = members.filter(member => !ranks.has(member.id));
    for (let i = unseen.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [unseen[i], unseen[j]] = [unseen[j], unseen[i]];
    }
    unseen.forEach(member => ranks.set(member.id, ranks.size));
    return [...members].sort((a, b) => ranks.get(a.id) - ranks.get(b.id));
  };
}

// Use the SDK's screen projection so zoom, rotation and latitude all count.
// Fixed anchors avoid a chain of nearby points swallowing a whole city.
export function clusterMembers(members, project, radius = 48) {
  const clusters = [];
  for (const member of [...members].sort((a, b) => a.id - b.id)) {
    const loc = member.location;
    if (loc?.longitude == null || loc.latitude == null) continue;
    const position = [Number(loc.longitude), Number(loc.latitude)];
    if (!position.every(Number.isFinite)) continue;
    const point = project(position);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    let nearest, distance = radius;
    for (const cluster of clusters) {
      const d = Math.hypot(point.x - cluster.point.x, point.y - cluster.point.y);
      if (d <= distance) {nearest = cluster; distance = d;}
    }
    if (nearest) nearest.people.push(member);
    else clusters.push({point, position, people: [member]});
  }
  const order = new Map(members.map((member, index) => [member.id, index]));
  clusters.forEach(cluster => cluster.people.sort((a, b) => order.get(a.id) - order.get(b.id)));
  return clusters;
}
