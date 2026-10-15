// sportbonnii page: loads the generated data, keeps one filter state (mirrored
// in the address hash by state.js; the visitor's filter choices also in store.js),
// renders the views. DOM via createElement / textContent only.
import { loadData } from './data.js';
import { parseHash, formatHash, writeAddress, applyFilters, chipCounts, kindCounts, defaultState, fold, subscription } from './state.js';
import { loadChoices, remember } from './store.js';
import { berlinToday, formatCheckedAt, monthOf, addDays, formatMonth } from './dates.js';
import { renderTable, el, PAGE } from './table.js';
import { renderCalendar, eventsInMonth } from './calendar.js';
import { renderClubs } from './clubs.js';
import { renderMapView } from './map.js';
import { serializeFeed } from './ics.js';
import { KINDS } from './kinds.js';

const STALE_HOURS = 48;
const MAX_QUERY = 100;
const $ = (id) => document.getElementById(id);

let data = null;
let ctx = null;
let state = defaultState();
const freshUi = () => ({ sort: { key: 'datum', dir: 1 }, limit: PAGE, allChips: false, day: null, focusDay: null, place: null, detail: null });
const ui = freshUi();
const VIEW_IDS = ['tabelle', 'kalender', 'karte', 'vereine'];

function known() {
  return { sportIds: new Set(data.sports.map((s) => s.id)), clubIds: new Set(data.clubs.map((c) => c.id)) };
}

/** Apply a change, mirror it in the address bar (`push`: as a new history entry), render. */
function update(patch, { push = false } = {}) {
  const next = { ...state, ...patch };
  next.q = next.q.slice(0, MAX_QUERY); // the hash keeps no more, so neither may the view
  if (patch.sport || patch.art || patch.ort || patch.verein !== undefined || patch.q !== undefined || patch.zeit) ui.limit = PAGE;
  if (patch.monat !== undefined && patch.monat !== state.monat) ui.day = null;
  state = next;
  writeAddress(state, { push });
  render();
}

/** A filter the visitor chose (not a shortcut such as a club link): applied, and kept for the next visit. */
function choose(patch) {
  update(patch);
  remember(patch);
}

// --- header ------------------------------------------------------------------

