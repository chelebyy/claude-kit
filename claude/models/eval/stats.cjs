#!/usr/bin/env node
// Değerlendirme sonuçlarının istatistiği. Ağ, alt süreç ya da model çağrısı yok; yalnızca summary.json okur.
// Kullanım:
//   node claude/models/eval/stats.cjs <sonuç-klasörü>                       görev başına oranlar
//   node claude/models/eval/stats.cjs <klasör-A> <klasör-B> [--grades <ad>]  eşleştirilmiş karşılaştırma
// --grades <ad>: her klasördeki grades-<ad>.json (blind.cjs unblind --label <ad> çıktısı) puan olarak kullanılır;
// verilmezse puan geçti = 1, kaldı = 0'dır. Verildiyse ölçülmüş her denemenin notu olmalıdır (eksik not hata).
// --margin <0-1>: geride kalmama (non-inferiority) payı, varsayılan 0.25. Ayrıntılar: claude/models/README.md ("Tekrar ve istatistik").
'use strict';
const fs = require('fs');
const path = require('path');

const runOf = r => (Number.isInteger(r.run) && r.run >= 1 ? r.run : 1);

// Görev başına: deneme sayısı, ölçülen, geçen, ölçülmeyen, geçme oranı (ölçülenler üzerinden) ve
// "her denemede geçti" (allPass: hiçbir deneme ölçülmemiş ya da kalmış olmamalı).
function taskStats(results) {
  const out = {};
  for (const r of results) {
    const s = out[r.id] || (out[r.id] = { runs: 0, measured: 0, passed: 0, unmeasured: 0 });
    s.runs++;
    if (r.pass === null || r.pass === undefined) s.unmeasured++;
    else { s.measured++; if (r.pass === true) s.passed++; }
  }
  for (const s of Object.values(out)) {
    s.passRate = s.measured ? s.passed / s.measured : null;
    s.allPass = s.measured > 0 && s.measured === s.runs && s.passed === s.runs;
  }
  return out;
}

// Bir denemenin 0–1 arası puanı. Ölçülmemiş deneme puansızdır (null), not olsa bile.
// grades verildiyse (kör puanlama) her ölçülmüş denemenin notu olmalıdır: eksik not sessizce geçti/kaldı
// puanına düşseydi, notları seçerek eksik bırakmak sonucu değiştirebilirdi.
function scoreOf(r, grades) {
  if (r.pass === null || r.pass === undefined) return null;
  if (grades === undefined) return r.pass === true ? 1 : 0;
  const k = `${r.id}#${runOf(r)}`;
  const g = Object.prototype.hasOwnProperty.call(grades, k) ? grades[k] : undefined;
  if (g === undefined) throw new Error(`not eksik: ${k}`);
  const ok = g && typeof g.score === 'number' && typeof g.max === 'number' && Number.isFinite(g.score) &&
    Number.isFinite(g.max) && g.max > 0 && g.score >= 0 && g.score <= g.max;
  if (!ok) throw new Error(`geçersiz not: ${r.id}#${runOf(r)}`);
  return g.score / g.max;
}

function taskMeans(results, grades) {
  const sums = new Map();
  for (const r of results) {
    const s = scoreOf(r, grades);
    if (s === null) continue;
    const m = sums.get(r.id) || { sum: 0, n: 0 };
    m.sum += s; m.n++;
    sums.set(r.id, m);
  }
  return new Map([...sums].map(([id, m]) => [id, m.sum / m.n]));
}

// Tohumlu, yeniden üretilebilir sözde rastgele sayı (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIN_TASKS = 3;
const DEFAULT_MARGIN = 0.25;

// Karşılaştırılabilirlik: aynı (görev, deneme) iki kez sayılmaz; deneme numarası özetin tekrar sayısını aşmaz.
function checkAttempts(results, repeats, side) {
  const seen = new Set();
  for (const r of results) {
    const k = `${r.id}#${runOf(r)}`;
    if (seen.has(k)) throw new Error(`${side}: ${k} iki kez var`);
    seen.add(k);
    if (repeats !== undefined && runOf(r) > repeats) throw new Error(`${side}: ${k} tekrar sayısını (${repeats}) aşıyor`);
  }
}

