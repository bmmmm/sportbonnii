// End-to-end: a temporary registry served by a fake network → site/data
// files that honour the contract, byte-identical across runs and across the
// order in which sources answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { run, normalizeAll } from '../pipeline/run.mjs';
import { firstPageUrl } from '../pipeline/adapters/tec.mjs';
import { loadRegistry } from '../pipeline/registry.mjs';
import { buildContext } from '../pipeline/model.mjs';
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
  sleep: async () => {}, minGapMs: 0, previousStateUrl: undefined, build: null, log: () => {},
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

test('one hostile item in a feed costs that item, not the run', async () => {
  const reg = await tempRegistry({
    clubs: [{ id: 'g-club', name: 'G Club', sports: ['radsport'], website: 'https://g.example/', sources: [{ id: 'termine', type: 'gancio', url: 'https://g.example/api/events' }] }],
    platforms: [],
  });
  const items = [
    { id: 1, title: 'Kaputt', slug: 'kaputt', start_datetime: 1e16 },
    { id: 2, title: 'Ausfahrt', slug: 'ausfahrt', start_datetime: Date.parse('2026-10-20T16:00:00Z') / 1000 },
  ];
  const fetchImpl = async (url) => (String(url).endsWith('/robots.txt') ? new Response('', { status: 404 }) : new Response(JSON.stringify(items)));
  const r = await run(opts(await mkdtemp(join(tmpdir(), 'sb-hostile-')), reg, fetchImpl));
  assert.equal(r.status['g-club/termine'].state, 'ok');
  assert.deepEqual(r.events.map((e) => e.title), ['Ausfahrt']);
});

test('normalizeAll: an item that throws is skipped with a warning, duplicates collapse', async () => {
  const registry = await loadRegistry();
  const owner = registry.clubs.find((c) => c.id === 'bsv-roleber');
  const good = { uid: 'g', recurrenceId: '', title: 'Training', allDay: false, startMs: Date.parse('2026-10-20T17:00:00Z'), endMs: null, tags: [] };
  const broken = { ...good, uid: 'b', tags: 'not-a-list' }; // .map on a string throws inside normalizeEvent
  const r = normalizeAll({ events: [good, broken, good], warnings: ['w0'] }, { owner, kind: 'club', source: owner.sources[0], ctx: buildContext(registry), window: { from: '2026-09-01', to: '2027-11-01' } });
  assert.deepEqual(r.events.map((e) => e.title), ['Training']);
  assert.equal(r.warnings[0], 'w0');
  assert.match(r.warnings[1], /skipped an event \(b\)/);
});

/** fetch over a url → body table that tags every body with an ETag and answers 304 to a matching If-None-Match. */
function conditionalFetch(table, log = []) {
  return async (url, init) => {
    const key = String(url);
    log.push({ url: key, headers: init?.headers ?? {} });
    if (key.endsWith('/robots.txt')) return new Response('', { status: 404 });
    const body = table[key];
    if (body === undefined) return new Response('nope', { status: 404 });
    const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 8)}"`;
    if (init?.headers?.['if-none-match'] === etag) return new Response(null, { status: 304, headers: { etag } });
    return new Response(body, { headers: { etag } });
  };
}

