#!/usr/bin/env node
// PreToolUse hook: kayıtta (~/.claude/models/registry.json) "approved" olmayan bir modelin
// Claude Code araç çağrılarıyla kullanılmasını engeller.
// - Bash / PowerShell: `codex exec`, `codex review`, `claude -p` çağrılarındaki model bayrakları.
// - Agent: `model` parametresi ve codex:codex-rescue isteğindeki `--model`.
// Değerlendirme çalıştırıcısı (node .../eval/run.cjs --model <aday>) bilerek denetlenmez; security
// rolündeki modelin adıyla birlikte codex de geçen her komut ise tek kalıba uymadıkça engellenir (README).
// Bu bir emniyet kemeridir: hook çökerse çağrı geçer ve uyarı gösterilir.
// Kapsam ve sınırlar: claude/models/README.md, "Engelin kapsamı".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CLAUDE_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable']);
const DYNAMIC_RE = /[$`%]/;
const MAX_DEPTH = 32; // iç içe $( ) / bash -c sınırı; aşılırsa çağrı engellenir (denetlenemez)

// Sınır aşılınca ayrıştırmayı durdurur; check() bunu "denetlenemez" diye engeller (fail-closed).
function tooDeep() { const e = new Error('nesting too deep'); e.tooDeep = true; throw e; }
// Bir denetimde taranabilecek toplam karakter: kasıtlı kurulmuş girdiler (her seviyede farklı yorumlu
// iç içe kabuklar) taramayı katlayabilir; bütçe aşılırsa çağrı engellenir (hook zaman aşımına girip
// çağrıyı geçirmesin).
const SCAN_BUDGET = 4000000;
// Seçenek taramalarındaki toplam adım: aynı sözcük listesinde tekrarlanan kabuk adları (sh -o x sh -o x …)
// taramayı karesel yapabilir; adımlar da sınırlıdır.
const SCAN_STEPS = 20000000;
function tooComplex() { const e = new Error('command too complex'); e.tooComplex = true; throw e; }

function registryPath() {
  return process.env.MODEL_GUARD_REGISTRY || path.join(os.homedir(), '.claude', 'models', 'registry.json');
}

function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(registryPath(), 'utf8')); } catch { return null; }
}

// TOML değerinin dış tırnaklarını atar: model="x" ya da model='x' → x.
function unquote(v) {
  const s = String(v).trim();
  const m = s.match(/^(["'])([\s\S]*)\1$/);
  return m ? m[2] : s;
}

// ---------------------------------------------------------------------------------------------
// Kabuk sözcük ayırıcı. Komutu basit komutlara (her biri sözcük dizisi) böler.
// shell: 'bash' (kaçış karakteri \), 'ps' (PowerShell, kaçış `), 'cmd' (kaçış ^).
// - Tırnaklar sözcüğün parçasıdır ama metne girmez: "git commit -m \"... codex exec ...\"" içindeki
//   metin tek bir sözcüktür, komut sayılmaz.
// - $( … ) (bash ve PowerShell, tırnak içinde de) ile bash'te `…` gerçek komuttur: içi ayrı komut
//   olarak çıkarılır, dıştaki sözcüğe "$(…)" yer tutucusu girer.
// - Heredoc (<<X, <<-X, <<'X') ve PowerShell here-string (@' … '@, @" … "@) gövdeleri stdin'e giden
//   metindir; komut sayılmaz.
// ---------------------------------------------------------------------------------------------
// Komut iki kez taranır ve sonuçlar birleşir: bir taramada yorumlar atlanır, diğerinde # sıradan bir
// karakterdir. Yorumu atlamak, yorumdaki bir kesme işaretinin (# Don't …) tırnak sanılıp sonraki
// komutları gizlemesini önler; ama lexer kabuğun her yorum kuralını izlemez (${x:- #y}, <(…)#z,
// tipografik tırnaklar, ters tırnak sonu) ve yorum sandığı yerde kabuk komutu çalıştırabilir. İkinci
// tarama bu yorum kuralının hiç olmadığı davranıştır; birleşim ikisinin de gördüğü her şeyi görür.
// Bedeli: yorum içine yazılmış onaysız bir çağrı da engellenir.
// Tırnaksız (gerçek) yönlendirme işaretçisi: lexer gerçek < ve > karakterlerinin önüne koyar, tırnaklı
// '>' sıradan metin kalır. Heredoc sınırlayıcısı lexer'da tüketildiği için heredoc ayrı işaretlenir.
// Ham girdide bu karakter varsa denetim reddeder (bkz. check); iç içe betiklerde silinir.
const REDIR = '\u0001';
const HEREDOC = REDIR + 'heredoc';
const unmark = w => w.split(REDIR).join('');
// İşaretli yönlendirme sözcüğünün hedefi bitişik değilse (">", "2>", ">&") sonraki sözcük hedeftir.
// Yalnızca işaretli < > & | operatördür (tırnaklı '>' hedeftir). Bitişik yönlendirmelerde (2>&1>out) son
// operatöre bakılır: ondan sonra hedef kalmıyorsa hedef sonraki sözcüktür.
const redirTargetIsNext = w => {
  const k = w.lastIndexOf(REDIR);
  return k >= 0 && w.slice(k).replace(/^(?:\u0001[<>&|])+/, '') === '';
};

function lex(src, shell) {
  // İki tarama yorum içermeyen girdide aynı listeleri üretir; tekrarlar atılır ki iç içe kabuklar
  // her seviyede iki kez taranmasın.
  const seen = new Set();
  const out = [];
  for (const words of [...lexOnce(src, shell, true), ...lexOnce(src, shell, false)]) {
    const key = JSON.stringify(words);
    if (!seen.has(key)) { seen.add(key); out.push(words); }
  }
  return out;
}

