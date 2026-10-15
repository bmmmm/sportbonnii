#!/usr/bin/env node
// Gate over the shipped site/ (a port of calqrii's scripts/web-smoke.mjs):
//
//  1. forbidden patterns: no storage, no network outside data.js, no address-bar
//     writes outside state.js, no code from strings, no HTML string sinks, no
//     external resources
//  2. the meta CSP pinned directive by directive, per page
//  3. nothing inline (the CSP would block it silently)
//  4. every src/href relative and present
//  5. the module graph equals PAGE_GRAPH; site/ holds exactly the shipped files
//  6. data.js fetches relative data/ URLs only; state.js writes the address bar
//     in one place, with replaceState (pushState once, for the brand's reset)
//  7. ics.js reproduces the pinned feed
//  8. data/*.json honour the contract (site/data/ when present, else the
//     committed snapshot test/fixtures/site-data/), and the feeds exist
//
// Usage: node scripts/web-smoke.mjs   (exit 1 on any failure)
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const site = join(root, 'site');
const PAGES = { 'index.html': 'app.js' };
// Each page's exact module set. A new import is a one-line change here.
const PAGE_GRAPH = {
  'index.html': ['app.js', 'data.js', 'state.js', 'dates.js', 'table.js', 'calendar.js', 'clubs.js', 'map.js', 'ics.js', 'kinds.js', 'venue.js'],
};
const MODULES = [...new Set(Object.values(PAGE_GRAPH).flat())];
// Shipped modules outside every page graph, until a page imports them.
const OTHER_MODULES = [];
const STATIC = ['index.html', '404.html', 'style.css', 'archivo.woff2', 'favicon.ico', 'robots.txt', 'sitemap.xml'];
const SHIPPED = [...STATIC, ...MODULES, ...OTHER_MODULES];
const NETWORK_MODULE = 'data.js';
const ADDRESS_MODULE = 'state.js';
const CSP = {
  'index.html': [
    ['default-src', "'none'"], ['script-src', "'self'"], ['style-src', "'self'"], ['font-src', "'self'"], ['img-src', "'self' data: https://tile.openstreetmap.org"],
    ['connect-src', "'self'"], ['base-uri', "'none'"], ['form-action', "'none'"],
  ],
  '404.html': [['default-src', "'none'"], ['style-src', "'self'"], ['font-src', "'self'"], ['img-src', "'self'"], ['base-uri', "'none'"], ['form-action', "'none'"]],
};

