#!/usr/bin/env node
// Model değerlendirme çalıştırıcısı. Yalnızca yeni bir model geldiğinde elle çalıştırılır.
// Kullanım:
//   node claude/models/eval/run.cjs --model <slug> --effort <efor> --tier <fast|default>
//     [--cyber-access-program <standard|daybreak_blue|daybreak_red>] [--task <id>] [--split <dev|frozen>]
//     [--repeats <1-10>] [--tasks <görev-klasörü>] [--results <sonuç-klasörü>] [--dry-run]
// --tasks: depo dışındaki (ör. özel) bir görev seti; verilirse sonuçlar varsayılan olarak onun yanındaki results/
// klasörüne yazılır, böylece özel görevlerin cevapları açık depoya girmez.
// Her görev için: fixture geçici bir klasöre kopyalanır, Codex
// `codex exec` ile çalıştırılır, ardından kontroller yapılır. Sonuç results/ altına yazılır.
// Ayrıntılar: claude/models/README.md
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { taskStats } = require('./stats.cjs');

const ROOT = __dirname;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const TIERS = new Set(['fast', 'default']);
const SANDBOXES = new Set(['read-only', 'workspace-write']);
// codex exec --cyber-access-program değerleri (codex exec --help); Daybreak modelleri bunu ister.
const CYBER_PROGRAMS = new Set(['standard', 'daybreak_blue', 'daybreak_red']);
const IS_WIN = process.platform === 'win32';
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
// Görev setinin bölümleri: dev (ayar ve deneme; ölçüm sonucuna göre değiştirilebilir) ve frozen (karar seti;
// rubrik ve kontroller ilk ölçümden önce commit'lenir, sonra yalnızca yeni bir version ile değişir).
const SPLITS = new Set(['dev', 'frozen']);

function parseArgs(argv) {
  const a = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run') a.dryRun = true;
    else if (['--model', '--effort', '--tier', '--task'].includes(k)) a[k.slice(2)] = argv[++i];
    else if (k === '--cyber-access-program') a.cyber = argv[++i];
    else if (k === '--split') a.split = argv[++i];
    else if (k === '--repeats') a.repeats = argv[++i];
    else if (k === '--tasks') a.tasksDir = argv[++i];
    else if (k === '--results') a.resultsDir = argv[++i];
    else throw new Error(`bilinmeyen argüman: ${k}`);
  }
  if (a.split !== undefined && !SPLITS.has(a.split)) throw new Error('--split: dev|frozen');
  for (const k of ['tasksDir', 'resultsDir']) {
    if (a[k] === undefined) continue;
    if (typeof a[k] !== 'string' || !a[k] || !fs.existsSync(a[k]) || !fs.statSync(a[k]).isDirectory()) throw new Error(`--${k === 'tasksDir' ? 'tasks' : 'results'} var olan bir klasör olmalı`);
    a[k] = fs.realpathSync(a[k]);
  }
  if (a.repeats === undefined) a.repeats = 1;
  else if (!/^(10|[1-9])$/.test(a.repeats)) throw new Error('--repeats: 1-10 arası bir tam sayı');
  else a.repeats = Number(a.repeats);
  if (!a.model || !SLUG_RE.test(a.model)) throw new Error('--model geçerli bir slug olmalı');
  // claude-* modelleri Claude Code CLI ile (claude -p) çalışır; katman ve cyber programı Codex'e özgüdür.
  a.provider = a.model.startsWith('claude-') ? 'claude' : 'codex';
  if (a.provider === 'claude') {
    if (!CLAUDE_EFFORTS.has(a.effort)) throw new Error('--effort (Claude): low|medium|high|xhigh|max');
    if (a.tier !== undefined || a.cyber !== undefined) throw new Error('Claude modellerinde --tier ve --cyber-access-program kullanılmaz');
    if (a.task !== undefined && !SLUG_RE.test(a.task)) throw new Error('--task geçerli bir görev kimliği olmalı');
    return a;
  }
  if (!EFFORTS.has(a.effort)) throw new Error('--effort: low|medium|high|xhigh|max|ultra');
  if (!TIERS.has(a.tier)) throw new Error('--tier: fast|default (Astra her zaman default)');
  if (a.cyber !== undefined && !CYBER_PROGRAMS.has(a.cyber)) throw new Error('--cyber-access-program: standard|daybreak_blue|daybreak_red');
  // Daybreak modellerinin fast katmanı yok; cyber programı yalnızca default katmanla denenir.
  if (a.cyber !== undefined && a.tier !== 'default') throw new Error('--cyber-access-program yalnızca --tier default ile kullanılır');
  if (a.task !== undefined && !SLUG_RE.test(a.task)) throw new Error('--task geçerli bir görev kimliği olmalı');
  return a;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, ...opts });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

// Çalıştırılabilir dosyaları ev klasöründen, mutlak yol olarak çözer. Windows'ta yalın bir ad
// önce o anki klasörde aranır; model çalışma klasörüne node.exe ya da başka bir .exe bırakabilir.
const exeCache = new Map();
function resolveExe(name) {
  if (exeCache.has(name)) return exeCache.get(name);
  const r = run(IS_WIN ? 'where' : 'which', [name], { cwd: os.homedir() });
  const hit = r.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    .find(l => path.isAbsolute(l) && (!IS_WIN || /\.(exe|cmd)$/i.test(l)));
  if (!hit) throw new Error(`${name} bulunamadı`);
  exeCache.set(name, hit);
  return hit;
}

// Windows'ta codex bir npm .cmd kısayoludur ve kabuksuz çalışmaz. Kabuk, boşluk içeren yolları
// bölerdi; bu yüzden kısayolun çağırdığı codex.js'i bulup doğrudan node ile çalıştırırız.
function codexCommand() {
  if (!IS_WIN) return { cmd: resolveExe('codex'), pre: [] };
  const js = path.join(path.dirname(resolveExe('codex.cmd')), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (!fs.existsSync(js)) throw new Error('codex.js bulunamadı');
  return { cmd: process.execPath, pre: [js] };
}

const testHooks = {};

// Klasördeki her girdiyi göreli yol → içerik özeti olarak çıkarır. Bağlantılar izlenmez;
// dosya ya da klasör olmayan her girdi (bağlantı, junction vb.) ve birden fazla adı olan dosya
// (sabit bağlantı: nlink > 1, başka bir yerdeki dosyayla aynı içerik) ayrı bir işaretle kaydedilir.
function snapshot(root) {
  const out = new Map();
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (st.isFile() && st.nlink <= 1) out.set(rel, crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'));
      else out.set(rel, 'non-regular-entry');
    }
  })(root);
  return out;
}

function loadTasks(only, split, tasksRoot = path.join(ROOT, 'tasks')) {
  const dir = tasksRoot;
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && (!only || e.name === only))
    .map(e => {
      const base = path.join(dir, e.name);
      const task = JSON.parse(fs.readFileSync(path.join(base, 'task.json'), 'utf8'));
      if (task.id !== e.name) throw new Error(`${e.name}: task.json id klasör adıyla aynı olmalı`);
      if (!SANDBOXES.has(task.sandbox)) throw new Error(`${e.name}: sandbox read-only ya da workspace-write olmalı`);
      if (task.split !== undefined && !SPLITS.has(task.split)) throw new Error(`${e.name}: split dev ya da frozen olmalı`);
      if (task.version !== undefined && !(Number.isInteger(task.version) && task.version >= 1)) throw new Error(`${e.name}: version pozitif bir tam sayı olmalı`);
      if (fs.existsSync(path.join(base, 'fixture', HIDDEN_DIR))) throw new Error(`${e.name}: fixture ${HIDDEN_DIR}/ içeremez`);
      if (task.check && task.check.verify !== undefined && (typeof task.check.verify !== 'string' || !/^[a-z0-9._-]+\.c?js$/.test(task.check.verify) || !fs.existsSync(path.join(base, 'verify', task.check.verify)))) throw new Error(`${e.name}: check.verify verify/ klasöründe bir dosya olmalı`);
      if (task.check && task.check.steps !== undefined) {
        const st = task.check.steps;
        const okStep = x => x && typeof x.command === 'string' && /^node [A-Za-z0-9_./ -]+$/.test(x.command) &&
          Number.isInteger(x.timeoutMs) && x.timeoutMs >= 1000 && x.timeoutMs <= 600000;
        if (!Array.isArray(st) || !st.length || st.length > 10 || !st.every(okStep) || !task.check.verify) {
          throw new Error(`${e.name}: check.steps 1-10 adım olmalı (node komutu, timeoutMs 1000-600000) ve check.verify gerektirir`);
        }
      }
      if (task.check && task.check.fixturePasses !== undefined && !(task.check.fixturePasses === true && Array.isArray(task.claims) && task.claims.length)) {
        throw new Error(`${e.name}: check.fixturePasses yalnızca true olabilir ve claims gerektirir`);
      }
      if (task.check && task.check.timeoutMs !== undefined && !(Number.isInteger(task.check.timeoutMs) && task.check.timeoutMs >= 1000 && task.check.timeoutMs <= 600000)) throw new Error(`${e.name}: check.timeoutMs 1000-600000 olmalı`);
      return { ...task, base, prompt: fs.readFileSync(path.join(base, 'prompt.md'), 'utf8') };
    })
    // split verilmemiş görevler eski settir (ön kontrol); --split verilince yalnızca o bölüm çalışır.
    .filter(t => !split || t.split === split);
}

