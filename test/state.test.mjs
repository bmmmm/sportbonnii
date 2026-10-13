// Page logic without a browser: the hash codec, filters, chip counts, date
// helpers, and table sorting — on the committed site-data snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseHash, formatHash, applyFilters, chipCounts, defaultState, fold } from '../site/state.js';
import {
  berlinToday, rangeFor, eventDays, overlaps, formatShortDate, formatLongDate, formatTime, formatSpan,
  formatCheckedAt, weekdayIndex, addMonths, lastDayOfMonth, formatMonth,
} from '../site/dates.js';
import { sortEvents, placeText, relativeDay } from '../site/table.js';

const json = (n) => JSON.parse(readFileSync(new URL(`./fixtures/site-data/${n}`, import.meta.url), 'utf8'));
const events = json('events.json').events;
const clubs = json('clubs.json').clubs;
const sports = json('sports.json').sports;
const ctx = { today: '2026-10-14', clubsById: new Map(clubs.map((c) => [c.id, c])), sportsById: new Map(sports.map((s) => [s.id, s])) };
const known = { sportIds: new Set(sports.map((s) => s.id)), clubIds: new Set(clubs.map((c) => c.id)) };
const state = (o) => ({ ...defaultState(), ...o });
const titles = (list) => list.map((e) => e.title);

test('hash round trip keeps every field', () => {
  const s = state({ ansicht: 'kalender', sport: ['fussball', 'tennis'], verein: 'bsv-roleber', q: 'Camp & Spiel', zeit: 'woche', monat: '2026-11' });
  const hash = formatHash(s);
  assert.equal(hash, '#ansicht=kalender&sport=fussball,tennis&verein=bsv-roleber&q=Camp%20%26%20Spiel&zeit=woche&monat=2026-11');
  assert.deepEqual(parseHash(hash, known), s);
  assert.equal(formatHash(defaultState()), '', 'defaults leave no hash');
});

test('hash parsing drops what it does not know', () => {
  const s = parseHash('#ansicht=karte&sport=fussball,quidditch,fussball&verein=gibts-nicht&zeit=jahr&monat=2026-13&x=1', known);
  assert.deepEqual(s, state({ sport: ['fussball'] }));
  assert.deepEqual(parseHash('#q=%E0%A4%A&sport=', known), state({}));
  assert.equal(parseHash(`#q=${'a'.repeat(500)}`, known).q.length, 100);
  assert.equal(parseHash('#q=fu%C3%9Fball+camp', known).q, 'fußball camp');
});

test('filters: sport (any of), club, words, time range from today', () => {
  const all = applyFilters(events, state({}), ctx);
  assert.ok(all.every((e) => eventDays(e)[1] >= '2026-10-14'), '"Alle" starts today');
  assert.ok(!titles(all).includes('Saisonauftakt mit Grillen'));
  assert.deepEqual(new Set(applyFilters(events, state({ sport: ['fussball', 'radsport'] }), ctx).flatMap((e) => e.sports)), new Set(['fussball', 'radsport']));
  assert.ok(applyFilters(events, state({ verein: 'bsv-roleber' }), ctx).every((e) => e.club === 'bsv-roleber'));
  assert.deepEqual(titles(applyFilters(events, state({ q: 'fussballcamp' }), ctx)), ['Herbst: Fußballcamp'], 'ß folds to ss');
  assert.deepEqual(titles(applyFilters(events, state({ q: 'handballcamp' }), ctx)), []);
  assert.deepEqual(titles(applyFilters(events, state({ q: 'herbst FUSSBALL' }), ctx)), ['Herbst: Fußballcamp'], 'folded, every word');
  assert.deepEqual(titles(applyFilters(events, state({ q: 'Gamecocks' }), ctx)), ['Gamecocks Probetraining für Einsteiger*innen'], 'club names are searchable');
  assert.deepEqual(titles(applyFilters(events, state({ zeit: 'heute' }), ctx)), []);
  const week = applyFilters(events, state({ zeit: 'woche' }), ctx);
  assert.ok(week.every((e) => eventDays(e)[0] <= '2026-10-18') && week.length > 0);
  const month = applyFilters(events, state({ zeit: 'monat' }), ctx);
  assert.ok(month.some((e) => e.title === 'Critical Mass Bonn') && !month.some((e) => e.title === 'Jahreshauptversammlung'));
  assert.equal(applyFilters(events, state({}), ctx, { skipTime: true }).length, events.length);
});

test('a multi-day event stays visible on its later days', () => {
  const camp = { ...ctx, today: '2026-10-28' };
  assert.ok(titles(applyFilters(events, state({ zeit: 'heute' }), camp)).includes('Herbst: Fußballcamp'));
});

test('chip counts apply every filter except the sport itself', () => {
  const counts = chipCounts(events, state({ sport: ['rugby'], verein: 'rc-bonn-rhein-sieg' }), ctx);
  assert.deepEqual([...counts.keys()], ['rugby']);
  const open = chipCounts(events, state({ sport: ['rugby'] }), ctx);
  assert.ok(open.get('fussball') > 0, 'other sports keep their counts while one is selected');
  const total = applyFilters(events, state({}), ctx).length;
  assert.ok([...open.values()].reduce((a, b) => a + b, 0) >= total);
});

