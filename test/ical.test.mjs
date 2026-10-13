// iCal adapter on fixtures: the timezone rules (floating, TZID without
// VTIMEZONE, Windows names, UTC, VTIMEZONE), all-day, EXDATE, RECURRENCE-ID,
// the DST end, and the expansion caps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseIcal, fetchEvents } from '../pipeline/adapters/ical.mjs';
import { windowMs } from '../pipeline/model.mjs';
import { toBerlinIso } from '../pipeline/tz.mjs';

const WINDOW = { from: '2026-09-01', to: '2027-11-01' };
const fixture = (name) => readFileSync(new URL(`./fixtures/ical/${name}`, import.meta.url), 'utf8');
const parse = (name) => parseIcal(fixture(name), windowMs(WINDOW));
const byUid = (events, uid) => events.filter((e) => e.uid === uid);
const at = (e) => toBerlinIso(e.startMs);

test('floating time is Berlin wall clock, with a warning', () => {
  const r = parse('edge-cases.ics');
  const [e] = byUid(r.events, 'floating@test');
  assert.equal(at(e), '2026-10-15T18:30:00+02:00');
  assert.equal(toBerlinIso(e.endMs), '2026-10-15T20:00:00+02:00');
  assert.match(r.warnings.join('\n'), /Europe\/Berlin wall clock \(floating/);
});

test('TZID without VTIMEZONE: +02:00 in summer time, +01:00 in winter time', () => {
  const r = parse('edge-cases.ics');
  assert.equal(at(byUid(r.events, 'tzid-summer@test')[0]), '2026-10-10T15:00:00+02:00');
  assert.equal(at(byUid(r.events, 'tzid-winter@test')[0]), '2026-11-07T15:00:00+01:00');
  // A TZID Intl knows is not a fallback: no warning names it.
  assert.doesNotMatch(r.warnings.join('\n'), /\(.*Europe\/Berlin.*\)/);
});

test('a Windows TZID falls back to Berlin with a warning', () => {
  const r = parse('edge-cases.ics');
  assert.equal(at(byUid(r.events, 'windows@test')[0]), '2026-10-12T19:00:00+02:00');
  assert.match(r.warnings.join('\n'), /W\. Europe Standard Time/);
});

test('UTC times convert to the Berlin offset of their day', () => {
  const [e] = byUid(parse('edge-cases.ics').events, 'utc@test');
  assert.equal(at(e), '2026-10-31T10:00:00+01:00');
  assert.equal(e.status, 'cancelled');
  assert.equal(e.url, 'https://example.org/halloween');
});

test('all-day events keep dates; a missing DTEND stays open for the model', () => {
  const r = parse('edge-cases.ics');
  const [two] = byUid(r.events, 'allday@test');
  assert.deepEqual([two.allDay, two.startDate, two.endDate], [true, '2026-11-21', '2026-11-23']);
  assert.deepEqual(two.tags, ['Jugend', 'Turnier']);
  const [one] = byUid(r.events, 'allday-noend@test');
  assert.equal(one.startDate, '2026-12-05');
});

test('weekly 19:00 series stays 19:00 across the 2026-10-25 DST end; EXDATE and a moved instance', () => {
  const series = byUid(parse('edge-cases.ics').events, 'training@test');
  assert.deepEqual(series.map(at), [
    '2026-10-06T19:00:00+02:00', '2026-10-13T19:00:00+02:00', '2026-10-20T19:00:00+02:00',
    '2026-10-27T19:00:00+01:00', // after the DST end: still 19:00 wall clock
    // 2026-11-03 is an EXDATE
    '2026-11-11T18:00:00+01:00', // the 11-10 instance, moved by RECURRENCE-ID
    '2026-11-17T19:00:00+01:00', '2026-11-24T19:00:00+01:00',
  ]);
  const moved = series.find((e) => e.title.includes('verlegt'));
  assert.equal(moved.recurrenceId, '2026-11-10T18:00:00.000Z', 'identity is the original slot');
  assert.equal(new Set(series.map((e) => e.recurrenceId)).size, series.length);
});

test('VTIMEZONE-defined zone goes through ical.js and agrees', () => {
  const series = parse('vtimezone.ics').events;
  assert.deepEqual(series.map(at), ['2026-10-20T19:00:00+02:00', '2026-10-27T19:00:00+01:00', '2026-11-03T19:00:00+01:00']);
});

test('out-of-window events are dropped, unsafe urls removed, text unescaped', () => {
  const r = parse('edge-cases.ics');
  assert.equal(byUid(r.events, 'old@test').length, 0);
  const [e] = byUid(r.events, 'unsafe@test');
  assert.equal(e.url, null);
  assert.equal(e.description, 'Zeile 1\nZeile 2, mit Komma');
});

test('FREQ=SECONDLY bomb: bounded, flagged partial, plain events survive', () => {
  const t0 = Date.now();
  const r = parse('bomb.ics');
  assert.ok(Date.now() - t0 < 5000, 'expansion is bounded in time');
  assert.ok(r.partial, 'partial is set');
  assert.equal(byUid(r.events, 'bomb@test').length, 1000);
  assert.equal(byUid(r.events, 'plain-after-bomb@test').length, 1);
});

test('fetchEvents refuses a body that is not iCalendar', async () => {
  const ctx = { window: WINDOW, get: async () => ({ body: '<!doctype html><title>404</title>' }) };
  await assert.rejects(fetchEvents({ url: 'https://example.org/x.ics' }, ctx), /not an iCalendar document/);
  const ok = { window: WINDOW, get: async (url, opts) => { assert.equal(opts.robots, false, 'subscription feeds skip robots'); return { body: fixture('vtimezone.ics') }; } };
  assert.equal((await fetchEvents({ url: 'https://example.org/x.ics' }, ok)).events.length, 3);
});
