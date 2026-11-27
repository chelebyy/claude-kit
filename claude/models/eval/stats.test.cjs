'use strict';
// Çalıştırma: node --test claude/models/eval/stats.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const { taskStats, pairedCompare, scoreOf } = require('./stats.cjs');

const runs = (id, passes) => passes.map((p, i) => ({ id, run: i + 1, pass: p }));

test('görev başına oran: ölçülmeyen denemeler paydaya girmez, "her denemede geçti" yalnızca hepsi ölçülüp geçtiyse', () => {
  const s = taskStats([...runs('a', [true, true, true]), ...runs('b', [true, null, true]), ...runs('c', [true, false, true])]);
  assert.deepStrictEqual(s.a, { runs: 3, measured: 3, passed: 3, unmeasured: 0, passRate: 1, allPass: true });
  assert.deepStrictEqual(s.b, { runs: 3, measured: 2, passed: 2, unmeasured: 1, passRate: 1, allPass: false });
  assert.strictEqual(s.c.passRate, 2 / 3);
  assert.strictEqual(s.c.allPass, false);
});

test('hiç ölçülmeyen görevin oranı yoktur (0 sayılmaz)', () => {
  const s = taskStats(runs('a', [null, null]));
  assert.strictEqual(s.a.passRate, null);
  assert.strictEqual(s.a.allPass, false);
});

test('eski özetlerde run alanı yoksa deneme 1 sayılır', () => {
  const s = taskStats([{ id: 'a', pass: true }]);
  assert.strictEqual(s.a.runs, 1);
});

test('puan: notlandırma varsa oranı, yoksa geçti/kaldı; ölçülmeyen deneme puansız', () => {
  assert.strictEqual(scoreOf({ id: 'a', run: 2, pass: false }, { 'a#2': { score: 3, max: 4 } }), 0.75);
  assert.strictEqual(scoreOf({ id: 'a', run: 1, pass: true }, {}), 1);
  assert.strictEqual(scoreOf({ id: 'a', run: 1, pass: false }), 0);
  assert.strictEqual(scoreOf({ id: 'a', run: 1, pass: null }, { 'a#1': { score: 1, max: 1 } }), null);
});

test('geçersiz not reddedilir', () => {
  assert.throws(() => scoreOf({ id: 'a', run: 1, pass: true }, { 'a#1': { score: 5, max: 4 } }), /geçersiz/);
  assert.throws(() => scoreOf({ id: 'a', run: 1, pass: true }, { 'a#1': { score: 1, max: 0 } }), /geçersiz/);
  assert.throws(() => scoreOf({ id: 'a', run: 1, pass: true }, { 'a#1': { score: '1', max: 2 } }), /geçersiz/);
});

test('eşleştirilmiş karşılaştırma görev bazında yapılır; açık farkta aralık sıfırı dışlar', () => {
  const ids = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
  const A = ids.flatMap(id => runs(id, [true, true, true]));
  const B = ids.flatMap(id => runs(id, [false, false, false]));
  const c = pairedCompare(A, B, { seed: 1 });
  assert.strictEqual(c.tasks, 8);
  assert.strictEqual(c.meanDiff, 1);
  assert.ok(c.ci[0] > 0);
  assert.strictEqual(c.verdict, 'A better');
});

test('eşit sonuçlarda karar "açık fark yok"; aralık sıfırı içerir', () => {
  const ids = ['t1', 't2', 't3', 't4', 't5', 't6'];
  const A = [...runs('t1', [true, false, true]), ...runs('t2', [false, true, false]), ...ids.slice(2).flatMap(id => runs(id, [true, true, false]))];
  const B = [...runs('t1', [false, true, false]), ...runs('t2', [true, false, true]), ...ids.slice(2).flatMap(id => runs(id, [true, false, true]))];
  const c = pairedCompare(A, B, { seed: 7 });
  assert.ok(c.ci[0] <= 0 && c.ci[1] >= 0, JSON.stringify(c));
  assert.strictEqual(c.verdict, 'no clear difference');
});

test('aynı tohumla aynı aralık (yeniden üretilebilir)', () => {
  const A = ['x', 'y', 'z', 'w'].flatMap(id => runs(id, [true, false, true]));
  const B = ['x', 'y', 'z', 'w'].flatMap(id => runs(id, [false, false, true]));
  assert.deepStrictEqual(pairedCompare(A, B, { seed: 3 }).ci, pairedCompare(A, B, { seed: 3 }).ci);
});

test('yalnızca iki tarafta da ölçülmüş görevler karşılaştırılır; dışarıda kalanlar listelenir', () => {
  const A = [...runs('a', [true]), ...runs('b', [true]), ...runs('only-a', [true])];
  const B = [...runs('a', [false]), ...runs('b', [null]), ...runs('only-b', [true])];
  const c = pairedCompare(A, B, { seed: 1 });
  assert.strictEqual(c.tasks, 1);
  assert.deepStrictEqual(c.excluded.sort(), ['b', 'only-a', 'only-b']);
});

test('karşılaştırılacak görev yoksa karar verilmez', () => {
  const c = pairedCompare(runs('a', [null]), runs('a', [true]), { seed: 1 });
  assert.strictEqual(c.tasks, 0);
  assert.strictEqual(c.verdict, 'not enough data');
});
