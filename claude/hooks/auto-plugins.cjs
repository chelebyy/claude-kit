#!/usr/bin/env node
// SessionStart hook: projede bulunan dosyalara göre yığına özgü plugin'leri
// <proje>/.claude/settings.local.json içinde açar. Genel ayarda (~/.claude/settings.json)
// bu plugin'ler kapalı tutulur; local ayar user ayarını ezdiği için sadece o projede açılırlar.
// Değişiklik bir SONRAKİ oturumda geçerli olur (Claude Code plugin'leri başlangıçta yükler).
// Kural: local dosyada zaten yazılı olan bir anahtara (true ya da false) asla dokunmaz.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'build', 'out', 'vendor', '.next', '.venv', 'venv', '__pycache__', 'target', 'Pods']);
const MAX_DEPTH = 3;
const MAX_ENTRIES = 4000;

const DOTNET = ['dotnet', 'dotnet-ai', 'dotnet-aspnetcore', 'dotnet-blazor', 'dotnet-data', 'dotnet-diag', 'dotnet-maui',
  'dotnet-msbuild', 'dotnet-nuget', 'dotnet-template-engine', 'dotnet-test', 'dotnet-test-migration', 'dotnet-upgrade', 'dotnet11']
  .map(n => `${n}@dotnet-agent-skills`).concat('dotnet-contribution@claude-code-workflows');

const FIREBASE_SKILLS = ['firebase-ai-logic-basics', 'firebase-app-hosting-basics', 'firebase-auth-basics', 'firebase-basics', 'firebase-crashlytics',
  'firebase-data-connect', 'firebase-firestore', 'firebase-hosting-basics', 'firebase-remote-config-basics', 'firebase-security-rules-auditor'];

