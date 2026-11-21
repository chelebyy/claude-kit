// Çalıştırma: node --test installer/test/
// Testler gerçek ~/.claude'a hiç dokunmaz: her test geçici bir ev klasörü kullanır.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mergeSettings, inspectCodexTier, fixCodexTier, answersFromFlags, renderProfile,
  hookCommand, FILES, compareVersions, parseAnswer, QUESTIONS,
} from '../core.mjs';
import { inspectMachine, buildPlan, applyPlan, resolveExe, runCommand, stableNodePath, rulesInstallSkillsUnasked } from '../system.mjs';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-kit-test-'));
const ctx = { home: '/home/ayse', platform: 'linux', nodePath: '/usr/bin/node' };
const base = {
  codex: true, daybreak: false, installCodexCli: false, fixCodexTier: false,
  autoMode: false, autoEnv: 'keep', advisor: false, teams: false, language: 'keep', uiPrefs: false, mcp: [], onConflict: 'keep',
};
const fullFlags = {
  codex: 'yes', daybreak: 'no', 'auto-mode': 'no', advisor: 'no', teams: 'no',
  language: 'keep', 'ui-prefs': 'no', mcp: 'none',
};

test('mergeSettings: boş ayara kitin hook\'larını ekler, onaysız izin eklemez', () => {
  const { settings, added } = mergeSettings({}, base, ctx, null);
  assert.deepEqual(settings.permissions.allow, [], 'npx skills izinleri onaysız çalıştırma açığıydı; kit hiç izin eklemez');
  assert.equal(settings.hooks.SessionStart[0].hooks.length, 2);
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Bash|PowerShell|Agent|Task');
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, '"/usr/bin/node" "/home/ayse/.claude/hooks/model-guard.cjs"');
  assert.equal(settings.permissions.defaultMode, undefined, 'auto mod sorulmadan açılmamalı');
  assert.equal(settings.advisorModel, undefined);
  assert.equal(added.allow.length, 0);
});

