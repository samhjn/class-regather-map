import {PRESET_LABELS, presetRange} from './filter.js';

// Confirmation recency has only three choices; stay dates are edited elsewhere.
export function mountRange(el, {today, preset, onChange}) {
  const set = nextPreset => {
    const range = presetRange(nextPreset, today);
    preset = nextPreset;
    draw(); onChange(range, preset);
  };
  function draw() {
    el.innerHTML = `<div class="filter-label">位置确认时间</div><div class="chips" role="group" aria-label="位置确认时间">${Object.entries(PRESET_LABELS).map(([key, label]) =>
      `<button type="button" data-preset="${key}" aria-pressed="${preset === key}" class="${preset === key ? 'on' : ''}">${label}</button>`).join('')}</div>`;
    el.querySelectorAll('[data-preset]').forEach(button => button.onclick = () => set(button.dataset.preset));
  }
  draw();
  return {set};
}
