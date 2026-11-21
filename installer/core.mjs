// claude-kit kurulum programının saf (yan etkisiz) parçaları: katalog, sorular, şablonlar,
// settings.json birleştirmesi ve Codex config.toml denetimi. Dosya sistemi ve süreç işleri system.mjs'te.

export const MIN_NODE = 22;
// 2.1.295: hook'larda `onFailure: "block"`. 2.1.310: Git Bash olmayan Windows'ta yalnızca tırnaklı
// dizgilerden oluşan bir PreToolUse hook komutu araç çağrısını geçiriyordu. 2.1.324: commit'e
// sabitlenmiş market kaynakları (eski kurulumun en düşük sürümü).
export const MIN_CLAUDE = '2.1.324';
export const SKILLS_CLI = 'skills@1.9.0';
export const PROFILE_PATH = '.claude/rules/claude-kit-profile.md';
export const MANIFEST_PATH = '.claude/claude-kit.json';

// Kurulan dosyalar. `rules`: kullanıcının kendi hali olabilir, fark varsa sorulur.
// Diğerleri kitin parçasıdır: fark varsa yedek alınıp güncellenir. `dir`: klasördeki her dosya.
export const FILES = [
  { src: 'claude/CLAUDE.md', dest: '.claude/CLAUDE.md', kind: 'rules' },
  { src: 'claude/rules/context7.md', dest: '.claude/rules/context7.md' },
  { src: 'claude/hooks/auto-plugins.cjs', dest: '.claude/hooks/auto-plugins.cjs' },
  { src: 'claude/hooks/model-watch.cjs', dest: '.claude/hooks/model-watch.cjs' },
  { src: 'claude/hooks/model-guard.cjs', dest: '.claude/hooks/model-guard.cjs' },
  { src: 'claude/models/registry.json', dest: '.claude/models/registry.json' },
  { src: 'claude/agents', dest: '.claude/agents', dir: true },
  { src: 'claude/skills/local-code-review', dest: '.claude/skills/local-code-review', dir: true },
  { src: 'claude/skills/local-security-review', dest: '.claude/skills/local-security-review', dir: true },
  { src: 'codex/AGENTS.md', dest: '.codex/AGENTS.md', kind: 'rules', when: 'codex' },
  { src: 'agents/skills/security-review-gate', dest: '.agents/skills/security-review-gate', dir: true, when: 'codex' },
  { src: 'agents/skills/codex-sentinel/references', dest: '.agents/skills/codex-sentinel/references', dir: true, when: 'codex' },
  { src: 'agents/skills/shared', dest: '.agents/skills/shared', dir: true, when: 'codex' },
];

export const HOOKS = [
  { event: 'SessionStart', matcher: 'startup', script: 'auto-plugins.cjs', timeout: 10 },
  { event: 'SessionStart', matcher: 'startup', script: 'model-watch.cjs', timeout: 15 },
  // onFailure: block: hook başlatılamazsa (ör. kayıtlı Node silindiyse) ya da zaman aşımına düşerse
  // araç çağrısı geçirilmez, engellenir. Oturum başı hook'larında kullanılmaz: oturumu açılmaz yapardı.
  { event: 'PreToolUse', matcher: 'Bash|PowerShell|Agent|Task', script: 'model-guard.cjs', timeout: 5, onFailure: 'block' },
];

// Her plugin'in marketi beklenen kaynakla kayıtlı olmalı: aynı adla başka bir depoya kayıtlı bir market
// varsa plugin kurulmaz (adı aynı, kodu başkasının olan bir plugin).
const OFFICIAL = { name: 'claude-plugins-official', source: 'anthropics/claude-plugins-official' };
export const PLUGINS = [
  { id: 'commit-commands@claude-plugins-official', marketplace: OFFICIAL },
  { id: 'claude-md-management@claude-plugins-official', marketplace: OFFICIAL },
  { id: 'codex@openai-codex', when: 'codex', marketplace: { name: 'openai-codex', source: 'openai/codex-plugin-cc' } },
];