// heredocBody: src bir tırnaksız heredoc gövdesidir; yalnızca $( … ) ve `…` ikameleri komut olarak
// taranır, geri kalanı (tırnaklar dahil) düz metindir.
function lexOnce(src, shell, comments, depth0 = 0, heredocBody = false) {
  const out = [];
  const esc = shell === 'bash' ? '\\' : shell === 'ps' ? '`' : '^';
  // PowerShell kaçış dizileri gerçek karakterlere çevrilir (`n satır sonu, `t sekme …); aksi halde
  // base64 içine konan `n "n" harfi sanılıp kodlanmış betik denetimini atlatır.
  const PS_ESCAPES = { n: '\n', t: '\t', r: '\r', v: '\v', f: '\f', 0: '\0', a: '\x07', b: '\b', e: '\x1b' };
  const escaped = ch => (shell === 'ps' && Object.prototype.hasOwnProperty.call(PS_ESCAPES, ch) ? PS_ESCAPES[ch] : ch);
  let i = 0;

  // Satır sonuna gelindiğinde bekleyen heredoc gövdelerini geç. Bash gibi: önce gövdenin bittiği
  // sınırlayıcı satır ham satırlar üzerinden bulunur; tarama her durumda onun ardından sürer. Sınırlayıcı
  // tırnaksızsa (<<EOF) bash gövdedeki $( … ) ve `…` ikamelerini çalıştırır: bunlar yalnızca gövde
  // diliminin içinde taranır (kapanmamış bir ikame gövdenin dışına taşamaz). Tırnaklı gövde düz metindir.
  function skipHeredocs(pending, depth) {
    for (const h of pending) {
      const start = i;
      let bodyEnd = src.length;
      let after = src.length;
      // Tırnaksız gövdede tek sayıda \ ile biten satır sonrakine birleşir (bash satır devamı); sınırlayıcı
      // birleşmiş mantıksal satırla karşılaştırılır (x\ + EOF = "xEOF", sınırlayıcı değildir). <<- için
      // bash önce fiziksel satırları birleştirir, baştaki sekmeleri birleşik satırdan bir kez siler.
      // Sondaki \ sayısı geriye doğru sayılır (düzenli ifade uzun \ dizilerinde karesel olurdu).
      let joined = '';
      let logicalStart = i;
      for (let p = i; p < src.length;) {
        let end = src.indexOf('\n', p);
        if (end < 0) end = src.length;
        const raw = src.slice(p, end).replace(/\r$/, '');
        let k = raw.length;
        while (k > 0 && raw.charCodeAt(k - 1) === 92) k--;
        if (!h.quoted && (raw.length - k) % 2 === 1) { joined += raw.slice(0, -1); p = end + 1; continue; }
        const logical = joined + raw;
        if ((h.strip ? logical.replace(/^\t+/, '') : logical) === h.delim) { bodyEnd = logicalStart; after = Math.min(end + 1, src.length); break; }
        joined = '';
        p = end + 1;
        logicalStart = p;
      }
      if (!h.quoted && bodyEnd > start) {
        for (const w of lexOnce(src.slice(start, bodyEnd), shell, comments, depth, true)) out.push(w);
      }
      i = after;
    }
    pending.length = 0;
  }

  // Bir komut listesi okur; endChar (')' ya da '`') görülünce döner.
  function list(endChar, depth) {
    let words = [];
    let word = null;
    // Sözcüğün yönlendirme işareti taşıyıp taşımadığı ve son iki karakteri eklenen parçadan izlenir: her
    // & | < > karakterinde büyüyen sözcüğün tamamını taramak (düzenli ifade, includes) karesel olurdu.
    let wordRedir = false;
    let wordTail = '';
    const pending = [];
    const add = s => {
      word = (word === null ? '' : word) + s;
      if (s.includes(REDIR)) wordRedir = true;
      wordTail = s.length >= 2 ? s.slice(-2) : (wordTail + s).slice(-2);
    };
    const flushWord = () => { if (word !== null) words.push(word); word = null; wordRedir = false; wordTail = ''; };
    const flushCmd = () => { flushWord(); if (words.length) out.push(words); words = []; };

    while (i < src.length) {
      const c = src[i];
      if (endChar && c === endChar) { i++; flushCmd(); return; }
      if (c === '\n') { i++; flushCmd(); if (pending.length) skipHeredocs(pending, depth); continue; }
      if (c === esc) {
        if (src[i + 1] === '\n') { i += 2; continue; } // satır devamı
        if (src[i + 1] === '\r' && src[i + 2] === '\n') { i += 3; continue; }
        if (i + 1 < src.length) add(escaped(src[i + 1]));
        i += 2; continue;
      }
      // Yorumlar (yalnızca comments taramasında; bkz. lex): bash ve PowerShell'de sözcük başındaki #
      // satır sonuna kadar (bash ters tırnak içindeyse kapanış ters tırnağına kadar), PowerShell'de
      // <# … #> bloğu. Sözcüğün ortasındaki # (a#b, $#) sözcüğün parçasıdır.
      if (comments && shell === 'ps' && c === '<' && src[i + 1] === '#' && word === null) {
        const end = src.indexOf('#>', i + 2);
        i = end < 0 ? src.length : end + 2;
        continue;
      }
      if (comments && c === '#' && shell !== 'cmd' && word === null) {
        while (i < src.length && src[i] !== '\n' && !(endChar === '`' && src[i] === '`')) i++;
        continue;
      }
      if (c === "'") { i++; add(single()); continue; }
      if (c === '"') { i++; add(double(depth)); continue; }
      if (c === '$' && src[i + 1] === '(' && shell !== 'cmd') {
        i += 2; add('$(…)');
        // Sınırda iç içe inmeyi bırak ama metni atlama: içerik bu listede düz komut olarak taranır.
        if (depth < MAX_DEPTH) list(')', depth + 1); else tooDeep();
        continue;
      }
      if (c === '`' && shell === 'bash') {
        i++; add('`…`');
        if (depth < MAX_DEPTH) list('`', depth + 1); else tooDeep();
        continue;
      }
      if (shell === 'bash' && c === '<' && src[i + 1] === '<' && src[i + 2] === '<') { i += 3; flushWord(); words.push(REDIR + '<' + REDIR + '<' + REDIR + '<'); continue; } // here-string <<<: sonraki sözcük stdin
      if (shell === 'bash' && c === '<' && src[i + 1] === '<') {
        const m = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|([A-Za-z_][\w.-]*))/.exec(src.slice(i, i + 200));
        if (m) {
          pending.push({ strip: m[1] === '-', delim: m[2] ?? m[3] ?? m[4], quoted: m[4] === undefined });
          flushWord(); words.push(HEREDOC); i += m[0].length; continue;
        }
      }
      if (shell === 'ps' && c === '@' && (src[i + 1] === "'" || src[i + 1] === '"') && /^[ \t]*\r?\n/.test(src.slice(i + 2, i + 40))) {
        const close = '\n' + src[i + 1] + '@';
        const end = src.indexOf(close, i);
        add('@HERESTRING');
        i = end < 0 ? src.length : end + close.length;
        continue;
      }
      // PowerShell argüman kipinde komutun ortasındaki (ifade) değeri argüman olur: genişletilebilir yer
      // tutucu olarak eklenir (güvenlik sözleşmesi reddeder), içi yine komut olarak taranır.
      if (c === '(' && shell === 'ps' && (words.length || word !== null)) { i++; add('$(…)'); if (depth < MAX_DEPTH) list(')', depth + 1); else tooDeep(); continue; }
      // bash extglob (+(…), @(…), !(…), ?(…), *(…)): sözcüğün parçasıdır ve çalışırken dosya adlarına
      // genişler (+(-m|x) → -m x). Genişletilebilir yer tutucu eklenir (codex argümanında reddedilir); içi
      // yine komut olarak taranır. Gruptan sonra sözcük bölünür: ?(x)codex içindeki codex program adı olarak
      // görünür kalsın (yoksa program adı gizlenir ve çağrı denetlenmez).
      if (c === '(' && shell === 'bash' && word !== null && /[+@!?*]$/.test(word)) { i++; add('$(…)'); if (depth < MAX_DEPTH) list(')', depth + 1); else tooDeep(); flushWord(); continue; }
      if (c === '(') { i++; flushCmd(); if (depth < MAX_DEPTH) list(')', depth + 1); else tooDeep(); continue; }
      // >&, <&, 2>&1, &>log, &>>log: & yönlendirmenin parçasıdır, komut ayırıcı değil (yoksa sonraki
      // sözcükler çağrının dışında kalır: codex exec 2>&1 -m <onaysız> denetlenmezdi).
      // Yalnızca lexer'ın işaretlediği (tırnaksız) < ya da > sonrası: tırnaklı "x>"& yine ayırıcıdır.
      if ((c === '&' || c === '|') && word !== null && wordTail[0] === REDIR && (wordTail[1] === '<' || wordTail[1] === '>')) { add(REDIR + c); i++; continue; }
      // &>log: önündeki sözcük ayrı bir argümandır (codex&>x exec …: program codex, yönlendirme &>x).
      // cmd'de &> yönlendirme değildir: & komut ayırıcıdır (aşağıda).
      if (c === '&' && src[i + 1] === '>' && shell !== 'cmd') { flushWord(); add(REDIR + c); i++; continue; }
      // Gerçek yönlendirme: önündeki sözcük yalnızca dosya tanımlayıcısı (2>, &>, *>) değilse ayrı bir
      // argümandır (-o>x: argüman -o, yönlendirme >x).
      if (c === '>' || c === '<') {
        if (word !== null && !wordRedir && !/^(?:\d+|&|\*)$/.test(word)) flushWord();
        add(REDIR + c); i++; continue;
      }
      if (c === ';' || c === '&' || c === '|' || c === ')') { i++; flushCmd(); continue; }
      if (c === ',' && shell === 'ps') { i++; flushWord(); continue; } // PowerShell dizi elemanları: 'a','b'
      if (c === ' ' || c === '\t' || c === '\r') { i++; flushWord(); continue; }
      add(c); i++;
    }
    flushCmd();
  }

  function single() {
    let s = '';
    while (i < src.length) {
      const c = src[i++];
      if (c === "'") {
        if (shell === 'ps' && src[i] === "'") { s += "'"; i++; continue; } // PowerShell: '' → '
        return s;
      }
      s += c;
    }
    return s;
  }

  function double(depth) {
    let s = '';
    while (i < src.length) {
      const c = src[i];
      if (c === '"') {
        i++;
        if (shell === 'ps' && src[i] === '"') { s += '"'; i++; continue; } // PowerShell: "" → "
        return s;
      }
      if (shell === 'bash' && c === '\\' && /["\\$`\n]/.test(src[i + 1] || '')) { s += src[i + 1]; i += 2; continue; }
      if (shell === 'ps' && c === '`' && i + 1 < src.length) { s += escaped(src[i + 1]); i += 2; continue; }
      if (shell !== 'cmd' && c === '$' && src[i + 1] === '(') {
        i += 2; s += '$(…)';
        // Sınırda dizgiyi burada bitir: kalan metin komut olarak taranır, atlanmaz.
        if (depth < MAX_DEPTH) list(')', depth + 1); else tooDeep();
        continue;
      }
      if (shell === 'bash' && c === '`') {
        i++; s += '`…`';
        if (depth < MAX_DEPTH) list('`', depth + 1); else tooDeep();
        continue;
      }
      s += c; i++;
    }
    return s;
  }

  if (heredocBody) {
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '$' && src[i + 1] === '(') { i += 2; if (depth0 < MAX_DEPTH) list(')', depth0 + 1); else tooDeep(); continue; }
      if (c === '`') { i++; if (depth0 < MAX_DEPTH) list('`', depth0 + 1); else tooDeep(); continue; }
      i++;
    }
  } else list(null, depth0);
  return out;
}

