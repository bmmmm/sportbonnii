// One run's per-source results + the previous published state → the next
// events.json / status.json. Pure; run.mjs does the I/O.
//
// Per source:
//   ok        → its events replace the previous ones (a drop from ≥ 5 to 0 counts as error)
//   partial   → merged with the previous ones, the new version of an id wins
//   error /
//   blocked   → the previous events stay while the failure is ≤ 7 days old, then go
//   disabled  → no events
// `since` moves only when the state changes. When every fetched source failed,
// the previous events are kept unchanged (a runner outage never wipes data).
//
// Across sources, one event published twice (the club's calendar and a
// platform, or two calendars of one club) is kept once: same club, same start
// minute, normalised titles sharing ≥ 50 % of their tokens. The club's own
// sources beat platforms, earlier sources beat later ones. Never within one
// source.
import { compareEvents } from './contract.mjs';
import { fold } from './model.mjs';
import { instantOf, addDays } from './tz.mjs';

export const RETENTION_DAYS = 7;
export const DROP_TO_ZERO_FROM = 5;
const FAILED = new Set(['error', 'blocked']);

const STOP_WORDS = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'und', 'oder', 'mit', 'von', 'vom', 'zum', 'zur', 'fur', 'auf',
  'bei', 'beim', 'gegen', 'ein', 'eine', 'einen', 'the', 'and', 'for', 'tag', 'uhr',
]);

/** Normalised title tokens: folded, ≥ 3 characters, stop words out. */
export function titleTokens(title) {
  return new Set(fold(title).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3 && !STOP_WORDS.has(t)));
}

/** Share of the smaller token set found in the other one. */
export function tokenOverlap(a, b) {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Precedence of a source for an event of `club`: lower wins. */
function rankOf(sourceKey, club, order) {
  const [owner] = sourceKey.split('/');
  const own = owner === club ? 0 : 1;
  return own * 10_000 + (order.get(sourceKey) ?? 9_999);
}

/** Drops cross-source duplicates; returns { events, dropped }. */
export function dedupe(events, order) {
  const groups = new Map();
  for (const e of events) {
    if (!e.club) continue;
    const key = `${e.club}|${Math.floor(instantOf(e.start) / 60_000)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(e);
  }
  const drop = new Set();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => rankOf(a.source, a.club, order) - rankOf(b.source, b.club, order) || (a.id < b.id ? -1 : 1));
    for (let i = 0; i < group.length; i++) {
      if (drop.has(group[i].id)) continue;
      for (let j = i + 1; j < group.length; j++) {
        const lo = group[j];
        if (drop.has(lo.id) || lo.source === group[i].source) continue;
        if (tokenOverlap(group[i].title, lo.title) >= 0.5) drop.add(lo.id);
      }
    }
  }
  return { events: events.filter((e) => !drop.has(e.id)), dropped: drop.size };
}

/**
 * results: Map sourceKey → { state, events, error? } for every registry source
 * (state 'ok' | 'partial' | 'error' | 'blocked' | 'disabled').
 * previous: { events, status } | null. order: Map sourceKey → registry position.
 * window: { from, to }. today: 'YYYY-MM-DD' (Berlin).
 */
export function mergeRun({ results, previous, order, window, today }) {
  const prevEvents = previous?.events ?? [];
  const prevStatus = previous?.status ?? {};
  const prevBySource = new Map();
  for (const e of prevEvents) (prevBySource.get(e.source) ?? prevBySource.set(e.source, []).get(e.source)).push(e);
  const inWindow = (e) => {
    const last = e.allDay ? addDays(e.end, -1) : e.start.slice(0, 10);
    return last >= window.from && e.start.slice(0, 10) < window.to;
  };

  const status = {};
  const kept = [];
  const warnings = [];
  let fetched = 0;
  let failed = 0;
  for (const [key, r] of results) {
    const prev = prevStatus[key];
    const old = (prevBySource.get(key) ?? []).filter(inWindow);
    let state = r.state;
    let error = r.error;
    let events = r.events ?? [];
    if (state === 'ok' && events.length === 0 && (prev?.count ?? 0) >= DROP_TO_ZERO_FROM) {
      state = 'error';
      error = `returned 0 events after ${prev.count} — kept the previous ones`;
    }
    const since = prev && prev.state === state ? prev.since : today;
    if (state !== 'disabled') fetched++;
    if (FAILED.has(state)) {
      failed++;
      events = daysBetween(since, today) <= RETENTION_DAYS ? old : [];
      if (!events.length && old.length) warnings.push(`${key}: failing since ${since}, its ${old.length} previous events dropped`);
    } else if (state === 'partial') {
      const byId = new Map(old.map((e) => [e.id, e]));
      for (const e of events) byId.set(e.id, e);
      events = [...byId.values()];
    } else if (state === 'disabled') {
      events = [];
    }
    status[key] = { state, since, count: events.length, ...(error && state !== 'ok' && state !== 'disabled' ? { error: String(error).slice(0, 300) } : {}) };
    kept.push(...events);
  }

  if (fetched > 0 && failed === fetched && prevEvents.length) {
    warnings.push(`all ${fetched} sources failed — kept the previous ${prevEvents.length} events unchanged`);
    return { events: [...prevEvents].filter(inWindow).sort(compareEvents), status, warnings, dropped: 0, allFailed: true };
  }

  const unique = new Map();
  for (const e of kept) if (!unique.has(e.id)) unique.set(e.id, e);
  const { events, dropped } = dedupe([...unique.values()], order);
  return { events: events.sort(compareEvents), status, warnings, dropped, allFailed: false };
}
