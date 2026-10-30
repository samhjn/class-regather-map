import {chinaCountry, cityKey, municipalities, provinceKey} from './logic.js';
import {REGION_NAMES, bucket, cluster, countByKey, dotSize, inRange, levelOf, memberKey} from './filter.js';
import {countryCenters} from './country-centers.js';

let loading;
let loadAttempt = 0;
const plugins = ['AMap.DistrictLayer', 'AMap.DistrictSearch', 'AMap.Geocoder', 'AMap.ToolBar', 'AMap.Scale'];
const markerEvents = ['complete', 'zoomend', 'moveend', 'resize'];
const isReady = A => A?.Map && A.DistrictLayer?.World && A.DistrictLayer?.Country && A.DistrictLayer?.Province && A.DistrictSearch && A.Geocoder && A.ToolBar && A.Scale;
export function loadMap(config) {
  if (isReady(window.AMap)) return Promise.resolve(window.AMap);
  if (!config?.key) return Promise.reject(new Error('地图尚未配置。管理员填写高德 JS API Key 后即可显示地图；同学列表与历史记录仍可使用。'));
  if (loading) return loading;
  window._AMapSecurityConfig = config.security_js_code ? {securityJsCode: config.security_js_code} :
    {serviceHost: new URL(config.service_host, location.origin).href};
  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const callback = `__regatherAMapReady${++loadAttempt}`;
    const cleanup = () => {clearTimeout(timer); delete window[callback];};
    const fail = message => {cleanup(); loading = null; script.remove(); reject(new Error(message));};
    const timer = setTimeout(() => fail('地图加载超时，请检查网络、Key 和域名白名单。'), 30000);
    window[callback] = () => {
      if (!window.AMap?.Map || !window.AMap?.plugin) {
        fail('高德地图初始化失败，请检查 Key、服务代理和 WebGL 支持。');
        return;
      }
      window.AMap.plugin(plugins, () => {
        if (!isReady(window.AMap)) {fail('高德行政区插件未能加载，请稍后重试。'); return;}
        cleanup(); resolve(window.AMap);
      });
    };
    // v1.4.15 retains the documented district picking API for all three levels.
    // A dynamic script's load event only means the bootstrap file arrived. The
    // provider callback and plugin callback establish SDK readiness separately.
    script.src = `https://webapi.amap.com/maps?v=1.4.15&key=${encodeURIComponent(config.key)}&callback=${callback}&plugin=Map3D,${plugins.join(',')}`;
    script.onerror = () => fail('无法连接高德地图，请稍后重试。');
    document.head.append(script);
  });
  return loading;
}

const RAMP = ['#d4ccff', '#a898ff', '#7a63ff', '#4b3bea'];
const MIN_GAP = 8;  // px between count dots before they merge (spec 5.1)
const PROVINCE_NUDGE = [0.35, -0.3];  // degrees, for province-only dots
const WORLD_SPAN = 60;  // degrees of longitude a zoom-3 phone screen can roughly show
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const shortName = name => String(name || '').replace(/(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|自治州|地区|盟|省|市)$/, '');