const baseName = w => w.split(/[\\/]/).pop().toLowerCase().replace(/\.(cmd|exe|js|ps1|bat)$/, '');
// codex'in değer alan bayrakları: alt komutu bulurken değerleri atlanır.
const CODEX_VALUE_FLAGS = new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '-C', '--cd', '-s', '--sandbox',
  '-a', '--ask-for-approval', '-i', '--image', '--enable', '--disable', '--add-dir', '--local-provider', '--cyber-access-program', '--remote', '--remote-auth-token-env']);
// Argümanı ayrı bir betik olan kabuklar: bash -c "…", pwsh -Command "…", cmd /c …
const NESTED_SHELLS = { bash: 'bash', sh: 'bash', zsh: 'bash', dash: 'bash', pwsh: 'ps', powershell: 'ps', cmd: 'cmd' };
// PowerShell bayrak öneki: -, --, /, ayrıca uzun tireler (– — ―); pwsh 7.6.9'da denendi.
const PS_DASH = String.raw`(?:[-–—―]{1,2}|\/)`;
const SCRIPT_FLAG = {
  // -c, -lc, -ec, -xc … İlk c'den önceki harfler c içermez: tek ayrıştırma yolu kalır, geri izleme
  // doğrusaldır (eski /^-[a-zA-Z]*c[a-zA-Z]*$/ uzun -ccc…=1 sözcüğünde karesel sürüp hook'u zaman aşımına sokuyordu).
  bash: /^-[abd-zA-Z]*c[a-zA-Z]*$/,
  // -c, -com, -Command, -CommandWithArgs, -cwa (kısaltmalar dahil)
  ps: new RegExp(String.raw`^${PS_DASH}(?:c(o(m(m(a(n(d(withargs)?)?)?)?)?)?)?|cwa)$`, 'i'),
  cmd: /^[-/]{1,2}[ck]$/i, // /c, /k, Git Bash'te //c
};
// pwsh -ec / -enc… / -EncodedCommand: base64 betik, içi denetlenemez → engellenir. Kısa -e bilerek
// denetlenmez (grep/rg -e ile çakışır); bkz. README "Engelin kapsamı".
const PS_ENCODED = new RegExp(String.raw`^${PS_DASH}e(c|n(c(o(d(e(d(c(o(m(m(a(n(d)?)?)?)?)?)?)?)?)?)?)?)?)$`, 'i');
// pwsh -File: sonrası betik dosyası ve onun argümanlarıdır, pwsh bayrağı değildir.
const PS_FILE = new RegExp(String.raw`^${PS_DASH}f(i(le?)?)?$`, 'i');
const PS_OPTION = new RegExp(`^${PS_DASH}`);
// Değer alan powershell.exe bayrakları: -File'ın konumsal argümandan önce olup olmadığına
// bakarken değerleri (örn. -ExecutionPolicy Bypass) konumsal argüman sayılmasın.
const PS_VALUE_FLAGS = new Set(['executionpolicy', 'ep', 'ex', 'exec', 'windowstyle', 'w', 'win', 'version', 'v',
  'psconsolefile', 'outputformat', 'o', 'of', 'inputformat', 'in', 'if', 'configurationname', 'config',
  'workingdirectory', 'wd', 'wo', 'settingsfile', 'custompipename']);
