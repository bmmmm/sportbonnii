// The data contract between pipeline and page: the exact text form of
// site/data/*.json and a checker for it. The pipeline writes through the
// formatters below; the tests, the web-smoke gate and the committed
// snapshot test/fixtures/site-data/ are all judged by checkSiteData.
import { instantOf } from './tz.mjs';
import { KIND_IDS, VENUE_USES } from '../site/kinds.js';
import { MAX_VENUES, VENUE_BOUNDS, OSM_REF } from './registry.mjs';

export const EVENT_KEYS = ['id', 'club', 'sports', 'kind', 'home', 'title', 'start', 'end', 'allDay', 'location', 'url', 'description', 'source', 'status'];
export const STATES = ['ok', 'partial', 'error', 'blocked', 'disabled'];
export const STATUSES = ['confirmed', 'cancelled'];
export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 400;
// status.json validators (response headers kept verbatim for the next conditional request).
export const MAX_ETAG = 200;
export const MAX_LAST_MODIFIED = 64;

// The keys a venue may carry in clubs.json (the registry's list: contract changes travel together).
const VENUE_KEYS = ['name', 'address', 'lat', 'lon', 'osm', 'use'];
const isText = (v) => typeof v === 'string' && v.trim() !== '' && v === v.trim();

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
const ID = /^[0-9a-f]{16}$/;
const SOURCE_KEY = /^[a-z0-9]+(-[a-z0-9]+)*\/[a-z0-9]+(-[a-z0-9]+)*$/;

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

/** Pretty JSON with sorted keys — status, clubs, sports and meta. */
export function formatJson(doc) {
  return JSON.stringify(sortKeys(doc), null, 2) + '\n';
}

/** One event per line, keys in EVENT_KEYS order — small diffs, cheap to read. */
export function formatEventsJson({ window, events }) {
  const head = `{"version":1,"window":${JSON.stringify({ from: window.from, to: window.to })},"events":[`;
  if (events.length === 0) return `${head}]}\n`;
  const lines = events.map((e) => JSON.stringify(Object.fromEntries(EVENT_KEYS.map((k) => [k, e[k]]))));
  return `${head}\n${lines.join(',\n')}\n]}\n`;
}

