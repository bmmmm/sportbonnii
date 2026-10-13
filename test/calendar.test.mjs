// Month grid math (calqrii's monthGrid) and the day mapping of events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { monthGrid, eventsByDay, eventsInMonth } from '../site/calendar.js';
import { weekdayIndex } from '../site/dates.js';

const events = JSON.parse(readFileSync(new URL('./fixtures/site-data/events.json', import.meta.url), 'utf8')).events;

test('monthGrid: 6 × 7, Monday first, every day of the month exactly once', () => {
  assert.equal(monthGrid(2026, 10)[0][0].date, '2026-09-28');
  assert.equal(monthGrid(2026, 2)[0][0].date, '2026-01-26');
  assert.equal(monthGrid(2026, 6)[0][0].date, '2026-06-01');
  for (let m = 1; m <= 12; m++) {
    for (const y of [2024, 2026, 2028, 2100]) {
      const g = monthGrid(y, m);
      assert.equal(g.length * g[0].length, 42);
      assert.ok(g.every((row) => weekdayIndex(row[0].date) === 0), `${y}-${m}: column 0 is Monday`);
      const inMonth = g.flat().filter((c) => c.inMonth).map((c) => c.date);
      assert.equal(inMonth.length, new Date(Date.UTC(y, m, 0)).getUTCDate());
      assert.equal(new Set(g.flat().map((c) => c.date)).size, 42);
    }
  }
});

test('eventsByDay: multi-day events on every day they touch, the DST week on the right days', () => {
  const days = monthGrid(2026, 10).flat().map((c) => c.date);
  const map = eventsByDay(events, days);
  const camp = (d) => map.get(d).some((e) => e.title === 'Herbst: Fußballcamp');
  assert.deepEqual(['2026-10-25', '2026-10-26', '2026-10-29', '2026-10-30'].map(camp), [false, true, true, false]);
  const training = (d) => map.get(d).filter((e) => e.title === 'Training Herren').map((e) => e.start);
  assert.deepEqual(training('2026-10-20'), ['2026-10-20T19:00:00+02:00']);
  assert.deepEqual(training('2026-10-27'), ['2026-10-27T19:00:00+01:00'], 'after the DST end: Tuesday, 19:00');
  assert.deepEqual(training('2026-10-26'), []);
  assert.equal(map.get('2026-10-17').length, 4, 'four on the busy Saturday → three chips and "+1"');
  assert.ok(map.get('2026-11-01').length === 0);
});

test('eventsInMonth: what touches the month, including spans from before', () => {
  const nov = eventsInMonth(events, '2026-11').map((e) => e.title);
  assert.ok(nov.includes('Trainingslager Jugend') && nov.includes('Saisonabschlussfeier'));
  assert.ok(!nov.includes('Herbst: Fußballcamp'));
  const span = [{ start: '2026-10-30', end: '2026-11-03', allDay: true }];
  assert.equal(eventsInMonth(span, '2026-11').length, 1);
  assert.equal(eventsInMonth(span, '2026-12').length, 0);
});
