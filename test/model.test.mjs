// normalizeEvent: times, caps, exclude, sports and clubs; text helpers; tz.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeEvent, buildContext, eventId, clip, fold, clubByAlias } from '../pipeline/model.mjs';
import { htmlToText, singleLineText, decodeEntities, safeHttpUrl } from '../pipeline/text.mjs';
import { toBerlinIso, zonedToUtc, berlinDate, addMonths } from '../pipeline/tz.mjs';
import { windowFor } from '../pipeline/run.mjs';
import { loadRegistry } from '../pipeline/registry.mjs';
import { checkEvent } from '../pipeline/contract.mjs';

const registry = await loadRegistry();
const ctx = buildContext(registry);
const WINDOW = { from: '2026-09-01', to: '2027-11-01' };
const club = registry.clubs.find((c) => c.id === 'bonner-thv');
const platform = registry.platforms[0];
const clubSource = { id: 'termine', type: 'ical', url: 'https://x.example/t.ics' };
const ms = (iso) => Date.parse(iso);
const raw = (o) => ({ uid: 'u1', recurrenceId: '', title: 'Training', description: '', allDay: false, startMs: ms('2026-10-20T17:00:00Z'), endMs: ms('2026-10-20T18:30:00Z'), location: null, url: null, status: 'confirmed', tags: [], ...o });
const asClub = (o, source = clubSource) => normalizeEvent(raw(o), { owner: club, kind: 'club', source, ctx, window: WINDOW });
const asPlatform = (o) => normalizeEvent(raw(o), { owner: platform, kind: 'platform', source: platform.sources[0], ctx, window: WINDOW });

test('timed events: Berlin offset, end before start becomes null', () => {
  const e = asClub({});
  assert.deepEqual(checkEvent(e), []);
  assert.equal(e.start, '2026-10-20T19:00:00+02:00');
  assert.equal(e.end, '2026-10-20T20:30:00+02:00');
  assert.equal(asClub({ endMs: ms('2026-10-20T16:00:00Z') }).end, null);
  assert.equal(e.id, eventId('bonner-thv/termine', 'u1', ''));
  assert.notEqual(asClub({ recurrenceId: 'x' }).id, e.id);
});

test('instants outside the Date range are dropped, not thrown', () => {
  assert.equal(asClub({ startMs: 1e19 }), null);
  assert.equal(asClub({ startMs: ms('2026-10-20T17:00:00Z'), endMs: 1e19 }).end, null);
});

test('all-day: exclusive end, missing or broken end means one day', () => {
  const two = asClub({ allDay: true, startDate: '2026-11-21', endDate: '2026-11-23' });
  assert.deepEqual([two.start, two.end, two.allDay], ['2026-11-21', '2026-11-23', true]);
  assert.equal(asClub({ allDay: true, startDate: '2026-11-21', endDate: null }).end, '2026-11-22');
  assert.equal(asClub({ allDay: true, startDate: '2026-11-21', endDate: '2026-11-20' }).end, '2026-11-22');
});

test('window: events ending before it or starting after it are dropped', () => {
  assert.equal(asClub({ startMs: ms('2026-08-30T10:00:00Z'), endMs: ms('2026-08-30T12:00:00Z') }), null);
  assert.notEqual(asClub({ startMs: ms('2026-08-31T20:00:00Z'), endMs: ms('2026-09-01T08:00:00Z') }), null, 'overlaps the start');
  assert.equal(asClub({ startMs: ms('2027-11-01T10:00:00Z'), endMs: null }), null);
});

test('caps: title 200, description 400, both with an ellipsis', () => {
  const e = asClub({ title: 'Wort '.repeat(80), description: 'lang '.repeat(200) });
  assert.ok(e.title.length <= 200 && e.title.endsWith('…'));
  assert.ok(e.description.length <= 400 && e.description.endsWith('…'));
  assert.equal(asClub({ description: '   ' }).description, null);
  assert.equal(asClub({ description: 'Absatz eins  \n\n\n\nAbsatz zwei' }).description, 'Absatz eins\n\nAbsatz zwei', 'paragraphs stay, runs collapse');
  assert.equal(asClub({ title: '   ' }), null);
  assert.equal(clip('kurz', 10), 'kurz');
});