let failures = 0;
const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };
const ok = (msg) => console.log(`ok   ${msg}`);
const read = (name) => readFileSync(join(site, name), 'utf8');
const stripHtmlComments = (name) => read(name).replace(/<!--[\s\S]*?-->/g, '');
const GAP = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\n]*\n)*`;

// --- 1. forbidden patterns
const textual = SHIPPED.filter((n) => /\.(html|css|js)$/.test(n));
const forbidden = [
  [/localStorage|sessionStorage|indexedDB|document\.cookie|cookieStore|serviceWorker|caches\./, 'storage API'],
  [/history\.(go|back|forward)\b/, 'history navigation'],
  [/history\.(replaceState|pushState)|history\s*\[/, `address-bar write outside ${ADDRESS_MODULE}`, (n) => n !== ADDRESS_MODULE],
  [/location\.(hash|href|search|pathname)\s*=(?!=)/, 'address bar assignment'],
  [/location\.(assign|replace|reload)\s*\(/, 'navigation call'],
  [new RegExp(String.raw`\bimport${GAP}\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon`), 'network or dynamic import'],
  [/\bfetch\b/, `fetch outside ${NETWORK_MODULE}`, (n) => n !== NETWORK_MODULE && n.endsWith('.js')],
  [/\beval\s*\(|new\s+Function\s*\(|setTimeout\(\s*['"`]/, 'code from strings'],
  [/innerHTML|outerHTML|insertAdjacentHTML|document\.write\s*\(|createContextualFragment|DOMParser/, 'HTML string sink'],
  [/<(script|link|img|iframe|source|video|audio)[^>]+(src|href)=["']?(https?:)?\/\//i, 'external resource tag'],
  [/@import|url\(\s*["']?(https?:)?\/\//i, 'external stylesheet resource'],
  [/\.setAttribute\(\s*['"]style['"]|\.style\s*=(?!=)|cssText/, 'inline style write (use style.setProperty)'],
];
for (const name of textual) {
  const src = read(name);
  const hits = forbidden.filter(([re, , applies = () => true]) => applies(name) && re.test(src)).map(([, what]) => what);
  if (hits.length) fail(`${name}: ${hits.join(', ')}`);
}
if (!failures) ok(`${textual.length} shipped text files: no storage, foreign network, address-bar write, HTML sink or external resource`);

// --- 2. CSP, parsed the way a browser reads it
for (const [page, required] of Object.entries(CSP)) {
  const tag = stripHtmlComments(page).match(/<meta\s+http-equiv="Content-Security-Policy"[^>]*?content="([^"]*)"/i);
  if (!tag) { fail(`${page}: no Content-Security-Policy meta tag`); continue; }
  const norm = (v) => v.split(/\s+/).filter(Boolean).sort().join(' ');
  const got = new Map();
  for (const d of tag[1].split(';').map((s) => s.trim()).filter(Boolean)) {
    const [k, ...vals] = d.split(/\s+/);
    if (!got.has(k.toLowerCase())) got.set(k.toLowerCase(), norm(vals.join(' ')));
  }
  const bad = required.filter(([k, v]) => got.get(k) !== norm(v)).map(([k, v]) => `${k} must be "${v}", got "${got.get(k) ?? '(absent)'}"`);
  const extra = [...got.keys()].filter((k) => !required.some(([r]) => r === k));
  if (bad.length || extra.length) fail(`${page} CSP: ${[...bad, ...extra.map((k) => `unexpected directive ${k}`)].join('; ')}`);
  else ok(`${page} CSP pins ${required.map(([k]) => k).join(', ')}`);
}

// --- 3. nothing inline, 4. relative assets that exist
for (const page of Object.keys(CSP)) {
  const html = stripHtmlComments(page);
  const issues = [];
  if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(html)) issues.push('inline <script>');
  if (/\sstyle\s*=/i.test(html)) issues.push('style= attribute');
  if (/\son[a-z]+\s*=/i.test(html)) issues.push('on*= handler');
  if (/<style\b/i.test(html)) issues.push('<style> element');
  if (issues.length) fail(`${page}: ${issues.join(', ')}`);
  else ok(`${page}: no inline script, style or handler`);
  let count = 0;
  let bad = 0;
  for (const m of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
    const ref = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('#')) continue; // links, not assets
    count++;
    if (ref.startsWith('/')) { fail(`${page} references root-absolute ${ref} (Pages serves under /sportbonnii/)`); bad++; continue; }
    if (ref === './') continue;
    if (!existsSync(join(site, ref.split(/[?#]/)[0]))) { fail(`${page} references missing ${ref}`); bad++; }
  }
  if (!count) fail(`${page} references no relative asset — nothing checked`);
  else if (!bad) ok(`${page}: ${count} relative asset references, all present`);
}

// --- 5. module graph and the closed file set
const IMPORT_RES = [
  /\bfrom\s*['"]([^'"]+)['"]|(?:^|[;{})]|\*\/)\s*import\s*['"]([^'"]+)['"]/gm,
  new RegExp(String.raw`\bfrom${GAP}['"]([^'"]+)['"]|(?:^|[;{})]|\*/)\s*import${GAP}['"]([^'"]+)['"]`, 'gm'),
];
const importsOf = (src) => [...new Set(IMPORT_RES.flatMap((re) => [...src.matchAll(re)].map((m) => m[1] ?? m[2])))];
for (const [page, entry] of Object.entries(PAGES)) {
  const scripts = [...stripHtmlComments(page).matchAll(/<script\b[^>]*\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => m[1] ?? m[2]);
  if (!scripts.includes(entry)) fail(`${page} does not load ${entry}`);
  const reached = new Set();
  const queue = [...scripts];
  let bad = 0;
  while (queue.length) {
    const name = queue.shift();
    if (reached.has(name)) continue;
    reached.add(name);
    if (!existsSync(join(site, name))) { fail(`${name} is imported but missing`); bad++; continue; }
    for (const spec of importsOf(read(name))) {
      if (!/^\.\/[a-z0-9-]+\.js$/.test(spec)) { fail(`${name} imports ${JSON.stringify(spec)}: only ./x.js`); bad++; continue; }
      queue.push(spec.slice(2));
    }
  }
  const want = [...PAGE_GRAPH[page]].sort();
  const got = [...reached].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`${page} module graph is ${got.join(', ')}; pinned: ${want.join(', ')}`);
  else if (!bad) ok(`${page} loads exactly its pinned ${want.length} modules`);
}
{
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const rel = relative(site, p);
      if (rel === 'data') continue;
      if (e.isDirectory()) walk(p);
      else files.push(rel);
    }
  };
  walk(site);
  const unknown = files.filter((f) => !SHIPPED.includes(f) && f !== '.DS_Store');
  const missing = SHIPPED.filter((f) => !files.includes(f));
  if (unknown.length || missing.length) fail(`site/ must hold exactly the shipped files — unknown: ${unknown.join(', ') || '–'}; missing: ${missing.join(', ') || '–'}`);
  else ok(`site/ holds exactly the ${SHIPPED.length} shipped files (+ data/)`);
}

// --- 6. the two privileged modules
{
  const data = read(NETWORK_MODULE);
  const calls = [...data.matchAll(/\bfetch\s*\(\s*([`'"])([^`'"]*)/g)];
  const named = (data.match(/\bfetch\b/g) || []).length;
  if (calls.length !== 1 || named !== 1 || !calls[0][2].startsWith('data/')) fail(`${NETWORK_MODULE}: fetch must appear once, with a relative data/ URL`);
  else ok(`${NETWORK_MODULE} fetches relative data/ URLs only`);
  const state = read(ADDRESS_MODULE);
  const writes = (state.match(/history\.replaceState\s*\(/g) || []).length;
  const pushes = (state.match(/history\.pushState\s*\(/g) || []).length;
  const dynamic = (state.match(/history\s*\[/g) || []).length;
  if (writes !== 1 || pushes !== 1 || dynamic) fail(`${ADDRESS_MODULE}: history.replaceState and history.pushState must appear exactly once each, never history[…] (found ${writes}, ${pushes}, ${dynamic})`);
  else ok(`${ADDRESS_MODULE} is the single address-bar writer`);
}

// --- 7. the feed writer reproduces the pinned feed
{
  const { serializeFeed } = await import('../site/ics.js');
  const { FEED_OPTS, SNAPSHOT_EVENTS } = await import('../test/helpers/feed-opts.mjs');
  const want = readFileSync(join(root, 'test/fixtures/ics/alle.ics'), 'utf8');
  if (serializeFeed(SNAPSHOT_EVENTS, FEED_OPTS) !== want) fail('site/ics.js does not reproduce test/fixtures/ics/alle.ics');
  else ok(`site/ics.js reproduces the pinned feed (${Buffer.byteLength(want)} bytes)`);
}

// --- 8. data contract
{
  const { checkSiteData } = await import('../pipeline/contract.mjs');
  const live = existsSync(join(site, 'data', 'events.json'));
  const dir = live ? join(site, 'data') : join(root, 'test/fixtures/site-data');
  const texts = {};
  for (const n of ['events.json', 'status.json', 'clubs.json', 'sports.json', 'meta.json']) {
    if (existsSync(join(dir, n))) texts[n] = readFileSync(join(dir, n), 'utf8');
  }
  const errs = checkSiteData(texts);
  if (errs.length) fail(`${relative(root, dir)}: ${errs.slice(0, 8).join('; ')}${errs.length > 8 ? ` (+${errs.length - 8})` : ''}`);
  else ok(`${relative(root, dir)}/*.json honour the data contract (${JSON.parse(texts['events.json']).events.length} events)`);
  if (live) {
    const sports = JSON.parse(texts['sports.json']).sports.map((s) => `sport-${s.id}.ics`);
    const clubs = JSON.parse(texts['clubs.json']).clubs.map((c) => `verein-${c.id}.ics`);
    const want = ['alle.ics', ...sports, ...clubs];
    const icsDir = join(dir, 'ics');
    const have = existsSync(icsDir) ? readdirSync(icsDir) : [];
    const missing = want.filter((f) => !have.includes(f));
    const empty = want.filter((f) => have.includes(f) && !statSync(join(icsDir, f)).size);
    if (missing.length || empty.length) fail(`site/data/ics: missing ${missing.join(', ') || '–'}, empty ${empty.join(', ') || '–'}`);
    else ok(`site/data/ics holds all ${want.length} feeds`);
  }
}

process.exit(failures ? 1 : 0);