test('mergeSettings: makinedeki anahtarları korur ve iki kez çalışınca değişiklik bulmaz', () => {
  const cur = { model: 'opus', permissions: { allow: ['Bash(ls)'], deny: ['Bash(rm *)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] }, language: 'English' };
  const a = { ...base, autoMode: true, advisor: true, teams: true, language: 'Turkish', uiPrefs: true };
  const first = mergeSettings(cur, a, ctx, null);
  assert.equal(first.settings.model, 'opus');
  assert.deepEqual(first.settings.permissions.deny, ['Bash(rm *)']);
  assert.ok(first.settings.permissions.allow.includes('Bash(ls)'));
  assert.equal(first.settings.hooks.Stop.length, 1);
  assert.equal(first.settings.language, 'Turkish');
  assert.equal(first.settings.permissions.defaultMode, 'auto');
  const second = mergeSettings(first.settings, a, ctx, { added: first.added });
  assert.deepEqual(second.notes, []);
  assert.deepEqual(second.settings, first.settings);
  assert.deepEqual(second.added, first.added, 'kitin eklediği girdiler ikinci çalışmada da kitin malı kalmalı');
});

test('mergeSettings: aynı matcher\'la aynı betiği ters bölüyle çağıran hook varsa yenisini eklemez', () => {
  const win = { home: 'C:\\Users\\ayse', platform: 'win32', nodePath: 'C:\\Program Files\\nodejs\\node.exe' };
  const cur = { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell|Agent|Task', hooks: [{ type: 'command', command: '"C:\\Program Files\\NodeJS\\node.exe" "C:\\Users\\Ayse\\.claude\\hooks\\model-guard.cjs"' }] }] } };
  const { settings } = mergeSettings(cur, base, win, null);
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.equal(settings.hooks.PreToolUse[0].hooks.length, 1);
});

test('mergeSettings: eski kurulumun onaysız npx skills izinleri (geniş olan dahil) kaldırılır', () => {
  const old = ['Bash(ls)', 'Bash(npx skills add *)', 'Bash(npx skills add anthropics/*)', 'Bash(npx skills add chelebyy/*)',
    'Bash(npx skills add chelebyy/*)', 'Bash(npx skills find *)', 'Bash(npx skills add openai/*)', 'Bash(npx skills add vercel-labs/*)'];
  const { settings, notes } = mergeSettings({ permissions: { allow: [...old] } }, base, ctx, null);
  assert.deepEqual(settings.permissions.allow, ['Bash(ls)']);
  assert.ok(notes.some(n => n.includes('onaysız skill kurulumu izni kaldırıldı')));
});

test('mergeSettings: beklenmeyen yapıdaki ayarı birleştirmez (hooks dizi, allow nesne)', () => {
  assert.throws(() => mergeSettings({ hooks: [] }, { ...base, autoMode: true }, ctx, null), /hooks/);
  assert.throws(() => mergeSettings({ hooks: { PreToolUse: {} } }, base, ctx, null), /hooks.PreToolUse/);
  assert.throws(() => mergeSettings({ permissions: { allow: {} } }, base, ctx, null), /permissions.allow/);
  assert.throws(() => mergeSettings({ permissions: [] }, base, ctx, null), /permissions/);
});

test('mergeSettings: hook komutunda kabukta genişleyen karakterli Node ya da ev yolu reddedilir', () => {
  for (const nodePath of ['/tmp/$(touch PWN)/node', '/tmp/`id`/node', 'C:\\%PATH%\\node.exe', '/a"b/node', '/tmp/!x/node']) {
    assert.throws(() => mergeSettings({}, base, { ...ctx, nodePath }, null), /güvenle kullanılamayacak/, nodePath);
  }
  assert.throws(() => mergeSettings({}, base, { ...ctx, home: '/home/$USER' }, null), /güvenle kullanılamayacak/);
  // Normal yollar (boşluk, parantez, Türkçe harf) kabul edilir.
  mergeSettings({}, base, { home: 'C:\\Users\\Ayşe Çelik', platform: 'win32', nodePath: 'C:\\Program Files (x86)\\nodejs\\node.exe' }, null);
});

test('mergeSettings: auto mod istenmezse makinedeki auto mod kapatılır', () => {
  const { settings, notes } = mergeSettings({ permissions: { defaultMode: 'auto' } }, base, ctx, null);
  assert.equal(settings.permissions.defaultMode, undefined);
  assert.ok(notes.some(n => n.includes('defaultMode')));
  const other = mergeSettings({ permissions: { defaultMode: 'acceptEdits' } }, base, ctx, null);
  assert.equal(other.settings.permissions.defaultMode, 'acceptEdits', 'auto dışındaki bir seçime dokunulmaz');
});

test('mergeSettings: daha dar matcher\'la ya da başka ev dizininde kayıtlı model-guard yetmez', () => {
  const narrow = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "/home/ayse/.claude/hooks/model-guard.cjs"' }] }] } };
  const a1 = mergeSettings(narrow, base, ctx, null).settings.hooks.PreToolUse;
  assert.ok(a1.some(g => g.matcher === 'Bash|PowerShell|Agent|Task' && g.hooks.some(h => h.command.includes('model-guard.cjs'))));
  const stale = { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell|Agent|Task', hooks: [{ type: 'command', command: 'node "/home/eski/.claude/hooks/model-guard.cjs"' }] }] } };
  const a2 = mergeSettings(stale, base, ctx, null).settings.hooks.PreToolUse[0].hooks;
  assert.ok(a2.some(h => h.command === '"/usr/bin/node" "/home/ayse/.claude/hooks/model-guard.cjs"'));
});

test('mergeSettings: makinede olan autoMode.environment\'a dokunmaz', () => {
  const cur = { autoMode: { environment: ['$defaults', 'kendi tanımım'] } };
  const { settings } = mergeSettings(cur, { ...base, autoMode: true, autoEnv: 'mine' }, ctx, null);
  assert.deepEqual(settings.autoMode.environment, ['$defaults', 'kendi tanımım']);
  const fresh = mergeSettings({}, { ...base, autoMode: true, autoEnv: 'mine' }, { ...ctx, platform: 'darwin' }, null);
  assert.match(fresh.settings.autoMode.environment[1], /\(macOS\)/);
});

test('hookCommand: Windows ters bölülerini düzeltir', () => {
  assert.equal(hookCommand('C:\\Users\\ayse', 'x.cjs', 'C:\\Program Files\\nodejs\\node.exe'), '"C:/Program Files/nodejs/node.exe" "C:/Users/ayse/.claude/hooks/x.cjs"');
});

test('inspectCodexTier: yalnızca en üst düzeydeki service_tier sayılır', () => {
  assert.deepEqual(inspectCodexTier(null), { exists: false, tier: null, needsFix: true, fastModeOff: false, count: 0, ambiguous: false });
  assert.equal(inspectCodexTier('service_tier = "fast"\n').needsFix, false);
  assert.equal(inspectCodexTier('service_tier = "priority"\n').needsFix, false);
  assert.equal(inspectCodexTier('model = "x"\nservice_tier = "default"\n').tier, 'default');
  const inTable = inspectCodexTier('[profiles.x]\nservice_tier = "fast"\n');
  assert.equal(inTable.tier, null);
  assert.equal(inTable.needsFix, true);
  assert.equal(inspectCodexTier('service_tier = "fast"\n[features]\nfast_mode = false\n').fastModeOff, true);
  assert.equal(inspectCodexTier('[other]\nfast_mode = false\n').fastModeOff, false);
});

test('fixCodexTier: satırı değiştirir ya da tablolardan önce ekler, satır sonlarını korur', () => {
  assert.equal(fixCodexTier(null), 'service_tier = "fast"\n');
  assert.equal(fixCodexTier('a = 1\r\nservice_tier = "default"\r\n[x]\r\n'), 'a = 1\r\nservice_tier = "fast"\r\n[x]\r\n');
  const added = fixCodexTier('[features]\nservice_tier = "default"\n');
  assert.equal(added, 'service_tier = "fast"\n[features]\nservice_tier = "default"\n');
  assert.equal(inspectCodexTier(added).tier, 'fast');
});

test('answersFromFlags: eksik bayrakları listeler, gereksiz soruları atlar', () => {
  const m = { codexOnPath: true, codexTier: { needsFix: false }, hasAutoEnv: true, rulesConflict: () => false };
  const missing = answersFromFlags({}, m);
  assert.ok(missing.errors.some(e => e.startsWith('--codex gerekli')));
  const ok = answersFromFlags({ ...fullFlags, codex: 'no' }, m);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.answers.daybreak, false, 'Codex yoksa Daybreak sorulmaz');
  const noDaybreak = answersFromFlags({ ...fullFlags, daybreak: undefined }, m);
  assert.ok(noDaybreak.errors.some(e => e.startsWith('--daybreak gerekli')));
  assert.ok(answersFromFlags({ ...fullFlags, mcp: 'lemma,bilinmeyen' }, m).errors.some(e => e.startsWith('--mcp geçersiz')));
  const conflict = answersFromFlags(fullFlags, { ...m, rulesConflict: () => true });
  assert.ok(conflict.errors.some(e => e.startsWith('--on-conflict gerekli')));
});

test('parseAnswer: dil yalnızca harf ve boşluk kabul eder', () => {
  const q = QUESTIONS.find(x => x.key === 'language');
  assert.equal(parseAnswer(q, 'Turkish'), 'Turkish');
  assert.equal(parseAnswer(q, 'x"; rm -rf /'), undefined);
});

test('kurallar: skill kurulumu her kaynakta kullanıcıya sorulur; şablon yer tutucusu kalmadı', () => {
  const rules = FILES.filter(x => x.kind === 'rules');
  assert.equal(rules.length, 2);
  for (const f of rules) {
    const text = fs.readFileSync(path.join(kitRoot, f.src), 'utf8');
    assert.ok(!text.includes('{{'), f.src);
    assert.equal(rulesInstallSkillsUnasked(text), false, f.src);
    assert.match(text, /Hangi kaynaktan olursa olsun kurmadan önce kullanıcıya sor|Whatever the source, ask the user before installing/, f.src);
  }
  assert.doesNotMatch(renderProfile({ codex: true, daybreak: true }), /skill/i);
  assert.match(renderProfile({ codex: true, daybreak: false }), /Codex: var\n.*Daybreak.*: yok/);
  assert.match(renderProfile({ codex: false, daybreak: true }), /Daybreak.*: yok/, 'Codex yoksa Daybreak da yok sayılır');
});

test('compareVersions', () => {
  assert.equal(compareVersions('2.1.328', '2.1.271'), 1);
  assert.equal(compareVersions('2.1.271', '2.1.271'), 0);
  assert.equal(compareVersions('2.0.999', '2.1.0'), -1);
});

function plan(home, a) {
  const m = inspectMachine({ home, kitRoot, realHome: path.join(home, 'başka') });
  return { m, steps: buildPlan(a, m) };
}

test('kurulum: boş ev klasörüne kurar, ikinci çalışmada hiçbir şey değişmez', () => {
  const home = tmpHome();
  const a = { ...base, mcp: ['figma'] };
  const { m, steps } = plan(home, a);
  const calls = [];
  const { results } = applyPlan(steps, a, m, { run: argv => { calls.push(argv); return { ok: true, output: '' }; } });
  assert.deepEqual(calls, [], 'ev klasörü gerçek değilken komut çalışmamalı');
  assert.ok(results.every(r => r.result !== 'fail'), JSON.stringify(results.filter(r => r.result === 'fail')));
  for (const rel of ['.claude/CLAUDE.md', '.claude/hooks/model-guard.cjs', '.claude/agents/reviewer-high.md', '.codex/AGENTS.md',
    '.agents/skills/security-review-gate/SKILL.md', '.claude/rules/claude-kit-profile.md', '.claude/claude-kit.json']) {
    assert.ok(fs.existsSync(path.join(home, rel)), rel);
  }
  assert.ok(!fs.readFileSync(path.join(home, '.claude/CLAUDE.md'), 'utf8').includes('{{'));
  JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
  const again = plan(home, a);
  const changing = again.steps.filter(s => ['create', 'update'].includes(s.status));
  assert.deepEqual(changing.map(s => s.label), []);
});

test('kurulum: Codex yoksa Codex dosyaları ve plugin\'i plana girmez', () => {
  const home = tmpHome();
  const { steps } = plan(home, { ...base, codex: false });
  assert.ok(!steps.some(s => s.label.includes('.codex/') || s.label.includes('security-review-gate') || s.label.includes('codex@')));
});

test('kurulum: farklı CLAUDE.md keep ile korunur, replace ile yedeklenip değiştirilir', () => {
  const home = tmpHome();
  const f = path.join(home, '.claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'benim kurallarım\n');
  let p = plan(home, { ...base, onConflict: 'keep' });
  assert.equal(p.steps.find(s => s.label === '~/.claude/CLAUDE.md').status, 'keep');
  applyPlan(p.steps, { ...base, onConflict: 'keep' }, p.m, { run: () => ({ ok: true, output: '' }) });
  assert.equal(fs.readFileSync(f, 'utf8'), 'benim kurallarım\n');
  p = plan(home, { ...base, onConflict: 'replace' });
  const { backups } = applyPlan(p.steps, { ...base, onConflict: 'replace' }, p.m, { run: () => ({ ok: true, output: '' }) });
  assert.notEqual(fs.readFileSync(f, 'utf8'), 'benim kurallarım\n');
  const b = backups.find(x => x.startsWith(f + '.bak-'));
  assert.ok(b);
  assert.equal(fs.readFileSync(b, 'utf8'), 'benim kurallarım\n');
});

test('kurulum: bozuk settings.json\'a dokunulmaz ve hata olarak raporlanır', () => {
  const home = tmpHome();
  const f = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{ bozuk');
  const p = plan(home, base);
  const { results } = applyPlan(p.steps, base, p.m, { run: () => ({ ok: true, output: '' }) });
  assert.equal(fs.readFileSync(f, 'utf8'), '{ bozuk');
  assert.equal(results.find(r => r.group === 'ayar').result, 'fail');
});

test('kurulum: gerçek ev klasöründe eksik plugin ve MCP için komut çalışır, anahtarlı MCP elle kalır', () => {
  const home = tmpHome();
  const m = inspectMachine({ home, kitRoot, realHome: home });
  const steps = buildPlan({ ...base, mcp: ['figma', 'context7'] }, m);
  const runs = steps.filter(s => s.status === 'run').map(s => s.argv.join(' '));
  assert.ok(runs.includes('claude plugin install codex@openai-codex -s user'));
  assert.ok(runs.includes('claude plugin marketplace add openai/codex-plugin-cc'));
  assert.ok(runs.some(r => r.startsWith('npx -y skills@') && r.includes('--skill find-skills')));
  assert.ok(runs.includes('claude mcp add -s user --transport http figma https://mcp.figma.com/mcp'));
  assert.ok(!runs.some(r => r.includes('context7')));
  assert.equal(steps.find(s => s.label === 'context7').status, 'manual');
});

test('runCommand: kabuk gereken .cmd programında güvensiz argümanı reddeder', () => {
  const dir = tmpHome();
  fs.writeFileSync(path.join(dir, 'aracim.cmd'), '@echo off\r\n');
  const env = { PATH: dir, PATHEXT: '.EXE;.CMD' };
  assert.equal(resolveExe('aracim', env, 'win32'), path.join(dir, 'aracim.cmd'));
  const r = runCommand(['aracim', 'iyi', 'kötü&calc'], { home: dir, env, platform: 'win32' });
  assert.equal(r.ok, false);
  assert.match(r.output, /güvensiz argüman/);
});

test('resolveExe: göreli PATH girdilerini (ör. ".") yok sayar', () => {
  const dir = tmpHome();
  fs.writeFileSync(path.join(dir, 'aracim'), '');
  const prev = process.cwd();
  process.chdir(dir);
  try { assert.equal(resolveExe('aracim', { PATH: '.' }, 'linux'), null); } finally { process.chdir(prev); }
});

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

test('plan: aynı adla başka kaynağa kayıtlı market varsa plugin kurulmaz', () => {
  const home = tmpHome();
  writeJson(path.join(home, '.claude/plugins/known_marketplaces.json'), {
    'openai-codex': { source: { source: 'github', repo: 'saldirgan/codex-plugin-cc' } },
    'claude-plugins-official': { source: { source: 'github', repo: 'anthropics/claude-plugins-official' } },
  });
  const m = inspectMachine({ home, kitRoot, realHome: home });
  const steps = buildPlan(base, m);
  assert.equal(steps.find(s => s.label === 'market openai-codex').status, 'error');
  assert.equal(steps.find(s => s.label === 'codex@openai-codex').status, 'error');
  assert.ok(!steps.some(s => s.status === 'run' && s.argv.join(' ').includes('codex@openai-codex')));
  assert.ok(!steps.some(s => s.label === 'market claude-plugins-official'), 'doğru kayıtlı market yeniden eklenmez');
});

test('plan: resmi market kayıtlı değilse önce eklenir; git URL\'li doğru kayıt kabul edilir', () => {
  const home = tmpHome();
  let steps = buildPlan({ ...base, codex: false }, inspectMachine({ home, kitRoot, realHome: home }));
  assert.equal(steps.filter(s => s.label === 'market claude-plugins-official').length, 1);
  assert.deepEqual(steps.find(s => s.label === 'market claude-plugins-official').argv, ['claude', 'plugin', 'marketplace', 'add', 'anthropics/claude-plugins-official']);
  writeJson(path.join(home, '.claude/plugins/known_marketplaces.json'), {
    'claude-plugins-official': { source: { source: 'git', url: 'https://github.com/anthropics/claude-plugins-official.git' } },
  });
  steps = buildPlan({ ...base, codex: false }, inspectMachine({ home, kitRoot, realHome: home }));
  assert.ok(!steps.some(s => s.label === 'market claude-plugins-official'));
});

test('plan: yalnızca başka bir projeye kurulmuş plugin kurulu sayılmaz', () => {
  const home = tmpHome();
  writeJson(path.join(home, '.claude/plugins/installed_plugins.json'), { version: 2, plugins: {
    'commit-commands@claude-plugins-official': [{ scope: 'project', projectPath: '/proje' }],
    'claude-md-management@claude-plugins-official': [{ scope: 'user' }],
  } });
  const steps = buildPlan({ ...base, codex: false }, inspectMachine({ home, kitRoot, realHome: home }));
  assert.equal(steps.find(s => s.label === 'commit-commands@claude-plugins-official').status, 'run');
  assert.equal(steps.find(s => s.label === 'claude-md-management@claude-plugins-official').status, 'same');
});

test('uygulama: bir kit dosyası yazılamazsa ayarlar ve komutlar uygulanmaz', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.claude/hooks/model-guard.cjs'), { recursive: true }); // dosya yerine klasör: yazılamaz
  const a = { ...base, autoMode: true };
  const m = inspectMachine({ home, kitRoot, realHome: home });
  const steps = buildPlan(a, m);
  const calls = [];
  const { results } = applyPlan(steps, a, m, { run: argv => { calls.push(argv); return { ok: true, output: '' }; } });
  assert.equal(results.find(r => r.label === '~/.claude/hooks/model-guard.cjs').result, 'fail');
  assert.ok(!fs.existsSync(path.join(home, '.claude/settings.json')), 'auto mod eksik güvenlik hook\'uyla açılmamalı');
  assert.deepEqual(calls, []);
});

test('uygulama: plandan sonra settings.json\'a eklenen değişiklik korunur', () => {
  const home = tmpHome();
  const f = path.join(home, '.claude/settings.json');
  writeJson(f, { permissions: { allow: [] } });
  const m = inspectMachine({ home, kitRoot, realHome: path.join(home, 'başka') });
  const steps = buildPlan(base, m);
  writeJson(f, { permissions: { allow: [], deny: ['Bash(rm *)'] } }); // başka bir oturum araya girdi
  applyPlan(steps, base, m, { run: () => ({ ok: true, output: '' }) });
  const after = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(after.permissions.deny, ['Bash(rm *)']);
  assert.ok(after.hooks.PreToolUse.some(g => g.hooks.some(h => h.command.includes('model-guard.cjs'))), 'kitin değişikliği de uygulanmış olmalı');
});

test('uygulama: aynı anda iki kurulum yedeklerin üzerine yazmaz', () => {
  const home = tmpHome();
  const f = path.join(home, '.claude', 'CLAUDE.md');
  const now = new Date(2026, 10, 19, 12, 0, 0);
  const a = { ...base, onConflict: 'replace' };
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'birinci\n');
  let p = plan(home, a);
  const one = applyPlan(p.steps, a, p.m, { run: () => ({ ok: true, output: '' }), now }).backups.filter(b => b.startsWith(f + '.bak-'));
  fs.writeFileSync(f, 'ikinci\n');
  p = plan(home, a);
  const two = applyPlan(p.steps, a, p.m, { run: () => ({ ok: true, output: '' }), now }).backups.filter(b => b.startsWith(f + '.bak-'));
  assert.notEqual(one[0], two[0]);
  assert.equal(fs.readFileSync(one[0], 'utf8'), 'birinci\n');
  assert.equal(fs.readFileSync(two[0], 'utf8'), 'ikinci\n');
});

test('uygulama: var olan dosyanın izinleri korunur, yeni ayar dosyası 0600 olur', { skip: process.platform === 'win32' && 'Windows POSIX izinlerini desteklemez' }, () => {
  const home = tmpHome();
  const f = path.join(home, '.claude/settings.json');
  writeJson(f, {});
  fs.chmodSync(f, 0o600);
  let p = plan(home, base);
  applyPlan(p.steps, base, p.m, { run: () => ({ ok: true, output: '' }) });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const home2 = tmpHome();
  p = plan(home2, base);
  applyPlan(p.steps, base, p.m, { run: () => ({ ok: true, output: '' }) });
  assert.equal(fs.statSync(path.join(home2, '.claude/settings.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(home2, '.claude/claude-kit.json')).mode & 0o777, 0o600);
});

test('hookRegistered: yalnızca tam komut, doğru tür ve yeterli timeout kabul edilir', async () => {
  const { hookRegistered, HOOKS } = await import('../core.mjs');
  const h = HOOKS.find(x => x.script === 'model-guard.cjs');
  // model-guard kaydı onFailure: block taşımalı (başlatılamazsa araç çağrısı geçmesin).
  const g = hook => [{ matcher: h.matcher, hooks: [{ type: 'command', onFailure: 'block', ...hook }] }];
  assert.equal(hookRegistered([{ matcher: h.matcher, hooks: [{ type: 'command', command: '"/usr/bin/node" "/home/ayse/.claude/hooks/model-guard.cjs"' }] }], h, ctx), false, 'onFailure olmadan sayılmaz');
  const ok = '"/usr/bin/node" "/home/ayse/.claude/hooks/model-guard.cjs"';
  assert.equal(hookRegistered(g({ command: ok, timeout: 5 }), h, ctx), true);
  assert.equal(hookRegistered(g({ command: '/usr/bin/node /home/ayse/.claude/hooks/model-guard.cjs' }), h, ctx), true);
  // Yalın node, projedeki sahte bir node.cmd ile ele geçirilebilir: kayıtlı sayılmaz.
  assert.equal(hookRegistered(g({ command: 'node "/home/ayse/.claude/hooks/model-guard.cjs"', timeout: 5 }), h, ctx), false);
  // Engelleyemeyen ya da koşullu kayıtlar sayılmaz.
  assert.equal(hookRegistered(g({ command: ok, async: true }), h, ctx), false);
  assert.equal(hookRegistered(g({ command: ok, if: 'Bash(git *)' }), h, ctx), false);
  assert.equal(hookRegistered(g({ command: 'node "$HOME/.claude/hooks/model-guard.cjs"', timeout: 5 }), h, ctx), false, 'eski yalın node biçimi');
  for (const bad of [
    { command: 'echo /home/ayse/.claude/hooks/model-guard.cjs' },
    { command: '"/usr/bin/node" "/home/ayse/.claude/hooks/model-guard.cjs.old"' },
    { command: 'node "/backup/home/ayse/.claude/hooks/model-guard.cjs"' },
    { command: '"/usr/bin/node" "/home/ayse/.claude/hooks/model-guard.cjs" && true' },
    { command: ok, timeout: 0.001 },
    { command: ok, timeout: '5' },
  ]) assert.equal(hookRegistered(g(bad), h, ctx), false, JSON.stringify(bad));
  assert.equal(hookRegistered([{ matcher: h.matcher, hooks: [{ type: 'prompt', command: ok }] }], h, ctx), false);
  const merged = mergeSettings({ hooks: { PreToolUse: g({ command: 'echo /home/ayse/.claude/hooks/model-guard.cjs' }) } }, base, ctx, null);
  assert.ok(merged.settings.hooks.PreToolUse[0].hooks.some(x => x.command === ok), 'sahte kayıt gerçek hook\'un eklenmesini engellememeli');
});

test('uygulama: market plan ile onay arasında değişirse ya da eklenemezse plugin kurulmaz', () => {
  const home = tmpHome();
  const reg = path.join(home, '.claude/plugins/known_marketplaces.json');
  writeJson(reg, { 'claude-plugins-official': { source: { source: 'github', repo: 'anthropics/claude-plugins-official' } } });
  const a = { ...base, codex: true };
  const m = inspectMachine({ home, kitRoot, realHome: home });
  const steps = buildPlan(a, m);
  writeJson(reg, { 'claude-plugins-official': { source: { source: 'github', repo: 'saldirgan/plugins' } } });
  const calls = [];
  const { results } = applyPlan(steps, a, m, { run: argv => { calls.push(argv.join(' ')); return { ok: !argv.includes('marketplace'), output: 'hata' }; } });
  assert.ok(!calls.some(c => c.startsWith('claude plugin install')), calls.join('\n'));
  assert.equal(results.find(r => r.label === 'commit-commands@claude-plugins-official').result, 'fail');
  assert.equal(results.find(r => r.label === 'codex@openai-codex').result, 'fail', 'market ekleme başarısızsa bağlı plugin kurulmaz');
});

test('uygulama: planda güncel görünen güvenlik dosyası sonradan değişmişse yeniden yazılır, yazılamazsa durulur', () => {
  const home = tmpHome();
  let p = plan(home, base);
  applyPlan(p.steps, base, p.m, { run: () => ({ ok: true, output: '' }) });
  const guard = path.join(home, '.claude/hooks/model-guard.cjs');
  const good = fs.readFileSync(guard, 'utf8');
  p = plan(home, { ...base, autoMode: true });
  assert.equal(p.steps.find(s => s.label === '~/.claude/hooks/model-guard.cjs').status, 'same');
  fs.writeFileSync(guard, '// devre dışı\n');
  applyPlan(p.steps, { ...base, autoMode: true }, p.m, { run: () => ({ ok: true, output: '' }) });
  assert.equal(fs.readFileSync(guard, 'utf8'), good);
  p = plan(home, { ...base, autoMode: true });
  fs.rmSync(guard);
  fs.mkdirSync(guard);
  const settings = path.join(home, '.claude/settings.json');
  const before = fs.readFileSync(settings, 'utf8');
  const { results } = applyPlan(p.steps, { ...base, autoMode: true }, p.m, { run: () => ({ ok: true, output: '' }) });
  assert.equal(results.find(r => r.label === '~/.claude/hooks/model-guard.cjs').result, 'fail');
  assert.equal(fs.readFileSync(settings, 'utf8'), before, 'auto mod açılmamalı');
});

test('hookRegistered: satır sonuyla bölünmüş komut kabul edilmez', async () => {
  const { hookRegistered, HOOKS } = await import('../core.mjs');
  const h = HOOKS.find(x => x.script === 'model-guard.cjs');
  for (const command of ['node\n/home/ayse/.claude/hooks/model-guard.cjs', 'node\r\n"/home/ayse/.claude/hooks/model-guard.cjs"',
    'node "/home/ayse/.claude/hooks/model-guard.cjs"\n', 'node "/home/ayse/.claude/hooks/model-guard.cjs\nx"']) {
    assert.equal(hookRegistered([{ matcher: h.matcher, hooks: [{ type: 'command', command }] }], h, ctx), false, JSON.stringify(command));
  }
});

test('uygulama: market ekleme başarısızsa kayıt dosyası doğru görünse bile plugin kurulmaz', () => {
  const home = tmpHome();
  const reg = path.join(home, '.claude/plugins/known_marketplaces.json');
  const a = { ...base, codex: false };
  const m = inspectMachine({ home, kitRoot, realHome: home });
  const steps = buildPlan(a, m);
  const calls = [];
  applyPlan(steps, a, m, { run: argv => {
    calls.push(argv.join(' '));
    if (argv.includes('marketplace')) {
      writeJson(reg, { 'claude-plugins-official': { source: { source: 'github', repo: 'anthropics/claude-plugins-official' } } });
      return { ok: false, output: 'checkout başarısız' };
    }
    return { ok: true, output: '' };
  } });
  assert.ok(!calls.some(c => c.startsWith('claude plugin install')), calls.join('\n'));
});

test('uygulama: planda güncel olan CLAUDE.md onaydan önce değiştirilirse keep ile korunur', () => {
  const home = tmpHome();
  let p = plan(home, base);
  applyPlan(p.steps, base, p.m, { run: () => ({ ok: true, output: '' }) });
  p = plan(home, base);
  assert.equal(p.steps.find(s => s.label === '~/.claude/CLAUDE.md').status, 'same');
  const f = path.join(home, '.claude/CLAUDE.md');
  fs.writeFileSync(f, 'onay beklerken yazdığım kural\n');
  const { results } = applyPlan(p.steps, base, p.m, { run: () => ({ ok: true, output: '' }) });
  assert.equal(fs.readFileSync(f, 'utf8'), 'onay beklerken yazdığım kural\n');
  assert.equal(results.find(r => r.label === '~/.claude/CLAUDE.md').result, 'keep');
});

test('uygulama: içeriği doğru olsa da sembolik bağlantı olan güvenlik dosyası normal dosyayla değiştirilir', (t) => {
  const home = tmpHome();
  let p = plan(home, base);
  applyPlan(p.steps, base, p.m, { run: () => ({ ok: true, output: '' }) });
  const guard = path.join(home, '.claude/hooks/model-guard.cjs');
  const target = path.join(tmpHome(), 'baska-yer.cjs');
  fs.copyFileSync(guard, target);
  fs.rmSync(guard);
  try { fs.symlinkSync(target, guard, 'file'); } catch (err) { t.skip(`sembolik bağlantı oluşturulamadı: ${err.code}`); return; }
  p = plan(home, base);
  applyPlan(p.steps, base, p.m, { run: () => ({ ok: true, output: '' }) });
  const st = fs.lstatSync(guard);
  assert.ok(st.isFile() && !st.isSymbolicLink());
  assert.equal(fs.readFileSync(guard, 'utf8'), fs.readFileSync(target, 'utf8'));
});

test('install.mjs: CLAUDE_CONFIG_DIR başka bir dizini gösteriyorsa kurulum durur', async () => {
  const { spawnSync } = await import('node:child_process');
  const home = tmpHome();
  const r = spawnSync(process.execPath, [path.join(kitRoot, 'install.mjs'), '--home', home, '--no-tui', ...Object.entries(fullFlags).map(([k, v]) => `--${k}=${v}`)],
    { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(home, 'baska') } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /CLAUDE_CONFIG_DIR/);
  assert.ok(!fs.existsSync(path.join(home, '.claude')));
});

test('mergeSettings: kitin eski yalın-node ve zayıflatılmış kayıtları doğru kayıtla değiştirilir, başka hook\'lara dokunulmaz', () => {
  const cur = { hooks: {
    SessionStart: [{ matcher: 'startup', hooks: [
      { type: 'command', command: 'node "$HOME/.claude/hooks/auto-plugins.cjs"', timeout: 10 },
      { type: 'command', command: 'node "/home/ayse/.claude/hooks/model-watch.cjs"', timeout: 15 },
      { type: 'command', command: 'kendi-hookum.sh' },
    ] }],
    PreToolUse: [{ matcher: 'Bash|PowerShell|Agent|Task', hooks: [{ type: 'command', command: '"/usr/bin/node" "/home/ayse/.claude/hooks/model-guard.cjs"', timeout: 5, async: true }] }],
  } };
  const { settings, notes } = mergeSettings(cur, base, ctx, null);
  const ss = settings.hooks.SessionStart.flatMap(g => g.hooks.map(h => h.command));
  assert.deepEqual(ss.filter(c => c.includes('auto-plugins')), ['"/usr/bin/node" "/home/ayse/.claude/hooks/auto-plugins.cjs"']);
  assert.deepEqual(ss.filter(c => c.includes('model-watch')), ['"/usr/bin/node" "/home/ayse/.claude/hooks/model-watch.cjs"']);
  assert.ok(ss.includes('kendi-hookum.sh'));
  const pre = settings.hooks.PreToolUse.flatMap(g => g.hooks);
  assert.equal(pre.length, 1);
  assert.equal(pre[0].async, undefined);
  assert.equal(notes.filter(n => n.startsWith('hook güncellendi')).length, 3);
  assert.deepEqual(mergeSettings(settings, base, ctx, null).notes, [], 'ikinci çalışmada değişiklik yok');
});

test('mergeSettings: disableAllHooks açıksa auto mod açılmaz', () => {
  const { settings, notes } = mergeSettings({ disableAllHooks: true }, { ...base, autoMode: true }, ctx, null);
  assert.equal(settings.permissions.defaultMode, undefined);
  assert.ok(notes.some(n => n.includes('disableAllHooks')));
});

test('mergeSettings: geniş izin birden çok kez yazılmışsa hepsi kaldırılır', () => {
  const { settings } = mergeSettings({ permissions: { allow: ['Bash(npx skills add *)', 'Bash(ls)', 'Bash(npx skills add *)'] } }, base, ctx, null);
  assert.ok(!settings.permissions.allow.includes('Bash(npx skills add *)'));
});

test('codex config: çok satırlı metindeki [satır] ve tırnaklı anahtar doğru okunur, dosya bozulmaz', () => {
  const text = 'model = "x"\ndeveloper_instructions = """\n[Review rules]\nservice_tier = "yanlis"\n"""\nservice_tier = "default"\n[features]\nx = 1\n';
  const i = inspectCodexTier(text);
  assert.equal(i.tier, 'default');
  assert.equal(i.count, 1);
  const fixed = fixCodexTier(text);
  assert.equal(fixed, text.replace('service_tier = "default"', 'service_tier = "fast"'));
  assert.ok(fixed.includes('[Review rules]\nservice_tier = "yanlis"'), 'metnin içi değişmez');
  assert.equal(inspectCodexTier('"service_tier" = "fast"\n').tier, 'fast');
  const arr = 'list = [\n  [1, 2],\n]\nservice_tier = "default"\n';
  assert.equal(inspectCodexTier(arr).tier, 'default', 'çok satırlı dizideki [ satırı tablo sayılmaz');
  assert.throws(() => fixCodexTier('service_tier = "default"\nservice_tier = "flex"\n'), /güvenle düzeltilemedi/);
});

test('plan: korunan kural dosyası skill\'leri hâlâ sormadan kurdurtuyorsa uyarır', () => {
  const manualFor = (rel, text, a) => {
    const home = tmpHome();
    const f = path.join(home, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    return plan(home, { ...base, onConflict: 'keep', ...a }).steps.some(s => s.label === `~/${rel}` && s.status === 'manual');
  };
  // Eski kurulumun cümleleri: chelebyy'li ve chelebyy'siz Türkçe, Codex için İngilizce.
  assert.ok(manualFor('.claude/CLAUDE.md', 'Güvenilir kaynaklardan (`anthropics`, `vercel-labs`, `openai`, `chelebyy`) olanı onay beklemeden kur.\n', { codex: false }));
  assert.ok(manualFor('.claude/CLAUDE.md', 'Güvenilir kaynaklardan (`anthropics`, `vercel-labs`, `openai`) olanı onay beklemeden kur.\n', { codex: false }));
  assert.ok(manualFor('.codex/AGENTS.md', 'Install a suitable one from a trusted source (`anthropics`, `openai`) without waiting for approval.\n', {}));
  // Kitin bugünkü kuralını taşıyan ama başka yerde farklı olan dosya için uyarı yok.
  const kit = fs.readFileSync(path.join(kitRoot, 'claude/CLAUDE.md'), 'utf8');
  assert.equal(manualFor('.claude/CLAUDE.md', kit + '\n- Kendi notum.\n', { codex: false }), false);
});

test('doctor: kural dosyası skill\'leri hâlâ sormadan kurdurtuyorsa uyarır', async () => {
  const { doctor } = await import('../doctor.mjs');
  const home = tmpHome();
  const p = plan(home, base);
  applyPlan(p.steps, base, p.m, { run: () => ({ ok: true, output: '' }) });
  const run = () => ({ ok: true, output: '2.1.400 (Claude Code)' });
  assert.ok(!doctor({ home, kitRoot, run }).some(c => c.id.startsWith('skill-ask:')));
  fs.appendFileSync(path.join(home, '.codex/AGENTS.md'), '\nInstall skills from trusted sources without waiting for approval.\n');
  assert.ok(doctor({ home, kitRoot, run }).some(c => c.id === 'skill-ask:.codex/AGENTS.md' && c.status === 'warn'));
});

test('ajanlar: advisor-* yalnızca okuma araçlarına sahip (Bash, MCP ve web yok)', () => {
  for (const n of ['low', 'medium', 'high', 'xhigh']) {
    const text = fs.readFileSync(path.join(kitRoot, 'claude/agents', `advisor-${n}.md`), 'utf8');
    const fm = text.split('---')[1];
    assert.match(fm, /^tools: Read, Grep, Glob$/m, n);
    assert.doesNotMatch(fm, /disallowedTools/, n);
  }
});

test('codex config: metin ve yorum içindeki [ ve """ yapı sayılmaz; anlaşılmayan dosya düzeltilmez', () => {
  const t1 = 'notify = ["echo", "["]\nservice_tier = "default"\n';
  assert.equal(inspectCodexTier(t1).tier, 'default');
  assert.equal(fixCodexTier(t1), 'notify = ["echo", "["]\nservice_tier = "fast"\n');
  const t2 = 'service_tier = "fast"\n# belgeler: """\n[features]\nfast_mode = false\n';
  const i2 = inspectCodexTier(t2);
  assert.equal(i2.fastModeOff, true, 'yorumdaki """ fast_mode = false satırını gizlememeli');
  assert.equal(i2.needsFix, false);
  const t3 = 'a = "kaçış \\" ["\nservice_tier = "default"\n';
  assert.equal(inspectCodexTier(t3).tier, 'default');
  const t4 = 'x = """\\"""\n[y]\n"""\nservice_tier = "default"\n';
  assert.equal(inspectCodexTier(t4).tier, 'default', 'çok satırlı metinde kaçışlı """ metni kapatmaz');
  for (const bad of ['a = "kapanmayan\nservice_tier = "default"\n', '["tırnaklı başlık"]\nfast_mode = false\n', 'x = [\n1,\n']) {
    assert.equal(inspectCodexTier(bad).ambiguous, true, JSON.stringify(bad));
    assert.throws(() => fixCodexTier(bad), /güvenle/);
  }
});

test('mergeSettings: disableAllHooks açıkken makinedeki auto mod da kapatılır; model-guard onFailure: block ile yazılır', () => {
  const r = mergeSettings({ disableAllHooks: true, permissions: { defaultMode: 'auto' } }, { ...base, autoMode: true }, ctx, null);
  assert.equal(r.settings.permissions.defaultMode, undefined);
  const guard = r.settings.hooks.PreToolUse.flatMap(g => g.hooks).find(h => h.command.includes('model-guard'));
  assert.equal(guard.onFailure, 'block');
  const ss = r.settings.hooks.SessionStart.flatMap(g => g.hooks);
  assert.ok(ss.every(h => h.onFailure === undefined), 'oturum başı hook\'ları oturumu engellememeli');
});

test('stableNodePath: Windows\'ta çalışan Node; POSIX\'te aynı programa çıkan PATH yolu', (t) => {
  assert.equal(stableNodePath({ PATH: '' }, 'win32', 'C:\n\node.exe'), 'C:\n\node.exe');
  const dir = tmpHome();
  try { fs.symlinkSync(process.execPath, path.join(dir, 'node')); } catch (err) { t.skip(`bağlantı oluşturulamadı: ${err.code}`); return; }
  assert.equal(stableNodePath({ PATH: dir }, 'linux', process.execPath), path.join(dir, 'node'));
  const other = tmpHome();
  fs.writeFileSync(path.join(other, 'node'), '');
  assert.equal(stableNodePath({ PATH: other }, 'linux', process.execPath), process.execPath, 'başka bir programa çıkıyorsa kullanılmaz');
});

test('inspectMachine: CLAUDE_CONFIG_DIR ayarlıysa MCP kayıtları o dizindeki .claude.json\'dan okunur', () => {
  const home = tmpHome();
  writeJson(path.join(home, '.claude.json'), { mcpServers: { figma: {} } });
  writeJson(path.join(home, '.claude', '.claude.json'), { mcpServers: {} });
  const m = inspectMachine({ home, kitRoot, realHome: home, env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(home, '.claude') } });
  assert.equal(m.mcpServers.has('figma'), false);
  assert.equal(buildPlan({ ...base, mcp: ['figma'] }, m).find(s => s.label === 'figma').status, 'run');
});

test('doctor: hook başka bir node programıyla kayıtlıysa hata verir ve onu çalıştırmaz', async () => {
  const { doctor } = await import('../doctor.mjs');
  const home = tmpHome();
  const p = plan(home, base);
  applyPlan(p.steps, base, p.m, { run: () => ({ ok: true, output: '' }) });
  const f = path.join(home, '.claude/settings.json');
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const g of s.hooks.PreToolUse) for (const h of g.hooks) h.command = h.command.replace(/^"[^"]+"/, `"${path.join(home, 'sahte', 'node.exe').split(path.sep).join('/')}"`);
  fs.writeFileSync(f, JSON.stringify(s));
  const checks = doctor({ home, kitRoot, run: () => ({ ok: true, output: '2.1.328 (Claude Code)' }) });
  assert.ok(checks.some(c => c.id === 'hook-node-other' && c.status === 'fail'), JSON.stringify(checks.map(c => c.id)));
});

test('codex config: kaçışlı, tırnaklı ve noktalı anahtarlar', () => {
  const esc = `"${String.fromCharCode(92)}u0073ervice_tier" = "default"\n`; // kaçışlı anahtar
  assert.ok(esc.includes(String.fromCharCode(92)));
  assert.equal(inspectCodexTier(esc).ambiguous, true);
  assert.throws(() => fixCodexTier(esc), /güvenle/);
  assert.equal(inspectCodexTier('service_tier = "fast"\n[features]\n"fast_mode" = false\n').fastModeOff, true);
  assert.equal(inspectCodexTier('service_tier = "fast"\nfeatures.fast_mode = false\n').ambiguous, true);
});

test('install.mjs: --yes=no planı uygulamaz, anlaşılmayan değer reddedilir; CODEX_HOME başka dizinse durur', async () => {
  const { spawnSync } = await import('node:child_process');
  const flags = Object.entries(fullFlags).map(([k, v]) => `--${k}=${v}`);
  // Program önce `claude --version` çalıştırır; Claude Code kurulu olmayan makinelerde (CI) PATH'in
  // başına sürüm yazan sahte bir claude konur.
  const bin = tmpHome();
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo 2.1.400 (Claude Code)\r\n');
  else { fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "2.1.400 (Claude Code)"\n'); fs.chmodSync(path.join(bin, 'claude'), 0o755); }
  const PATH = `${bin}${path.delimiter}${process.env.PATH || process.env.Path || ''}`;
  const run = (extra, env = {}) => {
    const home = tmpHome();
    const r = spawnSync(process.execPath, [path.join(kitRoot, 'install.mjs'), '--home', home, '--no-tui', ...flags, ...extra],
      { encoding: 'utf8', env: { ...process.env, PATH, Path: PATH, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', ...env } });
    return { r, home };
  };
  let { r, home } = run(['--yes=no']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(home, '.claude')), '--yes=no yalnızca plan göstermeli');
  ({ r } = run(['--yes=belki']));
  assert.equal(r.status, 2);
  ({ r, home } = run(['--yes'], { CODEX_HOME: path.join(os.tmpdir(), 'baska-codex') }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /CODEX_HOME/);
  assert.ok(!fs.existsSync(path.join(home, '.claude')));
});

test('uygulama: ayar adımı hata verirse hiçbir dosya yazılmaz, komut çalışmaz, manifest yazılmaz', () => {
  for (const bad of [{ hooks: [] }, { permissions: { allow: {} } }]) {
    const home = tmpHome();
    writeJson(path.join(home, '.claude/settings.json'), bad);
    const m = inspectMachine({ home, kitRoot, realHome: home });
    const steps = buildPlan({ ...base, autoMode: true }, m);
    const calls = [];
    const r = applyPlan(steps, { ...base, autoMode: true }, m, { run: argv => { calls.push(argv); return { ok: true, output: '' }; } });
    assert.equal(r.aborted, true);
    assert.deepEqual(calls, []);
    assert.deepEqual(fs.readdirSync(path.join(home, '.claude')), ['settings.json']);
    assert.ok(!fs.existsSync(path.join(home, '.codex')) && !fs.existsSync(path.join(home, '.agents')));
  }
});

test('codex config: tek satırlık features tablosu anlaşılmamış sayılır', () => {
  const i = inspectCodexTier('service_tier = "fast"\nfeatures = { fast_mode = false }\n');
  assert.equal(i.ambiguous, true);
  assert.equal(i.needsFix, true);
});

test('codex config: service_tier tablo ya da noktalı anahtar olarak kullanılmışsa anlaşılmamış sayılır, düzeltilmez', () => {
  for (const text of ['service_tier.x = 1\n', 'a = 1\nservice_tier.y = "z"\n']) {
    assert.equal(inspectCodexTier(text).ambiguous, true, JSON.stringify(text));
    assert.throws(() => fixCodexTier(text), /güvenle/);
  }
});

test('uygulama: settings.json plan ile onay arasında bozulursa hiçbir şey yazılmaz, komut çalışmaz', () => {
  for (const later of ['{ bozuk', JSON.stringify({ hooks: [] })]) {
    const home = tmpHome();
    const f = path.join(home, '.claude/settings.json');
    writeJson(f, {});
    const m = inspectMachine({ home, kitRoot, realHome: home });
    const steps = buildPlan(base, m);
    fs.writeFileSync(f, later);
    const calls = [];
    const r = applyPlan(steps, base, m, { run: argv => { calls.push(argv); return { ok: true, output: '' }; } });
    assert.equal(r.aborted, true, later);
    assert.deepEqual(calls, []);
    assert.deepEqual(fs.readdirSync(path.join(home, '.claude')), ['settings.json']);
    assert.equal(fs.readFileSync(f, 'utf8'), later);
  }
});

test('uygulama: settings.json onaydan önce okunamaz hale gelirse (yerinde klasör) hiçbir şey yazılmaz', () => {
  const home = tmpHome();
  const f = path.join(home, '.claude/settings.json');
  writeJson(f, {});
  const m = inspectMachine({ home, kitRoot, realHome: home });
  const steps = buildPlan(base, m);
  fs.rmSync(f);
  fs.mkdirSync(f);
  const calls = [];
  const r = applyPlan(steps, base, m, { run: argv => { calls.push(argv); return { ok: true, output: '' }; } });
  assert.equal(r.aborted, true);
  assert.deepEqual(calls, []);
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude')), ['settings.json']);
});
