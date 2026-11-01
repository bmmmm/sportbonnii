// normalizeEvent: times, caps, exclude, sports and clubs; text helpers; tz.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeEvent, buildContext, eventId, clip, fold, clubByAlias, homeGame } from '../pipeline/model.mjs';
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

test('exclude: a text anywhere, or =text for a whole title or tag', () => {
  const src = (exclude) => ({ ...clubSource, exclude });
  assert.equal(asClub({ title: 'Halle gesperrt 27.-29.11.' }, src(['Halle gesperrt'])), null);
  assert.equal(asClub({ title: 'Sommerferien', tags: ['Ferien'] }, src(['=Ferien'])), null, 'a whole tag');
  assert.equal(asClub({ title: 'Herbstferien' }, src(['=herbstferien'])), null, 'a whole title, case folded');
  assert.ok(asClub({ title: 'Training in den Sommerferien', tags: ['Training'] }, src(['=Ferien', '=Sommerferien'])), 'not a part of the title');
  assert.ok(asClub({ title: 'Camp', tags: ['Ferienprogramm'] }, src(['=Ferien'])), 'not a part of a tag');
});

test('a league feed only imports pairings that name the club, then applies exclusions', () => {
  const source = { ...clubSource, include: ['Dragons Bonn'], exclude: ['platzhalter'] };
  assert.ok(asClub({ title: 'SSF Dragons Bonn II - Frankfurt Falcons' }, source));
  assert.ok(asClub({ title: 'Spiel', tags: ['SSF Dragons Bonn'] }, source));
  assert.equal(asClub({ title: 'Leipzig - Berlin' }, source), null);
  assert.equal(asClub({ title: 'SSF Dragons Bonn - Platzhalter' }, source), null);
});

test('a title that calls the date off marks it cancelled', () => {
  assert.equal(asClub({ title: 'Training fällt aus' }).status, 'cancelled');
  assert.equal(asClub({ title: 'Jugendtraining entfällt' }).status, 'cancelled');
  assert.equal(asClub({ title: 'Turnier ABGESAGT' }).status, 'cancelled');
  assert.equal(asClub({ title: 'Training' }).status, 'confirmed');
  assert.equal(asClub({ title: 'Abgesagte Termine nachholen' }).status, 'confirmed', 'whole words only');
  assert.equal(asClub({ title: 'Training', status: 'cancelled' }).status, 'cancelled', 'the feed\'s own status still counts');
  assert.equal(asClub({ title: 'Training entfällt nicht' }).status, 'confirmed', 'negated');
  assert.equal(asClub({ title: 'Spiel (ursprünglich abgesagt)' }).status, 'confirmed', 'looking back');
  assert.equal(asClub({ title: 'Termin nicht abgesagt' }).status, 'confirmed');
  assert.equal(asClub({ title: 'Nachholspiel gegen TuS Pützchen abgesagt' }).status, 'cancelled', 'a replay can be called off');
  assert.equal(asClub({ title: 'Training für Nicht-Schwimmer fällt aus' }).status, 'cancelled', 'nicht elsewhere in the title');
  assert.equal(asClub({ title: 'Training (ursprünglich 18 Uhr) fällt aus' }).status, 'cancelled', 'ursprünglich elsewhere');
});

test('timed events: Berlin offset, end before start becomes null', () => {
  const e = asClub({});
  assert.deepEqual(checkEvent(e), []);
  assert.equal(e.start, '2026-10-20T19:00:00+02:00');
  assert.equal(e.end, '2026-10-20T20:30:00+02:00');
  assert.equal(asClub({ endMs: ms('2026-10-20T16:00:00Z') }).end, null);
  assert.equal(e.id, eventId('bonner-thv/termine', 'u1', ''));
  assert.notEqual(asClub({ recurrenceId: 'x' }).id, e.id);
});