test('exclude: case-insensitive against title and tags', () => {
  assert.equal(asPlatform({ title: 'Fahrrad-DEMONSTRATION am Rhein' }), null);
  assert.equal(asPlatform({ title: 'Radtour', tags: ['Demonstration'] }), null);
  assert.notEqual(asPlatform({ title: 'Radtour' }), null);
});

test('club sources: a multi-sport club narrows by keyword, else keeps all its sports', () => {
  assert.deepEqual(asClub({ title: 'Hockey: Heimspiel Damen' }).sports, ['hockey']);
  assert.deepEqual(asClub({ title: 'Mitgliederversammlung' }).sports, ['hockey', 'rugby', 'tennis'].sort((a, b) => ctx.order.get(a) - ctx.order.get(b)));
  assert.deepEqual(asClub({ title: 'Fußball-Freundschaftsspiel' }).sports, ['hockey', 'rugby', 'tennis'].sort((a, b) => ctx.order.get(a) - ctx.order.get(b)), 'keywords outside the club do not apply');
  assert.deepEqual(asClub({ title: 'Saisonstart' }, { ...clubSource, sports: ['tennis'] }).sports, ['tennis']);
  assert.equal(asClub({}).club, 'bonner-thv');
});

test('platform sources: tagMap, then keywords, then the aliased club, else sonstiges', () => {
  assert.deepEqual(asPlatform({ title: 'Ausfahrt', tags: ['Fahrrad'] }).sports, ['radsport']);
  assert.deepEqual(asPlatform({ title: 'Schwimmfest im Frankenbad' }).sports, ['schwimmen']);
  assert.deepEqual(asPlatform({ title: 'Tischtennis-Turnier' }).sports, ['tischtennis'], '"tennis" needs a word start');
  assert.deepEqual(asPlatform({ title: 'Ablauf der Saison' }).sports, ['sonstiges'], '"lauf" needs a word start');
  const aliased = asPlatform({ title: 'Tag der offenen Tür bei den Gamecocks' });
  assert.equal(aliased.club, 'bonn-gamecocks');
  assert.deepEqual(aliased.sports, ['american-football']);
  const neutral = asPlatform({ title: 'Sportabzeichen-Tag' });
  assert.equal(neutral.club, null);
  assert.deepEqual(neutral.sports, ['sonstiges']);
});

test('kind: from title and tags, else the source kind, else an event', () => {
  assert.equal(asClub({ title: 'Training' }).kind, 'training');
  assert.equal(asClub({ title: 'Hockey: Heimspiel Damen' }).kind, 'spiel');
  assert.equal(asClub({ title: 'Saisonstart', tags: ['Turnier'] }).kind, 'spiel');
  assert.equal(asClub({ title: 'Saisonstart' }).kind, 'veranstaltung');
  assert.equal(asClub({ title: 'Saisonstart' }, { ...clubSource, kind: 'training' }).kind, 'training');
  assert.equal(asPlatform({ title: 'Lauftreff am Rhein' }).kind, 'training');
});

test('aliases match whole words, longest first, diacritics folded', () => {
  assert.equal(clubByAlias(ctx, 'Spiel der Telekom Baskets heute')?.id, 'telekom-baskets-bonn');
  assert.equal(clubByAlias(ctx, 'Basketsbonner'), null);
  assert.equal(clubByAlias(ctx, 'Treffen', 'Halle der SSF Dragons Bonn')?.id, 'ssf-bonn');
  assert.equal(fold('Fußball Übungsleiter'), 'fussball ubungsleiter');
  assert.equal(clubByAlias(ctx, 'Rugby Bonn-Rhein-Sieg gegen Köln')?.id, 'rc-bonn-rhein-sieg', 'the longer alias outranks Bonner THV\'s "Rugby Bonn"');
  for (const [text, id] of [['Gamecocks-Heimspiel gegen Köln', 'bonn-gamecocks'], ['BTHV-Sommerfest', 'bonner-thv'], ['SSF Bonn-Schwimmfest', 'ssf-bonn']]) {
    assert.equal(clubByAlias(ctx, text)?.id, id, `German compounds keep their club: ${text}`);
  }
  assert.equal(clubByAlias(ctx, 'Heimspiel des RC Bonn-Rhein-Sieg')?.id, 'rc-bonn-rhein-sieg');
  assert.equal(clubByAlias(ctx, 'Rugby Bonn lädt ein')?.id, 'bonner-thv');
  assert.equal(clubByAlias(ctx, 'Lauftreff', 'Sportplatz Bonn-Roleber'), null, 'a place name is not a club');
});