// A ile B'yi görev bazında eşleştirerek karşılaştırır: her görevde ortalama puan farkı (A − B), görevler
// üzerinden ortalama fark ve görevleri yeniden örnekleyen %95 bootstrap aralığı. Denemeler aynı görevde
// birbirine bağlı olduğu için birim görevdir, deneme değil. Aralık sıfırı dışlamıyorsa karar "açık fark yok".
// nonInferior: A, B'den "payından fazla geride değil" kanıtı: aralığın alt ucu -margin'in üstünde, en az 3 görev
// karşılaştırılmış ve hiçbir görev dışarıda kalmamış. Rol kararı buna bakar (README "Karar kuralı").
function pairedCompare(A, B, { gradesA, gradesB, seed = 1, iterations = 10000, margin = DEFAULT_MARGIN } = {}) {
  if (!(typeof margin === 'number' && margin >= 0 && margin <= 1)) throw new Error('margin 0 ile 1 arasında olmalı');
  const ma = taskMeans(A, gradesA), mb = taskMeans(B, gradesB);
  const ids = [...ma.keys()].filter(id => mb.has(id)).sort();
  const all = new Set([...A.map(r => r.id), ...B.map(r => r.id)]);
  const excluded = [...all].filter(id => !ids.includes(id)).sort();
  const diffs = ids.map(id => ma.get(id) - mb.get(id));
  const n = diffs.length;
  const base = { tasks: n, excluded, margin, perTask: Object.fromEntries(ids.map((id, i) => [id, diffs[i]])) };
  if (!n) return { ...base, meanDiff: null, ci: null, halfWidth: null, verdict: 'not enough data', nonInferior: false };
  const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
  const meanDiff = mean(diffs);
  const rand = rng(seed);
  const boots = [];
  for (let i = 0; i < iterations; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += diffs[Math.floor(rand() * n)];
    boots.push(s / n);
  }
  boots.sort((x, y) => x - y);
  const ci = [boots[Math.floor(0.025 * (iterations - 1))], boots[Math.ceil(0.975 * (iterations - 1))]];
  const verdict = n < MIN_TASKS ? 'not enough data' : ci[0] > 0 ? 'A better' : ci[1] < 0 ? 'B better' : 'no clear difference';
  const nonInferior = n >= MIN_TASKS && !excluded.length && ci[0] > -margin;
  return { ...base, meanDiff, ci, halfWidth: (ci[1] - ci[0]) / 2, verdict, nonInferior };
}

function readSummary(dir) {
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  if (!Array.isArray(s.tasks)) throw new Error(`${dir}: summary.json tasks alanı yok`);
  return s;
}
function readGrades(dir, label) {
  if (!label) return undefined;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(label)) throw new Error('--grades geçerli bir ad olmalı');
  return JSON.parse(fs.readFileSync(path.join(dir, `grades-${label}.json`), 'utf8'));
}

// İki özet ancak aynı bölüm, aynı tekrar sayısı ve karşılaştırılan her görevde aynı sürümle karşılaştırılır.
function compatibility(a, b) {
  const split = x => x.split || null, reps = x => (x.repeats === undefined ? 1 : x.repeats);
  if (split(a) !== split(b)) throw new Error(`bölümler farklı: ${split(a)} / ${split(b)}`);
  if (reps(a) !== reps(b)) throw new Error(`tekrar sayıları farklı: ${reps(a)} / ${reps(b)}`);
  const va = a.taskVersions || {}, vb = b.taskVersions || {};
  for (const s of [a, b]) {
    if (s.taskVersions) for (const r of s.tasks) if (!Object.prototype.hasOwnProperty.call(s.taskVersions, r.id)) throw new Error(`${s.model}: ${r.id} taskVersions'ta yok`);
  }
  for (const id of new Set([...a.tasks.map(r => r.id)].filter(id => b.tasks.some(r => r.id === id)))) {
    const x = va[id] || { split: null, version: null }, y = vb[id] || { split: null, version: null };
    if (x.version !== y.version || x.split !== y.split) throw new Error(`${id}: görev sürümleri farklı`);
  }
  checkAttempts(a.tasks, reps(a), 'A');
  checkAttempts(b.tasks, reps(b), 'B');
}

function main(argv) {
  const dirs = [];
  let label, margin;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--grades') label = argv[++i];
    else if (argv[i] === '--margin') margin = Number(argv[++i]);
    else dirs.push(argv[i]);
  }
  if (dirs.length === 1) return { model: readSummary(dirs[0]).model, byTask: taskStats(readSummary(dirs[0]).tasks) };
  if (dirs.length !== 2) throw new Error('kullanım: stats.cjs <klasör> | <klasör-A> <klasör-B> [--grades <ad>]');
  const [a, b] = dirs.map(readSummary);
  compatibility(a, b);
  return { A: a.model, B: b.model, split: a.split || null, ...pairedCompare(a.tasks, b.tasks, { gradesA: readGrades(dirs[0], label), gradesB: readGrades(dirs[1], label), ...(margin !== undefined ? { margin } : {}) }) };
}

if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); } catch (e) { console.error(`model-eval stats: ${e.message}`); process.exit(1); }
} else {
  module.exports = { taskStats, scoreOf, pairedCompare, compatibility, rng, main, DEFAULT_MARGIN };
}
