import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceWarnings } from '../pipeline/health.mjs';

const source = { id: 'spiele', kind: 'spiel' };
const registry = (s) => ({ clubs: [{ id: 'club', sources: [s] }], platforms: [] });
const event = (start, extra = {}) => ({ source: 'club/spiele', start, status: 'confirmed', ...extra });
const check = (s, events, state = { state: 'ok', count: events.length }) => sourceWarnings({ registry: registry(s), events, status: { 'club/spiele': state }, today: '2026-10-28' });

test('source health: review is due 30 days ahead, including after its deadline', () => {
  assert.equal(check({ ...source, reviewAfter: '2026-11-27' }, []).at(0).code, 'review');
  assert.equal(check({ ...source, reviewAfter: '2026-09-01' }, []).at(0).code, 'review');
  assert.equal(check({ ...source, reviewAfter: '2026-11-28' }, [event('2027-01-01')]).length, 0);
});

test('source health: warn for empty or ending schedules, without counting cancelled dates', () => {
  assert.equal(check(source, []).at(0).code, 'empty');
  assert.equal(check(source, [event('2026-10-27')]).at(0).code, 'empty');
  assert.equal(check(source, [event('2026-11-20'), event('2027-01-01', { status: 'cancelled' })]).at(0).code, 'ending');
  assert.deepEqual(check(source, [event('2026-11-28')]), []);
  assert.deepEqual(check({ ...source, kind: 'training' }, [event('2026-11-20')]), []);
});

test('source health: disabled, expected empty, failed and dedup-losing sources do not get false empty warnings', () => {
  for (const s of [{ ...source, enabled: false }, { ...source, expectEmpty: true }]) assert.deepEqual(check(s, []), []);
  assert.deepEqual(check(source, [], { state: 'error', count: 0 }), []);
  assert.deepEqual(check(source, [], { state: 'ok', count: 12 }), []);
  assert.deepEqual(check(source, [event('2026-11-01')], { state: 'ok', count: 12 }), [], 'a dedup loser may have later dates');
});
