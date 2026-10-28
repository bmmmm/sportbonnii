import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseOverview, fetchEvents, CONDITIONAL } from '../pipeline/adapters/dav.mjs';
import { normalizeEvent, buildContext } from '../pipeline/model.mjs';
import { loadRegistry } from '../pipeline/registry.mjs';
import { checkEvent } from '../pipeline/contract.mjs';

const html = readFileSync(new URL('./fixtures/dav/overview.html', import.meta.url), 'utf8');
const base = 'https://dav-bonn.de/termine/';
const activities = ['10', '11'];

test('DAV: captured activity cards give the selected climbing dates without inventing hours', async () => {
  const registry = await loadRegistry();
  const owner = registry.clubs.find((c) => c.id === 'dav-bonn');
  const source = owner.sources[0];
  const calls = [];
  const r = await fetchEvents(source, { get: async (...args) => { calls.push(args); return { body: html, url: base }; } });
  assert.equal(CONDITIONAL, true);
  assert.deepEqual(calls, [[base]], 'one robots-aware request stands for the overview');
  assert.equal(r.events.length, 3);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.partial, undefined);
  for (const raw of r.events) {
    const e = normalizeEvent(raw, { owner, source, kind: 'club', ctx: buildContext(registry), window: { from: '2026-09-01', to: '2027-11-01' } });
    assert.deepEqual(checkEvent(e), []);
    assert.equal(e.timeUnknown, true);
    assert.deepEqual(e.sports, ['klettern']);
  }
  assert.equal(r.events.at(-1).startDate, '2027-05-23');
});

test('DAV: a changed layout fails; broken dates or foreign links make the result partial', () => {
  assert.throws(() => parseOverview('<html>Error</html>', base, activities), /layout changed/);
  for (const changed of [html.replace('23.05.2027', '31.02.2027'), html.replace('href="/termine/2027-5-23/', 'href="https://foreign.example/termine/2027-5-23/')]) {
    const r = parseOverview(changed, base, activities);
    assert.equal(r.events.length, 2);
    assert.ok(r.partial);
    assert.equal(r.warnings.length, 1);
  }
});
