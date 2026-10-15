// The map view: the clubs' venues on OpenStreetMap tiles, each with the dates
// the filters show there. A small slippy map of its own (Web Mercator, 256 px
// tiles as <img>, drag, wheel, pinch, keys, buttons) instead of a library:
// DOM via createElement, positions via the CSSOM. Tiles are the page's only
// third-party request, and none is made before the map is on screen.
import { el, card, relativeDay } from './table.js';
import { eventDays, formatLongDate } from './dates.js';
import { osmUrl, eventVenue } from './venue.js';

export { eventVenue };

const TILE = 256;
export const TILE_URL = 'https://tile.openstreetmap.org/';
export const MIN_ZOOM = 10;
export const MAX_ZOOM = 18;
const BONN = { lat: 50.7374, lon: 7.0982 };
const MAX_DATES = 5;

// --- projection (pure) -----------------------------------------------------------

/** World pixel of a coordinate at zoom z. */
export function project(lat, lon, z) {
  const size = TILE * 2 ** z;
  const s = Math.sin((lat * Math.PI) / 180);
  return { x: ((lon + 180) / 360) * size, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size };
}

/** Coordinate of a world pixel at zoom z. */
export function unproject(x, y, z) {
  const size = TILE * 2 ** z;
  const n = Math.PI - (2 * Math.PI * y) / size;
  return { lat: (180 / Math.PI) * Math.atan(Math.sinh(n)), lon: (x / size) * 360 - 180 };
}

/** The tiles a view needs: view = { z, cx, cy } (world pixels of the centre), size = { width, height }. */
export function visibleTiles({ z, cx, cy }, { width, height }) {
  if (!(width > 0 && height > 0)) return [];
  const n = 2 ** z;
  const left = cx - width / 2;
  const top = cy - height / 2;
  const tiles = [];
  const clamp = (v) => Math.max(0, Math.min(n - 1, v));
  for (let y = clamp(Math.floor(top / TILE)); y <= clamp(Math.floor((top + height - 1) / TILE)); y++) {
    for (let x = clamp(Math.floor(left / TILE)); x <= clamp(Math.floor((left + width - 1) / TILE)); x++) {
      tiles.push({ z, x, y, left: x * TILE - left, top: y * TILE - top });
    }
  }
  return tiles;
}

/** The view that shows every point: the largest zoom that fits them (with `pad` px on each side), centred; Bonn at z12 without points. */
export function fitView(points, { width, height }, { minZoom = 11, maxZoom = 16, pad = 40 } = {}) {
  if (!points.length) {
    const c = project(BONN.lat, BONN.lon, 12);
    return { z: 12, cx: c.x, cy: c.y };
  }
  let z = maxZoom;
  for (; z > minZoom; z--) {
    const xs = points.map((p) => project(p.lat, p.lon, z));
    const w = Math.max(...xs.map((p) => p.x)) - Math.min(...xs.map((p) => p.x));
    const h = Math.max(...xs.map((p) => p.y)) - Math.min(...xs.map((p) => p.y));
    if (w + 2 * pad <= width && h + 2 * pad <= height) break;
  }
  const xs = points.map((p) => project(p.lat, p.lon, z));
  return {
    z,
    cx: (Math.min(...xs.map((p) => p.x)) + Math.max(...xs.map((p) => p.x))) / 2,
    cy: (Math.min(...xs.map((p) => p.y)) + Math.max(...xs.map((p) => p.y))) / 2,
  };
}

/** The view after zooming to `z` with the screen point (px, py) kept in place. */
export function zoomView(view, z, px, py, { width, height }) {
  const k = 2 ** (z - view.z);
  const wx = view.cx - width / 2 + px;
  const wy = view.cy - height / 2 + py;
  return { z, cx: wx * k - px + width / 2, cy: wy * k - py + height / 2 };
}

// --- the slippy map ----------------------------------------------------------------

const translate = (node, x, y, k = 1) => node.style.setProperty('transform', `translate(${Math.round(x)}px, ${Math.round(y)}px)${k === 1 ? '' : ` scale(${k})`}`);

/**
 * A map in `box`: { setMarkers(markers, { fit }), view() }. markers:
 * [{ id, lat, lon, label, count, colour, selected }]; onSelect(id) on a click.
 */
