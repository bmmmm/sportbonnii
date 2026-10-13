// mergeRun: per-source state rules, retention, drop-to-zero, all-failed, and
// cross-source dedup precedence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRun, dedupe, tokenOverlap, titleTokens } from '../pipeline/merge.mjs';
import { eventId } from '../pipeline/model.mjs';

const WINDOW = { from: '2026-09-01', to: '2027-11-01' };
const ev = (source, uid, o = {}) => ({
  id: eventId(source, uid), club: source.split('/')[0] === 'bonn-jetzt' ? o.club ?? null : source.split('/')[0],
  sports: ['rugby'], title: 'Heimspiel', start: '2026-10-17T15:00:00+02:00', end: null, allDay: false,
  location: null, url: null, description: null, source, status: 'confirmed', ...o,
});
const A = 'rc-bonn-rhein-sieg/kalender';
const B = 'rc-bonn-rhein-sieg/zweit';
const P = 'bonn-jetzt/sport';
const order = new Map([[A, 0], [B, 1], [P, 2]]);
const run = (results, previous, today = '2026-10-14') => mergeRun({ results: new Map(results), previous, order, window: WINDOW, today });

test('ok replaces, disabled is empty, since moves only on transitions', () => {
  const prev = { events: [ev(A, 'old')], status: { [A]: { state: 'ok', since: '2026-10-01', count: 1 } } };
  const r = run([[A, { state: 'ok', events: [ev(A, 'new')] }], [P, { state: 'disabled', events: [] }]], prev);
  assert.deepEqual(r.events.map((e) => e.id), [eventId(A, 'new')]);
  assert.deepEqual(r.status[A], { state: 'ok', since: '2026-10-01', count: 1 });
  assert.deepEqual(r.status[P], { state: 'disabled', since: '2026-10-14', count: 0 });
});

test('partial merges with the previous events, the new version wins', () => {
  const prev = { events: [ev(A, 'x', { title: 'alt' }), ev(A, 'y')], status: { [A]: { state: 'ok', since: '2026-10-01', count: 2 } } };
  const r = run([[A, { state: 'partial', events: [ev(A, 'x', { title: 'neu' }), ev(A, 'z', { start: '2026-10-18T15:00:00+02:00' })], error: 'page cap' }]], prev);
  assert.deepEqual(r.events.map((e) => e.title).sort(), ['Heimspiel', 'Heimspiel', 'neu']);
  assert.equal(r.status[A].state, 'partial');
  assert.equal(r.status[A].error, 'page cap');
  assert.equal(r.status[A].since, '2026-10-14');
});

test('error keeps the previous events for 7 days, then drops them', () => {
  const prev = (since) => ({ events: [ev(A, 'x')], status: { [A]: { state: 'error', since, count: 1, error: 'HTTP 500' } } });
  const results = [[A, { state: 'error', events: [], error: 'HTTP 500' }], [B, { state: 'ok', events: [] }]];
  assert.equal(run(results, prev('2026-10-07')).events.length, 1, '7 days: kept');
  const late = run(results, prev('2026-10-06'));
  assert.equal(late.events.length, 0, '8 days: dropped');
  assert.match(late.warnings.join(), /dropped/);
  assert.equal(late.status[A].since, '2026-10-06');
  assert.equal(late.status[A].error, 'HTTP 500');
});

test('blocked behaves like error', () => {
  const prev = { events: [ev(A, 'x')], status: { [A]: { state: 'ok', since: '2026-10-01', count: 1 } } };
  const r = run([[A, { state: 'blocked', events: [], error: 'robots.txt' }], [B, { state: 'ok', events: [] }]], prev);
  assert.equal(r.events.length, 1);
  assert.deepEqual(r.status[A], { state: 'blocked', since: '2026-10-14', count: 1, error: 'robots.txt' });
});

