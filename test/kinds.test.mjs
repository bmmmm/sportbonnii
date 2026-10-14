// Event kinds: the title classifier, the source's fallback kind, the data
// contract, the upgrade of a previous state published before `kind`, and the
// kind in the feed's CATEGORIES.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eventKind } from '../pipeline/model.mjs';
import { acceptPrevious, upgradeLegacyEvent } from '../pipeline/run.mjs';
import { checkEvent, checkSiteData, EVENT_KEYS } from '../pipeline/contract.mjs';
import { veventLines } from '../site/ics.js';
import { KIND_IDS } from '../site/kinds.js';

const fixture = (n) => readFileSync(new URL(`./fixtures/site-data/${n}`, import.meta.url), 'utf8');
const snapshot = JSON.parse(fixture('events.json'));
const status = JSON.parse(fixture('status.json'));

// Real titles from the club feeds and bonn.jetzt.
const TITLES = [
  ['Training Herren', 'training'],
  ['U16 Gym', 'training'],
  ['Lauftreff im Rheinauenpark', 'training'],
  ['Trainingslager Jugend', 'training'],
  ['Gamecocks Probetraining für Einsteiger*innen', 'training'],
  ['Rugby Tryouts', 'training'],
  ['Heimspiel gegen RK Heusenstamm', 'spiel'],
  ['Kreisliga A: BSV Roleber – SV Beuel 06', 'spiel'],
  ['Hockey: 1. Damen – RTHC Leverkusen', 'spiel'],
  ['Jugendturnier U12', 'spiel'],
  ["Women's 7s Herbstpokal in Düsseldorf", 'spiel'],
  ['BONNER JSG vs. HC WEIDEN 2', 'spiel'],
  ['Goalball Spieltag', 'spiel'],
  ['Herbst: Fußballcamp', 'veranstaltung'],
  ['Weihnachtsfeier', 'veranstaltung'],
  ['Spielplatzfest', 'veranstaltung'],
  ['Trainerfortbildung', 'veranstaltung'],
  ['Treffen der Abteilungsleiter', 'veranstaltung'],
];

test('eventKind: real titles', () => {
  const wrong = TITLES.filter(([title, kind]) => eventKind(title) !== kind).map(([title, kind]) => `${title}: ${eventKind(title)}, want ${kind}`);
  assert.deepEqual(wrong, []);
  for (const [, kind] of TITLES) assert.ok(KIND_IDS.includes(kind));
});

test('eventKind: training beats a match word; tags count like the title', () => {
  assert.equal(eventKind('Trainingsspiel gegen Köln'), 'training');
  assert.equal(eventKind('Dienstag 19 Uhr', ['Training']), 'training');
  assert.equal(eventKind('Samstag', ['Liga']), 'spiel');
});

test('eventKind: the source kind applies only when title and tags name none', () => {
  assert.equal(eventKind('Rheinaue, 18 Uhr', [], { kind: 'training' }), 'training');
  assert.equal(eventKind('Heimspiel', [], { kind: 'training' }), 'spiel');
  assert.equal(eventKind('Training', [], { kind: 'spiel' }), 'training');
  assert.equal(eventKind('Sommerfest', [], { id: 'x' }), 'veranstaltung');
  assert.equal(eventKind('Sommerfest', [], null), 'veranstaltung');
});

test('contract: kind is one of the kinds, in its place', () => {
  const e = snapshot.events[0];
  assert.deepEqual(checkEvent(e), []);
  assert.match(checkEvent({ ...e, kind: 'match' }).join('\n'), /kind must be one of spiel, training, veranstaltung/);
  const { kind, ...withoutKind } = e;
  assert.match(checkEvent(withoutKind).join('\n'), /kind must be one of/);
  assert.match(checkEvent(withoutKind).join('\n'), /keys must be exactly/);
  const texts = Object.fromEntries(['events.json', 'status.json', 'clubs.json', 'sports.json', 'meta.json'].map((n) => [n, fixture(n)]));
  assert.deepEqual(checkSiteData(texts), []);
  const bad = texts['events.json'].replace('"kind":"training"', '"kind":"match"');
  assert.notEqual(bad, texts['events.json']);
  assert.match(checkSiteData({ ...texts, 'events.json': bad }).join('\n'), /kind must be/);
});

test('legacy: a previous state without kind is accepted and gets the kind from the title', () => {
  const legacy = { ...snapshot, events: snapshot.events.map(({ kind, ...e }) => e) };
  const ok = acceptPrevious(legacy, status);
  assert.ok(ok, 'the previous state survives the upgrade');
  // The snapshot's kinds were set from the titles alone, so the upgrade restores it exactly.
  assert.deepEqual(ok.events, snapshot.events);
  for (const e of ok.events) assert.equal(Object.keys(e).join(), EVENT_KEYS.join());
  assert.equal(acceptPrevious(snapshot, status).events.length, snapshot.events.length, 'a current state passes unchanged');
  const odd = { ...legacy.events[0], extra: 1 };
  assert.equal(upgradeLegacyEvent(odd), odd, 'only the exact legacy shape is upgraded');
  assert.equal(acceptPrevious({ ...legacy, events: [odd] }, status), null, 'and anything else still fails the shape check');
});

test('feed: CATEGORIES carry the sports, then the kind', () => {
  const opts = { dtstamp: '20260901T000000Z', labels: { rugby: 'Rugby' } };
  const training = snapshot.events.find((e) => e.title === 'Training Herren');
  assert.ok(veventLines(training, opts).includes('CATEGORIES:Rugby,Training'));
  assert.ok(veventLines({ ...training, kind: 'spiel' }, opts).includes('CATEGORIES:Rugby,Spiel'));
  assert.ok(veventLines({ ...training, kind: 'veranstaltung' }, opts).includes('CATEGORIES:Rugby,Veranstaltung'));
});