export function createMap(box, { onSelect }) {
  const root = el('div', 'map');
  root.tabIndex = 0;
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Karte der Spielstätten – mit den Pfeiltasten verschieben, mit + und − zoomen');
  const tiles = el('div', 'map-tiles');
  const pins = el('div', 'map-markers');
  const zoom = el('div', 'map-zoom');
  const zin = el('button', 'map-zoom-in', '+');
  const zout = el('button', 'map-zoom-out', '−');
  for (const [b, label] of [[zin, 'Hineinzoomen'], [zout, 'Herauszoomen']]) {
    b.type = 'button';
    b.setAttribute('aria-label', label);
    zoom.append(b);
  }
  const attrib = el('p', 'map-attrib', '© ');
  const osm = el('a', null, 'OpenStreetMap-Mitwirkende');
  osm.href = 'https://www.openstreetmap.org/copyright';
  osm.rel = 'noopener';
  attrib.append(osm);
  root.append(tiles, pins, zoom, attrib);
  box.replaceChildren(root);

  let view = null;
  let fitPending = true;
  let markers = [];
  const imgs = new Map();
  const ready = new WeakSet(); // tiles loaded and decoded
  const backdrop = new Map(); // img → its zoom
  const size = () => ({ width: root.clientWidth, height: root.clientHeight });

  function draw() {
    const s = size();
    if (!s.width || !s.height) return;
    if (fitPending || !view) { view = fitView(markers, s); fitPending = false; }
    const left = view.cx - s.width / 2;
    const top = view.cy - s.height / 2;
    const want = new Set();
    let loading = false;
    for (const t of visibleTiles(view, s)) {
      const key = `${t.z}/${t.x}/${t.y}`;
      want.add(key);
      let img = imgs.get(key);
      if (!img) {
        img = el('img', 'map-tile');
        img.alt = '';
        img.draggable = false;
        img.decoding = 'async';
        img.src = `${TILE_URL}${key}.png`;
        img.decode().catch(() => {}).then(() => { ready.add(img); redraw(); });
        imgs.set(key, img);
        tiles.append(img);
      }
      if (backdrop.delete(img)) tiles.append(img); // back on top of any backdrop
      translate(img, t.left, t.top);
      if (!ready.has(img)) loading = true;
    }
    // A zoom never shows an empty map: the loaded tiles of the zooms before stay
    // underneath, scaled to this one, until this zoom's own tiles are in.
    let restack = false;
    for (const [key, img] of imgs) {
      if (want.has(key)) continue;
      const [z, x, y] = key.split('/').map(Number);
      const k = 2 ** (view.z - z);
      const tl = x * TILE * k - left;
      const tt = y * TILE * k - top;
      const onScreen = tl < s.width && tt < s.height && tl + TILE * k > 0 && tt + TILE * k > 0;
      if (loading && z !== view.z && ready.has(img) && onScreen) {
        if (!backdrop.has(img)) { backdrop.set(img, z); restack = true; }
        translate(img, tl, tt, k);
      } else { img.remove(); imgs.delete(key); backdrop.delete(img); }
    }
    // Under the current tiles; of the backdrop the zoom nearest the view lies on top.
    const near = (img) => -Math.abs(backdrop.get(img) - view.z);
    if (restack) tiles.prepend(...[...backdrop.keys()].sort((a, b) => near(a) - near(b)));
    for (const m of markers) {
      const p = project(m.lat, m.lon, view.z);
      translate(m.node, p.x - left, p.y - top);
      // A marker off the box is out of the tab order: focusing it would scroll the layers.
      m.node.tabIndex = p.x >= left && p.x <= left + s.width && p.y >= top && p.y <= top + s.height ? 0 : -1;
    }
    zin.disabled = view.z >= MAX_ZOOM;
    zout.disabled = view.z <= MIN_ZOOM;
  }

  let frame = 0;
  const redraw = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw(); }); };
  const zoomTo = (z, px = size().width / 2, py = size().height / 2) => {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    if (!view || next === view.z) return;
    view = zoomView(view, next, px, py, size());
    draw();
  };
  const pan = (dx, dy) => { view = { ...view, cx: view.cx - dx, cy: view.cy - dy }; redraw(); };
  const local = (ev) => { const r = root.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };

  zin.addEventListener('click', () => zoomTo(view.z + 1));
  zout.addEventListener('click', () => zoomTo(view.z - 1));
  pins.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-marker]');
    if (b) onSelect(b.dataset.marker);
  });

  // Drag with one pointer, pinch with two (whole zoom steps).
  const down = new Map();
  let pinch = null;
  root.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || ev.target.closest('button, a') || !view) return;
    root.setPointerCapture(ev.pointerId);
    down.set(ev.pointerId, [ev.clientX, ev.clientY]);
    if (down.size === 2) {
      const [a, b] = [...down.values()];
      pinch = Math.hypot(a[0] - b[0], a[1] - b[1]);
    }
  });
  root.addEventListener('pointermove', (ev) => {
    const last = down.get(ev.pointerId);
    if (!last) return;
    if (down.size === 1) pan(ev.clientX - last[0], ev.clientY - last[1]);
    down.set(ev.pointerId, [ev.clientX, ev.clientY]);
    if (down.size === 2 && pinch) {
      const [a, b] = [...down.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (d > pinch * 1.5 || d < pinch / 1.5) {
        const r = root.getBoundingClientRect();
        zoomTo(view.z + (d > pinch ? 1 : -1), (a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top);
        pinch = d;
      }
    }
  });
  const up = (ev) => { down.delete(ev.pointerId); if (down.size < 2) pinch = null; };
  root.addEventListener('pointerup', up);
  root.addEventListener('pointercancel', up);
  root.addEventListener('lostpointercapture', up);
  // The layers move by transform only; a focused node must never scroll the box itself.
  root.addEventListener('scroll', () => { root.scrollTop = 0; root.scrollLeft = 0; });

  let wheelAt = 0;
  root.addEventListener('wheel', (ev) => {
    if (!view) return;
    const z = view.z + (ev.deltaY < 0 ? 1 : -1);
    // At the limit a plain vertical step scrolls the page; a pinch (ctrl) or a sideways swipe stays on the map.
    if (ev.deltaY && !ev.ctrlKey && (z < MIN_ZOOM || z > MAX_ZOOM)) return;
    ev.preventDefault();
    if (!ev.deltaY || ev.timeStamp - wheelAt < 250) return;
    wheelAt = ev.timeStamp;
    zoomTo(z, ...local(ev));
  }, { passive: false });
  root.addEventListener('dblclick', (ev) => { if (view && !ev.target.closest('button, a')) zoomTo(view.z + 1, ...local(ev)); });
  root.addEventListener('keydown', (ev) => {
    if (ev.target !== root || !view) return;
    const step = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] }[ev.key];
    if (step) pan(...step);
    else if (ev.key === '+' || ev.key === '=') zoomTo(view.z + 1);
    else if (ev.key === '-' || ev.key === '_') zoomTo(view.z - 1);
    else return;
    ev.preventDefault();
  });
  new ResizeObserver(() => draw()).observe(root);

  return {
    setMarkers(list, { fit = false } = {}) {
      markers = list.map((m) => {
        const b = el('button', 'map-marker', m.count ? String(m.count) : '');
        b.type = 'button';
        b.dataset.marker = m.id;
        b.style.setProperty('--sport', m.colour);
        b.setAttribute('aria-label', m.label);
        b.setAttribute('aria-pressed', String(Boolean(m.selected)));
        b.title = m.label;
        if (!m.count) b.classList.add('is-empty');
        return { ...m, node: b };
      });
      pins.replaceChildren(...markers.map((m) => m.node));
      if (fit) fitPending = true;
      draw();
    },
    view: () => view,
  };
}

