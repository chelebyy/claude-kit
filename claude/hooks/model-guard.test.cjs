'use strict';
// Çalıştırma: node --test claude/hooks/model-guard.test.cjs
// Komutlar, kurallarda (CLAUDE.md, AGENTS.md) gerçekten kullanılan çağrı biçimlerinden alındı.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { check } = require('./model-guard.cjs');

const REGISTRY_FILE = path.join(__dirname, '..', 'models', 'registry.json');
const registry = require(REGISTRY_FILE);
const bash = command => ({ tool_name: 'Bash', tool_input: { command } });
const ps = command => ({ tool_name: 'PowerShell', tool_input: { command } });
const agent = tool_input => ({ tool_name: 'Agent', tool_input });
// pwsh -EncodedCommand girdisi: UTF-16LE metnin base64 hali.
const ENC = Buffer.from('codex exec -m gpt-0-unapproved -', 'utf16le').toString('base64');
const allowed = input => assert.deepStrictEqual(check(input, registry), []);
const denied = (input, re) => {
  const issues = check(input, registry);
  assert.ok(issues.length > 0, 'engellenmeliydi');
  if (re) assert.match(issues.join(' '), re);
};

test('kurallardaki onaylı Codex çağrıları geçer', () => {
  allowed(bash('codex exec -m gpt-6-astra -c model_reasoning_effort="high" -c service_tier="default" -s read-only --skip-git-repo-check -'));
  allowed(bash('codex review --uncommitted -c review_model="gpt-6-astra" -c model_reasoning_effort="high" -c service_tier="default" -c sandbox_mode="read-only"'));
  allowed(bash('codex exec -m gpt-6.1-sol -c model_reasoning_effort="xhigh" -c service_tier="fast" -s workspace-write -C ../wt -'));
  allowed(ps('& codex exec --model gpt-6-astra -c model_reasoning_effort=high -s read-only -'));
  // CLAUDE.md'deki Codex güvenlik incelemesi komutu, gerçek kayıtla.
  allowed(bash('codex exec -m gpt-daybreak-blue-latest --cyber-access-program daybreak_blue --ignore-user-config --ignore-rules --disable apps --disable plugins -c windows.sandbox="unelevated" -c model_reasoning_effort="high" -c service_tier="default" -s read-only -C C:/All_Project/wt - < C:/Users/u/AppData/Local/Temp/claude/s/req.txt > C:/Users/u/AppData/Local/Temp/claude/s/out.md 2>&1'));
  allowed(ps('Get-Content -Raw C:/Users/u/AppData/Local/Temp/claude/s/req.txt | codex exec -m gpt-daybreak-blue-latest --cyber-access-program daybreak_blue --ignore-user-config --ignore-rules --disable apps --disable plugins -c windows.sandbox="unelevated" -c model_reasoning_effort="xhigh" -c service_tier="default" -s read-only -C C:/All_Project/wt - > C:/Users/u/AppData/Local/Temp/claude/s/out.md 2>&1'));
  // Kalıp dışı: yönlendirmesiz, değişkenli yol, kayıtta olmayan efor.
  denied(bash('codex exec -m gpt-daybreak-blue-latest --cyber-access-program daybreak_blue --ignore-user-config --ignore-rules --disable apps --disable plugins -c windows.sandbox="unelevated" -c model_reasoning_effort="high" -c service_tier="default" -s read-only -C ../wt -'), /security role/);
  denied(bash('codex exec -m gpt-daybreak-blue-latest --cyber-access-program daybreak_blue --ignore-user-config --ignore-rules --disable apps --disable plugins -c windows.sandbox="unelevated" -c model_reasoning_effort="high" -c service_tier="default" -s read-only -C C:/w - < $S/req.txt > $S/out.md 2>&1'), /security role/);
  denied(bash('codex exec -m gpt-daybreak-blue-latest --cyber-access-program daybreak_blue --ignore-user-config --ignore-rules --disable apps --disable plugins -c windows.sandbox="unelevated" -c model_reasoning_effort="low" -c service_tier="default" -s read-only -C C:/w - < C:/r.txt > C:/o.md 2>&1'), /security role/);
});

test('onaysız ya da kayıtta olmayan Codex modeli engellenir', () => {
  denied(bash('codex exec -m gpt-0-unapproved -s read-only -'), /gpt-0-unapproved.*not approved/);
  denied(bash('codex exec -m gpt-6-sol -'), /gpt-6-sol/);
  denied(bash('codex exec --model=gpt-7-astra -'), /gpt-7-astra/);
  denied(bash('codex review --uncommitted -c review_model="gpt-0-unapproved-review"'), /unapproved-review/);
  denied(bash("codex exec -c 'model=\"gpt-0-unapproved\"' -"), /unapproved/);
  denied(bash('C:/Users/x/AppData/Roaming/npm/codex.cmd exec -m gpt-0-unapproved -'), /unapproved/);
});

test('bitişik -c model değeri denetlenir', () => {
  denied(bash('codex exec -c=model=gpt-0-unapproved -'), /gpt-0-unapproved/);
  denied(bash('codex review -c=review_model=gpt-0-unapproved --uncommitted'), /gpt-0-unapproved/);
  denied(bash('codex exec -cmodel=gpt-0-unapproved -'), /gpt-0-unapproved/);
  denied(bash('codex review -creview_model="gpt-0-unapproved" --uncommitted'), /gpt-0-unapproved/);
  allowed(bash('codex exec -cmodel_reasoning_effort=high -m gpt-6-astra -'));
});

test('uzun köşeli parantez dizisi denetimi zaman aşımına sokmaz', () => {
  const t0 = Date.now();
  denied(bash('codex exec -m gpt-0-x' + '['.repeat(200000) + ' -'));
  assert.ok(Date.now() - t0 < 1000, 'denetim 1 sn altında bitmeli');
});

test('& içeren yönlendirmeden sonraki argümanlar da denetlenir', () => {
  denied(bash('codex exec -m gpt-0-unapproved>out -'), /gpt-0-unapproved/);
  denied(bash('codex exec -m gpt-6-astra - \u0001'), /U\+0001/);
  // Tırnaklı ya da kaçışlı '>' sonrası & ayırıcıdır: ikinci komut da denetlenir.
  denied(bash('codex --version "x>"& codex exec -m gpt-0-unapproved -'), /gpt-0-unapproved/);
  denied(bash('codex --version x\\>& codex exec -m gpt-0-unapproved -'), /gpt-0-unapproved/);
  denied(bash('codex exec -m gpt-6-astra -- "x>"& codex exec -m gpt-0-unapproved -'), /gpt-0-unapproved/);
  denied(bash('true "x>"&codex exec -m gpt-0-unapproved -'), /gpt-0-unapproved/);
  denied(bash('git log --format=">"&codex exec -m gpt-0-unapproved -'), /gpt-0-unapproved/);
  denied(bash('cmd /c "echo x^>&codex exec -m gpt-0-unapproved -"'), /gpt-0-unapproved/);
  denied(ps('Write-Output "a>"&codex exec -m gpt-0-unapproved -'), /gpt-0-unapproved/);
  // Alt komuttan önceki yönlendirme alt komut sayılmaz.
  denied(bash('codex >log exec -m gpt-0-unapproved -'), /gpt-0-unapproved/);
  denied(bash('codex 2>&1 exec -m gpt-0-unapproved -'), /gpt-0-unapproved/);
  allowed(ps('if ($x) { codex exec -m gpt-6-astra -c model_reasoning_effort=high - }'));
  allowed(bash('echo a & codex exec -m gpt-6-astra -c model_reasoning_effort=high - &> log'));
  denied(bash('codex exec 2>&1 -m gpt-0-unapproved -'), /gpt-0-unapproved/);
  denied(bash('codex exec >&2 -m gpt-0-unapproved -'), /gpt-0-unapproved/);
  denied(bash('codex exec &>log -m gpt-0-unapproved -'), /gpt-0-unapproved/);
  denied(ps('& codex exec 2>&1 -m gpt-0-unapproved -'), /gpt-0-unapproved/);
  allowed(bash('codex exec -m gpt-6-astra -c model_reasoning_effort=high - 2>&1 | tail -5'));
  allowed(bash('codex exec -m gpt-6-astra -c model_reasoning_effort=high - > log 2>&1 & codex exec -m gpt-6.1-terra -c model_reasoning_effort=medium -'));
  denied(bash('codex exec -m gpt-6-astra - > log 2>&1 & codex exec -m gpt-0-unapproved -'), /gpt-0-unapproved/);
});

test('değişkenle verilen model engellenir', () => {
  denied(bash('codex exec -m "$MODEL" -'), /not a literal/);
  denied(ps('codex exec -m $env:M -'), /not a literal/);
});

