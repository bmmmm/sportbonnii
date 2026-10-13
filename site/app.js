// sportbonnii page: loads the generated data, keeps one filter state (mirrored
// in the address hash by state.js), renders the views. DOM via createElement /
// textContent only.
import { loadData } from './data.js';
import { parseHash, formatHash, writeAddress, applyFilters, chipCounts, defaultState } from './state.js';
import { berlinToday, formatCheckedAt } from './dates.js';
import { renderTable, el, PAGE } from './table.js';

const STALE_HOURS = 48;
const $ = (id) => document.getElementById(id);

let data = null;
let ctx = null;
let state = defaultState();
const ui = { sort: { key: 'datum', dir: 1 }, limit: PAGE, allChips: false };

function known() {
  return { sportIds: new Set(data.sports.map((s) => s.id)), clubIds: new Set(data.clubs.map((c) => c.id)) };
}

/** Apply a change, mirror it in the address bar, render. */
function update(patch) {
  const next = { ...state, ...patch };
  if (patch.sport || patch.verein !== undefined || patch.q !== undefined || patch.zeit) ui.limit = PAGE;
  state = next;
  writeAddress(state);
  render();
}

// --- header ------------------------------------------------------------------

function renderHeader() {
  const { meta } = data;
  const checked = $('checked');
  const when = formatCheckedAt(meta.checkedAt);
  checked.replaceChildren(
    el('span', 'checked-label', 'Zuletzt geprüft: '),
    el('time', null, when),
    el('span', 'checked-sources', ` · ${meta.sourcesOk} von ${meta.sourcesTotal} Quellen aktuell`),
  );
  checked.querySelector('time').dateTime = meta.checkedAt;
  const ageHours = (Date.now() - Date.parse(meta.checkedAt)) / 3_600_000;
  const stale = $('stale');
  stale.hidden = !(ageHours > STALE_HOURS);
  if (!stale.hidden) stale.textContent = `Die Termine wurden zuletzt ${when} geprüft – die automatische Aktualisierung hakt gerade. Bitte beim Verein nachsehen, ob ein Termin noch gilt.`;
}

// --- filters -------------------------------------------------------------------

function renderChips(counts) {
  const box = $('sport-chips');
  const chips = [];
  let hidden = 0;
  for (const s of data.sports) {
    const pressed = state.sport.includes(s.id);
    const n = counts.get(s.id) ?? 0;
    // Sports without dates under the current filters fold away behind one button.
    if (!n && !pressed && !ui.allChips) { hidden++; continue; }
    const b = el('button', 'chip');
    b.type = 'button';
    b.dataset.sport = s.id;
    b.setAttribute('aria-pressed', String(pressed));
    b.style.setProperty('--sport', s.colour);
    if (!n && !pressed) b.classList.add('is-empty');
    b.append(el('span', 'emoji', s.emoji), el('span', 'chip-label', s.label), el('span', 'count', String(n)));
    b.setAttribute('aria-label', `${s.label}, ${n} ${n === 1 ? 'Termin' : 'Termine'}`);
    chips.push(b);
  }
  const zero = data.sports.filter((s) => !(counts.get(s.id) ?? 0) && !state.sport.includes(s.id)).length;
  if (hidden || (ui.allChips && zero)) {
    const more = el('button', 'chip-more', ui.allChips ? 'Sportarten ohne Termine ausblenden' : `+ ${hidden} weitere Sportarten`);
    more.type = 'button';
    more.dataset.more = '1';
    more.setAttribute('aria-expanded', String(ui.allChips));
    chips.push(more);
  }
  // Keep focus on the chip a keyboard user just toggled.
  const focused = document.activeElement?.dataset?.sport ?? (document.activeElement?.dataset?.more ? 'more' : null);
  box.replaceChildren(...chips);
  if (focused) box.querySelector(focused === 'more' ? '[data-more]' : `[data-sport="${focused}"]`)?.focus();
  $('sport-clear').hidden = state.sport.length === 0;
}

function clubLabel(c) {
  return c.name;
}

function renderClubField() {
  const input = $('f-club');
  const club = state.verein ? ctx.clubsById.get(state.verein) : null;
  if (document.activeElement !== input) input.value = club ? clubLabel(club) : '';
  $('f-club-clear').hidden = !club;
  input.classList.toggle('is-set', Boolean(club));
}

function renderZeit() {
  for (const b of $('f-zeit').querySelectorAll('[data-zeit]')) b.setAttribute('aria-pressed', String(b.dataset.zeit === state.zeit));
}

function isFiltered() {
  const d = defaultState();
  return state.sport.length > 0 || state.verein !== d.verein || state.q !== d.q || state.zeit !== d.zeit;
}

// --- views ---------------------------------------------------------------------

