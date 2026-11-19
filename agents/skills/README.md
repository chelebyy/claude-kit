# Codex güvenlik incelemesi skill'i

Bu klasördeki dosyalar [alicankiraz1/Codex-Sentinel](https://github.com/alicankiraz1/Codex-Sentinel) deposundan, `756322a51446b16d52b2b2ac5fed455f5ba9d876` commit'inden değiştirilmeden alındı (MIT, bkz. `LICENSE-codex-sentinel`).

- `security-review-gate/`: CLAUDE.md'deki Codex güvenlik incelemesinin kullandığı skill.
- `codex-sentinel/references/` ve `shared/`: bu skill'in `../` yoluyla okuduğu dosyalar. `codex-sentinel` skill'inin kendisi (`SKILL.md`) pakette yok; yalnızca başvuru dosyaları var.

Skill `skills` CLI ile değil kurulum programıyla bu klasörden kopyalanır. Upstream'i güncellemek bir güvenlik incelemesi kararıdır: yeni commit'i inceleyip bu klasörü ve yukarıdaki commit kimliğini birlikte güncelle.

## Bilinen sınırlar

- `codex-sentinel/references/active-analysis.md` bir geçişi 8 dosya, dosya başına 300 satır ve toplam 2000 satırla sınırlar; kalanı "incelenmedi" diye işaretler. Zorunlu incelemede bu sınır geçerli değildir: `claude/CLAUDE.md` isteğe "her dosyayı ve hunk'ı incele, eksik kalırsa `INCOMPLETE` yaz" ekletir. İstek bu cümleyi taşımıyorsa inceleme kapsamı daralmış sayılır.
- Skill'in akışı onay soran, tavsiye niteliğinde bir akıştır; zorunlu incelemede istek bunu da ezer.
- Bu kopya geçicidir: skill'in kendi tehdit modelimize göre yazılmış bir skill'le değiştirilmesi ayrı bir iştir.
