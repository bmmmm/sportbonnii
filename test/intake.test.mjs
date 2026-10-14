// Club intake: form parsing, slug derivation, the registry checks, hostile
// input, the comment quoting, and the form's options against the taxonomy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseIssueForm, slugify, validate, quoted, renderComment, FIELDS } from '../.github/scripts/club-intake.mjs';
import { validateRegistry } from '../pipeline/registry.mjs';

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

test('a complete suggestion with a calendar becomes one valid, canonical registry entry', async () => {
  const r = await validate({ body: fx('new-club.md'), number: 7, detect: icsFound });
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.deepEqual(r.club, {
    id: 'turnverein-kessenich-1898', name: 'Turnverein Kessenich 1898 e.V.', sports: ['handball', 'turnen'], district: 'Bonn',
    website: 'https://www.tv-kessenich.de/', aliases: ['Turnverein Kessenich 1898 e.V.'], active: true,
    sources: [{ id: 'kalender', type: 'ical', url: 'https://www.tv-kessenich.de/termine.ics' }],
  });
  const doc = JSON.parse(r.clubsJson);
  assert.deepEqual(validateRegistry({ clubs: doc, sports: { sports } }, { texts: { clubs: r.clubsJson } }), []);
  const before = readFileSync(new URL('../registry/clubs.json', import.meta.url), 'utf8');
  assert.equal(doc.clubs.length, JSON.parse(before).clubs.length + 1, 'exactly one entry added');
  assert.ok(!r.clubsJson.includes('vorstand@'), 'the contact never reaches the registry');
  assert.match(r.comment, /Pull Request/);
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
  assert.equal(r.clubsJson, null);
  assert.match(r.problems.join(), /kein lesbarer Kalender/);
  assert.match(r.comment, /fehlt noch etwas/);
});

test('a club already listed is refused, by id and by website host', async () => {
  const dup = fx('new-club.md').replace('Turnverein Kessenich 1898 e.V.', 'BSV Roleber');
  assert.match((await validate({ body: dup, number: 10, detect: icsFound })).problems.join(), /gibt es schon \(Kennung `bsv-roleber`\)/);
  const host = fx('new-club.md').replace('https://www.tv-kessenich.de/', 'https://bsvroleber.de/verein/');
  assert.match((await validate({ body: host, number: 11, detect: icsFound })).problems.join(), /Website bsvroleber\.de\/verein steht schon im Verzeichnis \(BSV Roleber\)/);
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
