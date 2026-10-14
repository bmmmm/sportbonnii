// Registry validator, canonical form, colour contrast, and the committed
// site-data snapshot that freezes the pipeline → page contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateRegistry, loadRegistry, readRegistry, formatRegistry, canonicalJson, relativeLuminance, LUMINANCE, DISTRICTS, REGISTRY_DIR,
  nameKey, sameSite, departmentConflict,
} from '../pipeline/registry.mjs';
import { checkSiteData } from '../pipeline/contract.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const committed = await readRegistry();
const { texts } = committed;
const docs = () => structuredClone(committed.docs);

/** A scratch copy of the committed registry directory. */
async function registryCopy() {
  const dir = await mkdtemp(join(tmpdir(), 'sb-registry-'));
  await cp(REGISTRY_DIR, dir, { recursive: true });
  return dir;
}

test('the committed registry is valid and canonical', async () => {
  assert.deepEqual(validateRegistry(docs(), { texts }), []);
  const reg = await loadRegistry();
  assert.ok(reg.clubs.length >= 9);
  assert.equal(reg.platforms[0].id, 'bonn-jetzt');
  assert.deepEqual(texts.files.map((f) => f.path), [...reg.clubs.map((c) => `clubs/${c.id}.json`), ...reg.platforms.map((p) => `platforms/${p.id}.json`)]);
});

test('every sport colour keeps 3:1 against #fff and #121212', () => {
  const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  for (const s of docs().sports.sports) {
    const l = relativeLuminance(s.colour);
    assert.ok(l >= LUMINANCE.min && l <= LUMINANCE.max, `${s.id} ${s.colour} luminance ${l}`);
    assert.ok(contrast(l, 1) >= 3, `${s.id} vs white`);
    assert.ok(contrast(l, relativeLuminance('#121212')) >= 3, `${s.id} vs dark`);
  }
});

test('luminance band: a too-light and a too-dark colour are refused', () => {
  for (const colour of ['#f0f0f0', '#101010']) {
    const d = docs();
    d.sports.sports[0].colour = colour;
    assert.match(validateRegistry(d).join('\n'), /luminance/);
  }
});

/** Applies `mutate` to fresh documents and returns the joined error text. */
function errorsAfter(mutate) {
  const d = docs();
  mutate(d.clubs, d.sports);
  return validateRegistry(d).join('\n');
}

/** A minimal club for the one-club-one-entry mutants. */
const club = (id, name, website = `https://${id}.example/`) => ({ id, name, sports: ['tischtennis'], website, sources: [] });
const DEPARTMENT = /clubs\[\d+\] \(ssf-tt\): "SSF Bonn Tischtennis" looks like a department of ssf-bonn \("SSF Bonn"\) — a department is a sport in ssf-bonn's sports/;

