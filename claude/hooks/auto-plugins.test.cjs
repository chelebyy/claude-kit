'use strict';
// Çalıştırma: node --test claude/hooks/auto-plugins.test.cjs
// Hook yalnızca bu makinede kurulu olan plugin ve skill'leri açmalı.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, 'auto-plugins.cjs');
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));

function setup({ plugins = [], skills = [] }) {
  const config = tmp('ap-config-');
  fs.mkdirSync(path.join(config, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(config, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: Object.fromEntries(plugins.map(p => [p, [{ scope: 'user' }]])) }));
  for (const s of skills) {
    fs.mkdirSync(path.join(config, 'skills', s), { recursive: true });
    fs.writeFileSync(path.join(config, 'skills', s, 'SKILL.md'), '---\nname: x\n---\n');
  }
  const project = tmp('ap-project-');
  fs.writeFileSync(path.join(project, 'firebase.json'), '{}');
  return { config, project };
}

function runHook(config, project) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: '{}', encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_PROJECT_DIR: project },
  });
  assert.equal(r.status, 0, r.stderr);
  const f = path.join(project, '.claude', 'settings.local.json');
  return { out: r.stdout, local: fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null };
}

test('kurulu plugin ve skill projeye göre açılır, kurulu olmayanlar yazılmaz', () => {
  const { config, project } = setup({ plugins: ['firebase@claude-plugins-official'], skills: ['firebase-basics'] });
  const { out, local } = runHook(config, project);
  assert.deepStrictEqual(local.enabledPlugins, { 'firebase@claude-plugins-official': true });
  assert.deepStrictEqual(local.skillOverrides, { 'firebase-basics': 'on' });
  assert.match(out, /Firebase/);
});

test('hiçbiri kurulu değilse dosya oluşturulmaz ve bildirim yapılmaz', () => {
  const { config, project } = setup({});
  const { out, local } = runHook(config, project);
  assert.strictEqual(local, null);
  assert.strictEqual(out, '');
});

test('kayıt dosyası bozuksa hiçbir plugin kurulu sayılmaz', () => {
  const { config, project } = setup({});
  fs.writeFileSync(path.join(config, 'plugins', 'installed_plugins.json'), '{ bozuk');
  const { local } = runHook(config, project);
  assert.strictEqual(local, null);
});

test('yalnızca başka bir projeye kurulmuş plugin açılmaz, bu projeye kurulmuş olan açılır', () => {
  const { config, project } = setup({});
  const write = projectPath => fs.writeFileSync(path.join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'firebase@claude-plugins-official': [{ scope: 'project', projectPath }],
  } }));
  write(path.join(os.tmpdir(), 'baska-proje'));
  assert.strictEqual(runHook(config, project).local, null);
  write(project);
  assert.deepStrictEqual(runHook(config, project).local.enabledPlugins, { 'firebase@claude-plugins-official': true });
});
