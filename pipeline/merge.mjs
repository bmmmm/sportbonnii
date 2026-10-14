// One run's per-source results + the previous published state → the next
// events.json / status.json. Pure; run.mjs does the I/O.
//
// Per source:
//   ok        → its events replace the previous ones (a drop from ≥ 5 to 0 counts as error)
//   unchanged → the server answered 304 to our validators: ok, the previous
//               events, `changed` and validators stay as they were
//   partial   → merged with the previous ones, the new version of an id wins
//   error /
//   blocked   → the previous events stay while the failure is ≤ 7 days old, then go
//   disabled  → no events
// `since` moves only when the state changes. `changed` (the last run that
// brought news) moves when a published event of the source is new or differs
// from its published version — measured after dedup, so a removal alone, a
// copy that always loses its dedup contest, or a date that only entered the
// window this month does not move it. `etag` and `lastModified` are the
// response validators of an ok fetch, kept for the next run's conditional
// request. When every fetched source failed, the previous events are kept
// unchanged (a runner outage never wipes data).
//
// Across sources, one event published twice (the club's calendar and a
// platform, or two calendars of one club) is kept once: same club, same start
// minute, normalised titles sharing ≥ 50 % of their tokens. The club's own
// sources beat platforms, earlier sources beat later ones. Never within one
// source.
import { compareEvents, EVENT_KEYS, MAX_ETAG, MAX_LAST_MODIFIED } from './contract.mjs';
import { fold } from './model.mjs';
import { instantOf, addDays, berlinDate } from './tz.mjs';

export const RETENTION_DAYS = 7;
export const DROP_TO_ZERO_FROM = 5;
const FAILED = new Set(['error', 'blocked']);

/** The published form of an event — what a change between runs is measured on. */
const publishedLine = (e) => JSON.stringify(Object.fromEntries(EVENT_KEYS.map((k) => [k, e[k]])));

/**
 * How many of `events` are new or differ from their version in
 * `previousEvents` (by id). An event starting on or after `until` (the
 * previous window's end) could not have been published before, so it is not
 * news when the window moves on.
 */
export function newsOf(events, previousEvents, until = null) {
  const before = new Map(previousEvents.map((e) => [e.id, publishedLine(e)]));
  let added = 0;
  let modified = 0;
  for (const e of events) {
    const was = before.get(e.id);
    if (was === undefined) { if (!until || e.start.slice(0, 10) < until) added++; }
    else if (was !== publishedLine(e)) modified++;
  }
  return { added, modified };
}

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

/** A previous event fitted to today's registry: unknown sports dropped (→ sonstiges), an unknown club unset. */
function reconcile(e, known) {
  if (!known) return e;
  const sports = e.sports.filter((s) => known.sportIds.has(s));
  const club = e.club && known.clubIds.has(e.club) ? e.club : null;
  if (sports.length === e.sports.length && club === e.club) return e;
  return { ...e, sports: sports.length ? sports : ['sonstiges'], club };
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
 * results: Map sourceKey → { state, events, error?, validators?, unchanged? }
 * for every registry source (state 'ok' | 'partial' | 'error' | 'blocked' |
 * 'disabled'; validators = { etag, lastModified } of an ok fetch; unchanged =
 * the server answered 304). previous: { events, status } | null. order: Map
 * sourceKey → registry position. window: { from, to }. today: 'YYYY-MM-DD'
 * (Berlin). known: { sportIds, clubIds } (Sets) — previous events are
 * re-checked against today's registry.
 * Returns { events, status, warnings, dropped, allFailed, news } where news
 * maps a fetched source to { added, modified, unchanged? } for the summary.
 */
export function mergeRun({ results, previous, order, window, today, known }) {
  // Last run's events may name a source, sport or club the registry no longer has.
  const prevEvents = (previous?.events ?? []).filter((e) => results.has(e.source)).map((e) => reconcile(e, known)).filter(Boolean);
  const prevStatus = previous?.status ?? {};
  const prevBySource = new Map();
  for (const e of prevEvents) (prevBySource.get(e.source) ?? prevBySource.set(e.source, []).get(e.source)).push(e);
  const inWindow = (e) => {
    const first = e.start.slice(0, 10);
    const last = e.allDay ? addDays(e.end, -1) : e.end ? berlinDate(instantOf(e.end) - 1) : first;
    return last >= window.from && first < window.to;
  };

  const draft = new Map(); // sourceKey → { state, since, events, validators, error, unchanged }
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
    let validators = null;
    if (r.unchanged) {
      // A 304 confirms the previous events: nothing was fetched, nothing moves.
      // (run.mjs asks conditionally only when the published events hold the
      // source's whole delivery, i.e. none of them lost a dedup contest.)
      state = 'ok';
      events = old;
      validators = prev ? { etag: prev.etag, lastModified: prev.lastModified } : null;
    } else if (state === 'ok' && events.length === 0 && (prev?.count ?? 0) >= DROP_TO_ZERO_FROM) {
      state = 'error';
      error = `returned 0 events after ${prev.count} — kept the previous ones`;
    } else if (state === 'ok') {
      validators = r.validators ?? null;
    }
    // error and blocked are one outage: switching between them keeps its start.
    const same = prev && (prev.state === state || (FAILED.has(prev.state) && FAILED.has(state)));
    const since = same ? prev.since : today;
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
    draft.set(key, { state, since, events, validators, error, unchanged: Boolean(r.unchanged) });
    kept.push(...events);
  }

  // status.json and the news per source. News is measured on the published
  // events (after dedup) against the previously published ones, so a copy that
  // loses its dedup contest every run never counts as new.
  const finish = (published) => {
    const status = {};
    const news = {};
    for (const [key, d] of draft) {
      const prev = prevStatus[key];
      let changed = prev?.changed;
      if (d.state === 'disabled') changed = undefined;
      else if (d.unchanged) news[key] = { added: 0, modified: 0, unchanged: true };
      else if (!FAILED.has(d.state)) {
        const n = newsOf(published.get(key) ?? [], prevBySource.get(key) ?? [], previous?.window?.to ?? null);
        news[key] = n;
        if (n.added || n.modified || !changed) changed = today;
      }
      const v = d.validators;
      const etag = typeof v?.etag === 'string' && v.etag.length <= MAX_ETAG ? v.etag : null;
      const lastModified = typeof v?.lastModified === 'string' && v.lastModified.length <= MAX_LAST_MODIFIED ? v.lastModified : null;
      status[key] = {
        state: d.state,
        since: d.since,
        count: d.events.length,
        ...(changed ? { changed } : {}),
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
        ...(d.error && d.state !== 'ok' && d.state !== 'disabled' ? { error: String(d.error).slice(0, 300) } : {}),
      };
    }
    return { status, news };
  };

  if (fetched > 0 && failed === fetched && prevEvents.length) {
    warnings.push(`all ${fetched} sources failed — kept the previous ${prevEvents.length} events unchanged`);
    const { status, news } = finish(new Map());
    return { events: [...prevEvents].filter(inWindow).sort(compareEvents), status, warnings, dropped: 0, allFailed: true, news };
  }

  const unique = new Map();
  for (const e of kept) if (!unique.has(e.id)) unique.set(e.id, e);
  const { events, dropped } = dedupe([...unique.values()], order);
  const published = new Map();
  for (const e of events) (published.get(e.source) ?? published.set(e.source, []).get(e.source)).push(e);
  const { status, news } = finish(published);
  return { events: events.sort(compareEvents), status, warnings, dropped, allFailed: false, news };
}
