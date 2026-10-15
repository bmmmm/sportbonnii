// The table view: a sortable table on wide screens, day-grouped cards below
// 640 px (both rendered, CSS picks one). DOM via createElement/textContent
// only — every string here is foreign feed text. Every title opens a detail
// row (a title with its own link gets a „Details“ button next to it); a place
// that is one of the club's venues opens the map there.
import { eventDays, formatShortDate, formatLongDate, formatTime, formatSpan, addDays } from './dates.js';
import { KINDS } from './kinds.js';
import { eventVenue } from './venue.js';

export const PAGE = 200;
export const COLUMNS = [
  { key: 'datum', label: 'Datum' },
  { key: 'zeit', label: 'Zeit', sortable: false },
  { key: 'sport', label: 'Sport' },
  { key: 'verein', label: 'Verein' },
  { key: 'titel', label: 'Termin' },
  { key: 'ort', label: 'Ort' },
];

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

const collator = new Intl.Collator('de', { sensitivity: 'base', numeric: true });
// A badge for matches and trainings; an event is the plain case and carries none.
const KIND_BADGE = new Map(KINDS.filter((k) => k.id !== 'veranstaltung').map((k) => [k.id, k.short]));

/** Comparator for a column; ties fall back to the date order of events.json. */
export function sorter(key, ctx) {
  const name = (e) => (e.club ? ctx.clubsById.get(e.club)?.name ?? '' : '');
  const sport = (e) => ctx.sportsById.get(e.sports[0])?.label ?? '';
  const by = {
    sport: (a, b) => collator.compare(sport(a), sport(b)),
    verein: (a, b) => (!a.club - !b.club) || collator.compare(name(a), name(b)),
    titel: (a, b) => collator.compare(a.title, b.title),
    ort: (a, b) => (!a.location - !b.location) || collator.compare(a.location ?? '', b.location ?? ''),
  }[key];
  return by ?? null;
}

/** Sorted copy; `dir` 1 ascending, -1 descending; 'datum' keeps the data order (by start). */
export function sortEvents(events, { key, dir }, ctx) {
  const indexed = events.map((e, i) => [e, i]);
  const cmp = sorter(key, ctx);
  indexed.sort(([a, ia], [b, ib]) => (cmp ? cmp(a, b) * dir || ia - ib : (ia - ib) * dir));
  return indexed.map(([e]) => e);
}

/** A toggle for an event's detail row. */
function detailButton(e, open, className, text) {
  const b = el('button', className, text);
  b.type = 'button';
  b.dataset.detail = e.id;
  b.setAttribute('aria-expanded', String(open));
  return b;
}

/**
 * The title: the event's own link when it has one, else plain text. `detail`
 * ({ open }) makes it interactive: a title without link becomes the toggle of
 * the detail row, one with a link gets a „Details“ button beside it.
 */
function titleNode(e, detail = null) {
  const wrap = el('span', 'title-wrap');
  const text = e.status === 'cancelled' ? el('s', null, e.title) : document.createTextNode(e.title);
  if (detail && !e.url) {
    const b = detailButton(e, detail.open, 'title title-button');
    b.append(text);
    wrap.append(b);
  } else if (e.url) {
    const a = el('a', 'title');
    a.href = e.url;
    a.rel = 'noopener';
    a.append(text, el('span', 'ext', '\u00a0↗'));
    a.title = `Zur Quelle: ${new URL(e.url).host}`;
    wrap.append(a);
  } else {
    const span = el('span', 'title');
    span.append(text);
    wrap.append(span);
  }
  if (KIND_BADGE.has(e.kind)) wrap.append(el('span', `badge badge-kind badge-${e.kind}`, KIND_BADGE.get(e.kind)));
  if (e.status === 'cancelled') wrap.append(el('span', 'badge badge-cancelled', 'Abgesagt'));
  if (detail && e.url) wrap.append(detailButton(e, detail.open, 'link-button detail-toggle', 'Details'));
  return wrap;
}

