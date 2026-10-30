import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';

// Spec: no native <select> / date / time / month / color controls anywhere in the UI.
// Scans every front-end source recursively so new files are covered automatically.
const roots = ['gathering/static/gathering', 'gathering/templates'];
const files = dir => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : /\.(js|mjs|html)$/.test(name) ? [path] : [];
});
// Comment lines are stripped first: commenting a control out must not count as removing
// it, and prose about the rule (like this file's) must not trip it either.
const code = text => text.split('\n').filter(line => !/^\s*(\/\/|\/?\*|<!--|\{#)/.test(line)).join('\n');
const banned = [/<select\b/i, /type\s*=\s*["']?(date|time|month|week|datetime-local|color)\b/i];

test('front-end sources contain no native select or date-like inputs', () => {
  const offenders = [];
  for (const file of roots.flatMap(files)) {
    const text = code(readFileSync(file, 'utf8'));
    for (const pattern of banned) if (pattern.test(text)) offenders.push(`${file}: ${pattern}`);
  }
  assert.deepEqual(offenders, []);
});