const psFlagName = w => w.replace(new RegExp(`^${PS_DASH}`), '').toLowerCase();
// Argümanlarını hiçbir zaman komut olarak çalıştırmayan saf metin araçları. Komut bunlardan biriyle
// başlıyorsa iç içe kabuk kuralları uygulanmaz ("rg -e pwsh …", "rg powershell \"codex …\"").
// git bilerek yok: "git rebase --exec" argümanını çalıştırır.
const TEXT_TOOLS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'findstr', 'select-string', 'sls', 'echo', 'printf',
  'write-output', 'write-host', 'cat', 'type', 'head', 'tail', 'wc', 'less']);

// Bir kabuk komutundaki codex exec/review ve claude -p çağrılarını, kullandıkları model
// değerleriyle döndürür: [{ kind, models: [...], profile: bool }]
function invocations(rawCommand, shell = 'bash', depth = 0, out = [], visited = { keys: new Set(), chars: 0, steps: 0 }) {
  const step = () => { if (++visited.steps > SCAN_STEPS) tooComplex(); };
  // Aynı (kabuk, betik) çifti bir denetimde bir kez taranır; toplam taranan metin bütçeyle sınırlıdır.
  const src = String(rawCommand);
  const key = `${shell}\0${src}`;
  if (visited.keys.has(key)) return out;
  visited.keys.add(key);
  visited.chars += src.length;
  if (visited.chars > SCAN_BUDGET) tooComplex();
  for (const words of lex(src, shell)) {
    // Kabuk adı komutun neresinde geçerse geçsin aranır (sudo -u root sh -c, if …; then sh -c,
    // xargs -I {} sh -c, find -exec sh -c …). Yanlış alarm zararsızdır: yalnızca betikte onaysız
    // bir codex/claude çağrısı varsa engeller. Her kabuk türünün yalnızca ilk geçişi işlenir;
    // sonraki geçişler onun taradığı sözcüklerin içindedir, bu yüzden tarama doğrusal kalır.
    // İlke: bir betik tarandıktan sonra komutun kalanı atlanmaz (fazla tarama yalnızca yanlış alarm
    // üretir, eksik tarama onaysız modeli geçirir).
    const seen = {};
    const textTool = words.length > 0 && TEXT_TOOLS.has(baseName(words[0]));
    for (let i = 0; i < words.length; i++) {
      const name = baseName(words[i]);
      const nested = textTool || !Object.prototype.hasOwnProperty.call(NESTED_SHELLS, name) ? undefined : NESTED_SHELLS[name];
      if (nested) {
        if (seen[nested]) continue;
        seen[nested] = true;
        if (nested === 'ps') {
          let opaque = false;
          for (let j = i + 1; j < words.length; j++) {
            step();
            const w = words[j];
            if (SCRIPT_FLAG.ps.test(w) || PS_FILE.test(w)) break; // sonrası betik ya da betiğin argümanları
            if (PS_ENCODED.test(w)) { opaque = true; break; }
          }
          if (opaque) {
            out.push({ kind: 'opaque', reason: 'an encoded PowerShell command (-EncodedCommand) cannot be checked; pass the script as plain text' });
            break;
          }
        }
        // Betik bayrağı i'den sonra aranır (findIndex baştan tarardı: çok sözcükte karesel).
        // bash seçenek ayrıştırmayı ilk seçenek olmayan sözcükte bitirir; sonrası betik dosyası ve onun
        // argümanlarıdır ("find . -exec sh ./a.sh {} + -exec codex …" içindeki -exec bash bayrağı
        // değildir). bash'in değer alan seçeneklerinin değeri atlanır (-o pipefail, --rcfile x).
        // cmd ise /c ya da /k'yı öndeki sözcüklerden bağımsız kabul eder; orada sınır yok.
        let k = -1;
        for (let j = i + 1; j < words.length; j++) {
          step();
          const w = words[j];
          // Yönlendirmeler seçenek ayrıştırmasını bitirmez (bash 2>/dev/null -c "…").
          if (w === HEREDOC) continue;
          if (w.includes(REDIR)) { if (redirTargetIsNext(w)) j++; continue; }
          if (SCRIPT_FLAG[nested].test(w)) { k = j; break; }
          if (nested === 'bash') {
            if (/^[-+][a-zA-Z]*[oO]$/.test(w) || w === '--rcfile' || w === '--init-file') { j++; continue; }
            if (!/^[-+]/.test(w)) break;
          }
        }
        // Betik bulunamadıysa sonraki aynı türden kabuk da işlensin (find … -exec sh ./a.sh +
        // -exec sh -c "…"); k araması ilk seçenek olmayan sözcükte durduğu için doğrusal kalır.
        if (k < 0 && nested === 'bash') seen.bash = false;
        if (k > 0 && nested === 'bash') {
          // bash: betik -c'den sonraki ilk sözcüktür ("-c --" ise ondan sonraki). Kalan sözcükler
          // $0, $1 … olur ama taranmaya devam edilir: "find … -exec sh -c : \; -exec codex …" ve
          // sh -c 'exec "$@"' _ codex … gibi biçimler orada gerçek çağrı taşır.
          const s = words[k + 1] === '--' ? k + 2 : k + 1;
          if (depth >= MAX_DEPTH) tooDeep();
          invocations(words[s] ?? '', nested, depth + 1, out, visited);
          seen.bash = false; // sonraki "sh -c" de işlensin; i her seferinde ileri gittiği için doğrusal
          i = s - 1; // betik sözcüğü de dış taramada komut adı olarak denensin (yalnızca yanlış alarm üretir)
          continue;
        }
        let script = null;
        // PowerShell ve cmd: bayraktan sonraki tüm sözcükler birleştirilip betik olarak çalışır;
        // komutun kalanı zaten bu betiğin içinde taranır.
        if (k > 0) script = words.slice(k + 1).map(unmark).join(' ');
        else if (name === 'powershell') {
          // Windows PowerShell 5.1: bayraksız konumsal argüman -Command olarak çalışır (Start-Process
          // powershell -ArgumentList "…", sudo powershell "…" dahil). -File ancak ilk konumsal
          // argümandan önce geliyorsa geçerlidir; sonra gelirse betiğin argümanıdır. Bayraklar betikten
          // atılmaz (değerleri de betiğe karışabilir, zararsızdır).
          let p = i + 1;
          let fileFirst = false;
          while (p < words.length && PS_OPTION.test(words[p])) {
            step();
            if (PS_FILE.test(words[p])) { fileFirst = true; break; }
            p += PS_VALUE_FLAGS.has(psFlagName(words[p])) ? 2 : 1;
          }
          if (!fileFirst && i + 1 < words.length) script = words.slice(i + 1).map(unmark).join(' ');
        }
        if (script !== null) {
          if (depth >= MAX_DEPTH) tooDeep();
          invocations(script, nested, depth + 1, out, visited);
          break;
        }
        continue; // betik yoksa sonraki sözcükler (örn. sudo sh codex …) taranmaya devam eder
      }
      if (name !== 'codex' && name !== 'claude') continue;
      // Bu sözcükten sonrakiler çağrının argümanlarıdır; komutun kalanı bir kez taranır.
      const end = words.length;
      if (name === 'codex') {
        let sub = null;
        for (let j = i + 1; j < end; j++) {
          if (words[j] === HEREDOC) continue; // yönlendirmeler alt komut değildir (codex >log exec …)
          if (words[j].includes(REDIR)) { if (redirTargetIsNext(words[j])) j++; continue; }
          if (words[j].startsWith('-')) { if (CODEX_VALUE_FLAGS.has(words[j])) j++; continue; }
          sub = words[j]; break;
        }
        if (['exec', 'e', 'review'].includes(sub)) {
          // args: security rolündeki modelin çağrı sözleşmesi için (bkz. roleProblem).
          const inv = { kind: 'codex', sub, args: words.slice(i + 1, end), models: [], efforts: [], profile: false };
          for (let j = i + 1; j < end; j++) {
            const w = words[j];
            if (w === '--') break; // sonrası istem metni
            if (w === '-m' || w === '--model') inv.models.push(words[++j] ?? '');
            else if (w.startsWith('--model=')) inv.models.push(w.slice(8));
            else if (/^-m[^-]/.test(w)) inv.models.push(w.slice(2).replace(/^=/, ''));
            else if (w === '-c' || w === '--config' || w.startsWith('--config=') || /^-c[^-]/.test(w)) {
              const kv = (w.startsWith('--config=') ? w.slice(9) : /^-c[^-]/.test(w) ? w.slice(2).replace(/^=/, '') : words[++j] ?? '').match(/^\s*(review_model|model|model_reasoning_effort)\s*=\s*([\s\S]*)$/);
              if (kv && kv[1] === 'model_reasoning_effort') inv.efforts.push(unquote(kv[2]));
              else if (kv) inv.models.push(unquote(kv[2]));
            } else if (w === '-p' || w === '--profile' || w.startsWith('--profile=')) inv.profile = true;
          }
          out.push(inv);
        }
      } else {
        const args = words.slice(i + 1, end);
        if (args.includes('-p') || args.includes('--print')) {
          const inv = { kind: 'claude', models: [], profile: false };
          for (let j = 0; j < args.length; j++) {
            if (args[j] === '--model') inv.models.push(args[++j] ?? '');
            else if (args[j].startsWith('--model=')) inv.models.push(args[j].slice(8));
          }
          out.push(inv);
        }
      }
      break;
    }
  }
  return out;
}

