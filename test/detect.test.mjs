// Detection ladder over a fake network, shaped after the real starter sites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectSource, sourceSnippet } from '../pipeline/detect.mjs';
import { createNet } from '../pipeline/net.mjs';

const fx = (p) => readFileSync(new URL(`./fixtures/${p}`, import.meta.url), 'utf8');

function fakeNet(table) {
  const calls = [];
  return {
    calls,
    async get(url, opts) {
      calls.push({ url, ...opts });
      const v = table[url];
      if (v === undefined) throw new Error('HTTP 404');
      return { body: v, url, status: 200 };
    },
  };
}

const WP_HEAD = '<!doctype html><html><head><link rel="https://api.w.org/" href="https://www.club.example/blog/wp-json/"><link rel="stylesheet" href="/blog/wp-content/x.css"></head><body>';

test('an ICS URL is ical as given; the first request asks like a browser and skips robots', async () => {
  const net = fakeNet({ 'https://cal.example/x.ics': fx('ical/vtimezone.ics') });
  const r = await detectSource('https://cal.example/x.ics', { net });
  assert.deepEqual([r.ok, r.type, r.url], [true, 'ical', 'https://cal.example/x.ics']);
  assert.match(net.calls[0].accept, /^text\/html/);
  assert.equal(net.calls[0].robots, false);
  assert.deepEqual(sourceSnippet(r), { id: 'kalender', type: 'ical', url: 'https://cal.example/x.ics' });
});

test('JSON endpoints: Gancio array and The Events Calendar response', async () => {
  const g = await detectSource('https://bonn.jetzt/api/events', { net: fakeNet({ 'https://bonn.jetzt/api/events': fx('gancio/bonn-jetzt-sport.json') }) });
  assert.equal(g.type, 'gancio');
  const t = await detectSource('https://bsvroleber.de/wp-json/tribe/events/v1/events', { net: fakeNet({ 'https://bsvroleber.de/wp-json/tribe/events/v1/events': fx('tec/bsvroleber.json') }) });
  assert.equal(t.type, 'tec');
  const empty = await detectSource('https://quiet.example/api/events', { net: fakeNet({ 'https://quiet.example/api/events': '[]' }) });
  assert.equal(empty.type, 'gancio', 'an empty array on a Gancio path counts');
  const other = await detectSource('https://x.example/data', { net: fakeNet({ 'https://x.example/data': '{"a":1}' }) });
  assert.equal(other.ok, false);
});

test('a Gancio homepage is found through /feed/json and mapped to /api/events', async () => {
  const net = fakeNet({ 'https://bonn.jetzt/': '<!doctype html><html><body>Gancio</body></html>', 'https://bonn.jetzt/feed/json': fx('gancio/bonn-jetzt-sport.json') });
  const r = await detectSource('https://bonn.jetzt/', { net });
  assert.deepEqual([r.type, r.url], ['gancio', 'https://bonn.jetzt/api/events']);
  assert.equal(net.calls[1].robots, true, 'probes honour robots.txt');
});

test('WordPress in a subdirectory behind a meta refresh: TEC at the announced REST root', async () => {
  const net = fakeNet({
    'https://www.club.example/': '<html><head><meta http-equiv="REFRESH" content="0;url=https://www.club.example/blog"></head></html>',
    'https://www.club.example/blog': `${WP_HEAD}<a href="https://www.club.example/blog/events/?ical=1">iCal</a></body></html>`,
    'https://www.club.example/blog/wp-json/tribe/events/v1/events': fx('tec/bthv-page1.json'),
  });
  const r = await detectSource('https://www.club.example/', { net });
  assert.deepEqual([r.type, r.url], ['tec', 'https://www.club.example/blog/wp-json/tribe/events/v1/events']);
});

test('WordPress without TEC: a Google Calendar embed wins, the TEC-style .ics export does not', async () => {
  const embed = '<iframe src="https://calendar.google.com/calendar/u/0/embed?showTitle=0&amp;height=600&amp;src=qo6kqa6o5e7l2hm5r92fn16ne4@group.calendar.google.com&amp;ctz=Europe%2FBerlin"></iframe>';
  const net = fakeNet({ 'https://rc.example/kalender/': `${WP_HEAD}${embed}<a href="/events/?ical=1">x.ics</a><link rel="alternate" type="application/rss+xml" href="https://rc.example/feed/"></body></html>` });
  const r = await detectSource('https://rc.example/kalender/', { net });
  assert.equal(r.type, 'ical');
  assert.equal(r.url, 'https://calendar.google.com/calendar/ical/qo6kqa6o5e7l2hm5r92fn16ne4%40group.calendar.google.com/public/basic.ics');
  const plain = fakeNet({ 'https://wp.example/': `${WP_HEAD}<a href="https://wp.example/events/list/?ical=1&tribe-bar-date=x">Export .ics</a><link rel="alternate" type="application/rss+xml" href="https://wp.example/feed/"></body></html>` });
  assert.equal((await detectSource('https://wp.example/', { net: plain })).type, 'rss', 'falls through to the feed');
});

test('a non-WordPress page: linked iCal export, then JSON-LD, then RSS, else a diagnosis', async () => {
  const ics = fakeNet({ 'https://c.example/t': '<html><body><a href="webcal://c.example/a.ics">Abo</a><a href="/b.ics">B</a></body></html>' });
  const r = await detectSource('https://c.example/t', { net: ics });
  assert.deepEqual([r.type, r.url], ['ical', 'https://c.example/a.ics']);
  assert.match(r.note, /2 iCal exports/);
  const ld = fakeNet({ 'https://www.bthv.de/blog/': fx('jsonld/bthv-blog.html').replace('wp-site', 'site') });
  assert.equal((await detectSource('https://www.bthv.de/blog/', { net: ld })).type, 'jsonld');
  const none = fakeNet({ 'https://n.example/': '<!doctype html><html><body>Hallo</body></html>' });
  const n = await detectSource('https://n.example/', { net: none });
  assert.equal(n.ok, false);
  assert.match(n.diagnosis, /could not find a supported calendar/);
  const down = await detectSource('https://gone.example/', { net: fakeNet({}) });
  assert.match(down.diagnosis, /could not fetch/);
});

test('the intake configuration: https only, a request budget', async () => {
  const net = createNet({ httpsOnly: true, maxRequests: 4, lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }], fetchImpl: async () => new Response('<html><body>x</body></html>'), minGapMs: 0 });
  assert.equal((await detectSource('http://plain.example/', { net })).ok, false);
  const r = await detectSource('https://plain.example/', { net });
  assert.equal(r.ok, false);
  assert.ok(net.requestCount <= 4);
});