// Claude Code CLI (claude -p). Claude Code'un Windows'ta işletim sistemi sandbox'ı yoktur; bu yüzden
// modele kabuk verilmez (yazdığı kodu makinede çalıştıramasın): düzeltme görevlerinde yalnızca okuma ve
// düzenleme araçları, inceleme görevlerinde yalnızca okuma araçları. İzin isteyen her şey reddedilir
// (--permission-prompts none); düzenlemeler çalışma klasörüyle sınırlıdır. Kontrol yine runCheck ile
// yalıtılmış çalışır. Görev isteği stdin'den verilir; cevap ve kullanım JSON çıktısından okunur.
// --tools yalnızca yerleşik araçları kısıtlar: kullanıcı ayarlarındaki MCP sunucularının araçları
// (tarayıcı, GitHub, web araması …; ayarlarda önceden izin verilmiş olanlar izin istemeden çalışır)
// --strict-mcp-config ve boş bir MCP ayarıyla kapatılır. Yerleşik danışman (advisorModel) da kapatılır:
// açık kalırsa ölçülen cevaba başka bir model katkı yapar. İkisi de gerçek CLI'de ölçüldü (2026-11-08):
// modelin gördüğü araçlar yalnızca verilenlerdi.
// Hiçbir ayar kaynağı yüklenmez (--setting-sources ""): araç olmasalar da kullanıcı plugin'leri ve
// hook'ları model kodunu çalıştırabilir. Ölçüldü (2026-11-08): ayarlar açıkken typescript-lsp plugin'i
// çalışma klasörüne konmuş bir tsserver.js'i çalıştırdı ve çalışma klasöründeki .claude/settings.local.json
// hook'u çalıştı (model ikisini de Write ile yazabilir); ayar kaynakları kapalıyken ikisi de çalışmadı ve
// giriş (OAuth) çalışmaya devam etti. Bu modda kullanıcının CLAUDE.md'si de yüklenmez.
function claudeArgs(a, task) {
  const edits = !task.mustNotModify;
  return ['-p', '--model', a.model, '--effort', a.effort, '--output-format', 'json', '--no-session-persistence',
    '--tools', edits ? 'Read,Edit,Write,Glob,Grep' : 'Read,Glob,Grep',
    '--permission-mode', edits ? 'acceptEdits' : 'manual', '--permission-prompts', 'none',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '', '--settings', '{"advisorModel":""}'];
}

// Windows'ta yalnızca yerel claude.exe kabul edilir: npm'in claude.cmd kısayolu kabuksuz çalıştırılamaz
// (her görev "ölçülmedi" olurdu); kabukla çalıştırmak da argüman tırnaklamasını bozardı.
function pickClaudeExe(paths) {
  if (!IS_WIN) return paths[0] || null;
  return paths.find(p => /\.exe$/i.test(p)) || null;
}

function claudeCommand() {
  const r = run(IS_WIN ? 'where' : 'which', ['claude'], { cwd: os.homedir() });
  const paths = r.stdout.split(/\r?\n/).map(l => l.trim()).filter(l => l && path.isAbsolute(l));
  const exe = pickClaudeExe(paths);
  if (!exe) throw new Error(IS_WIN ? 'claude.exe bulunamadı (npm claude.cmd kısayolu desteklenmez; yerel Claude Code kurulumu gerekir)' : 'claude bulunamadı');
  return { cmd: exe, pre: [] };
}

// claude -p --output-format json çıktısındaki JSON nesnesini okur (öncesinde uyarı satırları olabilir).
function parseClaudeOutput(stdout) {
  const at = stdout.indexOf('{"');
  if (at < 0) return null;
  try { return JSON.parse(stdout.slice(at)); } catch { return null; }
}

function claudeUsage(j) {
  if (!j || !j.usage) return null;
  const u = j.usage;
  const n = k => (typeof u[k] === 'number' ? u[k] : 0);
  return {
    input_tokens: n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens'),
    cached_input_tokens: n('cache_read_input_tokens'),
    output_tokens: n('output_tokens'),
    ...(typeof j.total_cost_usd === 'number' ? { cost_usd: j.total_cost_usd } : {}),
  };
}

function codexArgs(a, task, dir, lastMsgFile) {
  return ['exec', '-m', a.model,
    '-c', `model_reasoning_effort="${a.effort}"`, '-c', `service_tier="${a.tier}"`,
    '-s', task.sandbox, '-C', dir, '--skip-git-repo-check', '--ephemeral', '--json',
    ...(a.cyber ? ['--cyber-access-program', a.cyber] : []),
    '-o', lastMsgFile, '-'];
}

// Metindeki yerel yolları yer tutucuyla değiştirir: çalışma klasörü (verildiyse) `<workdir>`, geçici
// klasör `<tmp>`, ev klasörü `~`. İçteki klasör önce değişir (çalışma klasörü geçici klasörün, o da ev
// klasörünün altındadır). Windows'ta hem `\` hem `/` ayırıcılı yazımlar ve harf farkı yakalanır.
function redactLocalPaths(text, work) {
  let out = text;
  const roots = [...(work ? [[work, '<workdir>']] : []), [os.tmpdir(), '<tmp>'], [os.homedir(), '~']];
  for (const [root, rep] of roots) {
    const p = path.resolve(root);
    for (const v of new Set([p, p.split('\\').join('/')])) {
      out = out.replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), IS_WIN ? 'gi' : 'g'), rep);
    }
  }
  return out;
}

// Token biçimli değerleri maskeler (Bearer/Basic başlıkları, key/token/secret parametreleri; JSON ve
// tırnaklı yazımlar dahil; sk- anahtarları). Kayıtlar depoya girebilir; codex stderr'inin bunları
// taşıdığı bilinen bir yol yok, bu ek bir önlem.
function maskSecrets(text) {
  return text
    .replace(/((?:Bearer|Basic)\s+)[^\s"']+/gi, '$1***')
    .replace(/((?:api[_-]?key|access[_-]?token|token|secret|password)["']?\s*[=:]\s*["']?)[^\s&"',;]+/gi, '$1***')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}/g, 'sk-***');
}

// Sonuç nesnesindeki bütün metinlere redactLocalPaths uygular (summary.json: leftoverDir, hata
// mesajları vb.). JSON'a çevirmeden önce yapılır; çevrildikten sonra `\` kaçışlı yazılırdı.
function redactDeep(v, work) {
  if (typeof v === 'string') return redactLocalPaths(v, work);
  if (Array.isArray(v)) return v.map(x => redactDeep(x, work));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, work)]));
  return v;
}