// Eşleme tablosu: when(p) true dönerse plugins açılır (enabledPlugins) ve skills açılır (skillOverrides: "on").
// p.file(ad)     → kök dizinde dosya/klasör var mı
// p.ext(.uzantı) → ilk 3 seviyede bu uzantıda dosya/klasör var mı
// p.dep(ad)      → package.json bağımlılıklarında var mı
// p.py(ad)       → requirements*.txt / pyproject.toml içinde geçiyor mu
// p.text(dosya, regex) → kökteki dosyanın içeriği eşleşiyor mu
const RULES = [
  { name: '.NET', when: p => p.ext('.csproj') || p.ext('.sln') || p.ext('.slnx') || p.ext('.fsproj') || p.file('global.json'), plugins: DOTNET, skills: ['dotnet-backend-patterns'] },
  { name: 'Firebase', when: p => p.file('firebase.json') || p.file('.firebaserc') || p.dep('firebase') || p.dep('firebase-admin'), plugins: ['firebase@claude-plugins-official'], skills: FIREBASE_SKILLS },
  { name: 'Supabase', when: p => p.file('supabase') || p.dep('@supabase/supabase-js') || p.dep('@supabase/ssr') || p.py('supabase'), plugins: ['supabase@claude-plugins-official', 'supabase-toolkit@claude-code-templates'], skills: ['supabase', 'supabase-postgres-best-practices'] },
  { name: 'PostgreSQL', when: p => p.dep('pg') || p.dep('postgres') || p.py('psycopg') || p.py('psycopg2') || p.py('psycopg2-binary') || p.py('asyncpg') || p.text('prisma/schema.prisma', /provider\s*=\s*"postgresql"/) || p.text('docker-compose.yml', /image:\s*\S*postgres/),
    skills: ['postgresql-code-review', 'postgresql-database-engineering', 'postgresql-optimization', 'postgresql-table-design', 'pgbouncer-architect'] },
  { name: 'Redis', when: p => p.dep('redis') || p.dep('ioredis') || p.dep('@upstash/redis') || p.py('redis') || p.text('docker-compose.yml', /image:\s*\S*redis/),
    skills: ['redis-clustering', 'redis-connections', 'redis-core', 'redis-observability', 'redis-search', 'redis-security', 'redis-semantic-cache'] },
  { name: 'Cloudflare', when: p => p.file('wrangler.toml') || p.file('wrangler.json') || p.file('wrangler.jsonc') || p.dep('wrangler') || p.dep('@opennextjs/cloudflare'),
    skills: ['cloudflare', 'cloudflare-email-service', 'cloudflare-one', 'cloudflare-one-migrations', 'durable-objects', 'workers-best-practices', 'wrangler', 'nextjs-on-cloudflare', 'agents-sdk', 'turnstile-spin'] },
  // Next.js tek başına Vercel demek değil (Cloudflare'e de deploy ediliyor); yalnızca Vercel'e özgü işaretler.
  { name: 'Vercel', when: p => p.file('vercel.json') || p.file('vercel.ts') || p.file('.vercel') || p.dep('@vercel/functions') || p.dep('@vercel/analytics') || p.dep('@vercel/speed-insights'),
    plugins: ['vercel@claude-plugins-official'], skills: ['vercel-connect'] },
  { name: 'React Native', when: p => p.dep('react-native') || p.dep('expo'), skills: ['react-native-best-practices', 'react-native-design', 'react-native-dev', 'expo-skill-eval', 'app-store-review'] },
  { name: 'Flutter', when: p => p.file('pubspec.yaml'), skills: ['flutter-dev'] },
  { name: 'Android', when: p => p.file('build.gradle') || p.file('build.gradle.kts') || p.file('settings.gradle.kts') || p.ext('.kt'), skills: ['android-cli', 'mobile-android-design', 'play-policy-insights'] },
  { name: 'iOS / Apple', when: p => p.ext('.xcodeproj') || p.ext('.xcworkspace') || p.file('Package.swift') || p.ext('.swift'), skills: ['xcode-project-setup', 'apple-design', 'app-store-review'] },
  { name: 'FastAPI', when: p => p.py('fastapi'), skills: ['fastapi-templates'] },
  { name: 'Remotion', when: p => p.dep('remotion'), skills: ['remotion'] },
  { name: 'Chrome eklentisi', when: p => p.text('manifest.json', /"manifest_version"/), skills: ['chrome-extensions'] },
  { name: 'Gemini API', when: p => p.dep('@google/genai') || p.dep('@google/generative-ai') || p.py('google-genai') || p.py('google-generativeai'), skills: ['gemini-api-dev'] },
  { name: 'MongoDB', when: p => p.dep('mongodb') || p.dep('mongoose') || p.py('pymongo') || p.py('motor'), plugins: ['mongodb@claude-plugins-official'] },
  { name: 'Laravel', when: p => p.file('artisan') && p.file('composer.json'), plugins: ['laravel-boost@claude-plugins-official'] },
  { name: 'Hugging Face', when: p => p.py('transformers') || p.py('huggingface_hub') || p.py('datasets') || p.dep('@huggingface/transformers'), plugins: ['huggingface-skills@claude-plugins-official'] },
  { name: 'ML / AI', when: p => ['torch', 'tensorflow', 'keras', 'scikit-learn', 'xgboost', 'lightgbm', 'langchain', 'llama-index', 'mlflow'].some(n => p.py(n)) || p.dep('@tensorflow/tfjs') || p.dep('langchain'), plugins: ['ai-ml-toolkit@claude-code-templates'] },
  { name: 'Airflow / dbt', when: p => p.file('dags') || p.file('dbt_project.yml') || p.file('.astro') || p.py('apache-airflow') || p.py('dbt-core') || p.py('astronomer-cosmos'), plugins: ['data-engineering@claude-plugins-official'] },
  { name: 'Atomic Agents', when: p => p.py('atomic-agents'), plugins: ['atomic-agents@claude-plugins-official'] },
  { name: 'MCP sunucusu', when: p => p.dep('@modelcontextprotocol/sdk') || p.py('mcp') || p.py('fastmcp'), plugins: ['mcp-server-dev@claude-plugins-official'] },
  { name: 'Agent SDK', when: p => p.dep('@anthropic-ai/claude-agent-sdk') || p.py('claude-agent-sdk'), plugins: ['agent-sdk-dev@claude-plugins-official'] },
  { name: 'Claude plugin', when: p => p.file('.claude-plugin'), plugins: ['plugin-dev@claude-plugins-official'] },
];

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }

function scanExtensions(root) {
  const exts = new Set();
  let seen = 0;
  (function walk(dir, depth) {
    if (depth > MAX_DEPTH || seen > MAX_ENTRIES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > MAX_ENTRIES) return;
      exts.add(path.extname(e.name).toLowerCase()); // klasörler de: Foo.xcodeproj bir klasördür
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
    }
  })(root, 0);
  return exts;
}

function buildProbe(root) {
  const pkg = readJson(path.join(root, 'package.json')) || {};
  const deps = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }));
  let pyText = readText(path.join(root, 'pyproject.toml'));
  try { for (const f of fs.readdirSync(root)) if (/^requirements.*\.txt$/i.test(f)) pyText += '\n' + readText(path.join(root, f)); } catch {}
  pyText = pyText.toLowerCase();
  let exts = null;
  return {
    file: n => fs.existsSync(path.join(root, n)),
    ext: x => (exts ||= scanExtensions(root)).has(x),
    dep: n => deps.has(n),
    py: n => new RegExp(`(^|[\\s"'\\[,])${n.replace(/[-_]/g, '[-_]')}([\\s"'<>=~!\\],;\\[]|$)`, 'm').test(pyText),
    text: (f, re) => re.test(readText(path.join(root, f))),
  };
}

