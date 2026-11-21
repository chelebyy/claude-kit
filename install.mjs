#!/usr/bin/env node
// claude-kit kurulum programı. Ek bağımlılık yok; Node 22+ ile Windows, Linux ve macOS'ta çalışır.
//   node install.mjs              soruları sorar, planı gösterir, onay alınca uygular
//   node install.mjs --no-tui …   soruları bayraklardan alır (LLM için); --yes verilmezse yalnızca plan
//   node install.mjs doctor       kurulumu değiştirmeden denetler (--json ile makine çıktısı)
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { QUESTIONS, MCP, MIN_NODE, MIN_CLAUDE, parseAnswer, parseBool, answersFromFlags, compareVersions } from './installer/core.mjs';
import { inspectMachine, buildPlan, applyPlan, claudeVersion, kitCommit } from './installer/system.mjs';
import { doctor, formatChecks } from './installer/doctor.mjs';

const kitRoot = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `Kullanım:
  node install.mjs                    etkileşimli kurulum
  node install.mjs doctor [--json]    kurulumu denetle
  node install.mjs --no-tui <bayraklar> [--yes]

--no-tui bayrakları (yes|no):
  --codex  --daybreak (codex=yes ise)  --auto-mode  --advisor  --teams  --ui-prefs
  --auto-env=mine|keep (auto-mode=yes ve makinede tanım yoksa)
  --language=<dil>|keep   --mcp=context7,exa,figma|none
  --on-conflict=replace|keep (CLAUDE.md/AGENTS.md farklıysa)
  --install-codex-cli=yes|no   --fix-codex-tier=yes|no   (gerekirse; verilmezse no)
  --yes   planı uygula (verilmezse yalnızca plan gösterilir)`;

function parseArgs(argv) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (!x.startsWith('--')) { pos.push(x); continue; }
    const eq = x.indexOf('=');
    if (eq > 0) flags[x.slice(2, eq)] = x.slice(eq + 1);
    else if (['yes', 'no-tui', 'json', 'help'].includes(x.slice(2))) flags[x.slice(2)] = true;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[x.slice(2)] = argv[++i];
    else flags[x.slice(2)] = true;
  }
  // Açma/kapama bayrakları `--yes=no` biçiminde de gelebilir: "no" yazısı doğru sayılıp planı
  // uygulatmasın diye değer ayrıştırılır, anlaşılmazsa hata verilir.
  const errors = [];
  for (const k of ['yes', 'no-tui', 'json', 'help']) {
    if (typeof flags[k] !== 'string') continue;
    const v = parseBool(flags[k]);
    if (v === undefined) errors.push(`--${k}=${flags[k]} anlaşılmadı (yes|no)`);
    else flags[k] = v;
  }
  return { flags, cmd: pos[0] || 'install', errors };
}

const ICON = { create: '+', update: '~', same: '=', keep: '·', run: '▶', skip: '-', manual: '!', error: '✗' };
const WORD = { create: 'oluşturulacak', update: 'güncellenecek (yedekli)', same: 'zaten güncel', keep: 'farklı, korunacak',
  run: 'çalıştırılacak', skip: 'atlanacak', manual: 'senin yapman gereken', error: 'hata' };

function printPlan(steps) {
  const groups = [...new Set(steps.map(s => s.group))];
  for (const g of groups) {
    const items = steps.filter(s => s.group === g);
    const sameFiles = g === 'dosya' ? items.filter(s => s.status === 'same').length : 0;
    console.log(`\n[${g}]`);
    for (const s of items) {
      if (g === 'dosya' && s.status === 'same') continue;
      console.log(`  ${ICON[s.status]} ${s.label} — ${WORD[s.status]}${s.argv ? `: ${s.argv.join(' ')}` : ''}${s.detail ? ` (${s.detail})` : ''}`);
      for (const n of s.notes || []) console.log(`      · ${n}`);
      if (s.manual) console.log(`      → ${s.manual}`);
    }
    if (sameFiles) console.log(`  = ${sameFiles} dosya zaten güncel`);
  }
}

function printResults(results) {
  // Ayarlar uygulama anında dosyanın o anki haline yeniden birleştirilir; yazılan değişiklikleri göster.
  for (const r of results.filter(x => x.group === 'ayar' && x.result === 'ok' && x.notes && x.notes.length)) {
    console.log(`\n${r.label} güncellendi:`);
    for (const n of r.notes) console.log(`  · ${n}`);
  }
  const fails = results.filter(r => r.result === 'fail');
  const manual = results.filter(r => r.result === 'manual');
  const done = results.filter(r => r.result === 'ok');
  console.log(`\nSonuç: ${done.length} adım uygulandı, ${fails.length} başarısız, ${manual.length} sana kaldı.`);
  for (const f of fails) console.log(`  ✗ ${f.label}${f.output ? `\n${f.output.split('\n').map(l => `      ${l}`).join('\n')}` : ''}`);
  if (manual.length) {
    console.log('\nSenin yapman gerekenler:');
    for (const r of manual) console.log(`  ! ${r.label}: ${r.manual}`);
  }
  console.log('\nBitince Claude Code\'u yeniden başlat ve `node install.mjs doctor` ile denetle.');
  return fails.length ? 1 : 0;
}

