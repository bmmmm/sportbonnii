// Dates for the page. Event times arrive as Europe/Berlin wall clock with
// offset ('2026-10-20T19:00:00+02:00') or as plain dates, so everything here
// works on string parts and UTC calendar arithmetic: the visitor's own time
// zone never enters. Only "today" and the check timestamp need Intl, with an
// explicit timeZone.

export const TZ = 'Europe/Berlin';
export const WEEKDAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
export const WEEKDAYS_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
export const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
export const MONTHS_SHORT = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.'];

const pad = (n) => String(n).padStart(2, '0');
const parts = (date) => date.split('-').map(Number);
const iso = (d) => `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

function berlinParts(now) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const get = (type, list) => list.find((p) => p.type === type).value;
  const list = f.formatToParts(now);
  return { date: `${get('year', list)}-${get('month', list)}-${get('day', list)}`, time: `${get('hour', list)}:${get('minute', list)}` };
}

/** 'YYYY-MM-DD' of today in Bonn. */
export function berlinToday(now = new Date()) {
  return berlinParts(now).date;
}

/** { date, time } of an instant in Bonn. */
export function berlinWall(instant) {
  return berlinParts(instant instanceof Date ? instant : new Date(instant));
}

export function addDays(date, n) {
  const [y, m, d] = parts(date);
  return iso(new Date(Date.UTC(y, m - 1, d + n)));
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayIndex(date) {
  const [y, m, d] = parts(date);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export const monthOf = (date) => date.slice(0, 7);

/** 'YYYY-MM' plus n months. */
export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

export function lastDayOfMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return iso(new Date(Date.UTC(y, m, 0)));
}

/** Whole days from a to b (b − a). */
export function daysBetween(a, b) {
  const [ya, ma, da] = parts(a);
  const [yb, mb, db] = parts(b);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86_400_000);
}

/**
 * [from, to] (inclusive dates; to null = open) of a quick pick, always
 * starting today: heute, woche (to Sunday), monat (to the month's end), alle.
 */
export function rangeFor(zeit, today) {
  if (zeit === 'heute') return [today, today];
  if (zeit === 'woche') return [today, addDays(today, 6 - weekdayIndex(today))];
  if (zeit === 'monat') return [today, lastDayOfMonth(monthOf(today))];
  return [today, null];
}

/** First and last Berlin day an event touches. */
export function eventDays(e) {
  const first = e.start.slice(0, 10);
  if (e.allDay) return [first, addDays(e.end, -1)];
  if (!e.end) return [first, first];
  let last = e.end.slice(0, 10);
  // An end at midnight closes the previous day.
  if (last > first && e.end.slice(11, 16) === '00:00') last = addDays(last, -1);
  return [first, last < first ? first : last];
}

/** The event touches a day of [from, to] (to null = open-ended). */
export function overlaps(e, from, to) {
  const [first, last] = eventDays(e);
  return last >= from && (to === null || first <= to);
}

/** 'Di., 20. Okt.' — with the year when it is not `refYear`. */
export function formatShortDate(date, refYear) {
  const [y, m, d] = parts(date);
  return `${WEEKDAYS_SHORT[weekdayIndex(date)]}., ${d}. ${MONTHS_SHORT[m - 1]}${refYear && y !== refYear ? ` ${y}` : ''}`;
}

/** 'Dienstag, 20. Oktober 2026' */
export function formatLongDate(date) {
  const [y, m, d] = parts(date);
  return `${WEEKDAYS[weekdayIndex(date)]}, ${d}. ${MONTHS[m - 1]} ${y}`;
}

/** 'Oktober 2026' */
export function formatMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

const hm = (value) => value.slice(11, 16);

/** '19:00', '19:00–20:30', 'ganztägig', or for multi-day spans the start time only. */
export function formatTime(e) {
  if (e.allDay) return 'ganztägig';
  const start = hm(e.start);
  if (!e.end) return start;
  const [first, last] = eventDays(e);
  return first === last ? `${start}–${hm(e.end)}` : start;
}

/** 'bis Do., 29. Okt.' for events spanning several days, else ''. */
export function formatSpan(e, refYear) {
  const [first, last] = eventDays(e);
  return first === last ? '' : `bis ${formatShortDate(last, refYear)}${e.allDay || !e.end ? '' : `, ${hm(e.end)}`}`;
}

/** Relative wording for the check timestamp: 'heute, 12:23', 'gestern, 18:05', '12. Okt., 06:23'. */
export function formatCheckedAt(isoUtc, now = new Date()) {
  const at = berlinWall(isoUtc);
  const today = berlinToday(now);
  const [, m, d] = parts(at.date);
  if (at.date === today) return `heute, ${at.time} Uhr`;
  if (at.date === addDays(today, -1)) return `gestern, ${at.time} Uhr`;
  return `${d}. ${MONTHS_SHORT[m - 1]}, ${at.time} Uhr`;
}