export const SKILLS = [
  { name: 'find-skills', source: 'vercel-labs/skills' },
];

// İsteğe bağlı MCP sunucuları; yalnızca uzak (HTTP) sunucular. Yerel komutla başlayan (stdio) sunucu
// kurulmaz: sabitlenmemiş paket sürümleri ve Windows'ta proje klasöründen çözülen kısayollar
// (npx.cmd) kitin denetleyemeyeceği kod çalıştırırdı. `secret` olanları program kurmaz: anahtar ne
// bayrakla ne de modelin üzerinden geçmesin diye kullanıcıya kendi terminalinde çalıştıracağı komut
// gösterilir.
export const MCP = {
  context7: {
    label: 'Context7 (güncel kütüphane belgeleri, anahtar ister)', secret: 'CONTEXT7_API_KEY',
    manual: 'claude mcp add -s user --transport http context7 https://mcp.context7.com/mcp --header "CONTEXT7_API_KEY: <ANAHTAR>"',
  },
  exa: {
    label: 'Exa (web arama, anahtar ister)', secret: 'EXA_API_KEY',
    manual: 'claude mcp add -s user --transport http exa "https://mcp.exa.ai/mcp?exaApiKey=<ANAHTAR>"',
  },
  figma: { label: 'Figma', http: 'https://mcp.figma.com/mcp' },
};

const AUTO_ENV_MINE = [
  '$defaults',
  'Organization: personal developer workstation ({{OS}}). Primary use: full-stack software development with TypeScript, Python, PHP, Next.js, Laravel, Shopify, WordPress',
  'Source control: github.com personal and organization repos; gitlab.com for any flagged projects',
  'Cloud providers: Vercel (Next.js), Netlify (statik), Hetzner+Coolify (self-hosted), Supabase, Firebase, AWS S3 (build artifacts only)',
  'Trusted internal domains: localhost, 127.0.0.1. Shared hosting platforms (vercel.app, netlify.app, supabase.co, firebaseapp.com) are NOT trusted as a whole; only list exact project hostnames here.',
  'Package registries: registry.npmjs.org, pypi.org, packagist.org, rubygems.org',
  'Local dev tooling: Docker, PostgreSQL, Redis, Node.js, Python virtualenvs, Composer',
  'Additional context: solo/team work; trust but require explicit user confirmation for production deploys, force-push, infra changes, and payments/billing endpoints',
];

export const OS_NAMES = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' };