test('a 304 keeps a source untouched; validators are reused only for the same build and window', async () => {
  const reg = await tempRegistry(REG);
  const out = await mkdtemp(join(tmpdir(), 'sb-cond-'));
  const table = { 'https://rc.example/k.ics': await fixture('ical/edge-cases.ics'), 'https://other.example/z.ics': await fixture('ical/vtimezone.ics') };
  const log = [];
  const base = { ...opts(out, reg, conditionalFetch(table, log)), build: 'abc123' };
  const conditional = () => log.filter((l) => l.headers['if-none-match']).map((l) => l.url).sort();

  const first = await run(base);
  const files1 = await readOut(out);
  assert.deepEqual(checkSiteData(files1), []);
  assert.equal(JSON.parse(files1['meta.json']).build, 'abc123');
  assert.match(first.status['rc-test/kalender'].etag, /^"[0-9a-f]{8}"$/);
  assert.equal(first.status['rc-test/kalender'].changed, '2026-10-14');
  assert.match(first.summary, /\| rc-test\/kalender \| ok \| \d+ \| new \| \d+ new, 0 modified \|/);
  // zweit shares two dates with kalender and loses them to dedup: its delivery is not fully published.
  const published = (res, key) => res.events.filter((e) => e.source === key).length;
  assert.ok(published(first, 'rc-test/zweit') < first.status['rc-test/zweit'].count, 'the fixture pair must produce a dedup loser');
  assert.equal(published(first, 'rc-test/kalender'), first.status['rc-test/kalender'].count);

  // Same build, same window, next day: kalender is asked conditionally and answers 304;
  // zweit is read in full (a 304 could not bring its dropped copies back) and is still not news.
  log.length = 0;
  const second = await run({ ...base, now: new Date('2026-10-15T10:00:00Z') });
  assert.deepEqual(conditional(), ['https://rc.example/k.ics']);
  assert.deepEqual(second.status, first.status, 'nothing moves in status.json — not even for the dedup loser');
  assert.equal(second.events.length, first.events.length);
  assert.match(second.summary, /\| rc-test\/kalender \| ok \| \d+ \| ±0 \| unchanged \(304\) \|/);
  assert.match(second.summary, /\| rc-test\/zweit \| ok \| \d+ \| ±0 \| unchanged \|/);
  assert.match(second.summary, /2 of 2 fetched source\(s\) without news/);
  const files2 = await readOut(out);
  for (const name of Object.keys(files1)) if (name !== 'meta.json') assert.equal(files2[name], files1[name], `${name} changed on a run without news`);

  // The feed changes: the ETag no longer matches, the modified event moves `changed`.
  log.length = 0;
  const edited = { ...table, 'https://rc.example/k.ics': table['https://rc.example/k.ics'].replace('SUMMARY:', 'SUMMARY:Neu – ') };
  const third = await run({ ...base, fetchImpl: conditionalFetch(edited, log), now: new Date('2026-10-15T16:00:00Z') });
  assert.deepEqual(conditional(), ['https://rc.example/k.ics']);
  assert.equal(third.status['rc-test/kalender'].changed, '2026-10-15');
  assert.equal(third.status['rc-test/zweit'].changed, '2026-10-14', 'the untouched feed keeps its date');
  assert.notEqual(third.status['rc-test/kalender'].etag, first.status['rc-test/kalender'].etag);
  assert.match(third.summary, /\| rc-test\/kalender \| ok \| \d+ \| ±0 \| 0 new, [1-9]\d* modified \|/);

  // Another build (a push): a full fetch, no validators sent, identical content is not news.
  log.length = 0;
  const fourth = await run({ ...base, fetchImpl: conditionalFetch(edited, log), build: 'def456', now: new Date('2026-10-15T22:00:00Z') });
  assert.deepEqual(conditional(), []);
  assert.equal(fourth.status['rc-test/kalender'].changed, '2026-10-15');
  assert.match(fourth.summary, /\| rc-test\/kalender \| ok \| \d+ \| ±0 \| unchanged \|/);

  // Same build, but the window moved (a new month): a full fetch (the window-extension rule for `changed` is pinned in merge.test).
  log.length = 0;
  await run({ ...base, fetchImpl: conditionalFetch(edited, log), build: 'def456', now: new Date('2026-11-02T10:00:00Z') });
  assert.deepEqual(conditional(), []);

  // No build known (a local run): never conditional, also not against a previous local run.
  log.length = 0;
  await run({ ...base, fetchImpl: conditionalFetch(edited, log), build: null, now: new Date('2026-11-02T16:00:00Z') });
  assert.deepEqual(conditional(), []);
  assert.equal(JSON.parse((await readOut(out))['meta.json']).build, undefined);
  log.length = 0;
  await run({ ...base, fetchImpl: conditionalFetch(edited, log), build: null, now: new Date('2026-11-02T22:00:00Z') });
  assert.deepEqual(conditional(), []);
});

