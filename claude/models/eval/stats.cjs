#!/usr/bin/env node
// Değerlendirme sonuçlarının istatistiği. Ağ, alt süreç ya da model çağrısı yok; yalnızca summary.json okur.
// Kullanım:
//   node claude/models/eval/stats.cjs <sonuç-klasörü>                       görev başına oranlar
//   node claude/models/eval/stats.cjs <klasör-A> <klasör-B> [--grades <ad>]  eşleştirilmiş karşılaştırma
// --grades <ad>: her klasördeki grades-<ad>.json (blind.cjs unblind --label <ad> çıktısı) puan olarak kullanılır;
// verilmezse puan geçti = 1, kaldı = 0'dır. Verildiyse ölçülmüş her denemenin notu olmalıdır (eksik not hata).
// --role <rol>: onay kontrolü için B'nin (mevcut model) kayıtta bu rolle onaylı olması gerekir; verilmezse
// approval.blockers'a yazılır.
// --margin <0-1>: yalnızca keşif için withinMargin payı (varsayılan 0.25). Rol kararına giren approval alanı bu
// bayraktan etkilenmez: sabit pay 0.25, frozen bölüm, 3 tam tekrar ve depodaki kilitli görev seti (APPROVAL). Ayrıntılar: claude/models/README.md ("Tekrar ve istatistik").
'use strict';
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
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
// Çalıştırıcının kesin başarısızlıkları: kör not bunları düzeltemez (puan 0).
const hardFail = r => r.readOnlyOk === false || r.protectedOk === false || r.linksLeft === true ||
  r.checkTimedOut === true || Boolean(r.checkSkipped) || r.timedOutTwice === true;

function scoreOf(r, grades) {
  if (r.pass === null || r.pass === undefined) return null;
  if (hardFail(r)) return 0;
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
// withinMargin: A, B'den "payından fazla geride değil": aralığın alt ucu -margin'in üstünde, en az 3 görev
// karşılaştırılmış ve hiçbir görev dışarıda kalmamış. Keşif içindir; rol kararı approvalCheck'e bakar.
function pairedCompare(A, B, { gradesA, gradesB, seed = 1, iterations = 10000, margin = DEFAULT_MARGIN } = {}) {
  if (!(typeof margin === 'number' && margin >= 0 && margin <= 1)) throw new Error('margin 0 ile 1 arasında olmalı');
  const ma = taskMeans(A, gradesA), mb = taskMeans(B, gradesB);
  const ids = [...ma.keys()].filter(id => mb.has(id)).sort();
  const all = new Set([...A.map(r => r.id), ...B.map(r => r.id)]);
  const excluded = [...all].filter(id => !ids.includes(id)).sort();
  const diffs = ids.map(id => ma.get(id) - mb.get(id));
  const n = diffs.length;
  const base = { tasks: n, excluded, margin, perTask: Object.fromEntries(ids.map((id, i) => [id, diffs[i]])) };
  if (!n) return { ...base, meanDiff: null, ci: null, halfWidth: null, verdict: 'not enough data', withinMargin: false };
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
  const withinMargin = n >= MIN_TASKS && !excluded.length && ci[0] > -margin;
  return { ...base, meanDiff, ci, halfWidth: (ci[1] - ci[0]) / 2, verdict, withinMargin };
}

function readSummary(dir) {
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  if (!Array.isArray(s.tasks)) throw new Error(`${dir}: summary.json tasks alanı yok`);
  return s;
}
// Kör not dosyası (blind.cjs writeGrades): { version: 1, dir, label, grades: { "<görev>#<deneme>": { score, max, sha256 } }, mac }.
// mac, anahtar dosyasındaki gizli değerle (pack üretir, Claude'un geçici klasöründe durur) alınan HMAC-SHA256'dır:
// anahtarı olmayan biri not uyduramaz. sha256 notun ait olduğu cevap dosyasının özetidir: cevap sonradan
// değiştiyse not geçersizdir.
function gradesMac(secret, dir, label, grades) {
  return crypto.createHmac('sha256', Buffer.from(String(secret), 'utf8')).update(JSON.stringify({ dir, label, grades })).digest('hex');
}

const answerName = k => { const [id, run] = k.split('#'); return Number(run) > 1 ? `${id}.run${run}.md` : `${id}.md`; };

// { grades, verified }. secret verilmezse notlar okunur ama verified false'tur (yalnızca keşif).
function readGrades(dir, label, { secret, resultsRoot = path.join(__dirname, 'results') } = {}) {
  if (!label) return undefined;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(label)) throw new Error('--grades geçerli bir ad olmalı');
  const f = JSON.parse(fs.readFileSync(path.join(dir, `grades-${label}.json`), 'utf8'));
  if (!f || f.version !== 1 || !f.grades || typeof f.grades !== 'object' || typeof f.mac !== 'string') {
    if (secret) throw new Error(`${dir}: grades-${label}.json imzalı değil`);
    return { grades: f, verified: false };
  }
  if (!secret) return { grades: f.grades, verified: false };
  const rel = path.relative(fs.realpathSync(resultsRoot), fs.realpathSync(dir)).split(path.sep).join('/');
  if (f.dir !== rel || f.label !== label) throw new Error(`${dir}: not dosyası başka bir klasöre ya da ada ait`);
  const want = Buffer.from(gradesMac(secret, f.dir, f.label, f.grades), 'hex');
  const got = Buffer.from(/^[0-9a-f]{64}$/.test(f.mac) ? f.mac : '', 'hex');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new Error(`${dir}: not dosyasının imzası tutmuyor`);
  for (const [k, g] of Object.entries(f.grades)) {
    const af = path.join(dir, answerName(k));
    const st = fs.lstatSync(af, { throwIfNoEntry: false });
    const sha = st && st.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(af)).digest('hex') : null;
    if (!g || g.sha256 !== sha) throw new Error(`${dir}: ${k} notlandıktan sonra cevap değişmiş`);
  }
  return { grades: f.grades, verified: true };
}

