**Bir güvenlik bulgusu var — orta önem.**

[claude/hooks/model-guard.cjs:53](/<workdir>/claude/hooks/model-guard.cjs:53) — İki lexer geçişi birlikte atlatılabiliyor. Örneğin Bash komutunda:

```bash
# Don't
echo ${x:- #}; codex exec -m unapproved-model -
```

Yorumları atlayan geçiş, `${x:- #}` içindeki `#` karakterini yanlışlıkla yorum başlangıcı sayıp satırın kalanını atlıyor. Yorumları atlamayan geçiş ise ilk satırdaki apostrofu açılan tırnak sayıp sonraki komutu gizliyor. Sonuçta `codex exec` iki geçişte de görülmüyor ve onaysız model çağrısı engellenmiyor.

**Etki:** Model kayıt kontrolü fail-open davranıyor; komutu hazırlayan kişi onaysız bir modeli kullanabilir. `a69afe6` commit’indeki kod bellek içinde çalıştırıldığında bu girdi için `check()` boş sorun listesi döndürdü. Kanıt kaynağı: commit diff’i ve ilgili kod. Güven: yüksek.

İnceleme yalnızca belirtilen commit ve gerekli kod bağlamıyla sınırlandı; dosya oluşturulmadı veya değiştirilmedi.