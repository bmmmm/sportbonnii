// TEC, Gancio, JSON-LD and RSS adapters on payloads captured from the live
// sources on 2026-10-14, plus injected `get` for paging and hostile links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as tec from '../pipeline/adapters/tec.mjs';
import * as gancio from '../pipeline/adapters/gancio.mjs';
import * as jsonld from '../pipeline/adapters/jsonld.mjs';
import * as rss from '../pipeline/adapters/rss.mjs';
import { toBerlinIso } from '../pipeline/tz.mjs';
import { normalizeEvent, buildContext } from '../pipeline/model.mjs';
import { loadRegistry } from '../pipeline/registry.mjs';

const WINDOW = { from: '2026-09-01', to: '2027-11-01' };
const fx = (p) => readFileSync(new URL(`./fixtures/${p}`, import.meta.url), 'utf8');
const at = (e) => toBerlinIso(e.startMs);

/** ctx.get over a table; records every request. */
function ctxFor(table) {
  const calls = [];
  return {
    calls,
    window: WINDOW,
    today: '2026-10-14',
    async get(url, opts = {}) {
      calls.push({ url, opts });
      const hit = typeof table === 'function' ? table(url) : table[url];
      if (hit === undefined) throw new Error(`HTTP 404 for ${url}`);
      if (hit instanceof Error) throw hit;
      return { body: hit, url, status: 200 };
    },
  };
}

// --- TEC ----------------------------------------------------------------------

const BTHV = 'https://www.bthv.de/blog/wp-json/tribe/events/v1/events';
const bthvPages = () => {
  const pages = [1, 2, 3].map((p) => fx(`tec/bthv-page${p}.json`));
  return (url) => {
    const page = Number(new URL(url).searchParams.get('page') ?? 1);
    return pages[page - 1];
  };
};

