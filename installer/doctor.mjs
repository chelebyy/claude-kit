// doctor: kurulumu değiştirmeden denetler. Her kontrol { id, status: ok|warn|fail|info, msg }.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { HOOKS, PLUGINS, SKILLS, MCP, MIN_NODE, MIN_CLAUDE, PROFILE_PATH, compareVersions, normalizeText, findHook, marketplaceMatches, LEGACY_SKILL_ALLOWS } from './core.mjs';
import { inspectMachine, desiredFiles, readText, claudeVersion, runCommand, rulesInstallSkillsUnasked } from './system.mjs';

function runHook(file, input, env = {}, nodeExe = process.execPath) {
  const r = spawnSync(nodeExe, [file], { input: JSON.stringify(input), encoding: 'utf8', timeout: 20000, env: { ...process.env, ...env } });
  return { code: r.status, out: (r.stdout || '').trim(), err: r.error };
}

export function doctor({ home, kitRoot, run = runCommand, env = process.env }) {
  const checks = [];
  const add = (id, status, msg) => checks.push({ id, status, msg });
  const m = inspectMachine({ home, kitRoot, env });
  const a = (m.manifest && m.manifest.answers) || null;
  let guardNode = null;

  const nodeMajor = parseInt(process.versions.node, 10);
  add('node', nodeMajor >= MIN_NODE ? 'ok' : 'fail', `Node ${process.versions.node} (en az ${MIN_NODE})`);
  const cv = claudeVersion(run, home);
  if (!cv) add('claude', 'fail', 'claude komutu bulunamadı ya da sürümü okunamadı');
  else add('claude', compareVersions(cv, MIN_CLAUDE) >= 0 ? 'ok' : 'fail', `Claude Code ${cv} (en az ${MIN_CLAUDE})`);
  if (env.CLAUDE_CONFIG_DIR) add('config-dir', 'warn', `CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR} ayarlı; kit ~/.claude'a kurar`);
  if (env.CODEX_HOME) add('codex-home', 'warn', `CODEX_HOME=${env.CODEX_HOME} ayarlı; kit ~/.codex'e kurar`);

  if (!a) {
    add('manifest', 'fail', 'kurulum kaydı yok (~/.claude/claude-kit.json); önce `node install.mjs` çalıştır');
    return checks;
  }
  add('profile', fs.existsSync(path.join(home, PROFILE_PATH)) ? 'ok' : 'fail', `profil: Codex ${a.codex ? 'var' : 'yok'}, Daybreak ${a.codex && a.daybreak ? 'var' : 'yok'}`);
  if (a.codex && !m.codexOnPath) add('codex-cli', 'fail', 'profilde Codex var ama codex komutu PATH\'te yok');
  if (!a.codex && m.codexOnPath) add('codex-cli', 'info', 'codex komutu kurulu ama profilde Codex yok; Codex incelemeleri için kurulumu yeniden çalıştır');

  let same = 0; const diff = []; const missing = [];
  for (const f of desiredFiles(a, m)) {
    const cur = readText(f.dest);
    if (cur == null) missing.push(f.rel);
    else if (normalizeText(cur) === f.content) same++;
    else diff.push(f.rel);
  }
  add('files', missing.length ? 'fail' : diff.length ? 'warn' : 'ok',
    `kit dosyaları: ${same} güncel${diff.length ? `, ${diff.length} farklı (${diff.join(', ')})` : ''}${missing.length ? `, ${missing.length} eksik (${missing.join(', ')})` : ''}`);

  if (m.settings === undefined) add('settings', 'fail', 'settings.json geçerli JSON değil');
  else {
    const s = m.settings || {};
    const hooks = s.hooks || {};
    // Hook, kurulumun seçeceği Node ile (m.nodePath) kayıtlı olmalı; başka bir "node" programıyla
    // kayıtlıysa doctor onu çalıştırmaz ve hata verir (o program model-guard'ı atlatabilir).
    const lost = []; const otherNode = []; const staleNode = [];
    for (const h of HOOKS) {
      const exact = findHook(hooks[h.event], h, { home, platform: m.platform }, { nodePath: m.nodePath });
      if (exact) {
        if (!fs.existsSync(exact)) staleNode.push(`${h.script} → ${exact}`);
        else if (h.script === 'model-guard.cjs') guardNode = exact;
        continue;
      }
      const loose = findHook(hooks[h.event], h, { home, platform: m.platform });
      if (loose) otherNode.push(`${h.script} → ${loose}`);
      else lost.push(`${h.script} (${h.event}, matcher ${h.matcher})`);
    }
    add('hooks', lost.length ? 'fail' : 'ok', lost.length ? `settings.json'da beklenen biçimde kayıtlı olmayan hook: ${lost.join(', ')}` : '3 hook kayıtlı');
    if (otherNode.length) add('hook-node-other', 'fail', `hook başka bir Node programıyla kayıtlı (beklenen ${m.nodePath}): ${otherNode.join(', ')}; kurulumu yeniden çalıştır`);
    if (staleNode.length) add('hook-node', 'fail', `hook'ların çağırdığı Node artık yok (Node taşınmış ya da güncellenmiş): ${staleNode.join(', ')}; kurulumu yeniden çalıştır`);
    if (s.disableAllHooks === true) add('hooks-disabled', 'fail', 'disableAllHooks = true: model-guard dahil hiçbir hook çalışmıyor');
    const allow = Array.isArray(s.permissions && s.permissions.allow) ? s.permissions.allow : [];
    const legacy = allow.filter(x => LEGACY_SKILL_ALLOWS.includes(x));
    if (legacy.length) add('skill-allow', 'warn', `onaysız skill kurulumu izinleri duruyor (${legacy.join(', ')}); projedeki sahte bir npx/skills programı onaysız çalışabilir, kurulumu yeniden çalıştır`);
  }
  for (const rel of ['.claude/CLAUDE.md', ...(a.codex ? ['.codex/AGENTS.md'] : [])]) {
    if (rulesInstallSkillsUnasked(readText(path.join(home, rel)))) add(`skill-ask:${rel}`, 'warn', `~/${rel} skill'leri hâlâ kullanıcıya sormadan kurdurtuyor; o cümleyi değiştir ya da kurulumu --on-conflict=replace ile yeniden çalıştır`);
  }

  for (const p of PLUGINS) {
    const mk = p.marketplace;
    if (!mk || (p.when && !a[p.when]) || !m.marketplaces.has(mk.name)) continue;
    if (!marketplaceMatches(m.marketplaces.get(mk.name), mk.source)) add(`market:${mk.name}`, 'fail', `market ${mk.name} beklenen kaynağa (github.com/${mk.source}) değil başka bir yere kayıtlı`);
  }

  // Hook'lar yalnızca gerçek ev dizininde çalıştırılır: --home ile verilen klasördeki dosyalar
  // güvenilmez olabilir ve doctor onları kendi süreci içinde çalıştırırdı.
  const hooksDir = path.join(home, '.claude', 'hooks');
  const guard = path.join(hooksDir, 'model-guard.cjs');
  if (!m.commandsAllowed) add('hooks-run', 'info', 'ev dizini gerçek değil (--home): hook\'lar çalıştırılarak denenmedi');
  if (m.commandsAllowed && fs.existsSync(guard) && guardNode) {
    // Kayıtlı komutla aynı Node ve aynı betik; çıktı JSON olarak denetlenir.
    const deny = runHook(guard, { tool_name: 'Bash', tool_input: { command: 'codex exec -m gpt-0-unknown -' } }, {}, guardNode);
    let denied = false;
    try { const j = JSON.parse(deny.out); denied = j && j.hookSpecificOutput && j.hookSpecificOutput.permissionDecision === 'deny'; } catch {}
    add('model-guard', denied ? 'ok' : 'fail', denied ? 'model-guard onaysız modeli engelliyor' : 'model-guard onaysız model çağrısını engellemedi');
  }
  const watch = path.join(hooksDir, 'model-watch.cjs');
  if (m.commandsAllowed && fs.existsSync(watch)) {
    const w = runHook(watch, {});
    let okJson = w.code === 0;
    if (okJson && w.out) { try { const j = JSON.parse(w.out); if (j.systemMessage) add('model-watch-msg', 'info', j.systemMessage.replace(/\s*\n\s*/g, '; ').slice(0, 400)); } catch { okJson = false; } }
    add('model-watch', okJson ? 'ok' : 'fail', okJson ? 'model-watch hook\'u çalışıyor' : 'model-watch hook\'u geçerli çıktı vermedi');
  }
  const auto = path.join(hooksDir, 'auto-plugins.cjs');
  if (m.commandsAllowed && fs.existsSync(auto)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-kit-doctor-'));
    try {
      fs.writeFileSync(path.join(tmp, 'firebase.json'), '{}');
      const r = runHook(auto, {}, { CLAUDE_PROJECT_DIR: tmp });
      add('auto-plugins', r.code === 0 ? 'ok' : 'fail', r.code === 0 ? 'auto-plugins hook\'u çalışıyor' : 'auto-plugins hook\'u hata ile çıktı');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    // Projeye göre açılabilecek ama bu makinede kurulu olmayanlar: yalnızca bilgi.
    try {
      const { RULES } = createRequire(import.meta.url)(auto);
      const absentP = new Set(); const absentS = new Set();
      for (const r of RULES) {
        for (const p of r.plugins || []) if (!m.plugins.has(p)) absentP.add(p);
        for (const s of r.skills || []) if (!fs.existsSync(path.join(home, '.claude', 'skills', s, 'SKILL.md'))) absentS.add(s);
      }
      if (absentP.size || absentS.size) add('auto-plugins-absent', 'info', `projeye göre açılabilecek ama kurulu olmayan: ${absentP.size} plugin, ${absentS.size} skill (sorun değil; kurarsan ilgili projede kendiliğinden açılır)`);
    } catch {}
  }

  for (const p of PLUGINS) {
    if (p.when && !a[p.when]) continue;
    add(`plugin:${p.id}`, m.plugins.has(p.id) ? 'ok' : 'fail', `${p.id} ${m.plugins.has(p.id) ? 'kurulu' : 'kurulu değil'}`);
  }
  for (const s of SKILLS) {
    const ok = fs.existsSync(path.join(home, '.claude', 'skills', s.name, 'SKILL.md'));
    add(`skill:${s.name}`, ok ? 'ok' : 'fail', `${s.name} ${ok ? 'kurulu' : 'kurulu değil'}`);
  }
  for (const name of a.mcp || []) {
    if (!MCP[name]) continue;
    add(`mcp:${name}`, m.mcpServers.has(name) ? 'ok' : 'warn', `MCP ${name} ${m.mcpServers.has(name) ? 'ekli' : 'ekli değil'}`);
  }
  if (a.codex) {
    const t = m.codexTier;
    if (t.ambiguous) add('codex-config', 'warn', '~/.codex/config.toml güvenle okunamadı; service_tier ve fast_mode ayarlarını kendin kontrol et');
    else add('codex-tier', t.needsFix ? 'warn' : 'ok', `~/.codex/config.toml service_tier = ${t.tier ?? 'yok'}${t.needsFix ? ' (fast olmalı)' : ''}`);
    if (t.fastModeOff) add('codex-fast-mode', 'warn', '[features] fast_mode = false: katman ayarları yok sayılır');
  }
  return checks;
}

export function formatChecks(checks) {
  const icon = { ok: '✓', warn: '!', fail: '✗', info: 'i' };
  const lines = checks.map(c => `  ${icon[c.status] || '?'} ${c.msg}`);
  const fails = checks.filter(c => c.status === 'fail').length;
  const warns = checks.filter(c => c.status === 'warn').length;
  lines.push('', fails ? `${fails} hata, ${warns} uyarı.` : warns ? `Hata yok, ${warns} uyarı.` : 'Her şey yolunda.');
  return lines.join('\n');
}
