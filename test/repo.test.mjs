// Repository policy: pnpm-only install, pinned package manager, licence, and
// no machine-local paths or private hostnames in any tracked file (the
// pre-push leak gate refuses the GitHub push otherwise — this fails earlier).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('package.json pins pnpm with a hash and blocks npm/yarn installs', () => {
  assert.match(pkg.packageManager, /^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/);
  assert.match(pkg.scripts.preinstall, /npm_config_user_agent/);
  assert.match(pkg.scripts.preinstall, /startsWith\('pnpm\/'\)/);
  assert.equal(pkg.engines.node, '>=22');
  assert.equal(pkg.license, 'GPL-3.0-or-later');
  assert.equal(pkg.type, 'module');
});

test('pnpm-workspace.yaml keeps the release cooldown and allows no build scripts', () => {
  const ws = readFileSync(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8');
  assert.match(ws, /^minimumReleaseAge: 4320\b/m);
  assert.match(ws, /^allowBuilds: \{\}$/m);
});

test('the only runtime dependency is ical.js', () => {
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['ical.js']);
  assert.equal(pkg.devDependencies, undefined);
});

/** Tracked plus untracked-but-not-ignored files; a plain walk when git refuses (CI containers, dubious ownership). */
function repoFiles() {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8').split('\0').filter(Boolean);
  } catch {
    const skip = new Set(['.git', 'node_modules', '.claude']);
    const out = [];
    const walk = (dir) => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (skip.has(e.name) || rel === 'site/data') continue;
        if (e.isDirectory()) walk(rel);
        else out.push(rel);
      }
    };
    walk('');
    return out;
  }
}

test('no tracked file names a home directory or the private forge host', () => {
  const files = repoFiles();
  assert.ok(files.length > 10, `git ls-files listed only ${files.length} files`);
  // Built from parts so this file does not match itself.
  const patterns = [new RegExp(['/Us', 'ers/'].join('')), new RegExp(['git', '6bm', 'de'].join('\\.'))];
  const hits = [];
  for (const f of files) {
    let text;
    try { text = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'); } catch { continue; }
    for (const re of patterns) if (re.test(text)) hits.push(`${f}: ${re}`);
  }
  assert.deepEqual(hits, []);
});
