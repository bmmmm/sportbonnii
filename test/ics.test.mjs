// ICS writer: escaping, folding, a byte-exact pinned feed, and a round trip
// through the iCal adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { escapeText, foldLine, formatUtcDateTime, serializeFeed } from '../site/ics.js';
import { parseIcal } from '../pipeline/adapters/ical.mjs';
import { windowMs } from '../pipeline/model.mjs';
import { toBerlinIso } from '../pipeline/tz.mjs';

const EVENTS = readFileSync(new URL('./fixtures/site-data/events.json', import.meta.url), 'utf8');
const doc = JSON.parse(EVENTS);
const sports = JSON.parse(readFileSync(new URL('./fixtures/site-data/sports.json', import.meta.url), 'utf8')).sports;
const clubs = JSON.parse(readFileSync(new URL('./fixtures/site-data/clubs.json', import.meta.url), 'utf8')).clubs;
export const FEED_OPTS = {
  name: 'Sport in Bonn – alle Termine',
  windowFrom: doc.window.from,
  labels: Object.fromEntries(sports.map((s) => [s.id, s.label])),
  clubNames: Object.fromEntries(clubs.map((c) => [c.id, c.name])),
};

test('escapeText: backslash first, then ; , and newlines; control characters dropped', () => {
  assert.equal(escapeText('a\\b;c,d\ne\r\nf\x07'), 'a\\\\b\\;c\\,d\\ne\\nf');
});

test('foldLine: 75 octets, never inside a UTF-8 sequence', () => {
  const line = 'SUMMARY:' + 'ä'.repeat(60);
  const folded = foldLine(line);
  for (const part of folded.split('\r\n')) assert.ok(new TextEncoder().encode(part).length <= 75);
  assert.equal(folded.split('\r\n').map((p, i) => (i ? p.slice(1) : p)).join(''), line);
  assert.equal(foldLine('short'), 'short');
});

test('formatUtcDateTime', () => {
  assert.equal(formatUtcDateTime(new Date('2026-10-26T08:00:00+01:00')), '20261026T070000Z');
});

test('the full feed of the snapshot is byte-identical to the pinned file', () => {
  const got = serializeFeed(doc.events, FEED_OPTS);
  const want = readFileSync(new URL('./fixtures/ics/alle.ics', import.meta.url), 'utf8');
  assert.equal(got, want);
  assert.ok(got.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75));
  assert.equal((got.match(/BEGIN:VEVENT/g) || []).length, doc.events.length);
  assert.doesNotMatch(got.replace(/\r\n/g, ''), /\n/, 'only CRLF line ends');
});

test('round trip through the iCal adapter keeps times, dates, text and status', () => {
  const text = serializeFeed(doc.events, FEED_OPTS);
  const parsed = parseIcal(text, windowMs(doc.window)).events;
  assert.equal(parsed.length, doc.events.length);
  const byUid = new Map(parsed.map((p) => [p.uid, p]));
  for (const e of doc.events) {
    const p = byUid.get(`${e.id}@sportbonnii`);
    assert.ok(p, e.id);
    assert.equal(p.title, e.title);
    assert.equal(p.status, e.status);
    if (e.allDay) assert.deepEqual([p.startDate, p.endDate], [e.start, e.end]);
    else {
      assert.equal(toBerlinIso(p.startMs), e.start);
      if (e.end) assert.equal(toBerlinIso(p.endMs), e.end);
    }
  }
});
