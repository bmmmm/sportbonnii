// Venues on the published club list: the data contract's venue rules, one
// mutant per rule, against the committed site-data snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkSiteData, formatJson } from '../pipeline/contract.mjs';
import { MAX_VENUES } from '../pipeline/registry.mjs';

const NAMES = ['events.json', 'status.json', 'clubs.json', 'sports.json', 'meta.json'];
const texts = Object.fromEntries(NAMES.map((n) => [n, readFileSync(new URL(`./fixtures/site-data/${n}`, import.meta.url), 'utf8')]));
const snapshot = JSON.parse(texts['clubs.json']);

/** The snapshot with `mutate` applied to the Gamecocks' first venue (or the club), re-serialised canonically. */
function withClubs(mutate) {
  const doc = structuredClone(snapshot);
  mutate(doc.clubs.find((c) => c.id === 'bonn-gamecocks'));
  return checkSiteData({ ...texts, 'clubs.json': formatJson(doc) }).join('\n');
}

test('the snapshot carries venues and honours the contract', () => {
  assert.ok(snapshot.clubs.some((c) => c.venues?.length >= 2));
  assert.deepEqual(checkSiteData(texts), []);
});

test('contract: lat as a string is refused', () => {
  assert.match(withClubs((c) => { c.venues[0].lat = '50.66885'; }), /venues\[0\]: lat must be a number/);
});

test('contract: a venue outside Bonn is refused', () => {
  assert.match(withClubs((c) => { c.venues[1].lon = 8.5; }), /venues\[1\]: lon must be a number/);
});

test('contract: use "veranstaltung" is refused', () => {
  assert.match(withClubs((c) => { c.venues[0].use = 'veranstaltung'; }), /venues\[0\]: use must be one of spiel, training/);
});

test('contract: a malformed osm reference is refused', () => {
  assert.match(withClubs((c) => { c.venues[0].osm = 'way/0'; }), /venues\[0\]: osm must be/);
});

test('contract: a nameless venue, an empty address and an unknown field are refused', () => {
  assert.match(withClubs((c) => { delete c.venues[0].name; }), /venues\[0\]: name must be non-empty text/);
  assert.match(withClubs((c) => { c.venues[0].address = ' '; }), /venues\[0\]: address must be non-empty text/);
  assert.match(withClubs((c) => { c.venues[0].phone = '0228'; }), /venues\[0\]: unknown field "phone"/);
});

test('contract: venues must be a list of 1 to MAX_VENUES', () => {
  assert.match(withClubs((c) => { c.venues = []; }), /must list 1 to 3 venues/);
  assert.match(withClubs((c) => { c.venues = Array.from({ length: MAX_VENUES + 1 }, () => c.venues[0]); }), /must list 1 to 3 venues/);
  assert.match(withClubs((c) => { c.venues = 'Pennenfeld'; }), /venues must be a list/);
});