function renderHeader() {
  const { meta } = data;
  const checked = $('checked');
  const when = formatCheckedAt(meta.checkedAt);
  checked.replaceChildren(
    el('span', 'checked-label', 'Zuletzt geprüft: '),
    el('time', null, when),
    // The visible separator is a CSS rule; screen readers and copy get the comma.
    el('span', 'visually-hidden', ', '),
    el('span', 'checked-sources', `${meta.sourcesOk} von ${meta.sourcesTotal} Quellen aktuell`),
  );
  checked.querySelector('time').dateTime = meta.checkedAt;
  const ageHours = (Date.now() - Date.parse(meta.checkedAt)) / 3_600_000;
  const stale = $('stale');
  const noneOk = meta.sourcesTotal > 0 && meta.sourcesOk === 0;
  stale.hidden = !(ageHours > STALE_HOURS) && !noneOk;
  if (ageHours > STALE_HOURS) stale.textContent = `Die Termine wurden zuletzt ${when} geprüft – die automatische Aktualisierung hakt gerade. Bitte beim Verein nachsehen, ob ein Termin noch gilt.`;
  else if (noneOk) stale.textContent = 'Beim letzten Abruf hat keine Quelle geantwortet – angezeigt werden die zuletzt bekannten Termine. Bitte beim Verein nachsehen, ob ein Termin noch gilt.';
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

/** The kind chips: always all three, with the count each would show. */
function renderKindChips(counts) {
  const box = $('kind-chips');
  const chips = KINDS.map((k) => {
    const pressed = state.art.includes(k.id);
    const n = counts.get(k.id) ?? 0;
    const b = el('button', `chip chip-kind chip-${k.id}`);
    b.type = 'button';
    b.dataset.kind = k.id;
    b.setAttribute('aria-pressed', String(pressed));
    if (!n && !pressed) b.classList.add('is-empty');
    b.append(el('span', 'emoji', k.emoji), el('span', 'chip-label', k.label), el('span', 'count', String(n)));
    b.setAttribute('aria-label', `${k.label}, ${n} ${n === 1 ? 'Termin' : 'Termine'}`);
    return b;
  });
  const focused = document.activeElement?.dataset?.kind;
  box.replaceChildren(...chips);
  if (focused) box.querySelector(`[data-kind="${focused}"]`)?.focus();
  $('kind-clear').hidden = state.art.length === 0;
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

/** Home/away only concerns games: shown while games are among the kinds. */
const showsGames = () => !state.art.length || state.art.includes('spiel');

function renderOrt() {
  for (const b of $('f-ort').querySelectorAll('[data-ort]')) b.setAttribute('aria-pressed', String(b.dataset.ort === state.ort));
}

function isFiltered() {
  const d = defaultState();
  // The range only acts on the table and the map, the kind not on the clubs; where hidden they must not count.
  const zeit = (state.ansicht === 'tabelle' || state.ansicht === 'karte') && state.zeit !== d.zeit;
  const art = state.ansicht !== 'vereine' && state.art.join() !== d.art.join();
  const ort = state.ansicht !== 'vereine' && showsGames() && state.ort !== d.ort;
  return state.sport.length > 0 || state.verein !== d.verein || state.q !== d.q || zeit || art || ort;
}

// --- views ---------------------------------------------------------------------

/** No filter but the club: every kind, both sides, no sport, search or range. */
const UNFILTERED = { sport: [], art: [], ort: 'alle', q: '', zeit: 'alle' };

/** Every date of a club (or, without one, of all clubs), whatever the filters said; from the directory or the map in the table. */
function showUnfiltered(verein = state.verein) {
  const ansicht = state.ansicht === 'kalender' ? 'kalender' : 'tabelle';
  const switching = ansicht !== state.ansicht;
  update({ ...UNFILTERED, verein, ansicht });
  $('f-q').value = '';
  // The view is rebuilt under the clicked button: focus lands on the tab, or on the count that now heads it.
  $(switching ? `tab-${ansicht}` : 'result').focus();
}

function emptyState(message) {
  const box = el('div', 'empty');
  box.append(el('p', 'empty-icon', '🏟️'), el('p', 'empty-title', message));
  // A feed nothing of which fits the filters (or which they misjudge) is never hidden without a word and a way back.
  const all = applyFilters(data.events, { ...defaultState(), ...UNFILTERED, verein: state.verein }, ctx).length;
  if (all) box.append(el('p', 'empty-hidden', all === 1 ? '1 Termin ist durch Filter ausgeblendet.' : `${all} Termine sind durch Filter ausgeblendet.`));
  const hints = el('p', 'empty-actions');
  if (all) {
    const name = state.verein ? ctx.clubsById.get(state.verein)?.name : null;
    const what = all === 1 ? '1 Termin' : `Alle ${all} Termine`;
    const b = el('button', 'button', name ? `${what} von ${name} zeigen` : `${what} zeigen`);
    b.type = 'button';
    b.dataset.unfiltered = '1';
    b.addEventListener('click', () => showUnfiltered());
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

function renderResult(n, suffix = '') {
  const box = $('result');
  box.replaceChildren(el('b', null, n.toLocaleString('de-DE')), document.createTextNode(`${n === 1 ? ' Termin' : ' Termine'}${suffix}`));
}

/** The calendar month on screen: the hash's, else this month, clamped to the data window. */
function shownMonth() {
  const min = monthOf(data.window.from);
  const max = monthOf(addDays(data.window.to, -1));
  const ym = state.monat || monthOf(ctx.today);
  return ym < min ? min : ym > max ? max : ym;
}

function renderTabs() {
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const on = tab.dataset.view === state.ansicht;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`view-${tab.dataset.view}`).hidden = !on;
  }
  // The quick ranges belong to the list and the map; the calendar brings its own month.
  $('zeit-field').hidden = state.ansicht !== 'tabelle' && state.ansicht !== 'karte';
  // Clubs have no kind.
  $('kind-field').hidden = state.ansicht === 'vereine';
  $('ort-field').hidden = !showsGames();
}

function render() {
  ctx.today = berlinToday(); // a tab left open past midnight moves on to the new day
  renderTabs();
  renderClubField();
  renderZeit();
  renderOrt();
  $('reset').hidden = !isFiltered();
  if (state.ansicht === 'kalender') renderCalendarView();
  else if (state.ansicht === 'vereine') renderClubsView();
  else if (state.ansicht === 'karte') renderMap();
  else renderTableView();
  renderActions();
}

// --- feeds: download of the current selection, subscription to a published feed

/** Absolute URL of a generated feed, derived from where the page is served (self-hostable). */
function feedUrl(file, scheme = 'https') {
  const base = location.origin + location.pathname.replace(/[^/]*$/, '');
  const url = `${base}data/ics/${file}`;
  return scheme === 'webcal' ? url.replace(/^https?:/, 'webcal:') : url;
}

/** The events the current view shows (for the download). */
function shownEvents() {
  if (state.ansicht === 'kalender') return eventsInMonth(applyFilters(data.events, state, ctx, { skipTime: true }), shownMonth());
  return applyFilters(data.events, state, ctx);
}

function renderActions() {
  const box = $('view-actions');
  box.hidden = state.ansicht === 'vereine' || state.ansicht === 'karte';
  if (box.hidden) return;
  const n = shownEvents().length;
  $('download').disabled = n === 0;
  $('download').setAttribute('aria-label', `${n} angezeigte ${n === 1 ? 'Termin' : 'Termine'} als .ics herunterladen`);
  const sub = subscription(state, ctx);
  const details = $('subscribe');
  details.hidden = !sub;
  if (!sub) { details.open = false; return; }
  $('sub-title').textContent = sub.title;
  $('sub-webcal').href = feedUrl(sub.file, 'webcal');
  $('sub-url').value = feedUrl(sub.file);
  $('sub-hint').textContent = sub.exact
    ? 'Das Abo enthält genau diese Auswahl, auch künftige Termine.'
    : `Das Abo enthält ${sub.title[0].toLowerCase()}${sub.title.slice(1)} – ${sub.file.startsWith('verein-') && state.sport.length ? 'Sportart, ' : ''}Art, Spielort, Suche und Zeitraum gelten nur hier auf der Seite.`;
}

// The side filter in a file name: "Heimspiele" for games only, "ohne Auswärtsspiele" when the file holds more.
function sideLabel() {
  const onlyGames = state.art.length === 1 && state.art[0] === 'spiel';
  if (state.ort === 'heim') return onlyGames ? 'Heimspiele' : 'ohne Auswärtsspiele';
  return onlyGames ? 'Auswärtsspiele' : 'ohne Heimspiele';
}

function slug(text) {
  return fold(text).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'auswahl';
}

function download() {
  const events = shownEvents();
  if (!events.length) return;
  const parts = [
    state.verein ? ctx.clubsById.get(state.verein)?.name : null,
    ...state.sport.map((s) => ctx.sportsById.get(s)?.label),
    ...state.art.map((k) => KINDS.find((x) => x.id === k)?.label),
    showsGames() && state.ort !== 'alle' ? sideLabel() : null,
    state.ansicht === 'kalender' ? formatMonth(shownMonth()) : null,
  ].filter(Boolean);
  const name = `Sport in Bonn${parts.length ? ` – ${parts.join(', ')}` : ''}`;
  saveFeed(events, name, `sportbonnii-${slug(parts.join(' ') || 'alle-termine')}.ics`);
}

/** One date as its own .ics („In meinen Kalender“). */
function downloadOne(id) {
  const e = data.events.find((x) => x.id === id);
  if (e) saveFeed([e], e.title, `sportbonnii-${slug(e.title)}.ics`);
}

function saveFeed(events, name, file) {
  const text = serializeFeed(events, {
    name,
    windowFrom: data.window.from,
    labels: Object.fromEntries(data.sports.map((s) => [s.id, s.label])),
    clubNames: Object.fromEntries(data.clubs.map((c) => [c.id, c.name])),
  });
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
  const a = el('a');
  a.href = url;
  a.download = file;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function renderClubsView() {
  const upcoming = new Map();
  for (const e of applyFilters(data.events, { ...defaultState(), art: [], ort: 'alle', zeit: 'alle' }, ctx)) if (e.club) upcoming.set(e.club, (upcoming.get(e.club) ?? 0) + 1);
  // Counts of upcoming dates, like the cards ("kommende Termine"); the hidden range, kind and home/away do not apply.
  renderChips(chipCounts(data.events, { ...state, zeit: 'alle', art: [], ort: 'alle' }, ctx));
  const shown = renderClubs($('clubs'), {
    clubs: data.clubs,
    platforms: data.platforms,
    status: data.status,
    ctx,
    upcomingByClub: upcoming,
    state,
    feedUrl,
    onShowClub(id) { showUnfiltered(id); },
  });
  const box = $('result');
  box.replaceChildren(el('b', null, String(shown)), document.createTextNode(shown === 1 ? ' Verein' : ' Vereine'));
}

function renderTableView() {
  const visible = applyFilters(data.events, state, ctx);
  renderChips(chipCounts(data.events, state, ctx));
  renderKindChips(kindCounts(data.events, state, ctx));
  renderResult(visible.length);
  renderTable($('table'), visible, {
    ctx,
    sort: ui.sort,
    limit: ui.limit,
    refYear: Number(ctx.today.slice(0, 4)),
    empty: () => emptyState(state.zeit === 'alle' ? 'Keine kommenden Termine für diese Auswahl.' : 'Keine Termine in diesem Zeitraum.'),
    onSort(key) {
      ui.sort = ui.sort.key === key ? { key, dir: -ui.sort.dir } : { key, dir: 1 };
      render();
      document.querySelector(`#table [data-sort="${key}"]`)?.focus();
    },
    detail: ui.detail,
    onClub(id) { showUnfiltered(id); },
    onDetail(id) { ui.detail = ui.detail === id ? null : id; render(); },
    onIcs(id) { downloadOne(id); },
    onPlace: showPlace,
    onMore() { ui.limit += PAGE; render(); },
  });
}

function renderMap() {
  const visible = applyFilters(data.events, state, ctx);
  renderChips(chipCounts(data.events, state, ctx));
  renderKindChips(kindCounts(data.events, state, ctx));
  const located = renderMapView($('map'), {
    events: visible,
    clubs: data.clubs,
    state,
    ctx,
    refYear: Number(ctx.today.slice(0, 4)),
    selected: ui.place,
    onSelect(id) { ui.place = id; render(); },
    onClub(id) { showUnfiltered(id); },
  });
  renderResult(located, ' auf der Karte');
}

function renderCalendarView() {
  const ym = shownMonth();
  const filtered = applyFilters(data.events, state, ctx, { skipTime: true });
  const inMonth = eventsInMonth(data.events, ym);
  renderChips(chipCounts(inMonth, state, ctx, { skipTime: true }));
  renderKindChips(kindCounts(inMonth, state, ctx, { skipTime: true }));
  renderResult(eventsInMonth(filtered, ym).length, ` im ${formatMonth(ym).split(' ')[0]}`);
  const focus = ui.focusDay;
  ui.focusDay = null;
  renderCalendar($('calendar'), {
    ym,
    events: filtered,
    ctx,
    selected: ui.day,
    focus,
    minMonth: monthOf(data.window.from),
    maxMonth: monthOf(addDays(data.window.to, -1)),
    onNavigate(next, focusDate) {
      ui.focusDay = focusDate ?? null;
      update({ monat: next === monthOf(ctx.today) ? '' : next });
    },
    onSelect(date) {
      ui.day = date === ui.day ? null : date;
      ui.focusDay = date;
      render();
    },
    onClub(id) { showUnfiltered(id); },
  });
}

/** A place in the table opens the map at that venue, its marker focused. */
function showPlace(id) {
  const club = ctx.clubsById.get(id.split('/')[0]);
  ui.place = id;
  // The map shows a club only under a sport it has; a platform date may carry another.
  update({ ansicht: 'karte', ...(state.sport.length && !club.sports.some((s) => state.sport.includes(s)) ? { sport: [] } : {}) });
  $('map').querySelector(`[data-marker="${id}"]`)?.focus();
}

function resetFilters() {
  const d = defaultState();
  choose({ sport: d.sport, art: d.art, ort: d.ort, verein: d.verein, q: d.q, zeit: d.zeit });
  $('f-q').value = '';
}

// --- wiring ----------------------------------------------------------------------

function bind() {
  $('sport-chips').addEventListener('click', (e) => {
    if (e.target.closest('[data-more]')) { ui.allChips = !ui.allChips; render(); return; }
    const b = e.target.closest('[data-sport]');
    if (!b) return;
    const id = b.dataset.sport;
    choose({ sport: state.sport.includes(id) ? state.sport.filter((s) => s !== id) : [...state.sport, id] });
  });
  $('sport-clear').addEventListener('click', () => choose({ sport: [] }));
  $('kind-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    const id = b.dataset.kind;
    choose({ art: state.art.includes(id) ? state.art.filter((k) => k !== id) : [...state.art, id] });
  });
  $('kind-clear').addEventListener('click', () => choose({ art: [] }));

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
    if (b) choose({ zeit: b.dataset.zeit });
  });
  $('f-ort').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ort]');
    if (b) choose({ ort: b.dataset.ort });
  });
  $('reset').addEventListener('click', resetFilters);
  $('download').addEventListener('click', download);
  $('sub-url').addEventListener('focus', (e) => e.target.select());
  document.addEventListener('click', (e) => {
    const details = $('subscribe');
    if (details.open && !details.contains(e.target)) details.open = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('subscribe').open) { $('subscribe').open = false; $('subscribe').querySelector('summary').focus(); }
  });

  const tabs = document.querySelector('[role="tablist"]');
  tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab && tab.dataset.view !== state.ansicht) update({ ansicht: tab.dataset.view });
  });
  tabs.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const i = VIEW_IDS.indexOf(state.ansicht);
    const next = VIEW_IDS[Math.max(0, Math.min(VIEW_IDS.length - 1, Number.isFinite(step) ? (i + step + VIEW_IDS.length) % VIEW_IDS.length : step < 0 ? 0 : VIEW_IDS.length - 1))];
    update({ ansicht: next });
    $(`tab-${next}`).focus();
  });

  // The brand resets the page in place: a reload would load all data again and rebuild the page from blank.
  document.querySelector('.brand').addEventListener('click', (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    Object.assign(ui, freshUi());
    $('subscribe').open = false;
    $('impressum').open = false;
    update(defaultState(), { push: true });
    remember(defaultState()); // the way back to the default also forgets the saved choices
    $('f-q').value = '';
    window.scrollTo(0, 0);
  });

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
    platformsById: new Map(data.platforms.map((p) => [p.id, p])),
  };
  const list = $('club-list');
  list.replaceChildren(...data.clubs.filter((c) => c.active !== false).sort((a, b) => a.name.localeCompare(b.name, 'de')).map((c) => {
    const o = el('option');
    o.value = clubLabel(c);
    return o;
  }));
  state = parseHash(location.hash, known());
  // A link decides what it shows; only a bare address opens on what the visitor chose last time.
  if (!location.hash.replace(/^#/, '')) state = { ...state, ...loadChoices(known()) };
  writeAddress(state); // normalise a hand-edited or outdated link, and spell out the saved choices
  $('f-q').value = state.q;
  renderHeader();
  bind();
  render();
  document.body.classList.add('is-ready');
}

main();
