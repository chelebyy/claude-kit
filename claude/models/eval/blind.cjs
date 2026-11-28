#!/usr/bin/env node
// Kör puanlama araçları. Ağ, alt süreç ya da model çağrısı yok; yalnızca dosya okur ve yazar.
// Kullanım:
//   node claude/models/eval/blind.cjs pack --out <paket> --key <anahtar.json> --seed <n> <sonuç-klasörü>...
//   node claude/models/eval/blind.cjs agree <notlar-1.json> <notlar-2.json>
//   node claude/models/eval/blind.cjs unblind <notlar.json> --key <anahtar.json> --label <ad>
// pack: her sonuç klasöründeki ölçülmüş denemelerin cevaplarını model adı silinmiş olarak <paket>/<görev>/<harf>.md
// altına koyar; harfler görev başına tohumla karışır. Hangi harfin hangi model ve deneme olduğu yalnızca
// anahtar dosyasındadır; anahtar paketin içine yazılamaz ve puanlayıcıya verilmez.
// Not dosyası (puanlayıcının çıktısı): { "<görev>/<harf>": { "claims": { "<madde>": true|false, … } }, … }.
// agree: aynı paketin iki bağımsız puanlamasının madde bazında uyumu (oran, Cohen kappa, ayrışan maddeler).
// unblind: notları anahtarla açar ve her sonuç klasörüne grades-<ad>.json yazar (stats.cjs --grades <ad>).
// Ayrıntılar: claude/models/README.md ("Kör puanlama").
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const { rng, gradesMac } = require('./stats.cjs');

const ROOT = __dirname;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ITEM_RE = /^([a-z0-9][a-z0-9._-]{0,63})\/([A-Z]{1,3})$/;

// Göreli yol üst klasöre çıkıyor mu? Yalnızca tam bir `..` bölümü sayılır (`..x.json` bir dosya adıdır).
const escapes = r => r === '..' || r.startsWith(`..${path.sep}`) || r.startsWith('../') || path.isAbsolute(r);
// p, root'un içinde mi (bağlantılar çözüldükten sonra)?
function inside(root, p) {
  const r = path.relative(fs.realpathSync(root), fs.realpathSync(p));
  return Boolean(r) && !escapes(r);
}
// Henüz var olmayabilecek bir yolu, var olan en yakın üst klasörünün gerçek yolu (bağlantılar çözülmüş)
// üzerinden mutlak yola çevirir: klasöre bir takma ad (symlink, junction) üzerinden verilen yol da aynı
// gerçek yola çıkar.
function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) break;
    rest.unshift(path.basename(cur));
    cur = up;
  }
  return path.join(fs.existsSync(cur) ? fs.realpathSync(cur) : cur, ...rest);
}
function under(dir, p) {
  const r = path.relative(realish(dir), realish(p));
  return !r || !escapes(r);
}

