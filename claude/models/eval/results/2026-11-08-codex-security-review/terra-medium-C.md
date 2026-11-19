**1 bulgu — Orta:** Sandbox hatası iddiası, başarısız kontrolü hâlâ “ölçülmedi” durumuna çevirebiliyor.

[claude/models/eval/run.cjs:483](/<workdir>/claude/models/eval/run.cjs:483) yalnızca model çalışmasının `timedOut` alanını ve `checkSkipped` durumunu kontrol ediyor. Model, düzeltilmesi gereken kodda kontrol komutunu sonsuz döngüye sokup son mesajına `sandbox backend is unavailable` yazabilir. Kontrol zaman aşımına uğradığında `checkTimedOut = true` ve `checkPassed = false` atanmasına rağmen bu koşul eşleşir ve sonuç `pass: null` olur. Aynı durum zaman aşımı dışındaki başarısız kontroller için de geçerlidir.

**Etki:** Adayın gerçek değerlendirme başarısızlığı ortam hatası olarak sınıflandırılır; başarısızlığı gizleyerek yeniden değerlendirme veya aday seçimi kararını yanıltabilir. Bulgu kaynak kodu ve commit farkına dayanıyor; güven düzeyi yüksek.

**Öneri:** Sandbox iddiasını kabul etmeden önce başarısız kontrolü ve kontrol zaman aşımını da dışlayın. Başarısız kontrol ve zaman aşımı senaryolarında iddianın `pass: false` sonucunu değiştirmediğini doğrulayın.

İnceleme `56e9a1f` commit’i ve ilgili çevre koduyla sınırlıydı. `git show` ve kaynak okuması kullanıldı; dosya oluşturan veya değiştiren testler çalıştırılmadı.