import {cityKey, createMemberOrder, municipalities, placeName} from './logic.js';
import {ClassMap, chinaDivisions, createFootprintMap, loadMap} from './map.js';
import {REGIONS, consistentCounts, inRange, isStale, levelOf, memberKey, presetRange, splitForRegion} from './filter.js';
import {createSheet} from './sheet.js';
import {monthLabel, mountRange} from './range.js';
import {matches, memberRow, otherGroup, placeOf, regionTitle, section, sectionTitle, shortName} from './views.js';
import {closeUpdate, placeSearch, renderUpdate} from './update.js';
import {dayPicker} from './pickers.js';
import {buildEntryLink, readEntryLink} from './links.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const state = {scope: 'china', view: {type: 'home'}, search: '', range: null, preset: '3y', earliest: '', members: [], boot: null};
let map, sheet, rangeControl, footprintMap, memberTicket = 0, updateTicket = 0, modalMap, snapshotRequest = 0, toastTimer, modalGeneration = 0;
const apiRoot = new URL('api/', location.href);
const orderMembers = createMemberOrder();
const entryLink = readEntryLink(location.href);
const entry = entryLink.values;
if (entryLink.consumed) history.replaceState(history.state, '', entryLink.cleanUrl);
let pendingClaim = !!entry.claim_code;
$('#unlock-form [name="password"]').value = entry.view_code;

async function api(path, method = 'GET', data) {
  const token = document.cookie.split('; ').find(item => item.startsWith('csrftoken='))?.split('=').slice(1).join('=') || '';
  const response = await fetch(new URL(path, apiRoot), {method, credentials: 'same-origin', cache: 'no-store',
    headers: {'Content-Type': 'application/json', 'X-CSRFToken': decodeURIComponent(token)},
    ...(data === undefined ? {} : {body: JSON.stringify(data)})});
  let result;
  try {result = await response.json();} catch {throw new Error('服务暂时不可用，请稍后重试。');}
  if (!response.ok) throw Object.assign(new Error(result.error || '请求失败，请刷新重试。'), {status: response.status});
  return result;
}
function notify(message, error = false) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.toggle('error', error); $('#toast').hidden = false;
  toastTimer = setTimeout(() => {$('#toast').hidden = true;}, error ? 8000 : 4500);
}
function run(task) {Promise.resolve().then(task).catch(error => notify(error.message, true));}
function closeModal() {$('#modal').close(); modalMap?.destroy(); modalMap = null; modalGeneration++;}
function openModal(title, html, wide = false) {
  modalMap?.destroy(); modalMap = null; modalGeneration++;
  $('#modal-title').textContent = title; $('#modal-body').innerHTML = html;
  $('#modal').classList.toggle('wide', wide);
  if (!$('#modal').open) $('#modal').showModal();
}
function bindForm(selector, handler) {
  $(selector).addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget;
    const buttons = [...form.querySelectorAll('button[type="submit"]')]; buttons.forEach(button => button.disabled = true);
    let error = form.querySelector('.form-error');
    if (!error) {error = document.createElement('p'); error.className = 'form-error'; error.setAttribute('role', 'alert'); form.append(error);}
    error.textContent = '';
    try {await handler(Object.fromEntries(new FormData(form)), form);} catch (err) {error.textContent = err.message;}
    finally {buttons.forEach(button => button.disabled = false);}
  });
}