// Sondaki [..] ekini atar (claude-opus-5-5[1m] → claude-opus-5-5). Regex yerine doğrusal: uzun
// '[' dizisi taramayı karesel yapıp hook'u zaman aşımına (fail-open) sokmasın.
function stripSuffix(value) {
  if (!value.endsWith(']')) return value;
  const body = value.slice(0, -1);
  const j = body.indexOf('[', body.lastIndexOf(']') + 1);
  return j >= 0 ? value.slice(0, j) : value;
}

function approvedCodex(registry, slug) {
  const e = registry && registry.codex && Object.prototype.hasOwnProperty.call(registry.codex, slug) && registry.codex[slug];
  return !!(e && e.status === 'approved');
}

function approvedClaude(registry, value) {
  const claude = (registry && registry.claude) || {};
  const id = stripSuffix(value); // claude-opus-5-5[1m] → claude-opus-5-5
  const family = f => Object.entries(claude).some(([k, e]) => e && e.status === 'approved' && k.includes(`-${f}-`));
  if (CLAUDE_ALIASES.has(id)) return family(id);
  if (id === 'opusplan') return family('opus') && family('sonnet'); // planlamada Opus, uygulamada Sonnet
  if (id === 'default') return true; // hesabın varsayılanı; ana oturum modeliyle aynı kural
  const e = Object.prototype.hasOwnProperty.call(claude, id) && claude[id];
  return !!(e && e.status === 'approved');
}

// Bir model değerini denetler; sorun varsa nedenini döndürür.
function problem(registry, kind, value) {
  if (DYNAMIC_RE.test(value)) return `model "${value.slice(0, 40)}" is not a literal; write the approved model slug directly`;
  const id = stripSuffix(value);
  if (!SLUG_RE.test(id)) return `model "${value.slice(0, 40)}" could not be parsed`;
  if (!registry) return `the model registry (${registryPath()}) could not be read, so "${id}" cannot be checked`;
  const ok = kind === 'codex' ? approvedCodex(registry, id) : approvedClaude(registry, id);
  if (!ok) return `model "${id}" is not approved in the model registry. Unapproved models get no role; evaluate it first and update the registry (claude/models/README.md)`;
  return null;
}

// Onaylı bir Codex modelinin kaydında efforts listesi varsa çağrının eforu bu listeden olmalıdır.
// Efor verilmezse Codex config varsayılanını kullanır ve denetlenemez: modelsiz çağrı gibi engellenir.
// Birden çok değer verilirse hepsi denetlenir (Codex sonuncuyu kullanır).
// cache: aynı çağrıda aynı modele (son ekli yazımlar dahil: x[0], x[1]) çözülen değerler bir kez denetlenir;
// efforts listesi çağıran tarafından bir kez tekilleştirilir (modeller × eforlar karesel olmasın).
function effortProblem(registry, value, efforts, flag, cache) {
  const id = stripSuffix(value);
  if (cache.has(id)) return cache.get(id);
  const r = effortProblemUncached(registry, id, efforts, flag);
  cache.set(id, r);
  return r;
}

