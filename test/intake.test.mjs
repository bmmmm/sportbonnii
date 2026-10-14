// Club intake: form parsing, slug derivation, the registry checks, hostile
// input, the comment quoting, and the form's options against the taxonomy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseIssueForm, slugify, validate, quoted, renderComment, publishableFiles, FIELDS } from '../.github/scripts/club-intake.mjs';
import { loadRegistry, canonicalJson, REGISTRY_DIR } from '../pipeline/registry.mjs';
import { renderOverview } from '../pipeline/overview.mjs';

const fx = (p) => readFileSync(new URL(`./fixtures/intake/${p}`, import.meta.url), 'utf8');
const sports = JSON.parse(readFileSync(new URL('../registry/sports.json', import.meta.url), 'utf8')).sports;
const noDetect = () => { throw new Error('detect must not run without a calendar URL'); };
const icsFound = async (url) => ({ ok: true, type: 'ical', url, note: 'the URL serves an iCalendar document' });
const nothing = async (url) => ({ ok: false, diagnosis: `could not find a supported calendar at ${url}` });

test('a real form body parses, "_No response_" is empty', () => {
  const f = parseIssueForm(fx('new-club.md'));
  assert.equal(f[FIELDS.name], 'Turnverein Kessenich 1898 e.V.');
  assert.equal(f[FIELDS.sports], 'Handball, Turnen & Gymnastik');
  assert.equal(f[FIELDS.contact], 'vorstand@tv-kessenich.de');
  assert.match(f[FIELDS.consent], /^- \[X\]/);
  assert.deepEqual(parseIssueForm('### Kontakt\n\n_No response_\n\n### Website\n\nhttps://x.example/'), { Kontakt: '', Website: 'https://x.example/' });
});

test('slugs: umlauts transliterated, e.V. dropped, single hyphens', () => {
  assert.equal(slugify('Turnverein Kessenich 1898 e.V.'), 'turnverein-kessenich-1898');
  assert.equal(slugify('Ruder-Club Ägir Bonn'), 'ruder-club-aegir-bonn');
  assert.equal(slugify('ÖTV  Süd/Straße'), 'oetv-sued-strasse');
  assert.equal(slugify('Café Olé!'), 'cafe-ole');
  assert.equal(slugify('!!!'), '');
});

