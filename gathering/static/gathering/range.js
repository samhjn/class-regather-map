import {PRESET_LABELS, batchName, batchRange, presetRange} from './filter.js';

// Confirmation recency has only three choices; stay dates are edited elsewhere.
// A fourth choice — the last big round of updates — appears only when 近三年 is nearly empty.
export function mountRange(el, {today, preset, batch = null, onChange}) {
  const labels = Object.entries(PRESET_LABELS);
  if (batch) labels.splice(2, 0, ['batch', batchName(batch)]);
  const set = nextPreset => {
    const range = nextPreset === 'batch' ? batchRange(batch, today) : presetRange(nextPreset, today);
    preset = nextPreset;
    draw(); onChange(range, preset);
  };
  function draw() {
    el.innerHTML = `<div class="filter-label">位置确认时间</div><div class="chips${batch ? ' four' : ''}" role="group" aria-label="位置确认时间">${labels.map(([key, label]) =>
      `<button type="button" data-preset="${key}" aria-pressed="${preset === key}" class="${preset === key ? 'on' : ''}">${label}</button>`).join('')}</div>`;
    el.querySelectorAll('[data-preset]').forEach(button => button.onclick = () => set(button.dataset.preset));
  }
  draw();
  return {set};
}