// Sorular hem menüde hem bayraklarda aynı tanımdan gelir. `ask(a, ctx)` false ise soru sorulmaz
// ve cevabı `skip` olur. `def(ctx)` varsayılan cevaptır (önceki kurulumun cevabı önceliklidir).
export const QUESTIONS = [
  { key: 'codex', flag: 'codex', type: 'bool', text: 'Codex (OpenAI) aboneliğin var mı?',
    help: 'Varsa Codex plugin\'i, Codex kuralları (AGENTS.md) ve güvenlik incelemesi skill\'i kurulur.',
    def: c => c.codexOnPath },
  { key: 'daybreak', flag: 'daybreak', type: 'bool', text: 'Codex hesabında Daybreak (cyber erişim programı daybreak_blue) var mı?',
    help: 'Yoksa güvenlik incelemesi Astra ve ek bir Claude güvenlik reviewer\'ı ile yapılır.',
    ask: a => a.codex, skip: false, def: () => false },
  { key: 'installCodexCli', flag: 'install-codex-cli', type: 'bool', text: 'Codex CLI bulunamadı. `npm i -g @openai/codex` ile kurulsun mu?',
    ask: (a, c) => a.codex && !c.codexOnPath, skip: false, def: () => true, optional: true },
  { key: 'fixCodexTier', flag: 'fix-codex-tier', type: 'bool', text: '~/.codex/config.toml içinde service_tier "fast" değil. Düzeltilsin mi (yedek alınır)?',
    ask: (a, c) => a.codex && c.codexTier.needsFix && !c.codexTier.ambiguous, skip: false, def: () => true, optional: true },
  { key: 'autoMode', flag: 'auto-mode', type: 'bool', text: 'Claude Code varsayılan olarak auto modda çalışsın mı (permissions.defaultMode = auto)?',
    help: 'Auto modda araç çağrıları sınıflandırıcı denetiminde onay sorulmadan çalışır. Hayır dersen ve makinede auto açıksa kapatılır.', def: () => true },
  { key: 'autoEnv', flag: 'auto-env', type: 'choice', choices: ['mine', 'keep'], text: 'Auto mod ortam tanımı (autoMode.environment) eklensin mi?',
    help: 'mine: kit sahibinin yığın tanımı (TypeScript, Python, PHP, Vercel, Supabase...) eklenir, yalnızca makinede tanım yoksa. keep: dokunulmaz.',
    ask: (a, c) => a.autoMode && !c.hasAutoEnv, skip: 'keep', def: () => 'mine' },
  { key: 'advisor', flag: 'advisor', type: 'bool', text: 'Yerleşik danışman Fable olsun mu (advisorModel = fable)?', def: () => true },
  { key: 'teams', flag: 'teams', type: 'bool', text: 'Takım modu (agent teams) açılsın mı?', def: () => true },
  { key: 'language', flag: 'language', type: 'text', text: 'Claude yanıt dili (ör. Turkish, English; "keep" = dokunma)', def: () => 'Turkish' },
  { key: 'uiPrefs', flag: 'ui-prefs', type: 'bool', text: 'Arayüz tercihleri uygulansın mı (tema auto, tam ekran TUI, latest güncelleme kanalı)?', def: () => true },
  { key: 'mcp', flag: 'mcp', type: 'multi', choices: Object.keys(MCP), text: 'Hangi MCP sunucuları eklensin?',
    help: 'Anahtar isteyenler (context7, exa) için çalıştıracağın komut gösterilir; anahtarı programa vermezsin.',
    def: () => ['context7', 'exa'] },
  { key: 'onConflict', flag: 'on-conflict', type: 'choice', choices: ['replace', 'keep'],
    text: 'Makinedeki CLAUDE.md / AGENTS.md kitten farklıysa: replace (yedek alıp değiştir) mi, keep (koru) mu?',
    ask: (a, c) => c.rulesConflict(a), skip: 'keep', def: () => 'replace' },
];

export function parseBool(v) {
  if (v === true || v === false) return v;
  const s = String(v).toLowerCase();
  if (['yes', 'y', 'true', 'evet', 'e', '1'].includes(s)) return true;
  if (['no', 'n', 'false', 'hayır', 'hayir', 'h', '0'].includes(s)) return false;
  return undefined;
}

export function parseAnswer(q, raw) {
  if (q.type === 'bool') return parseBool(raw);
  if (q.type === 'choice') return q.choices.includes(raw) ? raw : undefined;
  if (q.type === 'text') { const s = String(raw).trim(); return /^[A-Za-z][A-Za-z -]{0,40}$/.test(s) ? s : undefined; }
  if (q.type === 'multi') {
    const s = String(raw).trim();
    if (s === 'none' || s === '') return [];
    const list = s.split(',').map(x => x.trim()).filter(Boolean);
    return list.every(x => q.choices.includes(x)) ? [...new Set(list)] : undefined;
  }
  return undefined;
}

// --no-tui: her sorulması gereken soru bayrakla verilmeli; eksik ya da geçersiz olanlar hata listesine.
export function answersFromFlags(flags, ctx) {
  const a = {}; const errors = [];
  for (const q of QUESTIONS) {
    if (q.ask && !q.ask(a, ctx)) { a[q.key] = q.skip; continue; }
    const raw = flags[q.flag];
    if (raw === undefined) {
      if (q.optional) { a[q.key] = false; continue; }
      errors.push(`--${q.flag} gerekli${q.choices ? ` (${q.choices.join('|')}${q.type === 'multi' ? '|none, virgülle' : ''})` : q.type === 'bool' ? ' (yes|no)' : ''}`);
      continue;
    }
    const v = parseAnswer(q, raw);
    if (v === undefined) errors.push(`--${q.flag} geçersiz: ${raw}`);
    else a[q.key] = v;
  }
  return { answers: a, errors };
}