test('a drop from ≥ 5 events to 0 counts as error and keeps the previous events', () => {
  const five = ['a', 'b', 'c', 'd', 'e'].map((u, i) => ev(A, u, { start: `2026-10-1${i}T15:00:00+02:00` }));
  const prev = { events: five, status: { [A]: { state: 'ok', since: '2026-10-01', count: 5 } } };
  const r = run([[A, { state: 'ok', events: [] }], [B, { state: 'ok', events: [] }]], prev);
  assert.equal(r.status[A].state, 'error');
  assert.match(r.status[A].error, /0 events after 5/);
  assert.equal(r.events.length, 5);
  const four = { events: five.slice(0, 4), status: { [A]: { state: 'ok', since: '2026-10-01', count: 4 } } };
  assert.equal(run([[A, { state: 'ok', events: [] }]], four).status[A].state, 'ok', 'below the threshold an empty result is believed');
});

test('all sources failed: the previous events stay unchanged', () => {
  const prev = { events: [ev(A, 'x'), ev(P, 'p', { club: null, start: '2026-10-18T10:00:00+02:00' })], status: {} };
  const r = run([[A, { state: 'error', events: [], error: 'down' }], [P, { state: 'error', events: [], error: 'down' }]], prev, '2026-12-01');
  assert.equal(r.allFailed, true);
  assert.equal(r.events.length, 2);
  assert.match(r.warnings.join(), /all 2 sources failed/);
});

test('previous events outside the moved window are not carried over', () => {
  const prev = { events: [ev(A, 'old', { start: '2026-08-20T15:00:00+02:00' })], status: { [A]: { state: 'ok', since: '2026-08-01', count: 1 } } };
  const r = run([[A, { state: 'error', events: [], error: 'x' }], [B, { state: 'ok', events: [] }]], prev);
  assert.equal(r.events.length, 0);
});

test('dedup: the club source beats the platform, earlier beats later, never within one source', () => {
  const club = ev(A, 'c', { title: 'Heimspiel gegen RK Heusenstamm' });
  const second = ev(B, 's', { title: 'Heimspiel RK Heusenstamm' });
  const plat = ev(P, 'p', { club: 'rc-bonn-rhein-sieg', title: 'Rugby: Heimspiel gegen den RK Heusenstamm' });
  const twin = ev(A, 'c2', { title: 'Heimspiel gegen RK Heusenstamm' });
  const other = ev(P, 'q', { club: 'rc-bonn-rhein-sieg', title: 'Kuchenverkauf' });
  const { events, dropped } = dedupe([plat, second, club, twin, other], order);
  assert.deepEqual(events.map((e) => e.id).sort(), [club.id, twin.id, other.id].sort());
  assert.equal(dropped, 2);
  // Flipped precedence keeps the platform event instead: the mutant this test exists for.
  const flipped = new Map([[P, 0], [A, 1], [B, 2]]);
  assert.ok(dedupe([plat, club], flipped).events.some((e) => e.id === club.id), 'own club source still wins over a platform');
  assert.deepEqual(dedupe([second, club], new Map([[B, 0], [A, 1]])).events.map((e) => e.id), [second.id]);
});

test('dedup needs the same club and start minute', () => {
  const club = ev(A, 'c', { title: 'Heimspiel gegen RK Heusenstamm' });
  const later = ev(P, 'p', { club: 'rc-bonn-rhein-sieg', title: 'Heimspiel gegen RK Heusenstamm', start: '2026-10-17T15:01:00+02:00' });
  const noClub = ev(P, 'n', { club: null, title: 'Heimspiel gegen RK Heusenstamm' });
  assert.equal(dedupe([club, later, noClub], order).dropped, 0);
});

test('title tokens: folded, stop words and short tokens out', () => {
  assert.deepEqual([...titleTokens('Das Fußball-Spiel gegen den FC Köln')], ['fussball', 'spiel', 'koln']);
  assert.equal(tokenOverlap('Heimspiel gegen RK Heusenstamm', 'heimspiel – heusenstamm'), 1);
  assert.equal(tokenOverlap('Training', 'Kuchenverkauf'), 0);
  assert.equal(tokenOverlap('', 'x'), 0);
});