// Yalnızca bu makinede kurulu olanlar açılır: her makinede farklı skill ve plugin bulunur ve kurulu
// olmayan bir anahtarı local ayara yazmak hiçbir şey açmaz, yalnızca yanıltıcı bir bildirim üretir.
// Plugin: ~/.claude/plugins/installed_plugins.json içinde kayıtlı. Skill: kullanıcı düzeyinde
// ~/.claude/skills/<ad>/SKILL.md var (proje içindeki skill'ler projeye aittir, sayılmaz).
// Plugin kapsamı: kullanıcı kapsamında kurulu olan her projede, proje/yerel kapsamda kurulu olan
// yalnızca kendi projesinde kullanılabilir.
function installedOnThisMachine(root) {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const reg = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'));
  const plugins = reg && typeof reg.plugins === 'object' && reg.plugins ? reg.plugins : {};
  const skillsDir = path.join(claudeDir, 'skills');
  const fold = s => (process.platform === 'win32' ? s.toLowerCase() : s);
  const same = p => {
    if (typeof p !== 'string' || !p) return false;
    try { return fold(path.resolve(p)) === fold(root); } catch { return false; }
  };
  return {
    plugin: k => Object.prototype.hasOwnProperty.call(plugins, k) && Array.isArray(plugins[k])
      && plugins[k].some(e => e && (e.scope === 'user' || ((e.scope === 'project' || e.scope === 'local') && same(e.projectPath)))),
    skill: n => /^[a-z0-9][a-z0-9._-]*$/i.test(n) && fs.existsSync(path.join(skillsDir, n, 'SKILL.md')),
  };
}

function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
  const root = path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  // Ev dizininde veya sürücü kökünde çalışma: orası proje değil.
  if (root === path.resolve(os.homedir()) || root === path.parse(root).root) return;

  const probe = buildProbe(root);
  const installed = installedOnThisMachine(root);
  const wantedPlugins = new Map();
  const wantedSkills = new Map();
  for (const r of RULES) {
    let hit = false;
    try { hit = r.when(probe); } catch {}
    if (!hit) continue;
    for (const k of r.plugins || []) if (installed.plugin(k)) wantedPlugins.set(k, r.name);
    for (const k of r.skills || []) if (installed.skill(k)) wantedSkills.set(k, r.name);
  }
  if (!wantedPlugins.size && !wantedSkills.size) return;

  // Güvenlik: proje içeriği güvenilmezdir. `.claude` klasörü ya da hedef dosya sembolik bağlantıysa
  // (örn. ~/.bashrc'ye işaret ediyorsa) hiçbir şey yazma; yazma yalnızca projenin içinde kalmalı.
  const dir = path.join(root, '.claude');
  const localFile = path.join(dir, 'settings.local.json');
  const lst = f => { try { return fs.lstatSync(f); } catch { return null; } };
  const dirStat = lst(dir);
  if (dirStat && (dirStat.isSymbolicLink() || !dirStat.isDirectory())) return;
  if (dirStat && !fs.realpathSync(dir).startsWith(fs.realpathSync(root) + path.sep)) return;
  const fileStat = lst(localFile);
  if (fileStat && (fileStat.isSymbolicLink() || !fileStat.isFile())) return;
  const local = fileStat ? readJson(localFile) : {};
  if (local === null) return; // bozuk JSON: üzerine yazma, kullanıcıya bırak
  const added = [];
  // Elle verilmiş karar (local dosyada zaten olan anahtar) her zaman kazanır.
  const merge = (section, wanted, value) => {
    for (const [k, ruleName] of wanted) {
      local[section] ||= {};
      if (k in local[section]) continue;
      local[section][k] = value;
      added.push(ruleName);
    }
  };
  merge('enabledPlugins', wantedPlugins, true);
  merge('skillOverrides', wantedSkills, 'on');
  if (!added.length) return;

  if (!dirStat) fs.mkdirSync(dir);
  // Tahmin edilemeyen ad + 'wx' (yalnızca yoksa oluştur): önceden konmuş bir bağlantı izlenmez, açma başarısız olur.
  const tmp = path.join(dir, `.settings.local.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(local, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, localFile); // rename bağlantıyı izlemez; hedefin yerine geçer
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
  const groups = [...new Set(added)].join(', ');
  process.stdout.write(JSON.stringify({
    systemMessage: `auto-plugins: bu proje için açıldı → ${groups}. Yüklenmeleri için Claude Code'u yeniden başlatın.`,
  }));
}

if (require.main === module) {
  try { main(); } catch { /* hook asla oturumu bozmamalı */ }
} else {
  module.exports = { RULES }; // kuralları denetim/test betiklerinden okumak için
}
