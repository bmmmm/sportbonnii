// Europe/Berlin wall clock ⇄ UTC instants, via Intl only (no tz database of
// our own). Ported from calqrii ics.js (zonedToUtc, tzOffsetMs) with seconds
// and the Berlin ISO formatter the pipeline writes into events.json.

export const BERLIN = 'Europe/Berlin';

const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    // hourCycle h23, not hour12:false — the latter can yield "24" at midnight.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

/** True when Intl knows the IANA zone name. */
export function isKnownZone(tz) {
  try {
    dtf(tz);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of the instant `utcMs` in `tz`. */
export function wallParts(utcMs, tz = BERLIN) {
  const parts = dtf(tz).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** Offset of `tz` at the instant `utcMs`, in ms (east positive). */
export function tzOffsetMs(tz, utcMs) {
  const p = wallParts(utcMs, tz);
  const local = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Intl drops sub-second precision; compare against the whole-second instant.
  return local - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Wall clock in `tz` → UTC ms. Two passes: the offset at the wall time read
 * as UTC, then the offset at the corrected instant. In a DST gap the result
 * is the instant one hour after the missing time; in an overlap it is the
 * later (standard-time) reading.
 */
export function zonedToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, tz = BERLIN) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  let t = wall - tzOffsetMs(tz, wall);
  t = wall - tzOffsetMs(tz, t);
  return t;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 'YYYY-MM-DDTHH:MM:SS+HH:MM' — the Berlin wall clock of `utcMs` with its offset. */
export function toBerlinIso(utcMs) {
  const p = wallParts(utcMs, BERLIN);
  const off = Math.round(tzOffsetMs(BERLIN, utcMs) / 60000);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** 'YYYY-MM-DD' of the Berlin calendar day containing `utcMs`. */
export function berlinDate(utcMs) {
  const p = wallParts(utcMs, BERLIN);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** UTC ms of Berlin midnight starting the day 'YYYY-MM-DD'. */
export function berlinMidnight(date) {
  const [year, month, day] = date.split('-').map(Number);
  return zonedToUtc({ year, month, day }, BERLIN);
}

/** 'YYYY-MM-DD' plus `n` calendar days. */
export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 'YYYY-MM-DD' of the first day of the month `n` months after the month of `date`. */
export function addMonths(date, n) {
  const [y, m] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-01`;
}

/** UTC ms of an events.json `start`/`end` value: a date (Berlin midnight) or an ISO datetime with offset. */
export function instantOf(value) {
  return value.length === 10 ? berlinMidnight(value) : Date.parse(value);
}