// Full-screen class map: district fill by count bucket plus one count dot per city
// (per country overseas). Dots that would overlap merge into a cluster dot.
export class ClassMap {
  constructor(A, element, {onPick = () => {}, onClusterPick = () => {}, onUnplaced = () => {}, onBlank = () => {}, onUserMoved = () => {}, divisions = null} = {}) {
    this.A = A;
    this.onUserMoved = onUserMoved;
    this.onBlank = onBlank;
    this.onUnplaced = onUnplaced;
    this.onPick = onPick;
    this.onClusterPick = onClusterPick;
    this.level = 'china';
    this.members = [];
    this.range = null;
    this.selected = null;
    this.inset = 0;
    this.markers = [];
    this.map = new A.Map(element, {zoom: 4, center: [108, 33], viewMode: '3D', pitch: 0, resizeEnable: true,
      showIndoorMap: false, isHotspot: false, mapStyle: 'amap://styles/whitesmoke',
      features: ['bg', 'road', 'building']});  // no provider place labels: our dots carry the names, never twice
    this.map.addControl(new A.Scale());
    this.setDivisions(divisions);
    const moved = () => {if (!this.userMoved) {this.userMoved = true; this.onUserMoved();}};
    // A real pan, a pinch or a wheel zoom hands the view to the user; a bare tap does not.
    this.map.on('dragstart', moved);
    const container = this.map.getContainer?.();
    container?.addEventListener('touchmove', event => {if (event.touches.length > 1) moved();}, {passive: true});
    container?.addEventListener('wheel', moved, {passive: true});
    this.refreshMarkers = () => this.renderMarkers();
    for (const event of markerEvents) this.map.on(event, this.refreshMarkers);
    this.map.on('click', event => {
      const props = this.layer?.getDistrictByContainerPos?.(event.pixel);
      const key = props && (this.level === 'world' ? chinaCountry(props.SOC) : cityKey(String(props.adcode_cit || props.adcode), provinceKey(props)));
      if (key && this.counts?.get(key)) this.onPick(key, this.level);
      else this.onBlank();  // empty map: the app folds the sheet away
    });
    this.buildLayer();
  }
  setDivisions(divisions) {
    // Most real records carry a city code but no coordinates, so the first frame only knows a
    // few dots; once centres arrive, frame again unless the user has taken over the map.
    if (divisions?.then) divisions.then(loaded => {this.divisions = loaded; this.renderMarkers(); if (this.wantsFit && !this.userMoved) this.fit();}, () => {});
    else {this.divisions = divisions; this.renderMarkers();}
  }
    setLevel(level) {
    if (level === this.level) return;
    this.level = level;
    this.selected = null;
    this.buildLayer();
    this.update(this.members, this.range);
  }
  buildLayer() {
    if (this.layer) this.map.remove(this.layer);
    const options = {zIndex: 10, styles: {fill: props => this.fill(props)}};
    // depth 2 = prefecture-level fill on the national view; boundaries stay the provider's own.
    this.layer = this.level === 'world' ? new this.A.DistrictLayer.World(options) :
      new this.A.DistrictLayer.Country({...options, SOC: 'CHN', depth: 2});
    this.map.add(this.layer);
  }
  fill(props) {
    const key = this.level === 'world' ? chinaCountry(props.SOC) : cityKey(String(props.adcode_cit || props.adcode), provinceKey(props));
    const count = this.counts?.get(key);
    return count ? RAMP[bucket(count)] + '99' : 'rgba(0,0,0,0)';
  }
  update(members, range) {
    this.members = members;
    this.range = range;
    if (!range) return;
    this.counts = countByKey(members, range, this.level);
    this.layer.setStyles({fill: props => this.fill(props)});
    this.renderMarkers();
  }
  points() {
    const groups = new Map();
    for (const member of this.members) {
      const loc = member.location;
      if (!loc || levelOf(loc) !== this.level || !inRange(loc.confirmed_at, this.range)) continue;
      const key = memberKey(loc, this.level);
      const group = groups.get(key) || {key, n: 0, coords: [], loc};
      group.n++;
      if (loc.longitude != null && loc.latitude != null) group.coords.push([Number(loc.longitude), Number(loc.latitude)]);
      groups.set(key, group);
    }
    const points = [];
    let unplaced = 0;
    for (const group of groups.values()) {
      const place = this.place(group);
      if (place?.position?.every(Number.isFinite)) points.push({key: group.key, n: group.n, ...place});
      else unplaced += group.n;  // reported, so the sheet can say the map is short by N people
    }
    this.unplaced = unplaced;
    return points;
  }
  place({key, coords, loc}) {
    const usable = coords.filter(pair => pair.every(Number.isFinite));
    let position = usable.length ? [0, 1].map(i => usable.reduce((sum, pair) => sum + pair[i], 0) / usable.length) : null;
    if (this.level === 'world') return {position: position || countryCenters[key], label: REGION_NAMES[key] || loc.country_name || key};
    if (key.startsWith('prov:')) {
      const province = this.divisions?.provinces.get(loc.province_code);
      // The provider's province centre is the capital; nudge the dot so it never sits
      // exactly on the capital's own dot and can split from it when zoomed in.
      const fallback = province?.center && [province.center[0] + PROVINCE_NUDGE[0], province.center[1] + PROVINCE_NUDGE[1]];
      return (position || fallback) && {position: position || fallback, label: `${shortName(province?.name || loc.province_name)} · 未填城市`};
    }
    const city = this.divisions?.cities.get(key);
    position = position || city?.center;
    return position && {position, label: shortName(city?.name || loc.city_name)};
  }
  renderMarkers() {
    if (!this.range || !this.layer) return;
    this.map.remove(this.markers);
    const points = this.points();
    this.onUnplaced(this.unplaced);
    for (const point of points) {
      const pixel = this.map.lngLatToContainer(new this.A.LngLat(...point.position));
      Object.assign(point, {x: pixel.x, y: pixel.y});
    }
    const byKey = new Map(points.map(point => [point.key, point]));
    this.markers = cluster(points, MIN_GAP).map(group => this.marker(group.keys.map(key => byKey.get(key)), group.n));
    this.map.add(this.markers);
  }
  marker(members, n) {
    const merged = members.length > 1;
    const size = dotSize(n);
    const position = [0, 1].map(i => members.reduce((sum, point) => sum + point.position[i] * point.n, 0) / n);
    const label = merged ? `${members[0].label}等 ${members.length} 城` : members[0].label;
    const selected = !merged && members[0].key === this.selected;
    const content = document.createElement('div');
    content.className = `pt${merged ? ' cl' : ''}${selected ? ' sel' : ''}`;
    content.setAttribute('aria-label', `${label}，${n} 位同学`);
    content.innerHTML = `<div class="d" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px;` +
      `background:${RAMP[bucket(n)]};color:${bucket(n) >= 2 ? '#fff' : '#17153a'}">${n}</div><span class="nm">${escapeHTML(label)}</span>`;
    content.addEventListener('click', event => {
      event.stopPropagation();
      if (!merged) {this.onPick(members[0].key, this.level); return;}
      this.map.setFitView(members.map(point => new this.A.Marker({position: point.position})), false, this.padding(), 8);  // city level, not street level
      this.onClusterPick(members.map(point => point.key));
    });
    const marker = new this.A.Marker({position, content, offset: new this.A.Pixel(-size / 2, -size / 2), zIndex: selected ? 130 : 120, bubble: false});
    marker.count = n; marker.spot = position;  // own fields: the SDK's marker.position is not public API
    return marker;
  }
  select(key) {
    this.selected = key;
    this.renderMarkers();
  }
  focus(key) {
    const point = this.points().find(candidate => candidate.key === key);
    if (!point) return;
    // With a side panel open, centre in the map that is still visible, at the current zoom.
    if (this.right) this.map.setFitView([new this.A.Marker({position: point.position})], false, this.padding(), this.map.getZoom());
    else this.map.setCenter(point.position);
  }
  setBottomInset(px) {this.inset = px;}
  // AMap 1.4 setFitView margins are [top, bottom, left, right] (not CSS order).
  setRightInset(px) {this.right = px;}
  padding() {return [110, this.inset + 20, 40, (this.right || 0) + 40];}
  fit() {
    this.wantsFit = true;
    this.userMoved = false;  // an explicit fit hands the view back to the app
    if (!this.markers.length) return;
    // AMap 1.4 cannot zoom out past 3, so continents apart do not fit one phone screen;
    // centring on their midpoint would show neither. Centre on the biggest group instead.
    const lngs = this.markers.map(marker => marker.spot[0]);
    if (this.level === 'world' && Math.max(...lngs) - Math.min(...lngs) > WORLD_SPAN) {
      const biggest = this.markers.reduce((best, marker) => marker.count > best.count ? marker : best);
      this.map.setZoomAndCenter(3, biggest.spot);
      return;
    }
    this.map.setFitView(this.markers, false, this.padding(), 9);
  }
  destroy() {
    for (const event of markerEvents) this.map.off(event, this.refreshMarkers);
    this.map.destroy();
  }
}

