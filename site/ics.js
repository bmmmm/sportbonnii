// RFC 5545 writer shared by the pipeline (the generated data/ics/*.ics feeds)
// and the page (download of the current filter). escapeText, foldLine and
// formatUtcDateTime are ported from calqrii's ics.js. Pure functions over
// events.json entries; byte-stable: DTSTAMP is the data window's start, not
// the clock, so unchanged events give an unchanged feed.

export const PRODID = '-//sportbonnii//Termine Bonner Sportvereine//DE';
const MAX_LINE_OCTETS = 75;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * TEXT escaping (§3.3.11). Backslashes first, or the backslashes inserted
 * for `;` `,` and newlines would be doubled again. Control characters have
 * no escape and are dropped; TAB stays.
 */
export function escapeText(raw) {
  return String(raw)
    .replace(/\r\n|\r/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Fold one logical line at 75 octets (§3.1) without cutting a UTF-8
 * sequence. A continuation line starts with one space that counts toward
 * its own budget, hence 74 payload octets from the second chunk on.
 */
export function foldLine(line) {
  const bytes = encoder.encode(line);
  if (bytes.length <= MAX_LINE_OCTETS) return line;
  const chunks = [];
  let start = 0;
  let limit = MAX_LINE_OCTETS;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    while (end > start && (bytes[end] & 0xc0) === 0x80) end--;
    chunks.push(decoder.decode(bytes.subarray(start, end)));
    start = end;
    limit = MAX_LINE_OCTETS - 1;
  }
  return chunks.join('\r\n ');
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Date → 'YYYYMMDDTHHMMSSZ' */
export function formatUtcDateTime(d) {
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
    + `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** An events.json time value as an ICS property value: VALUE=DATE for dates, UTC otherwise. */
function timeProp(name, value) {
  if (value.length === 10) return `${name};VALUE=DATE:${value.replace(/-/g, '')}`;
  return `${name}:${formatUtcDateTime(new Date(value))}`;
}

function urlValue(url) {
  const clean = String(url).replace(/[\x00-\x20\x7F]/g, '');
  return /^https?:\/\//.test(clean) ? clean : '';
}

/**
 * The lines of one VEVENT. `labels` maps sport ids to their labels (for
 * CATEGORIES), `clubNames` club ids to names (for the description footer).
 */
export function veventLines(ev, { dtstamp, labels = {}, clubNames = {} }) {
  const lines = ['BEGIN:VEVENT', `UID:${ev.id}@sportbonnii`, `DTSTAMP:${dtstamp}`, timeProp('DTSTART', ev.start)];
  if (ev.end) lines.push(timeProp('DTEND', ev.end));
  lines.push(`SUMMARY:${escapeText(ev.title)}`);
  const club = ev.club ? clubNames[ev.club] ?? ev.club : null;
  const description = [ev.description, club ? `Verein: ${club}` : null].filter(Boolean).join('\n\n');
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
  if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);
  const url = ev.url ? urlValue(ev.url) : '';
  if (url) lines.push(`URL:${url}`);
  const cats = ev.sports.map((s) => labels[s] ?? s);
  if (cats.length) lines.push(`CATEGORIES:${cats.map(escapeText).join(',')}`);
  lines.push(`STATUS:${ev.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`);
  lines.push('END:VEVENT');
  return lines;
}

/**
 * A whole feed. opts: { name (X-WR-CALNAME), windowFrom ('YYYY-MM-DD', the
 * DTSTAMP of every event), labels, clubNames }.
 */
export function serializeFeed(events, { name, windowFrom, labels, clubNames }) {
  const dtstamp = `${windowFrom.replace(/-/g, '')}T000000Z`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    'X-WR-TIMEZONE:Europe/Berlin',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
    ...events.flatMap((ev) => veventLines(ev, { dtstamp, labels, clubNames })),
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
