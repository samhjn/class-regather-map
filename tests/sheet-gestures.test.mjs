import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

// Pointer sequences against the real sheet: timestamps and pointer ids are set by hand,
// because what matters is when the finger stopped and which finger lifted.
const {window} = new JSDOM('<!doctype html><section id="sheet"><button class="grab" data-drag type="button"></button><div id="head" data-drag><b id="title">17 位同学</b></div><div id="body"></div></section>');
Object.assign(globalThis, {window, document: window.document,
  addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window),
  matchMedia: () => ({matches: false}),
  getComputedStyle: el => ({transform: el.style.transform}),
  DOMMatrixReadOnly: class {constructor(transform) {this.m42 = Number(/translateY\((-?[\d.]+)px\)/.exec(transform)?.[1] || 0);}}});
const {createSheet} = await import('../gathering/static/gathering/sheet.js');

const stops = {peek: 100, half: 400, full: 800};
function setup() {
  const el = document.querySelector('#sheet');
  Object.defineProperty(el, 'offsetHeight', {value: 800, configurable: true});
  const sheet = createSheet(el, {stops: () => stops, openTo: () => 'half'});
  sheet.snap('peek', false);
  const fire = (type, {id = 1, y, t, target = document.querySelector('#title')}) => {
    const event = new window.MouseEvent(type, {bubbles: true, clientY: y, button: 0});
    Object.defineProperty(event, 'pointerId', {value: id});
    Object.defineProperty(event, 'timeStamp', {value: t});
    target.dispatchEvent(event);
  };
  return {sheet, fire};
}

test('a drag whose finger stopped before lifting settles by position, not by the earlier speed', () => {
  const {sheet, fire} = setup();
  fire('pointerdown', {y: 700, t: 0});
  fire('pointermove', {y: 690, t: 10});                   // past the threshold: now a drag
  for (let i = 1; i <= 9; i++) fire('pointermove', {y: 690 - i * 30, t: 10 + i * 10});  // quick upward pull to 420
  fire('pointerup', {y: 420, t: 1200});                    // held still for a second, then lifted
  assert.equal(sheet.detent, 'half');                      // 100 + 270 = 370 sits nearest half
});

test('a cancelled press (the system took the touch) neither opens nor folds the sheet', () => {
  const {sheet, fire} = setup();
  fire('pointerdown', {y: 700, t: 0});
  fire('pointercancel', {y: 700, t: 50});
  assert.equal(sheet.detent, 'peek');
});

test('a second finger tapping the bar does not hijack or end the first finger\'s drag', () => {
  const {sheet, fire} = setup();
  fire('pointerdown', {id: 1, y: 700, t: 0});
  fire('pointermove', {id: 1, y: 690, t: 10});
  fire('pointermove', {id: 1, y: 600, t: 20});
  fire('pointerdown', {id: 2, y: 650, t: 30});
  fire('pointerup', {id: 2, y: 650, t: 40});              // a tap by the second finger
  fire('pointermove', {id: 1, y: 150, t: 400});           // the first finger keeps pulling (slowly)
  fire('pointermove', {id: 1, y: 140, t: 800});
  assert.equal(sheet.height, 650);                         // still following the first finger: 100 + (690 - 140)
  fire('pointerup', {id: 1, y: 140, t: 1300});
  assert.equal(sheet.detent, 'full');
});
