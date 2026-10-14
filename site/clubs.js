// The club directory: cards grouped by sport (a club with three sports
// appears under each), each with district, website, the state of its
// calendar, its upcoming dates and the two ways in: show them, subscribe.
// Below, every source with its last check. DOM via createElement only.
import { el, sportPills } from './table.js';
import { formatShortDate } from './dates.js';
import { fold } from './state.js';

const TYPE_LABEL = { ical: 'iCalendar', tec: 'The Events Calendar', gancio: 'Gancio', jsonld: 'schema.org', rss: 'RSS + schema.org' };

/**
 * The calendar state of an owner from its sources: { kind, text }.
 * kind: ok | partial | error | none | disabled.
 */
export function calendarState(owner, status, refYear) {
  const sources = owner.sources ?? [];
  if (!sources.length) return { kind: 'none', text: 'Keine Online-Termine' };
  const entries = sources.map((s) => status[`${owner.id}/${s.id}`]).filter(Boolean);
  const live = entries.filter((e) => e.state !== 'disabled');
  if (!live.length) return { kind: 'disabled', text: 'Termine nicht eingebunden' };
  const failing = live.filter((e) => e.state === 'error' || e.state === 'blocked');
  if (failing.length === live.length) {
    const since = failing.map((e) => e.since).sort()[0];
    return { kind: 'error', text: `Abruf scheitert seit ${formatShortDate(since, refYear)}` };
  }
  if (failing.length || live.some((e) => e.state === 'partial')) return { kind: 'partial', text: 'Termine teilweise aktuell' };
  return { kind: 'ok', text: 'Termine aktuell' };
}

const host = (url) => {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
};

function clubCard(club, { ctx, status, upcoming, feedUrl, selected, colour }) {
  const card = el('article', 'club');
  if (selected) card.classList.add('is-selected');
  card.style.setProperty('--sport', colour ?? ctx.sportsById.get(club.sports[0])?.colour ?? '#787878');
  const head = el('div', 'club-head');
  head.append(el('h4', 'club-name', club.name));
  if (club.district) head.append(el('span', 'club-district', club.district));
  card.append(head);
  card.append(sportPills({ sports: club.sports }, ctx));

  const st = calendarState(club, status, Number(ctx.today.slice(0, 4)));
  const facts = el('p', 'club-facts');
  facts.append(el('span', `state state-${st.kind}`, st.text));
  if (st.kind !== 'none' && st.kind !== 'disabled') facts.append(el('span', 'club-count', upcoming === 1 ? '1 kommender Termin' : `${upcoming} kommende Termine`));
  card.append(facts);

  const site = el('a', 'club-site', host(club.website));
  site.href = club.website;
  site.rel = 'noopener';
  card.append(site);

  const actions = el('div', 'club-actions');
  if (upcoming > 0) {
    const show = el('button', 'button', 'Termine');
    show.type = 'button';
    show.dataset.showClub = club.id;
    show.setAttribute('aria-label', `Termine von ${club.name} anzeigen`);
    actions.append(show);
    const sub = el('a', 'button button-quiet', 'Abonnieren');
    sub.href = feedUrl(`verein-${club.id}.ics`, 'webcal');
    sub.title = `Kalender-Abo: ${club.name}`;
    sub.setAttribute('aria-label', `Termine von ${club.name} abonnieren`);
    actions.append(sub);
  }
  if (actions.childNodes.length) card.append(actions);
  return card;
}

function sourcesTable(owners, status, ctx) {
  const table = el('table', 'sources');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['Quelle', 'Art', 'Zustand', 'seit', 'Termine']) {
    const th = el('th', null, h);
    th.scope = 'col';
    hr.append(th);
  }
  thead.append(hr);
  const tbody = el('tbody');
  const refYear = Number(ctx.today.slice(0, 4));
  const words = { ok: 'aktuell', partial: 'teilweise', error: 'Fehler', blocked: 'gesperrt (robots.txt)', disabled: 'nicht eingebunden' };
  for (const o of owners) {
    for (const s of o.sources) {
      const st = status[`${o.id}/${s.id}`];
      const tr = el('tr');
      const name = el('td');
      const a = el('a', null, o.name);
      a.href = o.website;
      a.rel = 'noopener';
      name.append(a);
      const state = el('td');
      state.append(el('span', `state state-${st?.state === 'blocked' ? 'error' : st?.state ?? 'none'}`, words[st?.state] ?? '–'));
      if (st?.error) state.title = st.error;
      tr.append(name, el('td', 'muted', TYPE_LABEL[s.type] ?? s.type), state,
        el('td', 'muted', st ? formatShortDate(st.since, refYear) : '–'), el('td', 'num', st ? String(st.count) : '–'));
      tbody.append(tr);
    }
  }
  table.append(thead, tbody);
  return table;
}

