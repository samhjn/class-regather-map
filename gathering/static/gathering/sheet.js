// Bottom sheet with three detents (spec 5.1–5.3). Tracks the finger 1:1, projects
// momentum on release (apple-design §6) and rubber-bands past the ends.

const DECELERATION = 0.998;
export const project = velocity => velocity / 1000 * DECELERATION / (1 - DECELERATION);

export function nearestStop(height, stops) {
  return Object.entries(stops).reduce((best, [name, value]) => Math.abs(value - height) < Math.abs(stops[best] - height) ? name : best, 'peek');
}

export function rubberband(overshoot, dimension, constant = 0.55) {
  return overshoot * dimension * constant / (dimension + constant * Math.abs(overshoot));
}

const THRESHOLD = 6;  // px of vertical travel before a press becomes a drag

export function createSheet(el, {stops, onChange = () => {}, openTo = () => 'half'}) {
  let detent = 'peek', height = 0, drag = null;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const apply = (value, animate) => {
    height = value;
    el.style.transition = animate && !reduceMotion.matches ? 'transform 340ms cubic-bezier(.22,1,.36,1)' : 'none';
    el.style.transform = `translateY(${el.offsetHeight - value}px)`;
  };
  const currentHeight = () => el.offsetHeight - new DOMMatrixReadOnly(getComputedStyle(el).transform).m42;

  function snap(name, animate = true) {
    detent = name;
    el.dataset.detent = name;
    el.querySelector('.grab')?.setAttribute('aria-expanded', String(name !== 'peek'));
    const value = stops()[name];
    apply(value, animate);
    onChange(name, value);
  }

  // Moves are read on window: once the finger leaves the handle, pointermove would
  // otherwise land on the map. Capture starts only when the press becomes a drag, so
  // taps on buttons inside the sheet still click.
  const move = event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dy = drag.startY - event.clientY;
    if (!drag.active) {
      if (Math.abs(dy) < THRESHOLD) return;
      drag.active = true;
      el.setPointerCapture?.(event.pointerId);
      drag.startY = event.clientY; drag.startHeight = currentHeight();
      return;
    }
    const {peek, full} = stops();
    let next = drag.startHeight + dy;
    if (next > full) next = full + rubberband(next - full, full);
    if (next < peek) next = peek - rubberband(peek - next, full);
    apply(next, false);
    drag.samples.push({t: event.timeStamp, y: event.clientY});
    if (drag.samples.length > 5) drag.samples.shift();
  };
  const release = event => {
    if (!drag || event.pointerId !== drag.id) return;
    const {active, samples, target: drag_target} = drag;
    drag = null;
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', release);
    removeEventListener('pointercancel', release);
    if (!active) {
      // A plain tap on the bar (not on a control in it) opens it, or folds it back.
      if (drag_target?.closest('[data-drag]') && !drag_target.closest('button, a, input, label, .picker')) snap(detent === 'peek' ? openTo() : 'peek');
      return;
    }
    el.dataset.justDragged = '1';
    setTimeout(() => delete el.dataset.justDragged, 0);
    // Only motion in the last 100 ms counts: a finger that stopped before lifting has no flick.
    const last = samples.at(-1), recent = samples.filter(sample => last && sample.t >= last.t - 100), first = recent[0];
    const velocity = first && last.t > first.t ? (first.y - last.y) / (last.t - first.t) * 1000 : 0;
    snap(nearestStop(height + project(velocity), stops()));
  };
  el.addEventListener('pointerdown', event => {
    if (event.button > 0) return;
    // In full the body scrolls, so only the handle and header start a drag.
    if (detent === 'full' && !event.target.closest('[data-drag]')) return;
    drag = {id: event.pointerId, target: event.target, startY: event.clientY, startHeight: currentHeight(), active: false, samples: []};
    addEventListener('pointermove', move);
    addEventListener('pointerup', release);
    addEventListener('pointercancel', release);
  });
  // The handle is a real button: a tap or Enter/Space toggles (a drag never reaches here).
  el.querySelector('.grab')?.addEventListener('click', () => snap(detent === 'peek' ? openTo() : 'peek'));
  // A drag that started on a button must not also click it.
  el.addEventListener('click', event => {if (el.dataset.justDragged) {event.stopPropagation(); event.preventDefault();}}, true);
  addEventListener('resize', () => snap(detent, false));

  return {snap, get detent() {return detent;}, get height() {return height;}};
}
