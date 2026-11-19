Commit `20a6b41` içinde üç sömürülebilir güvenlik sorunu buldum.

### 1. `<<-` heredoc ayrıştırma hatası model kısıtını atlatıyor

- **Konum:** `claude/hooks/model-guard.cjs:101-103`
- **Kategori:** Güvenlik kontrolü bypass
- **Önem:** **medium**
- **Güven:** high

**Saldırı girdisi** (`<TAB>` gerçek sekme karakteridir):

```bash
cat <<-EOF
<TAB>E\
<TAB>OF
' $(codex exec -m gpt-6.1-terra -)
EOF
```

Committeki kod, `<<-` için her fiziksel satırın başındaki sekmeleri satırlar birleştirilmeden önce siliyor. Böylece `E\` ve `OF`, hatalı biçimde `EOF` sınırlayıcısına dönüşüyor ve guard heredoc’un erken bittiğini sanıyor.

Bash ise önce fiziksel satırları birleştirir, ardından yalnızca birleşmiş satırın başındaki sekmeleri siler. Gerçek sonuç `E<TAB>OF` olur; bu bir sınırlayıcı değildir ve sonraki `$(codex exec …)` çalıştırılır. Exact-commit bellek içi probunda guard bu girdi için `issues=[]` döndürdü.

**Etki:** Onaylanmamış bir model, guard’ın kapsadığını iddia ettiği tırnaksız heredoc komut ikamesi üzerinden çağrılabilir.

**Düzeltme:** Fiziksel satırları ham hâlleriyle birleştirin; `<<-` sekme temizliğini birleşmiş mantıksal satıra yalnızca bir kez uygulayın.

---

### 2. Sondaki ters eğik çizgi regex’i hook’u zaman aşımına sokarak fail-open oluyor

- **Konum:** `claude/hooks/model-guard.cjs:102`
- **İlgili zaman aşımı:** `claude/settings.fragment.json:307`
- **Kategori:** Algoritmik DoS / güvenlik kontrolü bypass
- **Önem:** **medium**
- **Güven:** high

**Saldırı girdisi:**

```text
cat <<EOF
<100000 adet "\" karakteri>a
EOF
codex exec -m gpt-6.1-terra -
```

`/\\*$/.exec(line)` ifadesi, sonunda `a` bulunan uzun bir ters-eğik-çizgi dizisinde her başlangıç konumundan tekrar deneyerek karesel çalışıyor.

Exact commit üzerinde ölçtüğüm süreler:

- 40.000 karakter: yaklaşık 823 ms
- 80.000 karakter: yaklaşık 3.592 ms
- 100.000 karakter: yaklaşık **7.519 ms**

PreToolUse hook zaman aşımı 5 saniye. Dolayısıyla 100.000 karakterlik girdi denetim tamamlanmadan hook’u zaman aşımına uğratıyor; hook fail-open olduğundan arkasındaki onaylanmamış model çağrısı engellenmiyor.

**Etki:** Saldırgan kontrollü bir Bash/PowerShell araç girdisi, model allowlist kontrolünü güvenilir biçimde devre dışı bırakabilir.

**Düzeltme:** Sondaki ters eğik çizgileri satırın sonundan başlayan doğrusal bir döngüyle sayın ve süre/bütçe aşımını çağrıyı reddeden bir sonuç hâline getirin.

---

### 3. Modelin kendi “sandbox unavailable” iddiası başarısız kontrolü ölçülmemişe çeviriyor

- **Konum:** `claude/models/eval/run.cjs:487-493`
- **Kategori:** Değerlendirme bütünlüğü / fail-open sınıflandırma
- **Önem:** **medium**
- **Güven:** high

**Saldırı/failing input:**

- Model hiçbir dosyayı değiştirmez.
- Görevin kontrolü özgün hatalı kod üzerinde başarısız olur veya zaman aşımına uğrar.
- Model cevabına şu metni ekler:

```text
The Windows sandbox backend is unavailable.
```

`checkFailed` doğru olsa bile `changed.length === 0` koşulu dalı geçiriyor. Sonuç `pass:false` yerine:

```json
{
  "pass": null,
  "environmentError": "Codex sandbox could not start..."
}
```

oluyor. Burada sandbox arızası runner tarafından gözlemlenmiyor; yalnızca değerlendirilmekte olan modelin kontrol ettiği cevap metninden çıkarılıyor.

**Etki:** Bir aday model, başarısız düzeltme görevlerini ölçülmüş başarısızlık olmaktan çıkarabilir ve seçici yeniden deneme/sonuç yanlılığı oluşturabilir. Bu doğrudan `pass:true` üretmez, ancak model kaydı kararında kullanılan negatif kanıtı bastırır.

**Düzeltme:** Sandbox arızasını yalnızca süreç/probe tarafından üretilen yapılandırılmış hata kanıtından kabul edin. Modelin cevap metni, başarısız veya zaman aşımına uğramış bir kontrolü hiçbir durumda geçersiz kılmamalıdır.

### Kapsam

- **Reviewed:** `git show 20a6b41`, exact-commit kaynakları, ilgili testler, hook yapılandırması ve minimal çevre kodu.
- **Not reviewed:** Diğer commitlerdeki değişiklikler ve canlı model/API çalıştırmaları.
- **Verification:** Exact-commit modülü bellekte çalıştırılarak heredoc bypass’ı ve zaman karmaşıklığı tekrarlandı.
- **Workspace:** Hiçbir dosya oluşturulmadı, değiştirilmedi veya silinmedi; `git status --short` temiz kaldı.