test('modelsiz codex exec/review engellenir; codex dışı komutlar geçer', () => {
  denied(bash('codex exec -s read-only -'), /without a model/);
  denied(bash('codex review --uncommitted'), /without a model/);
  denied(bash('xargs codex exec < C:/tmp/args.txt'), /without a model/);
  denied(bash('CODEX_HOME=C:/tmp/h codex exec --cyber-access-program daybreak_blue -s danger-full-access edit'), /without a model/);
  allowed(bash('codex exec --help'));
  allowed(bash('codex --version'));
  allowed(bash('codex debug models'));
  allowed(bash('codex sandbox -P :workspace -C dir node -e 1'));
  allowed(bash('ls -m'));
});

test('tırnak içindeki metin komut sayılmaz (commit, PR, echo)', () => {
  allowed(bash('git commit -m "docs: use codex exec -m gpt-6-astra -c model_reasoning_effort=high"'));
  allowed(bash('git commit -m "use codex exec -m gpt-0-unapproved"'));
  allowed(bash('echo "Örnek: codex review -c review_model=gpt-0-unapproved"'));
  allowed(bash('gh pr create --title x --body "Denies codex exec -m gpt-0-x calls; see README"'));
  allowed(bash("rg 'codex exec -m' claude/CLAUDE.md"));
  allowed(ps('Write-Output "x@"\ncodex exec -m gpt-6-astra -c model_reasoning_effort=high -'));
  allowed(bash('echo "use <<EOF here"\ncodex exec -m gpt-6-astra -c model_reasoning_effort=high -'));
});

test('tırnak içindeki ayırıcı çağrıyı bölmez', () => {
  denied(bash('claude -p "a; b" --model claude-opus-6-0'), /claude-opus-6-0/);
});

test('tırnaklı codex yolu ve alt komuttan önceki bayraklar denetlenir', () => {
  denied(ps('& "C:/Users/x/AppData/Roaming/npm/codex.cmd" exec -m gpt-0-unapproved -'), /unapproved/);
  denied(ps('& "C:\\Program Files\\nodejs\\codex.cmd" exec -m gpt-0-unapproved -'), /unapproved/);
  denied(bash('codex -c model="gpt-0-unapproved" exec -'), /unapproved/);
  denied(bash('codex -m gpt-0-unapproved exec -'), /unapproved/);
  denied(bash('codex exec -mgpt-0-unapproved -'), /unapproved/);
  allowed(bash('codex -c service_tier="fast" exec -m gpt-6-astra -c model_reasoning_effort=high -'));
});

test('komut ikamesi içindeki çağrı denetlenir', () => {
  denied(bash('out="$(codex exec -m gpt-0-unapproved -)"'), /unapproved/);
  denied(bash('out=$(codex exec -m gpt-0-unapproved -)'), /unapproved/);
  denied(bash('echo "`codex exec -m gpt-0-unapproved -`"'), /unapproved/);
  denied(ps('$r = $(codex exec -m gpt-0-unapproved -)'), /unapproved/);
  allowed(bash('out="$(codex exec -m gpt-6-astra -c model_reasoning_effort=high -)"'));
});

test('Claude Code commit kalıbı: heredoc gövdesi komut sayılmaz, sonraki satır denetlenir', () => {
  const commit = body => `git commit -m "$(cat <<'EOF'\n${body}\nEOF\n)"`;
  allowed(bash(commit('Block codex exec -m gpt-0-unapproved calls')));
  allowed(bash(commit('says "hi')));
  denied(bash(commit('says "hi') + '\ncodex exec -m gpt-0-unapproved -'), /unapproved/);
  allowed(bash(commit('Mentions codex exec -m gpt-0-unapproved') + '\ncodex exec -m gpt-6-astra -c model_reasoning_effort=high -'));
});