test('tec: the first request carries the window, paging follows next_rest_url', async () => {
  const ctx = ctxFor(bthvPages());
  const r = await tec.fetchEvents({ url: BTHV }, ctx);
  const first = new URL(ctx.calls[0].url);
  assert.equal(first.searchParams.get('start_date'), '2026-09-01 00:00:00');
  assert.equal(first.searchParams.get('end_date'), '2027-11-01 00:00:00');
  assert.equal(first.searchParams.get('per_page'), '50');
  assert.equal(ctx.calls.length, 3);
  assert.equal(r.events.length, 22);
  assert.equal(r.partial, undefined);
  const damen = r.events.find((e) => e.title === 'Hockey: 1. Damen – Uhlenhorst Mülheim');
  assert.ok(damen, 'entity-decoded title');
  assert.equal(at(damen), '2026-10-15T20:00:00+02:00');
  assert.equal(toBerlinIso(damen.endMs), '2026-10-15T22:00:00+02:00');
  assert.deepEqual(damen.tags, ['Hockey']);
  assert.match(damen.url, /^https:\/\/www\.bthv\.de\/blog\/event\//);
  assert.equal(new Set(r.events.map((e) => e.uid)).size, 22);
});

test('tec: the BSV Roleber camp keeps its local times and plain-text description', async () => {
  const r = await tec.fetchEvents({ url: 'https://bsvroleber.de/wp-json/tribe/events/v1/events' }, ctxFor(() => fx('tec/bsvroleber.json')));
  assert.equal(r.events.length, 1);
  const [e] = r.events;
  assert.equal(e.title, 'Herbst: Fußballcamp');
  assert.equal(at(e), '2026-10-26T08:00:00+01:00');
  assert.equal(toBerlinIso(e.endMs), '2026-10-29T16:00:00+01:00');
  assert.equal(e.description, 'featured by Stegis Kicker.\n\nzur Anmeldung: Herbstcamps');
  assert.equal(e.uid, 'bsvroleber.de?id=15357');
});

test('tec: off-origin next_rest_url is not followed and marks the result partial', async () => {
  const page = JSON.parse(fx('tec/bsvroleber.json'));
  page.next_rest_url = 'http://169.254.169.254/latest/meta-data/';
  const ctx = ctxFor(() => JSON.stringify(page));
  const r = await tec.fetchEvents({ url: 'https://bsvroleber.de/wp-json/tribe/events/v1/events' }, ctx);
  assert.equal(ctx.calls.length, 1);
  assert.match(r.partial.reason, /off-origin/);
  assert.equal(r.events.length, 1);
});

test('tec: the page cap holds at 10 and is partial; a failing later page is partial', async () => {
  const page = JSON.parse(fx('tec/bsvroleber.json'));
  let n = 0;
  const endless = ctxFor(() => JSON.stringify({ ...page, events: [{ ...page.events[0], global_id: `g${n}`, id: n++ }], next_rest_url: `https://bsvroleber.de/wp-json/tribe/events/v1/events?page=${n + 1}` }));
  const r = await tec.fetchEvents({ url: 'https://bsvroleber.de/wp-json/tribe/events/v1/events' }, endless);
  assert.equal(endless.calls.length, tec.MAX_PAGES);
  assert.match(r.partial.reason, /capped/);
  const failing = ctxFor((url) => (url.includes('page=2') ? new Error('HTTP 502') : JSON.stringify({ ...page, next_rest_url: 'https://bsvroleber.de/wp-json/tribe/events/v1/events?page=2' })));
  const f = await tec.fetchEvents({ url: 'https://bsvroleber.de/wp-json/tribe/events/v1/events' }, failing);
  assert.match(f.partial.reason, /page 2/);
  assert.equal(f.events.length, 1);
});

test('tec: all-day ends become exclusive; drafts and hidden items are skipped', async () => {
  const base = JSON.parse(fx('tec/bsvroleber.json')).events[0];
  const items = [
    { ...base, id: 1, global_id: 'a', all_day: true, start_date: '2026-11-21 00:00:00', end_date: '2026-11-22 23:59:59' },
    { ...base, id: 2, global_id: 'b', all_day: true, start_date: '2026-11-21 00:00:00', end_date: '2026-11-22 05:59:59' },
    { ...base, id: 3, global_id: 'c', status: 'draft' },
    { ...base, id: 4, global_id: 'd', hide_from_listings: true },
  ];
  const r = await tec.fetchEvents({ url: 'https://x.example/wp-json/tribe/events/v1/events' }, ctxFor(() => JSON.stringify({ events: items, total: 4 })));
  assert.deepEqual(r.events.map((e) => [e.uid, e.startDate, e.endDate]), [['a', '2026-11-21', '2026-11-23'], ['b', '2026-11-21', '2026-11-22']]);
  assert.match(r.warnings.join(), /non-public status "draft"/);
});

// --- Gancio -------------------------------------------------------------------

test('gancio: window as epoch seconds, uid = id, literal "null" address dropped', async () => {
  const ctx = ctxFor(() => fx('gancio/bonn-jetzt-sport.json'));
  const r = await gancio.fetchEvents({ url: 'https://bonn.jetzt/api/events?tags=Sport' }, ctx);
  const u = new URL(ctx.calls[0].url);
  assert.equal(u.searchParams.get('tags'), 'Sport');
  assert.equal(u.searchParams.get('start'), String(Date.parse('2026-08-31T22:00:00Z') / 1000));
  assert.equal(u.searchParams.get('end'), String(Date.parse('2027-10-31T23:00:00Z') / 1000));
  assert.equal(r.events.length, 9);
  const ride = r.events[0];
  assert.equal(ride.uid, '2989');
  assert.equal(ride.title, 'Rennradeln nach Feierabend');
  assert.equal(at(ride), '2026-09-02T18:00:00+02:00');
  assert.equal(ride.location, 'Wilhelm-Spiritus-Ufer, 53113 Bonn');
  assert.equal(ride.url, 'https://bonn.jetzt/event/rennradeln-nach-feierabend-60');
  assert.deepEqual(ride.tags, ['Bonn', 'Fahrrad', 'Sport']);
});

test('gancio: the registry rules turn the live payload into the right events', async () => {
  const registry = await loadRegistry();
  const platform = registry.platforms.find((p) => p.id === 'bonn-jetzt');
  const ctx = buildContext(registry);
  const r = await gancio.fetchEvents(platform.sources[0], ctxFor(() => fx('gancio/bonn-jetzt-sport.json')));
  const events = r.events.map((raw) => normalizeEvent(raw, { owner: platform, kind: 'platform', source: platform.sources[0], ctx, window: WINDOW })).filter(Boolean);
  assert.equal(events.length, 7, 'the two Critical Mass demonstrations are excluded');
  assert.ok(events.every((e) => e.sports.join() === 'radsport' && e.club === null && e.source === 'bonn-jetzt/sport'));
});

test('gancio: shape errors are actionable', () => {
  assert.throws(() => gancio.parseGancio('BEGIN:VCALENDAR\r\n', 'https://g.example'), /iCalendar instead of JSON/);
  assert.throws(() => gancio.parseGancio('{"events":[]}', 'https://g.example'), /top-level JSON array/);
  const r = gancio.parseGancio(JSON.stringify([{ title: 'no id', start_datetime: 1 }, { id: 5, title: 'no start' }, 7]), 'https://g.example');
  assert.equal(r.events.length, 0);
  assert.equal(r.warnings.length, 3);
});

// --- JSON-LD ------------------------------------------------------------------

test('jsonld: the TEC-emitted Event list of the BTHV page', async () => {
  const r = await jsonld.fetchEvents({ url: 'https://www.bthv.de/blog/' }, ctxFor(() => fx('jsonld/bthv-blog.html')));
  assert.equal(r.events.length, 5);
  assert.equal(r.events[0].title, 'Hockey: 1. Damen – Uhlenhorst Mülheim');
  assert.equal(at(r.events[0]), '2026-10-15T20:00:00+02:00');
  assert.match(r.events[0].uid, /^https:\/\/www\.bthv\.de\/blog\/event\/hockey-1-damen-uhlenhorst-muelheim-2\/@2026-10-15T18:00:00\.000Z$/);
});

test('jsonld: zone-less times are Berlin wall clock; dates, @graph, malformed blocks, cancellations', () => {
  const html = `<html><head>
    <script type="application/ld+json">{ broken </script>
    <script type='application/ld+json'>{"@graph":[{"@type":"WebSite"},{"@type":"SportsEvent","name":"Regatta &amp; Fest","startDate":"2026-10-17T10:00","endDate":"2026-10-17T16:00","location":{"@type":"Place","name":"Bootshaus","address":{"streetAddress":"Rheinaustr. 1","addressLocality":"Bonn"}}}]}</script>
    <script type="application/ld+json">[{"@type":"Event","name":"Turnier","startDate":"2026-11-21","endDate":"2026-11-22","eventStatus":"https://schema.org/EventCancelled"},{"@type":"Event","name":"Ohne Datum"},{"@type":"Event","name":"Februar","startDate":"2026-02-30T10:00:00Z"}]</script>
  </head></html>`;
  const r = jsonld.extractJsonLdEvents(html, 'https://club.example/termine/');
  assert.equal(r.events.length, 2);
  const [regatta, turnier] = r.events;
  assert.equal(regatta.title, 'Regatta & Fest');
  assert.equal(at(regatta), '2026-10-17T10:00:00+02:00');
  assert.equal(regatta.location, 'Bootshaus, Rheinaustr. 1, Bonn');
  assert.deepEqual([turnier.allDay, turnier.startDate, turnier.endDate, turnier.status], [true, '2026-11-21', '2026-11-23', 'cancelled']);
  assert.match(r.warnings.join('\n'), /malformed ld\+json/);
  assert.match(r.warnings.join('\n'), /without time zone read as Europe\/Berlin/);
  assert.match(r.warnings.join('\n'), /"Ohne Datum": missing\/invalid startDate/);
});

test('jsonld: hostile nesting is bounded', () => {
  const deep = '['.repeat(5000) + ']'.repeat(5000);
  const r = jsonld.extractJsonLdEvents(`<script type="application/ld+json">${deep}</script>`, 'https://x.example/');
  assert.equal(r.events.length, 0);
});

// --- RSS ----------------------------------------------------------------------

test('rss: links of the live Gamecocks feed; item pages without JSON-LD yield nothing, with a warning', async () => {
  const items = rss.feedItems(fx('rss/gamecocks.rss'));
  assert.ok(items.length >= 5);
  assert.ok(items.every((i) => /^https:\/\/gamecocks\.de\//.test(i.link)));
  const ctx = ctxFor((url) => (url === 'https://gamecocks.de/feed/' ? fx('rss/gamecocks.rss') : '<html><body>news</body></html>'));
  const r = await rss.fetchEvents({ url: 'https://gamecocks.de/feed/' }, ctx);
  assert.equal(r.events.length, 0);
  assert.match(r.warnings.join(), /none of the \d+ item pages carries schema\.org Event JSON-LD/);
  assert.ok(ctx.calls.slice(1).every((c) => c.opts.robots !== false), 'item pages are crawl requests');
});

test('rss: item pages with JSON-LD become events; off-host links are skipped; the item cap is partial', async () => {
  const items = Array.from({ length: 30 }, (_, i) => `<item><title>Spieltag ${i}</title><link>https://club.example/news/${i}</link><pubDate>Mon, ${String(1 + (i % 28)).padStart(2, '0')} Sep 2026 10:00:00 +0200</pubDate></item>`);
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title><item><title>Fremd</title><link>https://evil.example/x</link></item>${items.join('')}</channel></rss>`;
  const page = (i) => `<html><script type="application/ld+json">{"@type":"SportsEvent","name":"Spieltag ${i}","startDate":"2026-10-${String(1 + (i % 28)).padStart(2, '0')}T15:00:00+02:00","url":"https://club.example/news/${i}"}</script></html>`;
  const ctx = ctxFor((url) => (url === 'https://club.example/feed/' ? feed : page(Number(url.split('/').pop()))));
  const r = await rss.fetchEvents({ url: 'https://club.example/feed/' }, ctx);
  assert.equal(r.events.length, rss.MAX_ITEMS);
  assert.match(r.partial.reason, /newest 25 of 30/);
  assert.match(r.warnings.join(), /leaves the feed's host/);
  assert.ok(!ctx.calls.some((c) => c.url.includes('evil.example')));
});

test('rss: Atom entries and an unknown format', () => {
  const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A</title><link rel="self" href="https://c.example/self"/><link rel="alternate" href="https://c.example/a"/><updated>2026-10-01T10:00:00Z</updated></entry></feed>';
  assert.deepEqual(rss.feedItems(atom).map((i) => i.link), ['https://c.example/a']);
  assert.throws(() => rss.feedItems('<html></html>'), /unrecognised feed format/);
});
