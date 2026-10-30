import {monthPicker} from './pickers.js';
import {presetRange} from './filter.js';

// Confirmed-time range control (spec 5.1): from/to fields, a two-handle slider on a
// real-time scale, and 1y / 3y / all presets. Month indexes are year*12 + month-1.

export const tickPercent = (month, earliest, now) => now === earliest ? 100 : Math.round((month - earliest) / (now - earliest) * 1000) / 10;
// The axis spans the data, the current selection and at least the 3-year preset, so no
// handle can sit off the track.
export const axisStart = (firstData, now, rangeFrom) => Math.min(firstData, rangeFrom, now - 36);
export const monthLabel = month => `${Math.floor(month / 12)}.${String(month % 12 + 1).padStart(2, '0')}`;

const PRESETS = [['1y', '近 1 年'], ['3y', '近 3 年'], ['all', '全部']];

export function mountRange(el, {today, earliest, range, preset, onChange}) {
  const now = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1;
  const first = Number(earliest.slice(0, 4)) * 12 + Number(earliest.slice(5, 7)) - 1;
  const start = axisStart(Math.min(first, now), now, range.from);
  const toValue = () => range.to === null ? now : range.to;
  const set = (next, nextPreset = null) => {
    range = next; preset = nextPreset;
    draw(); onChange(range, preset);
  };

  function draw() {
    const from = tickPercent(range.from, start, now), to = tickPercent(toValue(), start, now);
    const years = [];
    const step = Math.max(1, Math.ceil((now - start) / 12 / 4));
    for (let y = Math.ceil(start / 12); y * 12 <= now - 6; y += step) years.push(y);
    el.innerHTML = `<div class="fields">
        <button type="button" class="f" data-end="from" aria-expanded="false"><small>从</small><b>${monthLabel(range.from)}</b></button>
        <span class="dash" aria-hidden="true">—</span>
        <button type="button" class="f" data-end="to" aria-expanded="false"><small>到</small><b>${range.to === null ? '今天' : monthLabel(range.to)}</b></button></div>
      <div class="rng"><div class="t"></div><div class="fl" style="left:${from}%;right:${100 - to}%"></div>
        <div class="k" data-handle="from" style="left:${from}%" role="slider" tabindex="0" aria-label="开始月份" aria-valuetext="${monthLabel(range.from)}"><i></i></div>
        <div class="k" data-handle="to" style="left:${to}%" role="slider" tabindex="0" aria-label="结束月份" aria-valuetext="${range.to === null ? '今天' : monthLabel(range.to)}"><i></i></div></div>
      <div class="ticks">${years.map(y => `<span style="left:${tickPercent(y * 12, start, now)}%">${y}</span>`).join('')}<span style="left:100%" class="now">今天</span></div>
      <div class="chips">${PRESETS.map(([key, label]) => `<button type="button" data-preset="${key}" class="${preset === key ? 'on' : ''}">${label}</button>`).join('')}</div>`;
    el.querySelectorAll('[data-preset]').forEach(button => button.onclick = () => set(presetRange(button.dataset.preset, today, earliest), button.dataset.preset));
    el.querySelector('[data-end=from]').onclick = event => monthPicker(event.currentTarget.closest('.fields'), {
      value: range.from, min: start, max: toValue(), onPick: month => set({...range, from: month})});
    el.querySelector('[data-end=to]').onclick = event => monthPicker(event.currentTarget.closest('.fields'), {
      value: toValue(), min: range.from, max: now, onPick: month => set({...range, to: month === now ? null : month})});
    el.querySelectorAll('.k').forEach(handle => handle.addEventListener('pointerdown', grab));
  }

  function grab(event) {
    const handle = event.currentTarget, track = el.querySelector('.rng').getBoundingClientRect(), end = handle.dataset.handle;
    event.preventDefault(); event.stopPropagation();
    handle.setPointerCapture(event.pointerId);
    handle.parentElement.append(handle);  // the handle being dragged stays on top
    const move = moveEvent => {
      const ratio = Math.min(1, Math.max(0, (moveEvent.clientX - track.left) / track.width));
      let month = Math.round(start + ratio * (now - start));
      if (end === 'from') month = Math.min(month, toValue()); else month = Math.max(month, range.from);
      const next = end === 'from' ? {...range, from: month} : {...range, to: month >= now ? null : month};
      if (next.from === range.from && next.to === range.to) return;
      range = next; preset = null;
      const percent = tickPercent(end === 'from' ? range.from : toValue(), start, now);
      handle.style.left = percent + '%';
      el.querySelector('.fl').style[end === 'from' ? 'left' : 'right'] = (end === 'from' ? percent : 100 - percent) + '%';
      el.querySelector(`[data-end=${end}] b`).textContent = end === 'to' && range.to === null ? '今天' : monthLabel(end === 'from' ? range.from : range.to);
      el.querySelectorAll('[data-preset]').forEach(button => button.classList.remove('on'));
    };
    const up = () => {handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); set(range, null);};
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  draw();
  return {set};
}
