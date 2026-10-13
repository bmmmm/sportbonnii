// Adapter output → events.json entries. Adapters hand over "raw" events:
//
//   { uid, recurrenceId, title, description, allDay,
//     startMs | startDate, endMs | endDate,        // UTC ms, or 'YYYY-MM-DD' when allDay
//     location, url, status, tags }
//
// normalizeEvent applies the contract: Berlin wall-clock times with offset,
// exclusive all-day ends, caps on text, the source's `exclude` list, sports
// from tagMap / keywords / club, and the club from the owner or an alias.
import { createHash } from 'node:crypto';
import { MAX_TITLE, MAX_DESCRIPTION } from './contract.mjs';
import { toBerlinIso, berlinDate, addDays, berlinMidnight } from './tz.mjs';
import { safeHttpUrl } from './text.mjs';

/** sha256(source, uid, recurrenceId), first 16 hex digits. */
export function eventId(sourceKey, uid, recurrenceId = '') {
  return createHash('sha256').update(`${sourceKey}\0${uid}\0${recurrenceId}`).digest('hex').slice(0, 16);
}

/** Lowercase, diacritics folded (ß → ss), for matching. */
export function fold(s) {
  return s.normalize('NFD').replace(/\p{M}+/gu, '').replace(/ß/g, 'ss').toLowerCase();
}

/** Cut to `max` characters at a word boundary when one is near, with an ellipsis. */
export function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–-]+$/, '') + '…';
}

const isWordChar = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** `needle` occurs in `hay` starting at a word start (both already folded). */
function hasWordStart(hay, needle) {
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    if (!isWordChar(hay[i - 1])) return true;
  }
  return false;
}

/** `needle` occurs in `hay` as whole words (both already folded). */
function hasWhole(hay, needle) {
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    if (!isWordChar(hay[i - 1]) && !isWordChar(hay[i + needle.length])) return true;
  }
  return false;
}

const LOCATION_NOISE = /^(deutschland|germany|nordrhein-westfalen|nrw|stadtbezirk .+|regierungsbezirk .+)$/i;

/**
 * Readable place text: geocoder tails (country, state, "Stadtbezirk …") and
 * repeated parts dropped, a bare postcode merged into the following city
 * ("53113, Bonn" → "53113 Bonn") or dropped, at most five parts.
 */
export function tidyLocation(text) {
  const parts = String(text ?? '').replace(/\s+/g, ' ').split(/\s*,\s*/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (LOCATION_NOISE.test(p)) continue;
    if (out.some((q) => fold(q) === fold(p) || fold(q).includes(fold(p)))) continue;
    out.push(p);
  }
  for (let i = 0; i < out.length - 1; i++) {
    if (/^\d{5}$/.test(out[i]) && !/\d/.test(out[i + 1])) out.splice(i, 2, `${out[i]} ${out[i + 1]}`);
  }
  // A postcode that found no city to join says nothing a reader needs.
  const kept = out.filter((p, i) => !/^\d{5}$/.test(p) || out.length === 1 || i === 0);
  out.length = 0;
  out.push(...kept);
  return out.slice(0, 5).join(', ') || null;
}

/**
 * Lookup tables for one registry: sports keywords, club aliases. Built once
 * per run and passed to normalizeEvent.
 */
export function buildContext(registry) {
  const keywords = registry.sports
    .flatMap((s) => (s.keywords ?? []).map((k) => ({ sport: s.id, k: fold(k) })));
  const aliases = registry.clubs
    .filter((c) => c.active !== false)
    .flatMap((c) => [c.name, ...(c.aliases ?? [])].map((a) => ({ club: c, a: fold(a) })))
    .sort((x, y) => y.a.length - x.a.length || (x.club.id < y.club.id ? -1 : 1));
  const order = new Map(registry.sports.map((s, i) => [s.id, i]));
  return { keywords, aliases, order, sportIds: new Set(registry.sports.map((s) => s.id)) };
}

function sportsByTags(tags, tagMap) {
  if (!tagMap) return [];
  const map = new Map(Object.entries(tagMap).map(([t, s]) => [fold(t), s]));
  return tags.map((t) => map.get(fold(t))).filter(Boolean);
}

