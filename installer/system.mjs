// Dosya sistemi ve süreç işleri: planı makineye bakarak çıkarır ve onaylanınca uygular.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  FILES, PLUGINS, SKILLS, MCP, SKILLS_CLI, PROFILE_PATH, MANIFEST_PATH,
  renderProfile, mergeSettings, inspectCodexTier, fixCodexTier, normalizeText,
  marketplaceMatches, installedForUser,
} from './core.mjs';

export const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
export const readJson = f => { const t = readText(f); if (t == null) return null; try { return JSON.parse(t); } catch { return undefined; } };
// settings.json için sıkı okuma: yalnızca "dosya yok" (ENOENT) null sayılır; okunamayan dosya ya da
// dosyanın yerindeki bir klasör hata verir, böylece kurulum yazmaya başlamadan durur.
export function readSettingsStrict(f) {
  try { return fs.readFileSync(f, 'utf8'); } catch (err) { if (err && err.code === 'ENOENT') return null; throw err; }
}
export const sha256 = t => crypto.createHash('sha256').update(t).digest('hex');

export function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function listFiles(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '__pycache__' || e.name.startsWith('.bak') || /\.bak-\d/.test(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  })(dir, '');
  return out.sort();
}

// PATH'te bir programı bulur. Windows'ta PATHEXT uzantılarını dener. Geçerli klasöre bakmaz.
export function resolveExe(name, env = process.env, platform = process.platform) {
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map(x => x.toLowerCase()) : [''];
  for (const d of dirs) {
    if (!path.isAbsolute(d)) continue;
    for (const x of exts) {
      const f = path.join(d, name + x);
      try { if (fs.statSync(f).isFile()) return f; } catch {}
    }
  }
  return null;
}

// Kabuk gerektiren (.cmd/.bat) programlarda argümanlar yalnızca bu güvenli karakterlerden oluşabilir;
// argümanlar zaten katalogdaki sabitlerden gelir, bu son bir emniyettir.
const SAFE_ARG = /^[A-Za-z0-9@+=:,./_~-]+$/;
// Komutlar her zaman gerçek ev dizininde çalışır, --home ile verilen klasörde değil: cmd.exe ve npm
// kısayolları yalın adları (ör. node) önce geçerli klasörde arar; o klasör güvenilmez olabilir.
const SAFE_CWD = () => os.homedir();

export function runCommand(argv, { timeoutMs = 600000, env = process.env, platform = process.platform } = {}) {
  const [name, ...args] = argv;
  const exe = resolveExe(name, env, platform);
  if (!exe) return { ok: false, code: null, output: `${name} bulunamadı (PATH)` };
  const needsShell = platform === 'win32' && /\.(cmd|bat)$/i.test(exe);
  let r;
  if (needsShell) {
    const bad = args.find(x => !SAFE_ARG.test(x));
    if (bad) return { ok: false, code: null, output: `güvensiz argüman reddedildi: ${bad}` };
    r = spawnSync(`"${exe}" ${args.join(' ')}`, { shell: true, cwd: SAFE_CWD(), encoding: 'utf8', timeout: timeoutMs, env });
  } else {
    r = spawnSync(exe, args, { cwd: SAFE_CWD(), encoding: 'utf8', timeout: timeoutMs, env });
  }
  const output = `${r.stdout || ''}${r.stderr || ''}${r.error ? String(r.error.message) : ''}`;
  return { ok: r.status === 0 && !r.error, code: r.status, output };
}

export function claudeVersion(run = runCommand) {
  const r = run(['claude', '--version'], { timeoutMs: 30000 });
  const m = r.ok && /(\d+\.\d+\.\d+)/.exec(r.output);
  return m ? m[1] : null;
}

// Hook'ların çağıracağı Node. Windows'ta bu programı çalıştıran Node'un kendisi. Linux ve macOS'ta
// PATH'teki `node` aynı programa çıkıyorsa onun yolu (ör. /opt/homebrew/bin/node): sürümlü klasör
// (Cellar/<sürüm>) güncellemede silinir, PATH'teki bağlantı kalır. Yol hep mutlaktır.
export function stableNodePath(env = process.env, platform = process.platform, execPath = process.execPath) {
  if (platform === 'win32') return execPath;
  const onPath = resolveExe('node', env, platform);
  try {
    if (onPath && fs.realpathSync(onPath) === fs.realpathSync(execPath)) return onPath;
  } catch {}
  return execPath;
}

