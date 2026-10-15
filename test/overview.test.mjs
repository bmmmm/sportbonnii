// The club overview docs/vereine.md: pinned to the registry, escaped, ordered
// by id, and written only when it changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderOverview, escapeMarkdown } from '../pipeline/overview.mjs';
import { loadRegistry, writeOverview, OVERVIEW_PATH } from '../pipeline/registry.mjs';

const sports = [
  { id: 'handball', label: 'Handball' },
  { id: 'tischtennis', label: 'Tischtennis' },
  { id: 'sonstiges', label: 'Sonstiges' },
];
const club = (over = {}) => ({ id: 'tv-x', name: 'TV X', sports: ['handball'], website: 'https://www.tv-x.example/', sources: [], ...over });
const rows = (text) => text.split('\n').filter((l) => l.startsWith('| **'));

test('the committed docs/vereine.md is the overview of the registry — run `pnpm run registry:fmt`', async () => {
  assert.equal(readFileSync(OVERVIEW_PATH, 'utf8'), renderOverview(await loadRegistry()));
});

test('the overview follows the registry: a renamed club makes the committed file stale', async () => {
  const reg = await loadRegistry();
  const renamed = { ...reg, clubs: reg.clubs.map((c, i) => (i === 0 ? { ...c, name: `${c.name} Neu` } : c)) };
  assert.notEqual(renderOverview(renamed), readFileSync(OVERVIEW_PATH, 'utf8'));
});

test('title, notice, statistics, the department rule and one row per club', () => {
  const text = renderOverview({
    clubs: [club(), club({ id: 'a', name: 'A', website: 'https://a.example/', sources: [{ id: 's', type: 'ical', url: 'https://a.example/x.ics' }] })],
    sports,
  });
  assert.match(text, /^# Vereine in Bonn\n/);
  assert.match(text, /`pnpm run registry:fmt` – nicht von Hand ändern/);
  assert.match(text, /\n2 Vereine · 1 mit Online-Kalender · 1 Sportarten\n/);
  assert.match(text, /Abteilungen stehen beim Verein, nie als eigener Eintrag/);
  assert.equal(rows(text).length, 2);
  assert.ok(text.endsWith('|\n'), 'one trailing newline');
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(text), 'no date');
});

