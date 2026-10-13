// End-to-end: a temporary registry served by a fake network → site/data
// files that honour the contract, byte-identical across runs and across the
// order in which sources answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../pipeline/run.mjs';
import { canonicalJson, canonicalClubs } from '../pipeline/registry.mjs';
import { checkSiteData } from '../pipeline/contract.mjs';

const fixture = (p) => readFile(new URL(`./fixtures/${p}`, import.meta.url), 'utf8');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const NOW = new Date('2026-10-14T10:23:00Z');

/** A registry directory with the given clubs/platforms and the real taxonomy. */
export async function tempRegistry(doc) {
  const dir = await mkdtemp(join(tmpdir(), 'sb-reg-'));
  await writeFile(join(dir, 'clubs.json'), canonicalJson(canonicalClubs(doc)));
  await copyFile(join(ROOT, 'registry/sports.json'), join(dir, 'sports.json'));
  return dir;
}

/** fetch over a url → body table; optional per-url delay to shuffle completion order. */
export function servingFetch(table, delays = {}) {
  return async (url) => {
    const key = String(url);
    if (delays[key]) await new Promise((r) => setTimeout(r, delays[key]));
    if (key.endsWith('/robots.txt')) return new Response('', { status: 404 });
    const body = table[key];
    if (body === undefined) return new Response('nope', { status: 404 });
    if (body instanceof Error) throw body;
    return new Response(body);
  };
}

const REG = {
  clubs: [
    { id: 'rc-test', name: 'RC Test', sports: ['rugby'], website: 'https://rc.example/', aliases: ['RC Test'],
      sources: [{ id: 'kalender', type: 'ical', url: 'https://rc.example/k.ics' }, { id: 'zweit', type: 'ical', url: 'https://other.example/z.ics' }] },
    { id: 'off-test', name: 'Off Test', sports: ['tennis'], website: 'https://off.example/',
      sources: [{ id: 'aus', type: 'ical', url: 'https://off.example/a.ics', enabled: false }] },
  ],
  platforms: [],
};
const opts = (outDir, registryDir, fetchImpl) => ({
  registryDir, outDir, now: NOW, fetchImpl, lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
  sleep: async () => {}, minGapMs: 0, previousStateUrl: undefined, log: () => {},
});

async function readOut(dir) {
  const files = {};
  for (const n of await readdir(dir)) if (n.endsWith('.json')) files[n] = await readFile(join(dir, n), 'utf8');
  for (const n of await readdir(join(dir, 'ics'))) files[`ics/${n}`] = await readFile(join(dir, 'ics', n), 'utf8');
  return files;
}

