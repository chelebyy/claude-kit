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

test('puan: notlandırma varsa oranı, notlandırma yoksa geçti/kaldı; ölçülmeyen deneme puansız', () => {
  assert.strictEqual(scoreOf({ id: 'a', run: 2, pass: false }, { 'a#2': { score: 3, max: 4 } }), 0.75);
  assert.strictEqual(scoreOf({ id: 'a', run: 1, pass: true }), 1);
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

const { compatibility } = require('./stats.cjs');

test('kör notlar verildiyse ölçülmüş bir denemenin notu eksikse hata; geçti/kaldı puanına düşmez', () => {
  assert.throws(() => scoreOf({ id: 'a', run: 1, pass: true }, {}), /not eksik: a#1/);
  const ids = ['t1', 't2', 't3', 't4', 't5'];
  const A = ids.flatMap(id => runs(id, [true])), B = ids.flatMap(id => runs(id, [true]));
  const gradesB = Object.fromEntries(ids.map(id => [id + '#1', { score: 1, max: 2 }]));
  assert.throws(() => pairedCompare(A, B, { gradesA: { 't1#1': { score: 1, max: 2 } }, gradesB }), /not eksik/);
});

test('geride kalmama payı: 20 puan geride kalan aday geçmez; eşit aday geçer', () => {
  const ids = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'];
  const B = ids.flatMap(id => runs(id, [true, true, true]));
  const A = ids.flatMap((id, i) => runs(id, i < 2 ? [false, false, false] : [true, true, true]));
  const worse = pairedCompare(A, B, { seed: 1 });
  assert.strictEqual(worse.meanDiff, -0.2);
  assert.strictEqual(worse.withinMargin, false, JSON.stringify(worse));
  const same = pairedCompare(B, B, { seed: 1 });
  assert.strictEqual(same.withinMargin, true);
});

test('geride kalmama: 3 görevden az ya da dışarıda kalan görev varsa kanıt sayılmaz', () => {
  const two = ['a', 'b'].flatMap(id => runs(id, [true]));
  assert.strictEqual(pairedCompare(two, two, { seed: 1 }).withinMargin, false);
  const A = ['a', 'b', 'c', 'd'].flatMap(id => runs(id, [true]));
  const B = [...['a', 'b', 'c'].flatMap(id => runs(id, [true])), ...runs('d', [null])];
  const c = pairedCompare(A, B, { seed: 1 });
  assert.deepStrictEqual(c.excluded, ['d']);
  assert.strictEqual(c.withinMargin, false);
});

test('karşılaştırılabilirlik: farklı bölüm, tekrar sayısı ya da görev sürümü reddedilir', () => {
  const s = (over = {}) => ({ model: 'm', split: 'frozen', repeats: 3, taskVersions: { a: { split: 'frozen', version: 1 } }, tasks: runs('a', [true, true, true]), ...over });
  assert.doesNotThrow(() => compatibility(s(), s()));
  assert.throws(() => compatibility(s(), s({ split: 'dev' })), /bölümler farklı/);
  assert.throws(() => compatibility(s(), s({ repeats: 5 })), /tekrar sayıları farklı/);
  assert.throws(() => compatibility(s(), s({ taskVersions: { a: { split: 'frozen', version: 2 } } })), /sürümleri farklı/);
  assert.throws(() => compatibility(s(), s({ taskVersions: {} })), /taskVersions'ta yok/);
});

test('karşılaştırılabilirlik: aynı deneme iki kez ya da tekrar sayısını aşan deneme reddedilir', () => {
  const base = { model: 'm', split: 'frozen', repeats: 3, taskVersions: { a: { split: 'frozen', version: 1 } } };
  const good = { ...base, tasks: runs('a', [true, true, true]) };
  assert.throws(() => compatibility(good, { ...base, tasks: [...runs('a', [true, true]), { id: 'a', run: 2, pass: true }] }), /iki kez/);
  assert.throws(() => compatibility(good, { ...base, tasks: runs('a', [true, true, true, true, true]) }), /aşıyor/);
});

const { approvalCheck } = require('./stats.cjs');

function frozenSummary(model, ids, passFor, over = {}) {
  return {
    model, effort: 'high', split: 'frozen', repeats: 3,
    taskVersions: Object.fromEntries(ids.map(id => [id, { split: 'frozen', version: 1 }])),
    tasks: ids.flatMap(id => runs(id, [1, 2, 3].map(k => passFor(id, k)))),
    ...over,
  };
}
const REG = { codex: { 'gpt-base': { status: 'approved', role: 'frontier', efforts: ['high'] } }, claude: {} };
const OK = { role: 'frontier', registry: REG };
const EXP = { t1: { split: 'frozen', version: 1 }, t2: { split: 'frozen', version: 1 }, t3: { split: 'frozen', version: 1 }, t4: { split: 'frozen', version: 1 } };
const IDS = Object.keys(EXP);

test('onay: kilitli setin tamamı, 3 tam tekrar ve eşit sonuç geçer', () => {
  const a = frozenSummary('a', IDS, () => true), b = frozenSummary('gpt-base', IDS, () => true);
  const r = approvalCheck(a, b, EXP, OK);
  assert.strictEqual(r.blockers.length, 0, JSON.stringify(r.blockers));
});

test('onay: yarım kalmış çalıştırma (eksik görev ya da eksik deneme) geçmez', () => {
  const b = frozenSummary('gpt-base', IDS, () => true);
  const partial = frozenSummary('a', IDS.slice(0, 3), () => true);
  assert.strictEqual(approvalCheck(partial, b, EXP).blockers.length > 0, true);
  const fewRuns = { ...frozenSummary('a', IDS, () => true) };
  fewRuns.tasks = fewRuns.tasks.filter(r => r.run === 1);
  const r = approvalCheck(fewRuns, b, EXP);
  assert.strictEqual(r.blockers.length > 0, true);
  assert.ok(r.blockers.some(x => /denemeleri/.test(x)), JSON.stringify(r.blockers));
});

test('onay: ölçülmemiş deneme, dev bölümü, 1 tekrar ya da sürümsüz özet geçmez', () => {
  const b = frozenSummary('gpt-base', IDS, () => true);
  assert.strictEqual(approvalCheck(frozenSummary('a', IDS, (id, k) => (k === 2 ? null : true)), b, EXP).blockers.length > 0, true);
  assert.strictEqual(approvalCheck(frozenSummary('a', IDS, () => true, { split: 'dev' }), b, EXP).blockers.length > 0, true);
  assert.strictEqual(approvalCheck(frozenSummary('a', IDS, () => true, { repeats: 1 }), b, EXP).blockers.length > 0, true);
  const nov = frozenSummary('a', IDS, () => true); delete nov.taskVersions;
  const nov2 = frozenSummary('gpt-base', IDS, () => true); delete nov2.taskVersions;
  assert.strictEqual(approvalCheck(nov, nov2, EXP).blockers.length > 0, true);
});

test('onay: depodakinden farklı görev sürümü ya da sette olmayan görev geçmez', () => {
  const b = frozenSummary('gpt-base', IDS, () => true);
  const a = frozenSummary('a', IDS, () => true);
  assert.strictEqual(approvalCheck(a, b, { ...EXP, t1: { split: 'frozen', version: 2 } }).blockers.length > 0, true);
  const extra = frozenSummary('a', [...IDS, 't5'], () => true);
  assert.strictEqual(approvalCheck(extra, b, EXP).blockers.length > 0, true);
});

test('onay: pay sabittir; belirgin geride kalan aday geçmez (keşif payı ne olursa olsun)', () => {
  const b = frozenSummary('gpt-base', IDS, () => true);
  const a = frozenSummary('a', IDS, id => id === 't1' || id === 't2' ? false : true);
  const r = approvalCheck(a, b, EXP, { ...OK, margin: 1 });
  assert.strictEqual(r.blockers.length > 0, true);
  assert.ok(r.blockers.some(x => /alt ucu/.test(x)), JSON.stringify(r.blockers));
});

test('onay: tekrar edilen zaman aşımları bilgi olarak sayılır', () => {
  const a = frozenSummary('a', IDS, () => true);
  a.tasks[0].timeoutRetries = [{ pass: null }];
  assert.deepStrictEqual(approvalCheck(a, frozenSummary('gpt-base', IDS, () => true), EXP).timeoutRetries, { A: 1, B: 0 });
});

test('onay: mevcut model kayıtta o rolle onaylı olmalı; rol verilmemiş, aynı model ya da onaysız taban geçmez', () => {
  const a = frozenSummary('a', IDS, () => true), b = frozenSummary('gpt-base', IDS, () => true);
  assert.strictEqual(approvalCheck(a, b, EXP, OK).blockers.length === 0, true);
  assert.ok(approvalCheck(a, b, EXP, { registry: REG }).blockers.some(x => /rol verilmedi/.test(x)));
  assert.ok(approvalCheck(b, b, EXP, OK).blockers.some(x => /aynı model/.test(x)));
  assert.ok(approvalCheck(a, frozenSummary('weak', IDS, () => true), EXP, OK).blockers.some(x => /kayıtta yok/.test(x)));
  assert.ok(approvalCheck(a, b, EXP, { role: 'fast', registry: REG }).blockers.some(x => /onaylı değil/.test(x)));
  assert.ok(approvalCheck(a, { ...b, effort: 'low' }, EXP, OK).blockers.some(x => /efforts/.test(x)));
  assert.ok(approvalCheck(a, b, EXP, { role: 'frontier', registry: null }).blockers.some(x => /okunamadı/.test(x)));
});

test('karşılaştırılabilirlik ve onay: A ile B aynı eforla ölçülmüş olmalı', () => {
  const s = e => ({ model: 'm', effort: e, split: 'frozen', repeats: 3, taskVersions: { a: { split: 'frozen', version: 1 } }, tasks: runs('a', [true, true, true]) });
  assert.throws(() => compatibility(s('high'), s('max')), /eforlar farklı/);
  const a = frozenSummary('a', IDS, () => true, { effort: 'max' });
  assert.ok(approvalCheck(a, frozenSummary('gpt-base', IDS, () => true), EXP, OK).blockers.some(x => /efor/.test(x)));
});

test('onay: rubrik maddeleri (claims) olan görevlerde kör notlar zorunlu; yeniden ölçülmüş deneme kanıt sayılmaz', () => {
  const exp = { ...EXP, t1: { split: 'frozen', version: 1, claims: true } };
  const a = frozenSummary('a', IDS, () => true), b = frozenSummary('gpt-base', IDS, () => true);
  assert.ok(approvalCheck(a, b, exp, OK).blockers.some(x => /kör not/.test(x)));
  const full = s => Object.fromEntries(s.tasks.map(r => [`${r.id}#${r.run}`, { score: 1, max: 1 }]));
  assert.strictEqual(approvalCheck(a, b, exp, { ...OK, gradesA: full(a), gradesB: full(b), gradesVerified: true }).blockers.length, 0);
  const re = frozenSummary('a', IDS, () => true);
  re.tasks[0].previousAttempts = [{ id: 't1', run: 1, pass: false }];
  assert.ok(approvalCheck(re, b, EXP, OK).blockers.some(x => /yeniden ölçülmüş/.test(x)));
});

test('onay çıktısı yeterlilik iddia etmez: elle doğrulanacak adımları listeler', () => {
  const r = approvalCheck(frozenSummary('a', IDS, () => true), frozenSummary('gpt-base', IDS, () => true), EXP, OK);
  assert.strictEqual('passes' in r, false);
  assert.ok(Array.isArray(r.attest) && r.attest.length >= 3);
});

// --- Son inceleme bulguları (2026-11-27, 3. tur) ---
const statsMod = require('./stats.cjs');
const fsx = require('fs'), osx = require('os'), pathx = require('path');

test('onay: kayıtlı kural ihlali (salt okunur, korunan dosya, bağlantı) puandan bağımsız engeldir', () => {
  for (const v of [{ readOnlyOk: false }, { protectedOk: false }, { linksLeft: true }]) {
    const a = frozenSummary('a', IDS, () => true);
    Object.assign(a.tasks[0], v, { pass: false });
    assert.ok(approvalCheck(a, frozenSummary('gpt-base', IDS, () => true), EXP, OK).blockers.some(x => /kural ihlali/.test(x)), JSON.stringify(v));
  }
});

test('rol eşleşmesi: Claude rol metninde yalnızca rol adları sayılır, parantez içi ve bağlaçlar sayılmaz', () => {
  assert.deepStrictEqual(statsMod.roleNames('main and reviewer (alias opus)'), ['main', 'reviewer']);
  assert.deepStrictEqual(statsMod.roleNames('frontier'), ['frontier']);
  const reg = { codex: {}, claude: { 'claude-x': { status: 'approved', role: 'main and reviewer (alias opus)' } } };
  const a = { model: 'claude-y', effort: 'high' }, b = { model: 'claude-x', effort: 'high' };
  assert.strictEqual(statsMod.baselineProblem(a, b, 'reviewer', reg), null);
  for (const bad of ['alias', 'opus', 'and']) assert.match(statsMod.baselineProblem(a, b, bad, reg), /onaylı değil/);
});

test('onay: tekrar edilen zaman aşımları önceki denemelerdekileri de sayar', () => {
  const a = frozenSummary('a', IDS, () => true);
  a.tasks[0].previousAttempts = [{ pass: null, timeoutRetries: [{}] }];
  a.tasks[1].timeoutRetries = [{}];
  assert.strictEqual(approvalCheck(a, frozenSummary('gpt-base', IDS, () => true), EXP, OK).timeoutRetries.A, 2);
});

function gradedDir(root, name, secret, mutate) {
  const dir = pathx.join(root, name);
  fsx.mkdirSync(dir, { recursive: true });
  fsx.writeFileSync(pathx.join(dir, 't1.md'), 'answer');
  const sha = require('crypto').createHash('sha256').update(Buffer.from('answer')).digest('hex');
  const grades = { 't1#1': { score: 1, max: 2, sha256: sha } };
  const file = { version: 1, dir: name, label: 'opus', grades, mac: statsMod.gradesMac(secret, name, 'opus', grades) };
  if (mutate) mutate(file, dir);
  fsx.writeFileSync(pathx.join(dir, 'grades-opus.json'), JSON.stringify(file));
  return dir;
}

test('kör notlar doğrulanır: anahtardaki gizli değerle imzalı ve cevabın içerik özetine bağlı olmalı', () => {
  const root = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'model-eval-grades-'));
  const secret = 'a'.repeat(64);
  try {
    const ok = gradedDir(root, 'r-ok', secret);
    assert.deepStrictEqual(statsMod.readGrades(ok, 'opus', { secret, resultsRoot: root }).grades, { 't1#1': { score: 1, max: 2, sha256: require('crypto').createHash('sha256').update('answer').digest('hex') } });
    assert.strictEqual(statsMod.readGrades(ok, 'opus', { secret, resultsRoot: root }).verified, true);
    const forged = gradedDir(root, 'r-forged', secret, f => { f.grades['t1#1'].score = 2; });
    assert.throws(() => statsMod.readGrades(forged, 'opus', { secret, resultsRoot: root }), /imza/);
    const wrongKey = gradedDir(root, 'r-wrong', 'b'.repeat(64));
    assert.throws(() => statsMod.readGrades(wrongKey, 'opus', { secret, resultsRoot: root }), /imza/);
    const moved = gradedDir(root, 'r-moved', secret, f => { f.dir = 'r-other'; f.mac = statsMod.gradesMac(secret, 'r-other', 'opus', f.grades); });
    assert.throws(() => statsMod.readGrades(moved, 'opus', { secret, resultsRoot: root }), /klasör/);
    const stale = gradedDir(root, 'r-stale', secret, (f, dir) => { fsx.writeFileSync(pathx.join(dir, 't1.md'), 'changed later'); });
    assert.throws(() => statsMod.readGrades(stale, 'opus', { secret, resultsRoot: root }), /cevap değişmiş/);
    const unsigned = gradedDir(root, 'r-unsigned', secret);
    assert.strictEqual(statsMod.readGrades(unsigned, 'opus', { resultsRoot: root }).verified, false);
  } finally { fsx.rmSync(root, { recursive: true, force: true }); }
});

test('onay: doğrulanmamış kör notlar engeldir', () => {
  const exp = { ...EXP, t1: { split: 'frozen', version: 1, claims: true } };
  const a = frozenSummary('a', IDS, () => true), b = frozenSummary('gpt-base', IDS, () => true);
  const full = s => Object.fromEntries(s.tasks.map(r => [`${r.id}#${r.run}`, { score: 1, max: 1 }]));
  const r = approvalCheck(a, b, exp, { ...OK, gradesA: full(a), gradesB: full(b), gradesVerified: false });
  assert.ok(r.blockers.some(x => /doğrulanmadı/.test(x)), JSON.stringify(r.blockers));
});