// Plan ve doctor'ın ortak bakışı: makinede ne var.
export function inspectMachine({ home, kitRoot, platform = process.platform, env = process.env, realHome = os.homedir() }) {
  const claudeDir = path.join(home, '.claude');
  const settingsFile = path.join(claudeDir, 'settings.json');
  const settings = readJson(settingsFile);
  const codexCfgFile = path.join(home, '.codex', 'config.toml');
  const codexCfg = readText(codexCfgFile);
  const installed = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'));
  const markets = readJson(path.join(claudeDir, 'plugins', 'known_marketplaces.json'));
  // Kullanıcı kapsamındaki MCP kayıtları: CLAUDE_CONFIG_DIR ayarlıysa (kurulum yalnızca ~/.claude'u
  // gösterdiğinde çalışır) o dizindeki .claude.json, değilse ev dizinindeki.
  const cfgDir = env.CLAUDE_CONFIG_DIR;
  const claudeJson = readJson(cfgDir ? path.join(cfgDir, '.claude.json') : path.join(home, '.claude.json'));
  const manifest = readJson(path.join(home, MANIFEST_PATH));
  const m = {
    home, kitRoot, platform, claudeDir, settingsFile, settings, codexCfgFile,
    nodePath: stableNodePath(env, platform),
    codexOnPath: !!resolveExe('codex', env, platform),
    codexTier: inspectCodexTier(codexCfg),
    hasAutoEnv: !!(settings && settings.autoMode && Array.isArray(settings.autoMode.environment)),
    // Yalnızca kullanıcı kapsamında kurulu plugin'ler sayılır: başka bir projeye kurulmuş olan her yerde çalışmaz.
    plugins: new Set(Object.entries((installed && installed.plugins) || {}).filter(([, v]) => installedForUser(v)).map(([k]) => k)),
    marketplaces: new Map(Object.entries((markets && typeof markets === 'object' && markets) || {})),
    mcpServers: new Set(Object.keys((claudeJson && claudeJson.mcpServers) || {})),
    manifest: manifest || null,
    // claude, npx ve npm her zaman gerçek kullanıcı ayarlarına kurar. Ev dizini başka bir klasörse
    // (deneme ya da test) komutlar çalıştırılmaz, yalnızca dosyalar o klasöre yazılır.
    commandsAllowed: path.resolve(home) === path.resolve(realHome),
  };
  m.rulesConflict = a => FILES.filter(f => f.kind === 'rules' && (!f.when || a[f.when])).some(f => {
    const cur = readText(path.join(home, f.dest));
    if (cur == null) return false;
    const want = readText(path.join(kitRoot, f.src));
    return normalizeText(cur) !== normalizeText(want);
  });
  return m;
}

// Kural metni (eski kurulumdan kalan) bir skill'i kullanıcıya sormadan kurdurtuyor mu? Kit artık her
// kurulumda sordurur; eski cümle "güvenilir kaynaktan onay beklemeden kur" idi.
export function rulesInstallSkillsUnasked(text) {
  if (text == null) return false;
  return text.split(/\r?\n/).some(l => /onay beklemeden kur|without waiting for approval/i.test(l));
}

// Kurulacak dosyaların listesi: [{ dest (mutlak), rel (ev dizinine göre), content, kind }]
export function desiredFiles(a, m) {
  const out = [];
  for (const f of FILES) {
    if (f.when && !a[f.when]) continue;
    const src = path.join(m.kitRoot, f.src);
    const items = f.dir ? listFiles(src).map(r => [path.join(src, r), `${f.dest}/${r}`]) : [[src, f.dest]];
    for (const [s, rel] of items) {
      let content = fs.readFileSync(s, 'utf8');
      out.push({ dest: path.join(m.home, rel), rel, content: normalizeText(content), kind: f.kind || 'kit' });
    }
  }
  out.push({ dest: path.join(m.home, PROFILE_PATH), rel: PROFILE_PATH, content: renderProfile(a), kind: 'profile' });
  return out;
}

function mcpCommand(name, def) {
  return ['claude', 'mcp', 'add', '-s', 'user', '--transport', 'http', name, def.http];
}