const bound = new WeakMap();

/**
 * opts: { clubs, platforms, status, ctx, upcomingByClub: Map, state, feedUrl(file, scheme), onShowClub(id) }
 */
export function renderClubs(container, opts) {
  let st = bound.get(container);
  if (!st) {
    st = { opts };
    bound.set(container, st);
    container.addEventListener('click', (e) => {
      const b = e.target.closest('[data-show-club]');
      if (b) bound.get(container).opts.onShowClub(b.dataset.showClub);
    });
  }
  st.opts = opts;
  const { clubs, platforms, status, ctx, upcomingByClub, state, feedUrl } = opts;
  const words = fold(state.q).split(/\s+/).filter(Boolean);
  const visible = clubs.filter((c) => c.active !== false)
    .filter((c) => !state.verein || c.id === state.verein)
    .filter((c) => {
      if (!words.length) return true;
      const hay = fold([c.name, ...(c.aliases ?? []), c.district ?? '', ...c.sports.map((s) => ctx.sportsById.get(s)?.label ?? s)].join(' '));
      return words.every((w) => hay.includes(w));
    });
  const sportIds = state.sport.length ? state.sport : [...ctx.sportsById.keys()];
  const groups = [];
  const shownIds = new Set();
  for (const id of sportIds) {
    const sport = ctx.sportsById.get(id);
    const members = visible.filter((c) => c.sports.includes(id)).sort((a, b) => a.name.localeCompare(b.name, 'de'));
    if (!sport || !members.length) continue;
    const group = el('section', 'club-group');
    const h = el('h3', 'club-group-title');
    h.style.setProperty('--sport', sport.colour);
    h.append(el('span', 'emoji', sport.emoji), document.createTextNode(` ${sport.label}`), el('span', 'club-group-count', members.length === 1 ? '1 Verein' : `${members.length} Vereine`));
    const stack = el('div', 'club-stack');
    for (const c of members) {
      stack.append(clubCard(c, { ctx, status, upcoming: upcomingByClub.get(c.id) ?? 0, feedUrl, selected: c.id === state.verein, colour: sport.colour }));
      shownIds.add(c.id);
    }
    group.append(h, stack);
    groups.push(group);
  }
  const parts = [];
  if (groups.length) {
    const grid = el('div', 'club-groups');
    grid.append(...groups);
    parts.push(grid);
  } else {
    const empty = el('div', 'empty');
    empty.append(el('p', 'empty-icon', '🔎'), el('p', 'empty-title', 'Kein Verein passt zu dieser Auswahl.'));
    parts.push(empty);
  }
  const shown = shownIds.size;

  const more = el('section', 'club-extra');
  const suggest = el('p', 'club-suggest');
  const a = el('a', 'button', 'Verein vorschlagen');
  a.href = 'https://github.com/bmmmm/sportbonnii/issues/new?template=verein-hinzufuegen.yml';
  suggest.append(el('span', null, 'Euer Verein fehlt oder veröffentlicht einen Kalender, den wir noch nicht kennen? '), a);
  more.append(suggest);
  const srcHead = el('h3', 'sources-title', 'Quellen und ihr Zustand');
  srcHead.id = 'quellen';
  more.append(srcHead, el('p', 'muted sources-note', 'Jede Quelle wird viermal täglich abgerufen. Fällt eine aus, bleiben ihre letzten Termine bis zu sieben Tage stehen.'));
  const wrap = el('div', 'sources-wrap');
  wrap.append(sourcesTable([...clubs, ...platforms], status, ctx));
  more.append(wrap);
  parts.push(more);
  container.replaceChildren(...parts);
  return shown;
}
