import test from 'node:test';
import assert from 'node:assert/strict';
import {prefectureCode} from '../gathering/static/gathering/logic.js';

test('a located district resolves to its prefecture; province-run county-level cities stay themselves', () => {
  assert.equal(prefectureCode('330106'), '330100');   // 杭州 西湖区 → 杭州
  assert.equal(prefectureCode('429004'), '429004');   // 仙桃
  assert.equal(prefectureCode('419001'), '419001');   // 济源
  assert.equal(prefectureCode('469001'), '469001');   // 五指山
});