async function askAll(m, rl) {
  const prev = (m.manifest && m.manifest.answers) || {};
  const a = {};
  for (const q of QUESTIONS) {
    if (q.ask && !q.ask(a, m)) { a[q.key] = q.skip; continue; }
    const def = prev[q.key] !== undefined && !q.optional ? prev[q.key] : q.def(m);
    if (q.help) console.log(`\n  ${q.help}`);
    let v;
    while (v === undefined) {
      if (q.type === 'multi') {
        q.choices.forEach((c, i) => console.log(`    ${i + 1}) ${c} — ${MCP[c].label}`));
        const raw = (await rl.question(`${q.text} [numara ya da ad, virgülle; "none" hiçbiri] (${def.join(',') || 'none'}): `)).trim();
        const mapped = raw === '' ? def.join(',') : raw.split(',').map(x => x.trim()).map(x => (/^\d+$/.test(x) ? q.choices[Number(x) - 1] || x : x)).join(',');
        v = parseAnswer(q, mapped || 'none');
      } else {
        const hint = q.type === 'bool' ? (def ? 'E/h' : 'e/H') : q.type === 'choice' ? `${q.choices.join('/')}, varsayılan ${def}` : `varsayılan ${def}`;
        const raw = (await rl.question(`${q.text} [${hint}]: `)).trim();
        v = raw === '' ? def : parseAnswer(q, raw);
      }
      if (v === undefined) console.log('  Anlaşılmadı, tekrar dene.');
    }
    a[q.key] = v;
  }
  return a;
}

async function main() {
  const { flags, cmd, errors } = parseArgs(process.argv.slice(2));
  if (errors.length) { console.error(`${errors.join('\n')}\n\n${USAGE}`); return 2; }
  if (flags.help) { console.log(USAGE); return 0; }
  if (parseInt(process.versions.node, 10) < MIN_NODE) { console.error(`Node ${MIN_NODE}+ gerekli (şu an ${process.versions.node}).`); return 1; }
  const home = path.resolve(typeof flags.home === 'string' ? flags.home : os.homedir());

  if (cmd === 'doctor') {
    const checks = doctor({ home, kitRoot });
    if (flags.json) console.log(JSON.stringify({ home, checks }, null, 2));
    else console.log(`claude-kit doctor (${home})\n\n${formatChecks(checks)}`);
    return checks.some(c => c.status === 'fail') ? 1 : 0;
  }
  if (cmd !== 'install') { console.error(`Bilinmeyen komut: ${cmd}\n\n${USAGE}`); return 2; }

  // Kit ~/.claude'a kurar ve oradaki kayıtları (ör. market kaynakları) doğrular; claude komutu ise
  // CLAUDE_CONFIG_DIR'ı kullanır. İkisi farklı dizinse doğrulama yanlış yerde yapılırdı: dur.
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  const fold = s => (process.platform === 'win32' ? s.toLowerCase() : s);
  if (cfg && fold(path.resolve(cfg)) !== fold(path.join(home, '.claude'))) {
    console.error(`CLAUDE_CONFIG_DIR=${cfg} ayarlı ve ${path.join(home, '.claude')} değil. Bu durum desteklenmiyor; değişkeni kaldırıp yeniden çalıştır.`);
    return 1;
  }
  // Codex de yapılandırmasını CODEX_HOME'dan okur; kit ~/.codex'e yazar. Farklıysa düzeltmeler
  // Codex'in okumadığı dosyalara gider: dur.
  const codexHome = process.env.CODEX_HOME;
  if (codexHome && fold(path.resolve(codexHome)) !== fold(path.join(home, '.codex'))) {
    console.error(`CODEX_HOME=${codexHome} ayarlı ve ${path.join(home, '.codex')} değil. Bu durum desteklenmiyor; değişkeni kaldırıp yeniden çalıştır.`);
    return 1;
  }

  const cv = claudeVersion(undefined, home);
  if (!cv) { console.error('claude komutu bulunamadı. Önce Claude Code\'u kur: https://claude.com/claude-code'); return 1; }
  if (compareVersions(cv, MIN_CLAUDE) < 0) { console.error(`Claude Code ${cv} çok eski; en az ${MIN_CLAUDE} gerekli (claude update).`); return 1; }

  const m = inspectMachine({ home, kitRoot });
  let a;
  if (flags['no-tui']) {
    const r = answersFromFlags(flags, m);
    if (r.errors.length) { console.error(`Eksik ya da geçersiz bayraklar:\n  ${r.errors.join('\n  ')}\n\n${USAGE}`); return 2; }
    a = r.answers;
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error(`Etkileşimli kurulum için bir terminal gerekli. Soruları bayraklarla vermek için --no-tui kullan.\n\n${USAGE}`);
      return 2;
    }
    console.log(`claude-kit kurulumu (${home})\nClaude Code ${cv}. Sorulara Enter ile varsayılanı seçebilirsin; önce plan gösterilir, onaysız hiçbir şey değişmez.`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      a = await askAll(m, rl);
      const steps = buildPlan(a, m);
      printPlan(steps);
      const ok = (await rl.question('\nBu plan uygulansın mı? [e/H]: ')).trim().toLowerCase();
      if (!['e', 'evet', 'y', 'yes'].includes(ok)) { console.log('Hiçbir şey değişmedi.'); return 0; }
      rl.close();
      const { results } = applyPlan(steps, a, m, { log: s => console.log(`  ${s}`), kitCommit: kitCommit(kitRoot) });
      return printResults(results);
    } finally { rl.close(); }
  }

  const steps = buildPlan(a, m);
  printPlan(steps);
  if (!flags.yes) { console.log('\nYalnızca plan gösterildi; uygulamak için aynı komutu --yes ile çalıştır.'); return 0; }
  const { results } = applyPlan(steps, a, m, { log: s => console.log(`  ${s}`), kitCommit: kitCommit(kitRoot) });
  return printResults(results);
}

main().then(code => { process.exitCode = code; }, err => { console.error(err && err.stack || err); process.exitCode = 1; });