test('each rule goes red on its own mutant', () => {
  const cases = [
    ['duplicate club id', (c) => { c.clubs[1].id = c.clubs[0].id; }, /duplicate id/],
    ['club id shared with a platform', (c) => { c.platforms[0].id = c.clubs[0].id; }, /duplicate id/],
    ['non-slug id', (c) => { c.clubs[0].id = 'Bonn Gamecocks'; }, /lowercase slug/],
    ['double hyphen', (c) => { c.clubs[0].id = 'bonn--gamecocks'; }, /lowercase slug/],
    ['unknown sport', (c) => { c.clubs[0].sports = ['quidditch']; }, /unknown sport "quidditch"/],
    ['no sport', (c) => { c.clubs[0].sports = []; }, /at least one sport/],
    ['bad district', (c) => { c.clubs[0].district = 'Köln'; }, /district must be one of/],
    ['missing website', (c) => { delete c.clubs[0].website; }, /website must be/],
    ['unknown field (typo)', (c) => { c.clubs[0].webiste = 'https://x.de/'; }, /unknown field "webiste"/],
    ['missing sources', (c) => { delete c.clubs[0].sources; }, /sources must be an array/],
    ['http source url', (c) => { c.clubs.find((x) => x.sources.length).sources[0].url = 'http://example.org/x.ics'; }, /must be an https URL/],
    ['unknown adapter type', (c) => { c.clubs.find((x) => x.sources.length).sources[0].type = 'csv'; }, /type must be one of/],
    ['duplicate source id', (c) => { const k = c.clubs.find((x) => x.sources.length); k.sources.push({ ...k.sources[0] }); }, /duplicate source id/],
    ['source sport outside the club', (c) => { const k = c.clubs.find((x) => x.id === 'bsv-roleber'); k.sources[0].sports = ['rugby']; }, /not one of the club's sports/],
    ['tagMap to unknown sport', (c) => { c.platforms[0].sources[0].tagMap.Fahrrad = 'bmx'; }, /unknown sport "bmx"/],
    ['enabled not boolean', (c) => { c.platforms[0].sources[0].enabled = 'yes'; }, /enabled must be true or false/],
    ['duplicate sport id', (_, s) => { s.sports[1].id = s.sports[0].id; }, /duplicate sport id/],
    ['catch-all removed', (_, s) => { s.sports = s.sports.filter((x) => x.id !== 'sonstiges'); }, /sonstiges/],
    ['uppercase keyword', (_, s) => { s.sports[0].keywords = ['Fußball']; }, /keywords must be lowercase/],
    ['alias of another club', (c) => { c.clubs[1].aliases.push(c.clubs[0].aliases[0]); }, /\(bonner-sc\): "Bonn Gamecocks" is also a name of bonn-gamecocks/],
    ['same name but for case, accents and e.V.', (c) => { c.clubs.push(club('ssf-zwei', 'SSF BONN e.V.')); }, /\(ssf-zwei\): "SSF BONN e\.V\." is also a name of ssf-bonn \("SSF Bonn"\)/],
    ['department after its club', (c) => { c.clubs.push(club('ssf-tt', 'SSF Bonn Tischtennis')); }, DEPARTMENT],
    ['department before its club', (c) => { c.clubs.unshift(club('ssf-tt', 'SSF Bonn Tischtennis')); }, DEPARTMENT],
    ['department of a platform', (c) => { c.clubs.push(club('bj-lauf', 'bonn.jetzt Lauftreff')); }, /\(bj-lauf\): "bonn\.jetzt Lauftreff" looks like a department of bonn-jetzt/],
    ['website on a subdomain of a club', (c) => { c.clubs.push(club('lacrosse', 'Lacrosse Bonn', 'https://lacrosse.ssfbonn.de/')); }, /\(lacrosse\): website https:\/\/lacrosse\.ssfbonn\.de\/ is the site of ssf-bonn/],
  ];
  for (const [name, mutate, want] of cases) assert.match(errorsAfter(mutate), want, name);
});

test('one club, one entry: what stays valid', () => {
  // A hyphen is part of the name: "Rugby Bonn-Rhein-Sieg" is no department of "Rugby Bonn" (both listed today).
  const reg = docs().clubs;
  const [thv, rc] = ['bonner-thv', 'rc-bonn-rhein-sieg'].map((id) => reg.clubs.find((c) => c.id === id));
  assert.ok(thv.aliases.includes('Rugby Bonn') && rc.aliases.includes('Rugby Bonn-Rhein-Sieg'));
  assert.equal(departmentConflict(rc, [thv]), null);
  // Shared hosting: the same host with different paths is two clubs.
  assert.equal(errorsAfter((c) => { c.clubs.push(club('tt-a', 'TT A', 'https://sites.google.com/view/tt-a'), club('tt-b', 'TT B', 'https://sites.google.com/view/tt-b')); }), '');
  // A department with its own words in front is no prefix match.
  assert.equal(errorsAfter((c) => { c.clubs.push(club('tt-ssf', 'Tischtennis SSF Bonn')); }), '');
});

test('nameKey: accents, ß, case, e.V. and punctuation do not tell names apart', () => {
  assert.equal(nameKey('Turnverein Kessenich 1898 e.V.'), 'turnverein kessenich 1898');
  assert.equal(nameKey('GROẞE  Straße e. V.'), 'grosse strasse');
  assert.equal(nameKey('Bönnsche Sterntaucher'), 'bonnsche sterntaucher');
  assert.equal(nameKey('HSG Geislar/Oberkassel'), nameKey('HSG Geislar Oberkassel'));
  assert.equal(nameKey('bonn.jetzt'), 'bonn jetzt');
  assert.equal(nameKey('Rugby Bonn-Rhein-Sieg'), 'rugby bonn-rhein-sieg');
  assert.equal(nameKey(' !!! '), '');
});

test('sameSite: a subdomain is the club, a shared host is not', () => {
  assert.equal(sameSite('https://lacrosse.ssfbonn.de/', 'https://ssfbonn.de/'), true);
  assert.equal(sameSite('https://ssfbonn.de/', 'https://www.lacrosse.ssfbonn.de/team'), true);
  assert.equal(sameSite('http://www.ssfbonn.de', 'https://ssfbonn.de/verein/'), true);
  assert.equal(sameSite('https://sites.google.com/view/a', 'https://sites.google.com/view/b'), false);
  assert.equal(sameSite('https://sites.google.com/view/a/termine', 'https://sites.google.com/view/a'), true);
  assert.equal(sameSite('https://a.github.io/', 'https://b.github.io/'), false);
  assert.equal(sameSite('https://notssfbonn.de/', 'https://ssfbonn.de/'), false);
  assert.equal(sameSite('javascript:alert(1)', 'https://ssfbonn.de/'), false);
  assert.equal(sameSite(undefined, 'https://ssfbonn.de/'), false);
});

test('files: a misnamed or non-canonical club file and unsorted sports keys are refused', () => {
  const withFile = (i, change) => ({ ...texts, files: texts.files.map((f, j) => (j === i ? { ...f, ...change } : f)) });
  const i = texts.files.findIndex((f) => f.path === 'clubs/bsv-roleber.json');
  assert.match(validateRegistry(docs(), { texts: withFile(i, { path: 'clubs/roleber.json' }) }).join(),
    /clubs\/roleber\.json: the file must be named after its id \(clubs\/bsv-roleber\.json\)/);
  assert.match(validateRegistry(docs(), { texts: withFile(i, { path: 'platforms/bsv-roleber.json' }) }).join(), /named after its id/);
  const compact = JSON.stringify(texts.files[i].doc);
  assert.match(validateRegistry(docs(), { texts: withFile(i, { text: compact }) }).join(), /clubs\/bsv-roleber\.json is not in canonical form/);
  const unsortedKeys = texts.sports.replace('"colour": "#208a44",\n      "emoji": "⚽",', '"emoji": "⚽",\n      "colour": "#208a44",');
  assert.notEqual(unsortedKeys, texts.sports);
  assert.match(validateRegistry(docs(), { texts: { sports: unsortedKeys } }).join(), /sports.json is not in canonical form/);
});

test('readRegistry: id order (not file names), only *.json, platforms/ optional', async () => {
  const dir = await registryCopy();
  const club = (id) => ({ active: true, id, name: `Testverein ${id}`, sources: [], sports: ['rugby'], website: `https://${id}.example/` });
  // 'bonn-x.json' sorts before 'bonn.json' ('-' < '.'), yet the id 'bonn' comes first.
  for (const id of ['bonn-x', 'bonn']) await writeFile(join(dir, 'clubs', `${id}.json`), canonicalJson(club(id)));
  await writeFile(join(dir, 'clubs', 'README.txt'), 'not a club');
  await rm(join(dir, 'platforms'), { recursive: true });
  const { docs: d, texts: t } = await readRegistry(dir);
  const ids = d.clubs.clubs.map((c) => c.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.ok(ids.indexOf('bonn') < ids.indexOf('bonn-x'));
  assert.deepEqual(t.files.map((f) => f.doc.id), ids);
  assert.deepEqual(d.clubs.platforms, []);
  const reg = await loadRegistry(dir);
  assert.equal(reg.clubs.length, docs().clubs.clubs.length + 2);
});

test('readRegistry: broken JSON names the file; a club id twice across clubs/ and platforms/ is refused', async () => {
  const broken = await registryCopy();
  await writeFile(join(broken, 'clubs', 'bsv-roleber.json'), '{ "id": "bsv-roleber", }\n');
  await assert.rejects(readRegistry(broken), /invalid registry: clubs\/bsv-roleber\.json is not valid JSON/);
  const twice = await registryCopy();
  const platform = { id: 'bsv-roleber', name: 'Roleber-Plattform', sources: [], website: 'https://plattform.example/' };
  await writeFile(join(twice, 'platforms', 'bsv-roleber.json'), canonicalJson(platform));
  await assert.rejects(loadRegistry(twice), /platforms\[\d+\] \(bsv-roleber\): duplicate id "bsv-roleber"/);
});

test('registry:fmt rewrites a file canonically in place and never renames one', async () => {
  const dir = await registryCopy();
  const path = join(dir, 'clubs', 'bsv-roleber.json');
  const before = await readFile(path, 'utf8');
  await writeFile(path, JSON.stringify(JSON.parse(before)));
  await rename(join(dir, 'clubs', 'ssf-bonn.json'), join(dir, 'clubs', 'ssf.json'));
  assert.deepEqual(await formatRegistry(dir), ['clubs/bsv-roleber.json']);
  assert.equal(await readFile(path, 'utf8'), before);
  await assert.rejects(loadRegistry(dir), (e) => {
    assert.match(e.message, /clubs\/ssf\.json: the file must be named after its id \(clubs\/ssf-bonn\.json\)/);
    assert.doesNotMatch(e.message, /bsv-roleber/);
    return true;
  });
});

test('districts are the four Stadtbezirke', () => {
  assert.deepEqual(DISTRICTS, ['Bonn', 'Bad Godesberg', 'Beuel', 'Hardtberg']);
});

test('the site-data snapshot honours the data contract', () => {
  const files = {};
  for (const n of ['events.json', 'status.json', 'clubs.json', 'sports.json', 'meta.json']) files[n] = read(`test/fixtures/site-data/${n}`);
  assert.deepEqual(checkSiteData(files), []);
  // A timestamp anywhere but meta.json breaks byte-stable output.
  const stamped = { ...files, 'status.json': files['status.json'].replace('{\n', '{\n  "generatedAt": "2026-10-14",\n') };
  assert.match(checkSiteData(stamped).join(), /timestamp/);
  // A disabled source has no news date and no validators.
  const disabled = { ...files, 'status.json': files['status.json'].replace('"bonner-sc/spieltage": {\n', '"bonner-sc/spieltage": {\n    "changed": "2026-10-01",\n') };
  assert.notEqual(disabled['status.json'], files['status.json']);
  assert.match(checkSiteData(disabled).join(), /disabled but carries/);
  // Order is part of the contract.
  const lines = files['events.json'].split('\n');
  const swapped = [lines[0], lines[2].replace(/,$/, ''), lines[1].replace(/,$/, ''), ...lines.slice(3)];
  swapped[1] += ',';
  swapped[2] += ',';
  assert.match(checkSiteData({ ...files, 'events.json': swapped.join('\n') }).join(), /not sorted/);
});
