'use strict';
// Çalıştırma: node --test claude/models/eval/run.test.cjs  (gerçek Codex çağrılmaz)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { evaluate, testHooks } = require('./run.cjs');

const FAKE = path.join(__dirname, 'fake-codex.test-helper.cjs');
testHooks.codexCommand = () => ({ cmd: process.execPath, pre: [FAKE] });
const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.test-helper.cjs');
testHooks.claudeCommand = () => ({ cmd: process.execPath, pre: [FAKE_CLAUDE] });

const tasksDir = path.join(__dirname, 'tasks');
const load = id => ({
  ...JSON.parse(fs.readFileSync(path.join(tasksDir, id, 'task.json'), 'utf8')),
  base: path.join(tasksDir, id),
  prompt: fs.readFileSync(path.join(tasksDir, id, 'prompt.md'), 'utf8'),
});
const args = { model: 'fake', effort: 'low', tier: 'fast', dryRun: false };

function runMode(mode, id) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-test-out-'));
  process.env.FAKE_MODE = mode;
  try { return evaluate(args, load(id), outDir); } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
}

test('doğru düzeltme geçer', () => {
  const r = runMode('fix', 'fix-pagination');
  assert.strictEqual(r.checkPassed, true);
  assert.strictEqual(r.protectedOk, true);
  assert.strictEqual(r.pass, true);
  assert.ok(!r.leftoverDir && !r.leftoverGitDir);
});

// Kontrol yalıtımı: model doğru düzeltmeyi yapıp yanına yükleme anında çalışan bir satır ekler.
// Yalıtım çalışıyorsa satır ERR_ACCESS_DENIED ile düşer, kontrol başarısız olur ve dışarıya
// hiçbir şey yazılmaz.
test('kontrol, modelin kodunun ev klasörünü okumasına izin vermez', () => {
  const r = runMode('fix-reads-home', 'fix-pagination');
  assert.strictEqual(r.checkPassed, false);
  assert.strictEqual(r.pass, false);
});

test('kontrol, modelin kodunun çalışma klasörü dışına yazmasına izin vermez', () => {
  const outside = path.join(os.tmpdir(), `model-eval-escape-${process.pid}-${Date.now()}.txt`);
  process.env.FAKE_OUTSIDE_FILE = outside;
  try {
    const r = runMode('fix-writes-outside', 'fix-pagination');
    assert.strictEqual(fs.existsSync(outside), false, 'dışarıya yazılmamalıydı');
    assert.strictEqual(r.checkPassed, false);
  } finally {
    fs.rmSync(outside, { force: true });
    delete process.env.FAKE_OUTSIDE_FILE;
  }
});

test('kontrol, modelin kodunun alt süreç açmasına izin vermez', () => {
  const r = runMode('fix-spawns', 'fix-pagination');
  assert.strictEqual(r.checkPassed, false);
});

test('kontrol sandbox\'ı başlayamazsa sonuç ölçülmemiş sayılır, yalıtımsız çalıştırılmaz', () => {
  process.env.FAKE_SANDBOX = 'down';
  try {
    const r = runMode('fix', 'fix-pagination');
    assert.strictEqual(r.pass, null);
    assert.match(r.environmentError, /Check sandbox could not start/);
    assert.strictEqual(r.checkPassed, undefined);
  } finally {
    delete process.env.FAKE_SANDBOX;
  }
});

test('kontrol zaman aşımı başarısızlıktır, "ölçülmedi" değildir', () => {
  testHooks.checkTimeoutMs = 2000;
  try {
    const r = runMode('fix-hangs', 'fix-pagination');
    assert.strictEqual(r.checkPassed, false);
    assert.strictEqual(r.checkTimedOut, true);
    assert.strictEqual(r.pass, false);
    assert.strictEqual(r.environmentError, undefined);
  } finally {
    delete testHooks.checkTimeoutMs;
  }
});

