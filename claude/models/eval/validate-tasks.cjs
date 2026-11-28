#!/usr/bin/env node
// Görev setini doğrular: her görev yüklenir, tohumlanan hata gerçekten vardır (kontrol düzeltilmemiş fixture'da
// başarısız), başvuru düzeltmesi (solution/) kontrolden geçer, process.exit(0) ekleyen bir çözüm geçmez; güvenlik
// ve bölümlü görevlerin rubric.md'si, kilitli inceleme görevlerinin claims listesi vardır.
// Kullanım: node claude/models/eval/validate-tasks.cjs [<görev-klasörü>]   (varsayılan: depodaki tasks/)
// Kontroller görev setinin kendi dosyalarını (depo içeriği) Node izin modeliyle çalıştırır; güvenilmeyen bir görev
// setini bununla çalıştırma.
'use strict';
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const runModule = require('./run.cjs');

function validateTask(t) {
  assert.ok(t.prompt.trim().length > 0, 'prompt.md boş');
  if (t.roles.includes('security')) assert.ok(fs.existsSync(path.join(t.base, 'rubric.md')), 'güvenlik görevinin rubric.md dosyası olmalı');
  for (const e of t.expect || []) new RegExp(e.pattern, 'i');
  for (const [file, ranges] of Object.entries(t.decoys || {})) {
    const lines = fs.readFileSync(path.join(t.base, 'fixture', file), 'utf8').split('\n').length;
    for (const [lo, hi] of ranges) assert.ok(lo >= 1 && lo <= hi && hi <= lines, `${file} tuzak aralığı ${lo}-${hi}`);
  }
  if (t.check) {
    const [cmd, ...rest] = t.check.command.split(' ');
    assert.strictEqual(cmd, 'node');
    // Çalıştırıcıyla aynı kurallar (runChecks): her süreç fixture (+ overlay) ve gizli dosyaların yeni bir kopyasında,
    // Node izin modeliyle çalışır.
    const runOn = overlay => {
      const made = [];
      let out = '';
      const dirs = () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-taskcheck-'));
        made.push(dir);
        fs.cpSync(path.join(t.base, 'fixture'), dir, { recursive: true });
        if (overlay) fs.cpSync(overlay, dir, { recursive: true });
        if (fs.existsSync(path.join(t.base, 'hidden'))) fs.cpSync(path.join(t.base, 'hidden'), path.join(dir, runModule.HIDDEN_DIR), { recursive: true });
        return { dir };
      };
      const runOne = (command, ms, dir) => {
        const perm = ['--permission', `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`];
        const r = spawnSync(process.execPath, [...perm, ...command.split(' ').slice(1)], { cwd: dir, encoding: 'utf8', timeout: ms || 60000 });
        out += `${r.stdout || ''}${r.stderr || ''}`;
        return { passed: !r.error && r.status === 0, timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT') };
      };
      try {
        const res = runModule.runChecks(t, dirs, runOne);
        return { passed: res.passed === true, out: out + JSON.stringify(res) };
      } finally { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); }
    };
    // Yeniden düzenleme görevlerinde (check.fixturePasses) davranış fixture'da zaten doğrudur: kontrol fixture'da
    // geçmelidir; puanın geri kalanı kör notlardan (claims) gelir.
    if (t.check.fixturePasses === true) assert.strictEqual(runOn(null).passed, true, 'fixturePasses: kontrol fixture üzerinde geçmeli');
    else assert.strictEqual(runOn(null).passed, false, 'kontrol düzeltilmemiş fixture üzerinde başarısız olmalı');
    if (fs.existsSync(path.join(t.base, 'solution'))) {
      const ok = runOn(path.join(t.base, 'solution'));
      assert.strictEqual(ok.passed, true, `başvuru düzeltmesiyle kontrol geçmeli: ${ok.out.slice(-800)}`);
      const attack = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-exit0-'));
      try {
        fs.cpSync(path.join(t.base, 'solution'), attack, { recursive: true });
        for (const rel of fs.readdirSync(attack, { recursive: true })) {
          const f = path.join(attack, rel);
          if (/\.c?js$/.test(rel) && fs.statSync(f).isFile()) fs.writeFileSync(f, 'process.exit(0);\n' + fs.readFileSync(f, 'utf8'));
        }
        assert.strictEqual(runOn(attack).passed, false, 'process.exit(0) ekleyen bir çözüm kontrolden geçmemeli');
      } finally { fs.rmSync(attack, { recursive: true, force: true }); }
    }
  }
  if (t.check && t.check.verify) assert.ok(!fs.existsSync(path.join(t.base, 'hidden', path.basename(t.check.verify))), 'doğrulayıcı hidden/ içinde olamaz (kontrol klasörüne kopyalanırdı)');
  if (t.split === 'frozen' && t.kind === 'review') assert.ok(Array.isArray(t.claims) && t.claims.length, 'kilitli inceleme görevinin claims listesi olmalı');
  if (t.split) assert.ok(fs.existsSync(path.join(t.base, 'rubric.md')), 'bölümlü görevin rubric.md dosyası olmalı (zorluğun nedeni dahil)');
}

if (require.main === module) {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, 'tasks');
  let failed = 0;
  for (const t of runModule.loadTasks(undefined, undefined, dir)) {
    try { validateTask(t); console.log(`ok   ${t.id}`); } catch (e) { failed++; console.log(`FAIL ${t.id}: ${e.message.split('\n')[0]}`); }
  }
  process.exit(failed ? 1 : 0);
} else {
  module.exports = { validateTask };
}