/** Sport pills: colour bar, emoji, label. Colour via CSSOM (CSP-safe). */
export function sportPills(e, ctx, { compact = false } = {}) {
  const box = el('span', 'sport-pills');
  for (const id of e.sports) {
    const s = ctx.sportsById.get(id);
    const pill = el('span', 'sport-pill');
    pill.style.setProperty('--sport', s?.colour ?? '#787878');
    pill.append(el('span', 'emoji', s?.emoji ?? '🏅'));
    pill.append(el('span', compact ? 'visually-hidden' : 'label', s?.label ?? id));
    pill.title = s?.label ?? id;
    box.append(pill);
  }
  return box;
}

/**
 * The place without a leading part that only repeats the club ("Rugby Club
 * Bonn-Rhein-Sieg e.V., Martin-Luther-King-Straße 22, …" under that club).
 */
export function placeText(e, ctx) {
  if (!e.location) return '';
  const club = e.club ? ctx.clubsById.get(e.club) : null;
  if (!club) return e.location;
  const norm = (t) => t.toLowerCase().replace(/\s*e\.\s?v\.?$/, '').trim();
  const names = new Set([club.name, ...(club.aliases ?? [])].map(norm));
  const parts = e.location.split(/\s*,\s*/);
  return parts.length > 1 && names.has(norm(parts[0])) ? parts.slice(1).join(', ') : e.location;
}

/** The map place of an event: '<club>/<venue index>' when it is one of its club's venues, else null. */
export function placeId(e, ctx) {
  const club = e.club ? ctx.clubsById.get(e.club) : null;
  const i = club ? eventVenue(e, club) : -1;
  return i === -1 ? null : `${club.id}/${i}`;
}

/** The place as text, or — `interactive` and a club venue — a button that opens the map there. */
function placeNode(e, ctx, interactive, text = placeText(e, ctx)) {
  const id = interactive && text ? placeId(e, ctx) : null;
  if (!id) return document.createTextNode(text);
  const b = el('button', 'link-button place-link', text);
  b.type = 'button';
  b.dataset.place = id;
  b.title = 'Auf der Karte zeigen';
  return b;
}

/** The detail of one event: when, where, who, what, from where, and the one-event .ics. */
function detailNode(e, ctx, refYear) {
  const box = el('div', 'detail');
  const list = el('dl', 'detail-list');
  const row = (term, ...nodes) => {
    const dd = el('dd');
    dd.append(...nodes);
    list.append(el('dt', null, term), dd);
  };
  const [first] = eventDays(e);
  const span = formatSpan(e, refYear);
  row('Wann', `${formatLongDate(first)}, ${formatTime(e)}${span ? ` (${span})` : ''}`);
  const id = placeId(e, ctx);
  const place = placeText(e, ctx) || (id ? ctx.clubsById.get(e.club).venues[Number(id.split('/')[1])].name : '');
  if (place) row('Ort', placeNode(e, ctx, true, place));
  if (e.club) row('Verein', clubNode(e, ctx));
  row(e.sports.length === 1 ? 'Sportart' : 'Sportarten', e.sports.map((s) => ctx.sportsById.get(s)?.label ?? s).join(', '));
  if (e.description) row('Beschreibung', el('span', 'detail-desc', e.description));
  const owner = e.source.split('/')[0];
  row('Quelle', ctx.clubsById.get(owner)?.name ?? ctx.platformsById?.get(owner)?.name ?? owner);
  box.append(list);
  const ics = el('button', 'button button-quiet', 'In meinen Kalender (.ics)');
  ics.type = 'button';
  ics.dataset.ics = e.id;
  box.append(ics);
  return box;
}

function clubNode(e, ctx) {
  if (!e.club) return el('span', 'muted', '–');
  const club = ctx.clubsById.get(e.club);
  const b = el('button', 'club-link', club?.name ?? e.club);
  b.type = 'button';
  b.dataset.club = e.club;
  b.title = `Nur ${club?.name ?? e.club} zeigen`;
  return b;
}