test('iç içe kabuk betikleri denetlenir', () => {
  denied(bash('bash -c "cd x; codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(bash("sh -c 'codex exec -m gpt-0-unapproved -'"), /unapproved/);
  denied(ps('pwsh -NoProfile -Command "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(ps('cmd /c codex exec -m gpt-0-unapproved -'), /unapproved/);
  allowed(bash('bash -c "codex exec -m gpt-6-astra -c model_reasoning_effort=high -"'));
});

test('tırnaksız PowerShell -Command betiğinin tamamı denetlenir', () => {
  denied(ps('pwsh -NoProfile -Command codex exec -m gpt-0-unapproved -'), /unapproved/);
  denied(ps('powershell -c codex exec -m gpt-0-unapproved -'), /unapproved/);
  denied(ps('powershell.exe -NoProfile -Command codex exec -m gpt-0-unapproved -'), /unapproved/);
});

test('betik bayrağı olmayan ya da birleşik bayraklı kabuklar da taranır', () => {
  denied(bash('cmd //c codex exec -m gpt-0-unapproved -'), /unapproved/);
  denied(bash('bash -lc "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(bash('sh -ec "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(bash('sudo sh codex exec -m gpt-0-unapproved -'), /unapproved/);
});

test('iç içe sınırı aşılan komut denetlenemediği için engellenir (fail-closed)', () => {
  const deep = /levels deep/;
  denied(bash('('.repeat(40) + 'codex exec -m gpt-0-unapproved -' + ')'.repeat(40)), deep);
  denied(bash('$('.repeat(40) + 'codex exec -m gpt-0-unapproved -' + ')'.repeat(40)), deep);
  denied(bash('"$('.repeat(40) + 'codex exec -m gpt-0-unapproved -' + ')"'.repeat(40)), deep);
  denied(bash('"$('.repeat(33) + 'echo x' + ')"'.repeat(33) + '; codex exec -m gpt-6-astra -'), deep);
  denied(bash('cmd /c '.repeat(34) + 'codex exec -m gpt-0-unapproved -'), deep);
  // Sınırın altında normal denetim sürer.
  denied(bash('"$('.repeat(5) + 'codex exec -m gpt-0-unapproved -' + ')"'.repeat(5)), /unapproved/);
  allowed(bash('"$('.repeat(5) + 'codex exec -m gpt-6-astra -c model_reasoning_effort=high -' + ')"'.repeat(5)));
});

test('PowerShell betik bayrağının tüm yazımları ve kodlanmış betik', () => {
  denied(ps('pwsh /Command codex exec -m gpt-0-unapproved -'), /unapproved/);
  denied(ps('pwsh /Command "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(ps('pwsh --Command "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(ps('powershell -NoProfile -EncodedCommand ' + ENC), /encoded/);
  denied(ps('pwsh -ec ' + ENC), /encoded/);
  allowed(ps('pwsh -NoProfile -Command "Get-ChildItem"'));
});

test('kabuk adı argüman olarak geçerse kabuk sayılmaz (arama ve listeleme komutları)', () => {
  allowed(bash('rg -n -e pwsh -e powershell claude/'));
  allowed(bash('grep -rn -e pwsh -e PowerShell .'));
  allowed(bash('git grep -n pwsh -e foo'));
  allowed(bash('ls ~/bin/powershell -e'));
  allowed(ps('where.exe pwsh /e'));
  allowed(ps('pwsh -NoProfile -File build.ps1 -e prod'));
  allowed(ps('pwsh -c Get-Content x -Enc utf8'));
  allowed(bash('bash -e script.sh'));
});

test('betik bayrağı yerindeyse asıl sorun raporlanır', () => {
  denied(ps('pwsh -c "codex exec -m gpt-0-unapproved -" -e x'), /unapproved/);
  denied(bash('RUST_LOG=debug timeout 60 bash -c "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(bash('sudo pwsh -ec ' + ENC), /encoded/);
});

test('kısa -e bilerek denetlenmez (kapsam kararı: grep/rg -e ile çakışır, README)', () => {
  allowed(ps('pwsh -e ' + ENC));
  allowed(bash('rg -e powershell -e pwsh -e "pwsh -e" claude/'));
  allowed(bash('git grep -e pwsh -e "use the encoded cmd"'));
});

test('kabuk koşul, döngü ve blok içinde de taranır', () => {
  denied(bash('if sh -c "codex exec -m gpt-0-unapproved -"; then :; fi'), /unapproved/);
  denied(bash('for f in a; do sh -c "codex exec -m gpt-0-unapproved -"; done'), /unapproved/);
  denied(bash('{ bash -c "codex exec -m gpt-0-unapproved -"; }'), /unapproved/);
  denied(bash('! bash -c "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(ps('if ($true) { pwsh -c "codex exec -m gpt-0-unapproved -" }'), /unapproved/);
  denied(ps('foreach ($x in 1) { pwsh -Command "codex exec -m gpt-0-unapproved -" }'), /unapproved/);
  denied(ps('if ($true) { pwsh -ec ' + ENC + ' }'), /encoded/);
});

test('sarmalayıcıların değer alan seçeneklerinden sonra da taranır', () => {
  denied(bash('sudo -u root sh -c "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(bash('env -u FOO bash -c "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(bash('xargs -I {} sh -c "codex exec -m gpt-0-unapproved {}"'), /unapproved/);
  denied(bash('git ls-files | xargs -P 4 -I % sh -c "codex exec -m gpt-0-unapproved %"'), /unapproved/);
  denied(bash('timeout --signal KILL 60 bash -c "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(bash('find . -exec sh -c "codex exec -m gpt-0-unapproved {}" \\;'), /unapproved/);
  denied(bash('sudo -u root pwsh -ec ' + ENC), /encoded/);
  denied(ps('start /b cmd /c "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(ps('start "" cmd /c "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(ps("cmd /c 'start /b cmd /c \"codex exec -m gpt-0-unapproved -\"'"), /unapproved/);
});

test('bash seçeneklerinin değerleri betik sanılmaz', () => {
  denied(bash('bash -o pipefail -c "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(bash('bash -euo pipefail -c "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(bash('bash -O extglob -c "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(bash('bash --rcfile x -c "codex exec -m gpt-0-unapproved -"'), /unapproved/);
});

test('Windows PowerShell konumsal komutu denetlenir', () => {
  denied(ps('powershell "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(ps('powershell -NoProfile "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  allowed(ps('powershell -NoProfile -File build.ps1 "codex exec -m gpt-0-unapproved -"'));
});

test('açık yazılmış kodlanmış betik bayrağı değerden bağımsız engellenir', () => {
  denied(ps('pwsh -NoProfile -EncodedCommand (Get-Content enc.txt -Raw)'), /encoded/);
  denied(ps('pwsh -enc $b64'), /encoded/);
  allowed(ps('where.exe pwsh /e'));
});

test('Windows PowerShell konumsal komutu bayraklarıyla birlikte denetlenir', () => {
  denied(ps('powershell codex exec -m gpt-0-unapproved -'), /unapproved/);
  denied(ps('powershell -NoProfile -WindowStyle Hidden codex exec -m gpt-0-unapproved -'), /unapproved/);
  denied(ps('powershell -ExecutionPolicy Bypass codex exec --model gpt-0-unapproved -'), /unapproved/);
  allowed(bash('rg -n powershell "codex exec -m gpt-0-unapproved" docs/'));
  allowed(ps('powershell -ExecutionPolicy Bypass .\\build.ps1'));
  denied(ps('powershell "codex exec -m gpt-0-unapproved -" -File x.ps1'), /unapproved/);
  denied(ps('Start-Process powershell -ArgumentList "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(ps('Start-Process powershell "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(ps('$p = Start-Process powershell -ArgumentList "codex exec -m gpt-0-unapproved -" -PassThru'), /unapproved/);
  denied(bash('nohup powershell "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(bash('sudo powershell "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  allowed(ps('powershell -ExecutionPolicy Bypass -File build.ps1 "codex exec -m gpt-0-unapproved -"'));
  allowed(bash('grep -e pwsh -e "use the encoded cmd"'));
});

test('cmd /c öndeki sözcüklerden bağımsız bulunur', () => {
  denied(bash('cmd x.bat //c "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(ps('cmd x /c "codex exec -m gpt-0-unapproved -"'), /unapproved/);
});

test('betik dosyasıyla çağrılan sh sonrasındaki sh -c de işlenir', () => {
  denied(bash('find . -exec sh ./a.sh {} + -exec sh -c "codex exec -m gpt-0-unapproved -" +'), /unapproved/);
});

test('PowerShell dizi argümanları ayrı sözcüklerdir', () => {
  denied(ps("Start-Process powershell -ArgumentList '-NoProfile','-Command','codex exec -m gpt-0-unapproved -'"), /unapproved/);
  denied(ps('Start-Process pwsh -ArgumentList "-NoProfile", "-Command", "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(ps("Start-Process codex -ArgumentList 'exec','-m','gpt-0-unapproved','-'"), /unapproved/);
  allowed(ps("Start-Process codex -ArgumentList 'exec','-m','gpt-6-astra','-c','model_reasoning_effort=high','-'"));
});

test('bash seçenek ayrıştırması ilk betik dosyasında biter', () => {
  denied(bash('find . -exec sh ./a.sh {} + -exec codex exec -m gpt-0-unapproved - +'), /unapproved/);
  denied(bash('xargs sh ./a.sh -exec codex exec -m gpt-0-unapproved -'), /unapproved/);
  denied(bash('sh ./a.sh -ec codex exec -m gpt-0-unapproved -'), /unapproved/);
});

test('sarmalayıcı arkasındaki Windows PowerShell konumsal komutu', () => {
  denied(bash('env powershell "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(bash('exec powershell "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(bash('time powershell "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(ps('Start-Process -Wait powershell "codex exec -m gpt-0-unapproved -"'), /unapproved/);
});

test('sh -c betiğinden sonraki sözcüklerdeki çağrı da denetlenir', () => {
  denied(bash('find . -maxdepth 0 -exec sh -c : \\; -exec codex exec -m gpt-0-unapproved - \\;'), /unapproved/);
  denied(bash('find . -exec sh -c : + -exec pwsh -c "codex exec -m gpt-0-unapproved -" +'), /unapproved/);
  denied(bash('find . -exec sh -c : \\; -exec sh -c "codex exec -m gpt-0-unapproved -" \\;'), /unapproved/);
  denied(bash("sh -c 'exec \"$@\"' _ codex exec -m gpt-0-unapproved -"), /unapproved/);
  denied(bash('bash -c -- "codex exec -m gpt-0-unapproved -"'), /unapproved/);
});

test('PowerShell uzun tire ve -cwa biçimleri', () => {
  denied(ps('pwsh –Command "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(ps('pwsh -cwa "codex exec -m gpt-0-unapproved -"'), /unapproved/);
  denied(ps('pwsh –ec ' + ENC), /encoded/);
  denied(ps('pwsh —Command "codex exec -m gpt-0-unapproved -"'), /unapproved/);
});

test('çok sayıda kabuk adı içeren komut hızlı işlenir', () => {
  const t = Date.now();
  check(bash('echo ' + 'sh '.repeat(40000)), registry);
  check(ps('pwsh ' + 'pwsh '.repeat(40000)), registry);
  check(bash('sh -c x '.repeat(40000)), registry);
  denied(bash('sudo ' + 'sh '.repeat(40000) + 'codex exec -m gpt-0-unapproved -'), /unapproved/);
  assert.ok(Date.now() - t < 1500, `çok yavaş: ${Date.now() - t} ms`);
});

test('bash here-string (<<<) heredoc sayılmaz', () => {
  denied(bash('cat <<< hello\ncodex exec -m gpt-0-unapproved -'), /unapproved/);
});

test('CRLF satır devamı', () => {
  denied(bash('codex exec \\\r\n  -m gpt-0-unapproved -'), /unapproved/);
  denied(ps('codex exec `\r\n  -m gpt-0-unapproved -'), /unapproved/);
});

test('kaçışlı tırnaklar tırnak açmaz', () => {
  denied(bash('echo \\"; codex exec -m gpt-0-unapproved -'), /unapproved/);
  denied(ps('Write-Output "a`"b"; codex exec -m gpt-0-unapproved -'), /unapproved/);
  allowed(bash("codex exec -m gpt-6-astra -c model_reasoning_effort=high 'don'\\''t use -m gpt-0 here'"));
  allowed(ps("codex exec -m gpt-6-astra -c model_reasoning_effort=high 'don''t use -m gpt-0 here'"));
});

test('-- sonrası istem metni bayrak sayılmaz', () => {
  allowed(bash('codex exec -m gpt-6-astra -c model_reasoning_effort=high -- -p is a flag name'));
});

test('çok uzun komutlar hızlı işlenir', () => {
  const t = Date.now();
  check(bash('codex exec '.repeat(40000)), registry);
  check(bash('codex exec -m gpt-6-astra - ; '.repeat(20000)), registry);
  check(bash('$('.repeat(5000) + 'codex exec -m gpt-6-astra -' + ')'.repeat(5000)), registry);
  assert.ok(Date.now() - t < 1500, `çok yavaş: ${Date.now() - t} ms`);
});

test('Codex profili denetlenemediği için engellenir', () => {
  denied(bash('codex exec -p fastprofile -'), /profile/);
});

test('wrapper komutların arkasındaki çağrı da denetlenir', () => {
  denied(bash('timeout 180 codex exec -m gpt-0-unapproved -'), /unapproved/);
  denied(bash('cd x && RUST_LOG=debug codex exec -m gpt-0-unapproved -'), /unapproved/);
});

test('değerlendirme çalıştırıcısı adayla çalışabilir', () => {
  allowed(bash('node claude/models/eval/run.cjs --model gpt-0-unapproved --effort xhigh --tier fast'));
});

test('stdin ile verilen görev metnindeki bayraklar okunmaz', () => {
  allowed(bash("codex exec -m gpt-6-astra -c model_reasoning_effort=high -s read-only - <<'Q'\nCompare: codex exec -m gpt-0-unapproved\nQ"));
  allowed(bash('echo "use -m gpt-0-unapproved" | codex exec -m gpt-6-astra -c model_reasoning_effort=high -'));
  allowed(ps("@'\ncodex exec -m gpt-0-unapproved\n'@ | codex exec -m gpt-6-astra -c model_reasoning_effort=high -s read-only -"));
});

test('heredoc bittikten sonraki komut yine denetlenir', () => {
  denied(bash("cat <<'Q' > a.txt\nnote\nQ\ncodex exec -m gpt-0-unapproved - < a.txt"), /unapproved/);
  denied(ps("@'\nnote\n'@ | codex exec -m gpt-0-unapproved -"), /unapproved/);
});

test('aynı satırdaki ikinci çağrı da denetlenir', () => {
  denied(bash('codex exec -m gpt-6-astra - < a.txt && codex exec -m gpt-0-unapproved - < b.txt'), /unapproved/);
});

test('claude -p çağrıları denetlenir', () => {
  allowed(bash('claude -p --model fable --effort high --permission-mode plan'));
  allowed(bash('claude --print --model claude-opus-5-5 "x"'));
  denied(bash('claude -p --model claude-opus-6-0'), /claude-opus-6-0/);
  allowed(bash('claude plugin list --model x'));
});

test('Agent modeli kayda göre denetlenir', () => {
  allowed(agent({ subagent_type: 'reviewer-medium', model: 'opus', prompt: 'x' }));
  allowed(agent({ subagent_type: 'Explore', model: 'haiku', prompt: 'x' }));
  allowed(agent({ subagent_type: 'Plan', model: 'fable', prompt: 'x' }));
  allowed(agent({ subagent_type: 'general-purpose', prompt: 'x' }));
  denied(agent({ subagent_type: 'general-purpose', model: 'claude-sonnet-6-0', prompt: 'x' }), /sonnet-6-0/);
});

test('yorumdaki kesme işareti sonraki komutu gizlemez (bash ve PowerShell)', () => {
  denied(bash("# Don't use the retired model\ncodex exec -m gpt-0-unapproved -"), /unapproved/);
  denied(bash("ls # it's fine\ncodex exec -m gpt-0-unapproved -"), /unapproved/);
  denied(ps("# Don't use the retired model\ncodex exec -m gpt-0-unapproved -"), /unapproved/);
  denied(ps("<# it's a\nblock comment #>\ncodex exec -m gpt-0-unapproved -"), /unapproved/);
  // Sözcüğün ortasındaki # yorum değildir: komut görünür kalır.
  denied(bash('echo a#b; codex exec -m gpt-0-unapproved -'), /unapproved/);
  denied(bash('echo ${#x} $#; codex exec -m gpt-0-unapproved -'), /unapproved/);
  denied(bash("echo ''#x\ncodex exec -m gpt-0-unapproved -"), /unapproved/);
});

test('lexer yorum sandığı ama kabuğun çalıştırdığı yerlerde komut gizlenmez', () => {
  // Bash, ters tırnak içindeki yorumu kapanış ters tırnağında bitirir; sonraki komut çalışır.
  denied(bash('echo `#x`; codex exec -m gpt-0-unapproved -'), /unapproved/);
  denied(bash('echo "`#x`"; codex exec -m gpt-0-unapproved -'), /unapproved/);
  // Bash'te ${…} ve süreç ikamesinden sonra gelen # yorum değildir; lexer bunları izlemez, ama yorum
  // metni de tarandığı için komut görünür kalır.
  denied(bash('echo ${x:- #y}; codex exec -m gpt-0-unapproved -'), /unapproved/);
  denied(bash('cat <(ls)#z; codex exec -m gpt-0-unapproved -'), /unapproved/);
  // PowerShell tipografik tırnakları dizgi sınırlayıcısıdır.
  denied(ps('Write-Host “Step #1”; codex exec -m gpt-0-unapproved -'), /unapproved/);
  denied(ps('${a #b}; codex exec -m gpt-0-unapproved -'), /unapproved/);
  // Yanlış yorum aynı komutun içindeyse bayrak komuttan kopmaz.
  denied(bash('codex exec ${x:- #} -m gpt-0-unapproved -'), /unapproved/);
  denied(ps('codex exec “ #” -m gpt-0-unapproved -'), /unapproved/);
  // Yanlış yorumun bulunduğu satırda kabukta açılan tırnak sonraki satırda kapanır; arkasındaki çağrı
  // görünür kalır.
  denied(bash("echo ${x:- #} 'a\nb'; codex exec -m gpt-0-unapproved -"), /unapproved/);
  // Kabuğun birleştirdiği sözcükler (boş tırnak çifti) yanlış yorumun arkasında da birleşik kalır.
  denied(bash("echo ${x:- #}; co''dex exec -m gpt-0-unappr''oved -"), /unapproved/);
});

test('tırnaksız heredoc gövdesindeki komut ikamesi denetlenir, düz metin ve tırnaklı gövde denetlenmez', () => {
  // Bash tırnaksız heredoc gövdesinde $( … ) ve `…` çalıştırır.
  denied(bash('cat <<EOF\n$(codex exec -m gpt-0-unapproved -)\nEOF'), /unapproved/);
  denied(bash('cat <<EOF\nresult: `codex exec -m gpt-0-unapproved -` done\nEOF'), /unapproved/);
  denied(bash("cat <<-EOF\n\tIt's $(codex exec -m gpt-0-unapproved -)\n\tEOF"), /unapproved/);
  denied(bash('cat <<EOF\n$(\ncodex exec -m gpt-0-unapproved -\n)\nEOF\necho after'), /unapproved/);
  // Gövdedeki tırnak işaretleri düz karakterdir; sonraki ikameyi gizlemez.
  denied(bash("cat <<EOF\nDon't \"quote\"\n$(codex exec -m gpt-0-unapproved -)\nEOF"), /unapproved/);
  // Tırnaklı sınırlayıcı: gövde tamamen düz metindir. Kaçışlı \$( de ikame değildir.
  allowed(bash("cat <<'EOF'\n$(codex exec -m gpt-0-unapproved -)\nEOF"));
  allowed(bash('cat <<"EOF"\n$(codex exec -m gpt-0-unapproved -)\nEOF'));
  allowed(bash('cat <<EOF\n\\$(codex exec -m gpt-0-unapproved -)\nEOF'));
  allowed(bash('cat <<EOF\ncodex exec -m gpt-0-unapproved -\nEOF'));
  // Gövdeden sonra gelen komut yine denetlenir.
  denied(bash('cat <<EOF\nplain\nEOF\ncodex exec -m gpt-0-unapproved -'), /unapproved/);
  // Gövdede kapanmamış bir ikame (markdown'daki tek ters tırnak, yarım $( ) ve bir tırnak işareti
  // sınırlayıcıyı geçip arkasındaki gerçek komutu yutmaz: bash gövdeyi sınırlayıcıda bitirir.
  denied(bash("cat <<EOF\nUse `npm test, don't skip it\nEOF\ncodex exec -m gpt-0-unapproved -"), /unapproved/);
  denied(bash("cat <<EOF\n$( echo '\nEOF\ncodex exec -m gpt-0-unapproved -\n# '\ncase x in x) ;; esac"), /unapproved/);
  denied(bash("cat <<EOF\n`echo '\nEOF\ncodex exec -m gpt-0-unapproved -\n'`"), /unapproved/);
  denied(bash('cat <<EOF\nsay "hi $(date\nEOF\ncodex exec -m gpt-0-unapproved -'), /unapproved/);
  // Tırnaksız gövdede \ ile biten satır sonrakine birleşir: "x\" + "EOF" sınırlayıcı değildir, gövde
  // sürer ve sonraki ikame çalışır (bash 5.3'te denendi).
  denied(bash("cat <<EOF\nx\\\nEOF\n' $(codex exec -m gpt-0-unapproved -)\nEOF\necho after"), /unapproved/);
  // Çift \ kaçışlı bir ters eğik çizgidir, birleştirmez: gövde ilk EOF'ta biter.
  allowed(bash("cat <<EOF\nx\\\\\nEOF\necho after"));
  // Tırnaklı gövdede birleştirme yoktur.
  allowed(bash("cat <<'EOF'\nx\\\nEOF\necho after"));
  // <<-: bash önce birleştirir, sonra baştaki sekmeleri bir kez siler. "\tE\" + "\tOF" = "E\tOF"
  // sınırlayıcı değildir, gövde sürer; "\t\" + "\tEOF" ise gövdeyi bitirir (bash 5.3'te denendi).
  denied(bash("cat <<-EOF\n\tE\\\n\tOF\n' $(codex exec -m gpt-0-unapproved -)\nEOF\necho after"), /unapproved/);
  denied(bash("cat <<-EOF\n\t\\\n\tEOF\ncodex exec -m gpt-0-unapproved -"), /unapproved/);
  // Uzun bir \ dizisi taramayı yavaşlatmaz.
  const t0 = Date.now();
  denied(bash('cat <<EOF\n' + '\\'.repeat(200000) + 'a\nEOF\ncodex exec -m gpt-0-unapproved -'), /unapproved/);
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms sürdü`);
});

test('iç içe kabuklar tarama süresini katlamaz; bütçeyi aşan girdi engellenir', () => {
  for (const wrap of ['pwsh -c ', 'cmd /c ', 'powershell -Command ']) {
    const t0 = Date.now();
    denied(ps(wrap.repeat(25) + 'codex exec -m gpt-0-unapproved -'), /unapproved/);
    assert.ok(Date.now() - t0 < 1000, `${wrap.trim()} x25 ${Date.now() - t0} ms sürdü`);
  }
  const t0 = Date.now();
  denied(bash('echo ' + 'a '.repeat(2100000) + '; codex exec -m gpt-6-astra -'), /too large or too deeply nested to check/);
  assert.ok(Date.now() - t0 < 3000, `bütçe denetimi ${Date.now() - t0} ms sürdü`);
});

test('tekrarlanan kabuk seçenekleri taramayı karesel yavaşlatıp hook zaman aşımına sokamaz', () => {
  // sh -o x sh -o x …: her kabuk adında seçenek taraması listenin sonuna kadar gider; tarama karesel
  // büyür ve onu SCAN_STEPS bütçesi durdurur. Bütçe dolunca çağrı "too complex" diye engellenir, bu
  // yüzden 9000 ve 36000 tekrar aynı işi yapar. Süreyi sabit bir sınırla değil iki boyun oranıyla
  // ölçeriz: oran makineden bağımsızdır (bütçe olmasaydı 4 kat girdi ~16 kat sürerdi). Oran, gürültüyü
  // azaltmak için en hızlı ölçümleri karşılaştırır. Mutlak sınır ise hook'un 5 sn zaman aşımıdır
  // (installer/core.mjs): iki boy da gerçek hook süreci olarak (Node açılışı dahil) çalışır ve her
  // biri 4 sn altında bitmelidir.
  const cmd = n => bash('sh -o '.repeat(n) + '; codex exec -m gpt-0-unapproved -');
  const fastest = n => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = process.hrtime.bigint();
      denied(cmd(n), /too large or too deeply nested to check/);
      best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return best;
  };
  const small = fastest(9000);
  const large = fastest(36000);
  assert.ok(large < 2.5 * small, `4 kat girdi ${(large / small).toFixed(1)} kat sürdü (${small.toFixed(0)} ms → ${large.toFixed(0)} ms)`);
  for (const n of [9000, 36000]) {
    const t0 = Date.now();
    const r = runHook(cmd(n), {}, 5000);
    const ms = Date.now() - t0;
    assert.strictEqual(r.status, 0, `hook ${n} tekrarda bitmedi (${ms} ms, ${r.error?.code || r.signal || r.status})`);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /too large or too deeply nested to check/);
    assert.ok(ms < 4000, `hook ${n} tekrarda ${ms} ms sürdü`);
  }
  // Sıradan bir komut bundan etkilenmez.
  allowed(bash('set -o pipefail; bash -o errexit -c "ls"; codex exec -m gpt-6-astra -c model_reasoning_effort=high -'));
});

test('yorum içine yazılmış onaysız çağrı da engellenir (güvenli tarafta kalır)', () => {
  // Bilerek: yorumlar atlanmadan da taranır (bkz. lex). Bunun bedeli, çalışmayacak bir yorumdaki
  // çağrının da engellenmesidir (README "Engelin kapsamı").
  denied(bash('# codex exec -m gpt-0-unapproved -\nls'), /unapproved/);
  denied(ps('<# codex exec -m gpt-0-unapproved - #> Get-ChildItem'), /unapproved/);
  // Yorumda onaylı model ya da düz metin varsa engel yoktur.
  allowed(bash("# Don't forget: codex exec -m gpt-6-astra -c model_reasoning_effort=high -\nls"));
  allowed(bash('ls # just a note'));
});

test('codex-rescue isteğindeki --model denetlenir', () => {
  allowed(agent({ subagent_type: 'codex:codex-rescue', prompt: '--model gpt-6.1-sol --effort xhigh --wait\nFix the bug.' }));
  // Modelsiz istek config varsayılanını kullanır ve denetlenemez.
  denied(agent({ subagent_type: 'codex:codex-rescue', prompt: 'Diagnose the failure.' }), /without --model/);
  denied(agent({ subagent_type: 'codex:codex-rescue', prompt: '--model gpt-0-unapproved --effort high\nFix it.' }), /unapproved/);
});

test('kayıt okunamazsa yalnızca model adı veren çağrılar engellenir', () => {
  assert.match(check(bash('codex exec -m gpt-6-astra -'), null).join(' '), /could not be read/);
  assert.match(check(bash('codex exec -'), null).join(' '), /without a model/);
  assert.deepStrictEqual(check(bash('ls'), null), []);
});

// Uçtan uca: hook'u gerçek süreç olarak çalıştırıp Claude Code'a giden çıktıyı doğrula.
function runHook(input, env = {}, timeout = undefined) {
  return spawnSync(process.execPath, [path.join(__dirname, 'model-guard.cjs')], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8', env: { ...process.env, MODEL_GUARD_REGISTRY: REGISTRY_FILE, ...env }, timeout,
  });
}

test('süreç: engellemede deny JSON yazar, çıkış kodu 0', () => {
  const r = runHook(bash('codex exec -m gpt-0-unapproved -'));
  assert.strictEqual(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /gpt-0-unapproved/);
});

test('süreç: izin verilen çağrıda hiçbir şey yazmaz', () => {
  const r = runHook(bash('codex exec -m gpt-6-astra -c model_reasoning_effort=high -'));
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

test('süreç: bozuk girdide çağrıyı durdurmaz, uyarır', () => {
  const r = runHook('not json');
  assert.strictEqual(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput, undefined);
  assert.match(out.systemMessage, /engellenmedi/);
});

// security rolü: kurgusal kayıtla (canlı kayıt kararlarından bağımsız).
const secRegistry = {
  codex: {
    'gpt-0-sec': { status: 'approved', role: 'security', cyberAccessProgram: 'prog_blue', efforts: ['high', 'xhigh'], serviceTier: 'default' },
    'gpt-0-general': { status: 'approved', role: 'frontier' },
  },
  claude: {},
};
const secAllowed = input => assert.deepStrictEqual(check(input, secRegistry), []);
const secDenied = input => assert.match(check(input, secRegistry).join(' '), /security role/);

test('security rolündeki model yalnızca salt okunur codex exec güvenlik incelemesinde geçer', () => {
  secAllowed(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue --ignore-user-config --ignore-rules --disable apps --disable plugins -c windows.sandbox="unelevated" -c model_reasoning_effort="high" -c service_tier="default" -s read-only -C C:/All_Project/wt - < C:/Users/u/AppData/Local/Temp/claude/s/req.txt > C:/Users/u/AppData/Local/Temp/claude/s/out.md 2>&1'));
  secAllowed(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue --ignore-user-config --ignore-rules --disable apps --disable plugins -c windows.sandbox="unelevated" -c model_reasoning_effort="high" -c service_tier="default" -s read-only -C /c/w - < /c/Users/u/AppData/Local/Temp/claude/s/r.txt > /c/Users/u/AppData/Local/Temp/claude/s/o.log 2>&1'));
  secAllowed(bash('  codex exec -m gpt-0-sec --cyber-access-program prog_blue --ignore-user-config --ignore-rules --disable apps --disable plugins -c windows.sandbox="unelevated" -c model_reasoning_effort="xhigh" -c service_tier="default" -s read-only -C ../wt - < /tmp/claude/req.txt > /tmp/claude/x/out.md 2>&1  '));
  // İstek ve çıktı Claude'un geçici klasörü dışında, .. ile, ya da özel hedefe: reddedilir.
  const SEC = 'codex exec -m gpt-0-sec --cyber-access-program prog_blue --ignore-user-config --ignore-rules --disable apps --disable plugins -c windows.sandbox="unelevated" -c model_reasoning_effort="high" -c service_tier="default" -s read-only -C C:/w -';
  secDenied(bash(SEC + ' < C:/Users/u/AppData/Local/Temp/claude/s/req.txt > claude/hooks/model-guard.cjs 2>&1'));
  secDenied(bash(SEC + ' < ../req.txt > ../out.md 2>&1'));
  secDenied(bash(SEC + ' < C:/Users/u/AppData/Local/Temp/claude/s/../../x.txt > C:/Users/u/AppData/Local/Temp/claude/s/out.md 2>&1'));
  secDenied(bash(SEC + ' < C:/Users/u/AppData/Local/Temp/claude/s/req.txt > /dev/tcp/host/80 2>&1'));
  secDenied(bash(SEC + ' < C:/Users/u/AppData/Local/Temp/claude/s/req.txt > C:/Users/u/AppData/Local/Temp/claude/s/out.cjs 2>&1'));
  secDenied(ps('Get-Content -Raw Env:OPENAI_API_KEY | ' + SEC + ' > C:/Users/u/AppData/Local/Temp/claude/s/out.md 2>&1'));
  // Linux'ta Claude Code'un geçici klasörü /tmp/claude-<uid>/: yalnızca hook'u çalıştıran kullanıcının uid'i.
  if (typeof process.getuid === 'function') {
    const uid = process.getuid();
    secAllowed(bash(SEC + ` < /tmp/claude-${uid}/-home-u-p/sess/scratchpad/req.txt > /tmp/claude-${uid}/-home-u-p/sess/scratchpad/out.md 2>&1`));
    secDenied(bash(SEC + ` < /tmp/claude-${uid + 1}/s/req.txt > /tmp/claude-${uid + 1}/s/out.md 2>&1`));
    secDenied(bash(SEC + ` < /tmp/claude-${uid}x/s/req.txt > /tmp/claude-${uid}x/s/out.md 2>&1`));
    secDenied(bash(SEC + ' < /tmp/claude-/s/req.txt > /tmp/claude-/s/out.md 2>&1'));
  }
  secAllowed(ps('Get-Content -Raw C:/Users/u/AppData/Local/Temp/claude/s/req.txt | codex exec -m gpt-0-sec --cyber-access-program prog_blue --ignore-user-config --ignore-rules --disable apps --disable plugins -c windows.sandbox="unelevated" -c model_reasoning_effort="high" -c service_tier="default" -s read-only -C C:/w - > C:/Users/u/AppData/Local/Temp/claude/s/out.md 2>&1'));
  // Kalıp MCP'yi kapatan bayrakları ister; eksik ya da başka bir --disable reddedilir.
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue -c model_reasoning_effort="high" -c service_tier="default" -s read-only -C C:/w - < C:/Users/u/AppData/Local/Temp/claude/s/r.txt > C:/Users/u/AppData/Local/Temp/claude/s/o.md 2>&1'));
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue --ignore-user-config --disable apps -c windows.sandbox="unelevated" -c model_reasoning_effort="high" -c service_tier="default" -s read-only -C C:/w - < C:/Users/u/AppData/Local/Temp/claude/s/r.txt > C:/Users/u/AppData/Local/Temp/claude/s/o.md 2>&1'));
  // --ignore-rules olmadan (execpolicy allow kuralları sandbox dışında çalıştırır) reddedilir.
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue --ignore-user-config --disable apps --disable plugins -c windows.sandbox="unelevated" -c model_reasoning_effort="high" -c service_tier="default" -s read-only -C C:/w - < C:/Users/u/AppData/Local/Temp/claude/s/r.txt > C:/Users/u/AppData/Local/Temp/claude/s/o.md 2>&1'));
  // Ham tetikleyici codex harfleri arasındaki ayırıcıları da yakalar (PowerShell ` kaçışı).
  secDenied(ps('co`d`ex exec -m gpt-0-sec -s danger-full-access -'));
  // Ad tek başına kalıbı tetiklemez (grep, commit mesajı, eval çalıştırıcısı); codex de geçerse tetikler.
  secAllowed(bash('grep -n gpt-0-sec registry.json'));
  secAllowed(bash('git commit -m "approve gpt-0-sec"'));
  secAllowed(bash('node claude/models/eval/run.cjs --model gpt-0-sec --effort high --tier default --cyber-access-program prog_blue'));
  secDenied(bash('echo gpt-0-sec | xargs -I{} codex exec -m {} -s danger-full-access -'));
  secDenied(bash('git commit -m "run codex with gpt-0-sec"'));
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue --ignore-user-config --ignore-rules --disable apps --disable plugins -c windows.sandbox="unelevated" -c model_reasoning_effort="high" -c service_tier="default" -s read-only -C ../wt -'));
  secDenied(bash('codex exec --model=gpt-0-sec --cyber-access-program=prog_blue --sandbox=read-only -'));
  secDenied(ps('& codex exec -m gpt-0-sec --cyber-access-program prog_blue --sandbox read-only -'));
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue -c sandbox_mode="read-only" --skip-git-repo-check --json - < in.txt > out.md 2>&1'));
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue -s read-only -C C:/w - < "$S/req.txt" > "$S/out.md" 2>&1'));
  secDenied(bash('cd /c/w && codex -C . exec -m gpt-0-sec --cyber-access-program prog_blue -s read-only -C../wt - <<\'EOF\'\nbody --approve-for-me\nEOF'));
  // Rol sözleşmesi yalnızca security rolüne uygulanır.
  secAllowed(bash('codex exec -m gpt-0-general -s workspace-write -'));
  secAllowed(bash('codex review --uncommitted -c review_model="gpt-0-general"'));
});

test('security rolündeki model başka çağrı biçiminde engellenir', () => {
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue -s workspace-write -'));
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue -'));
  secDenied(bash('codex exec -m gpt-0-sec -s read-only -'));
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_red -s read-only -'));
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue --cyber-access-program prog_red -s read-only -'));
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue -s read-only -s danger-full-access -'));
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue -s read-only -c sandbox_mode="workspace-write" -'));
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue -s read-only --full-auto -'));
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue -s read-only --dangerously-bypass-approvals-and-sandbox -'));
  secDenied(bash('codex exec -c model="gpt-0-sec" --cyber-access-program prog_blue -'));
  secDenied(bash('codex review --uncommitted -c review_model="gpt-0-sec" -c sandbox_mode="read-only"'));
  // Sözleşmenin geri kalanı sağlansa da codex review reddedilir (artık kalıp denetiminde).
  secDenied(bash('codex review --commit abc -m gpt-0-sec --cyber-access-program prog_blue -s read-only'));
  secDenied(agent({ subagent_type: 'codex:codex-rescue', prompt: '--model gpt-0-sec --effort high review this' }));
  secDenied(agent({ subagent_type: 'codex:codex-rescue', prompt: '-m gpt-0-sec do it' }));
  secDenied(agent({ subagent_type: 'codex:codex-rescue', prompt: '--model gpt-0-general then --model gpt-0-sec' }));
  secAllowed(agent({ subagent_type: 'codex:codex-rescue', prompt: '--model gpt-0-general fix it and run git commit -m wip' }));
  // İzin listesi: sandbox'ı ya da yazma alanını değiştiren bayraklar ve bilinmeyen bayraklar.
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue -c sandbox_mode=read-only --approve-for-me -'));
  secDenied(ps('& codex exec -m gpt-0-sec --cyber-access-program prog_blue -c sandbox_mode=read-only --approve-for-me -'));
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue -s read-only --not-so-yolo -'));
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue -s read-only --add-dir /etc -'));
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue -s read-only --some-future-flag -'));
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue -s read-only -c sandbox_permissions=["disk-full-write-access"] -'));
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue -s read-only --ignore-rules -'));
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue -s read-only resume --last'));
  // İstem yalnızca stdin'den ('-'); fork, istem metni ve kabuğun genişletebileceği sözcükler reddedilir.
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue -s read-only fork 019abc "edit files"'));
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue -s read-only "review commit abc"'));
  secDenied(bash('codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue $(echo --approve-for-me) -'));
  secDenied(bash('F=--approve-for-me; codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue $F -'));
  secDenied(bash('codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue `echo --worktree` -'));
  secDenied(bash('codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue {--approve-for-me,-}'));
  secDenied(bash('codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue [-]-approve-for-me -'));
  secDenied(bash("sh -c 'codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue \"$@\" -' _ --approve-for-me"));
  secDenied(ps('$f="--approve-for-me"; & codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue $f -'));
  secDenied(ps('& codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue @a -'));
  secDenied(bash('codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue -- --approve-for-me'));
  // Yönlendirmeden sonraki sözcükler hâlâ argümandır.
  secDenied(bash('codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue 2>&1 --approve-for-me -'));
  secDenied(bash('codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue > out --approve-for-me -'));
  secDenied(bash('codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue &>log --worktree -'));
  // Yönlendirme lexer'da işaretlenir: tırnaklı '>' ve heredoc sonrası sözcük gerçek argümandır.
  secDenied(bash("codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue - <<'EOF' --approve-for-me\nbody\nEOF"));
  secDenied(bash("codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue '>' --approve-for-me"));
  secDenied(ps("& codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue '>' --approve-for-me"));
  secDenied(bash('codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue - >| out --approve-for-me'));
  secDenied(bash('codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue -o>x -'));
  secDenied(bash('codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue - >> log 2>&1'));
  secDenied(bash('pwsh -Command codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue - > out.md'));
  secDenied(ps('Get-Content p | codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue - *> out.md'));
  // Tam yeniden incelemede bulunanlar: heredoc sonrası bayrak, tırnaklı ya da kaçışlı '>' sonrası bayrak,
  // PowerShell (ifade) argümanı, cmd değişkeni.
  secDenied(bash("codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue -C . - <<'EOF' --dangerously-bypass-approvals-and-sandbox\nreq\nEOF"));
  secDenied(bash('codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue ">" --dangerously-bypass-approvals-and-sandbox'));
  secDenied(bash('codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue \\> --approve-for-me'));
  secDenied(ps("codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue ('--approve-'+'for-me') -"));
  secDenied(bash("F='. --approve-for-me' cmd //c codex exec -m gpt-0-sec --cyber-access-program prog_blue -s read-only -C %F% -"));
  secDenied(bash('codex >log exec -m gpt-0-sec --cyber-access-program prog_blue -s read-only --approve-for-me -'));
  secDenied(bash('cmd //c codex exec -m gpt-0-sec --cyber-access-program prog_blue -s read-only -C . -'));
  secDenied(ps("@'\nreq\n'@ | codex exec -m gpt-0-sec --cyber-access-program prog_blue -s read-only - 2>&1 | Out-File out.md"));
  secDenied(ps('codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue (Write-Output --full-auto) -'));
  // İstek tam olarak bir '-' ile stdin'den.
  secDenied(bash('codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue'));
  secDenied(bash('codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue - -'));
  // Model bayrağı değişkenle verilse de adı geçen security modeli denetlenir.
  secDenied(bash('F=-m; codex exec $F gpt-0-sec --cyber-access-program prog_blue -s danger-full-access "edit files"'));
  secDenied(bash("codex exec -m gpt-0-general -s read-only '>' -ogpt-0-sec -"));
  secDenied(bash("codex exec -m gpt-0-sec -s read-only --cyber-access-program prog_blue '>' -oclaude/hooks/model-guard.cjs"));
  // Here-string içeriği alt komut sayılmaz; tırnakla bölünmüş ad da kalıba takılır.
  // Yardım istisnası yalnızca tam biçim: yönlendirme hedefi ya da -- sonrası --help sayılmaz.
  denied(bash('codex exec "task" > --help'), /without a model/);
  denied(bash('codex exec -- -h'), /without a model/);
  denied(bash('codex exec -s danger-full-access --help "edit"'), /without a model/);
  allowed(bash('codex exec --help 2>&1 | head -40'));
  allowed(bash('codex review -h'));
  // Tırnaklı '>' dosya adı yönlendirme hedefidir; sonraki sözcük alt komuttur.
  denied(bash("codex >'>' exec -m gpt-0-unapproved -"), /gpt-0-unapproved/);
  denied(bash('codex >">" exec -m gpt-0-unapproved -'), /gpt-0-unapproved/);
  denied(bash('codex <<<">" exec -m gpt-0-unapproved -'), /gpt-0-unapproved/);
  denied(bash('codex >\\> exec -m gpt-0-unapproved -'), /gpt-0-unapproved/);
  denied(bash("codex 2>'<' exec -m gpt-0-unapproved -"), /gpt-0-unapproved/);
  denied(bash("codex >'&' exec -m gpt-0-unapproved -"), /gpt-0-unapproved/);
  denied(bash("codex >'>' exec -s read-only -"), /without a model/);
  denied(bash("codex >'>' exec -m gpt-daybreak-blue-'latest' -s danger-full-access edit"), /security role/);
  // Gerçek yönlendirmeler eskisi gibi.
  allowed(bash('codex exec -m gpt-6-astra -c model_reasoning_effort=high - >> log 2>&1'));
  allowed(bash('codex exec -m gpt-6-astra -c model_reasoning_effort=high - >&2'));
  allowed(bash('codex exec -m gpt-6-astra -c model_reasoning_effort=high - &>log'));
  allowed(bash('codex exec -m gpt-6-astra -c model_reasoning_effort=high - >| log'));
  // Bitişik yönlendirmeler: son operatörün hedefi sonraki sözcüktür.
  denied(bash('codex 2>&1> /tmp/out exec -m gpt-0-unapproved -'), /gpt-0-unapproved/);
  denied(bash('codex 2>&1>> /tmp/out exec -m gpt-0-unapproved -'), /gpt-0-unapproved/);
  denied(bash('codex 2>err> /tmp/out exec -m gpt-0-unapproved -'), /gpt-0-unapproved/);
  denied(bash("codex >'&' 2>&1> /tmp/out exec -m gpt-0-unapproved -"), /gpt-0-unapproved/);
  // Boşluksuz &>: önündeki sözcük programın adıdır.
  denied(bash('codex&>x exec -m gpt-0-unapproved -'), /gpt-0-unapproved/);
  denied(bash('sh&>x -c "codex exec -m gpt-0-unapproved -"'), /gpt-0-unapproved/);
  denied(bash('sh >x -c "codex exec -m gpt-0-unapproved -"'), /gpt-0-unapproved/);
  denied(bash('bash 2>/dev/null -c "codex exec -m gpt-0-unapproved -"'), /gpt-0-unapproved/);
  // cmd'de & ayırıcıdır: &> sonrası iç içe betik de denetlenir.
  denied(ps(`cmd /c 'echo&>x powershell -NoProfile -c "codex exec -m gpt-0-unapproved -"'`), /gpt-0-unapproved/);
  denied(ps(`cmd /c 'echo&>x bash -c "codex exec -m gpt-0-unapproved -"'`), /gpt-0-unapproved/);
  denied(ps(`cmd /c 'echo &>x powershell -NoProfile -c "codex exec -m gpt-0-unapproved -"'`), /gpt-0-unapproved/);
  allowed(bash('codex exec -m gpt-6-astra -c model_reasoning_effort=high -&>log'));
  denied(bash('codex 2>&1>/tmp/out exec -m gpt-0-unapproved -'), /gpt-0-unapproved/);
  denied(bash('codex <<<x exec -m gpt-0-unapproved -'), /gpt-0-unapproved/);
  denied(bash('codex <<< x exec -m gpt-0-unapproved -'), /gpt-0-unapproved/);
  assert.match(check(bash('codex <<<x exec -m gpt-0-"sec" -s danger-full-access -'), secRegistry).join(' '), /security role/);
  assert.match(check(bash('codex exec -m gpt-0-"sec" --cyber-access-program prog_blue --ignore-user-config --ignore-rules --disable apps --disable plugins -c windows.sandbox="unelevated" -c model_reasoning_effort="high" -c service_tier="default" -s read-only -C C:/w - < C:/r.txt > C:/o.md 2>&1'), secRegistry).join(' '), /security role/);
  // PowerShell: ters eğik çizgili scratchpad yolu; taşınmış geçici klasör (hook ortamından).
  secAllowed(ps('Get-Content -Raw C:\\Users\\u\\AppData\\Local\\Temp\\claude\\s\\req.txt | codex exec -m gpt-0-sec --cyber-access-program prog_blue --ignore-user-config --ignore-rules --disable apps --disable plugins -c windows.sandbox="unelevated" -c model_reasoning_effort="high" -c service_tier="default" -s read-only -C C:\\w - > C:\\Users\\u\\AppData\\Local\\Temp\\claude\\s\\out.md 2>&1'));
  // Kalıplar kabuğa göre: PowerShell biçimi Bash aracında geçmez.
  secDenied(bash('Get-Content -Raw C:/Users/u/AppData/Local/Temp/claude/s/req.txt | codex exec -m gpt-0-sec --cyber-access-program prog_blue --ignore-user-config --ignore-rules --disable apps --disable plugins -c windows.sandbox="unelevated" -c model_reasoning_effort="high" -c service_tier="default" -s read-only -C C:/w - > C:/Users/u/AppData/Local/Temp/claude/s/out.md 2>&1'));
  {
    const old = process.env.CLAUDE_CODE_TMPDIR;
    process.env.CLAUDE_CODE_TMPDIR = 'D:\\Temp';
    try {
      secAllowed(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue --ignore-user-config --ignore-rules --disable apps --disable plugins -c windows.sandbox="unelevated" -c model_reasoning_effort="high" -c service_tier="default" -s read-only -C C:/w - < D:/Temp/claude/s/req.txt > D:/Temp/claude/s/out.md 2>&1'));
      secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue --ignore-user-config --ignore-rules --disable apps --disable plugins -c windows.sandbox="unelevated" -c model_reasoning_effort="high" -c service_tier="default" -s read-only -C C:/w - < D:/Other/claude/s/req.txt > D:/Other/claude/s/out.md 2>&1'));
    } finally {
      if (old === undefined) delete process.env.CLAUDE_CODE_TMPDIR; else process.env.CLAUDE_CODE_TMPDIR = old;
    }
  }
  // = ile yazılan kısa seçenekler.
  secDenied(bash('codex exec -c=model=gpt-0-sec -s danger-full-access -'));
  // Model çok kez yazılsa da denetim hızlı biter.
  const t0 = Date.now();
  secDenied(bash('codex exec ' + '-c model=gpt-0-sec '.repeat(10000) + '--cyber-access-program prog_blue -s read-only --full-auto -'));
  assert.ok(Date.now() - t0 < 1500, 'denetim hızlı bitmeli');
  secDenied(bash('codex --approve-for-me exec -m gpt-0-sec --cyber-access-program prog_blue -s read-only -'));
  // -o çıktıyı seçilen dosyanın üstüne yazar; --worktree worktree oluşturur.
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue -s read-only -o claude/hooks/model-guard.cjs -'));
  secDenied(bash('codex exec -m gpt-0-sec --cyber-access-program prog_blue -s read-only --worktree -'));
  // Bitişik -c yazımı da model olarak okunur.
  secDenied(bash('codex exec -cmodel=gpt-0-sec -s workspace-write --cyber-access-program prog_red -'));
});

test('Codex eforu kayıttaki efforts listesinden olmalı', () => {
  // Kayıttaki listeler: Terra medium|high|xhigh, Sol yalnızca xhigh, Astra low…ultra.
  allowed(bash('codex exec -m gpt-6.1-terra -c model_reasoning_effort="medium" -c service_tier="fast" -s read-only -'));
  allowed(bash('codex exec -m gpt-6-astra -c model_reasoning_effort="low" -s read-only -'));
  allowed(bash('codex exec -m gpt-6.1-sol --config model_reasoning_effort=xhigh -s workspace-write -'));
  allowed(bash('codex exec -m gpt-6.1-sol -cmodel_reasoning_effort=xhigh -'));
  allowed(bash("codex exec -m gpt-6-astra -c 'model_reasoning_effort=\"max\"' -"));
  denied(bash('codex exec -m gpt-6.1-terra -c model_reasoning_effort="low" -c service_tier="fast" -s read-only -'), /effort "low" is not approved for model "gpt-6.1-terra"/);
  denied(bash('codex exec -m gpt-6.1-sol -c model_reasoning_effort="high" -'), /effort "high" is not approved for model "gpt-6.1-sol"/);
  denied(bash('codex exec -m gpt-6.1-sol --config=model_reasoning_effort=medium -'), /not approved for model "gpt-6.1-sol"/);
  // Birden çok değer: hepsi denetlenir.
  denied(bash('codex exec -m gpt-6.1-sol -c model_reasoning_effort=xhigh -c model_reasoning_effort=low -'), /effort "low"/);
  // Değişkenle verilen efor denetlenemez.
  denied(bash('codex exec -m gpt-6.1-terra -c model_reasoning_effort="$E" -'), /not a literal/);
  // codex review: review_model ile de aynı denetim.
  denied(bash('codex review --uncommitted -c review_model="gpt-6.1-terra" -c model_reasoning_effort="low"'), /not approved for model "gpt-6.1-terra"/);
  // İç içe kabukta da.
  denied(bash('bash -c "codex exec -m gpt-6.1-terra -c model_reasoning_effort=low -"'), /not approved/);
});

test('eforsuz Codex çağrısı engellenir (config varsayılanı denetlenemez)', () => {
  denied(bash('codex exec -m gpt-6-astra -s read-only -'), /without an effort/);
  denied(ps('& codex exec --model gpt-6.1-terra -s read-only -'), /without an effort/);
  denied(bash('codex review --uncommitted -c review_model="gpt-6-astra"'), /without an effort/);
  // Yardım çağrısı modelsiz olduğu için etkilenmez.
  allowed(bash('codex exec --help'));
});

test('codex-rescue isteğindeki --effort denetlenir', () => {
  allowed(agent({ subagent_type: 'codex:codex-rescue', prompt: '--model gpt-6.1-terra --effort medium --wait\nFix it.' }));
  allowed(agent({ subagent_type: 'codex:codex-rescue', prompt: '--model=gpt-6.1-sol --effort=xhigh\nFix it.' }));
  denied(agent({ subagent_type: 'codex:codex-rescue', prompt: '--model gpt-6.1-terra --effort low\nFix it.' }), /effort "low" is not approved/);
  denied(agent({ subagent_type: 'codex:codex-rescue', prompt: '--model gpt-6.1-sol --effort high\nFix it.' }), /not approved for model "gpt-6.1-sol"/);
  denied(agent({ subagent_type: 'codex:codex-rescue', prompt: '--model gpt-6.1-sol\nFix it.' }), /without an effort/);
  // Yalnızca efor verilen ya da hiçbiri verilmeyen istek engellenir (config varsayılan modeli denetlenemez).
  denied(agent({ subagent_type: 'codex:codex-rescue', prompt: '--effort low --wait\nFix it.' }), /without --model/);
  denied(agent({ subagent_type: 'codex:codex-rescue', prompt: 'Diagnose the failure.' }), /without --model/);
  // Aynı model tekrarlansa da bir kez denetlenir.
  allowed(agent({ subagent_type: 'codex:codex-rescue', prompt: '--model gpt-6.1-terra --model gpt-6.1-terra --effort high\nFix it.' }));
});

test('satır sonuyla biten -c değeri de denetlenir', () => {
  denied(bash("codex exec -m gpt-6.1-sol -c model_reasoning_effort=xhigh -c 'model_reasoning_effort=\"low\"\n' -"), /effort "low"/);
  denied(bash("codex exec -m gpt-6-astra -c model_reasoning_effort=high -c 'model=\"gpt-0-bad\"\n' -"), /gpt-0-bad/);
});

test('kabuğun genişletebileceği codex argümanı engellenir', () => {
  denied(bash("E='-c model_reasoning_effort=low'\ncodex exec -m gpt-6.1-terra -c model_reasoning_effort=medium $E -s read-only -"), /can be expanded/);
  denied(bash("F='-m gpt-0-bad'\ncodex exec -m gpt-6-astra -c model_reasoning_effort=high $F -"), /can be expanded/);
  denied(bash('codex exec -m gpt-6-astra -c model_reasoning_effort=high {-m,gpt-0-bad} -'), /can be expanded/);
  denied(ps('codex exec -m gpt-6-astra -c model_reasoning_effort=high @a -'), /can be expanded/);
  denied(bash('codex exec -m gpt-6-astra -c model_reasoning_effort=high "$(cat args)" -'), /can be expanded/);
  // Yönlendirme hedefi ve heredoc gövdesi argüman değildir.
  allowed(bash('codex exec -m gpt-6-astra -c model_reasoning_effort=high - < $REQ > $OUT 2>&1'));
  allowed(bash("codex exec -m gpt-6-astra -c model_reasoning_effort=high - <<'Q'\nuse $HOME and *.js\nQ"));
  // PowerShell blok ayraçları tek başına sözcüktür, genişletme değildir.
  allowed(ps('if ($x) { codex exec -m gpt-6-astra -c model_reasoning_effort=high - }'));
});

test('çok sayıda tekrarlanan model ve efor denetimi zaman aşımına sokmaz', () => {
  const big = 'codex exec ' + '-mgpt-6.1-terra '.repeat(40000) + '-cmodel_reasoning_effort=high '.repeat(40000) + '-m gpt-0-unapproved -';
  const t0 = Date.now();
  denied(bash(big), /gpt-0-unapproved/);
  assert.ok(Date.now() - t0 < 2000, 'denetim 2 sn altında bitmeli');
});

test('son ekli aynı model yazımları da bir kez denetlenir (zaman aşımı yok)', () => {
  let models = '';
  for (let i = 0; i < 35000; i++) models += `-mgpt-6.1-terra[${i}] `;
  const big = 'codex exec ' + models + '-cmodel_reasoning_effort=high '.repeat(80000) + '-m gpt-0-unapproved -';
  const t0 = Date.now();
  denied(bash(big), /gpt-0-unapproved/);
  assert.ok(Date.now() - t0 < 2000, 'denetim 2 sn altında bitmeli');
});

test('codex-rescue: son ekli tekrar modeller ve eforlar zaman aşımına sokmaz', () => {
  let models = '';
  for (let i = 0; i < 40000; i++) models += `--model gpt-6.1-terra[${i}] `;
  const prompt = models + '--effort high '.repeat(40000) + '--model gpt-0-bad\nFix it.';
  const t0 = Date.now();
  denied(agent({ subagent_type: 'codex:codex-rescue', prompt }), /gpt-0-bad/);
  assert.ok(Date.now() - t0 < 2000, 'denetim 2 sn altında bitmeli');
});

test('bash extglob argümanı genişletilebilir sayılır', () => {
  denied(bash("bash -O extglob -c 'codex exec -m gpt-6.1-terra -c model_reasoning_effort=high +(-m|gpt-0-unapproved) -'"), /can be expanded/);
  denied(bash('codex exec -m gpt-6.1-terra -c model_reasoning_effort=high x@(-m|y) -'), /can be expanded/);
  denied(bash('codex exec -m gpt-6.1-terra -c model_reasoning_effort=high !(a) -'), /can be expanded/);
  // Sıradan alt kabuk grubu eskisi gibi ayrı komuttur.
  allowed(bash('(codex exec -m gpt-6-astra -c model_reasoning_effort=high -)'));
});

test('extglob grubu program adını gizlemez', () => {
  denied(bash('shopt -s extglob\n/c/npm/!(z)codex exec -m gpt-0-bad -'), /gpt-0-bad/);
  denied(bash('/c/Users/u/AppData/Roaming/npm/?(x)codex exec -m gpt-0-bad -'), /gpt-0-bad/);
  denied(bash("bash -O extglob -c '/c/npm/*(x)codex exec -m gpt-0-bad -'"), /gpt-0-bad/);
});

test('PowerShell: security modelinin çok sayıda yazımı kalıp denetimini zaman aşımına sokmaz', () => {
  let m = '';
  for (let i = 0; i < 110000; i++) m += `-mgpt-daybreak-"blue"-latest[${i}] `;
  const t0 = Date.now();
  denied(ps('codex exec ' + m + '-m gpt-0-unapproved -'), /gpt-0-unapproved/);
  assert.ok(Date.now() - t0 < 2000, 'denetim 2 sn altında bitmeli');
});