export function renderProfile(a) {
  const yn = v => (v ? 'var' : 'yok');
  return [
    '# claude-kit kurulum profili',
    '',
    'Bu dosyayı claude-kit kurulum programı (`node install.mjs`) yazar. Elle değiştirme; değiştirmek için kurulumu yeniden çalıştır.',
    'CLAUDE.md\'deki "Kurulum profili" maddesi bu dosyayı nasıl kullanacağını anlatır.',
    '',
    `- Codex: ${yn(a.codex)}`,
    `- Daybreak (cyber erişim programı \`daybreak_blue\`): ${yn(a.codex && a.daybreak)}`,
    '',
  ].join('\n');
}

const slash = p => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
// Hook komutuna yazılan yollar yalnızca bu karakterleri içerebilir: kabuk (bash, cmd, PowerShell)
// çift tırnak içinde bile $, `, %, ! gibi karakterleri genişletir. Diğer yollarda kurulum durur.
export const SAFE_PATH = /^[\p{L}\p{N} _.:\/()+@~,=-]+$/u;
export const hookScriptPath = (home, script) => `${slash(home)}/.claude/hooks/${script}`;

// Hook komutu Node'un mutlak yoluyla yazılır, yalın `node` ile değil: hook proje klasöründe çalışır ve
// Windows'ta cmd.exe yalın bir adı önce geçerli klasörde arar; projeye konmuş bir node.cmd gerçek
// Node'un yerine geçip model-guard'ı atlatabilirdi. Node başka bir yere taşınırsa (sürüm yöneticisi)
// komut çalışmaz; doctor bunu yakalar, kurulumu yeniden çalıştırmak düzeltir.
export function hookCommand(home, script, nodePath) {
  return `"${slash(nodePath)}" "${hookScriptPath(home, script)}"`;
}

// Komutu tam iki parçaya ayırır (program ve betik). Yalnızca yatay boşluk: satır sonu kabukta komutu
// ikiye böler. Başka bir şey içeren komut (`&&`, üçüncü argüman, echo) eşleşmez.
function twoTokens(cmd) {
  const m = /^[ \t]*(?:"([^"\r\n]+)"|([^\s"]+))[ \t]+(?:"([^"\r\n]+)"|([^\s"]+))[ \t]*$/.exec(String(cmd));
  return m ? [m[1] || m[2], m[3] || m[4]] : null;
}
const isNodeProgram = p => /(^|\/)node(\.exe)?$/i.test(slash(p));
const HOOK_KEYS = new Set(['type', 'command', 'timeout', 'onFailure']);

// Kitin bu betik için yazdığı (ya da eski kurulumların yazdığı) bir kayıt mı? Yalnızca bunlar
// güncellenir; kullanıcının başka hook'larına dokunulmaz.
function isKitHookCommand(cmd, h, ctx) {
  const t = twoTokens(cmd);
  if (!t || !isNodeProgram(t[0])) return false;
  const fold = s => (ctx.platform === 'win32' ? s.toLowerCase() : s);
  const s = slash(t[1]);
  return fold(s) === fold(hookScriptPath(ctx.home, h.script))
    || s === `$HOME/.claude/hooks/${h.script}` || s === `\${HOME}/.claude/hooks/${h.script}`;
}

