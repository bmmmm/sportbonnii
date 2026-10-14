// mergeRun: per-source state rules, retention, drop-to-zero, all-failed, and
// cross-source dedup precedence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRun, dedupe, tokenOverlap, titleTokens, newsOf } from '../pipeline/merge.mjs';
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
  assert.deepEqual(r.status[A], { state: 'ok', since: '2026-10-01', count: 1, changed: '2026-10-14' });
  assert.deepEqual(r.status[P], { state: 'disabled', since: '2026-10-14', count: 0 });
});

test('unchanged (304) keeps the previous events, since, changed and validators', () => {
  const prev = {
    events: [ev(A, 'x'), ev(B, 'y', { start: '2026-10-18T15:00:00+02:00' })],
    status: {
      [A]: { state: 'ok', since: '2026-10-01', count: 1, changed: '2026-10-03', etag: '"v1"', lastModified: 'Mon, 05 Oct 2026 10:00:00 GMT' },
      [B]: { state: 'ok', since: '2026-10-01', count: 1, changed: '2026-10-03' },
    },
  };
  const r = run([
    [A, { state: 'ok', events: [], unchanged: true }],
    [B, { state: 'ok', events: [ev(B, 'y', { start: '2026-10-18T15:00:00+02:00' })], validators: { etag: '"v2"', lastModified: null } }],
  ], prev);
  assert.deepEqual(r.status[A], { state: 'ok', since: '2026-10-01', count: 1, changed: '2026-10-03', etag: '"v1"', lastModified: 'Mon, 05 Oct 2026 10:00:00 GMT' });
  assert.deepEqual(r.status[B], { state: 'ok', since: '2026-10-01', count: 1, changed: '2026-10-03', etag: '"v2"' });
  assert.deepEqual(r.news[A], { added: 0, modified: 0, unchanged: true });
  assert.deepEqual(r.news[B], { added: 0, modified: 0 });
  assert.deepEqual(r.events.map((e) => e.id).sort(), [eventId(A, 'x'), eventId(B, 'y')].sort());
});