function letter(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function shuffle(xs, rand) {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const answerFile = (id, run) => (run > 1 ? `${id}.run${run}.md` : `${id}.md`);

function redactModel(text, model) {
  const esc = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(esc, 'gi'), '[model]');
}

// Görevin rubriğindeki madde kimlikleri (task.json "claims"); varsa unblind notların tam olarak bu maddeleri
// taşımasını ister.
function taskClaims(tasksRoot, id) {
  let t;
  try { t = JSON.parse(fs.readFileSync(path.join(tasksRoot, id, 'task.json'), 'utf8')); } catch { return null; }
  if (!Array.isArray(t.claims)) return null;
  if (!t.claims.every(c => typeof c === 'string' && SLUG_RE.test(c))) throw new Error(`${id}: task.json claims geçersiz`);
  return [...new Set(t.claims)].sort();
}

function pack({ dirs, out, key, seed, resultsRoot = path.join(ROOT, 'results'), tasksRoot = path.join(ROOT, 'tasks') }) {
  if (!Number.isInteger(seed)) throw new Error('--seed bir tam sayı olmalı');
  if (under(out, key)) throw new Error('anahtar dosyası paket klasörünün içinde olamaz');
  const groups = new Map();
  const skipped = new Set();
  for (const dir of dirs) {
    if (!fs.existsSync(dir) || !inside(resultsRoot, dir)) throw new Error(`${dir}: sonuç kökü (${resultsRoot}) içinde değil`);
    const rel = path.relative(fs.realpathSync(resultsRoot), fs.realpathSync(dir)).split(path.sep).join('/');
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
    if (typeof s.model !== 'string' || !SLUG_RE.test(s.model)) throw new Error(`${dir}: summary.json model alanı geçersiz`);
    for (const t of Array.isArray(s.tasks) ? s.tasks : []) {
      if (typeof t.id !== 'string' || !SLUG_RE.test(t.id)) throw new Error(`${dir}: geçersiz görev kimliği ${JSON.stringify(t.id)}`);
      const run = t.run === undefined ? 1 : t.run;
      if (!Number.isInteger(run) || run < 1) throw new Error(`${dir}: ${t.id} geçersiz deneme numarası`);
      if (t.pass === null || t.pass === undefined) continue; // ölçülmedi: puanlanmaz
      // Rubrik maddesi olmayan görev (gizli kontrollü düzeltme) kör puanlanmaz; geçti/kaldı ile sayılır.
      if (!taskClaims(tasksRoot, t.id)) { skipped.add(t.id); continue; }
      const f = path.join(dir, answerFile(t.id, run));
      const st = fs.lstatSync(f, { throwIfNoEntry: false });
      if (!st || !st.isFile()) throw new Error(`${rel}/${answerFile(t.id, run)}: cevap dosyası yok ya da normal dosya değil`);
      const raw = fs.readFileSync(f);
      // Değişiklik kaydı varsa (çalıştırıcının yazdığı <deneme>.patch) cevabın altına eklenir: kod kalitesi
      // puanlanırken puanlayıcı yapılan değişikliği görür. Model adı ondan da silinir.
      const pf = path.join(dir, answerFile(t.id, run).replace(/\.md$/, '.patch'));
      const pst = fs.lstatSync(pf, { throwIfNoEntry: false });
      const patch = pst && pst.isFile() ? `\n\n## Changes (patch)\n\n\`\`\`diff\n${fs.readFileSync(pf, 'utf8')}\`\`\`\n` : '';
      const text = redactModel(raw.toString('utf8') + patch, s.model);
      if (!groups.has(t.id)) groups.set(t.id, []);
      groups.get(t.id).push({ dir: rel, id: t.id, run, model: s.model, effort: s.effort || null, sha256: sha256(raw), text });
    }
  }
  const ost = fs.lstatSync(out, { throwIfNoEntry: false });
  if (ost && (!ost.isDirectory() || ost.isSymbolicLink() || fs.readdirSync(out).length)) throw new Error(`${out}: paket klasörü boş bir klasör olmalı`);
  const created = !ost;
  fs.mkdirSync(out, { recursive: true });
  // Paket klasörü oluştuktan sonra yeniden denetlenir: henüz var olmayan klasöre işaret eden (sarkan) bir
  // takma ad, klasör oluşunca çözülür. Anahtarın klasörü var olmalıdır.
  const keyDir = path.dirname(path.resolve(key));
  const keyReal = fs.existsSync(keyDir) ? path.join(fs.realpathSync(keyDir), path.basename(key)) : null;
  const rk = keyReal && path.relative(fs.realpathSync(out), keyReal);
  if (!keyReal || !rk || !escapes(rk)) {
    if (created) fs.rmdirSync(out);
    throw new Error(keyReal ? 'anahtar dosyası paket klasörünün içinde olamaz' : 'anahtar dosyasının klasörü yok');
  }
  const rand = rng(seed);
  const items = {};
  const claims = {};
  for (const id of [...groups.keys()].sort()) {
    const c = taskClaims(tasksRoot, id);
    if (c) claims[id] = c;
    fs.mkdirSync(path.join(out, id));
    shuffle(groups.get(id), rand).forEach((e, i) => {
      const L = letter(i);
      fs.writeFileSync(path.join(out, id, `${L}.md`), e.text, { flag: 'wx' });
      items[`${id}/${L}`] = { dir: e.dir, id: e.id, run: e.run, model: e.model, effort: e.effort, sha256: e.sha256 };
    });
  }
  // claims yalnızca bilgi içindir; unblind maddeleri anahtardan değil görev tanımından okur.
  // secret: not dosyalarını imzalamak için (writeGrades); anahtarı olmayan biri not uyduramaz.
  fs.writeFileSync(key, JSON.stringify({ seed, secret: crypto.randomBytes(32).toString('hex'), items, claims }, null, 2) + '\n', { flag: 'wx' });
  return { items: Object.keys(items).length, tasks: groups.size, skipped: [...skipped].sort() };
}

function claimsOf(g, item) {
  const c = g && g.claims;
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`${item}: claims alanı yok`);
  for (const [k, v] of Object.entries(c)) if (typeof v !== 'boolean') throw new Error(`${item}: ${k} true ya da false olmalı`);
  return c;
}