// Kayıt gerçekten çalışan bu hook mu? Beklenen matcher, `type: command`, başka alan yok (`async`
// engelleyemez, `if`/`once` koşullu yapar), komutun tamamı `"<mutlak node>" "<bu ev dizinindeki betik>"`
// ve kitin süresinden kısa olmayan bir timeout. `nodePath` verilirse program tam olarak o olmalı.
// Dönüş: eşleşen kaydın Node programı ya da null.
export function findHook(groups, h, ctx, { nodePath } = {}) {
  const fold = s => (ctx.platform === 'win32' ? s.toLowerCase() : s);
  for (const g of Array.isArray(groups) ? groups : []) {
    if (!g || (g.matcher || '') !== h.matcher || !Array.isArray(g.hooks)) continue;
    for (const x of g.hooks) {
      if (!x || x.type !== 'command' || typeof x.command !== 'string') continue;
      if (Object.keys(x).some(k => !HOOK_KEYS.has(k))) continue;
      if ((x.onFailure ?? null) !== (h.onFailure ?? null)) continue;
      if (!(x.timeout === undefined || (typeof x.timeout === 'number' && x.timeout >= h.timeout))) continue;
      const t = twoTokens(x.command);
      if (!t || !isNodeProgram(t[0]) || !/^([A-Za-z]:)?\//.test(slash(t[0]))) continue;
      if (fold(slash(t[1])) !== fold(hookScriptPath(ctx.home, h.script))) continue;
      if (nodePath && fold(slash(t[0])) !== fold(slash(nodePath))) continue;
      return t[0];
    }
  }
  return null;
}
export const hookRegistered = (groups, h, ctx, opts) => findHook(groups, h, ctx, opts) !== null;

// Eski kurulumun (settings.fragment.json, SETUP.md) eklediği onaysız `npx skills` izinleri. Kit artık
// bunları eklemez ve bu tam dizgileri kaldırır: `npx` önce projenin node_modules/.bin klasörüne
// bakar, kötü niyetli bir projedeki sahte `skills` programı bu izinlerle onaysız çalışırdı. Skill
// kurulumu artık her seferinde onaydan geçer (auto modda sınıflandırıcıdan).
export const LEGACY_SKILL_ALLOWS = [
  ...['anthropics', 'vercel-labs', 'openai', 'chelebyy'].map(s => `Bash(npx skills add ${s}/*)`),
  'Bash(npx skills add *)',
  'Bash(npx skills find *)',
];

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// settings.json birleştirmesi. Makinedeki anahtarlar korunur; yalnızca soruların ve kitin gerektirdiği
// anahtarlar eklenir. Beklenmeyen bir yapı (ör. `hooks` dizi) varsa hata verir ve hiçbir şey yazılmaz:
// aksi halde kitin hook'ları sessizce kaybolurken auto mod açılabilirdi. `prev` uyumluluk için durur.
export function mergeSettings(current, a, ctx, prev) {
  void prev;
  if (current != null && !isPlainObject(current)) throw new Error('settings.json bir nesne değil');
  for (const k of ['permissions', 'hooks', 'env', 'pluginConfigs', 'autoMode']) {
    if (current && current[k] !== undefined && !isPlainObject(current[k])) throw new Error(`settings.json: "${k}" beklenen biçimde (nesne) değil; elle düzelt`);
  }
  if (current && current.permissions && current.permissions.allow !== undefined && !Array.isArray(current.permissions.allow)) {
    throw new Error('settings.json: "permissions.allow" bir dizi değil; elle düzelt');
  }
  if (current && current.hooks) {
    for (const [ev, groups] of Object.entries(current.hooks)) if (!Array.isArray(groups)) throw new Error(`settings.json: "hooks.${ev}" bir dizi değil; elle düzelt`);
  }
  if (!ctx.nodePath || !SAFE_PATH.test(slash(ctx.nodePath)) || !SAFE_PATH.test(slash(ctx.home))) {
    throw new Error(`Node ya da ev dizini yolu hook komutunda güvenle kullanılamayacak karakterler içeriyor ($, \`, ", %, ! ve benzeri): ${ctx.nodePath} / ${ctx.home}`);
  }
  const s = structuredClone(current || {});
  const notes = [];
  const added = { allow: [] };

  // İzinler
  s.permissions ||= {};
  const allow = Array.isArray(s.permissions.allow) ? s.permissions.allow : [];
  for (const e of LEGACY_SKILL_ALLOWS) {
    let removed = false;
    for (let i = allow.indexOf(e); i >= 0; i = allow.indexOf(e)) { allow.splice(i, 1); removed = true; }
    if (removed) notes.push(`onaysız skill kurulumu izni kaldırıldı: ${e} (projedeki sahte bir npx/skills programı onaysız çalışabilirdi)`);
  }
  s.permissions.allow = allow;
  // Auto mod sorusunun "hayır" cevabı da açık bir karardır: makinede auto açıksa kapatılır.
  // disableAllHooks açıkken hiçbir hook (model-guard dahil) çalışmaz: auto mod o durumda açılmaz.
  const hooksOff = s.disableAllHooks === true;
  if (a.autoMode && hooksOff && s.permissions.defaultMode !== 'auto') notes.push('auto mod açılmadı: disableAllHooks = true, model-guard çalışmaz (kapatıp kurulumu yeniden çalıştır)');
  if (hooksOff && s.permissions.defaultMode === 'auto') { delete s.permissions.defaultMode; notes.push('auto mod kapatıldı: disableAllHooks = true iken model-guard çalışmaz'); }
  if (a.autoMode && !hooksOff && s.permissions.defaultMode !== 'auto') { s.permissions.defaultMode = 'auto'; notes.push('permissions.defaultMode = auto'); }
  if (!a.autoMode && s.permissions.defaultMode === 'auto') { delete s.permissions.defaultMode; notes.push('permissions.defaultMode = auto kaldırıldı (auto mod istenmedi)'); }

  if (a.autoMode && a.autoEnv === 'mine' && !(s.autoMode && Array.isArray(s.autoMode.environment))) {
    s.autoMode ||= {};
    s.autoMode.environment = AUTO_ENV_MINE.map(l => l.replace('{{OS}}', OS_NAMES[ctx.platform] || ctx.platform));
    notes.push('autoMode.environment eklendi');
  }

  // Hook'lar: kitin tam beklediği kayıt (matcher, mutlak Node yolu, betik, timeout, ek alan yok) varsa
  // dokunulmaz. Yoksa kitin bu betik için yazdığı eski ya da zayıflatılmış kayıtlar (yalın `node`,
  // `$HOME` biçimi, async, başka matcher) kaldırılıp doğru kayıt eklenir; kullanıcının başka
  // hook'larına dokunulmaz.
  s.hooks ||= {};
  for (const h of HOOKS) {
    const groups = Array.isArray(s.hooks[h.event]) ? s.hooks[h.event] : [];
    if (findHook(groups, h, ctx, { nodePath: ctx.nodePath })) { s.hooks[h.event] = groups; continue; }
    let replaced = 0;
    const kept = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) { kept.push(g); continue; }
      const before = g.hooks.length;
      g.hooks = g.hooks.filter(x => !(x && typeof x.command === 'string' && isKitHookCommand(x.command, h, ctx)));
      replaced += before - g.hooks.length;
      if (g.hooks.length || before === 0) kept.push(g);
    }
    let g = kept.find(x => x && x.matcher === h.matcher && Array.isArray(x.hooks));
    if (!g) { g = { matcher: h.matcher, hooks: [] }; kept.push(g); }
    g.hooks.push({ type: 'command', command: hookCommand(ctx.home, h.script, ctx.nodePath), timeout: h.timeout, ...(h.onFailure ? { onFailure: h.onFailure } : {}) });
    s.hooks[h.event] = kept;
    notes.push(`hook ${replaced ? 'güncellendi' : 'eklendi'}: ${h.event} → ${h.script}`);
  }

  s.pluginConfigs ||= {};
  if (!s.pluginConfigs['agents-md@builtin']) {
    s.pluginConfigs['agents-md@builtin'] = { options: { instructionFiles: 'claude-md-and-agents-md' } };
    notes.push('pluginConfigs: projelerdeki AGENTS.md de okunur');
  }
  if (a.advisor && s.advisorModel !== 'fable') { s.advisorModel = 'fable'; notes.push('advisorModel = fable'); }
  if (a.teams) {
    s.env ||= {};
    if (s.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS !== '1') { s.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'; notes.push('takım modu açıldı'); }
    if (!s.teammateMode) { s.teammateMode = 'auto'; notes.push('teammateMode = auto'); }
  }
  if (a.language && a.language !== 'keep' && s.language !== a.language) { s.language = a.language; notes.push(`language = ${a.language}`); }
  if (a.uiPrefs) {
    for (const [k, v] of [['theme', 'auto'], ['tui', 'fullscreen'], ['autoUpdatesChannel', 'latest']]) {
      if (s[k] !== v) { s[k] = v; notes.push(`${k} = ${v}`); }
    }
  }
  return { settings: s, notes, added };
}