// Account links (my footprint, password, admin, login, logout); shown in the home sheet
// header and again at the bottom of the 我 page so they are easy to find.
function renderAccount(container) {
  const boot = state.boot;
  container.innerHTML = `${boot.me ? '<button data-act="profile" class="text-button" type="button">我的足迹</button><button data-act="password" class="text-button" type="button">改密码</button>' : '<button data-act="login" class="text-button" type="button">认领 / 登录</button>'}
    ${boot.is_admin ? '<button data-act="admin" class="text-button" type="button">班级管理</button>' : `<a class="quiet-link" href="/admin/login/?next=${encodeURIComponent(location.pathname)}">管理员</a>`}
    ${boot.authenticated || boot.unlocked && boot.has_password ? '<button data-act="logout" class="text-button" type="button">退出</button>' : ''}`;
  const actions = {profile: () => run(() => memberDialog(boot.me.id)), password: passwordDialog, admin: () => run(adminDialog), login: () => authDialog('login'),
    logout: () => run(async () => {await api('logout', 'POST', {}); location.reload();})};
  container.querySelectorAll('[data-act]').forEach(button => button.onclick = actions[button.dataset.act]);
}
async function boot() {
  state.boot = await api('bootstrap');
  const boot = state.boot;
  $('#class-title').textContent = boot.classroom.name;
  $('#class-description').textContent = boot.classroom.description || '看看大家落脚在哪座城，为下一次相聚留个坐标。';
  $('#gate').hidden = boot.unlocked; $('#app').hidden = !boot.unlocked;
  renderAccount($('#account'));
  if (!boot.unlocked) {
    $('#entry-hint').textContent = pendingClaim ? '认领信息已填好，请先输入查看码打开地图。' : entry.view_code ? '查看码已填好，点击打开班级地图即可。' : '';
    return;
  }
  $('#unlock-form [name="password"]').value = ''; entry.view_code = '';
  if (pendingClaim && !boot.me) {pendingClaim = false; authDialog('claim');}
  // The map ends where the sheet begins, so AMap's logo, scale and review number stay
  // visible above it (they are never moved or hidden).
  sheet ||= createSheet($('#sheet'), {stops: sheetStops, openTo: () => wide.matches ? 'full' : 'half', onChange: (detent, height) => {
    $('#app').dataset.detent = detent;
    // Phones: the map ends where the sheet begins. Wide screens: the panel floats on the right.
    $('#app').style.setProperty('--map-bottom', wide.matches ? '0px' : `${detent === 'full' ? sheetStops().peek : height}px`);
    map?.setRightInset(wide.matches && detent !== 'peek' ? $('#sheet').offsetWidth + 16 : 0);
    // The visible map just changed size: re-frame the home view so no dot ends up under the
    // sheet or off screen — unless the user has already taken over the map.
    if (map && state.view.type === 'home' && !map.userMoved) setTimeout(() => map.fit(), 60);
    renderSheet();
  }});
  await refresh();
  sheet.snap('peek', false);
  if (!map) {
    $('#map-status').hidden = false; $('#map-status').textContent = '正在载入地图…';
    try {
      const A = await loadMap(boot.map);
      state.A = A;
      // One DistrictSearch for dot positions and the city search; retried if it fails.
      const loadDivisions = () => {
        const request = chinaDivisions(A);
        request.then(loaded => {state.divisions = loaded;}, () => setTimeout(() => map?.setDivisions(loadDivisions()), 5000));
        return request;
      };
      map ||= new ClassMap(A, 'map', {divisions: loadDivisions(), onPick: openRegion, onClusterPick: () => {},
        onBlank: () => {if (sheet.detent !== 'peek') sheet.snap('peek');},
        onUserMoved: () => {$('#fit-all').hidden = false;},
        onUnplaced: n => {$('#unplaced').hidden = !n; $('#unplaced').textContent = n ? `地图上暂时少画了 ${n} 人，名单是完整的` : '';}});
      $('#map-status').hidden = true;
      render();
      map.fit();
    } catch (error) {$('#map-status').textContent = error.message;}
  }
}
// Sheet stops: the closed sheet is a slim bar (title + one line); half is ~55% of the screen.
function sheetStops() {
  const sheetTop = $('#sheet').getBoundingClientRect().top;
  const peek = Math.round($('#peek-end').getBoundingClientRect().top - sheetTop + 10);
  const full = $('#sheet').offsetHeight;
  return {peek, half: Math.min(full - 80, Math.max(Math.round(innerHeight * 0.55), peek + 160)), full};
}
const wide = matchMedia('(min-width: 720px)');
async function refresh() {
  const request = ++snapshotRequest;
  const result = await api('snapshot');
  if (request !== snapshotRequest) return;
  state.members = orderMembers(result.members);
  const confirmed = state.members.map(member => member.location?.confirmed_at).filter(Boolean).sort();
  state.earliest = confirmed[0]?.slice(0, 10) || state.boot.today;
  // Imports and edits can change the earliest confirmation. Rebuild the axis and
  // preset closures with the new data, while preserving a manually chosen range.
  if (state.preset) state.range = presetRange(state.preset, state.boot.today, state.earliest);
  rangeControl = mountRange($('#range'), {today: state.boot.today, earliest: state.earliest, range: state.range, preset: state.preset,
    onChange: (range, preset) => {state.range = range; state.preset = preset; render();}});
  render();
}
function rangeLabel() {
  const names = {'1y': '近 1 年', '3y': '近 3 年', all: '全部时间里'};
  if (state.preset) return names[state.preset] + ' ';
  return `${monthLabel(state.range.from)}–${state.range.to === null ? '今天' : monthLabel(state.range.to)} `;
}
function setScope(scope) {
  closeUpdate();
  $('#fit-all').hidden = true;
  state.scope = scope; state.view = {type: 'home'};
  render(); sheet.snap('peek'); map?.fit();
}
function openRegion(key, level) {
  closeUpdate();
  state.view = {type: 'region', key, level};
  render(); sheet.snap('half');
  map?.focus(key);  // after the snap, so the dot lands in the middle of the visible map
}
function goHome() {
  closeUpdate();
  footprintMap?.destroy(); footprintMap = null;
  state.view = {type: 'home'};
  render(); sheet.snap('peek');
}
function regionName(key, level) {
  const loc = state.members.find(member => member.location && levelOf(member.location) === level && memberKey(member.location, level) === key)?.location;
  return placeOf(loc) || key;
}
function render() {
  const counts = consistentCounts(state.members, state.range);
  $('#count-china').textContent = counts.china; $('#count-world').textContent = counts.world;
  document.querySelectorAll('[data-scope]').forEach(button => {button.classList.toggle('on', button.dataset.scope === state.scope); button.setAttribute('aria-pressed', String(button.dataset.scope === state.scope));});
  const me = state.boot.me && state.members.find(member => member.id === state.boot.me.id);
  $('#me-btn .dot').hidden = !state.boot.me || !isStale(me?.location?.confirmed_at, state.boot.today);
  map?.setLevel(state.scope);
  map?.update(state.members, state.range);
  map?.select(state.view.type === 'region' ? state.view.key : null);
  const to = state.range.to === null ? '今天' : monthLabel(state.range.to);
  $('#range-chip').innerHTML = `确认时间 ${monthLabel(state.range.from)} – ${to}<u>修改</u>`;
  $('#range-chip').hidden = state.view.type === 'home';
  renderSheet();
}
const rows = (list, options = {}) => list.map(member => memberRow(member, state.range, {...options, meId: state.boot.me?.id})).join('');
const moreRow = (text, note) => `<button type="button" class="more" data-more>${text}<span>${note}</span></button>`;
function renderSheet() {
  if (state.view.type === 'member' || state.view.type === 'update') return;
  const home = state.view.type === 'home', full = sheet?.detent === 'full';
  $('#range').hidden = !home; $('#legend').hidden = !home; $('#region-close').hidden = home; $('#account').hidden = !home;
  const counts = consistentCounts(state.members, state.range);
  let html;
  $('#search-box').hidden = !home;
  if (home && state.search.trim()) {
    // Search covers everyone — any scope, any confirm time, no location yet — so nobody is unreachable.
    const found = state.members.filter(member => matches(member, state.search.trim()));
    $('#list').innerHTML = section('搜索结果', found.length) + (rows(found, {showPlace: true}) || '<p class="empty-small">没有找到。</p>');
    return;
  }
  if (home) {
    // Everything on the home sheet is the current scope (境内 or 境外), same as the map.
    const shown = counts[state.scope];
    $('#sheet-title').textContent = `${shown} 位同学`;
    const missing = state.members.filter(member => !member.location).length;
    $('#sheet-summary').textContent = `${rangeLabel()}确认过位置 · 全班 ${state.members.length} 人${missing ? ` · 另有 ${missing} 人未填位置` : ''}`;
    if (state.scope === 'world') html = countryGroups(full);
    else {
      const {inRange: fresh, others} = splitForRegion(state.members, null, 'china', state.range);
      const other = otherGroup(state.range.to === null);
      const remaining = Math.max(0, fresh.length - 3) + others.length + missing;
      html = full ? (fresh.length ? section(sectionTitle(true), fresh.length) + rows(fresh, {showPlace: true}) : '') + (others.length ? section(other.title, others.length, other.note) + rows(others, {showPlace: true}) : '')
          + unplacedGroup()
        : (fresh.length ? section('最近更新', fresh.length) + rows(fresh.slice(0, 3), {showPlace: true}) : '') + (remaining ? moreRow('展开全部', `还有 ${remaining} 人`) : '');
    }
    // Zero map counts do not mean an empty roster: keep older and unplaced people reachable.
    if (!shown) html = '<div id="empty" class="empty"><p>这个时间段还没有同学确认过位置</p><button id="expand-range" class="secondary" type="button">扩大时间范围</button></div>' + html;
  } else {
    const {key, level} = state.view;
    const name = regionName(key, level);
    const {inRange: fresh, others} = splitForRegion(state.members, key, level, state.range);
    $('#sheet-title').textContent = regionTitle(name, fresh.length);
    $('#sheet-summary').textContent = '这段时间确认过位置';
    const toToday = state.range.to === null;
    const otherNote = `另有 ${others.length} 条${toToday ? '更早的记录' : '不在这段时间里的记录'}`;
    const other = otherGroup(toToday, escape(name));
    html = full ? section(sectionTitle(true), fresh.length) + rows(fresh) + (others.length ? section(other.title, others.length, other.note) + rows(others) : '')
      : rows(fresh.slice(0, 3)) + (fresh.length > 3 || others.length ? moreRow('展开全部', `还有 ${Math.max(0, fresh.length - 3)} 人，${otherNote}`) : '');
  }
  $('#list').innerHTML = html;
}
function unplacedGroup() {
  const unplaced = state.members.filter(member => !member.location);
  return unplaced.length ? section('还没填位置', unplaced.length) + rows(unplaced) : '';
}
function countryGroups(full) {
  const {inRange: fresh, others} = splitForRegion(state.members, null, 'world', state.range);
  const groups = new Map();
  for (const member of fresh) {
    const name = placeOf(member.location);
    groups.set(name, [...(groups.get(name) || []), member]);
  }
  const other = otherGroup(state.range.to === null);
  const remaining = [...groups.values()].reduce((n, list) => n + Math.max(0, list.length - 3), 0)
    + others.length + state.members.filter(member => !member.location).length;
  return [...groups].map(([name, list]) => section(escape(name), list.length) + rows(full ? list : list.slice(0, 3))).join('')
    + (full ? (others.length ? section(other.title, others.length, other.note) + rows(others, {showPlace: true}) : '') + unplacedGroup()
      : (remaining ? moreRow('展开全部', `还有 ${remaining} 人`) : ''));
}
function authDialog(mode, draft = entry, useCode = !draft.name && !!draft.student_code) {
  const claim = mode === 'claim';
  openModal(claim ? '认领我的身份' : '同学，欢迎回来', `<div class="segmented auth-tabs"><button id="tab-login" class="${claim ? '' : 'active'}">个人登录</button><button id="tab-claim" class="${claim ? 'active' : ''}">首次认领</button></div>
    <p class="muted">${claim ? '填写姓名和管理员发给你的一次性认领码，再设置自己的密码。个人密码至少 6 位，允许纯数字，无需混合字母或符号。' : '使用名单中的姓名和自己设置的密码登录。'}</p>
    <form id="auth-form"><label>${useCode ? '班级编号' : '姓名'}<input name="${useCode ? 'student_code' : 'name'}" value="${escape(useCode ? draft.student_code : draft.name)}" autocomplete="username" maxlength="${useCode ? 64 : 60}" required></label>${claim ? `<label>一次性认领码<input name="claim_code" value="${escape(draft.claim_code)}" autocomplete="off" maxlength="200" required></label>` : ''}
    <label>${claim ? '设置个人密码（至少 6 位）' : '个人密码'}<input name="password" type="password" autocomplete="${claim ? 'new-password' : 'current-password'}" ${claim ? 'minlength="6"' : ''} maxlength="200" required></label>
    ${claim && !state.boot.unlocked ? '<p class="form-error">认领前请先关闭窗口，输入班级查看码。</p>' : ''}<button type="submit" class="primary" ${claim && !state.boot.unlocked ? 'disabled' : ''}>${claim ? '认领并进入' : '登录'}</button></form>
    <details><summary>同名或使用原来的班级编号</summary><p class="muted">同名同学可凭各自的认领码认领；登录时请使用管理员提供的班级编号。</p><button id="identity-toggle" class="text-button">${useCode ? '改用姓名' : '使用班级编号'}</button></details><p class="muted">忘记个人密码可联系管理员重新发放认领码。</p>`);
  const remember = () => {
    const values = Object.fromEntries(new FormData($('#auth-form')));
    const saved = {...draft, ...values}; delete saved.password;
    Object.assign(entry, {name: saved.name || '', student_code: saved.student_code || '', claim_code: saved.claim_code || ''});
    if (claim && !state.boot.unlocked) pendingClaim = !!entry.claim_code;
    return saved;
  };
  $('#auth-form').addEventListener('input', remember);
  $('#tab-login').onclick = () => authDialog('login', remember(), useCode);
  $('#tab-claim').onclick = () => authDialog('claim', remember(), useCode);
  $('#identity-toggle').onclick = () => authDialog(mode, remember(), !useCode);
  bindForm('#auth-form', async data => {
    await api(claim ? 'claim' : 'login', 'POST', data);
    entry.claim_code = ''; pendingClaim = false;
    closeModal(); await boot(); notify(claim ? '认领成功，可以更新自己的位置了。' : '已登录');
  });
}
function passwordDialog() {
  const minimum = state.boot.is_admin ? 10 : 6;
  openModal('修改个人密码', `<form id="password-form"><label>原密码<input type="password" name="old_password" autocomplete="current-password" required></label><label>新密码（至少 ${minimum} 位）<input type="password" name="password" autocomplete="new-password" minlength="${minimum}" maxlength="200" required></label><button class="primary" type="submit">保存新密码</button></form>`);
  bindForm('#password-form', async data => {await api('password', 'POST', data); closeModal(); notify('个人密码已更新，其他设备需要重新登录。');});
}
// Member detail lives in the sheet (full height) instead of a modal.
async function memberDialog(id) {
  closeModal(); closeUpdate();
  // A newer tap wins: an older request that lands late must not build a second footprint map.
  const ticket = ++memberTicket;
  const detail = await api(`members/${id}`), member = detail.member;
  if (ticket !== memberTicket) return;
  const chronological = detail.locations;
  const back = state.view.type === 'member' ? state.view.back : state.view;
  state.view = {type: 'member', id, back};
  footprintMap?.destroy(); footprintMap = null;
  $('#range').hidden = true; $('#legend').hidden = true; $('#region-close').hidden = false; $('#account').hidden = true; $('#search-box').hidden = true;
  $('#sheet-title').textContent = member.name;
  $('#sheet-summary').textContent = member.bio || '下次路过，记得约一顿饭。';
  $('#list').innerHTML = `<div id="member-detail"><h2 class="sec">足迹 · ${chronological.length} 段</h2>
    ${detail.editable ? '<div class="actions"><button id="add-location" class="text-button" type="button">＋ 更新位置 / 补录历史</button><button id="edit-profile" class="text-button" type="button">编辑资料</button></div>' : ''}
    <div id="footprint-map" class="mini-map"><p class="map-inline-status">正在加载足迹地图…</p></div><p class="muted small">编号按时间排序；连线表示足迹顺序，不代表实际行程。</p>
    <div class="footprint-list">${[...chronological].reverse().map((loc, i) => `<article class="footprint"><span class="step">${chronological.length - i}</span><div><h3>${escape(placeName(loc))}</h3><div class="stay-date">${loc.started_on} → ${loc.ended_on || '至今'}${loc.ended_on ? '（离开当天起不计入）' : ''}</div>${loc.note ? `<p class="member-note">${escape(loc.note)}</p>` : ''}<small class="stay-date">资料更新于 ${escape(new Date(loc.updated_at).toLocaleDateString('zh-CN'))}</small>${detail.editable ? `<div class="record-actions"><button class="text-button" type="button" data-edit="${loc.id}">编辑</button><button class="text-button danger" type="button" data-delete="${loc.id}">删除</button></div>` : ''}</div></article>`).join('') || '<p class="empty-small">还没有留下足迹。</p>'}</div></div>`;
  sheet.snap('full');
  $('#add-location')?.addEventListener('click', () => locationDialog(member));
  $('#edit-profile')?.addEventListener('click', () => profileDialog(member));
  $('#list').querySelectorAll('[data-edit]').forEach(button => button.onclick = () => locationDialog(member, detail.locations.find(loc => loc.id === Number(button.dataset.edit))));
  $('#list').querySelectorAll('[data-delete]').forEach(button => button.onclick = () => {
    const loc = detail.locations.find(loc => loc.id === Number(button.dataset.delete));
    openModal('删除这段足迹？', `<p>${escape(placeName(loc))} · ${loc.started_on}</p><p class="muted">这段记录会从地图中移除。其他记录的日期不会自动延长。</p><div class="actions"><button id="delete-confirm" class="danger-button" type="button">确认删除</button><button id="delete-cancel" class="text-button" type="button">取消</button></div>`);
    $('#delete-cancel').onclick = closeModal;
    $('#delete-confirm').onclick = () => run(async () => {await api(`members/${id}/locations/${loc.id}`, 'DELETE', {version: loc.version}); await refresh(); await memberDialog(id); notify('足迹已删除');});
  });
  try {
    const A = await loadMap(state.boot.map);
    if (ticket === memberTicket && state.view.type === 'member' && state.view.id === id) footprintMap = createFootprintMap(A, 'footprint-map', chronological);
  } catch (error) {if (state.view.id === id) $('#footprint-map').textContent = error.message;}
}
async function openUpdate() {
  const me = state.boot.me;
  const current = state.members.find(member => member.id === me.id)?.location || null;
  const back = state.view.type === 'update' ? state.view.back : state.view;
  footprintMap?.destroy(); footprintMap = null;
  state.view = {type: 'update', back};
  $('#range').hidden = true; $('#legend').hidden = true; $('#account').hidden = true; $('#region-close').hidden = false; $('#search-box').hidden = true;
  $('#range-chip').hidden = true;
  $('#sheet-title').textContent = '更新我的位置';
  $('#sheet-summary').textContent = '';
  $('#list').innerHTML = '<div id="update"></div><nav id="update-account" class="account" aria-label="账号"></nav>';
  renderAccount($('#update-account'));
  sheet.snap('full');
  // The note's version is taken when the form opens: a note changed elsewhere meanwhile is a conflict, not an overwrite.
  const ticket = ++updateTicket;
  const {member: mine} = await api(`members/${me.id}`);
  // A newer tap on 我 (or leaving the page) wins: a late response must not wipe a draft.
  if (ticket !== updateTicket || state.view.type !== 'update' || !$('#update')) return;
  renderUpdate($('#update'), {me, current, bio: mine.bio || '', memberVersion: mine.updated_at, today: state.boot.today, api, notify, countries: state.boot.countries || {}, provinces: state.boot.provinces || {},
    divisions: () => state.divisions, locate: locateCity,
    todayInRange: () => inRange(`${state.boot.today}T12:00:00+08:00`, state.range),
    onDone: async () => {closeUpdate(); await refresh(); goHome();},
    onStale: () => run(async () => {await refresh(); await openUpdate();}),
    onNotMe: () => run(async () => {await api('logout', 'POST', {}); goHome(); await boot(); authDialog('login');})});
}
// Device location → GCJ-02 → reverse geocode → prefecture city from the division list.
function locateCity() {
  return new Promise((resolve, reject) => {
    const A = state.A;
    if (!navigator.geolocation || !A) {reject(new Error('当前浏览器不支持设备定位，请直接输入城市。')); return;}
    navigator.geolocation.getCurrentPosition(position => {
      A.convertFrom([position.coords.longitude, position.coords.latitude], 'gps', (status, result) => {
        if (status !== 'complete' || !result.locations?.length) {reject(new Error('定位转换失败，请直接输入城市。')); return;}
        const point = result.locations[0];
        new A.Geocoder().getAddress([point.lng, point.lat], (geoStatus, geo) => {
          const adcode = geo?.regeocode?.addressComponent?.adcode;
          if (geoStatus !== 'complete' || !adcode) {reject(new Error('没能识别所在城市，请直接输入。')); return;}
          const province = adcode.slice(0, 2) + '0000';
          resolve(state.divisions?.cities.get(municipalities.has(province) ? province : adcode.slice(0, 4) + '00') || null);
        });
      });
    }, () => reject(new Error('未能获取设备位置，请直接输入城市。')), {timeout: 15000, maximumAge: 0});
  });
}
function leaveUpdate() {
  closeUpdate();
  const back = state.view.back || {type: 'home'};
  // A member detail is not part of render(): rebuild it (and its footprint map) explicitly.
  if (back.type === 'member') {state.view = back.back || {type: 'home'}; run(() => memberDialog(back.id)); return;}
  state.view = back;
  render(); sheet.snap(state.view.type === 'home' ? 'peek' : 'half');
}
function leaveMember() {
  footprintMap?.destroy(); footprintMap = null;
  state.view = state.view.back || {type: 'home'};
  // Update forms, like member details, must be rebuilt rather than passed to renderSheet().
  if (state.view.type === 'update') {run(openUpdate); return;}
  render(); sheet.snap(state.view.type === 'home' ? 'peek' : 'half');
}
function profileDialog(member) {
  openModal('编辑我的资料', `<form id="profile-form"><label>姓名 / 昵称<input name="name" maxlength="60" value="${escape(member.name)}" required></label><p class="muted">修改后请使用新的姓名登录。</p><label>一句近况<textarea name="bio" maxlength="240">${escape(member.bio)}</textarea></label><button type="submit" class="primary">保存资料</button></form>`);
  bindForm('#profile-form', async data => {await api(`members/${member.id}`, 'PATCH', {...data, version: member.updated_at}); await refresh(); await memberDialog(member.id); notify('资料已保存');});
}