// İki özet ancak aynı bölüm, aynı tekrar sayısı ve karşılaştırılan her görevde aynı sürümle karşılaştırılır.
function compatibility(a, b) {
  const split = x => x.split || null, reps = x => (x.repeats === undefined ? 1 : x.repeats);
  if (split(a) !== split(b)) throw new Error(`bölümler farklı: ${split(a)} / ${split(b)}`);
  if (reps(a) !== reps(b)) throw new Error(`tekrar sayıları farklı: ${reps(a)} / ${reps(b)}`);
  if ((a.effort || null) !== (b.effort || null)) throw new Error(`eforlar farklı: ${a.effort} / ${b.effort}`);
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

// Makineyle denetlenmeyen, Claude'un sonuç yazısında doğrulayıp yazması gereken adımlar.
const ATTEST = Object.freeze([
  'puanlayıcı adayın ailesinden değil (Codex adayı: Claude; Claude adayı: frontier Codex modeli), körlemesine',
  'aynı paket ikinci bağımsız puanlayıcıyla puanlandı ve blind.cjs agree uyumu yazıldı',
  'kilitli görevler, rubrikler ve claims ilk ölçümden önce commit\'lendi',
  'puanlanmış cevaplardan bir örnek elle okundu',
  'timeoutRetries incelendi',
  'runs.jsonl\'deki bu model ve eforla yapılmış bütün ölçümler sonuç yazısında listelendi (yalnızca seçilen değil)',
]);

// Rol kararının sabit koşulları; komut satırından değiştirilemez.
const APPROVAL = Object.freeze({ split: 'frozen', repeats: 3, margin: 0.25 });

// Depodaki kilitli görev seti: { <id>: { split, version } } (güvenilen kaynak; özetteki kopya değil).
function frozenTasks(tasksRoot = path.join(__dirname, 'tasks')) {
  const out = {};
  for (const e of fs.readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    let t;
    try { t = JSON.parse(fs.readFileSync(path.join(tasksRoot, e.name, 'task.json'), 'utf8')); } catch { continue; }
    if (t.split === 'frozen') out[t.id] = { split: 'frozen', version: t.version || null, claims: Array.isArray(t.claims) && t.claims.length > 0 };
  }
  return out;
}

// A (aday) için rol kararının makineyle denetlenebilen ön koşulları. Çıktı "geçti" demez: blockers boşsa
// bu ön koşullar sağlanmıştır, ama karar ayrıca attest altındaki elle doğrulanan adımlara bağlıdır.
// Denetlenen kanıt: iki özet de frozen bölümde, tam 3 tekrarla, depodaki
// kilitli görev setinin tamamıyla (aynı sürümler) çalışmış; her görevin 1..3 denemesinin hepsi ölçülmüş;
// sabit 0.25 payla aralığın alt ucu -0.25'in üstünde. Eksik, yarım kalmış, başka bölümden ya da sürümden
// gelen kanıt geçmez. timeoutRetries yalnızca bilgi içindir (bkz. README, bilinen sınır).
// Kayıt yalnızca hesabın gerçek ev klasöründen okunur (run.cjs ile aynı; HOME/USERPROFILE yok sayılır).
function loadRegistry() {
  return JSON.parse(fs.readFileSync(path.join(os.userInfo().homedir, '.claude', 'models', 'registry.json'), 'utf8'));
}

// Kayıttaki rol metninden rol adları: parantez içi ("(alias opus)") atılır, virgül ve "and" ile ayrılır.
function roleNames(s) {
  return String(s).replace(/\([^)]*\)/g, ' ').split(/\s*(?:,|\band\b)\s*/).map(x => x.trim()).filter(Boolean);
}