function emptyState(message) {
  const box = el('div', 'empty');
  box.append(el('p', 'empty-icon', '🏟️'), el('p', 'empty-title', message));
  const hints = el('p', 'empty-actions');
  if (state.zeit !== 'alle') {
    const b = el('button', 'button', 'Zeitraum „Alle“ zeigen');
    b.type = 'button';
    b.addEventListener('click', () => update({ zeit: 'alle' }));
    hints.append(b);
  }
  if (isFiltered()) {
    const b = el('button', 'button button-quiet', 'Filter zurücksetzen');
    b.type = 'button';
    b.addEventListener('click', resetFilters);
    hints.append(b);
  }
  if (hints.childNodes.length) box.append(hints);
  return box;
}

function renderResult(n) {
  const box = $('result');
  box.replaceChildren(el('b', null, n.toLocaleString('de-DE')), document.createTextNode(n === 1 ? ' Termin' : ' Termine'));
}

function render() {
  const visible = applyFilters(data.events, state, ctx);
  renderChips(chipCounts(data.events, state, ctx));
  renderClubField();
  renderZeit();
  renderResult(visible.length);
  $('reset').hidden = !isFiltered();
  renderTable($('table'), visible, {
    ctx,
    sort: ui.sort,
    limit: ui.limit,
    refYear: Number(ctx.today.slice(0, 4)),
    empty: emptyState(state.zeit === 'alle' ? 'Keine kommenden Termine für diese Auswahl.' : 'Keine Termine in diesem Zeitraum.'),
    onSort(key) {
      ui.sort = ui.sort.key === key ? { key, dir: -ui.sort.dir } : { key, dir: 1 };
      render();
      document.querySelector(`#table [data-sort="${key}"]`)?.focus();
    },
    onClub(id) { update({ verein: id }); },
    onMore() { ui.limit += PAGE; render(); },
  });
}

function resetFilters() {
  const d = defaultState();
  update({ sport: d.sport, verein: d.verein, q: d.q, zeit: d.zeit });
  $('f-q').value = '';
}

// --- wiring ----------------------------------------------------------------------

function bind() {
  $('sport-chips').addEventListener('click', (e) => {
    if (e.target.closest('[data-more]')) { ui.allChips = !ui.allChips; render(); return; }
    const b = e.target.closest('[data-sport]');
    if (!b) return;
    const id = b.dataset.sport;
    update({ sport: state.sport.includes(id) ? state.sport.filter((s) => s !== id) : [...state.sport, id] });
  });
  $('sport-clear').addEventListener('click', () => update({ sport: [] }));

  const club = $('f-club');
  const byName = () => new Map(data.clubs.map((c) => [clubLabel(c).toLowerCase(), c.id]));
  club.addEventListener('input', () => {
    const v = club.value.trim().toLowerCase();
    if (v === '') { if (state.verein) update({ verein: '' }); return; }
    const id = byName().get(v);
    if (id && id !== state.verein) update({ verein: id });
  });
  club.addEventListener('change', () => renderClubField());
  club.addEventListener('blur', () => renderClubField());
  $('f-club-clear').addEventListener('click', () => { update({ verein: '' }); club.focus(); });

  const q = $('f-q');
  let timer = null;
  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => update({ q: q.value.trim() }), 150);
  });

  $('f-zeit').addEventListener('click', (e) => {
    const b = e.target.closest('[data-zeit]');
    if (b) update({ zeit: b.dataset.zeit });
  });
  $('reset').addEventListener('click', resetFilters);

  window.addEventListener('hashchange', () => {
    const next = parseHash(location.hash, known());
    if (formatHash(next) === formatHash(state)) return;
    state = next;
    $('f-q').value = state.q;
    render();
  });
}

async function main() {
  try {
    data = await loadData();
  } catch (err) {
    const box = $('load-error');
    box.hidden = false;
    box.textContent = `Die Termine konnten nicht geladen werden (${err.message}). Bitte später noch einmal versuchen.`;
    $('checked').textContent = '';
    return;
  }
  ctx = {
    today: berlinToday(),
    clubsById: new Map(data.clubs.map((c) => [c.id, c])),
    sportsById: new Map(data.sports.map((s) => [s.id, s])),
  };
  const list = $('club-list');
  list.replaceChildren(...data.clubs.filter((c) => c.active !== false).sort((a, b) => a.name.localeCompare(b.name, 'de')).map((c) => {
    const o = el('option');
    o.value = clubLabel(c);
    return o;
  }));
  state = parseHash(location.hash, known());
  writeAddress(state); // normalise a hand-edited or outdated link
  $('f-q').value = state.q;
  renderHeader();
  bind();
  render();
  document.body.classList.add('is-ready');
}

main();
