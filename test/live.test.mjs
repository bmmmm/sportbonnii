// Live check of every enabled registry source (RUN_LIVE=1, real network —
// run it unsandboxed). Skips itself otherwise, so `pnpm test` stays offline.
//
// Per source: parses, ≥ 1 event in the window unless `expectEmpty`, not
// partial. Across all timed events: ≥ 90 % start between 06:00 and 23:00
// Berlin — a timezone bug shifts whole feeds into the night.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRegistry } from '../pipeline/registry.mjs';
import { loadAdapter } from '../pipeline/adapters/index.mjs';
import { createNet } from '../pipeline/net.mjs';
import { buildContext, normalizeEvent } from '../pipeline/model.mjs';
import { windowFor } from '../pipeline/run.mjs';
import { berlinDate } from '../pipeline/tz.mjs';
import { checkEvent } from '../pipeline/contract.mjs';

const LIVE = process.env.RUN_LIVE === '1';
const registry = await loadRegistry();
const ctx = buildContext(registry);
const today = berlinDate(Date.now());
const window = windowFor(today);
const net = createNet();
const timed = [];

const owners = [...registry.clubs.map((o) => ({ owner: o, kind: 'club' })), ...registry.platforms.map((o) => ({ owner: o, kind: 'platform' }))];
for (const { owner, kind } of owners) {
  for (const source of owner.sources) {
    if (source.enabled === false || owner.active === false) continue;
    test(`live: ${owner.id}/${source.id} (${source.type})`, { skip: !LIVE && 'set RUN_LIVE=1', timeout: 180_000 }, async () => {
      const adapter = await loadAdapter(source.type);
      const r = await adapter.fetchEvents(source, { window, today, get: net.get });
      assert.equal(r.partial, undefined, `partial: ${r.partial?.reason}`);
      const events = r.events.map((raw) => normalizeEvent(raw, { owner, kind, source, ctx, window })).filter(Boolean);
      for (const e of events) assert.deepEqual(checkEvent(e), [], e.title);
      if (!source.expectEmpty) assert.ok(events.length >= 1, `no events in ${window.from}…${window.to}`);
      for (const e of events) if (!e.allDay) timed.push({ key: `${owner.id}/${source.id}`, hour: Number(e.start.slice(11, 13)), title: e.title });
      console.log(`# ${owner.id}/${source.id}: ${events.length} events, ${r.warnings.length} warnings${r.warnings.length ? ` (${r.warnings[0]})` : ''}`);
    });
  }
}

test('live: timed events start at plausible Berlin hours', { skip: !LIVE && 'set RUN_LIVE=1' }, () => {
  assert.ok(timed.length > 0, 'no timed events at all');
  const plausible = timed.filter((t) => t.hour >= 6 && t.hour <= 23);
  const share = plausible.length / timed.length;
  const odd = timed.filter((t) => t.hour < 6 || t.hour > 23).slice(0, 5).map((t) => `${t.key} ${t.hour}h ${t.title}`);
  assert.ok(share >= 0.9, `only ${(share * 100).toFixed(1)} % between 06 and 23 h: ${odd.join('; ')}`);
});
