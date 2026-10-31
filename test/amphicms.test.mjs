import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAmphiCalendar, requestUrl, fetchEvents, CONDITIONAL } from '../pipeline/adapters/amphicms.mjs';
import { normalizeEvent, buildContext } from '../pipeline/model.mjs';
import { loadRegistry } from '../pipeline/registry.mjs';
import { checkEvent } from '../pipeline/contract.mjs';

// Captured live from ssfbonn.de on 2026-10-31 (window 2026-10-01 … 2027-11-01).
const body = readFileSync(new URL('./fixtures/amphicms/ssfbonn.json', import.meta.url), 'utf8');
const window = { from: '2026-10-01', to: '2027-11-01' };

test('amphicms: the window becomes start/end in Berlin wall clock; one request, like a browser', async () => {
  const registry = await loadRegistry();
  const source = registry.clubs.find((c) => c.id === 'ssf-bonn').sources.find((s) => s.type === 'amphicms');
  const calls = [];
  const r = await fetchEvents(source, { window, get: async (...args) => { calls.push(args); return { body }; } });
  assert.equal(CONDITIONAL, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].robots, false);
  const u = new URL(calls[0][0]);
  assert.equal(u.searchParams.get('calendarId'), '37');
  assert.equal(u.searchParams.get('start'), '2026-10-01T00:00:00');
  assert.equal(u.searchParams.get('end'), '2027-11-01T00:00:00');
  assert.equal(u.searchParams.get('timeZone'), 'Europe/Berlin');
  assert.equal(r.events.length, 63);
  assert.deepEqual(r.warnings, []);
  assert.equal(requestUrl(`${source.url}&start=x`, window).match(/start=/g).length, 1, 'a stale window in the URL is replaced');
});

test('amphicms: captured SSF dates normalise; federation duplicates are excluded, volleyball and club dates stay', async () => {
  const registry = await loadRegistry();
  const owner = registry.clubs.find((c) => c.id === 'ssf-bonn');
  const source = owner.sources.find((s) => s.type === 'amphicms');
  const ctx = buildContext(registry);
  const events = parseAmphiCalendar(body).events
    .map((raw) => normalizeEvent(raw, { owner, source, kind: 'club', ctx, window }))
    .filter(Boolean);
  for (const e of events) assert.deepEqual(checkEvent(e), [], e.title);
  assert.ok(!events.some((e) => /floorball|1\. Herrenmannschaft/i.test(e.title)), 'federation feeds carry these with the opponent');
  const volleyball = events.filter((e) => e.title.startsWith('Heimspiel der Volleyball Damen'));
  assert.equal(volleyball.length, 13);
  for (const e of volleyball) {
    assert.equal(e.kind, 'spiel');
    assert.equal(e.home, true);
    assert.deepEqual(e.sports, ['volleyball']);
  }
  const first = volleyball.find((e) => e.start.startsWith('2026-10-03'));
  assert.equal(first.start, '2026-10-03T16:00:00+02:00');
  assert.equal(first.end, '2026-10-03T18:00:00+02:00');
  const triathlon = events.find((e) => e.title === 'Bonn Triathlon');
  assert.equal(triathlon.start, '2027-06-06');
  assert.equal(triathlon.end, '2027-06-07');
  assert.ok(events.some((e) => e.title === 'Tischtennisturnier Bergischer Cup'));
  // The hall comes from the description, so a game away from Sportpark Nord is not placed there.
  assert.equal(first.location, 'Hardtberghalle, Gaußstr. 1 53125 Bonn');
  assert.equal(events.find((e) => e.title.startsWith('Heimspiel der Tischtennis-Jungen')).location, 'Turnhalle Alte Jahnschule, Herseler Straße 3, 53117 Bonn');
  assert.equal(events.find((e) => e.title.startsWith('Außerordentliche')).location, 'Dreifachhalle im Sportpark Nord');
  assert.equal(events.find((e) => e.title.startsWith('Workshop')).location, null, 'a postcode inside a sentence is no place line');
});

test('amphicms: the uid survives the volatile per-request id; broken items are skipped with a warning', () => {
  const a = parseAmphiCalendar(body).events[0];
  const b = parseAmphiCalendar(body.replaceAll('6ae', 'xyz')).events[0];
  assert.equal(a.uid, b.uid);
  assert.throws(() => parseAmphiCalendar('<html>'), /not valid JSON/);
  assert.throws(() => parseAmphiCalendar('{"events":null}'), /events array/);
  const r = parseAmphiCalendar(JSON.stringify({ events: [{ title: 'X', start: 'soon' }, { start: '2026-10-01T10:00:00' }] }));
  assert.equal(r.events.length, 0);
  assert.equal(r.warnings.length, 2);
  assert.equal(parseAmphiCalendar(JSON.stringify({ events: [{ title: 'X', start: '2026-13-45T10:00:00' }] })).events.length, 0, 'an impossible date is refused, not rolled over');
});