test('clubs are ordered by id, not by name or file name', () => {
  const text = renderOverview({ clubs: [club({ id: 'bonn-x', name: 'A' }), club({ id: 'bonn', name: 'Z' })], sports });
  assert.deepEqual(rows(text).map((r) => r.match(/`([^`]+)`/)[1]), ['bonn', 'bonn-x']);
});

test('departments are the club\'s sports, in taxonomy order; missing fields show a dash', () => {
  const [row] = rows(renderOverview({ clubs: [club({ sports: ['sonstiges', 'tischtennis', 'handball'] })], sports }));
  assert.equal(row, '| **TV X**<br>`tv-x` | Handball, Tischtennis, Sonstiges | – | – | – | [tv-x.example](https://www.tv-x.example/) |');
});

test('calendars: type labels, disabled sources, repeats; the statistic counts enabled ones only', () => {
  const src = (type, over = {}) => ({ id: 's', type, url: 'https://x.example/', ...over });
  const text = renderOverview({
    clubs: [
      club({ id: 'a', name: 'A', website: 'https://a.example/', sources: [src('ical'), src('tec'), src('gancio'), src('jsonld'), src('rss')] }),
      club({ id: 'b', name: 'B', website: 'https://b.example/', sources: [src('ical', { enabled: false })] }),
      club({ id: 'c', name: 'C', website: 'https://c.example/', sources: [src('ical'), src('ical')] }),
    ],
    sports,
  });
  const [a, b, c] = rows(text);
  assert.match(a, /\| iCal, TEC, Gancio, schema\.org, RSS \|/);
  assert.match(b, /\| iCal \(aus\) \|/);
  assert.match(c, /\| iCal ×2 \|/);
  assert.match(text, /3 Vereine · 2 mit Online-Kalender/);
});

test('venues: at most three, use prefix, OpenStreetMap link; none → dash', () => {
  const v = (name, extra = {}) => ({ name, lat: 50.7, lon: 7.1, ...extra });
  const [row] = rows(renderOverview({
    clubs: [club({ venues: [v('Halle', { use: 'spiel', osm: 'way/12' }), v('Platz', { use: 'training' }), v('Beides'), v('Vierte')] })],
    sports,
  }));
  assert.ok(row.includes('Spiele: [Halle](https://www.openstreetmap.org/way/12)<br>Training: [Platz](https://www.openstreetmap.org/?mlat=50.7&mlon=7.1#map=18/50.7/7.1)<br>[Beides]('), row);
  assert.ok(!row.includes('Vierte'), 'a fourth venue is not shown');
});

test('Markdown characters in foreign text are escaped, one line per cell', () => {
  assert.equal(escapeMarkdown('a|b [c] *d* _e_ <f> `g` \\h'), 'a\\|b \\[c\\] \\*d\\* \\_e\\_ \\<f\\> \\`g\\` \\\\h');
  assert.equal(escapeMarkdown('a\n\nb'), 'a b');
  // GitHub autolinks bare www. and scheme:// text; a backslash keeps it plain (checked on GitHub's GFM render).
  assert.equal(escapeMarkdown('Infos: www.tv-x.de, WWW.Y.DE'), 'Infos: www\\.tv-x.de, WWW\\.Y.DE');
  assert.equal(escapeMarkdown('siehe https://x.de/a und http://y.de'), 'siehe https\\://x.de/a und http\\://y.de');
  assert.equal(escapeMarkdown('awww.x.de 10:30'), 'awww.x.de 10:30', 'no autolink, no escape');
  // An e-mail address is autolinked whatever is escaped; a code span keeps it plain and copies clean.
  assert.equal(escapeMarkdown('Kontakt: info@tv-x.de, a.b_c@x-y.example.org | *x*'), 'Kontakt: `info@tv-x.de`, `a.b_c@x-y.example.org` \\| \\*x\\*');
  assert.equal(escapeMarkdown('Treff @ Halle, x@y'), 'Treff @ Halle, x@y', 'no address, no code');
  const text = renderOverview({
    clubs: [club({ name: 'A | B *x*', venues: [{ name: 'Halle [1]', lat: 50.7, lon: 7.1 }], website: 'https://x.example/a)b c' })],
    sports,
  });
  const [row] = rows(text);
  assert.ok(row.startsWith('| **A \\| B \\*x\\***<br>'), row);
  assert.ok(row.includes('[Halle \\[1\\]]('), row);
  assert.ok(row.includes('(https://x.example/a%29b%20c)'), row);
  assert.equal(row.split(/(?<!\\)\|/).length, 8, 'six cells: an escaped pipe does not split the row');
});

test('platforms follow the clubs in their own table; none → no section', () => {
  const reg = { clubs: [club()], sports };
  assert.ok(!renderOverview(reg).includes('## Plattformen'));
  const text = renderOverview({ ...reg, platforms: [{ id: 'p', name: 'P', website: 'https://p.example/', sources: [{ id: 's', type: 'gancio', url: 'https://p.example/api' }] }] });
  assert.match(text, /\n## Plattformen\n[\s\S]*\| \*\*P\*\*<br>`p` \| Gancio \| \[p\.example\]\(https:\/\/p\.example\/\) \|\n$/);
});

test('writeOverview writes only when the text changes and creates the directory', async () => {
  const reg = await loadRegistry();
  const file = join(await mkdtemp(join(tmpdir(), 'sb-overview-')), 'docs', 'vereine.md');
  assert.equal(await writeOverview(reg, file), true);
  assert.equal(await readFile(file, 'utf8'), renderOverview(reg));
  assert.equal(await writeOverview(reg, file), false);
  await writeFile(file, 'stale\n');
  assert.equal(await writeOverview(reg, file), true);
});

test('overview.mjs imports only relative modules (the intake bot runs without install)', () => {
  const src = readFileSync(new URL('../pipeline/overview.mjs', import.meta.url), 'utf8');
  const specs = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(specs, ['../site/venue.js']);
});