// --- the view: venues, their dates, the panel --------------------------------------

/**
 * The places the map shows: every venue of the clubs the sport and club
 * filters leave, with the given (already filtered) events that happen there.
 * Returns { places: [{ id, club, venue, events }], elsewhere } — `elsewhere`
 * counts the events without a venue on the map.
 */
export function mapPlaces(events, clubs, state) {
  const shown = clubs.filter((c) => c.active !== false && c.venues?.length
    && (!state.verein || c.id === state.verein)
    && (!state.sport.length || c.sports.some((s) => state.sport.includes(s))));
  const places = shown.flatMap((club) => club.venues.map((venue, i) => ({ id: `${club.id}/${i}`, club, venue, events: [] })));
  const byId = new Map(places.map((p) => [p.id, p]));
  const clubsById = new Map(shown.map((c) => [c.id, c]));
  let elsewhere = 0;
  for (const e of events) {
    const club = clubsById.get(e.club);
    const i = club ? eventVenue(e, club) : -1;
    if (i === -1) elsewhere++;
    else byId.get(`${club.id}/${i}`).events.push(e);
  }
  return { places, elsewhere };
}

/**
 * opts: { events (filtered), clubs, state, ctx, refYear, selected,
 *   onSelect(id | null), onClub(id) }. Returns the number of dates on the map.
 */
