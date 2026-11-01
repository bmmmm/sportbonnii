// amphicms calendar adapter (ssfbonn.de and other sites on that CMS). The
// public calendar page loads its dates from
//   /ajax-cms?moduleId=…&request=loadSpecialCalendarSource&loadBy=calendar&calendarId=…
// with the visible range as start/end (Berlin wall clock, no offset); the
// answer is `{ dataSourceId, events: [{ id, title, start, end, listData }] }`
// in FullCalendar form: "YYYY-MM-DDTHH:MM:SS" wall clock, or "YYYY-MM-DD"
// with an exclusive end for an all-day date.
//
// The event `id` is a fresh uniqid() on every request, so the uid is the
// start plus the title: a date keeps its id as long as neither moves.
//
// A timed range over several days whose end hour is after its start hour
// ("26.10. 09:00 – 30.10. 16:00", the description says "Montag bis Freitag,
// 9-16 Uhr") stands for daily hours, not one continuous stretch: it becomes an
// all-day range. An overnight range (19:00 – 01:00) or one of whole days on
// the clock (12:00 – 12:00) stays timed.
//
// The API has no per-event link; `params.page`, the calendar page on the same
// site, is every event's link.
import { htmlToText, safeHttpUrl, singleLineText, createWarningSink } from '../text.mjs';
import { zonedToUtc, addDays, BERLIN } from '../tz.mjs';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** The source URL with the fetch window as start/end (Berlin dates, `to` exclusive). */
export function requestUrl(sourceUrl, window) {
  const u = new URL(sourceUrl);
  u.searchParams.set('start', `${window.from}T00:00:00`);
  u.searchParams.set('end', `${window.to}T00:00:00`);
  u.searchParams.set('timeZone', BERLIN);
  return u.toString();
}

/** A real calendar date: "2026-13-45" is none (Date.UTC would roll it over). */
const realDate = (y, mo, d) => new Date(Date.UTC(y, mo - 1, d)).toISOString().slice(0, 10) === `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const isDate = (s) => { const m = DATE.exec(s); return !!m && realDate(+m[1], +m[2], +m[3]); };

function wallMs(s) {
  const m = LOCAL.exec(s);
  if (!m || !realDate(+m[1], +m[2], +m[3]) || +m[4] > 23 || +m[5] > 59) return null;
  return zonedToUtc({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: +(m[6] ?? 0) });
}

/** The description without its repeated headline. */
function descriptionOf(item) {
  const html = typeof item.listData?.description === 'string' ? item.listData.description : '';
  return htmlToText(html.replace(/<div class="headline-wrapper">[\s\S]*?<\/div>/i, '')) || null;
}

// The CMS has no place field; the description names it on a line of its own,
// as "Ort: …" / "Austragungsort: …" or ending in a postcode and town ("Hardtberghalle, Gaußstr. 1 53125 Bonn").
const PLACE_LINE = /^(?:austragungs)?ort:\s*(.+)$|^(.{3,120}\b\d{5}\s+\p{L}[\p{L} .-]*)$/iu;

/** The place a description names, or null. */
export function placeOf(description) {
  for (const line of (description ?? '').split('\n')) {
    const m = PLACE_LINE.exec(line.trim());
    if (m) return (m[1] ?? m[2]).trim();
  }
  return null;
}

/** Parse an amphicms loadSpecialCalendarSource answer. */
export function parseAmphiCalendar(body, pageUrl = null) {
  const warnings = createWarningSink();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(`invalid amphicms calendar: not valid JSON (${e.message})`);
  }
  if (!parsed || !Array.isArray(parsed.events)) throw new Error('invalid amphicms calendar: expected an object with an events array');
  const events = [];
  for (const item of parsed.events) {
    const title = singleLineText(typeof item?.title === 'string' ? item.title : '');
    const start = typeof item?.start === 'string' ? item.start : '';
    const end = typeof item?.end === 'string' ? item.end : '';
    if (!title || !start) { warnings.push('skipped an item without title or start'); continue; }
    const description = descriptionOf(item);
    const common = { uid: `${start}|${title}`, recurrenceId: '', title, description, location: placeOf(description), url: pageUrl, status: 'confirmed', tags: [] };
    if (isDate(start)) {
      events.push({ ...common, allDay: true, startDate: start, endDate: isDate(end) && end > start ? end : null });
      continue;
    }
    const startMs = wallMs(start);
    if (startMs === null) { warnings.push(`skipped "${title}": unreadable start ${start}`); continue; }
    const endMs = wallMs(end);
    if (endMs !== null && end.slice(0, 10) > start.slice(0, 10) && end.slice(11, 16) > start.slice(11, 16)) {
      events.push({ ...common, allDay: true, startDate: start.slice(0, 10), endDate: addDays(end.slice(0, 10), 1) });
      continue;
    }
    events.push({ ...common, allDay: false, startMs, endMs: endMs !== null && endMs > startMs ? endMs : null });
  }
  return { events, warnings: warnings.list() };
}

/** Adapter entry point: the endpoint the club's own calendar page loads. */
export async function fetchEvents(source, ctx) {
  const res = await ctx.get(requestUrl(source.url, ctx.window), { accept: 'application/json', robots: false });
  const page = safeHttpUrl(source.params?.page ?? '');
  const sameSite = page && new URL(page).hostname.replace(/^www\./, '') === new URL(source.url).hostname.replace(/^www\./, '');
  const r = parseAmphiCalendar(res.body, sameSite ? page : null);
  if (!sameSite) r.warnings.push(source.params?.page ? `params.page ${source.params.page} is not a page of the calendar's site — events carry no link` : 'no params.page — events carry no link');
  return r;
}

/** One request per fetch: a 304 on it means the whole source is unchanged (run.mjs may ask conditionally). */
export const CONDITIONAL = true;