function effortProblemUncached(registry, id, efforts, flag) {
  const e = registry && registry.codex && Object.prototype.hasOwnProperty.call(registry.codex, id) && registry.codex[id];
  if (!e || e.status !== 'approved' || !Array.isArray(e.efforts)) return null;
  const list = e.efforts.join('|');
  if (!efforts.length) return `model "${id}" is called without an effort, so the Codex config default would be used and cannot be checked; pass ${flag} with one of the registry efforts: ${list}`;
  for (const v of efforts) {
    if (DYNAMIC_RE.test(v)) return `effort "${v.slice(0, 40)}" is not a literal; write one of the registry efforts for "${id}": ${list}`;
    if (!e.efforts.includes(v)) return `effort "${v.slice(0, 40)}" is not approved for model "${id}" in the model registry; use one of: ${list}`;
  }
  return null;
}

// security rolündeki model (örn. Daybreak) yalnızca kurallardaki salt okunur güvenlik incelemesi
// için onaylıdır: codex exec, açık -s read-only ve kayıttaki cyber programı. Sözleşme izin
// listesiyle denetlenir: listede olmayan her bayrak (örn. --approve-for-me, --full-auto, --add-dir, -o,
// --worktree,
// başka -c anahtarları) ve codex review / codex-rescue reddedilir; yeni CLI bayrakları da kapalı kalır.
// Bayrak listesi: codex-cli 0.167.0 `codex exec --help`.
const SEC_VALUE_FLAGS = new Set(['-m', '--model', '-c', '--config', '-s', '--sandbox', '-C', '--cd',
  '--cyber-access-program', '--color', '--disable']);
const SEC_BARE_FLAGS = new Set(['--skip-git-repo-check', '--ephemeral', '--json', '--strict-config', '--ignore-user-config', '--ignore-rules']);
const SEC_CONFIG_KEYS = new Set(['model', 'model_reasoning_effort', 'service_tier', 'sandbox_mode', 'windows.sandbox']);

function securityEntry(registry, value) {
  const id = stripSuffix(value);
  const e = registry && registry.codex && Object.prototype.hasOwnProperty.call(registry.codex, id) && registry.codex[id];
  return e && e.status === 'approved' && e.role === 'security' ? { id, e } : null;
}