// İki bağımsız puanlamanın madde bazında uyumu. Bir tarafta olmayan cevap ya da madde "missing"e
// yazılır; uyum oranına girmez ama sessizce de düşmez.
function agreement(g1, g2) {
  const items = [...new Set([...Object.keys(g1), ...Object.keys(g2)])].sort();
  const missing = [], disagreements = [];
  let n = 0, agree = 0, aTrue = 0, bTrue = 0;
  for (const item of items) {
    if (!(item in g1) || !(item in g2)) { missing.push(item); continue; }
    const c1 = claimsOf(g1[item], item), c2 = claimsOf(g2[item], item);
    for (const claim of [...new Set([...Object.keys(c1), ...Object.keys(c2)])].sort()) {
      if (!(claim in c1) || !(claim in c2)) { missing.push(`${item}:${claim}`); continue; }
      n++;
      if (c1[claim]) aTrue++;
      if (c2[claim]) bTrue++;
      if (c1[claim] === c2[claim]) agree++;
      else disagreements.push({ item, claim, a: c1[claim], b: c2[claim] });
    }
  }
  if (!n) return { claims: 0, agreementRate: null, kappa: null, disagreements, missing };
  const po = agree / n;
  const pa = aTrue / n, pb = bTrue / n;
  const pe = pa * pb + (1 - pa) * (1 - pb);
  const kappa = pe === 1 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe);
  return { claims: n, agreementRate: po, kappa, disagreements, missing };
}

const REL_DIR_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Notları anahtarla açar: { "<sonuç klasörü>": { "<görev>#<deneme>": { score, max } } }.
// Puanlayıcının çıktısı model etkisindeki bir veridir; seçerek eksik bırakılan, uydurulan ya da başka bir
// hedefe yönlendirilen not kabul edilmez: not dosyası anahtardaki cevapların tamamını, yalnızca onları taşır;
// her cevabın maddeleri görevin rubrik maddeleriyle (depodaki task.json claims; anahtardaki kopya kullanılmaz)
// aynıdır; görevde claims listesi yoksa açma durur (maddeleri puanlayıcı belirleyemez); anahtardaki her hedef geçerli ve tektir. Anahtar
// da kaynağına bağlıdır: her girdinin klasöründeki özetin modeli ve eforu, cevap dosyasının içerik özeti
// paketlenen cevapla aynı olmalıdır (klasörleri değiş tokuş eden bir anahtar reddedilir).
function unblind(grades, key, { resultsRoot = path.join(ROOT, 'results'), tasksRoot = path.join(ROOT, 'tasks') } = {}) {
  if (!key || !key.items || typeof key.items !== 'object') throw new Error('anahtar geçersiz');
  for (const item of Object.keys(grades)) {
    if (!ITEM_RE.test(item)) throw new Error(`${item}: geçersiz cevap adı`);
    if (!has(key.items, item)) throw new Error(`${item}: anahtarda yok`);
  }
  const missing = Object.keys(key.items).filter(item => !has(grades, item));
  if (missing.length) throw new Error(`not eksik: ${missing.slice(0, 10).join(', ')}`);
  const targets = new Set();
  const out = {};
  for (const [item, k] of Object.entries(key.items)) {
    const m = ITEM_RE.exec(item);
    if (!m || !k || typeof k.dir !== 'string' || !REL_DIR_RE.test(k.dir) || k.dir.split('/').some(s => s === '.' || s === '..') ||
        k.id !== m[1] || !Number.isInteger(k.run) || k.run < 1) throw new Error(`${item}: anahtar girdisi geçersiz`);
    const t = `${k.dir}#${k.id}#${k.run}`;
    if (targets.has(t)) throw new Error(`${item}: anahtarda aynı hedef iki kez`);
    targets.add(t);
    const dir = path.join(resultsRoot, ...k.dir.split('/'));
    if (!fs.existsSync(dir) || !inside(resultsRoot, dir)) throw new Error(`${item}: sonuç klasörü sonuç kökü içinde değil`);
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
    if (s.model !== k.model || (s.effort || null) !== (k.effort === undefined ? null : k.effort)) throw new Error(`${item}: anahtar girdisi kaynak özetle (model, efor) uyuşmuyor`);
    const af = path.join(dir, answerFile(k.id, k.run));
    const ast = fs.lstatSync(af, { throwIfNoEntry: false });
    if (!ast || !ast.isFile() || typeof k.sha256 !== 'string' || sha256(fs.readFileSync(af)) !== k.sha256) throw new Error(`${item}: anahtar girdisi kaynak cevapla uyuşmuyor`);
    const c = claimsOf(grades[item], item);
    const names = Object.keys(c).sort();
    if (!names.length) throw new Error(`${item}: hiç madde yok`);
    const expected = taskClaims(tasksRoot, k.id);
    if (!expected || !expected.length) throw new Error(`${item}: ${k.id} görevinin task.json'unda claims listesi yok; kör notlar açılamaz`);
    if (expected.join('\n') !== names.join('\n')) throw new Error(`${item}: maddeler görevin rubrik maddeleriyle aynı değil`);
    (out[k.dir] || (out[k.dir] = {}))[`${k.id}#${k.run}`] = { score: names.filter(n => c[n]).length, max: names.length, sha256: k.sha256 };
  }
  return out;
}

