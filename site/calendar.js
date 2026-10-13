// Month calendar. monthGrid is calqrii's (calendar.js, verbatim); the
// renderer grew event chips (≤ 3 per day, then "+N"), multi-day spans and a
// list under the grid: the selected day, else the whole month as an agenda —
// below 640 px the grid shrinks to dots and the agenda carries the month.
// DOM via createElement/textContent only; sport colours through the CSSOM.
import { eventDays, addDays, formatLongDate, formatMonth, monthOf, WEEKDAYS_SHORT, WEEKDAYS } from './dates.js';
import { el, card } from './table.js';

export const MAX_CHIPS = 3;

function pad(n) {
  return String(n).padStart(2, '0');
}

function iso(d) {
  // Four-digit year: typing a year into a date field passes through 0202, which must stay a readable ISO date.
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 6 rows × 7 cells of { date, inMonth }; month is 1-based, weekStart 1 = Monday. */
export function monthGrid(year, month, weekStart = 1) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (first.getUTCDay() + 7 - weekStart) % 7;
  const rows = [];
  for (let r = 0; r < 6; r++) {
    const row = [];
    for (let c = 0; c < 7; c++) {
      const d = new Date(Date.UTC(year, month - 1, 1 - offset + r * 7 + c));
      row.push({ date: iso(d), inMonth: d.getUTCMonth() === month - 1 });
    }
    rows.push(row);
  }
  return rows;
}

/** date → events touching it (start order kept), for the dates in `days`. */
export function eventsByDay(events, days) {
  const wanted = new Set(days);
  const map = new Map(days.map((d) => [d, []]));
  for (const e of events) {
    const [first, last] = eventDays(e);
    for (let d = first; d <= last; d = addDays(d, 1)) {
      if (wanted.has(d)) map.get(d).push(e);
      if (d > days[days.length - 1]) break;
    }
  }
  return map;
}

/** Events touching the month 'YYYY-MM'. */
export function eventsInMonth(events, ym) {
  const from = `${ym}-01`;
  const to = `${ym}-31`;
  return events.filter((e) => {
    const [first, last] = eventDays(e);
    return last >= from && first <= to;
  });
}

const bound = new WeakMap();
const KEY_DELTA = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

function onClick(e) {
  const st = bound.get(e.currentTarget);
  const nav = e.target.closest('[data-nav]');
  if (nav) { if (!nav.disabled) st.opts.onNavigate(nav.dataset.nav); return; }
  const day = e.target.closest('[data-date]');
  if (day) { st.opts.onSelect(day.dataset.date); return; }
  if (e.target.closest('[data-month-list]')) { st.opts.onSelect(null); return; }
  const club = e.target.closest('[data-club]');
  if (club) st.opts.onClub(club.dataset.club);
}

function onKey(e) {
  const day = e.target.closest('[data-date]');
  const delta = KEY_DELTA[e.key];
  if (!day || delta === undefined) return;
  e.preventDefault();
  const target = addDays(day.dataset.date, delta);
  const container = e.currentTarget;
  const next = container.querySelector(`.cal-grid [data-date="${target}"]`);
  if (next) {
    day.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  } else {
    bound.get(container).opts.onNavigate(monthOf(target), target);
  }
}

function chip(e, day, ctx) {
  const [first, last] = eventDays(e);
  const c = el('span', 'cal-ev');
  c.style.setProperty('--sport', ctx.sportsById.get(e.sports[0])?.colour ?? '#787878');
  if (first !== last) {
    c.classList.add('is-span');
    if (day !== first) c.classList.add('cont-left');
    if (day !== last) c.classList.add('cont-right');
  }
  if (e.status === 'cancelled') c.classList.add('is-cancelled');
  const time = e.allDay || day !== first ? '' : e.start.slice(11, 16);
  if (time) c.append(el('span', 'cal-ev-time', time));
  c.append(el('span', 'cal-ev-title', e.title));
  return c;
}

/**
 * opts: { ym 'YYYY-MM', events (filtered, all months), ctx, selected 'YYYY-MM-DD'|null,
 *   minMonth, maxMonth, focus, onNavigate(ym, focusDate?), onSelect(date|null), onClub(id) }
 */
