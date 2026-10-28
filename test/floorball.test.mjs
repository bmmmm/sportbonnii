import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseIcal } from '../pipeline/adapters/ical.mjs';
import { normalizeEvent, buildContext, windowMs } from '../pipeline/model.mjs';
import { loadRegistry } from '../pipeline/registry.mjs';

test('official Floorball league calendar: only SSF fixtures, with home and away from the pairing', async () => {
  const registry = await loadRegistry();
  const owner = registry.clubs.find((c) => c.id === 'ssf-bonn');
  const source = owner.sources.find((s) => s.id === 'spiele-floorball-herren');
  const window = { from: '2026-09-01', to: '2027-11-01' };
  const raw = parseIcal(readFileSync(new URL('./fixtures/ical/floorball.ics', import.meta.url), 'utf8'), windowMs(window)).events;
  const events = raw.map((e) => normalizeEvent(e, { owner, source, kind: 'club', ctx: buildContext(registry), window })).filter(Boolean);
  assert.equal(raw.length, 3);
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.kind === 'spiel' && e.sports.join() === 'floorball'));
  assert.deepEqual(events.map((e) => e.home), [false, true]);
});