test('a description that is only a link becomes the event link', () => {
  const e = asClub({ description: 'https://rcbrs.de/en/teams/youth/' });
  assert.equal(e.url, 'https://rcbrs.de/en/teams/youth/');
  assert.equal(e.description, null);
  const own = asClub({ description: 'https://a.example/x', url: 'https://b.example/y' });
  assert.equal(own.url, 'https://b.example/y', 'an explicit url wins');
});

test('urls: only http(s) survive', () => {
  assert.equal(asClub({ url: 'javascript:alert(1)' }).url, null);
  assert.equal(asClub({ url: 'https://club.example/e/1' }).url, 'https://club.example/e/1');
  assert.equal(safeHttpUrl('bolle-bonn.de'), 'https://bolle-bonn.de/');
  assert.equal(safeHttpUrl('/event/x', 'https://club.example/feed'), 'https://club.example/event/x');
});

test('text helpers: entities, tags, whitespace', () => {
  assert.equal(singleLineText('Herbst&#8211;Camp <b>2026</b>\n'), 'Herbst–Camp 2026');
  assert.equal(singleLineText('&lt;img src=x onerror=alert(1)&gt;'), '<img src=x onerror=alert(1)>');
  assert.equal(htmlToText('<p>Eins</p><p>Zwei<br>Drei</p><ul><li>a</li></ul>'), 'Eins\nZwei\nDrei\n- a');
  assert.equal(decodeEntities('&auml;&szlig;&unknown;'), 'äß&unknown;');
});

test('tz: Berlin offsets across DST, gaps, window boundaries', () => {
  assert.equal(toBerlinIso(ms('2026-10-25T00:30:00Z')), '2026-10-25T02:30:00+02:00');
  assert.equal(toBerlinIso(ms('2026-10-25T01:30:00Z')), '2026-10-25T02:30:00+01:00');
  assert.equal(toBerlinIso(zonedToUtc({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 })), '2026-03-29T03:30:00+02:00', 'DST gap → one hour later');
  assert.equal(toBerlinIso(zonedToUtc({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 })), '2026-10-25T02:30:00+02:00', 'DST overlap → the first occurrence (RFC 5545)');
  assert.equal(toBerlinIso(zonedToUtc({ year: 2026, month: 10, day: 25, hour: 3, minute: 0 })), '2026-10-25T03:00:00+01:00');
  assert.equal(toBerlinIso(zonedToUtc({ year: 2026, month: 7, day: 1, hour: 12 }, 'America/New_York')), '2026-07-01T18:00:00+02:00');
  assert.equal(berlinDate(ms('2026-10-13T22:30:00Z')), '2026-10-14');
  assert.deepEqual(windowFor('2026-10-14'), { from: '2026-09-01', to: '2027-11-01' });
  assert.deepEqual(windowFor('2027-01-31'), { from: '2026-12-01', to: '2028-02-01' });
  assert.equal(addMonths('2026-01-31', 1), '2026-02-01');
});

test('tz: results do not depend on the machine time zone', () => {
  const script = fileURLToPath(new URL('./helpers/tz-probe.mjs', import.meta.url));
  const out = (tz) => execFileSync(process.execPath, [script], { env: { ...process.env, TZ: tz } }).toString();
  const berlin = out('Europe/Berlin');
  assert.equal(out('America/New_York'), berlin);
  assert.equal(out('Asia/Kolkata'), berlin);
  assert.match(berlin, /2026-10-27T19:00:00\+01:00/);
});