function locationDialog(member, loc = {}) {
  const isEdit = !!loc.id;
  const abroad = !!loc.country_code && levelOf(loc) === 'world';
  openModal(isEdit ? '编辑这段足迹' : '留一个相聚的坐标', `<form id="location-form">
    <p class="muted">可以只填写城市，也可以在地图上选一个方便见面的点；无需填写家庭住址。</p>
    <input type="hidden" name="country_code" id="country-code" value="${escape(loc.country_code || 'CHN')}"><input type="hidden" name="province_code" id="province-code" value="${escape(loc.province_code || '')}">
    <div class="tog" role="group" aria-label="境内或境外"><button type="button" data-mode="china" class="${abroad ? '' : 'on'}">境内 · 城市</button><button type="button" data-mode="world" class="${abroad ? 'on' : ''}">境外 · 国家或地区</button></div>
    <label>城市或国家<input id="place-input" type="text" inputmode="search" autocomplete="off" value="${escape(placeOf(loc.country_code ? {...loc, country_name: state.boot.countries?.[loc.country_code]} : null))}" placeholder="输入城市或国家名"></label><div class="sugg"></div>
    <div class="form-grid"><label>城市名称<input name="city_name" id="city-name" maxlength="80" value="${escape(loc.city_name || '')}" placeholder="如：杭州市 / Tokyo"></label><label id="city-code-label">城市行政区代码<input name="city_code" id="city-code" maxlength="6" inputmode="numeric" value="${escape(loc.city_code || '')}" placeholder="如：330100"></label></div>
    <label>地点备注<input name="label" maxlength="120" value="${escape(loc.label || '')}" placeholder="如：滨江 / 市中心 / 常去的咖啡店"></label>
    <div class="form-grid dates"><div class="opt"><span>到达日期</span><button type="button" class="text-button" data-date="started_on">${loc.started_on || state.boot.today}</button><input type="hidden" name="started_on" value="${loc.started_on || state.boot.today}"></div>
      <div class="opt"><span>离开日期（当天起不计入）</span><button type="button" class="text-button" data-date="ended_on">${loc.ended_on || '还在这里'}</button><input type="hidden" name="ended_on" value="${loc.ended_on || ''}"><button type="button" class="text-button" data-clear-ended ${loc.ended_on ? '' : 'hidden'}>清除</button></div></div>
    ${!isEdit ? '<label class="checkbox"><input type="checkbox" name="close_previous" checked>将上一个未结束的常住地结束于此次到达日</label>' : ''}
    <div class="point-tools"><span>可选：在地图上点选位置</span><button type="button" id="gps-button">使用设备位置</button><button type="button" id="clear-point">仅记录城市</button></div>
    <div id="editor-map" class="mini-map"><p class="map-inline-status">正在加载选点地图…</p></div><p id="point-status" class="muted small" role="status">点选后请核对城市与行政区，位置只在保存时提交。</p>
    <details class="coordinate-details"><summary>经纬度与坐标系</summary><div class="form-grid"><label>经度<input name="longitude" id="longitude" type="number" step="0.000001" min="-180" max="180" value="${loc.longitude ?? ''}"></label><label>纬度<input name="latitude" id="latitude" type="number" step="0.000001" min="-90" max="90" value="${loc.latitude ?? ''}"></label></div><div class="opt"><span>坐标系</span><div class="segmented" id="coord-seg"><button type="button" data-coord="gcj02">GCJ-02（中国内地）</button><button type="button" data-coord="wgs84">WGS84（境外）</button></div><input type="hidden" name="coordinate_system" id="coordinate-system" value="${escape(loc.coordinate_system || 'gcj02')}"></div></details>
    <label>这段时间的近况<textarea name="note" maxlength="500" placeholder="如：在杭州工作，周末一般有空。">${escape(loc.note || '')}</textarea></label>
    <button type="submit" class="primary">保存${isEdit ? '修改' : '足迹'}</button></form>`, true);
  const generation = modalGeneration;
  let A, marker, cityRequest = 0, pointRequest = 0;
  const active = () => generation === modalGeneration && $('#modal').open;
  function clearPoint() {
    pointRequest++;
    $('#longitude').value = ''; $('#latitude').value = ''; marker?.setMap(null);
    $('#point-status').textContent = '只记录城市；如需共享位置点，请重新选点。';
  }
  let mode = abroad ? 'world' : 'china', placeSelected = !!loc.country_code;
  const clearPlace = () => {
    placeSelected = false;
    $('#country-code').value = mode === 'china' ? 'CHN' : '';
    $('#province-code').value = ''; $('#city-code').value = ''; $('#city-name').value = '';
  };
  const setCoord = value => {
    $('#coordinate-system').value = value;
    $('#coord-seg').querySelectorAll('[data-coord]').forEach(button => button.classList.toggle('active', button.dataset.coord === value));
  };
  $('#coord-seg').querySelectorAll('[data-coord]').forEach(button => button.onclick = () => setCoord(button.dataset.coord));
  const updateCountry = () => {
    const china = mode === 'china';
    $('#city-code-label').hidden = !china;
    setCoord(china ? 'gcj02' : 'wgs84');
  };
  const choosePlace = item => {
    if (!item) return;
    if (item.kind === 'region') {
      $('#country-code').value = 'CHN'; $('#province-code').value = item.province; $('#city-code').value = ''; $('#city-name').value = '';
    } else if (item.kind === 'province') {
      $('#country-code').value = 'CHN'; $('#province-code').value = item.code; $('#city-code').value = ''; $('#city-name').value = '';
    } else if (item.kind === 'china') {
      const province = municipalities.has(item.city.adcode) ? item.city.adcode : item.city.province.adcode;
      $('#country-code').value = 'CHN'; $('#province-code').value = province;
      $('#city-code').value = item.city.adcode; $('#city-name').value = item.city.name;
      modalMap?.setCity(item.city.adcode);
    } else {
      $('#country-code').value = item.code; $('#province-code').value = ''; $('#city-code').value = '';
    }
    placeSelected = true;
  };
  function setPoint(lng, lat) {
    if (!active()) return;
    const request = ++pointRequest;
    $('#longitude').value = Number(lng).toFixed(6); $('#latitude').value = Number(lat).toFixed(6);
    marker?.setMap(null); marker = new A.Marker({map: modalMap, position: [Number(lng), Number(lat)]});
    $('#point-status').textContent = '已选点，保存后才会更新班级地图。请核对下方所属城市。';
    if ($('#country-code').value === 'CHN') {
      new A.Geocoder().getAddress([Number(lng), Number(lat)], (status, result) => {
        if (!active() || request !== pointRequest || status !== 'complete' || !result.regeocode?.addressComponent) return;
        const address = result.regeocode.addressComponent;
        const province = String(address.adcode || '').slice(0, 2) + '0000';
        if (!state.boot.provinces[province]) return;
        $('#province-code').value = province;
        const adcode = String(address.adcode);
        $('#city-code').value = cityKey(adcode.slice(2, 4) === '90' ? adcode : adcode.slice(0, 4) + '00', province);
        $('#city-name').value = municipalities.has(province) ? state.boot.provinces[province] : (Array.isArray(address.city) ? address.district : address.city) || address.district;
        $('#place-input').value = shortName($('#city-name').value);
        placeSelected = true;
      });
    }
  }
  updateCountry();
  setCoord(loc.coordinate_system || $('#coordinate-system').value);
  const search = placeSearch($('#place-input'), $('#location-form .sugg'), {mode: () => mode, divisions: () => state.divisions,
    countries: state.boot.countries || {}, provinces: state.boot.provinces || {}, onPick: item => {
      clearPoint();
      if (item) choosePlace(item); else clearPlace();
    }});
  $('#location-form').querySelectorAll('[data-mode]').forEach(button => button.onclick = () => {
    mode = button.dataset.mode; clearPoint(); clearPlace(); updateCountry();
    $('#location-form').querySelectorAll('[data-mode]').forEach(other => other.classList.toggle('on', other === button));
    $('#place-input').value = ''; search.redraw();
  });
  $('#location-form').querySelectorAll('[data-date]').forEach(button => button.onclick = () => {
    const field = button.dataset.date, hidden = $(`#location-form [name="${field}"]`);
    dayPicker(button.closest('.opt'), {value: hidden.value || state.boot.today, min: '1990-01-01', max: field === 'started_on' ? state.boot.today : '2100-12-31',
      onPick: iso => {hidden.value = iso; button.textContent = iso; if (field === 'ended_on') $('[data-clear-ended]').hidden = false;}});
  });
  $('[data-clear-ended]').onclick = event => {$('#location-form [name="ended_on"]').value = ''; $('[data-date="ended_on"]').textContent = '还在这里'; event.currentTarget.hidden = true;};
  $('#clear-point').onclick = clearPoint;
  $('#gps-button').onclick = () => {
    if (!A) {notify('请先等待地图加载完成', true); return;}
    if (!navigator.geolocation) {notify('当前浏览器不支持设备定位', true); return;}
    $('#point-status').textContent = '等待设备定位授权…';
    navigator.geolocation.getCurrentPosition(position => {
      if (!active()) return;
      const point = [position.coords.longitude, position.coords.latitude];
      if ($('#country-code').value === 'CHN' && !['710000', '810000', '820000'].includes($('#province-code').value)) {
        A.convertFrom(point, 'gps', (status, result) => {
          if (!active()) return;
          if (status !== 'complete' || !result.locations?.length) {$('#point-status').textContent = '坐标转换失败，请手工在地图上选点。'; return;}
          const p = result.locations[0]; setCoord('gcj02'); setPoint(p.lng, p.lat); modalMap.setZoomAndCenter(12, [p.lng, p.lat]);
        });
      } else {setCoord('wgs84'); setPoint(...point); modalMap.setZoomAndCenter(12, point);}
    }, () => {if (active()) $('#point-status').textContent = '未能获取设备位置，可以直接在地图上选点。';}, {timeout: 15000, maximumAge: 0});
  };
  bindForm('#location-form', async data => {
    if (!placeSelected || !data.country_code) throw new Error('请先点选一个城市或国家');
    data.close_previous = data.close_previous === 'on';
    if (isEdit) data.version = loc.version;
    await api(`members/${member.id}/locations${isEdit ? '/' + loc.id : ''}`, isEdit ? 'PATCH' : 'POST', data);
    await refresh(); await memberDialog(member.id); notify('足迹已保存');
  });
  run(async () => {
    try {
      A = await loadMap(state.boot.map); if (!active()) return;
      $('#editor-map').replaceChildren();
      modalMap = new A.Map('editor-map', {zoom: loc.longitude != null ? 10 : 4, center: loc.longitude != null ? [Number(loc.longitude), Number(loc.latitude)] : [104, 35], resizeEnable: true});
      if (loc.longitude != null) marker = new A.Marker({map: modalMap, position: [Number(loc.longitude), Number(loc.latitude)]});
      modalMap.on('click', event => setPoint(event.lnglat.lng, event.lnglat.lat));
    } catch (error) {if (active()) $('#editor-map').textContent = error.message;}
  });
}