// Planı çıkarır. Her adım: { group, label, status, run?, manual? }
// status: create | update | same | keep | run | skip | manual | error
export function buildPlan(a, m) {
  const steps = [];
  const files = desiredFiles(a, m);
  for (const f of files) {
    const cur = readText(f.dest);
    let status;
    if (cur == null) status = 'create';
    else if (normalizeText(cur) === f.content) status = 'same';
    else if (f.kind === 'rules' && a.onConflict !== 'replace') status = 'keep';
    else status = 'update';
    steps.push({ group: 'dosya', label: `~/${f.rel}`, status, file: f });
    // Korunan eski kural dosyası skill'leri hâlâ sormadan kurdurtuyorsa kitin "her kurulumda sor"
    // kuralı o dosyada geçersiz kalır (Codex için onaysız kuruluma izin veren tek şey bu metin).
    if (status === 'keep' && rulesInstallSkillsUnasked(cur)) {
      steps.push({ group: 'dosya', label: `~/${f.rel}`, status: 'manual',
        manual: 'korunan dosya skill\'leri hâlâ kullanıcıya sormadan kurdurtuyor; o cümleyi değiştir ya da kurulumu --on-conflict=replace ile çalıştır' });
    }
  }

  if (m.settings === undefined) {
    steps.push({ group: 'ayar', label: '~/.claude/settings.json', status: 'error', detail: 'geçerli JSON değil; düzeltilene kadar dokunulmaz' });
  } else {
    let merged = null;
    try { merged = mergeSettings(m.settings, a, { home: m.home, platform: m.platform, nodePath: m.nodePath }, m.manifest); } catch (err) {
      steps.push({ group: 'ayar', label: '~/.claude/settings.json', status: 'error', detail: String(err.message || err) });
    }
    if (merged) {
      const { settings, notes, added } = merged;
      steps.push({ group: 'ayar', label: '~/.claude/settings.json', status: notes.length ? (m.settings ? 'update' : 'create') : 'same', notes, settings, added });
    }
  }

  if (a.codex) {
    const t = m.codexTier;
    if (t.ambiguous) {
      steps.push({ group: 'codex', label: '~/.codex/config.toml', status: 'manual',
        manual: 'dosya güvenle okunamadı (karmaşık TOML); en üst düzeyde service_tier = "fast" olduğunu ve [features] altında fast_mode = false olmadığını kendin kontrol et' });
    } else if (t.needsFix) {
      steps.push({ group: 'codex', label: `~/.codex/config.toml service_tier (şu an: ${t.exists ? (t.tier ?? 'yok') : 'dosya yok'})`,
        status: a.fixCodexTier ? 'update' : 'skip', detail: a.fixCodexTier ? 'service_tier = "fast"' : 'düzeltilmedi; Sol ve Terra fast katmanda çalışmaz' });
    } else steps.push({ group: 'codex', label: `~/.codex/config.toml service_tier = ${t.tier}`, status: 'same' });
    if (t.fastModeOff) steps.push({ group: 'codex', label: '[features] fast_mode = false', status: 'manual', manual: '~/.codex/config.toml içinde [features] altındaki fast_mode = false satırını kaldır; katman ayarları bu özelliğe bağlı.' });
    if (!m.codexOnPath) {
      steps.push(a.installCodexCli
        ? { group: 'codex', label: 'Codex CLI', status: 'run', argv: ['npm', 'i', '-g', '@openai/codex'] }
        : { group: 'codex', label: 'Codex CLI', status: 'manual', manual: 'npm i -g @openai/codex' });
    }
    steps.push({ group: 'codex', label: 'codex login', status: 'manual', manual: 'codex login (giriş yapılmadıysa), sonra Claude içinde /codex:setup; review gate\'i açma.' });
  }

  const marketSeen = new Set();
  const marketBad = new Set();
  for (const p of PLUGINS) {
    if (p.when && !a[p.when]) continue;
    const mk = p.marketplace;
    if (mk && !marketSeen.has(mk.name)) {
      marketSeen.add(mk.name);
      const entry = m.marketplaces.get(mk.name);
      if (!entry) {
        steps.push({ group: 'plugin', label: `market ${mk.name}`, status: 'run', argv: ['claude', 'plugin', 'marketplace', 'add', mk.source], marketAdd: mk.name });
      } else if (!marketplaceMatches(entry, mk.source)) {
        marketBad.add(mk.name);
        steps.push({ group: 'plugin', label: `market ${mk.name}`, status: 'error',
          detail: `bu adla başka bir kaynak kayıtlı; beklenen github.com/${mk.source}. Bu marketten plugin kurulmayacak, ~/.claude/plugins/known_marketplaces.json'u kontrol et` });
      }
    }
    if (mk && marketBad.has(mk.name)) {
      steps.push({ group: 'plugin', label: p.id, status: 'error', detail: 'marketinin kaynağı beklenen değil' });
      continue;
    }
    steps.push(m.plugins.has(p.id)
      ? { group: 'plugin', label: p.id, status: 'same' }
      : { group: 'plugin', label: p.id, status: 'run', argv: ['claude', 'plugin', 'install', p.id, '-s', 'user'], marketplace: mk });
  }

  for (const s of SKILLS) {
    const present = fs.existsSync(path.join(m.home, '.claude', 'skills', s.name, 'SKILL.md'));
    const agents = a.codex ? ['-a', 'claude-code', 'codex'] : ['-a', 'claude-code'];
    steps.push(present
      ? { group: 'skill', label: s.name, status: 'same' }
      : { group: 'skill', label: s.name, status: 'run', argv: ['npx', '-y', SKILLS_CLI, 'add', s.source, '--skill', s.name, '-g', '-y', ...agents] });
  }

  for (const name of a.mcp || []) {
    const def = MCP[name];
    if (m.mcpServers.has(name)) { steps.push({ group: 'mcp', label: name, status: 'same' }); continue; }
    if (def.secret) { steps.push({ group: 'mcp', label: name, status: 'manual', manual: `${def.manual}   (<ANAHTAR> = ${def.secret}; kendi terminalinde çalıştır)` }); continue; }
    steps.push({ group: 'mcp', label: name, status: 'run', argv: mcpCommand(name, def) });
  }
  if (!m.commandsAllowed) {
    for (const st of steps) if (st.status === 'run') { st.status = 'skip'; st.detail = 'ev dizini gerçek değil (--home), komut çalıştırılmadı'; }
  }
  return steps;
}

