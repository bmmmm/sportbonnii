// WordPress "The Events Calendar" REST adapter, ported from scalendarii
// (src/ingest/adapters/wordpress-tec.ts). /wp-json/tribe/events/v1/events is
// a paginated JSON list in which every occurrence of a recurring event is its
// own item, so there is no RRULE to expand.
//
// The request asks for the run's window (start_date/end_date, 50 per page)
// and follows next_rest_url only on the source's own origin, at most 10 pages.
import { htmlToText, safeHttpUrl, singleLineText, createWarningSink } from '../text.mjs';
import { BERLIN, isKnownZone, zonedToUtc } from '../tz.mjs';

export const MAX_PAGES = 10;
const PER_PAGE = 50;

/** The first page's URL: the configured endpoint plus the window parameters. */
export function firstPageUrl(sourceUrl, window) {
  const u = new URL(sourceUrl);
  u.searchParams.set('start_date', `${window.from} 00:00:00`);
  u.searchParams.set('end_date', `${window.to} 00:00:00`);
  u.searchParams.set('per_page', String(PER_PAGE));
  return u.toString();
}

function parsePage(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(`invalid JSON from The Events Calendar endpoint: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.events)) {
    throw new Error("malformed The Events Calendar response: expected an object with an 'events' array");
  }
  return parsed;
}

function sameOrigin(candidate, base) {
  try {
    const next = new URL(candidate, base);
    if (next.protocol !== 'https:' && next.protocol !== 'http:') return null;
    return next.origin === new URL(base).origin ? next.toString() : null;
  } catch {
    return null;
  }
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/;

/** 'YYYY-MM-DD HH:MM:SS' in UTC → ms. */
function utcMs(s) {
  if (typeof s !== 'string' || !s) return null;
  const t = Date.parse(`${s.replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? null : t;
}

/** Local 'YYYY-MM-DD HH:MM:SS' in `tz` → ms. */
function localMs(s, tz) {
  const m = typeof s === 'string' ? LOCAL.exec(s) : null;
  if (!m) return null;
  return zonedToUtc({ year: +m[1], month: +m[2], day: +m[3], hour: +(m[4] ?? 0), minute: +(m[5] ?? 0), second: +(m[6] ?? 0) }, tz);
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * TEC stores an all-day end as the next day boundary minus one second
 * (23:59:59 on the last day with the default cutoff, 05:59:59 on the next day
 * with a 06:00 cutoff). +1 s, truncated to the date, is the exclusive end.
 */
function exclusiveEndDate(s) {
  const m = typeof s === 'string' ? LOCAL.exec(s) : null;
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + (m[4] ? 0 : 1), +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0) + (m[4] ? 1 : 0)));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const firstOf = (v) => (Array.isArray(v) ? v[0] ?? null : v && typeof v === 'object' && Object.keys(v).length ? v : null);

function toRaw(item, warnings) {
  if (item.hide_from_listings === true) return null;
  const label = item.id ?? '?';
  if (item.status !== 'publish') {
    warnings.push(`skipped event ${label}: non-public status "${item.status ?? '(missing)'}"`);
    return null;
  }
  const uid = item.global_id || item.url || (item.id != null ? String(item.id) : null);
  if (!uid) { warnings.push('skipped an event without global_id/url/id'); return null; }
  const title = singleLineText(typeof item.title === 'string' ? item.title : '');
  if (!title) { warnings.push(`skipped event ${label}: empty title`); return null; }
  const tz = typeof item.timezone === 'string' && isKnownZone(item.timezone) ? item.timezone : BERLIN;

  let time;
  if (item.all_day === true) {
    const m = typeof item.start_date === 'string' ? LOCAL.exec(item.start_date) : null;
    if (!m) { warnings.push(`skipped event ${label}: invalid start_date`); return null; }
    time = { allDay: true, startDate: `${m[1]}-${m[2]}-${m[3]}`, endDate: exclusiveEndDate(item.end_date) };
  } else {
    const startMs = utcMs(item.utc_start_date) ?? localMs(item.start_date, tz);
    if (startMs === null) { warnings.push(`skipped event ${label}: invalid start`); return null; }
    time = { allDay: false, startMs, endMs: utcMs(item.utc_end_date) ?? localMs(item.end_date, tz) };
  }

  const venue = firstOf(item.venue);
  const location = venue ? [venue.venue, venue.address, venue.city].filter((s) => typeof s === 'string' && s.trim()).map((s) => singleLineText(s)).join(', ') : '';
  const tags = [...(item.categories ?? []), ...(item.tags ?? [])]
    .map((t) => (typeof t?.name === 'string' ? singleLineText(t.name) : ''))
    .filter(Boolean);
  return {
    uid,
    recurrenceId: '',
    title,
    description: htmlToText(typeof item.description === 'string' ? item.description : ''),
    ...time,
    location: location || null,
    url: safeHttpUrl(item.url) ?? safeHttpUrl(item.website),
    status: 'confirmed',
    tags,
  };
}

/** Adapter entry point. */
export async function fetchEvents(source, ctx) {
  const warnings = createWarningSink();
  const events = [];
  const seen = new Set();
  let partial;
  let url = firstPageUrl(source.url, ctx.window);
  for (let page = 1; ; page++) {
    let body;
    try {
      body = (await ctx.get(url, { accept: 'application/json' })).body;
    } catch (e) {
      if (page === 1) throw e;
      warnings.push(`pagination stopped after page ${page - 1}: ${e.message}`);
      partial = { reason: `page ${page} could not be fetched` };
      break;
    }
    let data;
    try {
      data = parsePage(body);
    } catch (e) {
      if (page === 1) throw e;
      warnings.push(`pagination stopped: page ${page} ${e.message}`);
      partial = { reason: `page ${page} was unparseable` };
      break;
    }
    for (const item of data.events) {
      const raw = toRaw(item, warnings);
      if (!raw) continue;
      if (seen.has(raw.uid)) { warnings.push(`duplicate uid ${raw.uid} — kept the first`); continue; }
      seen.add(raw.uid);
      events.push(raw);
    }
    if (!data.next_rest_url) break;
    if (page >= MAX_PAGES) {
      warnings.push(`pagination capped at ${MAX_PAGES} pages (${data.total ?? '?'} events upstream)`);
      partial = { reason: `pagination capped at ${MAX_PAGES} pages` };
      break;
    }
    const next = sameOrigin(data.next_rest_url, source.url);
    if (!next) {
      warnings.push(`next_rest_url leaves the source origin (${data.next_rest_url}) — not followed`);
      partial = { reason: 'off-origin next_rest_url' };
      break;
    }
    url = next;
  }
  return { events, warnings: warnings.list(), ...(partial ? { partial } : {}) };
}

/** Several requests per fetch (pages or item pages): a 304 on the first would hide changes behind it, so run.mjs never asks conditionally. */
export const CONDITIONAL = false;