let divisionsLoading;
// One DistrictSearch for the whole country: centres for count dots and the city search list.
export function chinaDivisions(A) {
  divisionsLoading = divisionsLoading || new Promise((resolve, reject) => {
    new A.DistrictSearch({level: 'country', subdistrict: 2, extensions: 'base'}).search('中国', (status, result) => {
      const provinces = result?.districtList?.[0]?.districtList;
      if (status !== 'complete' || !provinces?.length) {divisionsLoading = null; reject(new Error('行政区列表暂不可用')); return;}
      const lngLat = center => center ? [Number(center.lng ?? center.getLng?.()), Number(center.lat ?? center.getLat?.())] : null;
      const out = {provinces: new Map(), cities: new Map(), list: []};
      for (const province of provinces) {
        const p = {adcode: province.adcode, name: province.name, center: lngLat(province.center)};
        out.provinces.set(p.adcode, p);
        // Municipalities, HK/Macau, and provinces listed without cities (Taiwan) count as one city.
        const children = municipalities.has(p.adcode) || !province.districtList?.length ? [province] : province.districtList;
        for (const city of children) {
          const c = {adcode: city.adcode, name: city.name, center: lngLat(city.center), province: p};
          out.cities.set(c.adcode, c);
          out.list.push(c);
        }
      }
      resolve(out);
    });
  });
  return divisionsLoading;
}

export function districtChildren(A, province) {
  return new Promise((resolve, reject) => {
    new A.DistrictSearch({subdistrict: 1, extensions: 'base', level: 'province'}).search(province, (status, result) => {
      if (status !== 'complete' || !result.districtList?.length) reject(new Error('城市列表暂不可用，可手工填写城市名和行政区代码。'));
      else resolve(result.districtList[0].districtList || []);
    });
  });
}

export function createFootprintMap(A, element, locations) {
  document.getElementById(element).replaceChildren();
  const map = new A.Map(element, {center: [104, 35], zoom: 3, resizeEnable: true, mapStyle: 'amap://styles/whitesmoke'});
  const points = [];
  locations.forEach((loc, index) => {
    if (loc.longitude == null || loc.latitude == null) return;
    const content = document.createElement('span');
    content.className = 'map-marker'; content.textContent = String(index + 1);
    const marker = new A.Marker({position: [Number(loc.longitude), Number(loc.latitude)], content, offset: new A.Pixel(-17, -17)});
    points.push(marker); map.add(marker);
    const previous = locations[index - 1];
    if (previous?.longitude != null && Math.abs(Number(previous.longitude) - Number(loc.longitude)) < 180) {
      map.add(new A.Polyline({path: [[Number(previous.longitude), Number(previous.latitude)], [Number(loc.longitude), Number(loc.latitude)]], strokeColor: '#4b3bea', strokeWeight: 2, strokeStyle: 'dashed'}));
    }
  });
  if (points.length) map.setFitView(points, false, [45, 45, 45, 45], 10);
  return map;
}