test('changed moves on a new or modified event, not on a removal; validators only from an ok fetch', () => {
  const prev = { events: [ev(A, 'x'), ev(A, 'gone')], status: { [A]: { state: 'ok', since: '2026-10-01', count: 2, changed: '2026-10-03', etag: '"old"' } } };
  const removed = run([[A, { state: 'ok', events: [ev(A, 'x')] }]], prev);
  assert.equal(removed.status[A].changed, '2026-10-03', 'a removal alone is not news');
  assert.equal(removed.status[A].etag, undefined, 'validators are never carried from the previous run');
  assert.deepEqual(removed.news[A], { added: 0, modified: 0 });
  const edited = run([[A, { state: 'ok', events: [ev(A, 'x', { title: 'Heimspiel (neu)' })] }]], prev);
  assert.equal(edited.status[A].changed, '2026-10-14');
  assert.deepEqual(edited.news[A], { added: 0, modified: 1 });
  const added = run([[A, { state: 'partial', events: [ev(A, 'z', { start: '2026-10-19T15:00:00+02:00' })], error: 'page cap', validators: { etag: '"p"' } }]], prev);
  assert.equal(added.status[A].changed, '2026-10-14');
  assert.deepEqual(added.news[A], { added: 1, modified: 0 });
  assert.equal(added.status[A].etag, undefined, 'a partial answer leaves no validators');
  const failed = run([[A, { state: 'error', events: [], error: 'HTTP 500' }]], prev);
  assert.equal(failed.status[A].changed, '2026-10-03', 'a failure carries changed');
  assert.equal(failed.news[A], undefined);
  const oversized = run([[A, { state: 'ok', events: [ev(A, 'x')], validators: { etag: 'x'.repeat(201), lastModified: 'y'.repeat(65) } }]], prev);
  assert.equal(oversized.status[A].etag, undefined);
  assert.equal(oversized.status[A].lastModified, undefined);
  assert.deepEqual(newsOf([ev(A, 'x'), ev(A, 'n')], [ev(A, 'x', { title: 'alt' })]), { added: 1, modified: 1 });
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

test('switching between error and blocked keeps the outage start', () => {
  const prev = { events: [ev(A, 'x')], status: { [A]: { state: 'error', since: '2026-10-07', count: 1, error: 'HTTP 500' } } };
  const r = run([[A, { state: 'blocked', events: [], error: 'robots.txt' }], [B, { state: 'ok', events: [] }]], prev, '2026-10-15');
  assert.equal(r.status[A].since, '2026-10-07');
  assert.equal(r.events.length, 0, 'retention counts from the first failure: 8 days, dropped');
});

test('previous events are fitted to the current registry', () => {
  const known = { sportIds: new Set(['rugby', 'sonstiges']), clubIds: new Set(['rc-bonn-rhein-sieg']) };
  const prev = {
    events: [ev(A, 'kept'), ev(A, 'renamed', { sports: ['rugby-union'], start: '2026-10-18T15:00:00+02:00' }), ev('gone-club/feed', 'orphan', { start: '2026-10-19T15:00:00+02:00' })],
    status: { [A]: { state: 'ok', since: '2026-10-01', count: 2 } },
  };
  const r = mergeRun({ results: new Map([[A, { state: 'error', events: [], error: 'down' }], [B, { state: 'ok', events: [] }]]), previous: prev, order, window: WINDOW, today: '2026-10-14', known });
  assert.deepEqual(r.events.map((e) => [e.id, e.sports.join()]), [[eventId(A, 'kept'), 'rugby'], [eventId(A, 'renamed'), 'sonstiges']]);
  const outage = mergeRun({ results: new Map([[A, { state: 'error', events: [], error: 'down' }]]), previous: prev, order, window: WINDOW, today: '2026-10-14', known });
  assert.equal(outage.allFailed, true);
  assert.ok(!outage.events.some((e) => e.source === 'gone-club/feed'), 'a removed source never comes back, not even in an outage');
});

test('a retained multi-day event that began before the window stays while it lasts into it', () => {
  const camp = ev(A, 'camp', { start: '2026-08-30T10:00:00+02:00', end: '2026-09-03T16:00:00+02:00' });
  const prev = { events: [camp], status: { [A]: { state: 'ok', since: '2026-08-01', count: 1 } } };
  const r = run([[A, { state: 'error', events: [], error: 'down' }], [B, { state: 'ok', events: [] }]], prev);
  assert.deepEqual(r.events.map((e) => e.id), [camp.id]);
});

test('a date that only entered the window this month is not news; a disabled source carries no changed', () => {
  const future = ev(A, 'f', { start: '2027-11-05T15:00:00+01:00' });
  assert.deepEqual(newsOf([ev(A, 'x'), future], [ev(A, 'x')], '2027-11-01'), { added: 0, modified: 0 });
  assert.deepEqual(newsOf([ev(A, 'x'), future], [ev(A, 'x')]), { added: 1, modified: 0 });
  const prev = { events: [ev(A, 'x')], status: { [A]: { state: 'ok', since: '2026-10-01', count: 1, changed: '2026-10-03' }, [P]: { state: 'ok', since: '2026-10-01', count: 0, changed: '2026-10-03' } }, window: { from: '2026-09-01', to: '2027-11-01' } };
  const moved = mergeRun({ results: new Map([[A, { state: 'ok', events: [ev(A, 'x'), future] }], [P, { state: 'disabled', events: [] }]]), previous: prev, order, window: { from: '2026-10-01', to: '2027-12-01' }, today: '2026-11-02' });
  assert.equal(moved.status[A].changed, '2026-10-03');
  assert.deepEqual(moved.status[P], { state: 'disabled', since: '2026-11-02', count: 0 });
});

test('news is measured on the published events: a copy that loses dedup every run is never new', () => {
  const own = ev(A, 'own', { title: 'Heimspiel gegen Köln' });
  const copy = ev(P, 'copy', { club: 'rc-bonn-rhein-sieg', title: 'Heimspiel gegen Köln' });
  const first = run([[A, { state: 'ok', events: [own] }], [P, { state: 'ok', events: [copy] }]], null);
  assert.equal(first.dropped, 1);
  assert.deepEqual(first.events.map((e) => e.source), [A]);
  const prev = { events: first.events, status: first.status };
  const second = mergeRun({ results: new Map([[A, { state: 'ok', events: [own] }], [P, { state: 'ok', events: [copy] }]]), previous: prev, order, window: WINDOW, today: '2026-10-15' });
  assert.deepEqual(second.news[P], { added: 0, modified: 0 });
  assert.equal(second.status[P].changed, '2026-10-14');
  assert.deepEqual(second.status, first.status);
});
