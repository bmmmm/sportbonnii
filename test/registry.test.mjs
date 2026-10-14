// Registry validator, canonical form, colour contrast, and the committed
// site-data snapshot that freezes the pipeline → page contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateRegistry, loadRegistry, canonicalJson, canonicalClubs, relativeLuminance, LUMINANCE, DISTRICTS,
} from '../pipeline/registry.mjs';
import { checkSiteData } from '../pipeline/contract.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const texts = { clubs: read('registry/clubs.json'), sports: read('registry/sports.json') };
const docs = () => ({ clubs: JSON.parse(texts.clubs), sports: JSON.parse(texts.sports) });

test('the committed registry is valid and canonical', async () => {
  assert.deepEqual(validateRegistry(docs(), { texts }), []);
  const reg = await loadRegistry();
  assert.ok(reg.clubs.length >= 9);
  assert.equal(reg.platforms[0].id, 'bonn-jetzt');
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
  ];
  for (const [name, mutate, want] of cases) assert.match(errorsAfter(mutate), want, name);
});

test('canonical form: unsorted keys or club order are refused, the formatter fixes both', () => {
  const d = docs();
  const reordered = { ...d.clubs, clubs: [...d.clubs.clubs].reverse() };
  const badText = JSON.stringify(reordered, null, 2) + '\n';
  assert.match(validateRegistry({ clubs: reordered, sports: d.sports }, { texts: { clubs: badText } }).join(), /canonical/);
  assert.equal(canonicalJson(canonicalClubs(reordered)), texts.clubs);
  const unsortedKeys = texts.sports.replace('"colour": "#208a44",\n      "emoji": "⚽",', '"emoji": "⚽",\n      "colour": "#208a44",');
  assert.notEqual(unsortedKeys, texts.sports);
  assert.match(validateRegistry(docs(), { texts: { sports: unsortedKeys } }).join(), /sports.json is not in canonical form/);
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
