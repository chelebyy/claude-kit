# Kurulumu Claude Code'a yaptırmak

Yeni makinede bir terminal açıp `claude` çalıştır ve aşağıdaki metni olduğu gibi yapıştır:

```
claude-kit'i kur. Adımlar:

1. `git clone https://github.com/chelebyy/claude-kit.git ~/claude-kit` ile depoyu klonla
   (zaten varsa `git -C ~/claude-kit pull --ff-only`). Klonladığın kopyadaki README.md'yi oku.
2. Bana şu soruları tek tek sor, cevaplarımı tahmin etme:
   - Codex (OpenAI) aboneliğin var mı? Varsa: Daybreak (cyber erişim programı daybreak_blue) var mı?
   - Auto mod açılsın mı? Açılacaksa ve settings.json'da autoMode.environment yoksa,
     kit sahibinin yığın tanımı eklensin mi (mine) yoksa dokunulmasın mı (keep)?
   - Fable danışman, takım modu ve arayüz tercihleri (tema auto, tam ekran, latest kanalı) açılsın mı?
   - Yanıt dili ne olsun (ör. Turkish, English ya da keep)?
   - Hangi MCP sunucuları eklensin: context7, exa, figma (ya da none)?
3. `node ~/claude-kit/install.mjs --no-tui` komutunu cevaplarımın bayraklarıyla çalıştır
   (bayrak listesi: `node ~/claude-kit/install.mjs --help`). Program eksik bir bayrak isterse
   (ör. --on-conflict, --install-codex-cli, --fix-codex-tier) bunu da bana sor.
   Bu ilk çalıştırma yalnızca plan gösterir. Planı bana göster ve onayımı bekle.
4. Onaylarsam aynı komutu `--yes` ile çalıştır.
5. `node ~/claude-kit/install.mjs doctor` çalıştır ve sonucu göster.

Kurallar:
- API anahtarlarını benden isteme ve hiçbir komuta yazma. Anahtar isteyen MCP'ler için program
  bir komut gösterir; onu bana ver, kendi terminalimde çalıştırırım.
- `codex login`, `gh auth login` gibi etkileşimli adımları bana bırak.
- Programın dışında dosya düzenleme, ayar birleştirme ya da kurulum yapma; planda olmayan bir şey
  gerekirse önce bana sor.

Sonunda kurulanları, atlananları, başarısız olanları ve benim yapmam gerekenleri tablo halinde raporla.
```

Kurulum bittikten sonra Claude Code'u yeniden başlat. Codex kurduysan Claude içinde `/codex:setup` çalıştır; review gate'i açmayı teklif ederse **hayır** de.