test('a run writes contract-conform data and every feed', async () => {
  const reg = await tempRegistry(REG);
  const out = await mkdtemp(join(tmpdir(), 'sb-out-'));
  const table = { 'https://rc.example/k.ics': await fixture('ical/edge-cases.ics'), 'https://other.example/z.ics': await fixture('ical/vtimezone.ics') };
  const res = await run(opts(out, reg, servingFetch(table)));
  const files = await readOut(out);
  assert.deepEqual(checkSiteData(files), []);
  assert.equal(res.status['rc-test/kalender'].state, 'ok');
  assert.equal(res.status['off-test/aus'].state, 'disabled');
  assert.ok(files['ics/alle.ics'].startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(files['ics/sport-rugby.ics'] && files['ics/verein-rc-test.ics'] && files['ics/sport-sonstiges.ics']);
  assert.equal((files['ics/verein-off-test.ics'].match(/BEGIN:VEVENT/g) || []).length, 0);
  assert.match(res.summary, /\| rc-test\/kalender \| ok \| \d+ \| new \|/);
  assert.equal(JSON.parse(files['meta.json']).checkedAt, NOW.toISOString());
  assert.deepEqual(JSON.parse(files['meta.json']), { checkedAt: NOW.toISOString(), sourcesOk: 2, sourcesTotal: 2 });
});

test('two runs on unchanged sources are byte-identical, whatever order the sources answer in', async () => {
  const reg = await tempRegistry(REG);
  const table = { 'https://rc.example/k.ics': await fixture('ical/edge-cases.ics'), 'https://other.example/z.ics': await fixture('ical/vtimezone.ics') };
  const a = await mkdtemp(join(tmpdir(), 'sb-a-'));
  const b = await mkdtemp(join(tmpdir(), 'sb-b-'));
  await run(opts(a, reg, servingFetch(table, { 'https://rc.example/k.ics': 30 })));
  const first = await readOut(a);
  await run(opts(a, reg, servingFetch(table)));
  await run({ ...opts(b, reg, servingFetch(table, { 'https://other.example/z.ics': 30 })), now: new Date('2026-10-14T16:23:00Z') });
  const again = await readOut(a);
  const other = await readOut(b);
  for (const name of Object.keys(first)) {
    if (name === 'meta.json') continue;
    assert.equal(again[name], first[name], `${name} changed on a second run`);
    assert.equal(other[name], first[name], `${name} depends on answer order or run time`);
  }
  assert.notEqual(other['meta.json'], first['meta.json'], 'only meta.json carries the clock');
});

test('a failing source keeps its previous events (local previous state)', async () => {
  const reg = await tempRegistry(REG);
  const out = await mkdtemp(join(tmpdir(), 'sb-prev-'));
  const good = { 'https://rc.example/k.ics': await fixture('ical/edge-cases.ics'), 'https://other.example/z.ics': await fixture('ical/vtimezone.ics') };
  const first = await run(opts(out, reg, servingFetch(good)));
  const count = first.status['rc-test/kalender'].count;
  const broken = { ...good, 'https://rc.example/k.ics': new Error('connect ECONNREFUSED') };
  const second = await run({ ...opts(out, reg, servingFetch(broken)), now: new Date('2026-10-15T10:00:00Z') });
  assert.equal(second.status['rc-test/kalender'].state, 'error');
  assert.equal(second.status['rc-test/kalender'].count, count);
  assert.equal(second.status['rc-test/kalender'].since, '2026-10-15');
  assert.equal(second.events.length, first.events.length);
  assert.match(second.summary, /\| rc-test\/kalender \| error \| \d+ \| ±0 \|/);
});

test('previous state from PREVIOUS_STATE_URL, shape-checked', async () => {
  const reg = await tempRegistry(REG);
  const site = await mkdtemp(join(tmpdir(), 'sb-site-'));
  const good = { 'https://rc.example/k.ics': await fixture('ical/edge-cases.ics'), 'https://other.example/z.ics': await fixture('ical/vtimezone.ics') };
  await run(opts(site, reg, servingFetch(good)));
  const live = { 'https://live.example/data/events.json': await readFile(join(site, 'events.json'), 'utf8'), 'https://live.example/data/status.json': await readFile(join(site, 'status.json'), 'utf8') };
  const down = { 'https://rc.example/k.ics': new Error('down'), 'https://other.example/z.ics': new Error('down'), ...live };
  const fresh = await mkdtemp(join(tmpdir(), 'sb-fresh-'));
  const r = await run({ ...opts(fresh, reg, servingFetch(down)), previousStateUrl: 'https://live.example/data/' });
  assert.equal(r.events.length > 0, true, 'events survive a total outage on a fresh runner');
  const garbage = { ...down, 'https://live.example/data/events.json': '{"version":2}' };
  const empty = await mkdtemp(join(tmpdir(), 'sb-empty-'));
  const g = await run({ ...opts(empty, reg, servingFetch(garbage)), previousStateUrl: 'https://live.example/data/' });
  assert.equal(g.events.length, 0, 'a previous state of the wrong shape is ignored');
});

test('an invalid registry stops the run', async () => {
  const dir = await tempRegistry(REG);
  await writeFile(join(dir, 'clubs.json'), (await readFile(join(dir, 'clubs.json'), 'utf8')).replace('"rc-test"', '"off-test"'));
  await mkdir(join(dir, 'x'), { recursive: true });
  await assert.rejects(run(opts(await mkdtemp(join(tmpdir(), 'sb-bad-')), dir, servingFetch({}))), /invalid registry/);
});