test('only opted-in midnight placeholders become date-only events with an unknown time', () => {
  const midnight = { title: 'Heimspiel', startMs: ms('2026-10-24T22:00:00Z'), endMs: ms('2026-10-24T23:30:00Z') };
  const source = { ...clubSource, midnightTimeUnknown: true };
  const e = asClub(midnight, source);
  assert.deepEqual([e.start, e.end, e.allDay, e.timeUnknown], ['2026-10-25', '2026-10-26', true, true], 'the DST day is one calendar day');
  assert.deepEqual(checkEvent(e), []);
  assert.equal(asClub(midnight).allDay, false, 'real midnight events stay timed');
  assert.equal(asClub({ ...midnight, startMs: ms('2026-10-24T22:30:00Z') }, source).timeUnknown, undefined, '00:30 is never inferred to be unknown');
  assert.equal(asClub({ ...midnight, allDay: true, startDate: '2026-10-25' }, source).timeUnknown, undefined, 'a real all-day event stays all-day');
  assert.match(checkEvent({ ...e, timeUnknown: false }).join(), /timeUnknown/);
  assert.match(checkEvent({ ...e, end: '2026-10-27' }).join(), /exactly one day/);
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

test('club sources: a multi-sport club narrows by the title, else sonstiges — never by the description', () => {
  assert.deepEqual(asClub({ title: 'Hockey: Heimspiel Damen' }).sports, ['hockey']);
  assert.deepEqual(asClub({ title: 'Mitgliederversammlung' }).sports, ['sonstiges'], 'a club-wide date is filed under no single sport');
  assert.deepEqual(asClub({ title: 'Spielefest', description: 'auf dem ganzen Gelände: Tennisplätze, Hockeyfeld' }).sports, ['sonstiges'], 'place words in the description are no sport');
  assert.deepEqual(asClub({ title: 'Hockey-Turnier', description: 'mit Tennis-Abteilung' }).sports, ['hockey']);
  assert.deepEqual(asClub({ title: 'Fußball-Freundschaftsspiel' }).sports, ['sonstiges'], 'keywords outside the club do not apply');
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

test('home: the title marker, then a pairing, the club venue, Bonn, another postcode, a title place', () => {
  const rc = { venues: [{ name: 'Rugbyplatz Rheinaue', address: 'Martin-Luther-King-Str. 22, 53175 Bonn' }] };
  const spiel = (title, location = null, c = rc) => homeGame(title, location, c, 'spiel');
  assert.equal(homeGame('Training', 'Sportplatz, Bonn', rc, 'training'), null, 'only games have one');
  assert.equal(homeGame('Heimspiel gegen X', null, rc, 'veranstaltung'), null);
  // 1. the title's own word, which beats a Bonn hall
  assert.equal(spiel('TSV Bonn rrh. 3. Männer vs. HSG GEISLAR-OBERKASSEL (auswärts)', 'SPORTHALLE RINGSTRASSE, BONN'), false);
  assert.equal(spiel("Men's Regionalliga Away"), false);
  assert.equal(spiel('Damen zu Gast bei TuS Pützchen', 'Sportplatz Pützchen, Bonn'), false);
  assert.equal(spiel('Herren: Heim gegen TuS Pützchen'), true);
  assert.equal(spiel('U16W Home Game vs. St. Pauli'), true);
  assert.equal(spiel('Heimspiel gegen RK Heusenstamm'), true);
  assert.equal(spiel('Heimturnier U12', 'Sportplatz Rheinbach, 53359 Rheinbach'), true, 'a home word beats the place');
  // 2. a pairing that names the club: the host comes first, whatever the place says
  const roleber = { name: 'BSV Roleber', aliases: ['Bonner SV Roleber'], venues: [{ name: 'Sportplatz Roleber', address: 'Siebengebirgsstraße 181, 53229 Bonn' }] };
  assert.equal(spiel('⚽️ SV Ennert 1911 - Bonner SV Roleber', 'Steinbruchweg, 53227 Bonn', roleber), false, 'a derby in Bonn is away');
  assert.equal(spiel('⚽️ Bonner SV Roleber - SC Rheinbach II', 'Siebengebirgsstr. 181, 53229 Bonn', roleber), true);
  assert.equal(spiel('TTV Viktoria Bonn vs BSV Roleber', 'Halle, 53119 Bonn', roleber), false);
  assert.equal(spiel('BSV Roleber II vs TSV Bonn rrh.', null, roleber), true, 'a team number after the name');
  assert.equal(spiel('Bonner SV Roleber-Telekom Baskets Bonn 5, 107B611 (SpNr. 3)', null, roleber), true, 'a bare hyphen when nothing is spaced');
  assert.equal(spiel('TuS Zülpich-Bonner SV Roleber, 106B501', 'Blayer Straße, 53909, Zülpich', roleber), false);
  const baskets = { name: 'Telekom Baskets Bonn', aliases: ['Telekom Baskets Bonn'] };
  assert.equal(spiel('EWE Baskets Oldenburg vs. Telekom Baskets Bonn - NETTO BBL Pokal', null, baskets), false, 'the first deciding separator');
  assert.equal(spiel('Telekom Baskets Bonn vs. Bnei Herzliya - Basketball Champions League', null, baskets), true);
  assert.equal(spiel('Bonner SV Roleber - Bonner SV Roleber II', 'Halle, 53229 Bonn', roleber), true, 'both sides name it: the place decides');
  assert.equal(spiel('Blau-Weiss Bonn-TV Beuel', null, { name: 'Blau-Weiss Bonn' }), true, 'a hyphen inside the name splits in vain');
  // 3. one of the club's venues, even without the city
  assert.equal(spiel('Liga: Herren vs. Köln', 'Martin-Luther-King-Straße 22'), true);
  assert.equal(spiel('Liga: Herren vs. Köln', 'Martin-Luther-King-Straße 22', null), null, 'without the club nothing says');
  // 4. anywhere in Bonn
  assert.equal(spiel('BONNER JSG vs. BTB AACHEN', 'SPORTHALLE PENNENFELD, BONN'), true);
  assert.equal(spiel('Liga vs. Köln', 'Halle Ost, 53229'), true, 'a Bonn postcode');
  // 5. another postcode
  assert.equal(spiel('Touch Rugby German Championship', 'Oeserstraße 84, 65934 Frankfurt am Main'), false);
  assert.equal(spiel('Liga', 'Rugby Club Bonn-Rhein-Sieg e.V., Oeserstraße 84, 65934 Frankfurt'), false, 'a postcode beats the word Bonn');
  assert.equal(spiel('Liga', 'Sportpark Bonn-Rhein-Sieg, 53229 Bonn'), true, 'a Bonn postcode with the word');
  // 6. a place in the title
  assert.equal(spiel("Women's Bundesliga 7s Tourney in Darmstadt"), false);
  assert.equal(spiel('Deutsche Mehrkampfmeisterschaften in Heide', 'Heide'), false);
  assert.equal(spiel('E-team in Bonn - Freundschaftsspiele', 'Sportplatz Schulzentrum Tannenbusch'), true);
  assert.equal(spiel('Turnier in Bad Godesberg'), true);
  assert.equal(spiel('Turnier in Bad Honnef'), false);
  assert.equal(spiel('Turnier in Sporthalle Beuel'), true, 'a Bonn place anywhere in the phrase');
  assert.equal(spiel('Turnier in Lessenich'), null, 'an Ortsteil another town shares says nothing alone');
  assert.equal(spiel('Turnier in Gronau'), null);
  assert.equal(spiel('Turnier in Gronau', null, { venues: [{ name: 'Sporthalle Gronau', address: 'Kurt-Schumacher-Str. 1, 53113 Bonn' }] }), true, 'the club venue names it');
  assert.equal(spiel('Turnier in Südstadt', null, { district: 'Südstadt' }), true, 'the club district names it');
  assert.equal(spiel('Turnier in Bonn-Gronau'), true, 'with Bonn it is ours');
  assert.equal(spiel('Spiel in Gronau-Epe', null, { venues: [{ name: 'Sporthalle Gronau', address: 'Kurt-Schumacher-Str. 1, 53113 Bonn' }] }), false, 'a hyphen makes it the other town');
  assert.equal(spiel('Spiel in Lessenich-Meßdorf', null, { district: 'Lessenich' }), true, 'unless a Bonn place follows it');
  assert.equal(spiel('Spiel in Lessenich-Meßdorf'), null, 'which is still a shared name');
  assert.equal(spiel('Spiel in Grafschaft'), false, 'Grafschaft is a place, no abstract noun');
  assert.equal(spiel('Spiel in Partnerschaft mit X'), null);
  assert.equal(spiel('Spieltag in Schwarzrheindorf'), true);
  assert.equal(spiel('Spiel in Köln - Bonn Gamecocks'), false, 'the phrase ends at a dash');
  assert.equal(spiel('Spiel in Köln, Bonn II'), false, 'at a comma');
  assert.equal(spiel('Spiel in Köln (Bonn II)'), false, 'at a bracket');
  assert.equal(spiel('Spiel in Köln vs. Bonn'), false, 'at vs');
  assert.equal(spiel('Spiel in Köln gegen Bonn'), false, 'at gegen');
  assert.equal(spiel('Lauf in Hardthöhe und Ennert'), true, 'the phrase ends at und');
  assert.equal(spiel('Waldlauf in Ennert'), true);
  assert.equal(spiel('Turnier in der Sporthalle Beuel'), true, 'past an article and a venue word');
  assert.equal(spiel('Turnier in Bonn-Beuel'), true);
  assert.equal(spiel('Turnier in Hallenbad Beuel'), true);
  assert.equal(spiel('Spiel in Köln-Südstadt'), false, 'a Bonn name as the second part of another place');
  assert.equal(spiel('Spiel in Düsseldorf-Oberkassel'), false);
  assert.equal(spiel('Turnier in Siegburg/Bonn'), false, 'only the start of the phrase counts');
  assert.equal(spiel('Turnier in Beuel: Finale'), true, 'punctuation after the place');
  assert.equal(spiel('Turnier in Beuel/Vilich'), true);
  assert.equal(spiel('Spiel in Köln: Bonn Gamecocks vs Cologne'), false, 'at a colon');
  assert.equal(spiel('Lauf in der Kölner Südstadt'), null, 'after an article only a Bonn place says');
  assert.equal(spiel('Spiel in der Halle'), null);
  assert.equal(spiel('Turnier in Turnhalle der Gesamtschule Beuel'), true, 'past venue words and articles');
  assert.equal(spiel('Spieltag in Sporthalle am Brüser Berg'), true);
  assert.equal(spiel('Turnier in Rheinaue-Halle'), true, 'a Bonn place inside a venue word');
  assert.equal(spiel('Turnier in Halle 2 Beuel'), null, 'a venue first is no place elsewhere');
  assert.equal(spiel('Turnier in Kooperation mit dem TV Beuel'), null, 'an abstract noun names no place');
  assert.equal(spiel('Spieltag in Zusammenarbeit mit dem SC Bonn'), null);
  assert.equal(spiel('Spiel in Vorbereitung'), null);
  assert.equal(spiel('Spiel in der Halle'), null, 'no capitalised place');
  // nothing says
  assert.equal(spiel('Hockey: 1. Damen – RTHC Leverkusen'), null);
  assert.equal(spiel('E-team Freundschaftsspiele', 'Sportplatz Schulzentrum Tannenbusch'), null);
  // in normalizeEvent: the owner's venues count
  assert.equal(asClub({ title: 'Hockey: 1. Herren – RW Köln', location: 'Christian-Miesen-Str. 1' }).home, true);
  assert.equal(asClub({ title: 'Training', location: 'Christian-Miesen-Str. 1' }).home, null);
});

test('aliases match whole words, longest first, diacritics folded', () => {
  assert.equal(clubByAlias(ctx, 'Spiel der Telekom Baskets heute')?.id, 'telekom-baskets-bonn');
  assert.equal(clubByAlias(ctx, 'Basketsbonner'), null);
  assert.equal(clubByAlias(ctx, 'Treffen', 'Halle der SSF Dragons Bonn')?.id, 'ssf-bonn');
  assert.equal(fold('Fußball Übungsleiter'), 'fussball ubungsleiter');
  assert.equal(clubByAlias(ctx, 'Rugby Bonn-Rhein-Sieg gegen Köln')?.id, 'rc-bonn-rhein-sieg', 'the longer alias outranks the Bonn Rugby UC\'s "Rugby Bonn"');
  for (const [text, id] of [['Gamecocks-Heimspiel gegen Köln', 'bonn-gamecocks'], ['BTHV-Sommerfest', 'bonner-thv'], ['SSF Bonn-Schwimmfest', 'ssf-bonn']]) {
    assert.equal(clubByAlias(ctx, text)?.id, id, `German compounds keep their club: ${text}`);
  }
  assert.equal(clubByAlias(ctx, 'Heimspiel des RC Bonn-Rhein-Sieg')?.id, 'rc-bonn-rhein-sieg');
  assert.equal(clubByAlias(ctx, 'Rugby Bonn lädt ein')?.id, 'bonn-rugby-union-club');
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
