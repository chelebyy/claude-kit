# claude-kit

Claude Code (ve isteğe bağlı Codex) için ortak kurallar, inceleme ajanları, güvenlik hook'ları ve model kaydı. Windows, Linux ve macOS'ta tek bir kurulum programıyla kurulur. Gizli bilgi içermez.

## Kurulum

Gerekenler: [Node.js](https://nodejs.org) 22 veya üstü, `git` ve [Claude Code](https://claude.com/claude-code) 2.1.324 veya üstü.

```sh
git clone https://github.com/chelebyy/claude-kit.git
cd claude-kit
node install.mjs
```

Program birkaç soru sorar, yapacağı her şeyi önce plan olarak gösterir ve sen onaylamadan hiçbir şeyi değiştirmez. Değiştirdiği her dosyanın yanına `.bak-<tarih>` yedeği bırakır.

Kurulumu bir LLM'e yaptırmak istersen [PROMPT.md](./PROMPT.md) içindeki istemi Claude Code'a yapıştır. Soruları sana sorar, programı cevaplarınla çalıştırır.

Kurulumdan sonra Claude Code'u yeniden başlat ve denetle:

```sh
node install.mjs doctor
```

Güncellemek için: `git pull`, sonra yine `node install.mjs`. Program önceki cevaplarını hatırlar, yalnızca değişeni uygular.

Hook'lar Node'un mutlak yoluyla kaydedilir. Node'u başka bir yere taşır ya da sürüm yöneticisiyle (nvm, Homebrew) eski sürümü silersen `node install.mjs`'i yeniden çalıştır. O zamana kadar model-guard araç çağrılarını engeller (bilerek: denetimsiz geçirmektense durdurur); `doctor` da bunu hata olarak gösterir.

## Ne kurulur

**Herkese:**

- Kurallar: `~/.claude/CLAUDE.md`, `~/.claude/rules/context7.md` ve kurulum profili `~/.claude/rules/claude-kit-profile.md`.
- Hook'lar:
  - `model-guard`: kayıtta onaylı olmayan model ya da efor kullanan çağrıları engeller.
  - `model-watch`: kayıtta olmayan yeni Codex modellerini bildirir.
  - `auto-plugins`: projeye göre, yalnızca makinende kurulu olan plugin ve skill'leri açar.
- Model kaydı: `~/.claude/models/registry.json`.
- Ajanlar: `reviewer-*` (teslim öncesi inceleme), `advisor-*` (Fable danışman), `worker-*`.
- Skill'ler: `local-code-review`, `local-security-review`, `postgres-schema` (PostgreSQL ve Supabase şema, migration ve RLS işleri), `find-skills`.
- Plugin'ler: `commit-commands`, `claude-md-management`.

**Codex varsa ayrıca:**

- `~/.codex/AGENTS.md`.
- `codex@openai-codex` plugin'i.
- `security-review-gate` skill'i ve okuduğu dosyalar.
- `postgres-schema` skill'inin Codex kopyası (`~/.agents/skills/postgres-schema`).
- `service_tier` denetimi (`~/.codex/config.toml`).

**Sorulanlar:**

- Daybreak erişimi var mı?
- Auto mod, Fable danışmanı, takım modu, dil ve arayüz tercihleri uygulansın mı?
- İsteğe bağlı MCP sunucuları: Context7, Exa, Figma (yalnızca uzak sunucular). Anahtar isteyenleri program kurmaz, sana kendi terminalinde çalıştıracağın komutu gösterir. Yerel komutla çalışan MCP'leri (ör. Lemma, Serena) program kurmaz; istersen kendin eklersin.

**Kurulmayanlar:** diğer bütün skill ve plugin'ler. Herkes ihtiyacı olanı kendisi kurar. `auto-plugins` projeye uyanlardan yalnızca kurulu olanları açar; `doctor` projeye göre açılabilecek ama kurulu olmayanları yalnızca bilgi olarak gösterir.

Program makinende kit dışından olan hiçbir skill, plugin, hook ya da ayarı silmez. Tek istisna, eski kurulumun eklediği onaysız `npx skills` izinleridir (`Bash(npx skills add <kaynak>/*)`, `Bash(npx skills add *)`, `Bash(npx skills find *)`): `npx` önce projenin `node_modules/.bin` klasörüne baktığı için kötü niyetli bir projedeki sahte bir `skills` programı bu izinlerle onaysız çalışabilirdi. Program bu girdileri kaldırır ve plan bunu ayrıca gösterir; skill kurulumu artık onaydan geçer.

## Bilinen sınırlar

- Makinede zaten kurulu olan bir plugin ya da skill (ör. `find-skills`, `codex@openai-codex`) adıyla tanınır; nereden kurulduğu doğrulanmaz. Daha önce aynı adla başka bir kaynaktan kurduysan kaldırıp programı yeniden çalıştır.
- `settings.json` yazılırken başka bir Claude oturumu aynı anda yazarsa, çok dar bir aralıkta o değişiklik kaybolabilir. Program yazmadan önce dosyayı yeniden okur, değişmişse birleştirmeyi tekrarlar; dosya kilidi kullanmaz.
- `config.toml` için tam bir TOML ayrıştırıcısı yok. Program dosyayı anlayamazsa `service_tier` satırını düzeltmez ve bunu sana bırakır.
- `CLAUDE_CONFIG_DIR` ya da `CODEX_HOME` varsayılandan farklı bir dizini gösteriyorsa program kurmaz.
- Hook komutuna yazılan Node ve ev dizini yolları kabukta genişleyen karakterler (`$`, ters tırnak, `%`, `!`, `"`) içeriyorsa program kurmaz.
- Claude Code'un deneysel [Code Mode](https://code.claude.com/docs/en/code-mode)'unda model, araç çağrılarını JavaScript koduyla yapar ve komutu çalışırken (ör. bir dosyadan) üretebilir; auto mod sınıflandırıcısı yalnızca kodu görür. `model-guard` koddan yapılan `Bash`/`PowerShell` çağrılarını yine görür ve kit onu `"onFailure": "block"` ile kurar (hook çalışamazsa çağrı engellenir). Koddan başlatılan alt ajanların hook'tan geçip geçmediği belgede yazmaz. Güvenmediğin bir repoda Code Mode'u kapat: macOS/Linux/WSL'de `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=0 claude`, PowerShell'de `$env:CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = "0"; claude` (o PowerShell penceresi kapanana kadar kapalı kalır). Ayrıntı: `claude/models/README.md` ("Engelin kapsamı").

## Codex ve Daybreak olmadan

Kurallar her makinede aynıdır. Profil yalnızca incelemelerin hangi yoldan yapılacağını belirler:

| Makine | Genel inceleme | Güvenlik incelemesi |
| --- | --- | --- |
| Codex + Daybreak | Codex | Daybreak (`security-review-gate`) |
| Codex var, Daybreak yok | Codex | Astra + `security-review-gate`, ayrıca Claude güvenlik reviewer'ı |
| Codex yok | Claude reviewer | Claude güvenlik reviewer'ı; teslimden önce bağımsız aile incelemesi yapılamadığı söylenir |

## Depo yapısı

- `install.mjs`, `installer/`: kurulum programı ve testleri (`node --test installer/test/`).
- Testler: CI (Windows, Linux, macOS; Node 22, 24, 26) kurulum programını ve hook'ları dener. Değerlendirme çalıştırıcısının testleri (`node --test claude/models/eval/run.test.cjs`) ağ iznini (`--allow-net`) tanıyan bir Node ister, bu yüzden CI'da Node 26 ile çalışır; gerçek `codex sandbox` isteyen üç testi Codex CLI yoksa atlanır.
- `claude/`: Claude Code'a kurulan kurallar, hook'lar, ajanlar, skill'ler ve model kaydı (`claude/models/README.md`: kayıt ve değerlendirme süreci).
- `codex/AGENTS.md`: Codex kuralları.
- `agents/skills/`: Codex güvenlik incelemesi skill'i (kaynağı ve lisansı `agents/skills/README.md`).