// Kabuğun genişletebileceği sözcük (değişken, ikame, ayraç, glob, PowerShell splat): değeri
// denetlenemez, çalışırken bayrağa dönüşebilir (örn. $F → --approve-for-me) → sözleşmede reddedilir.
const EXPANDABLE_RE = /[$`{}*?[\]%!]|^@/; // % ve !: cmd değişkenleri (%F%, !F!)

// Çağrı argümanlarında sözleşmeye aykırı ilk şeyi döndürür; uygunsa null. Alt komuttan sonra
// konumsal argüman olarak yalnızca '-' (istem stdin'den) kabul edilir: fork/resume, istem metni
// ve genişletilebilir sözcükler böylece tek kuralla kapanır.
function securityArgsProblem(args, program) {
  const sandboxes = [];
  const programs = [];
  let sawSub = false;
  let stdin = 0;
  for (let j = 0; j < args.length; j++) {
    let w = args[j];
    if (w === '--') return 'arguments after -- are not allowed; give the request on stdin with -';
    // Gerçek yönlendirme (lexer işaretli): operatör ve bitişik değilse hedefi (sonraki sözcük) argüman
    // değildir. Heredoc'un sınırlayıcısı zaten tüketildi, sonraki sözcük gerçek argümandır.
    if (w === HEREDOC) continue;
    if (w.includes(REDIR)) { if (redirTargetIsNext(w)) j++; continue; }
    if (EXPANDABLE_RE.test(w)) return `argument ${w.slice(0, 40)} can be expanded by the shell`;
    let value = null;
    const eq = w.startsWith('--') ? w.indexOf('=') : -1;
    if (eq > 0) { value = w.slice(eq + 1); w = w.slice(0, eq); }
    else if (/^-[mscC][^-]/.test(w)) { value = w.slice(2).replace(/^=/, ''); w = w.slice(0, 2); }
    if (w.startsWith('-') && w !== '-') {
      if (SEC_BARE_FLAGS.has(w) && value === null) continue;
      if (!SEC_VALUE_FLAGS.has(w)) return `option ${w.slice(0, 40)} is not allowed`;
      if (value === null) {
        value = args[++j] ?? '';
        if (EXPANDABLE_RE.test(value)) return `argument ${value.slice(0, 40)} can be expanded by the shell`;
      }
      if (w === '-s' || w === '--sandbox') sandboxes.push(value);
      else if (w === '--cyber-access-program') programs.push(value);
      else if (w === '--disable') { if (!/^(?:apps|plugins)$/.test(value)) return `--disable ${value.slice(0, 40)} is not allowed`; }
      else if (w === '-c' || w === '--config') {
        // (?!\s): = sonrasındaki boşluk tümüyle tüketilir; yoksa \s* ile (.*) aynı boşluğu paylaşır ve
        // satır sonlu uzun değerde eşleşme karesel geri izler.
        const kv = value.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(?!\s)(.*)$/);
        if (!kv || !SEC_CONFIG_KEYS.has(kv[1])) return `config override ${value.slice(0, 40)} is not allowed`;
        if (kv[1] === 'sandbox_mode') sandboxes.push(unquote(kv[2]));
        if (kv[1] === 'windows.sandbox' && unquote(kv[2]) !== 'unelevated') return 'windows.sandbox must be unelevated';
      }
      continue;
    }
    if (!sawSub) { sawSub = true; continue; } // alt komut (exec / e)
    if (w === '-') { stdin++; continue; }
    if (w !== '-') return `positional argument ${w.slice(0, 40)} is not allowed; give the request on stdin with -`;
  }
  if (stdin !== 1) return 'give the request on stdin with exactly one -';
  if (sandboxes.length === 0 || sandboxes.some(v => v !== 'read-only')) return 'sandbox must be given as read-only';
  if (!program || programs.length !== 1 || programs[0] !== program) return 'wrong or missing cyber program';
  return null;
}

// security rolündeki modelin tek izinli çağrısı: ham komut metni bu kalıba harfiyen uymalıdır (lexer'a
// dayanmaz; kabuk sözdizimi ne kadar karmaşık olursa olsun kalıp dışı her şey reddedilir). Yollar boşluk,
// tırnak ve kabuk karakteri içermez ve '-' ile başlamaz.
const TPL_PATH = String.raw`[A-Za-z0-9_.:/\\][A-Za-z0-9_.:/\\-]*`;
// İstek ve çıktı dosyaları yalnızca Claude'un geçici klasöründe olabilir (kaynak dosyanın üstüne yazılmasın,
// PowerShell sağlayıcı yolu Env:… ya da /dev/tcp gibi özel hedefler kalıba uymasın). '..' segmenti yok.
const TPL_SEG = String.raw`[A-Za-z0-9_-][A-Za-z0-9_.-]*`;
// Ortamdan gelen kök yalnızca güvenli karakterlerden oluşuyorsa eklenir (komut bu değişkenleri değiştiremez:
// hook Claude Code'un ortamıyla çalışır).
function tmpRoots() {
  const roots = [String.raw`(?:[A-Za-z]:|/[a-z])/Users/[A-Za-z0-9_.-]+/AppData/Local/Temp`, '/tmp'];
  for (const v of [process.env.CLAUDE_CODE_TMPDIR, process.env.TEMP, process.env.TMP]) {
    const r = String(v || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (/^(?:[A-Za-z]:|\/)[A-Za-z0-9_./-]*$/.test(r) && !r.split('/').includes('..')) roots.push(r.replace(/[.]/g, '\\.'));
  }
  return roots;
}
// Linux ve macOS'ta Claude Code klasörü kullanıcıya göre adlandırır: claude-<uid>. Yalnızca hook'u çalıştıran
// kullanıcının uid'i kabul edilir; paylaşılan /tmp'de başka bir kullanıcının klasörü kalıba uymaz.
const claudeDir = () => (typeof process.getuid === 'function' ? `claude(?:-${process.getuid()})?` : 'claude');
const tplTmp = () => `(?:${tmpRoots().join('|')})/${claudeDir()}(?:/${TPL_SEG})*/`;
const reEscape = v => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// İnceleme çalıştırmalarında MCP sunucuları, uygulamalar (ChatGPT bağlayıcıları) ve eklentiler kapalı:
// incelenen koda gizlenmiş bir talimat GitHub'a yazamasın, dağıtım yapamasın. --ignore-user-config
// config.toml'u (MCP listesi dahil) yok sayar; Windows sandbox ayarı orada olduğu için açıkça verilir.
// --ignore-rules execpolicy .rules dosyalarını yükletmez: oradaki allow kuralları (git push, gh pr create)
// komutu sandbox dışında, onaysız çalıştırırdı.
const NO_MCP = '--ignore-user-config --ignore-rules --disable apps --disable plugins -c windows.sandbox="unelevated"';
const NO_MCP_RE = NO_MCP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function securityTemplates(slug, e) {
  const efforts = (Array.isArray(e.efforts) ? e.efforts : []).filter(x => /^[a-z]+$/.test(x));
  if (!e.cyberAccessProgram || !efforts.length || !/^[a-z_]+$/.test(e.cyberAccessProgram)) return [];
  const tier = /^[a-z]+$/.test(e.serviceTier || '') ? e.serviceTier : 'default';
  const call = `codex exec -m ${reEscape(slug)} --cyber-access-program ${e.cyberAccessProgram}` +
    ` ${NO_MCP_RE} -c model_reasoning_effort="(?:${efforts.join('|')})" -c service_tier="${tier}" -s read-only -C ${TPL_PATH} -`;
  const tmp = tplTmp();
  const req = `${tmp}${TPL_SEG}\\.txt`;
  const out = `${tmp}${TPL_SEG}\\.(?:md|log)`;
  return [
    new RegExp(`^${call} < ${req} > ${out} 2>&1$`), // Bash
    new RegExp(`^Get-Content -Raw ${req} \\| ${call} > ${out} 2>&1$`), // PowerShell
  ];
}

// Ham komutta security rolündeki bir modelin adı geçiyorsa kalıba uymayan komut reddedilir.
function securityTemplateProblem(registry, command, only, tool) {
  const codex = (registry && registry.codex) || {};
  for (const slug of securitySlugs(registry)) {
    // Ad tek başına yetmez: komutta codex de geçmeli (grep, commit mesajı, eval çalıştırıcısı serbest).
    if (only ? slug !== only : !(command.includes(slug) && /c\W*o\W*d\W*e\W*x/i.test(command))) continue;
    const e = codex[slug];
    const cmd = command.trim();
    const [bashTpl, psTpl] = securityTemplates(slug, e);
    if (bashTpl && tool !== 'PowerShell' && bashTpl.test(cmd)) continue;
    if (psTpl && tool !== 'Bash' && psTpl.test(cmd.replace(/\\/g, '/'))) continue;
    return `model "${slug}" has the security role; it may only be called in exactly this form (one line, literal paths without spaces): ` +
      `codex exec -m ${slug} --cyber-access-program ${e.cyberAccessProgram} ${NO_MCP} -c model_reasoning_effort="<${(e.efforts || []).join('|')}>" ` +
      `-c service_tier="${e.serviceTier || 'default'}" -s read-only -C <worktree> - < <request-file.txt> > <output-file.md|.log> 2>&1` +
      ' (request and output files under the Claude temp folder: …/AppData/Local/Temp/claude/…, /tmp/claude/… or /tmp/claude-<your uid>/…, no ..)' +
      ' (PowerShell: Get-Content -Raw <request-file> | codex exec … - > <output-file> 2>&1). Any command that contains both this name and "codex" must have this form.';
  }
  return null;
}

// Kabuğun çalışırken genişletebileceği argüman (değişken, ikame, ayraç, glob, splat) ek bayrağa dönüşebilir:
// E='-c model_reasoning_effort=low'; codex exec … $E → denetlenen değerden sonra onaysız efor ya da model.
// Codex çağrısında bu yüzden reddedilir (istek stdin'den '-' ile verilir). Yönlendirme hedefleri hariç;
// '--' sonrası istem metni de genişletilebilir, o yüzden onu da kapsar.
function expandableArg(args) {
  for (let j = 0; j < args.length; j++) {
    const w = args[j];
    if (w === HEREDOC) continue;
    if (w.includes(REDIR)) { if (redirTargetIsNext(w)) j++; continue; }
    if (w === '{' || w === '}') continue; // PowerShell/bash blok ayracı, genişletme değil
    if (EXPANDABLE_RE.test(w)) return `codex argument ${w.slice(0, 40)} can be expanded by the shell into extra options (model or effort) and cannot be checked; write the arguments literally and give the request on stdin with -`;
  }
  return null;
}

// Yalnızca yardım/sürüm isteyen çağrı: alt komut ve tek bir -h/--help/-V/--version, gerçek yönlendirmeler
// hariç başka sözcük yok (codex exec "task" > --help ya da codex exec -- -h yardım değildir).
function helpOnly(args) {
  const rest = [];
  for (let j = 0; j < args.length; j++) {
    const w = args[j];
    if (w === HEREDOC) return false;
    if (w.includes(REDIR)) { if (redirTargetIsNext(w)) j++; continue; }
    rest.push(w);
  }
  return rest.length === 2 && /^(?:-h|--help|-V|--version)$/.test(rest[1]);
}

function securitySlugs(registry) {
  const codex = (registry && registry.codex) || {};
  return Object.keys(codex).filter(k => codex[k] && codex[k].status === 'approved' && codex[k].role === 'security');
}

function roleProblem(registry, inv, value) {
  const s = securityEntry(registry, value);
  if (!s) return null;
  const why = `model "${s.id}" has the security role and is approved only for the read-only security review: ` +
    `codex exec -s read-only --cyber-access-program ${s.e.cyberAccessProgram || '<program>'}`;
  if (inv === null) return `${why} (codex-rescue writes files by default)`;
  if (inv.sub === 'review') return `${why} (codex review cannot set the cyber program)`;
  // Aynı çağrıda model kaç kez yazılırsa yazılsın argümanlar bir kez taranır (karesel iş olmasın).
  const key = s.e.cyberAccessProgram || '';
  if (!inv.secCache) inv.secCache = new Map();
  if (!inv.secCache.has(key)) inv.secCache.set(key, securityArgsProblem(inv.args, s.e.cyberAccessProgram));
  const p = inv.secCache.get(key);
  return p ? `${why} (${p})` : null;
}

function check(input, registry) {
  const tool = input && input.tool_name;
  const ti = (input && input.tool_input) || {};
  const issues = [];
  if ((tool === 'Bash' || tool === 'PowerShell') && typeof ti.command === 'string') {
    if (ti.command.includes(REDIR)) return ['the command contains a U+0001 control character and cannot be checked; remove it'];
    const tp = securityTemplateProblem(registry, ti.command, null, tool);
    if (tp) return [tp];
    let invs;
    try {
      invs = invocations(ti.command, tool === 'Bash' ? 'bash' : 'ps');
    } catch (e) {
      if (e && e.tooComplex) return ['the command is too large or too deeply nested to check in time; split or flatten it'];
      if (!e || !e.tooDeep) throw e;
      return [`the command nests $( ), backticks, parentheses or shell scripts more than ${MAX_DEPTH} levels deep and cannot be checked; flatten it`];
    }
    const templateChecked = new Set();
    for (const inv of invs) {
      if (inv.kind === 'opaque') { issues.push(inv.reason); continue; }
      // Aynı model kaç kez yazılırsa yazılsın bir kez denetlenir (modeller × eforlar karesel olmasın).
      const checked = new Set();
      const effortCache = new Map();
      const efforts = inv.efforts ? [...new Set(inv.efforts)] : [];
      if (inv.kind === 'codex') { const x = expandableArg(inv.args); if (x) issues.push(x); }
      for (const v of inv.models) {
        if (checked.has(v)) continue;
        checked.add(v);
        const p = problem(registry, inv.kind, v) || (inv.kind === 'codex' ? roleProblem(registry, inv, v) || effortProblem(registry, v, efforts, '-c model_reasoning_effort="<effort>"', effortCache) : null);
        if (p) issues.push(p);
        // Ad komutta harfiyen geçmese de (tırnakla bölünmüş: gpt-x-"y"-latest) lexer'ın okuduğu değer
        // security modeliyse ham komut kalıba uymalıdır.
        const sec = inv.kind === 'codex' && securityEntry(registry, v);
        // Kalıp denetimi tüm komutu tarar: aynı slug (son ekli ya da tırnakla bölünmüş yazımları dahil) bir
        // kez denetlenir, yoksa yazım sayısı × komut uzunluğu hook'u zaman aşımına sokar.
        if (sec && !templateChecked.has(sec.id)) { templateChecked.add(sec.id); const tp = securityTemplateProblem(registry, ti.command, sec.id, tool); if (tp) issues.push(tp); }
      }
      if (inv.profile) issues.push('a Codex profile (-p/--profile) can set any model and cannot be checked; pass the approved model with -m instead');
      if (inv.kind === 'codex' && inv.models.length === 0 && !helpOnly(inv.args))
        issues.push(`codex ${inv.sub} without a model takes it from the config (or from arguments added at run time, e.g. xargs) and cannot be checked; pass the approved model with -m (exec) or -c review_model=… (review)`);
      // Model bayrağı çalışırken oluşsa da (F=-m; codex exec $F <slug>) security rolündeki modelin adı
      // çağrıda geçiyorsa sözleşme denetlenir. Bilinen yanlış alarm: istem metninde bu adı geçen başka çağrı.
      if (inv.kind === 'codex' && inv.args) {
        for (const slug of securitySlugs(registry)) {
          if (inv.models.some(v => stripSuffix(v) === slug)) continue;
          if (!inv.args.some(w => w.includes(slug))) continue;
          const p = roleProblem(registry, inv, slug);
          if (p) issues.push(p);
        }
      }
    }
  } else if (tool === 'Agent' || tool === 'Task') {
    if (typeof ti.model === 'string' && ti.model && ti.model !== 'inherit') {
      const p = problem(registry, 'claude', ti.model);
      if (p) issues.push(p);
    }
    if (typeof ti.subagent_type === 'string' && /codex-rescue$/.test(ti.subagent_type) && typeof ti.prompt === 'string') {
      // Companion son değeri kullanır ve -m'yi --model sayar: her eşleşme denetlenir. -m yalnızca
      // değeri gpt- ile başlıyorsa model sayılır (istem metnindeki git commit -m … yanlış alarm vermesin).
      // Model ve efor verilmezse companion config varsayılanlarını kullanır (efor varsayılanı onaylı
      // listelerde olmayabilir) ve denetlenemez: ikisi de açıkça yazılmalıdır.
      const efforts = [...new Set([...ti.prompt.matchAll(/(?:^|\s)--effort(?:\s+|=)("[^"]*"|'[^']*'|\S+)/g)].map(m => unquote(m[1])))];
      const effortCache = new Map();
      const models = new Set();
      for (const m of ti.prompt.matchAll(/(?:^|\s)(--model|-m)(?:\s+|=)("[^"]*"|'[^']*'|\S+)/g)) {
        const v = unquote(m[2]);
        if (m[1] === '-m' && !/^gpt-/i.test(v)) continue;
        models.add(v);
      }
      if (!models.size) issues.push('a codex-rescue request without --model uses the Codex config default model and effort, which cannot be checked; pass --model <approved slug> --effort <registry effort>');
      for (const v of models) {
        const p = problem(registry, 'codex', v) || roleProblem(registry, null, v) || effortProblem(registry, v, efforts, '--effort <effort>', effortCache);
        if (p) issues.push(p);
      }
    }
  }
  return issues;
}

function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch {}
  const input = JSON.parse(raw || '{}');
  const issues = check(input, loadRegistry());
  if (!issues.length) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `model-guard: ${[...new Set(issues)].join('; ')}.`,
    },
  }));
}

if (require.main === module) {
  try { main(); } catch (e) {
    // Hook çökerse çağrıyı durdurma; yalnızca kullanıcıyı uyar.
    process.stdout.write(JSON.stringify({ systemMessage: `model-guard: denetim yapılamadı (${String(e && e.message).slice(0, 120)}); çağrı engellenmedi.` }));
  }
} else {
  module.exports = { check, invocations, lex };
}
