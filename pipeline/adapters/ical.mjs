// iCalendar adapter, ported from scalendarii (src/ingest/adapters/ical.ts,
// parseIcalFeed) with its DoS caps and expansion rules, plus the timezone fix
// that file left as TODO:
//
//   zone = the TZID on the event's DTSTART.
//   - The feed defines it (VTIMEZONE) or the time is UTC → ical.js toUnixTime().
//   - Otherwise the wall clock is converted with that TZID when Intl knows it,
//     with Europe/Berlin when it does not (floating times, a TZID without
//     VTIMEZONE such as Google's "Europe/Berlin", Outlook's
//     "W. Europe Standard Time"), and the feed gets a warning.
//
// ical.js resolves an undefined TZID as floating and its toUnixTime() then
// reads the wall clock as UTC — hours off. Recurring series stay correct
// across DST because the iterator steps the wall clock and every instance is
// converted on its own.
import ICAL from 'ical.js';
import { createWarningSink, safeHttpUrl } from '../text.mjs';
import { BERLIN, isKnownZone, zonedToUtc } from '../tz.mjs';
import { windowMs } from '../model.mjs';

const MAX_ITERATIONS_PER_SERIES = 100_000;
const MAX_ITERATION_STEPS_PER_FEED = 250_000;
const MAX_INSTANCES_PER_SERIES = 1000;
const MAX_INSTANCES_PER_FEED = 50_000;
const TZ_PROPS = ['dtstart', 'dtend', 'recurrence-id', 'exdate', 'rdate'];

const pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * How one event's times become instants: `registered` (VTIMEZONE or UTC —
 * trust ical.js) or a zone name for wall-clock conversion.
 */
function zoneHintOf(comp) {
  const prop = comp.getFirstProperty('dtstart');
  const tzid = prop?.getParameter('tzid');
  const value = prop?.getFirstValue();
  if (!value || value.isDate) return { zone: BERLIN, fallback: false };
  if (value.zone && value.zone.tzid === 'UTC') return { registered: true };
  if (typeof tzid === 'string' && ICAL.TimezoneService.has(tzid)) return { registered: true };
  if (typeof tzid === 'string' && isKnownZone(tzid)) return { zone: tzid, fallback: false, label: tzid };
  return { zone: BERLIN, fallback: true, label: typeof tzid === 'string' ? tzid : 'floating' };
}

/** UTC ms of an ICAL.Time under the event's zone hint. */
function toMs(t, hint) {
  if (t.isDate) return zonedToUtc({ year: t.year, month: t.month, day: t.day }, BERLIN);
  if (t.zone && t.zone.tzid === 'UTC') return t.toUnixTime() * 1000;
  if (hint.registered && t.zone && t.zone.tzid !== 'floating') return t.toUnixTime() * 1000;
  return zonedToUtc({ year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second }, hint.zone ?? BERLIN);
}