// Codex config.toml: yalnızca en üst düzeydeki service_tier satırına ve [features] fast_mode'a bakılır.
// Dosya gizli bilgi (token) içerebilir; içeriği asla yazdırılmaz.
// Satırları karakter karakter tarar: metinler (tek ve çok satırlı, kaçışlarıyla), yorumlar ve çok
// satırlı diziler yapı sayılmaz. Her satır için: hangi tabloda ve bir anahtar satırı mı (satır normal
// durumda ve dizi dışında başlıyorsa). Tam bir TOML ayrıştırıcısı değildir; anlayamadığı bir şey
// görürse (kapanmayan metin ya da dizi, basit olmayan tablo başlığı) `ambiguous` döner ve dosya
// düzeltilmez.
function tomlLines(text) {
  const out = [];
  let table = null; let ml = null; let depth = 0; let ambiguous = false;
  for (const raw of text.split(/\r?\n/)) {
    const lineIsCode = !ml && depth === 0;
    const t = raw.trim();
    if (lineIsCode && t.startsWith('[')) {
      const hm = /^\[\[?[ \t]*([A-Za-z0-9_-]+(?:[ \t]*\.[ \t]*[A-Za-z0-9_-]+)*)[ \t]*\]\]?[ \t]*(#.*)?$/.exec(t);
      if (hm) { table = hm[1].replace(/[ \t]/g, ''); out.push({ raw, table, code: false }); continue; }
      ambiguous = true; // tırnaklı ya da karmaşık başlık: güvenle sınıflandırılamaz
      table = '?';
      out.push({ raw, table, code: false });
      continue;
    }
    let i = 0;
    while (i < raw.length) {
      if (ml) {
        let j = raw.indexOf(ml, i);
        // Çok satırlı temel metinde \""" kaçışlıdır.
        while (j >= 0 && ml === '"""') {
          let bs = 0; for (let k = j - 1; k >= 0 && raw[k] === '\\'; k--) bs++;
          if (bs % 2 === 0) break;
          j = raw.indexOf(ml, j + 1);
        }
        if (j < 0) { i = raw.length; break; }
        i = j + 3;
        let extra = 0; while (extra < 2 && raw[i] === ml[0]) { i++; extra++; }
        ml = null;
        continue;
      }
      const c = raw[i];
      if (c === '#') break;
      if (raw.startsWith('"""', i)) { ml = '"""'; i += 3; continue; }
      if (raw.startsWith("'''", i)) { ml = "'''"; i += 3; continue; }
      if (c === '"') {
        i++;
        while (i < raw.length && raw[i] !== '"') { if (raw[i] === '\\') i++; i++; }
        if (i >= raw.length) ambiguous = true;
        i++;
        continue;
      }
      if (c === "'") {
        const j = raw.indexOf("'", i + 1);
        if (j < 0) { ambiguous = true; i = raw.length; } else i = j + 1;
        continue;
      }
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth < 0) { ambiguous = true; depth = 0; } }
      i++;
    }
    out.push({ raw, table, code: lineIsCode });
  }
  if (ml || depth) ambiguous = true;
  return { lines: out, ambiguous };
}