test('validators from the live site (PREVIOUS_STATE_URL) are reused on the same build', async () => {
  const reg = await tempRegistry(REG);
  const site = await mkdtemp(join(tmpdir(), 'sb-live-site-'));
  const table = { 'https://rc.example/k.ics': await fixture('ical/edge-cases.ics'), 'https://other.example/z.ics': await fixture('ical/vtimezone.ics') };
  await run({ ...opts(site, reg, conditionalFetch(table)), build: 'abc123' });
  const live = {};
  for (const n of ['events.json', 'status.json', 'meta.json']) live[`https://live.example/data/${n}`] = await readFile(join(site, n), 'utf8');
  const log = [];
  const fresh = await mkdtemp(join(tmpdir(), 'sb-live-fresh-'));
  const conditional = () => log.filter((l) => l.headers['if-none-match']).map((l) => l.url);
  const same = await run({ ...opts(fresh, reg, conditionalFetch({ ...table, ...live }, log)), previousStateUrl: 'https://live.example/data/', build: 'abc123', now: new Date('2026-10-15T10:00:00Z') });
  assert.deepEqual(conditional(), ['https://rc.example/k.ics']);
  assert.match(same.summary, /\| rc-test\/kalender \| ok \| \d+ \| ±0 \| unchanged \(304\) \|/);
  log.length = 0;
  const other = await mkdtemp(join(tmpdir(), 'sb-live-other-'));
  await run({ ...opts(other, reg, conditionalFetch({ ...table, ...live }, log)), previousStateUrl: 'https://live.example/data/', build: 'def456', now: new Date('2026-10-15T10:00:00Z') });
  assert.deepEqual(conditional(), [], 'another build reads everything again');
});

test('a multi-request adapter is never asked conditionally', async () => {
  const reg = await tempRegistry({
    clubs: [{ id: 'bsv-test', name: 'BSV Test', sports: ['fussball'], website: 'https://bsv.example/', sources: [{ id: 'tec', type: 'tec', url: 'https://bsv.example/wp-json/tribe/events/v1/events' }] }],
    platforms: [],
  });
  const out = await mkdtemp(join(tmpdir(), 'sb-tec-'));
  const table = { [firstPageUrl('https://bsv.example/wp-json/tribe/events/v1/events', { from: '2026-09-01', to: '2027-11-01' })]: await fixture('tec/bsvroleber.json') };
  const log = [];
  const base = { ...opts(out, reg, conditionalFetch(table, log)), build: 'abc123' };
  const first = await run(base);
  assert.equal(first.status['bsv-test/tec'].state, 'ok');
  assert.equal(first.status['bsv-test/tec'].etag, undefined, 'no validators are kept: page 1 does not describe the source');
  log.length = 0;
  const second = await run({ ...base, now: new Date('2026-10-15T10:00:00Z') });
  assert.equal(log.filter((l) => l.headers['if-none-match']).length, 0);
  assert.match(second.summary, /\| bsv-test\/tec \| ok \| \d+ \| ±0 \| unchanged \|/);
});

/** fetch that validates with Last-Modified only, like a static file server without ETags. */
function lastModifiedFetch(table, log = []) {
  const stamp = 'Mon, 05 Oct 2026 10:00:00 GMT';
  return async (url, init) => {
    const key = String(url);
    log.push({ url: key, headers: init?.headers ?? {} });
    if (key.endsWith('/robots.txt')) return new Response('', { status: 404 });
    const body = table[key];
    if (body === undefined) return new Response('nope', { status: 404 });
    if (init?.headers?.['if-modified-since'] === stamp) return new Response(null, { status: 304, headers: { 'last-modified': stamp } });
    return new Response(body, { headers: { 'last-modified': stamp } });
  };
}

test('a source that validates with Last-Modified only is asked conditionally too', async () => {
  const reg = await tempRegistry({
    clubs: [{ id: 'lm-test', name: 'LM Test', sports: ['rugby'], website: 'https://lm.example/', sources: [{ id: 'kalender', type: 'ical', url: 'https://lm.example/k.ics' }] }],
    platforms: [],
  });
  const out = await mkdtemp(join(tmpdir(), 'sb-lm-'));
  const table = { 'https://lm.example/k.ics': await fixture('ical/edge-cases.ics') };
  const log = [];
  const base = { ...opts(out, reg, lastModifiedFetch(table, log)), build: 'abc123' };
  const first = await run(base);
  assert.equal(first.status['lm-test/kalender'].lastModified, 'Mon, 05 Oct 2026 10:00:00 GMT');
  assert.equal(first.status['lm-test/kalender'].etag, undefined);
  log.length = 0;
  const second = await run({ ...base, now: new Date('2026-10-15T10:00:00Z') });
  assert.deepEqual(log.filter((l) => l.headers['if-modified-since']).map((l) => l.url), ['https://lm.example/k.ics']);
  assert.equal(log.some((l) => l.headers['if-none-match']), false, 'no ETag, no If-None-Match');
  assert.match(second.summary, /\| lm-test\/kalender \| ok \| \d+ \| ±0 \| unchanged \(304\) \|/);
  assert.deepEqual(second.status, first.status);
});