/** Sort key of events.json: start instant, then club, then id. */
export function compareEvents(a, b) {
  const d = instantOf(a.start) - instantOf(b.start);
  if (d) return d;
  const ca = a.club ?? '';
  const cb = b.club ?? '';
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const isHttp = (v) => {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};

/** Problems with one event object; [] when it honours the contract. */
export function checkEvent(e, { sportIds, clubIds } = {}) {
  const errs = [];
  const at = `event ${e?.id ?? '?'}`;
  if (!e || typeof e !== 'object') return [`${at}: not an object`];
  const keys = Object.keys(e);
  if (keys.join() !== EVENT_KEYS.join()) errs.push(`${at}: keys must be exactly ${EVENT_KEYS.join(', ')} in that order, got ${keys.join(', ')}`);
  if (!ID.test(e.id)) errs.push(`${at}: id must be 16 hex digits`);
  if (e.club !== null && (typeof e.club !== 'string' || (clubIds && !clubIds.has(e.club)))) errs.push(`${at}: club must be a registry club id or null`);
  if (!Array.isArray(e.sports) || e.sports.length === 0 || new Set(e.sports).size !== e.sports.length) errs.push(`${at}: sports must be a non-empty list without repeats`);
  else if (sportIds && e.sports.some((s) => !sportIds.has(s))) errs.push(`${at}: unknown sport in ${e.sports.join(', ')}`);
  if (!KIND_IDS.includes(e.kind)) errs.push(`${at}: kind must be one of ${KIND_IDS.join(', ')}`);
  if (![true, false, null].includes(e.home)) errs.push(`${at}: home must be true, false or null`);
  else if (e.home !== null && e.kind !== 'spiel') errs.push(`${at}: only a game (kind spiel) can be home or away`);
  if (typeof e.title !== 'string' || e.title.trim() === '' || e.title.length > MAX_TITLE) errs.push(`${at}: title must be 1–${MAX_TITLE} characters`);
  if (typeof e.allDay !== 'boolean') errs.push(`${at}: allDay must be boolean`);
  const kind = e.allDay ? DATE : DATETIME;
  if (typeof e.start !== 'string' || !kind.test(e.start)) errs.push(`${at}: start must be ${e.allDay ? 'YYYY-MM-DD' : 'YYYY-MM-DDTHH:MM:SS±HH:MM'}`);
  if (e.allDay) {
    if (typeof e.end !== 'string' || !DATE.test(e.end) || !(e.end > e.start)) errs.push(`${at}: an all-day end must be a later date (exclusive)`);
  } else if (e.end !== null && (typeof e.end !== 'string' || !DATETIME.test(e.end) || instantOf(e.end) < instantOf(e.start))) {
    errs.push(`${at}: end must be null or a datetime not before start`);
  }
  if (e.location !== null && (typeof e.location !== 'string' || e.location.trim() === '')) errs.push(`${at}: location must be text or null`);
  if (e.url !== null && !isHttp(e.url)) errs.push(`${at}: url must be http(s) or null`);
  if (e.description !== null && (typeof e.description !== 'string' || e.description === '' || e.description.length > MAX_DESCRIPTION)) errs.push(`${at}: description must be null or 1–${MAX_DESCRIPTION} characters`);
  if (typeof e.source !== 'string' || !SOURCE_KEY.test(e.source)) errs.push(`${at}: source must be "<owner>/<source>"`);
  if (!STATUSES.includes(e.status)) errs.push(`${at}: status must be ${STATUSES.join(' or ')}`);
  return errs;
}

/** Contract violations of one club's `venues` (the registry's rules and bounds, applied to the published form). */
export function checkVenues(venues, at) {
  const errs = [];
  if (!Array.isArray(venues)) return [`${at}: venues must be a list`];
  if (venues.length === 0 || venues.length > MAX_VENUES) errs.push(`${at}: venues must list 1 to ${MAX_VENUES} venues`);
  for (const [j, v] of venues.entries()) {
    const vat = `${at}.venues[${j}]`;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) { errs.push(`${vat}: must be an object`); continue; }
    for (const k of Object.keys(v)) if (!VENUE_KEYS.includes(k)) errs.push(`${vat}: unknown field "${k}"`);
    if (!isText(v.name)) errs.push(`${vat}: name must be non-empty text`);
    if ('address' in v && !isText(v.address)) errs.push(`${vat}: address must be non-empty text`);
    for (const axis of ['lat', 'lon']) {
      const [min, max] = VENUE_BOUNDS[axis];
      if (typeof v[axis] !== 'number' || !Number.isFinite(v[axis]) || v[axis] < min || v[axis] > max) errs.push(`${vat}: ${axis} must be a number from ${min} to ${max}`);
    }
    if ('osm' in v && !(typeof v.osm === 'string' && OSM_REF.test(v.osm))) errs.push(`${vat}: osm must be node/<n>, way/<n> or relation/<n>`);
    if ('use' in v && !VENUE_USES.includes(v.use)) errs.push(`${vat}: use must be one of ${VENUE_USES.join(', ')}`);
  }
  return errs;
}

/**
 * Every contract violation in a site/data/ snapshot. `texts` holds the raw
 * file contents keyed by name (events.json, status.json, clubs.json,
 * sports.json, meta.json); the text form is part of the contract.
 */