const dateOf = (t) => `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;

function isJcalList(parsed) {
  return Array.isArray(parsed) && Array.isArray(parsed[0]);
}

/**
 * Parse an iCalendar body into raw events overlapping [startMs, endMs).
 * Returns { events, warnings, partial? }.
 */
export function parseIcal(text, { startMs, endMs }) {
  const warnings = createWarningSink();
  let roots;
  try {
    const parsed = ICAL.parse(text);
    roots = (isJcalList(parsed) ? parsed : [parsed]).map((j) => new ICAL.Component(j));
  } catch (err) {
    throw new Error(`invalid iCalendar data: ${err instanceof Error ? err.message : String(err)}`);
  }
  const sub = (name) => roots.flatMap((r) => r.getAllSubcomponents(name));

  // Fresh registry per feed, so one feed's VTIMEZONE never leaks into another.
  ICAL.TimezoneService.reset();
  for (const vtz of sub('vtimezone')) {
    const tz = new ICAL.Timezone(vtz);
    if (tz.tzid) ICAL.TimezoneService.register(tz);
  }

  const fallbackZones = new Set();
  const unknownTzids = new Set();
  for (const v of sub('vevent')) {
    for (const name of TZ_PROPS) {
      for (const p of v.getAllProperties(name)) {
        const tzid = p.getParameter('tzid');
        if (typeof tzid === 'string' && tzid !== 'UTC' && !ICAL.TimezoneService.has(tzid) && !isKnownZone(tzid)) unknownTzids.add(tzid);
      }
    }
  }

  const vevents = sub('vevent').map((c) => new ICAL.Event(c));
  const masters = vevents.filter((e) => !e.isRecurrenceException());
  const exceptions = vevents.filter((e) => e.isRecurrenceException());
  const byUid = new Map(masters.map((m) => [m.uid, m]));
  const orphans = [];
  for (const ex of exceptions) {
    const master = byUid.get(ex.uid);
    if (master) master.relateException(ex);
    else orphans.push(ex);
  }

  const events = [];
  const budget = { remaining: MAX_ITERATION_STEPS_PER_FEED, exhausted: false };
  let ceiling = false;
  let seriesTruncated = false;
  const emit = (ev, start, end, rid, hint) => {
    if (hint.fallback) fallbackZones.add(hint.label);
    const raw = toRaw(ev, start, end, rid, hint);
    if (overlaps(raw, startMs, endMs)) events.push(raw);
  };

  for (const master of masters) {
    if (events.length >= MAX_INSTANCES_PER_FEED) { ceiling = true; break; }
    const hint = zoneHintOf(master.component);
    try {
      if (master.isRecurring()) {
        if (budget.exhausted) continue;
        const r = expandSeries(master, hint, startMs, endMs, Math.min(MAX_INSTANCES_PER_SERIES, MAX_INSTANCES_PER_FEED - events.length), budget, warnings);
        for (const raw of r.instances) events.push(raw);
        if (r.instances.length && hint.fallback) fallbackZones.add(hint.label);
        if (r.truncated) seriesTruncated = true;
      } else {
        emit(master, master.startDate, master.endDate, '', hint);
      }
    } catch (err) {
      warnings.push(`skipped event ${master.uid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const ex of orphans) {
    if (events.length >= MAX_INSTANCES_PER_FEED) { ceiling = true; break; }
    try {
      const hint = zoneHintOf(ex.component);
      emit(ex, ex.startDate, ex.endDate, ex.recurrenceId ? ridOf(ex.recurrenceId, hint) : '', hint);
    } catch (err) {
      warnings.push(`skipped orphan override ${ex.uid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const head = [];
  const truncations = [];
  if (ceiling) { head.push(`feed reached the ${MAX_INSTANCES_PER_FEED}-instance ceiling`); truncations.push('instance ceiling'); }
  if (budget.exhausted) { head.push(`feed reached the ${MAX_ITERATION_STEPS_PER_FEED}-step expansion budget`); truncations.push('expansion budget'); }
  if (seriesTruncated) { head.push('at least one series hit its own expansion bound — instances are missing'); truncations.push('series bound'); }
  if (fallbackZones.size) head.push(`times without a usable time zone read as Europe/Berlin wall clock (${[...fallbackZones].join(', ')})`);
  if (unknownTzids.size) head.push(`unknown TZID(s): ${[...unknownTzids].join(', ')}`);
  return {
    events,
    warnings: [...head, ...warnings.list()],
    ...(truncations.length ? { partial: { reason: `iCal expansion truncated: ${truncations.join('; ')}` } } : {}),
  };
}

function ridOf(t, hint) {
  return t.isDate ? dateOf(t) : new Date(toMs(t, hint)).toISOString();
}

function expandSeries(master, hint, startMs, endMs, maxInstances, budget, warnings) {
  const out = [];
  const emitted = new Set();
  const durationMs = Math.max(0, master.duration.toSeconds() * 1000);
  const anchor = fastForwardAnchor(master, hint, startMs - durationMs);
  const iter = anchor ? master.iterator(anchor) : master.iterator();
  let iterations = 0;
  let truncated = false;
  let next;
  while ((next = iter.next())) {
    if (budget.remaining <= 0) { budget.exhausted = true; break; }
    budget.remaining--;
    if (++iterations > MAX_ITERATIONS_PER_SERIES) {
      warnings.push(`series ${master.uid}: stopped after ${MAX_ITERATIONS_PER_SERIES} iterator steps`);
      truncated = true;
      break;
    }
    const slot = toMs(next, hint);
    if (slot > endMs) break; // the ORIGINAL slot is monotonic; overrides are not
    if (slot + durationMs < startMs) continue;
    let occ = master.getOccurrenceDetails(next);
    // ical.js relates every recurrence-id sibling of the calendar as an
    // exception without checking the UID; fall back to our own occurrence.
    if (occ.item.uid !== master.uid) {
      const endDate = next.clone();
      endDate.addDuration(master.duration);
      occ = { recurrenceId: next, startDate: next, endDate, item: master };
    }
    const itemHint = occ.item === master ? hint : zoneHintOf(occ.item.component);
    const raw = toRaw(occ.item, occ.startDate, occ.endDate, ridOf(occ.recurrenceId, hint), itemHint);
    if (!overlaps(raw, startMs, endMs)) continue;
    if (out.length >= maxInstances) {
      warnings.push(`series ${master.uid}: capped at ${maxInstances} instances`);
      truncated = true;
      break;
    }
    emitted.add(raw.recurrenceId);
    out.push(raw);
  }
  // Overrides whose original slot the loop never reached, moved into the window.
  for (const ex of Object.values(master.exceptions ?? {})) {
    if (ex.uid !== master.uid || !ex.recurrenceId) continue;
    const rid = ridOf(ex.recurrenceId, hint);
    if (emitted.has(rid)) continue;
    const raw = toRaw(ex, ex.startDate, ex.endDate, rid, zoneHintOf(ex.component));
    if (!overlaps(raw, startMs, endMs)) continue;
    if (out.length >= maxInstances) { truncated = true; break; }
    emitted.add(rid);
    out.push(raw);
  }
  return { instances: out, truncated };
}

const FIXED_PERIOD_SECONDS = { SECONDLY: 1, MINUTELY: 60, HOURLY: 3600, DAILY: 86_400, WEEKLY: 604_800 };
const FAST_FORWARD_MARGIN_PERIODS = 2;

/**
 * Start the expansion just before the window instead of at DTSTART, shifting
 * by whole rule periods (wall clock, so the occurrence grid is unchanged).
 * Not for COUNT, RDATE, several RRULEs, MONTHLY/YEARLY.
 */
function fastForwardAnchor(master, hint, notAfter) {
  const comp = master.component;
  if (comp.getAllProperties('rrule').length !== 1 || comp.hasProperty('rdate')) return null;
  const rule = comp.getFirstPropertyValue('rrule');
  if (!(rule instanceof ICAL.Recur) || rule.count) return null;
  const periodSeconds = FIXED_PERIOD_SECONDS[rule.freq];
  if (periodSeconds === undefined) return null;
  const interval = rule.interval > 0 ? rule.interval : 1;
  const stepMs = periodSeconds * interval * 1000;
  const start = master.startDate;
  const target = notAfter - FAST_FORWARD_MARGIN_PERIODS * stepMs;
  let periods = Math.floor((target - toMs(start, hint)) / stepMs);
  for (let attempt = 0; attempt < 4 && periods > 0; attempt++) {
    const anchor = start.clone();
    const n = periods * interval;
    if (rule.freq === 'WEEKLY') anchor.adjust(n * 7, 0, 0, 0);
    else if (rule.freq === 'DAILY') anchor.adjust(n, 0, 0, 0);
    else if (rule.freq === 'HOURLY') anchor.adjust(0, n, 0, 0);
    else if (rule.freq === 'MINUTELY') anchor.adjust(0, 0, n, 0);
    else anchor.adjust(0, 0, 0, n);
    const overshoot = toMs(anchor, hint) - target;
    if (overshoot <= 0) return anchor;
    periods -= Math.max(1, Math.ceil(overshoot / stepMs));
  }
  return null;
}

function toRaw(ev, start, end, recurrenceId, hint) {
  const comp = ev.component;
  const status = String(comp.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED' ? 'cancelled' : 'confirmed';
  const tags = comp.getAllProperties('categories').flatMap((p) => p.getValues()).map((v) => String(v).trim()).filter(Boolean);
  const base = {
    uid: ev.uid,
    recurrenceId,
    title: (ev.summary ?? '').replace(/\s+/g, ' ').trim(),
    description: (ev.description ?? '').trim(),
    location: ev.location ?? null,
    url: safeHttpUrl(comp.getFirstPropertyValue('url')),
    status,
    tags,
  };
  if (start.isDate) {
    return { ...base, allDay: true, startDate: dateOf(start), endDate: end && end.isDate ? dateOf(end) : null };
  }
  return { ...base, allDay: false, startMs: toMs(start, hint), endMs: end ? toMs(end, hint) : null };
}

function overlaps(raw, startMs, endMs) {
  if (raw.allDay) {
    const s = zonedToUtc(ymd(raw.startDate), BERLIN);
    const e = raw.endDate ? zonedToUtc(ymd(raw.endDate), BERLIN) : s + 86_400_000;
    return s < endMs && e > startMs;
  }
  const e = raw.endMs ?? raw.startMs;
  return raw.startMs < endMs && e >= startMs;
}

function ymd(date) {
  const [year, month, day] = date.split('-').map(Number);
  return { year, month, day };
}

/** Adapter entry point. */
export async function fetchEvents(source, ctx) {
  // A subscription feed: fetched the way a calendar client does (see net.mjs).
  const res = await ctx.get(source.url, { accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5', robots: false });
  const body = res.body.replace(/^﻿/, '');
  if (!/^\s*BEGIN:VCALENDAR/i.test(body)) throw new Error('response is not an iCalendar document (no BEGIN:VCALENDAR)');
  return parseIcal(body, windowMs(ctx.window));
}
