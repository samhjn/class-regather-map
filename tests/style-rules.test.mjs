import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const css = readFileSync('gathering/static/gathering/style.css', 'utf8');

test('every backdrop-filter has the -webkit- form iOS Safari before 18 needs', () => {
  const plain = css.match(/(?<!-webkit-)backdrop-filter:\s*[^;]+;/g) || [];
  for (const rule of plain) assert.ok(css.includes('-webkit-' + rule), `missing -webkit- twin for: ${rule}`);
});