function headerRow(sort, columns) {
  const tr = el('tr');
  for (const col of columns) {
    const th = el('th');
    th.scope = 'col';
    th.className = `col-${col.key}`;
    if (col.sortable === false) {
      th.textContent = col.label;
    } else {
      const active = sort.key === col.key;
      th.setAttribute('aria-sort', active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none');
      const b = el('button', 'sort', col.label);
      b.type = 'button';
      b.dataset.sort = col.key;
      b.append(el('span', 'sort-mark', active ? (sort.dir === 1 ? '▲' : '▼') : '↕'));
      th.append(b);
    }
    tr.append(th);
  }
  return tr;
}

/** 'Heute' / 'Morgen' for those days, else null. */
export function relativeDay(date, today) {
  if (date === today) return 'Heute';
  if (date === addDays(today, 1)) return 'Morgen';
  return null;
}

function tableRow(e, ctx, { showDate, refYear, withPlace, detail }) {
  const tr = el('tr');
  if (e.status === 'cancelled') tr.classList.add('is-cancelled');
  const [first] = eventDays(e);
  const date = el('td', 'col-datum');
  if (showDate) {
    const rel = relativeDay(first, ctx.today);
    if (rel) date.append(el('span', 'rel', rel));
    date.append(el('span', 'date', formatShortDate(first, refYear)));
    tr.classList.add('day-start');
  }
  const time = el('td', 'col-zeit');
  time.append(el('span', 'time', formatTime(e)));
  const span = formatSpan(e, refYear);
  if (span) time.append(el('span', 'span', span));
  tr.append(date, time);
  const sport = el('td', 'col-sport');
  sport.append(sportPills(e, ctx));
  const club = el('td', 'col-verein');
  club.append(clubNode(e, ctx));
  const title = el('td', 'col-titel');
  title.append(titleNode(e, detail));
  if (e.description) title.append(el('span', 'desc', e.description));
  tr.append(sport, club, title);
  if (withPlace) {
    const place = el('td', 'col-ort');
    place.append(placeNode(e, ctx, Boolean(detail)));
    tr.append(place);
  }
  return tr;
}

/** A card; `detail` ({ open }) makes title and place interactive, as in the table. */
export function card(e, ctx, refYear, detail = null) {
  const li = el('li', 'card');
  if (e.status === 'cancelled') li.classList.add('is-cancelled');
  li.style.setProperty('--sport', ctx.sportsById.get(e.sports[0])?.colour ?? '#787878');
  const time = el('div', 'card-time');
  const [first, last] = eventDays(e);
  if (e.allDay || !e.end || first !== last) time.append(el('span', 'time', formatTime(e)));
  else time.append(el('span', 'time', e.start.slice(11, 16)), el('span', 'until', `bis ${e.end.slice(11, 16)}`));
  const body = el('div', 'card-body');
  body.append(titleNode(e, detail));
  const meta = el('div', 'card-meta');
  meta.append(sportPills(e, ctx));
  if (e.club) meta.append(clubNode(e, ctx));
  body.append(meta);
  const span = formatSpan(e, refYear);
  const place = placeText(e, ctx);
  if (span || place) {
    const where = el('div', 'card-place', span);
    if (span && place) where.append(document.createTextNode(' · '));
    if (place) where.append(placeNode(e, ctx, Boolean(detail), place));
    body.append(where);
  }
  if (detail?.open) body.append(detailNode(e, ctx, refYear));
  li.append(time, body);
  return li;
}

const bound = new WeakMap();

function onClick(ev) {
  const st = bound.get(ev.currentTarget);
  const sortBtn = ev.target.closest('[data-sort]');
  if (sortBtn) { st.opts.onSort(sortBtn.dataset.sort); return; }
  const club = ev.target.closest('[data-club]');
  if (club) { st.opts.onClub(club.dataset.club); return; }
  const detail = ev.target.closest('[data-detail]');
  if (detail) { st.opts.onDetail(detail.dataset.detail); return; }
  const ics = ev.target.closest('[data-ics]');
  if (ics) { st.opts.onIcs(ics.dataset.ics); return; }
  const place = ev.target.closest('[data-place]');
  if (place) { st.opts.onPlace(place.dataset.place); return; }
  if (ev.target.closest('[data-more]')) st.opts.onMore();
}

/**
 * opts: { ctx, sort: {key, dir}, limit, refYear, empty: Node, detail: id | null,
 *   onSort(key), onClub(id), onDetail(id), onIcs(id), onPlace(placeId), onMore() }
 */
export function renderTable(container, events, opts) {
  let st = bound.get(container);
  if (!st) {
    st = { opts };
    bound.set(container, st);
    container.addEventListener('click', onClick);
  }
  st.opts = opts;
  const { ctx, sort, limit, refYear } = opts;
  // The toggle a keyboard user just pressed keeps the focus across the rebuild (in the table or the cards, whichever shows).
  const focusDetail = container.contains(document.activeElement) ? document.activeElement.dataset?.detail : undefined;
  if (!events.length) {
    container.replaceChildren(opts.empty);
    return;
  }
  const sorted = sortEvents(events, sort, ctx);
  const shown = sorted.slice(0, limit);
  const byDate = sort.key === 'datum';

  // A column nobody fills only costs width.
  const withPlace = shown.some((e) => placeText(e, ctx));
  const columns = withPlace ? COLUMNS : COLUMNS.filter((c) => c.key !== 'ort');
  const table = el('table', 'events');
  if (!withPlace) table.classList.add('no-place');
  const thead = el('thead');
  thead.append(headerRow(sort, columns));
  const tbody = el('tbody');
  let lastDay = null;
  for (const e of shown) {
    const day = eventDays(e)[0];
    const open = e.id === opts.detail;
    tbody.append(tableRow(e, ctx, { showDate: !byDate || day !== lastDay, refYear, withPlace, detail: { open } }));
    if (open) {
      const tr = el('tr', 'detail-row');
      const td = el('td');
      td.colSpan = columns.length;
      td.append(detailNode(e, ctx, refYear));
      tr.append(td);
      tbody.append(tr);
    }
    lastDay = day;
  }
  table.append(thead, tbody);
  const wrap = el('div', 'table-wrap');
  wrap.append(table);

  // Cards: always grouped by day in date order (sorting is a wide-screen tool).
  const cards = el('div', 'cards');
  const dateOrder = byDate ? shown : sortEvents(events, { key: 'datum', dir: 1 }, ctx).slice(0, limit);
  let list = null;
  lastDay = null;
  for (const e of dateOrder) {
    const day = eventDays(e)[0];
    if (day !== lastDay) {
      const h = el('h3', 'day-heading');
      const rel = relativeDay(day, ctx.today);
      if (rel) h.append(el('span', 'rel', rel));
      h.append(document.createTextNode(formatLongDate(day)));
      cards.append(h);
      list = el('ul', 'card-list');
      cards.append(list);
      lastDay = day;
    }
    list.append(card(e, ctx, refYear, { open: e.id === opts.detail }));
  }

  const parts = [wrap, cards];
  if (sorted.length > limit) {
    const more = el('button', 'more', `Weitere ${Math.min(PAGE, sorted.length - limit)} anzeigen`);
    more.type = 'button';
    more.dataset.more = '1';
    const note = el('p', 'more-note', `${limit} von ${sorted.length} Terminen angezeigt`);
    const box = el('div', 'more-box');
    box.append(note, more);
    parts.push(box);
  }
  container.replaceChildren(...parts);
  if (focusDetail) [...container.querySelectorAll('[data-detail]')].find((b) => b.dataset.detail === focusDetail && b.getClientRects().length)?.focus();
}
