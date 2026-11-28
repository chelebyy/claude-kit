'use strict';
// Çalıştırma: node --test claude/models/eval/blind.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const blind = require('./blind.cjs');

function makeResults(root, name, model, answers) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const tasks = [];
  for (const [id, run, text] of answers) {
    fs.writeFileSync(path.join(dir, run > 1 ? `${id}.run${run}.md` : `${id}.md`), text);
    tasks.push({ id, run, pass: true });
  }
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ model, effort: 'high', repeats: 2, tasks }));
  return dir;
}

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-blind-')); }

test('paketleme: model adı cevaplardan silinir, harfler görev başına karışır, anahtar paketin dışında', () => {
  const root = tmp();
  try {
    const a = makeResults(root, 'r-a', 'gpt-x', [['t1', 1, 'As GPT-X I found a bug'], ['t1', 2, 'run two of gpt-x']]);
    const b = makeResults(root, 'r-b', 'claude-y', [['t1', 1, 'claude-y here'], ['t1', 2, 'nothing']]);
    const out = path.join(root, 'pkg');
    const key = path.join(root, 'key.json');
    blind.pack({ dirs: [a, b], out, key, seed: 5, resultsRoot: root });
    const files = fs.readdirSync(path.join(out, 't1')).sort();
    assert.deepStrictEqual(files, ['A.md', 'B.md', 'C.md', 'D.md']);
    const all = files.map(f => fs.readFileSync(path.join(out, 't1', f), 'utf8')).join('\n');
    assert.ok(!/gpt-x|claude-y/i.test(all), all);
    assert.ok(!fs.readdirSync(out).includes('key.json'));
    const k = JSON.parse(fs.readFileSync(key, 'utf8'));
    assert.strictEqual(Object.keys(k.items).length, 4);
    // Aynı tohum aynı karışım, farklı tohum (çoğunlukla) farklı.
    const out2 = path.join(root, 'pkg2');
    blind.pack({ dirs: [a, b], out: out2, key: path.join(root, 'key2.json'), seed: 5, resultsRoot: root });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'key2.json'), 'utf8')).items, k.items);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('paketleme: anahtar paket klasörünün içine yazılamaz, dolu bir paket klasörü reddedilir', () => {
  const root = tmp();
  try {
    const a = makeResults(root, 'r-a', 'gpt-x', [['t1', 1, 'x']]);
    const out = path.join(root, 'pkg');
    assert.throws(() => blind.pack({ dirs: [a], out, key: path.join(out, 'key.json'), seed: 1, resultsRoot: root }), /anahtar/);
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'x'), '1');
    assert.throws(() => blind.pack({ dirs: [a], out, key: path.join(root, 'k.json'), seed: 1, resultsRoot: root }), /boş/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('paketleme: sonuç kökünün dışındaki klasör ve görev kimliği olmayan dosya adları kabul edilmez', () => {
  const root = tmp();
  const other = tmp();
  try {
    const a = makeResults(other, 'r-a', 'gpt-x', [['t1', 1, 'x']]);
    assert.throws(() => blind.pack({ dirs: [a], out: path.join(root, 'p'), key: path.join(root, 'k.json'), seed: 1, resultsRoot: root }), /sonuç kökü/);
    const b = makeResults(root, 'r-b', 'gpt-x', []);
    fs.writeFileSync(path.join(b, 'summary.json'), JSON.stringify({ model: 'gpt-x', tasks: [{ id: '../evil', run: 1 }] }));
    assert.throws(() => blind.pack({ dirs: [b], out: path.join(root, 'p2'), key: path.join(root, 'k2.json'), seed: 1, resultsRoot: root }), /görev kimliği/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); }
});

test('ölçülmeyen denemeler pakete girmez', () => {
  const root = tmp();
  try {
    const a = makeResults(root, 'r-a', 'gpt-x', [['t1', 1, 'x'], ['t1', 2, 'y']]);
    const s = JSON.parse(fs.readFileSync(path.join(a, 'summary.json'), 'utf8'));
    s.tasks[1].pass = null;
    fs.writeFileSync(path.join(a, 'summary.json'), JSON.stringify(s));
    blind.pack({ dirs: [a], out: path.join(root, 'p'), key: path.join(root, 'k.json'), seed: 1, resultsRoot: root });
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'p', 't1')), ['A.md']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('puanlayıcı uyumu: madde bazında oran ve kappa; ayrışan maddeler listelenir', () => {
  const g1 = { 't1/A': { claims: { c1: true, c2: true, c3: false } }, 't1/B': { claims: { c1: false, c2: true, c3: false } } };
  const g2 = { 't1/A': { claims: { c1: true, c2: false, c3: false } }, 't1/B': { claims: { c1: false, c2: true, c3: false } } };
  const r = blind.agreement(g1, g2);
  assert.strictEqual(r.claims, 6);
  assert.strictEqual(r.agreementRate, 5 / 6);
  assert.ok(r.kappa > 0 && r.kappa < 1);
  assert.deepStrictEqual(r.disagreements, [{ item: 't1/A', claim: 'c2', a: true, b: false }]);
});

test('puanlayıcı uyumu: bir tarafta eksik madde ya da cevap uyumsuzluk olarak sayılır, sessizce düşmez', () => {
  const r = blind.agreement({ 't1/A': { claims: { c1: true } } }, { 't1/A': { claims: {} }, 't1/B': { claims: { c1: true } } });
  assert.deepStrictEqual(r.missing.sort(), ['t1/A:c1', 't1/B']);
});

test('anahtarı açma: notlar deneme kimliğine (görev#deneme) ve sonuç klasörüne döner', () => {
  const root = tmp();
  try {
    const a = makeResults(root, 'r-a', 'gpt-x', [['t1', 1, 'x'], ['t1', 2, 'y']]);
    fs.mkdirSync(path.join(root, 'tasks', 't1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tasks', 't1', 'task.json'), JSON.stringify({ id: 't1', claims: ['c1', 'c2'] }));
    const key = path.join(root, 'key.json');
    blind.pack({ dirs: [a], out: path.join(root, 'p'), key, seed: 2, resultsRoot: root, tasksRoot: path.join(root, 'tasks') });
    const k = JSON.parse(fs.readFileSync(key, 'utf8'));
    const grades = Object.fromEntries(Object.keys(k.items).map(item => [item, { claims: { c1: true, c2: k.items[item].run === 2 } }]));
    const out = blind.unblind(grades, k, { resultsRoot: root, tasksRoot: path.join(root, 'tasks') });
    const strip = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { score: v.score, max: v.max }]));
    assert.deepStrictEqual(strip(out['r-a']), { 't1#1': { score: 1, max: 2 }, 't1#2': { score: 2, max: 2 } });
    assert.ok(Object.values(out['r-a']).every(v => /^[0-9a-f]{64}$/.test(v.sha256)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('anahtarı açma: anahtarda olmayan bir harf reddedilir', () => {
  assert.throws(() => blind.unblind({ 't1/Z': { claims: { c: true } } }, { items: {} }, { resultsRoot: os.tmpdir() }), /anahtarda yok/);
});

// --- İnceleme düzeltmeleri (2026-11-27) ---

test('paketleme: paket klasörüne takma ad (bağlantı) üzerinden verilen anahtar yolu da reddedilir', () => {
  const root = tmp();
  try {
    const a = makeResults(root, 'r-a', 'gpt-x', [['t1', 1, 'x']]);
    const out = path.join(root, 'pkg');
    fs.mkdirSync(out);
    const alias = path.join(root, 'pkg-alias');
    fs.symlinkSync(out, alias, 'junction');
    assert.throws(() => blind.pack({ dirs: [a], out, key: path.join(alias, 'key.json'), seed: 1, resultsRoot: root }), /anahtar/);
    assert.deepStrictEqual(fs.readdirSync(out), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const roots = root => ({ resultsRoot: root, tasksRoot: path.join(root, 'tasks') });
function packed(root, answers, claims) {
  const tasksRoot = path.join(root, 'tasks');
  if (claims) { fs.mkdirSync(path.join(tasksRoot, 't1'), { recursive: true }); fs.writeFileSync(path.join(tasksRoot, 't1', 'task.json'), JSON.stringify({ id: 't1', claims })); }
  const a = makeResults(root, 'r-a', 'gpt-x', answers);
  const key = path.join(root, 'key.json');
  blind.pack({ dirs: [a], out: path.join(root, 'p'), key, seed: 3, resultsRoot: root, tasksRoot });
  return JSON.parse(fs.readFileSync(key, 'utf8'));
}

test('anahtarı açma: eksik bırakılan cevap, rubrikte olmayan madde ve tutarsız madde kümeleri reddedilir', () => {
  const root = tmp();
  try {
    const k = packed(root, [['t1', 1, 'x'], ['t1', 2, 'y']], ['c1', 'c2']);
    const items = Object.keys(k.items);
    const full = Object.fromEntries(items.map(i => [i, { claims: { c1: true, c2: false } }]));
    assert.doesNotThrow(() => blind.unblind(full, k, roots(root)));
    assert.throws(() => blind.unblind({ [items[0]]: full[items[0]] }, k, roots(root)), /not eksik/);
    assert.throws(() => blind.unblind({ ...full, [items[0]]: { claims: { invented: true } } }, k, roots(root)), /rubrik/);
    // Anahtardaki madde listesi kullanılmaz: depodaki task.json'dakiler geçerlidir.
    assert.throws(() => blind.unblind({ ...full, [items[0]]: { claims: { invented: true } } }, { ...k, claims: { t1: ['invented'] } }, roots(root)), /rubrik/);
    // Görevde rubrik maddeleri tanımlı değilse maddeleri puanlayıcı belirleyemez: açma durur.
    fs.rmSync(path.join(root, 'tasks'), { recursive: true });
    const invented = Object.fromEntries(items.map(i => [i, { claims: { invented: true } }]));
    assert.throws(() => blind.unblind(invented, k, roots(root)), /claims listesi yok/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('anahtarı açma: başka klasöre, başka göreve yönlendiren ya da aynı hedefi iki kez veren anahtar reddedilir', () => {
  const root = tmp();
  try {
    const k = packed(root, [['t1', 1, 'x'], ['t1', 2, 'y']], ['c1']);
    const items = Object.keys(k.items);
    const g = Object.fromEntries(items.map(i => [i, { claims: { c1: true } }]));
    const mut = (i, v) => ({ ...k, items: { ...k.items, [items[i]]: { ...k.items[items[i]], ...v } } });
    assert.throws(() => blind.unblind(g, mut(0, { dir: '../x' }), roots(root)), /anahtar girdisi/);
    assert.throws(() => blind.unblind(g, mut(0, { id: 'other-task' }), roots(root)), /anahtar girdisi/);
    assert.throws(() => blind.unblind(g, mut(1, { run: k.items[items[0]].run }), roots(root)), /iki kez/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('notları yazma: özette ölçülmemiş bir denemeye not yazılmaz, eksik not kabul edilmez, hiçbir şey yarım yazılmaz', () => {
  const root = tmp();
  try {
    makeResults(root, 'r-a', 'gpt-x', [['t1', 1, 'x'], ['t1', 2, 'y']]);
    makeResults(root, 'r-b', 'gpt-y', [['t1', 1, 'x']]);
    const S = 'c'.repeat(64);
    const ok = { 'r-a': { 't1#1': { score: 1, max: 1, sha256: 'x' }, 't1#2': { score: 0, max: 1, sha256: 'y' } } };
    assert.throws(() => blind.writeGrades({ ...ok, 'r-b': { 't1#9': { score: 1, max: 1, sha256: 'z' } } }, 'opus', root, S), /ölçülmüş bir deneme değil/);
    assert.ok(!fs.existsSync(path.join(root, 'r-a', 'grades-opus.json')), 'yarım yazılmamalı');
    assert.throws(() => blind.writeGrades({ 'r-a': { 't1#1': { score: 1, max: 1, sha256: 'x' } } }, 'opus', root, S), /için not yok/);
    assert.throws(() => blind.writeGrades(ok, 'opus', root), /secret/);
    assert.deepStrictEqual(blind.writeGrades(ok, 'opus', root, S).length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('anahtarı açma: sonuç klasörlerini değiş tokuş eden anahtar reddedilir (model ve cevap özeti kaynağa bağlı)', () => {
  const root = tmp();
  try {
    const a = makeResults(root, 'r-a', 'gpt-x', [['t1', 1, 'answer of x']]);
    const b = makeResults(root, 'r-b', 'gpt-y', [['t1', 1, 'answer of y']]);
    fs.mkdirSync(path.join(root, 'tasks', 't1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tasks', 't1', 'task.json'), JSON.stringify({ id: 't1', claims: ['c1'] }));
    const key = path.join(root, 'key.json');
    blind.pack({ dirs: [a, b], out: path.join(root, 'p'), key, seed: 1, resultsRoot: root });
    const k = JSON.parse(fs.readFileSync(key, 'utf8'));
    const g = Object.fromEntries(Object.keys(k.items).map(i => [i, { claims: { c1: true } }]));
    assert.doesNotThrow(() => blind.unblind(g, k, roots(root)));
    const swapped = { ...k, items: Object.fromEntries(Object.entries(k.items).map(([i, e]) => [i, { ...e, dir: e.dir === 'r-a' ? 'r-b' : 'r-a' }])) };
    assert.throws(() => blind.unblind(g, swapped, roots(root)), /kaynak özetle/);
    const swappedAll = { ...k, items: Object.fromEntries(Object.entries(k.items).map(([i, e]) => [i, { ...e, dir: e.dir === 'r-a' ? 'r-b' : 'r-a', model: e.model === 'gpt-x' ? 'gpt-y' : 'gpt-x' }])) };
    assert.throws(() => blind.unblind(g, swappedAll, roots(root)), /kaynak cevapla/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('paketleme: henüz var olmayan paket klasörüne işaret eden (sarkan) takma ad da reddedilir; paket klasörü geride kalmaz', () => {
  const root = tmp();
  try {
    const a = makeResults(root, 'r-a', 'gpt-x', [['t1', 1, 'x']]);
    const out = path.join(root, 'pkg');
    const alias = path.join(root, 'pkg-alias');
    fs.symlinkSync(out, alias, 'junction');
    assert.throws(() => blind.pack({ dirs: [a], out, key: path.join(alias, 'key.json'), seed: 1, resultsRoot: root }), /anahtar/);
    assert.ok(!fs.existsSync(path.join(out, 'key.json')));
    assert.ok(!fs.existsSync(out), 'oluşturulan boş paket klasörü kaldırılmalı');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('paketleme: ".." ile başlayan bir dosya adı üst klasör sayılmaz; takma ad üzerinden paketin içine yazılamaz', () => {
  const root = tmp();
  try {
    const a = makeResults(root, 'r-a', 'gpt-x', [['t1', 1, 'x']]);
    const out = path.join(root, 'pkg');
    const alias = path.join(root, 'pkg-alias');
    fs.symlinkSync(out, alias, 'junction');
    assert.throws(() => blind.pack({ dirs: [a], out, key: path.join(alias, '..identity.json'), seed: 1, resultsRoot: root }), /anahtar/);
    assert.ok(!fs.existsSync(path.join(out, '..identity.json')));
    assert.throws(() => blind.pack({ dirs: [a], out: path.join(root, 'pkg2'), key: path.join(root, 'pkg2', '..identity.json'), seed: 1, resultsRoot: root }), /anahtar/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- Son inceleme bulguları (2026-11-27, 3. tur) ---

test('anahtar gizli bir değer taşır; açılan notlar cevap özetini taşır ve yazılan dosya imzalıdır', () => {
  const root = tmp();
  try {
    const a = makeResults(root, 'r-a', 'gpt-x', [['t1', 1, 'x']]);
    fs.mkdirSync(path.join(root, 'tasks', 't1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tasks', 't1', 'task.json'), JSON.stringify({ id: 't1', claims: ['c1'] }));
    const key = path.join(root, 'key.json');
    blind.pack({ dirs: [a], out: path.join(root, 'p'), key, seed: 1, resultsRoot: root, tasksRoot: path.join(root, 'tasks') });
    const k = JSON.parse(fs.readFileSync(key, 'utf8'));
    assert.match(k.secret, /^[0-9a-f]{64}$/);
    const g = Object.fromEntries(Object.keys(k.items).map(i => [i, { claims: { c1: true } }]));
    const byDir = blind.unblind(g, k, { resultsRoot: root, tasksRoot: path.join(root, 'tasks') });
    assert.match(byDir['r-a']['t1#1'].sha256, /^[0-9a-f]{64}$/);
    blind.writeGrades(byDir, 'opus', root, k.secret);
    const stats = require('./stats.cjs');
    assert.strictEqual(stats.readGrades(a, 'opus', { secret: k.secret, resultsRoot: root }).verified, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
