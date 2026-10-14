// Event kinds: the title classifier, the source's fallback kind, the data
// contract, the upgrade of a previous state published before `kind`/`home`, and the
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
  // live 2026-10-15 (RCBRS, Rheinos, bonn.jetzt)
  ['U12-U18 Activate & Touch', 'training'],
  ['BIS Sportshall', 'training'],
  ['European Games', 'veranstaltung'],
  ['Rennradeln nach Feierabend', 'veranstaltung'],
  // the gaps: social meetings, celebrations and board games are no training or match
  ['Jugendtreff im Clubhaus', 'veranstaltung'],
  ['Seniorentreff', 'veranstaltung'],
  ['Brettspiele-Abend', 'veranstaltung'],
  ['Pokalübergabe im Rathaus', 'veranstaltung'],
  ['Meisterschaftsfeier der 1. Herren', 'veranstaltung'],
  ['Saisonabschlussfeier mit Turnier', 'veranstaltung'],
  ['Feierabendliga Spieltag', 'spiel'],
  ['Feiertagsturnier', 'spiel'],
  ['Feierabend-Cup', 'spiel'],
  ['Yoga gegen Rückenschmerzen', 'veranstaltung'],
  ['Sport gegen Gewalt', 'veranstaltung'],
  ['Damen gegen den 1. FC Köln', 'spiel'],
  ['Friendly gegen Essen/Düsseldorf', 'spiel'],
  ['Herren gegen die Münster Blackhawks', 'spiel'],
  ['U16 gegen Köln', 'spiel'],
  ['Abschluss gegen Bonner SC', 'spiel'],
  ['gegen ESV Bonn', 'spiel'],
  ['Laufen gegen Krebs', 'veranstaltung'],
  ['Herren gegen Blau-Weiß Beuel', 'spiel'],
  ['Abschluss gegen Eintracht Bonn', 'spiel'],
  ['Treffen gegen 19 Uhr', 'veranstaltung'],
  ['Abholung gegen 18:30 Uhr', 'veranstaltung'],
  ['Spendenaktion gegen TV-Spot', 'veranstaltung'],
  ['Elterntreff', 'veranstaltung'],
  ['Jugendtreff, danach Lauftreff', 'training'],
  ['Board Game Night', 'veranstaltung'],
  ['Spieleabend im Clubhaus', 'veranstaltung'],
  ['Feierstunde zum Pokalsieg', 'veranstaltung'],
  ['Wir feiern den Pokalsieg', 'veranstaltung'],
  ['U14 Game Day', 'spiel'],
  ['Match: Bonn Gamecocks – Cologne Falcons', 'spiel'],
  ['Herren gegen TuS Pützchen', 'spiel'],
  ['Ligatermin Damen', 'spiel'],
  ['Halbfinale Kreispokal', 'spiel'],
  ['Finale', 'spiel'],
  ['Team Practice', 'training'],
];

test('eventKind: real titles', () => {
  const wrong = TITLES.filter(([title, kind]) => eventKind(title) !== kind).map(([title, kind]) => `${title}: ${eventKind(title)}, want ${kind}`);
  assert.deepEqual(wrong, []);
  for (const [, kind] of TITLES) assert.ok(KIND_IDS.includes(kind));
});

test('eventKind: the celebration veto beats a source kind', () => {
  assert.equal(eventKind('Weihnachtsfeier', [], { kind: 'spiel' }), 'veranstaltung');
  assert.equal(eventKind('Saisonabschluss', [], { kind: 'spiel' }), 'spiel', 'no veto word: the source kind');
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
  assert.match(checkEvent({ ...e, home: 'yes' }).join('\n'), /home must be true, false or null/);
  assert.match(checkEvent({ ...e, kind: 'training', home: true }).join('\n'), /only a game/);
  const game = snapshot.events.find((x) => x.kind === 'spiel');
  assert.deepEqual(checkEvent({ ...game, home: false }), []);
  assert.deepEqual(checkEvent({ ...game, home: null }), []);
  const { kind, ...withoutKind } = e;
  assert.match(checkEvent(withoutKind).join('\n'), /kind must be one of/);
  assert.match(checkEvent(withoutKind).join('\n'), /keys must be exactly/);
  const texts = Object.fromEntries(['events.json', 'status.json', 'clubs.json', 'sports.json', 'meta.json'].map((n) => [n, fixture(n)]));
  assert.deepEqual(checkSiteData(texts), []);
  const bad = texts['events.json'].replace('"kind":"training"', '"kind":"match"');
  assert.notEqual(bad, texts['events.json']);
  assert.match(checkSiteData({ ...texts, 'events.json': bad }).join('\n'), /kind must be/);
});

test('legacy: a previous state without kind or home is accepted and gets both back', () => {
  const clubsById = new Map(JSON.parse(fixture('clubs.json')).clubs.map((c) => [c.id, c]));
  const legacy = { ...snapshot, events: snapshot.events.map(({ kind, home, ...e }) => e) };
  const ok = acceptPrevious(legacy, status, null, clubsById);
  assert.ok(ok, 'the previous state survives the upgrade');
  // The snapshot's kinds and home flags were set from titles and places alone, so the upgrade restores it exactly.
  assert.deepEqual(ok.events, snapshot.events);
  for (const e of ok.events) assert.equal(Object.keys(e).join(), EVENT_KEYS.join());
  const withKind = { ...snapshot, events: snapshot.events.map(({ home, ...e }) => e) };
  assert.deepEqual(acceptPrevious(withKind, status, null, clubsById).events, snapshot.events, 'a state with kind but without home gets home');
  assert.equal(acceptPrevious(snapshot, status).events.length, snapshot.events.length, 'a current state passes unchanged');
  // Home from a club venue alone (street and number, no Bonn, no postcode) needs the clubs.
  const atVenue = { ...legacy.events[0], club: 'rc-bonn-rhein-sieg', title: 'Ligaspiel: Herren gegen RK Köln', location: 'Martin-Luther-King-Str. 22' };
  assert.equal(upgradeLegacyEvent(atVenue, clubsById).kind, 'spiel');
  assert.equal(upgradeLegacyEvent(atVenue, clubsById).home, true, 'the club venue makes it a home game');
  assert.equal(upgradeLegacyEvent(atVenue).home, null, 'without the clubs nothing says');
  const odd = { ...legacy.events[0], extra: 1 };
  assert.equal(upgradeLegacyEvent(odd), odd, 'only the exact legacy shapes are upgraded');
  assert.equal(acceptPrevious({ ...legacy, events: [odd] }, status), null, 'and anything else still fails the shape check');
});

test('feed: CATEGORIES carry the sports, then the kind', () => {
  const opts = { dtstamp: '20260901T000000Z', labels: { rugby: 'Rugby' } };
  const training = snapshot.events.find((e) => e.title === 'Training Herren');
  assert.ok(veventLines(training, opts).includes('CATEGORIES:Rugby,Training'));
  assert.ok(veventLines({ ...training, kind: 'spiel' }, opts).includes('CATEGORIES:Rugby,Spiel'));
  assert.ok(veventLines({ ...training, kind: 'veranstaltung' }, opts).includes('CATEGORIES:Rugby,Veranstaltung'));
});