// B, kayıtta verilen rolde onaylı mevcut model olmalı; A ondan farklı bir model olmalı. Codex modellerinde
// B'nin eforu kayıttaki efforts listesinde olmalı. Claude rolleri serbest metindir ("main and reviewer (alias
// opus)"): rol sözcüğü metnin sözcüklerinden biri olmalı.
function baselineProblem(a, b, role, registry) {
  if (!role) return 'rol verilmedi (--role): mevcut model doğrulanamaz';
  if (!registry) return 'model kaydı okunamadı';
  if (a.model === b.model) return 'A ile B aynı model';
  for (const fam of ['codex', 'claude']) {
    const sec = registry[fam] || {};
    if (!Object.prototype.hasOwnProperty.call(sec, b.model)) continue;
    const e = sec[b.model];
    const roleOk = typeof e.role === 'string' && roleNames(e.role).includes(role);
    if (e.status !== 'approved' || !roleOk) return `B (${b.model}) kayıtta ${role} rolüyle onaylı değil`;
    if (fam === 'codex' && Array.isArray(e.efforts) && !e.efforts.includes(b.effort)) return `B eforu (${b.effort}) kayıttaki efforts listesinde değil`;
    return null;
  }
  return `B (${b.model}) kayıtta yok`;
}

function approvalCheck(a, b, expected, opts = {}) {
  const reasons = [];
  let registry = opts.registry;
  if (registry === undefined) { try { registry = loadRegistry(); } catch { registry = null; } }
  const bp = baselineProblem(a, b, opts.role, registry);
  if (bp) reasons.push(bp);
  if ((a.effort || null) !== (b.effort || null)) reasons.push(`eforlar farklı: A ${a.effort}, B ${b.effort}`);
  const needsGrades = Object.keys(expected).filter(id => expected[id].claims);
  if (needsGrades.length && (opts.gradesA === undefined || opts.gradesB === undefined)) reasons.push(`rubrik maddeli görevlerde kör not zorunlu (--grades): ${needsGrades.join(', ')}`);
  else if (needsGrades.length && opts.gradesVerified !== true) reasons.push('kör notlar doğrulanmadı (--key ile imza ve cevap özeti denetlenmeli)');
  const ids = Object.keys(expected).sort();
  if (ids.length < MIN_TASKS) reasons.push(`kilitli sette ${ids.length} görev var (en az ${MIN_TASKS})`);
  for (const [side, s] of [['A', a], ['B', b]]) {
    if (s.split !== APPROVAL.split) reasons.push(`${side}: bölüm ${s.split || 'yok'} (frozen olmalı)`);
    if (s.repeats !== APPROVAL.repeats) reasons.push(`${side}: tekrar ${s.repeats === undefined ? 1 : s.repeats} (${APPROVAL.repeats} olmalı)`);
    const tv = s.taskVersions || {};
    const tvIds = Object.keys(tv).sort();
    if (tvIds.join('\n') !== ids.join('\n')) reasons.push(`${side}: görev seti depodaki kilitli setle aynı değil`);
    for (const id of ids) {
      if (tv[id] && (tv[id].version !== expected[id].version || tv[id].split !== 'frozen')) reasons.push(`${side}: ${id} sürümü depodakinden farklı`);
      const got = s.tasks.filter(r => r.id === id);
      const runs = got.map(runOf).sort((x, y) => x - y).join(',');
      const want = Array.from({ length: APPROVAL.repeats }, (_, k) => k + 1).join(',');
      if (runs !== want) reasons.push(`${side}: ${id} denemeleri ${runs || 'yok'} (${want} olmalı)`);
      else if (got.some(r => r.pass !== true && r.pass !== false)) reasons.push(`${side}: ${id} ölçülmemiş deneme var`);
      if (got.some(r => r.readOnlyOk === false || r.protectedOk === false || r.linksLeft === true || Boolean(r.checkSkipped))) reasons.push(`${side}: ${id} kural ihlali ya da kontrol klasörü denetimi başarısız (salt okunur, korunan dosya, bağlantı, checkSkipped)`);
      if (got.some(r => (r.previousAttempts || []).some(p => p.pass === true || p.pass === false))) reasons.push(`${side}: ${id} yeniden ölçülmüş deneme var (ölçülmüş deneme değiştirilemez)`);
    }
    for (const r of s.tasks) if (!ids.includes(r.id)) reasons.push(`${side}: ${r.id} kilitli sette değil`);
  }
  const cmp = pairedCompare(a.tasks, b.tasks, { gradesA: opts.gradesA, gradesB: opts.gradesB, margin: APPROVAL.margin });
  if (cmp.excluded.length) reasons.push(`dışarıda kalan görevler: ${cmp.excluded.join(', ')}`);
  if (!cmp.ci || !(cmp.ci[0] > -APPROVAL.margin)) reasons.push(`aralığın alt ucu ${cmp.ci ? cmp.ci[0] : 'yok'} (-${APPROVAL.margin}'in üstünde olmalı)`);
  const n = x => (Array.isArray(x.timeoutRetries) ? x.timeoutRetries.length : 0);
  const retries = s => s.tasks.reduce((sum, r) => sum + n(r) + (r.previousAttempts || []).reduce((t, p) => t + n(p), 0), 0);
  return { blockers: [...new Set(reasons)], ci: cmp.ci, meanDiff: cmp.meanDiff, timeoutRetries: { A: retries(a), B: retries(b) }, attest: ATTEST };
}