// Cevaptaki `dosya:satır` ve `dosya:satır-satır` atıflarından tuzak aralıklarına düşenleri döndürür.
// decoys: { "server.js": [[10, 12], [42, 45]] }.
function decoyCitations(answer, decoys) {
  const out = [];
  for (const [file, ranges] of Object.entries(decoys)) {
    const esc = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![\\w.-])${esc}:(\\d+)(?:\\s*[-–]\\s*(\\d+))?`, 'g');
    for (const m of answer.matchAll(re)) {
      const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
      if (ranges.some(([lo, hi]) => a <= hi && b >= lo)) out.push(m[0]);
    }
  }
  return out;
}

// --json olay akışından son kullanım bilgisini sayılar olarak çıkarır.
function lastUsage(jsonl) {
  let usage = null;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const u = ev && (ev.usage || (ev.msg && ev.msg.usage) || (ev.payload && ev.payload.usage));
    if (u && typeof u === 'object') {
      usage = Object.fromEntries(Object.entries(u).filter(([, v]) => typeof v === 'number'));
    }
  }
  return usage;
}

// Değişiklikler, depodaki temiz fixture'ın içerik özetleriyle karşılaştırılır. Model yalnızca
// çalışma kopyasına yazabilir; karşılaştırma tabanı onun erişemediği depo kopyasıdır. mtime,
// .gitignore ya da git durumu hiçbir rol oynamaz.
// Codex'in kendi kullanıcı ayarındaki hook'lar çalışma klasörüne .codex/ altında durum dosyaları
// yazar; bunlar modelin değişikliği değildir, ayrı raporlanır.
// .codex/ (Codex) ya da .claude/ (Claude Code) yolu mu? Windows dosya sistemi büyük/küçük harf ayırmaz:
// .CODEX de aynı klasördür. Bu dosyalar kontrol klasörüne de kopyalanmaz.
const isCodexPath = rel => ['.codex', '.claude'].includes(rel.split('/')[0].toLowerCase());
// Ayrı raporlanan araç dosyası yalnızca Codex çalıştırmasındaki .codex/ yoludur (kullanıcı hook'ları oraya yazar).
// Claude çalıştırmasında ayar kaynakları ve hook'lar kapalıdır: .claude/ ya da .codex/ altına yazan modeldir;
// bu değişiklikler salt okunur ve korumalı dosya denetimlerine girer.
const isHarnessPath = (rel, isClaude) => !isClaude && rel.split('/')[0].toLowerCase() === '.codex';

function changedFiles(before, work, isClaude = false) {
  const after = snapshot(work);
  const all = new Set();
  for (const [rel, hash] of after) if (before.get(rel) !== hash) all.add(rel);
  for (const rel of before.keys()) if (!after.has(rel)) all.add(rel);
  const list = [...all].sort();
  // Dosya ya da klasör olmayan girdiler (junction, sembolik bağlantı): Node izin modeli bunları izler,
  // yani kontrol sırasında okuma/yazma klasör dışına taşabilir.
  const links = [...after].filter(([, h]) => h === 'non-regular-entry').map(([rel]) => rel);
  return { model: list.filter(f => !isHarnessPath(f, isClaude)), harness: list.filter(f => isHarnessPath(f, isClaude)), links, after };
}

// Kontrol, modelin klasöründe değil, ev klasörü altında yeni bir klasörde çalışır. Codex sandbox'ı
// ev klasörüne yazmayı engellediği için model çalışmasından geride kalmış bir süreç bu klasöre
// ulaşamaz (TEMP'e ise ulaşabilir). Yalnızca normal dosyalar kopyalanır, .codex/ kopyalanmaz.
// Her dosya bir kez okunur, özeti model çalışmasından hemen sonra alınan özetle karşılaştırılır ve
// aynı içerik yazılır; arada değişen bir dosya varsa kontrol çalışmaz (drift).
const checkRoot = () => testHooks.checkRoot || path.join(os.homedir(), '.cache', 'model-eval');

// Kontrol klasörünün izinlerini üst klasörlerden bağımsız kılar: Windows'ta miras kesilir ve yalnızca
// geçerli kullanıcı, SYSTEM ve Administrators tam yetki alır (~/.cache gibi üst klasörlerde Codex
// sandbox gruplarına miras geçen yazma izinleri olabilir). Codex sandbox, -C ile verilen klasöre kendi
// yazma iznini kendisi ekler; başka sandbox süreçleri yazamaz. Diğer sistemlerde 0700.
function lockDown(dir) {
  if (process.platform !== 'win32') { fs.chmodSync(dir, 0o700); return; }
  const user = `${process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' : ''}${os.userInfo().username}`;
  const r = run(resolveExe('icacls'), [dir, '/inheritance:r', '/grant:r',
    `${user}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { cwd: os.homedir() });
  if (r.status !== 0) throw new Error(`icacls failed: ${(r.stderr || r.stdout).trim().slice(0, 160)}`);
}

// Klasörün araya girilemez durumda olduğunu doğrular; sorun varsa nedenini, yoksa null döndürür.
// Gerçek bir klasör olmalı (bağlantı değil). Windows'ta sahibi geçerli kullanıcı ya da Administrators
// olmalı ve ACL'de yalnızca kullanıcı, SYSTEM ve Administrators bulunmalı: icacls /grant:r başka
// hesapların açık girdilerini silmez, kök klasör de çalıştırmalar arasında kalıcıdır. Diğer
// sistemlerde sahibi kullanıcı olmalı ve başkalarına izin verilmemeli.
function privateDirProblem(dir) {
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return 'not a plain directory';
  if (!IS_WIN) {
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return 'owned by another user';
    return (st.mode & 0o077) ? 'accessible by other users' : null;
  }
  const script = "$ErrorActionPreference='Stop';$S=[System.Security.Principal.SecurityIdentifier];" +
    // Get-Acl yerine .NET: PowerShell 7'den başlatılan Windows PowerShell, devraldığı PSModulePath
    // yüzünden Get-Acl'in modülünü yükleyemeyebilir.
    "$a=(New-Object System.IO.DirectoryInfo $env:MODEL_EVAL_DIR).GetAccessControl();" +
    "'me='+[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;'owner='+$a.GetOwner($S).Value;" +
    "foreach($r in $a.GetAccessRules($true,$true,$S)){'ace='+$r.IdentityReference.Value}";
  const r = run(resolveExe('powershell'), ['-NoProfile', '-NonInteractive', '-Command', script],
    { cwd: os.homedir(), env: { ...process.env, MODEL_EVAL_DIR: dir } });
  const lines = r.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const me = (lines.find(l => l.startsWith('me=')) || '').slice(3);
  const owner = (lines.find(l => l.startsWith('owner=')) || '').slice(6);
  if (r.status !== 0 || !me || !owner) return `ACL could not be read (${(r.stderr || '').trim().slice(0, 120)})`;
  const allowed = new Set([me, 'S-1-5-18', 'S-1-5-32-544']);
  if (owner !== me && owner !== 'S-1-5-32-544') return `owned by ${owner}`;
  const other = lines.filter(l => l.startsWith('ace=')).map(l => l.slice(4)).find(sid => !allowed.has(sid));
  return other ? `ACL grants ${other}` : null;
}

function prepareCheckDir(work, after, ctx) {
  // Kök klasör, kontrol klasörü oluşturulmadan önce kilitlenir ve doğrulanır: yeni klasör kısıtlı
  // izinleri doğduğu anda miras alır, oluşturma ile kilitleme arasında başka bir sürecin yazabileceği
  // bir aralık kalmaz. Hazırlıktaki her sorun "ölçülmedi" değil başarısızlık sayılır (unsafe).
  const root = checkRoot();
  let dir, problem;
  try {
    fs.mkdirSync(root, { recursive: true });
    if (testHooks.beforeRootLock) testHooks.beforeRootLock(root); // yalnızca testler
    // Önce bağlantı olmadığı görülür (icacls bağlantının hedefine uygulanırdı), sonra kilitlenip doğrulanır.
    const rst = fs.lstatSync(root);
    if (rst.isSymbolicLink() || !rst.isDirectory()) return { unsafe: 'check root: not a plain directory' };
    lockDown(root);
    problem = privateDirProblem(root);
    if (problem) return { unsafe: `check root: ${problem}` };
    dir = fs.mkdtempSync(path.join(root, 'check-'));
    ctx.checkDir = dir; // kopyalama yarıda kalsa da temizlensin
    lockDown(dir);
    problem = privateDirProblem(dir);
    if (problem) return { dir, unsafe: `check dir: ${problem}` };
  } catch (e) {
    return { dir, unsafe: `check dir could not be prepared (${e.code || e.message})` };
  }
  if (testHooks.afterLockDown) testHooks.afterLockDown(dir); // yalnızca testler: araya giren bir süreci taklit eder
  // Kopyalamadan önce klasör boş olmalı: oraya bırakılmış bir bağlantı, yazmayı klasör dışına
  // yönlendirebilirdi; sonradan fark etmek, yazmanın olmasını engellemezdi.
  const early = fs.readdirSync(dir);
  if (early.length) return { dir, foreign: `${early[0]} (present before the copy)` };
  const copied = new Map();
  for (const [rel, hash] of after) {
    if (isCodexPath(rel) || hash === 'non-regular-entry') continue;
    const src = path.join(work, ...rel.split('/'));
    let st;
    try { st = fs.lstatSync(src, { throwIfNoEntry: false }); } catch (e) { return { dir, drift: `${rel} (unreadable: ${e.code || e.message})` }; }
    if (!st || !st.isFile() || st.nlink > 1) return { dir, drift: rel };
    let buf;
    try { buf = fs.readFileSync(src); } catch (e) { return { dir, drift: `${rel} (unreadable: ${e.code || e.message})` }; }
    if (crypto.createHash('sha256').update(buf).digest('hex') !== hash) return { dir, drift: rel };
    const dst = path.join(dir, ...rel.split('/'));
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, buf, { flag: 'wx' });
    } catch (e) { return { dir, foreign: `${rel} (copy failed: ${e.code || e.message})` }; }
    copied.set(rel, hash);
  }
  // Ek önlem: kopyadan sonra klasörde yalnızca kopyalanan dosyaların, aynı içerikle olduğu doğrulanır.
  // Hata (okunamayan dosya vb.) "ölçülmedi" değil, başarısızlık sayılır.
  if (testHooks.afterCopy) testHooks.afterCopy(dir);
  let got;
  try { got = snapshot(dir); } catch (e) { return { dir, foreign: `(unreadable: ${e.code || e.message})` }; }
  for (const [rel, hash] of got) if (copied.get(rel) !== hash) return { dir, foreign: rel };
  for (const rel of copied.keys()) if (!got.has(rel)) return { dir, foreign: `${rel} (missing)` };
  return { dir };
}

// Gizli kontrol dosyalarının kontrol klasöründeki yeri. Fixture'da bu adla bir şey olamaz (loadTasks denetler).
const HIDDEN_DIR = '__hidden__';

// Görevin hidden/ klasöründeki normal dosyaları kontrol klasörünün __hidden__/ alt klasörüne kopyalar
// (yalnızca yeni dosya: wx). Sorun varsa nedenini, yoksa null döndürür.
function copyHidden(task, dir) {
  const src = path.join(task.base, 'hidden');
  if (!fs.existsSync(src)) return null;
  try {
    for (const [rel, hash] of snapshot(src)) {
      if (hash === 'non-regular-entry') return `${rel}: not a regular file`;
      const dst = path.join(dir, HIDDEN_DIR, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, fs.readFileSync(path.join(src, ...rel.split('/'))), { flag: 'wx' });
    }
  } catch (e) { return e.code || e.message; }
  return null;
}

// Kontrol komutunun yazdığı __hidden__/results.json'u görevin verify/ klasöründeki doğrulayıcıyla denetler.
// Dosya model etkisindeki bir veridir: normal dosya, en çok 16 MB, yalnızca JSON.parse. Doğrulayıcı depodan
// (task.base) yüklenir, kontrol klasöründen değil.
const RESULTS_MAX = 16 * 1024 * 1024;
const RESULTS_MAX_DEPTH = 64;
const RESULTS_MAX_NODES = 2000000;
// JSON metnindeki dizi/nesne derinliğini ve toplam değer sayısını (ayraçlar ve virgüller) dizgi dışında, doğrusal
// zamanda sayar. Sınır aşılırsa nedenini, yoksa null döndürür.
function jsonShapeProblem(text) {
  let depth = 0, nodes = 0, inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inStr) { if (c === 92) i++; else if (c === 34) inStr = false; continue; }
    if (c === 34) inStr = true;
    else if (c === 91 || c === 123) { if (++depth > RESULTS_MAX_DEPTH) return `nested deeper than ${RESULTS_MAX_DEPTH}`; if (++nodes > RESULTS_MAX_NODES) return 'too many values'; }
    else if (c === 93 || c === 125) depth--;
    else if (c === 44 && ++nodes > RESULTS_MAX_NODES) return 'too many values';
  }
  return null;
}
// --- Birleşik diff (değişiklik kaydı) ---
const PATCH_MAX = 1024 * 1024;
const LCS_MAX = 4000000;
// Satırlar; dosya satır başıyla bitmiyorsa son satırın sonuna bir işaret (NUL) eklenir: "a" ile "a\n" farklı satırdır ve
// çıktıda "\ No newline at end of file" yazılır. NUL içeren metin ikili sayıldığı için işaret içerikle karışmaz.
const NOEOL = String.fromCharCode(0);
const splitLines = t => {
  const l = t.split('\n');
  if (l[l.length - 1] === '') l.pop(); else l[l.length - 1] += NOEOL;
  return l;
};
const PATCH_FILE_MAX = 512 * 1024;
const PATCH_LINES_MAX = 50000;
const countLines = t => { let n = 0; for (let i = t.indexOf('\n'); i >= 0; i = t.indexOf('\n', i + 1)) n++; return n; };

// İki metnin satır farkı: [' '|'-'|'+', satır] listesi. Ortak baş ve son kırpılır; kalan kısım küçükse LCS ile,
// büyükse bütünüyle silinmiş/eklenmiş sayılır (doğrusal bellek sınırı).
function lineOps(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const A = a.slice(p, a.length - q), B = b.slice(p, b.length - q);
  const ops = a.slice(0, p).map(l => [' ', l]);
  if (A.length * B.length > LCS_MAX) {
    for (const l of A) ops.push(['-', l]);
    for (const l of B) ops.push(['+', l]);
  } else {
    const n = A.length, m = B.length, w = m + 1;
    const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) { ops.push([' ', A[i]]); i++; j++; }
      else if (i < n && (j === m || L[(i + 1) * w + j] >= L[i * w + j + 1])) { ops.push(['-', A[i]]); i++; }
      else { ops.push(['+', B[j]]); j++; }
    }
  }
  for (const l of a.slice(a.length - q)) ops.push([' ', l]);
  return ops;
}

// Tek bir dosyanın birleşik diff'i (3 satır bağlam). oldText/newText null ise dosya yok sayılır. Fark yoksa ''.
function unifiedDiff(oldText, newText, name) {
  const bin = t => t !== null && t.includes(String.fromCharCode(0));
  const head = `--- ${oldText === null ? '/dev/null' : 'a/' + name}\n+++ ${newText === null ? '/dev/null' : 'b/' + name}\n`;
  if (oldText === newText) return '';
  if (bin(oldText) || bin(newText)) return `${head}Binary file ${name} differs\n`;
  const big = t => t !== null && (t.length > PATCH_FILE_MAX || countLines(t) > PATCH_LINES_MAX);
  if (big(oldText) || big(newText)) return `${head}(file too large for a diff: ${[oldText, newText].map(t => (t === null ? '-' : `${t.length} chars`)).join(' -> ')})\n`;
  const ops = lineOps(oldText === null ? [] : splitLines(oldText), newText === null ? [] : splitLines(newText));
  if (!ops.some(o => o[0] !== ' ')) return '';
  const C = 3;
  let out = head;
  let k = 0;
  while (k < ops.length) {
    while (k < ops.length && ops[k][0] === ' ') k++;
    if (k >= ops.length) break;
    let start = Math.max(0, k - C), end = k;
    for (;;) {
      while (end < ops.length && ops[end][0] !== ' ') end++;
      let e = end;
      while (e < ops.length && ops[e][0] === ' ' && e - end < 2 * C) e++;
      if (e < ops.length && ops[e][0] !== ' ') { end = e; continue; }
      end = Math.min(ops.length, end + C);
      break;
    }
    let oldBefore = 0, newBefore = 0;
    for (let i = 0; i < start; i++) { if (ops[i][0] !== '+') oldBefore++; if (ops[i][0] !== '-') newBefore++; }
    let oc = 0, nc = 0, body = '';
    for (let i = start; i < end; i++) {
      const [t, l] = ops[i];
      if (t !== '+') oc++;
      if (t !== '-') nc++;
      body += l.endsWith(NOEOL) ? `${t}${l.slice(0, -1)}\n\\ No newline at end of file\n` : `${t}${l}\n`;
    }
    out += `@@ -${oc ? oldBefore + 1 : oldBefore},${oc} +${nc ? newBefore + 1 : newBefore},${nc} @@\n` + body;
    k = end;
  }
  return out;
}

// Modelin değiştirdiği dosyalar için birleşik diff; yalnızca normal dosyalar okunur, toplam 1 MB ile sınırlı.
// Okunan dosya model çalışmasından hemen sonra alınan anlık görüntüyle (after: göreli yol -> SHA-256) aynı olmalıdır:
// sonradan değişen dosya kaydedilmez, not düşülür. Büyük dosyalar okunmadan özetlenir.
function changesPatch(fixture, work, changed, after) {
  // Dosya bir kez açılır ve açılan tanıtıcıdan en çok PATCH_FILE_MAX + 1 bayt okunur (yol yeniden açılmaz; FIFO ya da
  // bağlantı açılmaz): okuma sırasında dosya değişse de büyüse de bellek sınırlı kalır. Sonuç anlık görüntüyle karşılaştırılır.
  const C = fs.constants;
  const FLAGS = C.O_RDONLY | (C.O_NOFOLLOW || 0) | (C.O_NONBLOCK || 0);
  const read = (root, rel, check) => {
    const f = path.join(root, ...rel.split('/'));
    const snap = check && after ? after.get(rel) : undefined;
    const st = fs.lstatSync(f, { throwIfNoEntry: false });
    const regularNow = Boolean(st && st.isFile() && st.nlink <= 1);
    // Anlık görüntüdeki durumla karşılaştırılır: görüntüde normal bir dosya olan girdi kaybolduysa ya da türü
    // değiştiyse, görüntüde olmayan bir dosya sonradan belirdiyse kayıt yapılmaz.
    if (check && after && (snap === undefined ? Boolean(st) : snap === 'non-regular-entry' ? regularNow : !regularNow)) return { drift: true };
    if (!regularNow) return null;
    let fd;
    try {
      fd = fs.openSync(f, FLAGS);
      const fst = fs.fstatSync(fd);
      if (!fst.isFile() || fst.nlink > 1) return check && after ? { drift: true } : null;
      const buf = Buffer.alloc(PATCH_FILE_MAX + 1);
      let n = 0;
      for (let r; n < buf.length && (r = fs.readSync(fd, buf, n, buf.length - n, n)) > 0;) n += r;
      // Büyük dosyanın yalnızca özeti yazılır (içerik kaydedilmediği için anlık görüntüyle karşılaştırılmaz).
      if (n > PATCH_FILE_MAX) return { tooBig: true };
      const data = buf.subarray(0, n);
      if (check && after && snap !== crypto.createHash('sha256').update(data).digest('hex')) return { drift: true };
      return data.toString('utf8');
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  };
  let out = '';
  for (const rel of changed) {
    let part;
    try {
      const o = read(fixture, rel, false), n = read(work, rel, true);
      const odd = [o, n].find(x => x && typeof x === 'object');
      part = odd ? `--- a/${rel}\n+++ b/${rel}\n(${odd.drift ? 'changed after the model run; not recorded' : `file too large for a diff: more than ${PATCH_FILE_MAX} bytes`})\n` : unifiedDiff(o, n, rel);
    } catch (e) { part = `--- ${rel}\n(could not be read: ${e.code || e.message})\n`; }
    if (out.length + part.length > PATCH_MAX) { out += `(patch truncated at ${PATCH_MAX} bytes; remaining files: ${changed.slice(changed.indexOf(rel)).join(', ')})\n`; break; }
    out += part;
  }
  return out;
}

// Kontrol klasöründeki bir sonuç dosyasını güvenli biçimde okur: { data } ya da { failure }.
function readResultsFile(dir, name) {
  const f = path.join(dir, HIDDEN_DIR, name);
  let st;
  try { st = fs.lstatSync(f); } catch { return { failure: `no ${name} (the check stopped before writing its results)` }; }
  if (!st.isFile() || st.nlink > 1 || st.size > RESULTS_MAX) return { failure: `${name} is not a regular file of acceptable size` };
  const text = fs.readFileSync(f, 'utf8');
  // Boyut sınırı bayt sayar, nesne sayısını ve derinliği değil: sıkışık bir JSON milyonlarca iç içe nesneye açılıp
  // bu süreci (kontrolün süre sınırı dışında) durdurabilirdi. Ayrıştırmadan önce biçim taranır.
  const shape = jsonShapeProblem(text);
  if (shape) return { failure: `${name} rejected: ${shape}` };
  try { return { data: JSON.parse(text) }; } catch { return { failure: `${name} is not valid JSON` }; }
}

// Ana kontrol komutunu ve adımları (check.steps) sırayla çalıştırır. Her süreç kendi temiz klasöründe çalışır
// (dirs(i): modelin çıktısının anlık görüntüsü ve gizli dosyaların temiz kopyası): bir süreç sonraki bir sürecin
// dosyalarını, toplayıcısını ya da sonucunu değiştiremez. Her sürecin sonucu kendi klasöründen, süreç biter bitmez okunur.
// dirs(i) => { dir } | { skip: neden } | { env: neden }; runOne(command, timeoutMs, dir) => { passed, timedOut, sandboxError }.
function runChecks(task, dirs, runOne) {
  const out = { passed: false };
  const steps = Array.isArray(task.check.steps) ? task.check.steps : [];
  const procs = [{ command: task.check.command, timeoutMs: task.check.timeoutMs, results: 'results.json' },
    ...steps.map((st, i) => ({ command: st.command, timeoutMs: st.timeoutMs, results: `results-step${i}.json`, step: i }))];
  const data = [];
  for (const p of procs) {
    const d = dirs(data.length);
    if (d.env) return { environmentError: d.env };
    if (d.skip) return { checkSkipped: d.skip };
    const c = runOne(p.command, p.timeoutMs, d.dir);
    if (c.sandboxError) return { sandboxError: c.sandboxError };
    if (!c.passed) {
      if (c.timedOut) { out.timedOut = true; if (p.step !== undefined) out.stepTimedOut = p.step; }
      else if (p.step !== undefined) out.stepFailed = p.step;
      return out;
    }
    data.push(task.check.verify ? readResultsFile(d.dir, p.results) : { data: null });
  }
  if (!task.check.verify) { out.passed = true; return out; }
  const failure = data.find(r => r.failure);
  if (failure) { out.verifyFailures = [failure.failure]; return out; }
  const v = verifyData(task, steps.length ? { main: data[0].data, steps: data.slice(1).map(r => r.data) } : data[0].data);
  out.passed = v.ok;
  if (!v.ok) out.verifyFailures = v.failures.slice(0, 20);
  return out;
}

// Doğrulayıcı (verify/, depodan yüklenir) adım yoksa ana sonucu, varsa { main, steps } alır.
function verifyData(task, data) {
  const verifier = require(path.join(task.base, 'verify', path.basename(task.check.verify)));
  let r;
  try { r = verifier.verify(data); } catch (e) { return { ok: false, failures: [`verifier rejected the results: ${e && e.message}`] }; }
  return { ok: Boolean(r && r.ok === true), failures: Array.isArray(r && r.failures) ? r.failures.map(String) : [] };
}

// codex sandbox -C <dir>, üst klasörlerdeki .codex/ ayarlarını proje ayarı olarak okuyabilir. Ev
// klasörünün altındaki üst klasörlerde .codex/ varsa kontrol çalışmaz. Ev klasörünün kendisindeki
// ~/.codex Codex'in kendi ayar klasörüdür (CODEX_HOME) ve beklenir.
function codexConfigAbove(dir) {
  const home = path.resolve(os.homedir());
  for (let p = path.dirname(path.resolve(dir)); ; p = path.dirname(p)) {
    const rel = path.relative(home, p);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (fs.existsSync(path.join(p, '.codex'))) return p;
    if (path.dirname(p) === p) return null;
  }
}

// Bir komutu `codex sandbox -P :workspace -C <work>` içinde çalıştırır (işletim sistemi düzeyinde
// yazma kısıtı; bu makinedeki unelevated Windows sandbox'ı TEMP'e yazmaya izin verir, okumayı ve
// ağı kısıtlamaz — bkz. README "Bilinen sınırlar").
function sandboxed(work, exe, args, timeout, input) {
  const sb = (testHooks.sandboxCommand || testHooks.codexCommand || codexCommand)();
  const argv = [...sb.pre, 'sandbox', '-P', ':workspace', '-C', work, exe, ...args];
  if (IS_WIN) return run(sb.cmd, argv, { cwd: work, timeout, input });
  if (input === undefined) return runGroup(sb.cmd, argv, { cwd: work, timeout });
  // Linux: spawnSync'in `input`'u alt sürece socketpair olarak verilir; codex'in Linux sandbox'ı
  // içindeki node bu soketi okuyamaz (betik ulaşmaz, `node -` boş betik çalıştırır). Girdi bu yüzden
  // çalışma klasörünün dışındaki geçici bir dosyadan, normal dosya tanımlayıcısı olarak verilir.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-stdin-'));
  const file = path.join(dir, 'stdin');
  let fd;
  try {
    fs.writeFileSync(file, input, { mode: 0o600 });
    fd = fs.openSync(file, 'r');
    return runGroup(sb.cmd, argv, { cwd: work, timeout, stdio: [fd, 'pipe', 'pipe'] });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Windows dışı: komutu kendi süreç grubunda başlatır ve dönünce grubu öldürür. Zaman aşımında spawnSync
// yalnızca doğrudan çocuğu (codex'in npm sarmalayıcısı) öldürür; codex-linux-sandbox sahipsiz kalır,
// bwrap --die-with-parent onu beklediği için sandbox'ta takılan kontrol süreci sonsuza dek yaşardı.
// Grup, sarmalayıcı ve sandbox sürecini kapsar; bwrap kendi oturumunda olsa da ebeveyniyle ölür.
function runGroup(cmd, args, opts) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, ...opts, detached: true });
  if (r.pid) try { process.kill(-r.pid, 'SIGKILL'); } catch {} // ESRCH: grupta süreç kalmamış
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

// Görevin kontrol komutunu modelin yazdığı klasörde, iki katmanlı yalıtımla çalıştırır:
// 1. codex sandbox (sandboxed()).
// 2. Komut node ise Node izin modeli: okuma ve yazma yalnızca çalışma klasörü; ağ, alt süreç,
//    worker ve native eklenti kapalı. Node bunu "seat belt" olarak tanımlar, tam yalıtım değildir.
// Önce sandbox'ın açıldığı, model kodundan bağımsız zararsız bir komutla (node -e 0) sınanır;
// açılmazsa sonuç ölçülmemiş sayılır ve yalıtımsız çalıştırmaya geri dönülmez. Asıl kontrolde
// karar yalnızca çıkış kodundadır (modelin kodu çıktıya ne yazarsa yazsın); zaman aşımı başarısızlıktır.
const PROBE_OK = 42;

function runCheck(command, work, timeout = 60000) {
  const probe = sandboxed(work, process.execPath, ['-e', '0'], 30000);
  if (probe.error || probe.status !== 0) {
    const why = probe.error ? probe.error.message : `${probe.stderr}`.trim().split(/\r?\n/).pop();
    return { sandboxError: String(why || `exit ${probe.status}`).slice(0, 160) };
  }
  const [cmd, ...rest] = command.split(' ');
  const exe = cmd === 'node' ? process.execPath : resolveExe(cmd);
  const permission = ['--permission', `--allow-fs-read=${work}`, `--allow-fs-write=${work}`];
  if (cmd === 'node') {
    // Ağ kısıtı Node izin modelinin yeni bir parçası; eski sürümler bayrakları kabul edip ağı açık
    // bırakır. process.permission.has('net') buna güvenilecek bir işaret değildir (Node tanımadığı
    // kapsamlar için de false döndürür). Bu yüzden davranış sınanır: aynı bayraklarla bir ağ bağlantısı
    // ve bir alt süreç açmak denenir; ikisi de ERR_ACCESS_DENIED ile reddedilmelidir.
    const denied = 'const D=e=>e&&e.code==="ERR_ACCESS_DENIED";' +
      'try{require("child_process").spawnSync(process.execPath,["-e","0"]);process.exit(3)}catch(e){if(!D(e))process.exit(3)}' +
      `let s;try{s=require("net").connect(9,"127.0.0.1")}catch(e){process.exit(D(e)?${PROBE_OK}:3)}` +
      `s.on("error",e=>process.exit(D(e)?${PROBE_OK}:3));s.on("connect",()=>process.exit(3));setTimeout(()=>process.exit(3),5000);`;
    // Betik komut satırı yerine standart girdiden verilir (`node -`): bu makinede komut satırında
    // child_process + net taşıyan iç içe bir süreç başlatma, virüs koruması tarafından EPERM ile
    // engelleniyordu (2026-11-07). Başarı 0 değil PROBE_OK ile bildirilir: betik standart girdiden
    // ulaşmazsa `node -` boş betiği çalıştırıp 0 döner ve deneme hiçbir şey sınamadan geçerdi.
    const flagKnown = process.allowedNodeEnvironmentFlags.has('--allow-net');
    const p = flagKnown && sandboxed(work, process.execPath, [...permission, '-'], 30000, denied);
    if (!flagKnown || p.error || p.status !== PROBE_OK) {
      return { sandboxError: 'Node permission model does not restrict network and child processes in this Node version' };
    }
  }
  const args = cmd === 'node' ? [...permission, ...rest] : rest;
  const r = sandboxed(work, exe, args, timeout);
  if (r.error && r.error.code === 'ETIMEDOUT') return { passed: false, timedOut: true };
  return { passed: !r.error && r.status === 0 };
}

function evaluate(a, task, outDir) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-'));
  const lastMsgFile = work + '.last.md';
  const ctx = {};
  let result;
  try {
    result = evaluateIn(a, task, outDir, work, lastMsgFile, ctx);
  } catch (e) {
    result = { id: task.id, run: task.run || 1, error: String(e && e.message), pass: null };
  }
  // Zaman aşımından sonra codex'in alt süreci klasörü bir süre tutabilir (Windows'ta EBUSY).
  // rmSync bağlantıları izlemez: bağlantının kendisini siler, hedefini değil.
  try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { result.leftoverDir = work; }
  for (const c of [ctx, ...(ctx.extraCheckDirs || [])]) {
    if (!c.checkDir) continue;
    try { fs.rmSync(c.checkDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { result.leftoverCheckDir = c.checkDir; }
  }
  try { fs.rmSync(lastMsgFile, { force: true }); } catch {}
  return result;
}

// Deneme dosyalarının adı: 1. deneme <görev>.md (eski sonuçlarla aynı), sonrakiler <görev>.run<n>.md.
const answerStem = task => (task.run > 1 ? `${task.id}.run${task.run}` : task.id);

function evaluateIn(a, task, outDir, work, lastMsgFile, ctx) {
    const stem = answerStem(task);
    const fixture = path.join(task.base, 'fixture');
    const before = snapshot(fixture);
    fs.cpSync(fixture, work, { recursive: true });

    const isClaude = a.provider === 'claude';
    const args = isClaude ? claudeArgs(a, task) : codexArgs(a, task, work, lastMsgFile);
    if (a.dryRun) return { id: task.id, run: task.run || 1, dryRun: true, command: [isClaude ? 'claude' : 'codex', ...args].join(' ') };

    const cli = isClaude ? (testHooks.claudeCommand || claudeCommand)() : (testHooks.codexCommand || codexCommand)();
    const t0 = Date.now();
    // Claude Code çalışma klasörünü cwd'den alır (Codex -C ile).
    const r = run(cli.cmd, [...cli.pre, ...args], { input: task.prompt, timeout: (task.timeoutSec || 600) * 1000, ...(isClaude ? { cwd: work } : {}) });
    const durationMs = Date.now() - t0;
    let answer = '';
    let claudeOut = null;
    if (isClaude) {
      claudeOut = parseClaudeOutput(r.stdout);
      if (claudeOut && !claudeOut.is_error && typeof claudeOut.result === 'string') answer = claudeOut.result;
    } else {
      try { answer = fs.readFileSync(lastMsgFile, 'utf8'); } catch {}
    }
    // Sonuçlar depoya kanıt olarak girer: yerel yollar (kullanıcı adı) yer tutucuyla değiştirilir.
    // Puanlama da kaydedilen metin üzerinden yapılır ki sonradan yeniden üretilebilsin.
    answer = redactLocalPaths(answer, work);
    fs.writeFileSync(path.join(outDir, `${stem}.md`), answer);
    // codex exec hata verdiyse son çıktısı (stderr) teşhis için saklanır; yerel yollar ve token biçimli
    // değerler gizlenir. Başarılı bir tekrar, önceki denemeden kalan dosyayı siler (sonuç klasörü aynı gün
    // yeniden kullanılır).
    // Claude: süreç başarılı çıksa da JSON okunamadıysa ya da is_error varsa model çalışmamıştır.
    const codexFailed = Boolean(r.error) || r.status !== 0 || (isClaude && (!claudeOut || claudeOut.is_error === true));
    const stderrFile = path.join(outDir, `${stem}.stderr.txt`);
    // Claude hatayı stdout'taki JSON'da bildirir (örn. "API Error: overloaded"); JSON okunamadıysa stdout'un
    // sonu saklanır. Bu metin cevaba girmez, yalnızca tanı dosyasına yazılır.
    // Bazı hata türleri result metni yerine subtype ve errors alanlarıyla gelir; o zaman bunların özeti yazılır.
    const claudeDetail = j => (typeof j.result === 'string' && j.result
      ? j.result
      // Yollar JSON'a çevrilmeden önce gizlenir: JSON \ karakterini çiftler, sonra yol tanınmaz.
      : JSON.stringify(redactDeep({ subtype: j.subtype, is_error: j.is_error, result: j.result, errors: j.errors }, work)));
    const claudeDiag = !isClaude ? '' : claudeOut ? `claude -p result: ${claudeDetail(claudeOut).slice(0, 4000)}\n` : `claude -p stdout (unparsed): ${r.stdout.slice(-4000)}\n`;
    if (codexFailed) fs.writeFileSync(stderrFile, maskSecrets(redactLocalPaths(claudeDiag + r.stderr.slice(-8000), work)));
    else fs.rmSync(stderrFile, { force: true });

    let files;
    try { files = changedFiles(before, work, isClaude); } catch (e) {
      // Model çalışmasından sonra okunamayan bir girdi: sonuç "ölçülmedi" değil başarısızlıktır.
      return { id: task.id, kind: task.kind, exitStatus: r.status, durationMs, pass: false,
        error: `work dir unreadable after the model run (${e.code || e.message})` };
    }
    const { model: changed, harness, links, after } = files;
    // linksLeft: zaman aşımı tekrarı kararı için (bağlantı bırakan model kural ihlalidir).
    if (testHooks.afterSnapshot) testHooks.afterSnapshot(work); // yalnızca testler: geride kalan bir süreci taklit eder
    const result = { id: task.id, run: task.run || 1, kind: task.kind, exitStatus: r.status, durationMs, usage: isClaude ? claudeUsage(claudeOut) : lastUsage(r.stdout), changed, harnessFiles: harness };
    if (links.length) result.linksLeft = true;
    // Değişiklik kaydı: modelin değiştirdiği normal dosyaların temiz fixture'a göre birleşik diff'i (<deneme>.patch).
    // Kod kalitesi kör puanlanırken puanlayıcı yalnızca son mesajı değil yapılan değişikliği de görür.
    const patch = changesPatch(fixture, work, changed, after);
    const patchFile = path.join(outDir, `${stem}.patch`);
    if (patch) { fs.writeFileSync(patchFile, redactLocalPaths(patch, work)); result.patchFile = `${stem}.patch`; }
    else fs.rmSync(patchFile, { force: true });
    if (task.mustNotModify) result.readOnlyOk = changed.length === 0;
    if (task.protected) result.protectedOk = !task.protected.some(p => changed.includes(p));
    // Codex son mesaj yazmadan hata koduyla çıktıysa (API ya da oturum hatası) model değerlendirilemedi:
    // sonuç "ölçülmedi"dir, görev yeniden çalıştırılır. Zaman aşımı burada başarısızlık olarak işaretlenir;
    // ilk zaman aşımını "ölçülmedi" sayıp denemeyi bir kez yineleyen kural withTimeoutRetry'dadır. Kural ihlali (salt okunur ya da korunan dosya, bırakılan bağlantı) varsa da sonuç
    // başarısızlıktır.
    if (r.error && r.error.code === 'ETIMEDOUT') result.timedOut = true;
    else if (codexFailed && !answer.trim() && result.readOnlyOk !== false && result.protectedOk !== false && !links.length) {
      const how = r.error ? `failed (${r.error.code || r.error.message})` : `exited ${r.status}`;
      const cliName = isClaude ? 'claude -p' : 'codex exec';
      const claudeErr = isClaude && claudeOut && claudeOut.is_error ? ' (is_error)' : '';
      result.environmentError = `${cliName} ${how}${claudeErr} without a final message; not a model result. See ${stem}.stderr.txt and rerun.`;
      result.pass = null;
      return result;
    }
    if (task.check && result.timedOut) {
      // Model süreyi aştı: yarım kalmış kod çalıştırılmaz. Deneme ya yinelenir ya da başarısız sayılır
      // (withTimeoutRetry); her iki durumda da bu kontrolün sonucu kullanılmazdı.
      result.checkPassed = false;
      result.checkNotRun = 'model timed out';
    } else if (task.check) {
      // Kontrol modelin yazdığı kodu yükler; bu yüzden yalıtılmış çalışır (runCheck).
      // Korunan dosyalar değiştiyse hiç çalıştırılmaz.
      if (result.protectedOk === false) {
        result.checkPassed = false;
        result.checkSkipped = 'protected files changed';
      } else if (links.length) {
        // Model bir bağlantı bıraktıysa kontrol klasör dışına erişebilir: çalıştırılmaz, başarısız sayılır.
        result.checkPassed = false;
        result.checkSkipped = `links in work dir: ${links.slice(0, 5).join(', ')}`;
      } else {
        // Kontrol, modelin yazdığı normal dosyaların kopyasıyla ayrı bir klasörde çalışır (prepareCheckDir).
        const prep = prepareCheckDir(work, after, ctx);
        const above = !prep.unsafe && !prep.drift && !prep.foreign && codexConfigAbove(prep.dir);
        if (prep.unsafe) {
          result.checkPassed = false;
          result.checkSkipped = `check dir not usable: ${prep.unsafe}`;
        } else if (prep.drift) {
          result.checkPassed = false;
          result.checkSkipped = `work dir changed after the model run: ${prep.drift}`;
        } else if (prep.foreign) {
          result.checkPassed = false;
          result.checkSkipped = `check dir has unexpected content: ${prep.foreign}`;
        } else if (above) {
          result.environmentError = `Codex config found above the check dir (${above}); not a model result.`;
          result.pass = null;
          return result;
        } else if (fs.readdirSync(prep.dir).some(n => n.toLowerCase() === '.codex')) {
          // Kopyalama .codex'i dışarıda bırakır; yine de varsa (harf farkı vb.) kontrol çalışmaz.
          result.checkPassed = false;
          result.checkSkipped = 'codex config in the check dir';
        } else if (fs.existsSync(path.join(task.base, 'hidden')) && [...after.keys()].some(rel => rel.split('/')[0].toLowerCase() === HIDDEN_DIR)) {
          // Model gizli test klasörünün adıyla bir şey bıraktı: gizli test yerine kendi dosyası çalışabilirdi.
          result.checkPassed = false;
          result.checkSkipped = `model wrote ${HIDDEN_DIR}/ (reserved for hidden checks)`;
        } else {
          // Gizli kontrol dosyaları (görevin hidden/ klasörü) modelin göremediği, yalnızca kontrol klasörüne
          // model çalışmasından sonra konan dosyalardır: model testi görüp ona göre kod yazamaz.
          const hiddenProblem = copyHidden(task, prep.dir);
          if (hiddenProblem) {
            result.environmentError = `hidden check files could not be copied (${hiddenProblem}); not a model result.`;
            result.pass = null;
            return result;
          }
          // Ana kontrol ve adımlar (check.steps): her biri ayrı bir süreçte, dışarıdan uygulanan süre sınırıyla; karar
          // depodaki doğrulayıcıyla (check.verify) bu süreçte verilir (runChecks).
          // İlk süreç hazırlanmış klasörde; sonraki her süreç için aynı denetimlerle yeni bir klasör hazırlanır.
          const dirFor = i => {
            if (i === 0) return { dir: prep.dir };
            const sub = {};
            (ctx.extraCheckDirs || (ctx.extraCheckDirs = [])).push(sub);
            const p = prepareCheckDir(work, after, sub);
            if (p.unsafe) return { skip: `check dir not usable: ${p.unsafe}` };
            if (p.drift) return { skip: `work dir changed after the model run: ${p.drift}` };
            if (p.foreign) return { skip: `check dir has unexpected content: ${p.foreign}` };
            const above = codexConfigAbove(p.dir);
            if (above) return { env: `Codex config found above the check dir (${above}); not a model result.` };
            const hp = copyHidden(task, p.dir);
            if (hp) return { env: `hidden check files could not be copied (${hp}); not a model result.` };
            return { dir: p.dir };
          };
          const c = runChecks(task, dirFor, (command, ms, dir) => runCheck(command, dir, testHooks.checkTimeoutMs || ms));
          if (c.environmentError) {
            result.environmentError = c.environmentError;
            result.pass = null;
            return result;
          }
          if (c.checkSkipped) {
            result.checkPassed = false;
            result.checkSkipped = c.checkSkipped;
          }
          if (c.sandboxError) {
            result.environmentError = `Check sandbox could not start (${c.sandboxError}); not a model result.`;
            result.pass = null;
            return result;
          }
          if (!c.checkSkipped) result.checkPassed = c.passed;
          if (c.timedOut) result.checkTimedOut = true;
          if (c.stepTimedOut !== undefined) result.stepTimedOut = c.stepTimedOut;
          if (c.stepFailed !== undefined) result.stepFailed = c.stepFailed;
          if (c.verifyFailures) result.verifyFailures = c.verifyFailures;
        }
      }
    }
    if (task.expect) {
      result.hits = task.expect.filter(e => new RegExp(e.pattern, 'i').test(answer)).map(e => e.id);
      result.misses = task.expect.map(e => e.id).filter(id => !result.hits.includes(id));
    }
    // Güvenli koda (tuzak satırlar) yapılan file:line atıfları olası yanlış pozitiflerdir. Yalnızca
    // bilgi içindir, geçme kuralına girmez; kararı görevin rubric.md'sine göre yapılan puanlama verir.
    if (task.decoys) result.decoyCitations = decoyCitations(answer, task.decoys);
    // Sandbox açılamadıysa model hiç çalışamamıştır; bu bir model başarısızlığı sayılmaz.
    // Bu ifade modelin kendi cevabından okunur; kural ihlali, zaman aşımı ya da kontrol klasörünün
    // bütünlük denetimine takılma (checkSkipped) varsa sonucu "ölçülmedi"ye çeviremez. Başarısız ya da
    // süreyi aşan bir kontrol yalnızca model hiçbir dosyayı değiştirmediyse gerçek bir sandbox arızası
    // sayılır (kontrol özgün kod üzerinde düşmüştür); yanlış bir düzenleme yapıp sandbox'ı bahane eden
    // model başarısızdır. Kontrol runner'ın kendi sandbox'ında çalışır, modelinkinde değil.
    const checkFailed = result.checkPassed === false || Boolean(result.checkTimedOut);
    // Yalnızca Codex: Claude modellerine kabuk verilmez, bu ifadeyi taşıyan bir Claude cevabı gerçek bir
    // sandbox arızası olamaz.
    if (!isClaude && /sandbox backend (was |is )?unavailable|shell backend (failed|returned an error)/i.test(answer) &&
        result.readOnlyOk !== false && result.protectedOk !== false && !links.length &&
        !result.timedOut && !result.checkSkipped && (!checkFailed || changed.length === 0)) {
      result.environmentError = 'Codex sandbox could not start; rerun after fixing the sandbox. Not a model result.';
      result.pass = null;
      return result;
    }
    result.pass = r.status === 0 && result.readOnlyOk !== false && result.protectedOk !== false &&
      result.checkPassed !== false && !(result.misses && result.misses.length);
    return result;
}

// Aynı gün aynı model ve eforla yapılmış önceki çalıştırmanın summary.json'undaki görev sonuçlarını
// döndürür (sonuç klasörü aynıdır). Katman ya da cyber programı farklıysa karıştırmamak için durur.
function previousResults(outDir, a, taskVersions) {
  const f = path.join(outDir, 'summary.json');
  let s;
  try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
  if (s.model !== a.model || s.effort !== a.effort || s.tier !== a.tier || (s.cyberAccessProgram || null) !== (a.cyber || null)) {
    throw new Error(`${path.basename(outDir)}/summary.json başka bir çalıştırmaya ait (katman ya da cyber programı farklı); klasörü taşıyıp yeniden çalıştır`);
  }
  // Tekrar sayısı, bölüm ve görev sürümleri de aynı olmalı: farklı bir çalıştırmanın denemeleri (fazladan
  // tekrarlar, başka bölümün ya da eski sürümün görevleri) yeni özete karışmasın. run alanı olmayan eski
  // özetler 1 tekrar ve bölümsüz sayılır.
  const old = { repeats: s.repeats === undefined ? 1 : s.repeats, split: s.split || null };
  if (old.repeats !== (a.repeats || 1) || old.split !== (a.split || null)) {
    throw new Error(`${path.basename(outDir)}/summary.json başka bir çalıştırmaya ait (tekrar sayısı ya da bölüm farklı); klasörü taşıyıp yeniden çalıştır`);
  }
  // Sürüm bilgisi olmayan (v2 öncesi) bir özete sürümlü ya da bölümlü görevler eklenmez.
  if (taskVersions && !s.taskVersions && Array.isArray(s.tasks) && s.tasks.length &&
      Object.values(taskVersions).some(v => v.version !== null || v.split !== null)) {
    throw new Error(`${path.basename(outDir)}/summary.json sürüm bilgisi olmayan eski bir çalıştırmaya ait; klasörü taşıyıp yeniden çalıştır`);
  }
  if (taskVersions && s.taskVersions) {
    for (const [id, v] of Object.entries(taskVersions)) {
      const o = s.taskVersions[id];
      if (o && (o.version !== v.version || o.split !== v.split)) {
        throw new Error(`${path.basename(outDir)}/summary.json: ${id} görevinin başka bir sürümüne ait; klasörü taşıyıp yeniden çalıştır`);
      }
    }
  }
  return Array.isArray(s.tasks) ? s.tasks : [];
}

// Ölçülmüş bir deneme (pass true ya da false) asla yeniden çalıştırılmaz ve değiştirilmez: denemeleri seçerek
// yeniden ölçüp istenen sonucu bekleme yolu kapalıdır; eski notlar da o cevaplara ait kalır. Yeniden çalıştırma
// yalnızca eksik ya da ölçülmemiş (pass null) denemeleri doldurur. Yeniden ölçmek için yeni bir sonuç klasörü
// gerekir (klasörü taşı).
function attemptsToRun(previous, tasks, repeats) {
  const measured = new Set(previous.filter(r => r.pass === true || r.pass === false).map(r => `${r.id}#${r.run || 1}`));
  const out = [];
  for (const task of tasks) for (let run = 1; run <= repeats; run++) if (!measured.has(`${task.id}#${run}`)) out.push({ task, run });
  return out;
}

// Aynı sonuç klasöründe aynı anda tek çalıştırma: iki çalıştırma aynı eksik denemeleri hesaplayıp birbirinin
// cevabını ve özetini ezebilirdi. Kilit dosyası wx ile oluşturulur; çalıştırma bitince (hata dahil) silinir.
// Süreç öldürülürse kilit kalır: başka çalıştırma olmadığından emin olunca .lock elle silinir.
function acquireLock(outDir) {
  const f = path.join(outDir, '.lock');
  try { fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' }); } catch (e) {
    if (e.code === 'EEXIST') throw new Error(`${path.basename(outDir)}: başka bir çalıştırma sürüyor ya da yarım kaldı (.lock); başka çalıştırma olmadığından eminsen .lock'u sil`);
    throw e;
  }
  return () => fs.rmSync(f, { force: true });
}

// Sonuç kökündeki runs.jsonl: her çalıştırmanın başlangıç ve bitişi (yalnızca eklenir). Bir modelin bütün
// ölçümleri buradan görülür; karar yazısında hepsi listelenir, yalnızca iyi çıkanı değil.
function logRun(root, entry) {
  fs.appendFileSync(path.join(root, 'runs.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

function previousTaskVersions(outDir) {
  try { return JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8')).taskVersions || {}; } catch { return {}; }
}

// Tekrar edilen görevin yeni sonucu eskisinin yerine geçer; eski deneme previousAttempts altında kalır,
// diğer görevlerin sonuçları korunur (ör. "ölçülmedi" bir görev --task ile yeniden çalıştırıldığında).
// Deneme kimliği görev + deneme numarasıdır; run alanı olmayan eski sonuçlar 1. deneme sayılır.
const sameAttempt = (x, r) => x.id === r.id && (x.run || 1) === (r.run || 1);
function mergeResult(results, r) {
  const i = results.findIndex(x => sameAttempt(x, r));
  if (i < 0) return [...results, r];
  const { previousAttempts = [], ...old } = results[i];
  return results.map((x, j) => (j === i ? { ...r, previousAttempts: [...previousAttempts, old] } : x));
}

// Özetin görev sayısı: kaydedilmiş ve bu çalıştırmada planlanan görevlerin birleşimi. Yarıda kalan bir
// çalıştırmanın özeti tamamlanmış görünmesin (sonuç her görevden sonra yazılır).
function summaryTotal(results, tasks, repeats = 1) {
  const planned = tasks.flatMap(t => Array.from({ length: repeats }, (_, k) => `${t.id}#${k + 1}`));
  return new Set([...results.map(r => `${r.id}#${r.run || 1}`), ...planned]).size;
}

// Zaman aşımı kuralı: bir denemenin ilk zaman aşımı "ölçülmedi"dir (API ya da sandbox takılması modelin
// suçu değildir) ve deneme bir kez yeniden çalışır; aynı denemede ikinci zaman aşımı model başarısızlığıdır.
// Zaman aşımıyla birlikte kural ihlali varsa (salt okunur, korunan dosya, bırakılan bağlantı) yeniden
// çalıştırılmaz, başarısızlık kalır. Kontrol komutunun zaman aşımı (checkTimedOut: modelin kodu takıldı)
// bu kurala girmez. İlk denemenin sonucu timeoutRetries altında kalır; cevap dosyası son denemenindir.
// Kontrolün zaman aşımı ya da bütünlük denetimine takılması (checkSkipped) da modelin sonucudur; zaman
// aşımıyla gelse de deneme yinelenmez. Modelin süreyi aştığı denemede kontrol hiç çalıştırılmaz (checkNotRun).
const isRuleViolation = r => r.readOnlyOk === false || r.protectedOk === false || r.linksLeft === true ||
  r.checkTimedOut === true || Boolean(r.checkSkipped);
// priorTimeouts: aynı denemenin daha önceki çalıştırmalarında (devam ettirilen ölçülmemiş deneme) kaç zaman
// aşımı olduğu. Hak deneme başına birdir; devam ettirmek onu sıfırlamaz.
function priorTimeouts(prev) {
  if (!prev) return 0;
  const one = r => (r.timedOut ? 1 : 0) + (Array.isArray(r.timeoutRetries) ? r.timeoutRetries.length : 0);
  return one(prev) + (Array.isArray(prev.previousAttempts) ? prev.previousAttempts.reduce((s, p) => s + one(p), 0) : 0);
}
function withTimeoutRetry(runOnce, beforeRetry, prior = 0) {
  const first = runOnce();
  if (!first.timedOut || isRuleViolation(first)) return first;
  if (prior >= 1) return { ...first, pass: false, timedOutTwice: true };
  const firstAttempt = { ...first, pass: null, timeoutUnmeasured: true };
  // İlk denemenin cevap ve tanı dosyaları yeniden denemenin üstüne yazmasın diye saklanır.
  if (beforeRetry) beforeRetry();
  const second = runOnce();
  if (second.timedOut) return { ...second, pass: false, timedOutTwice: true, timeoutRetries: [firstAttempt] };
  return { ...second, timeoutRetries: [firstAttempt] };
}

// Kayıtta onaylı security rolündeki model (örn. Daybreak) yalnızca güvenlik görevleriyle ve kayıttaki
// cyber programıyla ölçülür: model-guard bu çalıştırıcıyı görmez (codex'i kendisi başlatır), bu yüzden
// rol sınırı burada uygulanır. Kayıt yalnızca hesabın gerçek ev klasöründen okunur: çalıştırıcının ortamını
// komut belirler; os.homedir() HOME/USERPROFILE'ı izler, os.userInfo() izlemez. Ortam değişkeniyle başka
// bir kayıt verilemez. Kayıt okunamazsa çalıştırma durur (fail-closed).
function registryPath() {
  return testHooks.registryPath || path.join(os.userInfo().homedir, '.claude', 'models', 'registry.json');
}
function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(registryPath(), 'utf8')); } catch (e) {
    throw new Error(`model registry could not be read (${registryPath()}); the security-role check cannot run`);
  }
}
function securityRoleProblem(a, tasks, registry) {
  const codex = (registry && registry.codex) || {};
  const e = Object.prototype.hasOwnProperty.call(codex, a.model) && codex[a.model];
  if (!e || e.status !== 'approved' || e.role !== 'security') return null;
  if (a.cyber !== e.cyberAccessProgram) return `${a.model} has the security role: use --cyber-access-program ${e.cyberAccessProgram}`;
  const other = tasks.filter(t => !Array.isArray(t.roles) || !t.roles.includes('security')).map(t => t.id);
  if (other.length) return `${a.model} has the security role and is measured only on security tasks; not: ${other.join(', ')} (use --task)`;
  return null;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const tasks = loadTasks(a.task, a.split, a.tasksDir);
  if (!tasks.length) throw new Error('görev bulunamadı');
  const roleIssue = securityRoleProblem(a, tasks, loadRegistry());
  if (roleIssue) throw new Error(roleIssue);
  const stamp = new Date().toISOString().slice(0, 10);
  const resultsRoot = a.resultsDir || (a.tasksDir ? path.join(path.dirname(a.tasksDir), 'results') : path.join(ROOT, 'results'));
  const outDir = path.join(resultsRoot, `${stamp}-${a.model}-${a.effort}${a.cyber ? `-${a.cyber}` : ''}${a.split ? `-${a.split}` : ''}`);
  if (!a.dryRun) fs.mkdirSync(outDir, { recursive: true });
  const taskVersions = Object.fromEntries(tasks.map(t => [t.id, { split: t.split || null, version: t.version || null }]));
  let results = a.dryRun ? [] : previousResults(outDir, a, taskVersions);
  // Tek görevlik tekrar (--task) öteki görevlerin sonuçlarını korur; onların sürüm bilgisi de korunur.
  if (!a.dryRun) Object.assign(taskVersions, { ...previousTaskVersions(outDir), ...taskVersions });
  const summarize = () => ({ model: a.model, effort: a.effort, tier: a.tier, cyberAccessProgram: a.cyber || null, date: stamp,
    repeats: a.repeats, split: a.split || null, taskVersions, tasks: results,
    passed: results.filter(r => r.pass === true).length,
    notMeasured: results.filter(r => r.pass === null).length,
    total: summaryTotal(results, tasks, a.repeats),
    byTask: taskStats(results) });
  const todo = a.dryRun ? tasks.flatMap(t => Array.from({ length: a.repeats }, (_, k) => ({ task: t, run: k + 1 }))) : attemptsToRun(results, tasks, a.repeats);
  if (!a.dryRun && !todo.length) console.error('model-eval: bütün denemeler zaten ölçülmüş; yeniden ölçmek için sonuç klasörünü taşı');
  const release = a.dryRun ? () => {} : acquireLock(outDir);
  try {
    // Kilit alındıktan sonra özet yeniden okunur: kilitten önce okunan özet başka bir çalıştırmanın sonucunu
    // kaçırmış olabilir. Buradan sonraki her adım try içindedir: hata verse de kilit bırakılır.
    if (!a.dryRun) results = previousResults(outDir, a, taskVersions);
    const todoLocked = a.dryRun ? todo : attemptsToRun(results, tasks, a.repeats);
    const runInfo = { dir: path.basename(outDir), model: a.model, effort: a.effort, tier: a.tier, cyberAccessProgram: a.cyber || null, split: a.split || null, repeats: a.repeats, attempts: todoLocked.length };
    if (!a.dryRun) logRun(path.dirname(outDir), { event: 'start', ...runInfo });
    for (const { task: t, run: k } of todoLocked) {
      const task = { ...t, run: k };
      // Sonuçlar depoya kanıt olarak girer: yerel yollar (leftoverDir, hata mesajları) yer tutucuyla.
      // --dry-run hiçbir şey yazmaz; gösterdiği komut çalıştırılabilsin diye olduğu gibi kalır.
      const keepFirst = () => {
        for (const ext of ['.md', '.stderr.txt']) {
          const f = path.join(outDir, `${answerStem(task)}${ext}`);
          if (fs.existsSync(f)) fs.renameSync(f, path.join(outDir, `${answerStem(task)}.timeout1${ext}`));
        }
      };
      const prev = results.find(x => x.id === t.id && (x.run || 1) === k);
      const r = a.dryRun ? evaluate(a, task, outDir) : withTimeoutRetry(() => evaluate(a, task, outDir), keepFirst, priorTimeouts(prev));
      results = mergeResult(results, a.dryRun ? r : redactDeep(r));
      // Her denemeden sonra yaz: sonraki bir deneme çökerse harcanan kotanın sonucu kaybolmasın.
      if (!a.dryRun) fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summarize(), null, 2) + '\n');
    }
    if (!a.dryRun) logRun(path.dirname(outDir), { event: 'end', ...runInfo, passed: results.filter(r => r.pass === true).length, notMeasured: results.filter(r => r.pass === null).length });
  } finally {
    release();
  }
  console.log(JSON.stringify(summarize(), null, 2));
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`model-eval: ${e.message}`); process.exit(1); }
} else {
  // testHooks yalnızca run.test.cjs içindir: gerçek codex yerine sahte bir betik çalıştırır.
  module.exports = { securityRoleProblem, registryPath, loadRegistry, parseArgs, lastUsage, claudeArgs, parseClaudeOutput, claudeUsage, pickClaudeExe, decoyCitations, redactLocalPaths, redactDeep, maskSecrets, mergeResult, previousResults, previousTaskVersions, attemptsToRun, acquireLock, logRun, priorTimeouts, summaryTotal, withTimeoutRetry, answerStem, loadTasks, copyHidden, runChecks, verifyData, readResultsFile, jsonShapeProblem, unifiedDiff, changesPatch, HIDDEN_DIR, evaluate, testHooks, codexCommand, sandboxed, codexConfigAbove, lockDown };
}
