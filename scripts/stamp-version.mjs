#!/usr/bin/env node
// Stamps a new deploy version into the site so open browser tabs can detect it (be-update.js):
//   • version.json                      { version, built }
//   • <meta name="be-version">          in every top-level *.html page
//   • ?v=VERSION on every local .js/.css <script src> / <link href> in those pages, so a new
//     deploy can never be served from a stale browser cache.
// Run by .githooks/pre-commit on every commit. Can also be run by hand: node scripts/stamp-version.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// India time, e.g. 2026.10.05.1830-k3f9 (suffix keeps two commits in the same minute distinct)
const ist = new Date(Date.now() + 5.5 * 3600e3);
const p = n => String(n).padStart(2, '0');
const version = `${ist.getUTCFullYear()}.${p(ist.getUTCMonth() + 1)}.${p(ist.getUTCDate())}.${p(ist.getUTCHours())}${p(ist.getUTCMinutes())}-${Math.random().toString(36).slice(2, 6)}`;

writeFileSync(join(root, 'version.json'), JSON.stringify({ version, built: new Date().toISOString() }, null, 2) + '\n');

const ASSET = /(<(?:script|link)\b[^>]*?\b(?:src|href)=")(?!https?:|\/\/|data:)([^"?#]+\.(?:js|css))(?:\?v=[^"]*)?(")/gi;
const META = /<meta name="be-version" content="[^"]*">/;
const changed = [];
for (const f of readdirSync(root).filter(f => f.endsWith('.html'))) {
  const file = join(root, f);
  const before = readFileSync(file, 'utf8');
  let html = before.replace(ASSET, (_, a, path, z) => `${a}${path}?v=${version}${z}`);
  if (META.test(html)) html = html.replace(META, `<meta name="be-version" content="${version}">`);
  else html = html.replace(/(<meta charset="[^"]*"\s*\/?>)/i, `$1\n<meta name="be-version" content="${version}">`);
  if (html !== before) { writeFileSync(file, html); changed.push(f); }
}
console.log(`[stamp-version] ${version} → version.json${changed.length ? ', ' + changed.join(', ') : ''}`);