const TIER_KEY = /^(?:service_tier|"service_tier"|'service_tier')\s*=\s*["']([^"']*)["']/;
const TIER_LINE = /^(?:service_tier|"service_tier"|'service_tier')\s*=/;

// `ambiguous`: dosya bu taramayla güvenle okunamadı; sonuçlara güvenilmez, dosya düzeltilmez.
export function inspectCodexTier(text) {
  if (text == null) return { exists: false, tier: null, needsFix: true, fastModeOff: false, count: 0, ambiguous: false };
  let tier = null; let fastModeOff = false; let count = 0;
  const parsed = tomlLines(text);
  let ambiguous = parsed.ambiguous;
  const FAST_OFF = /^(?:fast_mode|"fast_mode"|'fast_mode')\s*=\s*false\b/;
  for (const l of parsed.lines) {
    if (!l.code) continue;
    const t = l.raw.trim();
    // Kaçış içeren tırnaklı anahtar ("service_tier") ya da noktalı anahtar (features.fast_mode,
    // "features".x) bu taramayla güvenle eşleştirilemez: dosya anlaşılmamış sayılır.
    if (/^["'][^=]*\\/.test(t)) ambiguous = true;
    if (/^(?:features|"features"|'features')\s*[.=]/.test(t)) ambiguous = true; // noktalı ya da tek satırlık tablo
    if (/^(?:service_tier|"service_tier"|'service_tier')\s*\./.test(t)) ambiguous = true;
    if (l.table === null && TIER_LINE.test(t)) { count++; const m = TIER_KEY.exec(t); tier = m ? m[1] : null; }
    else if (l.table === 'features' && FAST_OFF.test(t)) fastModeOff = true;
  }
  return { exists: true, tier, needsFix: ambiguous || !(tier === 'fast' || tier === 'priority'), fastModeOff, count, ambiguous };
}

// Düzeltilmiş metin yeniden denetlenir: en üst düzeyde tam bir service_tier = "fast" yoksa ya da
// dosya bu taramanın anlayamayacağı biçimdeyse hata verilir ve dosya yazılmaz.
export function fixCodexTier(text) {
  let out;
  if (text == null) out = 'service_tier = "fast"\n';
  else {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const { lines } = tomlLines(text);
    if (inspectCodexTier(text).ambiguous) throw new Error('config.toml güvenle okunamadı; service_tier = "fast" satırını kendin ekle');
    const i = lines.findIndex(l => l.code && l.table === null && TIER_LINE.test(l.raw.trim()));
    if (i >= 0) {
      const raw = lines.map(l => l.raw);
      raw[i] = 'service_tier = "fast"';
      out = raw.join(eol);
    } else out = `service_tier = "fast"${eol}${text}`;
  }
  const check = inspectCodexTier(out);
  if (check.ambiguous || check.count !== 1 || check.tier !== 'fast') throw new Error('config.toml güvenle düzeltilemedi; service_tier = "fast" satırını kendin ekle');
  return out;
}

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export const normalizeText = t => t.replace(/\r\n/g, '\n');

// known_marketplaces.json'daki kaynak, beklenen GitHub deposu mu? (github kaynağı ya da o deponun git URL'si)
export function marketplaceMatches(entry, repo) {
  const src = entry && entry.source;
  if (!src || typeof src !== 'object') return false;
  if (src.source === 'github') return String(src.repo || '').toLowerCase() === repo.toLowerCase();
  if (src.source === 'git') {
    const u = String(src.url || '').toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
    return u === `https://github.com/${repo.toLowerCase()}`;
  }
  return false;
}

// installed_plugins.json girdisi kullanıcı kapsamında mı (her projede kullanılabilir mi)?
export function installedForUser(entries) {
  return Array.isArray(entries) && entries.some(e => e && e.scope === 'user');
}