const importTemplate = 'student_code,name,bio,country_code,province_code,city_code,city_name,label,longitude,latitude,coordinate_system,started_on,ended_on,note\n001,示例同学甲,,CHN,330000,330100,杭州市,,,,gcj02,2024-07-01,,在杭州工作\n002,示例同学乙,,,,,,,,,,,,\n';
function download(name, content, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob(['\ufeff', content], {type}));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function adminDialog() {
  const settings = await api('admin/settings');
  openModal('班级管理', `<div class="admin-tabs"><button id="import-open" class="primary">导入同学与已知位置</button><button id="template-download">下载 CSV 模板</button><button id="share-view">分享查看链接</button></div>
    <details><summary>班级名称与解锁密码</summary><form id="settings-form"><label>班级名称<input name="name" maxlength="80" required value="${escape(settings.name)}"></label><label>班级说明<input name="description" maxlength="240" value="${escape(settings.description)}"></label><label>新的班级密码<input name="password" type="password" autocomplete="new-password" minlength="10" maxlength="200" placeholder="留空则不修改"></label><label class="checkbox"><input type="checkbox" name="remove_password">取消班级解锁密码，允许任何访客查看</label><p class="muted">目前${settings.has_password ? '已设置' : '未设置'}班级密码。修改密码会使之前的访客解锁失效。</p><button type="submit">保存班级设置</button></form></details>
    <div class="list-heading"><span>身份认领 · ${state.members.length} 位同学</span></div><p class="muted">认领码有效期 7 天，仅在生成时显示。请单独发给本人；重新认领会立即撤销原登录。</p>
    <div class="admin-members">${state.members.map(member => `<div><span><strong>${escape(member.name)}</strong><small>${escape(member.student_code || '')} · ${member.claimed ? '已认领' : '待认领'}</small></span><div class="actions"><button data-edit-member="${member.id}">编辑</button><button data-invite="${member.id}" data-claimed="${member.claimed}">${member.claimed ? '重新认领' : '生成认领码'}</button></div></div>`).join('') || '<p>还没有同学，请先导入班级名单。</p>'}</div>`, true);
  $('#template-download').onclick = () => download('class-import-template.csv', importTemplate);
  $('#import-open').onclick = importDialog;
  $('#share-view').onclick = () => {
    openModal('分享班级地图', `<form id="view-link-form">${settings.has_password ? '<label>当前班级查看码<input name="view_code" type="password" maxlength="200" autocomplete="off" required></label>' : ''}<p class="muted">${settings.has_password ? '填入当前查看码，接收者打开链接后只需点击“打开班级地图”。请只发给允许查看的同学。' : '当前班级允许访客直接查看。'}</p><button type="submit" class="primary">生成查看链接</button></form><div id="view-link-result"></div>`);
    bindForm('#view-link-form', async data => {
      const link = buildEntryLink(location.href, data);
      $('#view-link-result').innerHTML = `<label>查看链接<input readonly value="${escape(link)}"></label><button id="copy-view-link">复制查看链接</button>`;
      $('#copy-view-link').onclick = () => run(async () => {await navigator.clipboard.writeText(link); notify('已复制查看链接');});
    });
  };
  bindForm('#settings-form', async data => {
    if (data.remove_password === 'on') data.password = '';
    else if (!data.password) delete data.password;
    delete data.remove_password;
    await api('admin/settings', 'PATCH', data); closeModal(); await boot(); notify('班级设置已更新');
  });
  $('#modal-body').querySelectorAll('[data-edit-member]').forEach(button => button.onclick = () => run(() => memberDialog(Number(button.dataset.editMember))));
  $('#modal-body').querySelectorAll('[data-invite]').forEach(button => button.onclick = () => {
    const id = Number(button.dataset.invite), reset = button.dataset.claimed === 'true';
    const member = state.members.find(member => member.id === id);
    openModal(reset ? '重新发放认领码' : '生成认领码', `<p>为 ${escape(member.name)}（${escape(member.student_code)}）${reset ? '重置身份认领' : '发放一次性认领码'}。</p>${reset ? '<p class="form-error">原个人密码和所有登录会话将立即失效，资料与足迹保留。</p>' : '<p class="muted">新认领码会替换此前尚未使用的认领码。</p>'}<button class="primary" id="issue-confirm">${reset ? '确认重置' : '生成'}</button>`);
    $('#issue-confirm').onclick = () => run(async () => {
      $('#issue-confirm').disabled = true;
      try {
        const invitation = await api(`admin/members/${id}/invite`, 'POST', {reset});
        const linkValues = {name: invitation.name, claim_code: invitation.claim_code};
        openModal('认领码已生成', `<p>请单独交给 ${escape(invitation.name)}，关闭后无法再次查看。</p><label>一次性认领码<input id="claim-value" readonly value="${escape(invitation.claim_code)}"></label>${settings.has_password ? '<label>同时预填查看码（可选）<input id="invite-view-code" type="password" maxlength="200" autocomplete="off" placeholder="填入当前班级查看码"></label>' : ''}<label>认领链接<input id="invite-link" readonly value="${escape(buildEntryLink(location.href, linkValues))}"></label><p class="muted">打开链接会预填姓名和认领码。有效至 ${escape(new Date(invitation.expires_at).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'}))}</p><button id="copy-invite" class="primary">复制认领链接</button><details><summary>同名同学的登录备用信息</summary><p>班级编号：${escape(invitation.student_code)}</p></details>`);
        $('#invite-view-code')?.addEventListener('input', event => {$('#invite-link').value = buildEntryLink(location.href, {...linkValues, view_code: event.target.value});});
        $('#copy-invite').onclick = () => run(async () => {await navigator.clipboard.writeText($('#invite-link').value); notify('已复制认领链接');});
      } catch (error) {$('#issue-confirm').disabled = false; throw error;}
    });
  });
}
function importDialog() {
  openModal('导入同学与已知位置', `<p class="muted">CSV（UTF-8）或 JSON 数组，最多 1000 行。同一编号对应同一同学，同一到达日期更新原足迹。请先预览；有错误时整批不导入。</p><button id="import-template">下载字段模板</button><form id="import-form"><label>选择文件<input id="import-file" type="file" accept=".csv,.json,text/csv,application/json"></label><label>或粘贴 CSV / JSON<textarea id="import-content" rows="10" spellcheck="false" placeholder="student_code,name,..." required></textarea></label><button type="submit" class="primary">检查并预览</button></form><div id="import-preview" aria-live="polite"></div>`, true);
  let payload, token;
  $('#import-template').onclick = () => download('class-import-template.csv', importTemplate);
  const invalidate = () => {token = null; $('#import-preview').textContent = '';};
  $('#import-content').oninput = invalidate;
  $('#import-file').onchange = () => run(async () => {
    const file = $('#import-file').files[0]; if (!file) return;
    if (file.size > 1_000_000) throw new Error('文件太大，请拆分到 1 MB 以内。');
    $('#import-content').value = await file.text(); invalidate();
  });
  bindForm('#import-form', async () => {
    const text = $('#import-content').value.trim();
    payload = text.startsWith('[') ? {rows: JSON.parse(text)} : {csv: text};
    const result = await api('admin/import', 'POST', payload); token = result.preview_token;
    $('#import-preview').innerHTML = `<div class="preview-box"><h3>检查通过</h3><p>新增 ${result.created} 位同学 · 更新 ${result.updated} 位同学 · 写入 ${result.locations} 段足迹</p><p class="muted">尚未保存。确认后将以本次内容更新相同编号和到达日期的记录。</p><button id="import-commit" class="primary">确认导入 ${result.rows} 行</button></div>`;
    $('#import-commit').onclick = () => run(async () => {
      if (!token) throw new Error('内容已变化，请重新预览。');
      $('#import-commit').disabled = true;
      try {await api('admin/import', 'POST', {...payload, commit: true, preview_token: token}); await refresh(); await adminDialog(); notify('导入成功');}
      catch (error) {$('#import-commit').disabled = false; throw error;}
    });
  });
}

