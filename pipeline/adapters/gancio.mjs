// Gancio adapter (https://gancio.org), ported from scalendarii
// (src/ingest/adapters/gancio.ts). /api/events returns a JSON array; recurring
// series arrive pre-expanded (a child carries parentId but its own id). The
// request adds the window as start/end epoch seconds.
//
// Changes from the port: uid = item.id (the stable key; the slug follows the
// title), and a place address that is the literal string "null" — which
// bonn.jetzt really serves — is dropped.
import { htmlToText, safeHttpUrl, singleLineText, createWarningSink } from '../text.mjs';
import { windowMs } from '../model.mjs';

export function requestUrl(sourceUrl, window) {
  const u = new URL(sourceUrl);
  const { startMs, endMs } = windowMs(window);
  u.searchParams.set('start', String(Math.floor(startMs / 1000)));
  u.searchParams.set('end', String(Math.floor(endMs / 1000)));
  return u.toString();
}

const text = (v) => (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim() : null);

function placeText(place) {
  if (!place || typeof place !== 'object') return null;
  const name = text(place.name);
  const address = text(place.address);
  // bonn.jetzt often puts the whole address into the name; do not repeat it.
  const parts = [name, address && (!name || !name.includes(address)) ? address : null].filter(Boolean);
  return parts.length ? singleLineText(parts.join(', ')) : null;
}

function tagsOf(value) {
  if (!Array.isArray(value)) return [];
  return value.map((t) => (typeof t === 'string' ? t : typeof t?.tag === 'string' ? t.tag : '')).map((t) => t.trim()).filter(Boolean);
}

/** Parse a Gancio /api/events body. `origin` builds the event links. */
export function parseGancio(body, origin) {
  const warnings = createWarningSink();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    if (/^\s*BEGIN:VCALENDAR/.test(body)) throw new Error('received iCalendar instead of JSON — point the source at …/api/events or use type ical');
    throw new Error(`invalid Gancio feed: not valid JSON (${e.message})`);
  }
  if (!Array.isArray(parsed)) throw new Error('invalid Gancio feed: expected a top-level JSON array');
  const events = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') { warnings.push('skipped a non-object item'); continue; }
    const id = typeof item.id === 'number' || (typeof item.id === 'string' && item.id) ? String(item.id) : null;
    if (!id) { warnings.push(`skipped item ${item.slug ?? '?'}: no id`); continue; }
    const startS = item.start_datetime;
    if (typeof startS !== 'number' || !Number.isFinite(startS)) { warnings.push(`skipped item ${id}: missing start_datetime`); continue; }
    const endS = typeof item.end_datetime === 'number' && Number.isFinite(item.end_datetime) ? item.end_datetime : null;
    const slug = typeof item.slug === 'string' && item.slug ? item.slug : id;
    events.push({
      uid: id,
      recurrenceId: '',
      title: singleLineText(typeof item.title === 'string' ? item.title : ''),
      description: htmlToText(typeof item.description === 'string' ? item.description : ''),
      allDay: false,
      startMs: startS * 1000,
      endMs: endS === null ? null : endS * 1000,
      location: placeText(item.place),
      url: safeHttpUrl(`/event/${encodeURIComponent(slug)}`, origin),
      status: 'confirmed',
      tags: tagsOf(item.tags),
    });
  }
  return { events, warnings: warnings.list() };
}

/** Adapter entry point. */
export async function fetchEvents(source, ctx) {
  const res = await ctx.get(requestUrl(source.url, ctx.window), { accept: 'application/json' });
  return parseGancio(res.body, new URL(source.url).origin);
}