// Zaman aşımında spawnSync yalnızca doğrudan çocuğu (codex sarmalayıcısı) öldürür. Sandbox'ın içinde
// takılan kontrol süreci sahipsiz kalıp sonsuza dek CPU yakmamalı (Linux'ta 2026-11-17'de 11 tane bulundu).
test('takılan kontrol zaman aşımından sonra süreç bırakmaz', { skip: process.platform === 'win32' && 'Windows: süreç grubu yok' }, () => {
  // Testin kendi kontrol kökü: tarama ve temizlik yalnızca bu testin süreçlerini görür, aynı anda
  // çalışan başka bir değerlendirmenin kontrol sürecine dokunmaz.
  const base = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'model-eval-test-'));
  testHooks.checkRoot = path.join(base, 'root');
  testHooks.checkTimeoutMs = 2000;
  const alive = () => require('child_process').spawnSync('pgrep', ['-f', '--', `--allow-fs-read=${testHooks.checkRoot}/`], { encoding: 'utf8' })
    .stdout.split('\n').filter(Boolean);
  try {
    assert.strictEqual(runMode('fix-hangs', 'fix-pagination').checkTimedOut, true);
    const deadline = Date.now() + 2000;
    let leaked;
    do { leaked = alive(); } while (leaked.length && Date.now() < deadline);
    for (const p of leaked) try { process.kill(Number(p), 'SIGKILL'); } catch {}
    assert.deepStrictEqual(leaked, [], 'zaman aşımından sonra kontrol süreci yaşıyor');
  } finally {
    delete testHooks.checkTimeoutMs;
    delete testHooks.checkRoot;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('modelin çıktıya yazdığı sahte sandbox hatası sonucu "ölçülmedi"ye çeviremez', () => {
  const r = runMode('wrong-fix-fakes-sandbox-error', 'fix-pagination');
  assert.strictEqual(r.environmentError, undefined);
  assert.strictEqual(r.checkPassed, false);
  assert.strictEqual(r.pass, false);
});

test('model çalışma klasöründe bağlantı bırakırsa kontrol çalıştırılmaz', () => {
  const r = runMode('fix-leaves-link', 'fix-pagination');
  assert.match(r.checkSkipped, /links in work dir: lnk/);
  assert.strictEqual(r.checkPassed, false);
  assert.strictEqual(r.pass, false);
});

test('model sabit bağlantı (hard link) bırakırsa kontrol çalıştırılmaz', () => {
  const r = runMode('fix-leaves-hardlink', 'fix-pagination');
  assert.match(r.checkSkipped, /links in work dir: .*(data|hl)\.txt/);
  assert.strictEqual(r.checkPassed, false);
});

test('kontrol sandbox\'ı açılmadan önce çalışma klasöründeki .codex/ silinir', () => {
  const report = path.join(os.tmpdir(), `model-eval-sbreport-${process.pid}-${Date.now()}.txt`);
  process.env.FAKE_SANDBOX_REPORT = report;
  try {
    const r = runMode('fix-leaves-codex-config', 'fix-pagination');
    assert.strictEqual(fs.existsSync(report), false, 'sandbox açılırken .codex/ hâlâ vardı');
    assert.strictEqual(r.checkPassed, true);
    assert.deepStrictEqual(r.harnessFiles, ['.codex/config.toml']);
  } finally {
    fs.rmSync(report, { force: true });
    delete process.env.FAKE_SANDBOX_REPORT;
  }
});

test('büyük harfle yazılmış .CODEX de kontrol klasörüne girmez', () => {
  const report = path.join(os.tmpdir(), `model-eval-sbreport-upper-${process.pid}-${Date.now()}.txt`);
  process.env.FAKE_SANDBOX_REPORT = report;
  try {
    const r = runMode('fix-leaves-upper-codex-config', 'fix-pagination');
    assert.strictEqual(fs.existsSync(report), false, 'sandbox açılırken .CODEX vardı');
    assert.deepStrictEqual(r.harnessFiles, ['.CODEX/config.toml']);
    assert.deepStrictEqual(r.changed, ['paginate.js']);
  } finally {
    fs.rmSync(report, { force: true });
    delete process.env.FAKE_SANDBOX_REPORT;
  }
});

test('model çalışmasından sonra değişen dosya kontrolü durdurur (geride kalan süreç)', () => {
  testHooks.afterSnapshot = work => fs.appendFileSync(path.join(work, 'paginate.js'), '\n// changed later\n');
  try {
    const r = runMode('fix', 'fix-pagination');
    assert.match(r.checkSkipped, /work dir changed after the model run: paginate\.js/);
    assert.strictEqual(r.checkPassed, false);
  } finally {
    delete testHooks.afterSnapshot;
  }
});

test('anlık görüntüden sonra eklenen dosya kontrol klasörüne girmez', () => {
  testHooks.afterSnapshot = work => fs.writeFileSync(path.join(work, 'late.js'), 'process.exit(1)');
  process.env.FAKE_SANDBOX_REPORT_FILES = path.join(os.tmpdir(), `model-eval-files-${process.pid}-${Date.now()}.txt`);
  try {
    const r = runMode('fix', 'fix-pagination');
    assert.strictEqual(r.checkPassed, true);
    const seen = fs.readFileSync(process.env.FAKE_SANDBOX_REPORT_FILES, 'utf8');
    assert.ok(!seen.includes('late.js'), 'geç eklenen dosya kontrol klasöründe olmamalı');
    assert.ok(seen.includes('paginate.js'));
  } finally {
    delete testHooks.afterSnapshot;
    fs.rmSync(process.env.FAKE_SANDBOX_REPORT_FILES, { force: true });
    delete process.env.FAKE_SANDBOX_REPORT_FILES;
  }
});

test('kontrol klasörünün üstünde .codex varsa kontrol çalışmaz', () => {
  const base = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'model-eval-test-'));
  fs.mkdirSync(path.join(base, '.codex'));
  testHooks.checkRoot = path.join(base, 'root');
  try {
    const r = runMode('fix', 'fix-pagination');
    assert.strictEqual(r.pass, null);
    assert.match(r.environmentError, /Codex config found above the check dir/);
    assert.strictEqual(runModule.codexConfigAbove(path.join(os.homedir(), 'x')), null, '~/.codex beklenen ayar klasörüdür');
  } finally {
    delete testHooks.checkRoot;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Gerçek `codex sandbox` (codex kurulu değilse atlanır; model çağrılmaz).
const runModule = require('./run.cjs');
let realCodex = null;
try { realCodex = runModule.codexCommand(); } catch {}

test('Node izin modeli ağı kısıtlamıyorsa (eski sürüm) kontrol çalışmaz, ölçülmedi sayılır', () => {
  process.env.FAKE_OLD_NODE = '1';
  try {
    const r = runMode('fix', 'fix-pagination');
    assert.strictEqual(r.pass, null);
    assert.match(r.environmentError, /does not restrict network/);
  } finally {
    delete process.env.FAKE_OLD_NODE;
  }
});

test('sandbox standart girdiyi iletmezse ağ denemesi boşta geçmez, ölçülmedi sayılır', () => {
  process.env.FAKE_SANDBOX_NO_STDIN = '1';
  try {
    const r = runMode('fix', 'fix-pagination');
    assert.strictEqual(r.pass, null);
    assert.match(r.environmentError, /does not restrict network/);
  } finally {
    delete process.env.FAKE_SANDBOX_NO_STDIN;
  }
});

test('kontrol klasörüne kopyalananlar dışında bir şey girerse kontrol çalışmaz', () => {
  testHooks.afterCopy = dir => fs.writeFileSync(path.join(dir, 'planted.js'), 'process.exit(0)');
  try {
    const r = runMode('fix', 'fix-pagination');
    assert.strictEqual(r.checkPassed, false);
    assert.match(r.checkSkipped, /check dir has unexpected content: planted\.js/);
    assert.ok(!r.leftoverCheckDir);
  } finally {
    delete testHooks.afterCopy;
  }
});

// Kök klasör çalıştırmalar arasında kalıcıdır; kilit başka hesapların açık girdilerini silmez.
test('kök klasörde başka bir hesabın açık izni varsa kontrol çalışmaz, başarısız sayılır', { skip: process.platform !== 'win32' && 'yalnızca Windows ACL' }, () => {
  const base = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'model-eval-test-'));
  testHooks.checkRoot = path.join(base, 'root');
  // Zararsız bir açık girdi: Everyone (S-1-1-0) için yalnızca okuma.
  testHooks.beforeRootLock = root => {
    const r = require('child_process').spawnSync('icacls', [root, '/grant', '*S-1-1-0:(OI)(CI)R'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
  };
  try {
    const r = runMode('fix', 'fix-pagination');
    assert.notStrictEqual(r.pass, null);
    assert.strictEqual(r.checkPassed, false);
    assert.match(r.checkSkipped, /check dir not usable: check root: ACL grants S-1-1-0/);
  } finally {
    delete testHooks.checkRoot;
    delete testHooks.beforeRootLock;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('kök klasör bir bağlantıysa kilitlenmez, kontrol başarısız sayılır', () => {
  const base = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'model-eval-test-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-root-target-'));
  // Zararsız bir junction: hedefi bu testin kendi boş geçici klasörü.
  fs.symlinkSync(target, path.join(base, 'root'), 'junction');
  testHooks.checkRoot = path.join(base, 'root');
  try {
    const r = runMode('fix', 'fix-pagination');
    assert.strictEqual(r.checkPassed, false);
    assert.match(r.checkSkipped, /check dir not usable: check root: not a plain directory/);
    assert.deepStrictEqual(fs.readdirSync(target), [], 'bağlantının hedefine hiçbir şey yazılmamalı');
  } finally {
    delete testHooks.checkRoot;
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('kopyadan önce kontrol klasörüne bırakılan bir şey varsa hiçbir şey kopyalanmaz, kontrol başarısız', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-planted-target-'));
  // Zararsız bir junction: hedefi bu testin kendi boş geçici klasörü.
  testHooks.afterLockDown = dir => fs.symlinkSync(target, path.join(dir, 'lnk'), 'junction');
  try {
    const r = runMode('fix', 'fix-pagination');
    assert.strictEqual(r.checkPassed, false);
    assert.match(r.checkSkipped, /check dir has unexpected content: lnk \(present before the copy\)/);
    assert.deepStrictEqual(fs.readdirSync(target), [], 'bağlantının hedefine hiçbir şey yazılmamalı');
    assert.ok(!r.leftoverCheckDir);
  } finally {
    delete testHooks.afterLockDown;
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('kopyalanacak bir dosyanın yerine dosya bırakılırsa sonuç "ölçülmedi" değil başarısızlıktır', () => {
  // Boşluk denetimi atlatılmış gibi: kopyalama sırasında hedef yolda bir dosya bulunur (EEXIST).
  const realWrite = fs.writeFileSync;
  let planted = false;
  fs.writeFileSync = function (p, data, opts) {
    if (!planted && opts && opts.flag === 'wx' && /check-/.test(String(p))) { planted = true; realWrite(p, 'planted'); }
    return realWrite.apply(this, arguments);
  };
  try {
    const r = runMode('fix', 'fix-pagination');
    assert.notStrictEqual(r.pass, null);
    assert.strictEqual(r.checkPassed, false);
    assert.match(r.checkSkipped, /check dir has unexpected content: .*copy failed: EEXIST/);
  } finally {
    fs.writeFileSync = realWrite;
  }
});

test('kontrol klasöründe kopyalanan bir dosya değiştirilirse kontrol çalışmaz', () => {
  testHooks.afterCopy = dir => fs.appendFileSync(path.join(dir, 'paginate.js'), '\n// swapped\n');
  try {
    const r = runMode('fix', 'fix-pagination');
    assert.strictEqual(r.checkPassed, false);
    assert.match(r.checkSkipped, /check dir has unexpected content: paginate\.js/);
  } finally {
    delete testHooks.afterCopy;
  }
});

// Sonucu sınar, kilidin etkisini değil: bu makinede 2026-11-07'de kilitsiz bir kontrol klasörüne de ne
// codex sandbox ne de codex exec -s workspace-write yazabildi. lockDown izinleri farklı makineler içindir.
test('gerçek codex sandbox: başka bir sandbox süreci kısıtlanmış kontrol klasörüne yazamaz', { skip: !realCodex && 'codex kurulu değil' }, () => {
  testHooks.sandboxCommand = () => realCodex;
  const root = path.join(os.homedir(), '.cache', 'model-eval');
  fs.mkdirSync(root, { recursive: true });
  const check = fs.mkdtempSync(path.join(root, 'check-test-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-other-'));
  const target = path.join(check, 'intruder.txt');
  try {
    runModule.lockDown(check);
    runModule.sandboxed(other, process.execPath, ['-e', `try{require('fs').writeFileSync(${JSON.stringify(target)},'x')}catch{process.exit(7)}`], 30000);
    assert.strictEqual(fs.existsSync(target), false, 'başka bir sandbox süreci kontrol klasörüne yazabildi');
  } finally {
    delete testHooks.sandboxCommand;
    fs.rmSync(check, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('gerçek codex sandbox: doğru düzeltme yalıtılmış kontrolden geçer', { skip: !realCodex && 'codex kurulu değil' }, () => {
  testHooks.sandboxCommand = () => realCodex;
  try {
    assert.strictEqual(runMode('fix', 'fix-pagination').checkPassed, true);
  } finally {
    delete testHooks.sandboxCommand;
  }
});

test('gerçek codex sandbox tek başına (Node izinleri olmadan): ev klasörüne yazma engellenir, TEMP açık (bilinen sınır)', { skip: !realCodex && 'codex kurulu değil' }, () => {
  testHooks.sandboxCommand = () => realCodex;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-sbtest-'));
  const home = path.join(os.homedir(), `model-eval-sandbox-probe-${process.pid}-${Date.now()}.txt`);
  const temp = path.join(os.tmpdir(), `model-eval-sandbox-probe-${process.pid}-${Date.now()}.txt`);
  const write = f => `try{require('fs').writeFileSync(${JSON.stringify(f)},'x')}catch{process.exit(7)}`;
  try {
    runModule.sandboxed(work, process.execPath, ['-e', write(home)], 30000);
    assert.strictEqual(fs.existsSync(home), false, 'sandbox ev klasörüne yazmayı engellemeliydi');
    runModule.sandboxed(work, process.execPath, ['-e', write(temp)], 30000);
    // README "Bilinen sınırlar": unelevated Windows sandbox'ı TEMP'e yazmaya izin verir. Bu değişirse
    // test düşer ve README güncellenmelidir.
    if (process.platform === 'win32') assert.strictEqual(fs.existsSync(temp), true, 'TEMP sınırı değişti; README güncellenmeli');
  } finally {
    delete testHooks.sandboxCommand;
    fs.rmSync(home, { force: true });
    fs.rmSync(temp, { force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('testi değiştiren model düşer ve kontrol çalıştırılmaz', () => {
  const r = runMode('cheat', 'fix-pagination');
  assert.strictEqual(r.protectedOk, false);
  assert.strictEqual(r.checkSkipped, 'protected files changed');
  assert.strictEqual(r.pass, false);
});

test('read-only incelemede .codex dosyaları modele yazılmaz', () => {
  const r = runMode('review-good', 'review-readonly');
  assert.deepStrictEqual(r.changed, []);
  assert.deepStrictEqual(r.harnessFiles, ['.codex/state.json']);
  assert.strictEqual(r.readOnlyOk, true);
  assert.deepStrictEqual(r.misses, []);
  assert.strictEqual(r.pass, true);
});

test('read-only incelemede dosya düzenleyen model düşer', () => {
  const r = runMode('review-edits', 'review-readonly');
  assert.strictEqual(r.readOnlyOk, false);
  assert.strictEqual(r.pass, false);
});

test('aynı boyut ve eski mtime ile değiştirilen korunan dosya yakalanır', () => {
  const r = runMode('stealth-cheat', 'fix-pagination');
  assert.deepStrictEqual(r.changed, ['test.js']);
  assert.strictEqual(r.protectedOk, false);
  assert.strictEqual(r.pass, false);
});

test('.gitignore ile gizlenen yeni dosyalar yakalanır', () => {
  const r = runMode('ignore-hide', 'review-readonly');
  assert.deepStrictEqual(r.changed, ['.gitignore', 'new.js']);
  assert.strictEqual(r.readOnlyOk, false);
});

test('sandbox açılamazsa sonuç ölçülmemiş sayılır', () => {
  const r = runMode('sandbox-down', 'review-readonly');
  assert.strictEqual(r.pass, null);
  assert.ok(r.environmentError);
});

test('--cyber-access-program doğrulanır ve codex exec komutuna geçer', () => {
  const base = ['--model', 'gpt-daybreak-blue-latest', '--effort', 'high'];
  const a = runModule.parseArgs([...base, '--tier', 'default', '--cyber-access-program', 'daybreak_blue']);
  assert.strictEqual(a.cyber, 'daybreak_blue');
  assert.throws(() => runModule.parseArgs([...base, '--tier', 'default', '--cyber-access-program', 'daybreak']), /standard\|daybreak_blue\|daybreak_red/);
  assert.throws(() => runModule.parseArgs([...base, '--tier', 'fast', '--cyber-access-program', 'daybreak_blue']), /--tier default/);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-test-out-'));
  try {
    const withCyber = evaluate({ ...a, dryRun: true }, load('fix-pagination'), outDir).command;
    assert.match(withCyber, / --cyber-access-program daybreak_blue -o /);
    const without = evaluate({ ...args, dryRun: true }, load('fix-pagination'), outDir).command;
    assert.ok(!without.includes('--cyber-access-program'));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('kaydedilen cevapta yerel yollar (kullanıcı adı) yer tutucuyla değişir', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-test-out-'));
  process.env.FAKE_MODE = 'fix-mentions-paths';
  try {
    const r = evaluate(args, load('fix-pagination'), outDir);
    assert.strictEqual(r.pass, true);
    const saved = fs.readFileSync(path.join(outDir, 'fix-pagination.md'), 'utf8');
    const user = os.userInfo().username;
    assert.ok(!saved.toLowerCase().includes(user.toLowerCase()), `kullanıcı adı kalmamalı: ${saved}`);
    assert.match(saved, /\[paginate\.js\]\(<workdir>\/paginate\.js\) in <workdir>\./);
    assert.match(saved, /Config: ~[\\/]\.codex and ~\/x\./);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('codex son mesaj yazmadan hata koduyla çıkarsa sonuç "ölçülmedi", stderr gizlenmiş olarak saklanır', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-test-out-'));
  process.env.FAKE_MODE = 'crash-no-answer';
  try {
    const r = evaluate(args, load('sec-review-auth'), outDir);
    assert.strictEqual(r.pass, null);
    assert.match(r.environmentError, /codex exec exited 1 without a final message; not a model result/);
    const err = fs.readFileSync(path.join(outDir, 'sec-review-auth.stderr.txt'), 'utf8');
    assert.match(err, /stream disconnected before completion \(workdir <workdir>\)/);
    assert.ok(!err.toLowerCase().includes(os.userInfo().username.toLowerCase()));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('aynı sonuç klasöründe başarılı tekrar, önceki denemenin stderr dosyasını siler', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-test-out-'));
  const stderrFile = path.join(outDir, 'sec-review-auth.stderr.txt');
  try {
    process.env.FAKE_MODE = 'crash-no-answer';
    evaluate(args, load('sec-review-auth'), outDir);
    assert.ok(fs.existsSync(stderrFile));
    process.env.FAKE_MODE = 'ok-no-op';
    const r = evaluate(args, load('sec-review-auth'), outDir);
    assert.strictEqual(r.exitStatus, 0);
    assert.ok(!fs.existsSync(stderrFile), 'başarılı tekrardan sonra eski stderr kalmamalı');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('bağlantı bırakıp son mesaj yazmadan çöken model başarısızdır, "ölçülmedi" değil', () => {
  const r = runMode('crash-after-link', 'fix-pagination');
  assert.strictEqual(r.pass, false);
  assert.ok(!r.environmentError);
  assert.match(r.checkSkipped, /links in work dir: lnk/);
});

test('stderr kaydında token biçimli değerler maskelenir', () => {
  const masked = runModule.maskSecrets([
    'Authorization: Bearer abc.DEF-123_xyz',
    'GET https://mcp.example.dev/v1?api_key=SECRET123&tools=a',
    'token=tok_live_999; other=fine',
    'key sk-proj-ABCDEFGHIJKLMNOPQRSTUV12',
    'body {"access_token":"eyJabc123","expires_in":3600}',
    "password: 'hunter2'",
    'Authorization: Basic dXNlcjpwYXNz',
  ].join('\n'));
  for (const s of ['abc.DEF-123_xyz', 'SECRET123', 'tok_live_999', 'sk-proj-ABCDEFGHIJKLMNOPQRSTUV12', 'eyJabc123', 'hunter2', 'dXNlcjpwYXNz']) assert.ok(!masked.includes(s), `${s} maskelenmeli`);
  assert.match(masked, /"expires_in":3600/);
  assert.strictEqual(runModule.maskSecrets('max_tokens: 5, input_tokens=3'), 'max_tokens: 5, input_tokens=3');
  assert.match(masked, /tools=a/);
  assert.match(masked, /other=fine/);
});

test('"sandbox açılamadı" yazıp süreyi aşan model başarısızdır, "ölçülmedi" değil', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-test-out-'));
  process.env.FAKE_MODE = 'sandbox-claim-then-hang';
  try {
    const r = evaluate(args, { ...load('review-readonly'), timeoutSec: 2 }, outDir);
    assert.strictEqual(r.timedOut, true);
    assert.strictEqual(r.pass, false);
    assert.ok(!r.environmentError);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('yanlış düzenleme yapıp "sandbox açılamadı" diyen model başarısızdır, "ölçülmedi" değil', () => {
  const r = runMode('wrong-fix-claims-sandbox-down', 'fix-pagination');
  assert.deepStrictEqual(r.changed, ['paginate.js']);
  assert.strictEqual(r.checkPassed, false);
  assert.ok(!r.checkSkipped);
  assert.strictEqual(r.pass, false);
  assert.ok(!r.environmentError);
});

test('düzeltme görevinde gerçek sandbox arızası (hiçbir dosya değişmedi) "ölçülmedi" sayılır', () => {
  // Model hiçbir şey düzenleyemedi; kontrol özgün hatalı kodda düşer. Bu bir model sonucu değildir.
  const r = runMode('sandbox-down', 'fix-pagination');
  assert.deepStrictEqual(r.changed, []);
  assert.strictEqual(r.checkPassed, false);
  assert.strictEqual(r.pass, null);
  assert.ok(r.environmentError);
});

test('kontrol klasörü denetimine takılıp "sandbox açılamadı" diyen model başarısızdır', () => {
  testHooks.afterCopy = dir => fs.writeFileSync(path.join(dir, 'planted.js'), '1;');
  try {
    const r = runMode('fix-claims-sandbox-down', 'fix-pagination');
    assert.match(r.checkSkipped, /unexpected content/);
    assert.strictEqual(r.pass, false);
    assert.ok(!r.environmentError);
  } finally {
    delete testHooks.afterCopy;
  }
});

test('korunan dosyayı değiştirip "sandbox açılamadı" diyen model başarısızdır, "ölçülmedi" değil', () => {
  const r = runMode('cheat-claims-sandbox-down', 'fix-pagination');
  assert.strictEqual(r.protectedOk, false);
  assert.strictEqual(r.pass, false);
  assert.ok(!r.environmentError);
});

test('korunan dosyayı değiştirip son mesaj yazmadan çöken model başarısızdır, "ölçülmedi" değil', () => {
  const r = runMode('crash-after-cheat', 'fix-pagination');
  assert.strictEqual(r.protectedOk, false);
  assert.strictEqual(r.pass, false);
  assert.ok(!r.environmentError);
});

test('aynı gün tek görevlik tekrar, önceki summary.json sonuçlarını korur ve eski denemeyi saklar', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-test-out-'));
  const run1 = { model: 'gpt-x', effort: 'high', tier: 'default', cyberAccessProgram: null, tasks: [
    { id: 'fix-pagination', pass: true, durationMs: 100 },
    { id: 'sec-review-fileserver', pass: null, environmentError: 'codex exec exited 1 without a final message' },
  ] };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(run1));
  const a = { model: 'gpt-x', effort: 'high', tier: 'default' };
  try {
    let results = runModule.previousResults(outDir, a);
    results = runModule.mergeResult(results, { id: 'sec-review-fileserver', pass: true, durationMs: 492 });
    assert.deepStrictEqual(results.map(r => [r.id, r.pass]), [['fix-pagination', true], ['sec-review-fileserver', true]]);
    assert.strictEqual(results[1].previousAttempts.length, 1);
    assert.match(results[1].previousAttempts[0].environmentError, /exited 1/);
    // İkinci tekrar: denemeler birikir, iç içe girmez.
    results = runModule.mergeResult(results, { id: 'sec-review-fileserver', pass: false });
    assert.deepStrictEqual(results[1].previousAttempts.map(x => x.pass), [null, true]);
    assert.ok(!results[1].previousAttempts[1].previousAttempts);
    // Başka katmanla yapılmış bir çalıştırmanın özetine karıştırılmaz.
    assert.throws(() => runModule.previousResults(outDir, { ...a, tier: 'fast' }), /başka bir çalıştırmaya ait/);
    assert.deepStrictEqual(runModule.previousResults(path.join(outDir, 'yok'), a), []);
    // Yarıda kalan bir çalıştırmanın özeti tamamlanmış görünmez: total planlanan görevleri de sayar.
    assert.strictEqual(runModule.summaryTotal([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }, { id: 'd' }]), 4);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('summary.json alanlarında (leftoverDir, hata mesajı) yerel yollar yer tutucuyla değişir', () => {
  const left = path.join(os.tmpdir(), 'model-eval-AbC123');
  const result = {
    id: 'fix-pagination', durationMs: 1234, pass: null, changed: ['paginate.js'],
    leftoverDir: left,
    error: `EBUSY: resource busy or locked, rmdir '${left}'`,
    environmentError: `Codex config found above the check dir (${path.join(os.homedir(), '.cache', 'x')}); not a model result.`,
  };
  const out = runModule.redactDeep(result);
  const json = JSON.stringify(out);
  assert.ok(!json.toLowerCase().includes(os.userInfo().username.toLowerCase()), json);
  assert.strictEqual(out.leftoverDir, `<tmp>${path.sep}model-eval-AbC123`);
  assert.match(out.error, /rmdir '<tmp>[\\/]model-eval-AbC123'/);
  assert.match(out.environmentError, /\(~[\\/]\.cache[\\/]x\)/);
  assert.deepStrictEqual([out.durationMs, out.pass, out.changed], [1234, null, ['paginate.js']]);
});

test('tuzak satırlara yapılan atıflar sayılır, diğerleri sayılmaz', () => {
  const decoys = { 'server.js': [[10, 12], [42, 45]] };
  const answer = [
    'server.js:17 prefix bypass (high)',
    'server.js:43 XSS in greet (false positive)',
    'see server.js:40-42 as well',
    'myserver.js:11 is a different file',
    'server.js:24 reflected XSS',
  ].join('\n');
  assert.deepStrictEqual(runModule.decoyCitations(answer, decoys), ['server.js:43', 'server.js:40-42']);
  assert.deepStrictEqual(runModule.decoyCitations('no citations here', decoys), []);
});

// expect desenleri: tam bir cevap her ekilen hatayı bulur; tek bir bulguyu anlatan ya da kodun güvenli
// olduğunu açıklayan cevap, diğer hatalar için sahte isabet üretmez.
const hitsFor = (id, answer) => load(id).expect.filter(e => new RegExp(e.pattern, 'i').test(answer)).map(e => e.id);
test('sec-review-auth desenleri: her açık kendi bulgusuyla eşleşir', () => {
  assert.deepStrictEqual(hitsFor('sec-review-auth',
    'auth.js:19 alg none bypass: forge a token with {"alg":"none"} and {"sub":1,"role":"admin"}; full authentication and authorization bypass (privilege escalation)'),
    ['alg-none']);
  assert.deepStrictEqual(hitsFor('sec-review-auth', [
    'auth.js:19 (critical) verifyToken accepts alg none, so the signature check is skipped.',
    'auth.js:38 (high) getInvoice never compares invoice.ownerId with session.sub: IDOR, any user reads any invoice.',
    'auth.js:46 (high) updateProfile uses Object.assign(user, body), so a user can set role to admin (mass assignment).',
  ].join('\n')), ['alg-none', 'idor', 'mass-assignment']);
  // Başlık + gövde biçimi ve farklı ifadeler.
  assert.deepStrictEqual(hitsFor('sec-review-auth', '### 2. Broken access control in getInvoice (auth.js:38)\nAny authenticated user can read any invoice.'), ['idor']);
  assert.deepStrictEqual(hitsFor('sec-review-auth', 'auth.js:38 any user can read invoices of other users'), ['idor']);
  assert.deepStrictEqual(hitsFor('sec-review-auth', '### 3. updateProfile (auth.js:46)\nThe request body is merged into the user record, so a user can set their own role.'), ['mass-assignment']);
});

test('sec-review-fileserver desenleri: başlık + gövde ve farklı ifadeler eşleşir', () => {
  assert.deepStrictEqual(hitsFor('sec-review-fileserver', '### 2. Reflected XSS (server.js:24)\nThe 404 response echoes the decoded path unescaped.'), ['reflected-xss']);
  assert.deepStrictEqual(hitsFor('sec-review-fileserver', 'server.js:24 reflected XSS: the error page interpolates name without escapeHtml'), ['reflected-xss']);
  assert.deepStrictEqual(hitsFor('sec-review-fileserver', 'server.js:17 startsWith(ROOT) lacks a trailing slash, so /srv/public2/x passes'), ['prefix-bypass']);
  assert.deepStrictEqual(hitsFor('sec-review-fileserver', 'a directory like public_backup next to ROOT is reachable via /..%2Fpublic_backup%2Fdb.sql'), ['prefix-bypass']);
  assert.deepStrictEqual(hitsFor('sec-review-fileserver', 'The files are publicly readable by design.'), []);
});

test('sec-review-fileserver desenleri: olumsuz açıklama isabet sayılmaz', () => {
  assert.deepStrictEqual(hitsFor('sec-review-fileserver',
    'server.js:16 path traversal: the startsWith(ROOT) check blocks ../ so this is fine. greet escapes output, so no XSS there.'), []);
  assert.deepStrictEqual(hitsFor('sec-review-fileserver', [
    'server.js:17 (high) startsWith(ROOT) has no separator: /..%2Fpublic-secret%2Fkey.pem reads the sibling folder public-secret.',
    'server.js:24 (high) the 404 page echoes the decoded path unescaped: reflected XSS with /%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E.',
    'server.js:33 (high) hostname.endsWith allows evilimgcdn.net: SSRF.',
  ].join('\n')), ['prefix-bypass', 'reflected-xss', 'ssrf-allowlist']);
});

// Görev setinin kendisi: her görev yüklenir, tohumlanan hata gönderildiği haliyle gerçekten vardır
// (düzeltme görevlerinde kontrol, düzeltilmemiş fixture'da başarısız olur) ve güvenlik görevlerinin
// model çalıştırılmadan önce sabitlenmiş bir rubric.md'si vardır.
for (const id of fs.readdirSync(tasksDir)) {
  test(`görev ${id}: tanım geçerli, hata fixture'da mevcut`, () => {
    const t = load(id);
    assert.strictEqual(t.id, id);
    assert.ok(t.prompt.trim().length > 0);
    if (t.roles.includes('security')) assert.ok(fs.existsSync(path.join(t.base, 'rubric.md')), 'güvenlik görevinin rubric.md dosyası olmalı');
    for (const e of t.expect || []) new RegExp(e.pattern, 'i');
    for (const [file, ranges] of Object.entries(t.decoys || {})) {
      const lines = fs.readFileSync(path.join(t.base, 'fixture', file), 'utf8').split('\n').length;
      for (const [lo, hi] of ranges) assert.ok(lo >= 1 && lo <= hi && hi <= lines, `${file} tuzak aralığı ${lo}-${hi}`);
    }
    if (t.check) {
      const [cmd, ...rest] = t.check.command.split(' ');
      assert.strictEqual(cmd, 'node');
      const r = require('child_process').spawnSync(process.execPath, rest, { cwd: path.join(t.base, 'fixture'), encoding: 'utf8' });
      assert.notStrictEqual(r.status, 0, 'kontrol düzeltilmemiş fixture üzerinde başarısız olmalı');
    }
  });
}

// Claude modelleri (claude -p): sahte CLI ile, gerçek Claude çağrılmaz.
const claudeArgsFor = { model: 'claude-haiku-5-5', effort: 'medium', provider: 'claude', dryRun: false };
function runClaude(mode, id) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-test-out-'));
  process.env.FAKE_MODE = mode;
  process.env.FAKE_CLAUDE_ARGS = path.join(outDir, 'args.json');
  try {
    const r = evaluate(claudeArgsFor, load(id), outDir);
    return { r, args: JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_ARGS, 'utf8')), answer: fs.readFileSync(path.join(outDir, `${id}.md`), 'utf8') };
  } finally {
    delete process.env.FAKE_CLAUDE_ARGS;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

test('Claude: argümanlar doğrulanır; katman ve cyber programı reddedilir', () => {
  const a = runModule.parseArgs(['--model', 'claude-sonnet-5-5', '--effort', 'high']);
  assert.strictEqual(a.provider, 'claude');
  assert.throws(() => runModule.parseArgs(['--model', 'claude-sonnet-5-5', '--effort', 'high', '--tier', 'fast']), /--tier/);
  assert.throws(() => runModule.parseArgs(['--model', 'claude-sonnet-5-5', '--effort', 'ultra']), /Claude/);
  assert.strictEqual(runModule.parseArgs(['--model', 'gpt-6-astra', '--effort', 'high', '--tier', 'default']).provider, 'codex');
});

test('Claude: düzeltme görevinde kabuk yok, düzenleme var; doğru düzeltme yalıtılmış kontrolden geçer', () => {
  const { r, args } = runClaude('claude-fix', 'fix-pagination');
  const tools = args[args.indexOf('--tools') + 1];
  assert.strictEqual(tools, 'Read,Edit,Write,Glob,Grep');
  assert.ok(!/Bash/.test(tools), 'kabuk aracı verilmemeli');
  assert.strictEqual(args[args.indexOf('--permission-prompts') + 1], 'none');
  // MCP araçları ve yerleşik danışman kapalı.
  assert.ok(args.includes('--strict-mcp-config'));
  assert.strictEqual(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.strictEqual(args[args.indexOf('--settings') + 1], '{"advisorModel":""}');
  // Hiçbir ayar kaynağı yüklenmez: kullanıcı plugin'leri/hook'ları ve çalışma klasöründeki .claude ayarları.
  assert.strictEqual(args[args.indexOf('--setting-sources') + 1], '');
  assert.strictEqual(r.checkPassed, true);
  assert.strictEqual(r.pass, true);
  assert.deepStrictEqual(r.usage, { input_tokens: 1503, cached_input_tokens: 500, output_tokens: 40, cost_usd: 0.12 });
});

test('Claude: inceleme görevinde yalnızca okuma araçları; cevap JSON sonucundan okunur', () => {
  const { r, args, answer } = runClaude('claude-review', 'review-readonly');
  assert.strictEqual(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.match(answer, /negative percent/);
  assert.strictEqual(r.readOnlyOk, true);
  assert.strictEqual(r.pass, true);
});

test('Claude: is_error ya da okunamayan çıktı "ölçülmedi" sayılır, hata metni tanı dosyasına yazılır', () => {
  for (const [mode, diag] of [['claude-error', /API Error: overloaded/], ['claude-error-subtype', /error_during_execution.*Tool execution failed: boom/], ['claude-garbage', /not json at all/]]) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-test-out-'));
    process.env.FAKE_MODE = mode;
    try {
      const r = evaluate(claudeArgsFor, load('sec-review-auth'), outDir);
      assert.strictEqual(r.pass, null, mode);
      assert.match(r.environmentError, /^claude -p .*without a final message/, mode);
      assert.match(fs.readFileSync(path.join(outDir, 'sec-review-auth.stderr.txt'), 'utf8'), diag, mode);
      assert.strictEqual(fs.readFileSync(path.join(outDir, 'sec-review-auth.md'), 'utf8'), '', 'hata metni cevaba girmemeli');
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
});

test('Claude: hata alanlarındaki yerel yollar tanı dosyasında da gizlenir (JSON kaçışından önce)', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-test-out-'));
  process.env.FAKE_MODE = 'claude-error-path';
  try {
    evaluate(claudeArgsFor, load('sec-review-auth'), outDir);
    const diag = fs.readFileSync(path.join(outDir, 'sec-review-auth.stderr.txt'), 'utf8');
    assert.match(diag, /<workdir>/);
    assert.ok(!diag.toLowerCase().includes(os.userInfo().username.toLowerCase()), diag);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('Claude: Windows\'ta npm .cmd kısayolu değil yerel claude.exe seçilir', () => {
  if (process.platform !== 'win32') return;
  assert.strictEqual(runModule.pickClaudeExe(['C:/n/npm/claude.cmd', 'C:/u/.local/bin/claude.exe']), 'C:/u/.local/bin/claude.exe');
  assert.strictEqual(runModule.pickClaudeExe(['C:/n/npm/claude.cmd']), null);
});

test('security rolündeki model yalnızca güvenlik görevleri ve kayıttaki programla ölçülür', () => {
  const { securityRoleProblem } = require('./run.cjs');
  const reg = { codex: {
    'gpt-0-sec': { status: 'approved', role: 'security', cyberAccessProgram: 'prog_blue' },
    'gpt-0-cand': { status: 'candidate' },
  } };
  const sec = { id: 'sec-a', roles: ['security', 'frontier'] };
  const fix = { id: 'fix-a', roles: ['workhorse', 'fast', 'frontier'] };
  assert.strictEqual(securityRoleProblem({ model: 'gpt-0-sec', cyber: 'prog_blue' }, [sec], reg), null);
  assert.match(securityRoleProblem({ model: 'gpt-0-sec', cyber: 'prog_blue' }, [sec, fix], reg), /security tasks; not: fix-a/);
  assert.match(securityRoleProblem({ model: 'gpt-0-sec', cyber: 'prog_red' }, [sec], reg), /prog_blue/);
  assert.match(securityRoleProblem({ model: 'gpt-0-sec' }, [sec], reg), /prog_blue/);
  // Aday ya da kayıt okunamazsa sınır yok (adaylar kayıtta onaylı değildir).
  assert.strictEqual(securityRoleProblem({ model: 'gpt-0-cand', cyber: 'prog_red' }, [fix], reg), null);
  assert.strictEqual(securityRoleProblem({ model: 'gpt-0-sec' }, [fix], null), null);
  // Gerçek görev kümesinde fix-pagination güvenlik görevi değildir.
  const tasks = fs.readdirSync(tasksDir).map(d => JSON.parse(fs.readFileSync(path.join(tasksDir, d, 'task.json'), 'utf8')));
  assert.match(securityRoleProblem({ model: 'gpt-0-sec', cyber: 'prog_blue' }, tasks, reg), /fix-pagination/);
});

test('çalıştırıcı kaydı hesabın gerçek ev klasöründen okur: HOME, USERPROFILE ve MODEL_GUARD_REGISTRY yok sayılır', () => {
  const { registryPath } = require('./run.cjs');
  const want = path.join(os.userInfo().homedir, '.claude', 'models', 'registry.json');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, MODEL_GUARD_REGISTRY: process.env.MODEL_GUARD_REGISTRY };
  try {
    process.env.HOME = path.join(os.tmpdir(), 'attacker-home');
    process.env.USERPROFILE = path.join(os.tmpdir(), 'attacker-profile');
    process.env.MODEL_GUARD_REGISTRY = path.join(os.tmpdir(), 'fake.json');
    assert.notStrictEqual(os.homedir(), os.userInfo().homedir, 'os.homedir() ortamı izlemeli (testin ön koşulu)');
    assert.strictEqual(registryPath(), want);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('çalıştırıcı kayıt okunamazsa durur (fail-closed)', () => {
  const { loadRegistry } = require('./run.cjs');
  testHooks.registryPath = path.join(os.tmpdir(), 'no-such-dir-' + process.pid, 'registry.json');
  try {
    assert.throws(() => loadRegistry(), /registry could not be read/);
  } finally {
    delete testHooks.registryPath;
  }
});

test('Claude: modelin .claude/ altına yazdığı dosya araç dosyası sayılmaz, salt okunur denetimine girer', () => {
  const { r } = runClaude('claude-review-writes-claude-dir', 'review-readonly');
  assert.deepStrictEqual(r.changed, ['.claude/settings.local.json']);
  assert.deepStrictEqual(r.harnessFiles, []);
  assert.strictEqual(r.readOnlyOk, false);
  assert.strictEqual(r.pass, false);
});

// --- Tekrar, zaman aşımı kuralı ve görev seti bölümleri (eval v2) ---

test('--repeats 1-10 arası tam sayı, --split dev|frozen olmalı; verilmezse repeats 1', () => {
  const base = ['--model', 'gpt-x', '--effort', 'high', '--tier', 'default'];
  assert.strictEqual(runModule.parseArgs(base).repeats, 1);
  assert.strictEqual(runModule.parseArgs([...base, '--repeats', '3']).repeats, 3);
  assert.strictEqual(runModule.parseArgs([...base, '--repeats', '10']).repeats, 10);
  for (const bad of ['0', '11', '2.5', '-1', 'x', '03']) assert.throws(() => runModule.parseArgs([...base, '--repeats', bad]), /--repeats/);
  assert.strictEqual(runModule.parseArgs([...base, '--split', 'frozen']).split, 'frozen');
  assert.throws(() => runModule.parseArgs([...base, '--split', 'test']), /--split/);
});

test('zaman aşımı kuralı: ilk zaman aşımı ölçülmedi sayılır ve deneme bir kez yinelenir', () => {
  let calls = 0;
  const r = runModule.withTimeoutRetry(() => (++calls === 1 ? { id: 't', run: 1, timedOut: true, pass: false } : { id: 't', run: 1, pass: true }));
  assert.strictEqual(calls, 2);
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.timeoutRetries.length, 1);
  assert.strictEqual(r.timeoutRetries[0].pass, null);
  assert.strictEqual(r.timeoutRetries[0].timeoutUnmeasured, true);
});

test('zaman aşımı kuralı: aynı denemede ikinci zaman aşımı model başarısızlığıdır', () => {
  let calls = 0;
  const r = runModule.withTimeoutRetry(() => { calls++; return { id: 't', timedOut: true, pass: false }; });
  assert.strictEqual(calls, 2);
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.timedOutTwice, true);
});

test('zaman aşımı kuralı: kural ihlaliyle gelen zaman aşımı yinelenmez, başarısızlık kalır', () => {
  for (const v of [{ readOnlyOk: false }, { protectedOk: false }, { linksLeft: true }]) {
    let calls = 0;
    const r = runModule.withTimeoutRetry(() => { calls++; return { id: 't', timedOut: true, pass: false, ...v }; });
    assert.strictEqual(calls, 1, JSON.stringify(v));
    assert.strictEqual(r.pass, false);
  }
  let calls = 0;
  runModule.withTimeoutRetry(() => { calls++; return { id: 't', pass: false, checkTimedOut: true }; });
  assert.strictEqual(calls, 1, 'kontrol zaman aşımı modelin kodudur, yinelenmez');
});

test('zaman aşımı kuralı gerçek değerlendirmede: iki kez süreyi aşan model başarısızdır', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-test-out-'));
  process.env.FAKE_MODE = 'sandbox-claim-then-hang';
  try {
    const task = { ...load('review-readonly'), timeoutSec: 2, run: 1 };
    const r = runModule.withTimeoutRetry(() => evaluate(args, task, outDir));
    assert.strictEqual(r.pass, false);
    assert.strictEqual(r.timedOutTwice, true);
    assert.ok(!r.environmentError);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('tekrarlar: her deneme kendi cevap dosyasına yazılır, sonuç deneme numarasını taşır', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-test-out-'));
  process.env.FAKE_MODE = 'review-good';
  try {
    const r1 = evaluate(args, { ...load('review-readonly'), run: 1 }, outDir);
    const r2 = evaluate(args, { ...load('review-readonly'), run: 2 }, outDir);
    assert.strictEqual(r1.run, 1);
    assert.strictEqual(r2.run, 2);
    assert.deepStrictEqual(fs.readdirSync(outDir).sort(), ['review-readonly.md', 'review-readonly.run2.md']);
    assert.strictEqual(r2.pass, true);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('tekrarlar: aynı görevin farklı denemeleri ayrı tutulur, aynı deneme birleşir; toplam deneme sayısını sayar', () => {
  let results = [{ id: 'a', pass: true }]; // eski özet: run yok = 1. deneme
  results = runModule.mergeResult(results, { id: 'a', run: 2, pass: false });
  results = runModule.mergeResult(results, { id: 'a', run: 1, pass: null });
  assert.deepStrictEqual(results.map(r => [r.id, r.run || 1, r.pass]), [['a', 1, null], ['a', 2, false]]);
  assert.strictEqual(results[0].previousAttempts.length, 1);
  assert.strictEqual(runModule.summaryTotal([{ id: 'a', run: 1 }], [{ id: 'a' }, { id: 'b' }], 3), 6);
});

test('görev seti bölümü: --split yalnızca o bölümdeki görevleri yükler; bölümsüz görevler eski settir', () => {
  const all = runModule.loadTasks(undefined, undefined);
  assert.ok(all.length >= 5);
  const legacy = all.filter(t => t.split === undefined).map(t => t.id);
  for (const split of ['dev', 'frozen']) {
    const got = runModule.loadTasks(undefined, split);
    assert.ok(got.every(t => t.split === split));
    assert.ok(!got.some(t => legacy.includes(t.id)));
  }
});

// --- İnceleme düzeltmeleri (2026-11-27) ---

test('zaman aşımı kuralı: kontrol zaman aşımı ya da kontrol klasörü denetimiyle gelen zaman aşımı yinelenmez', () => {
  for (const v of [{ checkTimedOut: true }, { checkSkipped: 'work dir changed after the model run: x' }]) {
    let calls = 0;
    const r = runModule.withTimeoutRetry(() => { calls++; return { id: 't', timedOut: true, pass: false, ...v }; });
    assert.strictEqual(calls, 1, JSON.stringify(v));
    assert.strictEqual(r.pass, false);
  }
});

test('zaman aşımı kuralı: ilk denemenin dosyaları yeniden denemeden önce saklanır', () => {
  const order = [];
  runModule.withTimeoutRetry(() => { order.push('run'); return { id: 't', timedOut: order.length === 1, pass: true }; }, () => order.push('keep'));
  assert.deepStrictEqual(order, ['run', 'keep', 'run']);
});

test('süreyi aşan modelin düzeltme görevinde kontrol çalıştırılmaz', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-test-out-'));
  process.env.FAKE_MODE = 'sandbox-claim-then-hang';
  try {
    const r = evaluate(args, { ...load('fix-pagination'), timeoutSec: 2, run: 1 }, outDir);
    assert.strictEqual(r.timedOut, true);
    assert.strictEqual(r.checkNotRun, 'model timed out');
    assert.strictEqual(r.checkPassed, false);
    assert.strictEqual(r.pass, false);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('aynı gün tekrar: farklı tekrar sayısı, bölüm ya da görev sürümüyle yapılmış özete karışmaz', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-test-out-'));
  const a = { model: 'gpt-x', effort: 'high', tier: 'default', repeats: 3, split: 'frozen' };
  const write = s => fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ model: 'gpt-x', effort: 'high', tier: 'default', cyberAccessProgram: null, tasks: [], ...s }));
  try {
    write({ repeats: 5, split: 'frozen' });
    assert.throws(() => runModule.previousResults(outDir, a), /tekrar sayısı ya da bölüm/);
    write({ repeats: 3, split: 'dev' });
    assert.throws(() => runModule.previousResults(outDir, a), /tekrar sayısı ya da bölüm/);
    write({ repeats: 3, split: 'frozen', taskVersions: { t: { split: 'frozen', version: 1 } } });
    assert.throws(() => runModule.previousResults(outDir, a, { t: { split: 'frozen', version: 2 } }), /başka bir sürümüne/);
    assert.deepStrictEqual(runModule.previousResults(outDir, a, { t: { split: 'frozen', version: 1 } }), []);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