$('#modal-close').onclick = closeModal;
$('#modal').addEventListener('cancel', () => {modalMap?.destroy(); modalMap = null; modalGeneration++;});
$('#gate-login').onclick = () => authDialog('login');
bindForm('#unlock-form', async data => {await api('unlock', 'POST', data); await boot();});
document.querySelectorAll('[data-scope]').forEach(button => button.onclick = () => setScope(button.dataset.scope));
// A date picker opened from the peeking sheet would fall off the bottom of the screen.
$('#range').addEventListener('click', event => {if (event.target.closest('[data-end]') && sheet.detent !== 'full') sheet.snap('full');}, true);
$('#search').addEventListener('input', event => {state.search = event.target.value; renderSheet();});
$('#fit-all').onclick = () => {map?.fit(); $('#fit-all').hidden = true;};
$('#region-close').onclick = () => state.view.type === 'member' ? leaveMember() : state.view.type === 'update' ? leaveUpdate() : goHome();
$('#range-chip').onclick = () => {goHome(); $('#range').scrollIntoView({block: 'nearest'});};
$('#me-btn').onclick = () => state.boot.me ? run(openUpdate) : authDialog('login');
// Keep the save bar above the on-screen keyboard (visual viewport shrinks, layout viewport does not).
visualViewport?.addEventListener('resize', () => document.documentElement.style.setProperty('--kb', `${Math.max(0, innerHeight - visualViewport.height - visualViewport.offsetTop)}px`));
$('#list').addEventListener('click', event => {
  const row = event.target.closest('[data-member]');
  if (row) {run(() => memberDialog(Number(row.dataset.member))); return;}
  if (event.target.closest('[data-more]')) sheet.snap('full');
  if (event.target.closest('#expand-range')) rangeControl.set(presetRange('all', state.boot.today, state.earliest), 'all');
});
run(boot);