// Var olan dosyanın izinleri korunur (ör. 0600 bir settings.json 0644 olmamalı). Yeni dosyalar
// `defaultMode` ile oluşur; ayar ve kayıt dosyaları için 0600. Geçici dosya tahmin edilemez adla ve
// yalnızca yoksa oluşturulur (wx); rename bağlantıyı izlemez.
const PRIVATE = 0o600;
function atomicWrite(file, content, defaultMode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = defaultMode;
  try { mode = fs.statSync(file).mode & 0o777; } catch {}
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx', mode: mode & PRIVATE });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

// Yedek adı çakışırsa (aynı saniyede iki kurulum) üzerine yazılmaz, sona sayı eklenir.
function backup(file, when, backups) {
  let st;
  try { st = fs.statSync(file); } catch { return; }
  for (let i = 0; i < 100; i++) {
    const b = `${file}.bak-${when}${i ? `-${i}` : ''}`;
    try {
      fs.copyFileSync(file, b, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(b, st.mode & 0o777);
      backups.push(b);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`yedek adı bulunamadı: ${file}`);
}

// Planı uygular. `run`: komut çalıştırıcı (testte sahte). Önce dosyalar yazılır; bir dosya yazılamazsa
// (ör. model-guard.cjs) ayarlar ve komutlar uygulanmaz: aksi halde auto mod eksik ya da eski bir
// güvenlik hook'uyla açılabilirdi. Dosyalardan sonraki adımlarda bir hata diğerlerini durdurmaz.
export function applyPlan(steps, a, m, { run = runCommand, log = () => {}, kitCommit = null, now = new Date() } = {}) {
  // Ayar adımı hata verdiyse (settings.json okunamadı, beklenmeyen yapı, güvensiz yol) hiçbir şey
  // uygulanmaz: güvenlik ayarları olmadan dosya yazmak ve komut çalıştırmak yarım bir kurulum bırakırdı.
  const abort = (failed, reason) => ({
    aborted: true, backups: [],
    results: steps.map(s => (s === failed ? { ...s, result: 'fail', output: reason }
      : { ...s, result: 'skip', output: 'ayar adımı hata verdiği için hiçbir şey uygulanmadı' })),
  });
  const blocker = steps.find(s => s.group === 'ayar' && s.status === 'error');
  if (blocker) return abort(blocker, blocker.detail);
  // Plan onay beklerken settings.json bozulmuş ya da yapısı değişmiş olabilir: hiçbir şey yazmadan
  // önce dosyanın şimdiki haliyle birleştirme bir kez denenir.
  const settingsStep = steps.find(s => s.group === 'ayar');
  if (settingsStep) {
    try {
      const txt = readSettingsStrict(m.settingsFile);
      mergeSettings(txt == null ? null : JSON.parse(txt), a, { home: m.home, platform: m.platform, nodePath: m.nodePath }, m.manifest);
    } catch (err) {
      return abort(settingsStep, `settings.json uygulama anında kullanılamadı: ${String(err && err.message || err)}`);
    }
  }
  const when = stamp(now);
  const backups = [];
  const results = [];
  const manifestFiles = { ...((m.manifest && m.manifest.files) || {}) };
  let added = (m.manifest && m.manifest.added) || { allow: [] };
  let fileFailed = false;
  const marketAddFailed = new Set();
  let settingsFailed = false;
  for (const st of steps) {
    if (fileFailed && st.group !== 'dosya') {
      results.push(st.status === 'manual' ? { ...st, result: 'manual' } : { ...st, result: 'fail', output: 'bir kit dosyası yazılamadığı için uygulanmadı' });
      continue;
    }
    // Ön denetimden sonra yine de ayar adımı başarısız olursa (dar bir yarış) sonraki komutlar
    // çalışmaz ve manifest yazılmaz.
    if (settingsFailed) {
      results.push(st.status === 'manual' ? { ...st, result: 'manual' } : { ...st, result: 'fail', output: 'ayar adımı başarısız olduğu için uygulanmadı' });
      continue;
    }
    try {
      if (st.group === 'dosya' && st.file && st.status !== 'keep' && st.status !== 'manual') {
        // Planda "güncel" görünen dosya da yeniden denetlenir: plan ile onay arasında silinmiş ya da
        // değiştirilmiş bir model-guard.cjs ile ayarlar uygulanmamalı. Yalnızca normal bir dosya
        // güncel sayılır; içeriği doğru olsa da bir sembolik bağlantı (hedefi sonradan değişebilir)
        // normal dosyayla değiştirilir.
        let lst = null;
        try { lst = fs.lstatSync(st.file.dest); } catch {}
        const cur = lst && lst.isFile() ? readText(st.file.dest) : null;
        if (cur != null && normalizeText(cur) === st.file.content) {
          results.push({ ...st, result: st.status === 'same' ? 'same' : 'ok' });
          continue;
        }
        // Kullanıcının kural dosyası (CLAUDE.md, AGENTS.md) plandan sonra değiştiyse ya da bir bağlantıysa,
        // açıkça "replace" seçilmedikçe korunur.
        if (lst && st.file.kind === 'rules' && a.onConflict !== 'replace') {
          results.push({ ...st, result: 'keep', detail: 'kitten farklı, korundu' });
          continue;
        }
        if (lst) backup(st.file.dest, when, backups);
        atomicWrite(st.file.dest, st.file.content);
        const after = fs.lstatSync(st.file.dest);
        if (!after.isFile() || normalizeText(readText(st.file.dest) ?? '') !== st.file.content) throw new Error('yazılan dosya doğrulanamadı');
        manifestFiles[st.file.rel] = sha256(st.file.content);
        results.push({ ...st, result: 'ok' });
      } else if (st.group === 'ayar' && st.status !== 'error') {
        // Plan sorular sırasında okundu; o arada başka bir oturumun yaptığı değişiklik kaybolmasın
        // diye birleştirme dosyanın şimdiki haline uygulanır. Yazmadan hemen önce dosya yeniden
        // okunur; değişmişse birleştirme baştan yapılır (yarış penceresi daralır, tamamen kapanmaz).
        let done = false;
        for (let attempt = 0; attempt < 5 && !done; attempt++) {
          const freshText = readSettingsStrict(m.settingsFile);
          let fresh = null;
          if (freshText != null) { try { fresh = JSON.parse(freshText); } catch { throw new Error('settings.json geçerli JSON değil; dokunulmadı'); } }
          const merged = mergeSettings(fresh, a, { home: m.home, platform: m.platform, nodePath: m.nodePath }, m.manifest);
          added = merged.added;
          if (!merged.notes.length) {
            if (readSettingsStrict(m.settingsFile) !== freshText) continue; // o arada değişti: yeniden birleştir
            results.push({ ...st, result: 'same' }); done = true; break;
          }
          const text = JSON.stringify(merged.settings, null, 2) + '\n';
          JSON.parse(text);
          if (readSettingsStrict(m.settingsFile) !== freshText) continue;
          backup(m.settingsFile, when, backups);
          if (readSettingsStrict(m.settingsFile) !== freshText) continue;
          atomicWrite(m.settingsFile, text, PRIVATE);
          results.push({ ...st, notes: merged.notes, result: 'ok' });
          done = true;
        }
        if (!done) throw new Error('settings.json yazılırken sürekli değişti; dokunulmadı, kurulumu yeniden çalıştır');
      } else if (st.status === 'run' && st.marketplace) {
        // Plugin kurulmadan hemen önce marketi yeniden doğrula: plan ile onay arasında kaynağı
        // değişmiş ya da market ekleme komutu başarısız olmuşsa plugin kurulmaz.
        if (marketAddFailed.has(st.marketplace.name)) {
          results.push({ ...st, result: 'fail', output: `market ${st.marketplace.name} eklenemedi; plugin kurulmadı` });
          continue;
        }
        const markets = readJson(path.join(m.claudeDir, 'plugins', 'known_marketplaces.json'));
        const entry = markets && typeof markets === 'object' ? markets[st.marketplace.name] : null;
        if (!marketplaceMatches(entry, st.marketplace.source)) {
          results.push({ ...st, result: 'fail', output: `market ${st.marketplace.name} beklenen kaynakla (github.com/${st.marketplace.source}) kayıtlı değil; plugin kurulmadı` });
          continue;
        }
        log(`çalışıyor: ${st.argv.join(' ')}`);
        const r = run(st.argv);
        results.push({ ...st, result: r.ok ? 'ok' : 'fail', output: r.ok ? '' : r.output.trim().split(/\r?\n/).slice(-8).join('\n') });
      } else if (st.group === 'codex' && st.status === 'update' && st.label.includes('service_tier')) {
        const cur = readText(m.codexCfgFile);
        backup(m.codexCfgFile, when, backups);
        atomicWrite(m.codexCfgFile, fixCodexTier(cur), PRIVATE);
        results.push({ ...st, result: 'ok' });
      } else if (st.status === 'run') {
        log(`çalışıyor: ${st.argv.join(' ')}`);
        const r = run(st.argv);
        // Market ekleme başarısızsa, kayıt dosyası sonradan doğru görünse bile o marketin plugin'leri kurulmaz.
        if (!r.ok && st.marketAdd) marketAddFailed.add(st.marketAdd);
        results.push({ ...st, result: r.ok ? 'ok' : 'fail', output: r.ok ? '' : r.output.trim().split(/\r?\n/).slice(-8).join('\n') });
      } else {
        results.push({ ...st, result: st.status === 'error' ? 'fail' : st.status });
      }
    } catch (err) {
      results.push({ ...st, result: 'fail', output: String(err && err.message || err) });
      if (st.group === 'dosya') fileFailed = true;
      if (st.group === 'ayar') settingsFailed = true;
    }
  }
  if (settingsFailed) return { results, backups, aborted: true };
  const manifest = {
    kit: 'claude-kit', schema: 1, kitCommit, updatedAt: now.toISOString(),
    answers: a, added, files: manifestFiles,
    backups: [...(((m.manifest && m.manifest.backups) || [])), ...backups].slice(-200),
  };
  atomicWrite(path.join(m.home, MANIFEST_PATH), JSON.stringify(manifest, null, 2) + '\n', PRIVATE);
  return { results, backups };
}

export function kitCommit(kitRoot, run = runCommand) {
  const r = run(['git', '-C', kitRoot, 'rev-parse', '--short', 'HEAD'], { timeoutMs: 15000 });
  return r.ok ? r.output.trim() : null;
}
