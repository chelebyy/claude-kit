#!/usr/bin/env node
// SessionStart hook: `codex debug models` kataloğunu ~/.claude/models/registry.json ile karşılaştırır.
// - Kayıtta olmayan görünür bir Codex modeli → "değerlendirilmemiş yeni model" uyarısı.
// - Kayıtta onaylı olup katalogda artık olmayan bir model → "onaylı model kayboldu" uyarısı.
// - Claude tarafında listelenebilir bir katalog yok; onaylı Claude kimlikleri bağlama yazılır,
//   ana model kendi ortam listesini bununla karşılaştırır.
// Katalog metni üreticiden gelir ve güvenilmez: bağlama yalnızca doğrulanmış slug'lar ve
// kısaltılmış, temizlenmiş açıklamalar girer. Ham JSON hiçbir yere yazılmaz.
// Hiçbir durumda oturumu bozmaz: codex yoksa, giriş yapılmamışsa, zaman aşımı ya da bozuk
// çıktı varsa Codex kısmı sessizce atlanır.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const NOTE = 'claude/models/README.md';

function registryPath() {
  return process.env.MODEL_WATCH_REGISTRY || path.join(os.homedir(), '.claude', 'models', 'registry.json');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Açıklamayı bağlama girebilecek hale getirir: tek satır, yalnızca sade karakterler, en fazla 80 karakter.
function cleanDescription(text) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/[^A-Za-z0-9 .,()'-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? flat.slice(0, 77) + '...' : flat;
}

function loadCatalog() {
  if (process.env.MODEL_WATCH_CATALOG_FILE) return readJson(process.env.MODEL_WATCH_CATALOG_FILE);
  // Windows'ta codex bir .cmd kısayoludur ve kabuk olmadan çalışmaz. Komut sabittir, girdi içermez.
  // cwd ev klasörü: cmd.exe yalın komutu PATH'ten önce o anki klasörde arar; hook proje klasöründe
  // çalıştığı için bir depoya konmuş codex.cmd aksi halde kendiliğinden çalışırdı.
  const r = spawnSync('codex debug models', {
    shell: true,
    cwd: os.homedir(),
    encoding: 'utf8',
    timeout: 8000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.error || r.status !== 0 || !r.stdout) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// Saf karşılaştırma: test edilebilsin diye G/Ç'den ayrı.
function compare(registry, catalog) {
  const known = (registry && typeof registry.codex === 'object' && registry.codex) || {};
  const result = { unknown: [], missing: [], skipped: 0 };
  if (!catalog || !Array.isArray(catalog.models)) return null;
  const visible = new Set();
  for (const m of catalog.models) {
    if (!m || m.visibility !== 'list') continue;
    if (typeof m.slug !== 'string' || !SLUG_RE.test(m.slug)) { result.skipped++; continue; }
    visible.add(m.slug);
    if (!Object.prototype.hasOwnProperty.call(known, m.slug)) {
      result.unknown.push({ slug: m.slug, description: cleanDescription(m.description) });
    }
  }
  for (const [slug, entry] of Object.entries(known)) {
    if (entry && entry.status === 'approved' && !visible.has(slug)) result.missing.push(slug);
  }
  return result;
}

function approvedClaude(registry) {
  const c = (registry && typeof registry.claude === 'object' && registry.claude) || {};
  return Object.entries(c).filter(([id, e]) => SLUG_RE.test(id) && e && e.status === 'approved').map(([id]) => id);
}

function buildOutput(registry, diff) {
  const context = [];
  const notices = [];
  if (!registry) {
    notices.push(`model-watch: model kaydı okunamadı (${registryPath()}); yeni modeller denetlenemiyor.`);
    context.push('Model registry could not be read, so no model has a vetted role this session. Tell the user and use only the models named in the rules.');
  } else {
    const ids = approvedClaude(registry);
    context.push(`Model registry: approved Claude model IDs are ${ids.join(', ') || '(none)'}. ` +
      'If your environment names a Claude model ID that is not in this list, tell the user in your first reply that it is unevaluated and must not get a role until it passes our evaluation (' + NOTE + ').');
  }
  if (diff) {
    for (const u of diff.unknown) {
      notices.push(`model-watch: değerlendirilmemiş yeni Codex modeli: ${u.slug}`);
      context.push(`Unevaluated Codex model in the catalog: ${u.slug}` + (u.description ? ` (vendor description, unverified: "${u.description}")` : '') +
        '. It gets no role until evaluated. Tell the user and decide whether to evaluate it.');
    }
    for (const slug of diff.missing) {
      notices.push(`model-watch: onaylı Codex modeli katalogda yok: ${slug}`);
      context.push(`Approved Codex model ${slug} is no longer in the catalog; commands that name it may fail. Tell the user.`);
    }
    if (diff.skipped) context.push(`model-watch skipped ${diff.skipped} catalog entries with malformed slugs.`);
  }
  const out = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context.join('\n') } };
  if (notices.length) out.systemMessage = notices.join('\n');
  return out;
}

function main() {
  const registry = readJson(registryPath());
  const diff = registry ? compare(registry, loadCatalog()) : null;
  process.stdout.write(JSON.stringify(buildOutput(registry, diff)));
}

if (require.main === module) {
  try { main(); } catch { /* hook asla oturumu bozmamalı */ }
} else {
  module.exports = { compare, cleanDescription, approvedClaude, buildOutput };
}