export function renderMapView(box, opts) {
  const { places, elsewhere } = mapPlaces(opts.events, opts.clubs, opts.state);
  const { ctx } = opts;
  let st = mapState.get(box);
  if (!st) {
    const canvas = el('div', 'map-box');
    const note = el('p', 'map-note');
    const panel = el('section', 'map-panel');
    panel.setAttribute('aria-live', 'polite');
    const list = el('ul', 'map-list');
    box.replaceChildren(canvas, note, panel, list);
    st = { map: createMap(canvas, { onSelect: (id) => st.onSelect(id) }), note, panel, list, key: null };
    // Club names in the panel (its own and the date cards') open that club's dates.
    panel.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-club]');
      if (b) st.onClub(b.dataset.club);
    });
    mapState.set(box, st);
  }
  st.onSelect = (id) => opts.onSelect(id === opts.selected ? null : id);
  st.onClub = opts.onClub;
  // Markers and list buttons are rebuilt below; the one a keyboard user just pressed keeps the focus.
  const active = document.activeElement;
  const focusMarker = box.contains(active) ? active.dataset?.marker : undefined;
  const focusPlace = box.contains(active) ? active.dataset?.place : undefined;
  const key = places.map((p) => p.id).join();
  const colour = (club) => ctx.sportsById.get(club.sports.find((s) => !opts.state.sport.length || opts.state.sport.includes(s)) ?? club.sports[0])?.colour ?? '#787878';
  const label = (p) => `${p.venue.name} (${p.club.name}): ${p.events.length === 1 ? '1 Termin' : `${p.events.length} Termine`}`;
  st.map.setMarkers(places.map((p) => ({
    id: p.id, lat: p.venue.lat, lon: p.venue.lon, label: label(p), count: p.events.length, colour: colour(p.club), selected: p.id === opts.selected,
  })), { fit: key !== st.key });
  st.key = key;

  const located = places.reduce((n, p) => n + p.events.length, 0);
  st.note.textContent = places.length
    ? elsewhere ? `${elsewhere === 1 ? '1 weiterer Termin' : `${elsewhere} weitere Termine`} dieser Auswahl ${elsewhere === 1 ? 'hat' : 'haben'} keinen eingetragenen Ort – ${elsewhere === 1 ? 'er steht' : 'sie stehen'} in der Tabelle.` : ''
    : 'Für diese Auswahl ist kein Vereinsgelände eingetragen.';
  st.note.hidden = !st.note.textContent;

  const sel = places.find((p) => p.id === opts.selected);
  if (!sel) {
    st.panel.replaceChildren(el('p', 'map-hint', places.length ? 'Einen Ort auf der Karte oder in der Liste wählen, um seine Termine zu sehen.' : ''));
  } else {
    const head = el('div', 'map-panel-head');
    head.append(el('h3', 'map-panel-title', sel.venue.name));
    const club = el('button', 'link-button', sel.club.name);
    club.type = 'button';
    club.dataset.club = sel.club.id;
    const where = el('p', 'map-panel-where');
    where.append(club);
    if (sel.venue.address) where.append(document.createTextNode(` · ${sel.venue.address}`));
    const link = el('a', 'map-panel-osm', 'In OpenStreetMap öffnen');
    link.href = osmUrl(sel.venue);
    link.rel = 'noopener';
    where.append(document.createTextNode(' · '), link);
    head.append(where);
    // The next dates, grouped by day like the table's cards.
    const dates = el('div', 'agenda map-dates');
    let list = null;
    let last = null;
    for (const e of sel.events.slice(0, MAX_DATES)) {
      const day = eventDays(e)[0];
      if (day !== last) {
        const h = el('h4', 'day-heading');
        const rel = relativeDay(day, ctx.today);
        if (rel) h.append(el('span', 'rel', rel));
        h.append(document.createTextNode(formatLongDate(day)));
        list = el('ul', 'card-list');
        dates.append(h, list);
        last = day;
      }
      list.append(card(e, ctx, opts.refYear));
    }
    st.panel.replaceChildren(head, sel.events.length ? dates : el('p', 'map-hint', 'Hier stehen für diese Auswahl keine Termine an.'));
    if (sel.events.length > MAX_DATES) {
      const more = el('button', 'button button-quiet', `Alle Termine von ${sel.club.name} in der Tabelle`);
      more.type = 'button';
      more.dataset.club = sel.club.id;
      st.panel.append(more);
    }
  }

  st.list.replaceChildren(...places.map((p) => {
    const b = el('button', 'map-list-item');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(p.id === opts.selected));
    b.dataset.place = p.id;
    b.style.setProperty('--sport', colour(p.club));
    b.append(el('span', 'map-list-name', p.venue.name), el('span', 'map-list-club', p.club.name), el('span', 'count', String(p.events.length)));
    b.addEventListener('click', () => st.onSelect(p.id));
    const li = el('li');
    li.append(b);
    return li;
  }));
  const refocus = [...box.querySelectorAll('[data-marker], [data-place]')]
    .find((n) => (focusMarker && n.dataset.marker === focusMarker) || (focusPlace && n.dataset.place === focusPlace));
  refocus?.focus();
  return located;
}

const mapState = new WeakMap();