function writeGrades(byDir, label, resultsRoot = path.join(ROOT, 'results'), secret, tasksRoot = path.join(ROOT, 'tasks')) {
  if (!SLUG_RE.test(label || '')) throw new Error('--label geçerli bir ad olmalı');
  if (!(typeof secret === 'string' && /^[0-9a-f]{64}$/.test(secret))) throw new Error('anahtar dosyasında secret yok');
  const plan = [];
  for (const [rel, grades] of Object.entries(byDir)) {
    const dir = path.join(resultsRoot, rel);
    if (!fs.existsSync(dir) || !inside(resultsRoot, dir)) throw new Error(`${rel}: sonuç kökü içinde değil`);
    // Notlar özetteki ölçülmüş denemelerle birebir eşleşmeli: başka bir göreve ya da denemeye not yazılamaz,
    // ölçülmüş bir deneme notsuz kalamaz.
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
    const measured = new Set((Array.isArray(s.tasks) ? s.tasks : []).filter(t => (t.pass === true || t.pass === false) && taskClaims(tasksRoot, t.id))
      .map(t => `${t.id}#${t.run === undefined ? 1 : t.run}`));
    for (const k of Object.keys(grades)) if (!measured.has(k)) throw new Error(`${rel}: ${k} özette ölçülmüş bir deneme değil`);
    for (const k of measured) if (!has(grades, k)) throw new Error(`${rel}: ${k} için not yok`);
    for (const [k, g] of Object.entries(grades)) if (!g || typeof g.sha256 !== 'string') throw new Error(`${rel}: ${k} notunda cevap özeti yok`);
    const f = path.join(dir, `grades-${label}.json`);
    if (fs.existsSync(f)) throw new Error(`${rel}: grades-${label}.json zaten var`);
    plan.push([f, { version: 1, dir: rel, label, grades, mac: gradesMac(secret, rel, label, grades) }]);
  }
  // Önce hepsi doğrulanır, sonra yazılır: yarım kalan bir açma bazı klasörlere not bırakmasın.
  for (const [f, grades] of plan) fs.writeFileSync(f, JSON.stringify(grades, null, 2) + '\n', { flag: 'wx' });
  return plan.map(([f]) => f);
}

function opt(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}

// --results <kök> ve --tasks <klasör>: depo dışındaki (özel) görev seti için (run.cjs --tasks ile aynı).
function rootsFrom(rest) {
  const r = opt(rest, '--results'), t = opt(rest, '--tasks');
  return { ...(r ? { resultsRoot: path.resolve(r) } : {}), ...(t ? { tasksRoot: path.resolve(t) } : {}) };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
  if (cmd === 'pack') {
    const out = opt(rest, '--out'), key = opt(rest, '--key'), seed = Number(opt(rest, '--seed'));
    const roots = rootsFrom(rest);
    if (!out || !key || !rest.length) throw new Error('kullanım: pack --out <paket> --key <anahtar.json> --seed <n> [--results <kök>] [--tasks <klasör>] <sonuç-klasörü>...');
    return pack({ dirs: rest, out, key, seed, ...roots });
  }
  if (cmd === 'agree' && rest.length === 2) return agreement(readJson(rest[0]), readJson(rest[1]));
  if (cmd === 'unblind') {
    const key = opt(rest, '--key'), label = opt(rest, '--label');
    const roots = rootsFrom(rest);
    if (!key || !label || rest.length !== 1) throw new Error('kullanım: unblind <notlar.json> --key <anahtar.json> --label <ad>');
    const k = readJson(key);
    return { written: writeGrades(unblind(readJson(rest[0]), k, roots), label, roots.resultsRoot, k.secret, roots.tasksRoot) };
  }
  throw new Error('komut: pack | agree | unblind');
}

if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); } catch (e) { console.error(`model-eval blind: ${e.message}`); process.exit(1); }
} else {
  module.exports = { pack, agreement, unblind, writeGrades, letter, main };
}