function main(argv) {
  const dirs = [];
  let label, margin, role, keyFile;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--grades') label = argv[++i];
    else if (argv[i] === '--margin') margin = Number(argv[++i]);
    else if (argv[i] === '--role') role = argv[++i];
    else if (argv[i] === '--key') keyFile = argv[++i];
    else dirs.push(argv[i]);
  }
  if (dirs.length === 1) return { model: readSummary(dirs[0]).model, byTask: taskStats(readSummary(dirs[0]).tasks) };
  if (dirs.length !== 2) throw new Error('kullanım: stats.cjs <klasör> | <klasör-A> <klasör-B> [--grades <ad>]');
  if (path.resolve(dirs[0]) === path.resolve(dirs[1])) throw new Error('A ile B aynı klasör');
  const [a, b] = dirs.map(readSummary);
  compatibility(a, b);
  const secret = keyFile ? JSON.parse(fs.readFileSync(keyFile, 'utf8')).secret : undefined;
  if (keyFile && !(typeof secret === 'string' && /^[0-9a-f]{64}$/.test(secret))) throw new Error('anahtar dosyasında secret yok');
  const ga = readGrades(dirs[0], label, { secret }), gb = readGrades(dirs[1], label, { secret });
  const grades = { gradesA: ga && ga.grades, gradesB: gb && gb.grades, gradesVerified: Boolean(ga && gb && ga.verified && gb.verified) };
  return { A: a.model, B: b.model, split: a.split || null,
    ...pairedCompare(a.tasks, b.tasks, { gradesA: grades.gradesA, gradesB: grades.gradesB, ...(margin !== undefined ? { margin } : {}) }),
    approval: approvalCheck(a, b, frozenTasks(), { ...grades, role }) };
}

if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); } catch (e) { console.error(`model-eval stats: ${e.message}`); process.exit(1); }
} else {
  module.exports = { taskStats, scoreOf, pairedCompare, compatibility, approvalCheck, baselineProblem, roleNames, readGrades, gradesMac, frozenTasks, APPROVAL, rng, main, DEFAULT_MARGIN };
}