export function checkSiteData(texts) {
  const errs = [];
  const parsed = {};
  for (const name of ['events.json', 'status.json', 'clubs.json', 'sports.json', 'meta.json']) {
    if (typeof texts[name] !== 'string') { errs.push(`${name}: missing`); continue; }
    try { parsed[name] = JSON.parse(texts[name]); } catch (e) { errs.push(`${name}: not JSON (${e.message})`); }
  }
  if (errs.length) return errs;
  const { 'events.json': ev, 'status.json': status, 'clubs.json': clubs, 'sports.json': sports, 'meta.json': meta } = parsed;

  const sportIds = new Set((sports.sports ?? []).map((s) => s.id));
  if (sportIds.size === 0) errs.push('sports.json: no sports');
  if (!Array.isArray(clubs.clubs) || !Array.isArray(clubs.platforms)) errs.push('clubs.json: needs clubs[] and platforms[]');
  const owners = [...(clubs.clubs ?? []), ...(clubs.platforms ?? [])];
  const clubIds = new Set((clubs.clubs ?? []).map((c) => c.id));
  const sourceKeys = new Set(owners.flatMap((o) => (o.sources ?? []).map((s) => `${o.id}/${s.id}`)));
  for (const o of owners) for (const s of o.sources ?? []) if ('note' in s) errs.push(`clubs.json: ${o.id}/${s.id} still carries its note`);
  for (const c of clubs.clubs ?? []) if ('venues' in c) errs.push(...checkVenues(c.venues, `clubs.json: ${c.id}`));

  if (ev.version !== 1) errs.push('events.json: version must be 1');
  if (!ev.window || !DATE.test(ev.window.from) || !DATE.test(ev.window.to) || !(ev.window.from < ev.window.to)) errs.push('events.json: window needs from < to as dates');
  if (!Array.isArray(ev.events)) errs.push('events.json: events must be an array');
  else {
    const ids = new Set();
    for (const e of ev.events) {
      errs.push(...checkEvent(e, { sportIds, clubIds }));
      if (ids.has(e.id)) errs.push(`event ${e.id}: duplicate id`);
      ids.add(e.id);
      if (!sourceKeys.has(e.source)) errs.push(`event ${e.id}: source ${e.source} is not in clubs.json`);
    }
    for (let i = 1; i < ev.events.length; i++) {
      if (compareEvents(ev.events[i - 1], ev.events[i]) > 0) { errs.push(`events.json: not sorted at index ${i} (${ev.events[i].id})`); break; }
    }
    if (!errs.length && texts['events.json'] !== formatEventsJson(ev)) errs.push('events.json: text is not in the one-event-per-line form');
  }

  for (const [key, s] of Object.entries(status)) {
    if (!s || typeof s !== 'object') { errs.push(`status.json: ${key} must be an object`); continue; }
    if (!sourceKeys.has(key)) errs.push(`status.json: ${key} is not a source in clubs.json`);
    if (!STATES.includes(s.state)) errs.push(`status.json: ${key} state must be one of ${STATES.join(', ')}`);
    if (!DATE.test(s.since)) errs.push(`status.json: ${key} since must be a date`);
    if (!Number.isInteger(s.count) || s.count < 0) errs.push(`status.json: ${key} count must be a non-negative integer`);
    if ('error' in s && (typeof s.error !== 'string' || s.error === '')) errs.push(`status.json: ${key} error must be text`);
    if ((s.state === 'error' || s.state === 'blocked') && !s.error) errs.push(`status.json: ${key} is ${s.state} without an error text`);
    // Optional: the last run that brought news, and the validators for the next conditional request.
    if ('changed' in s && !DATE.test(s.changed)) errs.push(`status.json: ${key} changed must be a date`);
    if ('etag' in s && (typeof s.etag !== 'string' || s.etag === '' || s.etag.length > MAX_ETAG)) errs.push(`status.json: ${key} etag must be 1–${MAX_ETAG} characters`);
    if ('lastModified' in s && (typeof s.lastModified !== 'string' || s.lastModified === '' || s.lastModified.length > MAX_LAST_MODIFIED)) errs.push(`status.json: ${key} lastModified must be 1–${MAX_LAST_MODIFIED} characters`);
    if (s.state === 'disabled' && ('changed' in s || 'etag' in s || 'lastModified' in s)) errs.push(`status.json: ${key} is disabled but carries changed/etag/lastModified`);
  }
  for (const key of sourceKeys) if (!(key in status)) errs.push(`status.json: no entry for ${key}`);

  if (typeof meta.checkedAt !== 'string' || Number.isNaN(Date.parse(meta.checkedAt)) || !meta.checkedAt.endsWith('Z')) errs.push('meta.json: checkedAt must be a UTC ISO timestamp');
  if (!Number.isInteger(meta.sourcesOk) || !Number.isInteger(meta.sourcesTotal) || meta.sourcesOk > meta.sourcesTotal) errs.push('meta.json: sourcesOk ≤ sourcesTotal, both integers');
  if ('build' in meta && (typeof meta.build !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(meta.build))) errs.push('meta.json: build must be a short identifier (the commit that produced the data)');

  for (const [name, doc] of [['status.json', status], ['clubs.json', clubs], ['sports.json', sports], ['meta.json', meta]]) {
    if (texts[name] !== formatJson(doc)) errs.push(`${name}: text is not in canonical form (sorted keys, 2-space indent)`);
  }
  // Only meta.json may carry a timestamp: the other files must be byte-stable
  // across runs. (status.json's lastModified is a source's own validator,
  // echoed verbatim — it moves only when that source changes.)
  for (const name of ['events.json', 'status.json', 'clubs.json', 'sports.json']) {
    if (/"(generatedAt|checkedAt|fetchedAt|updatedAt|timestamp)"/.test(texts[name])) errs.push(`${name}: carries a timestamp field (only meta.json may)`);
  }
  return errs;
}