function sportsByKeywords(text, keywords) {
  return keywords.filter(({ k }) => hasWordStart(text, k)).map(({ sport }) => sport);
}

const uniqueInOrder = (ids, order) => [...new Set(ids)].sort((a, b) => order.get(a) - order.get(b));

/** The club a platform event names (longest alias first), or null. */
export function clubByAlias(ctx, ...texts) {
  const hay = fold(texts.filter(Boolean).join(' \n '));
  return ctx.aliases.find(({ a }) => hasWhole(hay, a))?.club ?? null;
}

/**
 * One raw adapter event → an events.json entry, or null when it is dropped
 * (excluded, outside the window, unusable). `owner` is the club or platform,
 * `kind` 'club' | 'platform', `window` { from, to } as Berlin dates.
 */
export function normalizeEvent(raw, { owner, kind, source, ctx, window }) {
  const sourceKey = `${owner.id}/${source.id}`;
  const title = clip(String(raw.title ?? '').trim(), MAX_TITLE);
  if (!title) return null;
  const tags = (raw.tags ?? []).map((t) => String(t).trim()).filter(Boolean);
  const foldedTitle = fold(title);
  if ((source.exclude ?? []).some((x) => {
    const fx = fold(x);
    return foldedTitle.includes(fx) || tags.some((t) => fold(t).includes(fx));
  })) return null;

  // --- time
  let start;
  let end;
  if (raw.allDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.startDate ?? '')) return null;
    start = raw.startDate;
    end = /^\d{4}-\d{2}-\d{2}$/.test(raw.endDate ?? '') && raw.endDate > start ? raw.endDate : addDays(start, 1);
  } else {
    if (!Number.isFinite(raw.startMs)) return null;
    start = toBerlinIso(raw.startMs);
    end = Number.isFinite(raw.endMs) && raw.endMs > raw.startMs ? toBerlinIso(raw.endMs) : null;
  }
  const firstDay = raw.allDay ? start : berlinDate(raw.startMs);
  const lastDay = raw.allDay ? addDays(end, -1) : end ? berlinDate(raw.endMs - 1) : firstDay;
  if (lastDay < window.from || firstDay >= window.to) return null;

  // --- club and sports
  let club = kind === 'club' ? owner : clubByAlias(ctx, title, raw.location);
  const textForSports = fold([title, ...tags].join(' \n '));
  let sports;
  if (kind === 'club') {
    const candidates = source.sports ?? owner.sports;
    const hits = [...sportsByTags(tags, source.tagMap), ...sportsByKeywords(textForSports, ctx.keywords)].filter((s) => candidates.includes(s));
    sports = candidates.length > 1 && hits.length ? hits : candidates;
  } else {
    sports = [...sportsByTags(tags, source.tagMap), ...sportsByKeywords(textForSports, ctx.keywords)];
    if (!sports.length && club) sports = source.sports ?? club.sports;
    if (!sports.length) sports = source.sports ?? ['sonstiges'];
  }
  sports = uniqueInOrder(sports.filter((s) => ctx.sportIds.has(s)), ctx.order);
  if (!sports.length) sports = ['sonstiges'];

  let description = clip(String(raw.description ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), MAX_DESCRIPTION) || null;
  let url = safeHttpUrl(raw.url) ?? null;
  // A description that is nothing but a link (Google calendars do this) is the event's link.
  if (description && /^https?:\/\/\S+$/.test(description)) {
    url ??= safeHttpUrl(description);
    description = null;
  }
  const location = tidyLocation(raw.location);
  return {
    id: eventId(sourceKey, String(raw.uid), raw.recurrenceId ?? ''),
    club: club ? club.id : null,
    sports,
    title,
    start,
    end,
    allDay: Boolean(raw.allDay),
    location,
    url,
    description,
    source: sourceKey,
    status: raw.status === 'cancelled' ? 'cancelled' : 'confirmed',
  };
}

/** The UTC window an adapter should fetch for `window` (Berlin dates, `to` exclusive). */
export function windowMs(window) {
  return { startMs: berlinMidnight(window.from), endMs: berlinMidnight(window.to) };
}