test('dates: Berlin today does not depend on the machine zone', () => {
  const at = new Date('2026-10-13T22:30:00Z');
  const probe = `import('${new URL('../site/dates.js', import.meta.url).href}').then(m => console.log(m.berlinToday(new Date('${at.toISOString()}')), m.formatCheckedAt('2026-10-13T22:05:00Z', new Date('${at.toISOString()}'))))`;
  for (const tz of ['America/New_York', 'Pacific/Auckland', 'UTC']) {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], { env: { ...process.env, TZ: tz } }).toString().trim();
    assert.equal(out, '2026-10-14 heute, 00:05 Uhr', tz);
  }
  assert.equal(berlinToday(at), '2026-10-14');
});

test('dates: ranges, days and German formatting from string parts', () => {
  assert.deepEqual(rangeFor('woche', '2026-10-14'), ['2026-10-14', '2026-10-18']);
  assert.deepEqual(rangeFor('woche', '2026-10-18'), ['2026-10-18', '2026-10-18']);
  assert.deepEqual(rangeFor('monat', '2026-02-10'), ['2026-02-10', '2026-02-28']);
  assert.deepEqual(rangeFor('alle', '2026-10-14'), ['2026-10-14', null]);
  assert.equal(weekdayIndex('2026-10-19'), 0);
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(lastDayOfMonth('2028-02'), '2028-02-29');
  assert.equal(formatMonth('2026-10'), 'Oktober 2026');
  assert.equal(formatShortDate('2026-10-20', 2026), 'Di., 20. Okt.');
  assert.equal(formatShortDate('2027-01-01', 2026), 'Fr., 1. Jan. 2027');
  assert.equal(formatLongDate('2026-10-25'), 'Sonntag, 25. Oktober 2026');
  const camp = events.find((e) => e.title === 'Herbst: Fußballcamp');
  assert.deepEqual(eventDays(camp), ['2026-10-26', '2026-10-29']);
  assert.equal(formatTime(camp), '08:00');
  assert.equal(formatSpan(camp, 2026), 'bis Do., 29. Okt., 16:00');
  const party = events.find((e) => e.title === 'Saisonabschlussfeier');
  assert.deepEqual([formatTime(party), formatSpan(party, 2026)], ['ganztägig', '']);
  const lager = events.find((e) => e.title === 'Trainingslager Jugend');
  assert.equal(formatSpan(lager, 2026), 'bis So., 29. Nov.');
  assert.equal(formatTime(events.find((e) => e.title === 'Critical Mass Bonn')), '18:00');
  assert.ok(overlaps(camp, '2026-10-29', '2026-10-29') && !overlaps(camp, '2026-10-30', null));
  assert.deepEqual(eventDays({ allDay: false, start: '2026-10-20T20:00:00+02:00', end: '2026-10-21T00:00:00+02:00' }), ['2026-10-20', '2026-10-20'], 'midnight end closes the day before');
  assert.equal(formatCheckedAt('2026-10-12T04:23:00Z', new Date('2026-10-14T10:00:00Z')), '12. Okt., 06:23 Uhr');
  assert.equal(formatCheckedAt('2026-10-13T16:05:00Z', new Date('2026-10-14T10:00:00Z')), 'gestern, 18:05 Uhr');
});

test('table helpers: sorting, place text without the club, relative days', () => {
  const byTitle = sortEvents(events.slice(0, 6), { key: 'titel', dir: 1 }, ctx);
  assert.deepEqual(titles(byTitle), [...titles(events.slice(0, 6))].sort((a, b) => a.localeCompare(b, 'de')));
  const desc = sortEvents(events, { key: 'datum', dir: -1 }, ctx);
  assert.equal(desc[0], events[events.length - 1]);
  const byClub = sortEvents(events, { key: 'verein', dir: 1 }, ctx);
  assert.equal(byClub[byClub.length - 1].club, null, 'events without club last');
  assert.equal(placeText({ club: 'rc-bonn-rhein-sieg', location: 'Rugby Club Bonn-Rhein-Sieg e.V., Martin-Luther-King-Straße 22, 53175 Bonn' }, ctx), 'Martin-Luther-King-Straße 22, 53175 Bonn');
  assert.equal(placeText({ club: null, location: 'Kaiserplatz, Bonn' }, ctx), 'Kaiserplatz, Bonn');
  assert.deepEqual([relativeDay('2026-10-14', '2026-10-14'), relativeDay('2026-10-15', '2026-10-14'), relativeDay('2026-10-16', '2026-10-14')], ['Heute', 'Morgen', null]);
  assert.equal(fold('Übungs-Straße'), 'ubungs-strasse');
});

test('the browser-free modules import without a DOM', () => {
  const file = fileURLToPath(new URL('../site/state.js', import.meta.url));
  assert.ok(readFileSync(file, 'utf8').includes('history.replaceState'));
});
