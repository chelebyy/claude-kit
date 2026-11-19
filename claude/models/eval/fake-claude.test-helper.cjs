'use strict';
// run.test.cjs için sahte `claude -p`. Gerçek CLI gibi: istek stdin'den gelir, çalışma klasörü cwd'dir,
// stdout'ta önce bir uyarı satırı, sonra tek bir JSON nesnesi yazılır.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const mode = process.env.FAKE_MODE;
const json = obj => { process.stdout.write('Warning: some MCP servers blocked by policy\n' + JSON.stringify(obj)); };
const usage = { input_tokens: 3, cache_creation_input_tokens: 1000, cache_read_input_tokens: 500, output_tokens: 40 };

// Testler için: aldığı argümanları kaydeder (araç kısıtlarının iletildiği doğrulanır).
if (process.env.FAKE_CLAUDE_ARGS) fs.writeFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify(args));
fs.readFileSync(0, 'utf8'); // stdin'deki isteği tüket

if (mode === 'claude-fix') {
  const f = path.join(process.cwd(), 'paginate.js');
  const src = fs.readFileSync(f, 'utf8')
    .replace('Math.floor(items.length / pageSize)', 'Math.ceil(items.length / pageSize)')
    .replace('const start = page * pageSize;', 'const start = (page - 1) * pageSize;');
  fs.writeFileSync(f, src);
  json({ type: 'result', is_error: false, result: 'Fixed: floor dropped the last page; start skipped page one.', usage, total_cost_usd: 0.12 });
} else if (mode === 'claude-review') {
  json({ type: 'result', is_error: false, result: 'checkout.js:5 negative percent raises the price. checkout.js:10 assigns role instead of comparison. checkout.js:16 floating point money, no rounding to cents.', usage, total_cost_usd: 0.05 });
} else if (mode === 'claude-error') {
  json({ type: 'result', is_error: true, result: 'API Error: overloaded', usage });
} else if (mode === 'claude-error-subtype') {
  json({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Tool execution failed: boom'], usage });
} else if (mode === 'claude-error-path') {
  // Hata alanında çalışma klasörünün Windows yolu (\ ayırıcılı).
  json({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [`ENOENT: no such file '${path.join(process.cwd(), 'checkout.js')}'`], usage });
} else if (mode === 'claude-review-writes-claude-dir') {
  // İnceleme görevinde .claude/ altına yazar: bu modelin değişikliğidir, araç dosyası değil.
  fs.mkdirSync(path.join(process.cwd(), '.claude'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), '.claude', 'settings.local.json'), '{}');
  json({ type: 'result', is_error: false, result: 'checkout.js:5 negative percent raises the price. checkout.js:10 assigns role instead of comparison. checkout.js:16 floating point money, no rounding to cents.', usage, total_cost_usd: 0.05 });
} else if (mode === 'claude-garbage') {
  process.stdout.write('not json at all');
}
process.exit(0);
