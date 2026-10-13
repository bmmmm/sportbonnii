// Filter state: the hash codec, the filters, the chip counts. Pure apart from
// writeAddress — the one place on the page that touches the address bar
// (history.replaceState, so filtering never floods the back button).
//
//   #ansicht=kalender&sport=fussball,tennis&verein=bsv-roleber&q=camp&zeit=woche&monat=2026-11
//
// Defaults are left out, unknown values dropped, so every link stays valid
// when the registry changes.
import { overlaps, rangeFor } from './dates.js';

export const VIEWS = ['tabelle', 'kalender', 'vereine'];
export const RANGES = ['alle', 'heute', 'woche', 'monat'];
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_QUERY = 100;

export function defaultState() {
  return { ansicht: 'tabelle', sport: [], verein: '', q: '', zeit: 'alle', monat: '' };
}

const decode = (v) => {
  try {
    return decodeURIComponent(v.replace(/\+/g, ' '));
  } catch {
    return '';
  }
};

/** Hash → state. `known` = { sportIds: Set, clubIds: Set } (omit to skip the id check). */
export function parseHash(hash, known = {}) {
  const state = defaultState();
  const text = String(hash ?? '').replace(/^#/, '');
  for (const pair of text.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = decode(eq === -1 ? pair : pair.slice(0, eq));
    const value = eq === -1 ? '' : decode(pair.slice(eq + 1));
    if (key === 'ansicht' && VIEWS.includes(value)) state.ansicht = value;
    else if (key === 'sport') {
      const ids = value.split(',').map((s) => s.trim()).filter((s) => s && (!known.sportIds || known.sportIds.has(s)));
      state.sport = [...new Set(ids)];
    } else if (key === 'verein' && value && (!known.clubIds || known.clubIds.has(value))) state.verein = value;
    else if (key === 'q') state.q = value.slice(0, MAX_QUERY);
    else if (key === 'zeit' && RANGES.includes(value)) state.zeit = value;
    else if (key === 'monat' && MONTH.test(value)) state.monat = value;
  }
  return state;
}

/** State → hash ('' when everything is default). Commas in the sport list stay readable. */
export function formatHash(state) {
  const d = defaultState();
  const out = [];
  if (state.ansicht !== d.ansicht) out.push(`ansicht=${state.ansicht}`);
  if (state.sport.length) out.push(`sport=${state.sport.map(encodeURIComponent).join(',')}`);
  if (state.verein) out.push(`verein=${encodeURIComponent(state.verein)}`);
  if (state.q) out.push(`q=${encodeURIComponent(state.q)}`);
  if (state.zeit !== d.zeit) out.push(`zeit=${state.zeit}`);
  if (state.monat) out.push(`monat=${state.monat}`);
  return out.length ? `#${out.join('&')}` : '';
}

/** Lowercase without diacritics, ß → ss: "Fußball" and "fussball" match. */
export function fold(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').toLowerCase();
}

/** Searchable text of an event: title, place, club name, sport labels, description. */
function haystack(e, ctx) {
  const club = e.club ? ctx.clubsById.get(e.club)?.name ?? '' : '';
  const sports = e.sports.map((s) => ctx.sportsById.get(s)?.label ?? s).join(' ');
  return fold([e.title, e.location ?? '', club, sports, e.description ?? ''].join(' \n '));
}

const searchCache = new WeakMap();

function matches(e, state, ctx, { skipSport = false, skipTime = false } = {}) {
  if (!skipSport && state.sport.length && !e.sports.some((s) => state.sport.includes(s))) return false;
  if (state.verein && e.club !== state.verein) return false;
  if (state.q) {
    let hay = searchCache.get(e);
    if (hay === undefined) { hay = haystack(e, ctx); searchCache.set(e, hay); }
    const words = fold(state.q).split(/\s+/).filter(Boolean);
    if (!words.every((w) => hay.includes(w))) return false;
  }
  if (!skipTime) {
    const [from, to] = rangeFor(state.zeit, ctx.today);
    if (!overlaps(e, from, to)) return false;
  }
  return true;
}

/**
 * The events the current filters show. ctx = { today, clubsById, sportsById };
 * opts.skipTime for views that bring their own time range (the calendar).
 */
export function applyFilters(events, state, ctx, opts = {}) {
  return events.filter((e) => matches(e, state, ctx, opts));
}

/** Per sport: how many events the view would show with that sport selected — the other filters applied. */
export function chipCounts(events, state, ctx, opts = {}) {
  const counts = new Map();
  for (const e of events) {
    if (!matches(e, state, ctx, { ...opts, skipSport: true })) continue;
    for (const s of e.sports) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return counts;
}

/** The single address-bar writer. */
export function writeAddress(state) {
  const hash = formatHash(state);
  const url = `${location.pathname}${location.search}${hash}`;
  if (`${location.pathname}${location.search}${location.hash}` !== url) history.replaceState(null, '', url);
}
