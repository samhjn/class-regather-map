// Inline popovers that replace native date controls (no <select>, no <input type=date>).
// They open below their anchor inside the form flow, styled by .picker in style.css.

const pad = n => String(n).padStart(2, '0');

function popover(anchor, render) {
  close();
  const box = document.createElement('div');
  box.className = 'picker';
  box.setAttribute('role', 'dialog');
  anchor.after(box);
  anchor.setAttribute('aria-expanded', 'true');
  render(box);
  box.scrollIntoView?.({block: 'nearest'});
  const outside = event => {if (!box.contains(event.target) && !anchor.contains(event.target)) close();};
  setTimeout(() => document.addEventListener('pointerdown', outside), 0);
  current = {box, anchor, outside};
  return box;
}
let current = null;
export function close() {
  if (!current) return;
  current.box.remove();
  current.anchor.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', current.outside);
  current = null;
}

// value/min/max are month indexes (year*12 + month-1).
export function monthPicker(anchor, {value, min, max, onPick}) {
  let year = Math.floor(value / 12);
  popover(anchor, function draw(box) {
    const years = [];
    for (let y = Math.floor(min / 12); y <= Math.floor(max / 12); y++) years.push(y);
    box.innerHTML = `<div class="years">${years.map(y => `<button type="button" data-year="${y}" class="${y === year ? 'on' : ''}">${y}</button>`).join('')}</div>
      <div class="months">${Array.from({length: 12}, (_, i) => {
        const index = year * 12 + i;
        return `<button type="button" data-month="${i + 1}" class="${index === value ? 'on' : ''}" ${index < min || index > max ? 'disabled' : ''}>${i + 1}月</button>`;
      }).join('')}</div>`;
    box.querySelector('.years [class="on"]')?.scrollIntoView({inline: 'center', block: 'nearest'});
    box.querySelectorAll('[data-year]').forEach(button => button.onclick = () => {year = Number(button.dataset.year); draw(box);});
    box.querySelectorAll('[data-month]').forEach(button => button.onclick = () => {close(); onPick(year * 12 + Number(button.dataset.month) - 1);});
  });
}

// value/min/max are 'YYYY-MM-DD'; first a month, then a 7-column day grid.
export function dayPicker(anchor, {value, min, max, onPick}) {
  const index = iso => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;
  const pickDay = month => popover(anchor, box => {
    const y = Math.floor(month / 12), m = month % 12 + 1;
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    box.innerHTML = `<div class="picker-head"><button type="button" data-back>‹ ${y}.${pad(m)}</button></div><div class="days">${
      '日一二三四五六'.split('').map(d => `<span>${d}</span>`).join('')}${'<span></span>'.repeat(lead)}${
      Array.from({length: days}, (_, i) => {
        const iso = `${y}-${pad(m)}-${pad(i + 1)}`;
        return `<button type="button" data-day="${iso}" class="${iso === value ? 'on' : ''}" ${iso < min || iso > max ? 'disabled' : ''}>${i + 1}</button>`;
      }).join('')}</div>`;
    box.querySelector('[data-back]').onclick = () => monthPicker(anchor, {value: month, min: index(min), max: index(max), onPick: pickDay});
    box.querySelectorAll('[data-day]').forEach(button => button.onclick = () => {close(); onPick(button.dataset.day);});
  });
  monthPicker(anchor, {value: index(value || max), min: index(min), max: index(max), onPick: pickDay});
}