test('a complete suggestion with a calendar becomes a new, valid, canonical club file plus the regenerated overview', async () => {
  const r = await validate({ body: fx('new-club.md'), number: 7, detect: icsFound });
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.deepEqual(r.club, {
    id: 'turnverein-kessenich-1898', name: 'Turnverein Kessenich 1898 e.V.', sports: ['handball', 'turnen'], district: 'Bonn',
    website: 'https://www.tv-kessenich.de/', aliases: ['Turnverein Kessenich 1898 e.V.'], active: true,
    sources: [{ id: 'kalender', type: 'ical', url: 'https://www.tv-kessenich.de/termine.ics' }],
  });
  assert.deepEqual(r.files.map((f) => f.path), ['registry/clubs/turnverein-kessenich-1898.json', 'docs/vereine.md']);
  assert.deepEqual(r.files[0], { path: 'registry/clubs/turnverein-kessenich-1898.json', text: canonicalJson(r.club) });
  assert.deepEqual(publishableFiles(r.files), r.files);
  // Written into a copy of the registry, the club file makes a valid registry with exactly one more club.
  const dir = await mkdtemp(join(tmpdir(), 'sb-intake-'));
  await cp(REGISTRY_DIR, dir, { recursive: true });
  await writeFile(join(dir, r.files[0].path.replace(/^registry\//, '')), r.files[0].text, { flag: 'wx' });
  const grown = await loadRegistry(dir);
  assert.equal(grown.clubs.length, (await loadRegistry()).clubs.length + 1, 'exactly one entry added');
  // The overview is the one of the grown registry — the freshness test stays green on the PR — and lists the new club.
  assert.equal(r.files[1].text, renderOverview(grown));
  assert.ok(r.files[1].text.split('\n').some((l) => l.startsWith('| **Turnverein Kessenich 1898 e.V.**<br>`turnverein-kessenich-1898` |')), 'the new row');
  assert.ok(!r.files[0].text.includes('vorstand@'), 'the contact never reaches the registry');
  assert.match(r.comment, /Pull Request/);
});

test('publish writes nothing but registry/clubs/<slug>.json and docs/vereine.md', () => {
  const file = (path) => ({ path, text: '{}\n' });
  const club = file('registry/clubs/tv-kessenich-1898.json');
  const overview = file('docs/vereine.md');
  assert.doesNotThrow(() => publishableFiles([club, overview]));
  assert.doesNotThrow(() => publishableFiles([overview, club]));
  for (const path of [
    'docs/vereine.md.bak', 'docs/vereine.md\n', 'docs/other.md', 'docs/README.md', 'docs/../README.md', 'docs/sub/vereine.md', '/docs/vereine.md',
    'Docs/vereine.md', 'docs/vereine.mdx', 'xdocs/vereine.md',
    'registry/clubs/../../.github/workflows/club-intake.yml', 'registry/sports.json', 'registry/platforms/x.json',
    '.github/workflows/club-intake.yml', 'registry/clubs/TV.json', 'registry/clubs/a--b.json', 'registry/clubs/a.json\n',
    'registry/clubs/.json', '/registry/clubs/a.json', 'registry/clubs/a.json.bak', 'registry/clubs/a/b.json', undefined,
  ]) assert.throws(() => publishableFiles([club, overview, file(path)]), /refusing to write/, String(path));
  assert.throws(() => publishableFiles([club, file('README.md')]), /refusing to write "README\.md"/, 'one bad path refuses all');
  // The set, not just each path: exactly one club file and the overview, no duplicates.
  assert.throws(() => publishableFiles([club]), /exactly one club file/, 'the overview is missing');
  assert.throws(() => publishableFiles([overview]), /exactly one club file/, 'the club file is missing');
  assert.throws(() => publishableFiles([club, file('registry/clubs/other.json'), overview]), /exactly one club file/, 'two club files');
  assert.throws(() => publishableFiles([club, club]), /exactly one club file/, 'the same club file twice');
  assert.throws(() => publishableFiles([overview, overview]), /exactly one club file/, 'the overview twice');
  assert.throws(() => publishableFiles([]), /nothing to publish/);
  assert.throws(() => publishableFiles(null), /nothing to publish/);
  assert.throws(() => publishableFiles([{ path: 'registry/clubs/ok.json' }, overview]), /no text/);
});

test('without a calendar URL: an entry with no sources, detection not run', async () => {
  const body = fx('new-club.md').replace('https://www.tv-kessenich.de/termine.ics', '_No response_').replace('### Stadtbezirk\n\nBonn', '### Stadtbezirk\n\nWeiß nicht');
  const r = await validate({ body, number: 8, detect: noDetect });
  assert.equal(r.ok, true);
  assert.deepEqual(r.club.sources, []);
  assert.equal(r.club.district, undefined);
});

test('an undetectable calendar asks for more information, no PR', async () => {
  const r = await validate({ body: fx('new-club.md'), number: 9, detect: nothing });
  assert.equal(r.ok, false);
  assert.equal(r.files, null);
  assert.match(r.problems.join(), /kein lesbarer Kalender/);
  assert.match(r.comment, /fehlt noch etwas/);
});

test('a club already listed is refused, by id and by website host', async () => {
  const dup = fx('new-club.md').replace('Turnverein Kessenich 1898 e.V.', 'BSV Roleber');
  assert.match((await validate({ body: dup, number: 10, detect: icsFound })).problems.join(), /gibt es schon \(Kennung `bsv-roleber`\)/);
  const host = fx('new-club.md').replace('https://www.tv-kessenich.de/', 'https://bsvroleber.de/verein/');
  assert.match((await validate({ body: host, number: 11, detect: icsFound })).problems.join(), /Website bsvroleber\.de\/verein steht schon im Verzeichnis \(BSV Roleber\)/);
});

test('a department is refused: by its name, by a listed parent, by a subdomain', async () => {
  const body = (name, parent = '_No response_', website = 'https://www.tv-kessenich.de/') => fx('new-club.md')
    .replace('Turnverein Kessenich 1898 e.V.', name).replace('### Abteilung von\n\n_No response_', `### Abteilung von\n\n${parent}`)
    .replace('https://www.tv-kessenich.de/', website);
  const department = /„SSF Dragons Bonn“ sieht nach einer Abteilung von SSF Bonn aus\. Abteilungen stehen beim Verein – fehlt dort eine Sportart oder ein Kalender, ergänzt das Projekt sie von Hand\./;
  const cases = [
    ['name with the club in front', body('SSF Bonn Tischtennis'), /„SSF Bonn Tischtennis“ sieht nach einer Abteilung von SSF Bonn aus/],
    ['parent listed by name', body('SSF Dragons Bonn', 'SSF Bonn e.V.'), department],
    ['parent listed by alias', body('SSF Dragons Bonn', 'Schwimm- und Sportfreunde Bonn'), department],
    ['website on a subdomain', body('Lacrosse Bonn', undefined, 'https://lacrosse.ssfbonn.de/'), /Website lacrosse\.ssfbonn\.de steht schon im Verzeichnis \(SSF Bonn\)\. Abteilungen stehen beim Verein/],
    ['a listed club reads like a department of the suggestion', body('Rugby Club'), /Rugby Club Bonn-Rhein-Sieg \(Kennung `rc-bonn-rhein-sieg`\) sieht nach einer Abteilung von „Rugby Club“ aus/],
    ['the same club under an alias', body('Schwimm- und Sportfreunde Bonn e.V.'), /Den Verein gibt es schon: SSF Bonn \(Kennung `ssf-bonn`\)\./],
    ['a parent with markup', body('SSF Dragons Bonn', 'SSF <b>Bonn</b>'), /Der Name unter „Abteilung von“ enthält Zeichen/],
  ];
  for (const [what, text, want] of cases) {
    const r = await validate({ body: text, number: 14, detect: icsFound });
    assert.equal(r.ok, false, what);
    assert.equal(r.files, null, what);
    assert.match(r.problems.join('\n'), want, what);
  }
});

test('a department of a club not yet listed becomes the club\'s entry', async () => {
  const body = fx('new-club.md').replace('Turnverein Kessenich 1898 e.V.', 'TV Kessenich Handball')
    .replace('### Abteilung von\n\n_No response_', '### Abteilung von\n\nTurnverein Kessenich 1898 e.V.');
  const r = await validate({ body, number: 15, detect: icsFound });
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.equal(r.club.id, 'turnverein-kessenich-1898');
  assert.equal(r.club.name, 'Turnverein Kessenich 1898 e.V.');
  assert.deepEqual(r.club.aliases, ['Turnverein Kessenich 1898 e.V.', 'TV Kessenich Handball']);
  assert.deepEqual(r.files.map((f) => f.path), ['registry/clubs/turnverein-kessenich-1898.json', 'docs/vereine.md']);
});

test('a bare department name never becomes an alias of its club', async () => {
  const body = (name) => fx('new-club.md').replace('Turnverein Kessenich 1898 e.V.', name)
    .replace('### Abteilung von\n\n_No response_', '### Abteilung von\n\nPost SV Bonn');
  for (const name of ['Tischtennis', 'Tischtennis Bonn', 'Bonner Tischtennis']) {
    const r = await validate({ body: body(name), number: 16, detect: icsFound });
    assert.equal(r.ok, true, r.problems.join('; '));
    assert.deepEqual(r.club.aliases, ['Post SV Bonn'], name);
  }
  const r = await validate({ body: body('Post SV Tischtennis'), number: 17, detect: icsFound });
  assert.deepEqual(r.club.aliases, ['Post SV Bonn', 'Post SV Tischtennis']);
});

test('websites: http is accepted, a shared host counts per path', async () => {
  const http = fx('new-club.md').replace('https://www.tv-kessenich.de/', 'http://www.tv-kessenich.de/');
  assert.equal((await validate({ body: http, number: 13, detect: icsFound })).ok, true);
  const shared = (path) => ({ clubs: [{ id: 'a', name: 'A', sports: ['rugby'], website: `https://sites.google.com${path}`, sources: [] }], platforms: [] });
  const { buildEntry } = await import('../.github/scripts/club-intake.mjs');
  const form = parseIssueForm(fx('new-club.md').replace('https://www.tv-kessenich.de/', 'https://sites.google.com/view/tvk/'));
  const other = await buildEntry(form, { clubsDoc: shared('/view/another-club'), sportsDoc: { sports }, detect: icsFound });
  assert.deepEqual(other.problems, []);
  const same = await buildEntry(form, { clubsDoc: shared('/view/tvk'), sportsDoc: { sports }, detect: icsFound });
  assert.match(same.problems.join(), /steht schon/);
});

test('hostile input: injection attempts never become an entry and stay fenced in the comment', async () => {
  const r = await validate({ body: fx('hostile.md'), number: 12, detect: nothing });
  assert.equal(r.ok, false);
  const text = r.problems.join('\n');
  assert.match(text, /Zeichen, die in einem Namen nicht vorkommen/);
  assert.match(text, /Unbekannte Sportart/);
  assert.match(text, /vollständige Adresse/);
  assert.match(text, /bestätigen/);
  // The longest backtick run in the problems decides the fence: the user text cannot close it.
  const body = r.comment;
  const fence = /^(`{3,})$/m.exec(body)[1];
  const inner = body.split(fence)[1];
  assert.ok(!inner.includes(fence), 'no backtick run inside reaches the fence length');
  assert.ok(fence.length > 5, 'the echoed sport name carries five backticks, so the fence grew past them');
  assert.ok(!body.includes('onerror') && !body.includes('rm -rf'), 'the hostile name is not echoed at all');
});

test('quoted(): the fence outgrows any backtick run', () => {
  assert.equal(quoted('a'), '```\na\n```');
  assert.equal(quoted('x ````` y').split('\n')[0], '``````');
  assert.match(renderComment({ ok: false, problems: ['@everyone <script>'] }), /```\n- @everyone <script>\n```/);
});

test('the issue form offers exactly the taxonomy and the four districts', () => {
  const form = readFileSync(new URL('../.github/ISSUE_TEMPLATE/verein-hinzufuegen.yml', import.meta.url), 'utf8');
  const block = (id) => form.split(`id: ${id}\n`)[1].split('\n  - type:')[0];
  const options = (id) => [...block(id).matchAll(/^ {8}- "?([^"\n]+?)"?$/gm)].map((m) => m[1]);
  assert.deepEqual(options('sports'), sports.map((s) => s.label));
  assert.ok(sports.every((s) => !s.label.includes(', ')), 'labels must not contain ", " (the form joins choices with it)');
  assert.deepEqual(options('district'), ['Weiß nicht', 'Bonn', 'Bad Godesberg', 'Beuel', 'Hardtberg']);
  for (const label of Object.values(FIELDS)) assert.ok(form.includes(`label: ${label}`) || form.includes(`label: "${label}"`), `form label ${label}`);
  assert.match(form, /labels: \[verein-vorschlag\]/);
});

test('the workflow keeps user text out of run lines and the token out of validate', () => {
  const wf = readFileSync(new URL('../.github/workflows/club-intake.yml', import.meta.url), 'utf8');
  for (const line of wf.split('\n').filter((l) => /^\s+run:/.test(l))) assert.doesNotMatch(line, /\$\{\{/, line);
  const validateStep = wf.split('- name: Validate')[1].split('- name:')[0];
  assert.doesNotMatch(validateStep, /GH_TOKEN|secrets\./);
  assert.match(wf, /^permissions: \{\}$/m);
  assert.match(wf, /if: vars\.INTAKE_ENABLED == 'true'/, 'dormant until switched on');
  assert.match(wf, /^ {4}types: \[opened, edited\]$/m, 'the form label must not start a second run (no labeled trigger)');
  assert.match(wf, /persist-credentials: false/);
});