export function renderCalendar(container, opts) {
  let st = bound.get(container);
  if (!st) {
    st = { opts };
    bound.set(container, st);
    container.addEventListener('click', onClick);
    container.addEventListener('keydown', onKey);
  }
  st.opts = opts;
  const { ym, events, ctx, selected, minMonth, maxMonth, focus } = opts;
  const [year, month] = ym.split('-').map(Number);
  const grid = monthGrid(year, month);
  const days = grid.flat().map((c) => c.date);
  const byDay = eventsByDay(events, days);
  const active = document.activeElement;
  const refocus = focus ? `[data-date="${focus}"]`
    : container.contains(active) && active.dataset.date ? `[data-date="${active.dataset.date}"]`
      : container.contains(active) && active.dataset.nav ? `[data-nav="${active.dataset.nav}"]` : null;

  // --- navigation
  const nav = el('div', 'cal-nav');
  const prev = el('button', 'cal-step', '‹');
  prev.type = 'button';
  prev.dataset.nav = ymShift(ym, -1);
  prev.setAttribute('aria-label', `Vorheriger Monat: ${formatMonth(prev.dataset.nav)}`);
  prev.disabled = ym <= minMonth;
  const next = el('button', 'cal-step', '›');
  next.type = 'button';
  next.dataset.nav = ymShift(ym, 1);
  next.setAttribute('aria-label', `Nächster Monat: ${formatMonth(next.dataset.nav)}`);
  next.disabled = ym >= maxMonth;
  const title = el('h2', 'cal-title', formatMonth(ym));
  title.setAttribute('aria-live', 'polite');
  const todayBtn = el('button', 'button button-quiet cal-today', 'Heute');
  todayBtn.type = 'button';
  todayBtn.dataset.nav = monthOf(ctx.today);
  todayBtn.disabled = ym === monthOf(ctx.today);
  nav.append(prev, title, next, todayBtn);

  // --- grid
  const table = el('table', 'cal-grid');
  table.setAttribute('role', 'grid');
  table.setAttribute('aria-label', `Kalender ${formatMonth(ym)}`);
  const thead = el('thead');
  const hrow = el('tr');
  WEEKDAYS_SHORT.forEach((name, i) => {
    const th = el('th', i >= 5 ? 'weekend' : undefined);
    th.scope = 'col';
    th.append(el('span', null, name));
    th.title = WEEKDAYS[i];
    hrow.append(th);
  });
  thead.append(hrow);
  const tbody = el('tbody');
  const inGrid = (d) => days.includes(d);
  const tabDate = focus && inGrid(focus) ? focus
    : selected && inGrid(selected) ? selected
      : inGrid(ctx.today) && monthOf(ctx.today) === ym ? ctx.today : `${ym}-01`;
  for (const row of grid) {
    const tr = el('tr');
    for (const cell of row) {
      const td = el('td');
      const list = byDay.get(cell.date);
      const b = el('button', 'cal-day');
      b.type = 'button';
      b.dataset.date = cell.date;
      b.tabIndex = cell.date === tabDate ? 0 : -1;
      if (!cell.inMonth) b.classList.add('out');
      if (cell.date === ctx.today) b.classList.add('today');
      if (cell.date < ctx.today) b.classList.add('past');
      if (cell.date === selected) b.classList.add('selected');
      if (list.length) b.classList.add('has-events');
      b.setAttribute('aria-pressed', String(cell.date === selected));
      b.setAttribute('aria-label', `${formatLongDate(cell.date)}${cell.date === ctx.today ? ' (heute)' : ''}: ${list.length ? `${list.length} ${list.length === 1 ? 'Termin' : 'Termine'}` : 'keine Termine'}`);
      b.append(el('span', 'cal-num', String(Number(cell.date.slice(8)))));
      if (list.length) {
        const chips = el('span', 'cal-evs');
        chips.setAttribute('aria-hidden', 'true');
        for (const e of list.slice(0, MAX_CHIPS)) chips.append(chip(e, cell.date, ctx));
        if (list.length > MAX_CHIPS) chips.append(el('span', 'cal-more', `+${list.length - MAX_CHIPS} weitere`));
        const dots = el('span', 'cal-dots');
        dots.setAttribute('aria-hidden', 'true');
        for (const id of [...new Set(list.flatMap((e) => e.sports))].slice(0, 4)) {
          const dot = el('span', 'cal-dot');
          dot.style.setProperty('--sport', ctx.sportsById.get(id)?.colour ?? '#787878');
          dots.append(dot);
        }
        b.append(chips, dots);
      }
      td.append(b);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);

  // --- list under the grid: the selected day, else the month
  const listBox = el('div', 'cal-list');
  const monthEvents = eventsInMonth(events, ym);
  const head = el('div', 'cal-list-head');
  if (selected) {
    const dayEvents = byDay.get(selected) ?? eventsByDay(events, [selected]).get(selected);
    head.append(el('h3', 'cal-list-title', formatLongDate(selected)), el('span', 'cal-list-count', count(dayEvents.length)));
    const all = el('button', 'link-button', `Ganzen ${formatMonth(ym).split(' ')[0]} zeigen`);
    all.type = 'button';
    all.dataset.monthList = '1';
    head.append(all);
    listBox.append(head, dayEvents.length ? agenda(dayEvents, ctx, { single: selected }) : el('p', 'cal-none', 'An diesem Tag stehen keine Termine an.'));
  } else {
    head.append(el('h3', 'cal-list-title', `Termine im ${formatMonth(ym).split(' ')[0]}`), el('span', 'cal-list-count', count(monthEvents.length)));
    listBox.append(head, monthEvents.length ? agenda(monthEvents, ctx, { ym }) : el('p', 'cal-none', 'In diesem Monat stehen für diese Auswahl keine Termine an.'));
  }

  container.replaceChildren(nav, el('div', 'cal-grid-wrap'), listBox);
  container.querySelector('.cal-grid-wrap').append(table);
  const target = refocus ? container.querySelector(refocus) : null;
  if (target && !target.disabled) {
    if (target.dataset.date) {
      for (const b of container.querySelectorAll('.cal-day')) b.tabIndex = -1;
      target.tabIndex = 0;
    }
    target.focus();
  }
}

const count = (n) => (n === 1 ? '1 Termin' : `${n} Termine`);

function ymShift(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/** Day-grouped cards; a multi-day event is listed on its first day (in the month: on the 1st if it began earlier). */
function agenda(events, ctx, { single, ym } = {}) {
  const box = el('div', 'agenda');
  const groups = new Map();
  for (const e of events) {
    let day = single ?? eventDays(e)[0];
    if (ym && day < `${ym}-01`) day = `${ym}-01`;
    (groups.get(day) ?? groups.set(day, []).get(day)).push(e);
  }
  for (const day of [...groups.keys()].sort()) {
    if (!single) {
      const h = el('h4', 'day-heading');
      h.id = `tag-${day}`;
      if (day === ctx.today) h.append(el('span', 'rel', 'Heute'));
      h.append(document.createTextNode(formatLongDate(day)));
      box.append(h);
    }
    const ul = el('ul', 'card-list');
    for (const e of groups.get(day)) ul.append(card(e, ctx, Number(ctx.today.slice(0, 4))));
    box.append(ul);
  }
  return box;
}
