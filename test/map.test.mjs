// The map view without a browser: projection, tiles, fitting, zooming, and
// which venue a date belongs to — on the committed site-data snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { project, unproject, visibleTiles, fitView, zoomView, eventVenue, mapPlaces, TILE_URL } from '../site/map.js';
import { applyFilters, defaultState } from '../site/state.js';

const json = (n) => JSON.parse(readFileSync(new URL(`./fixtures/site-data/${n}`, import.meta.url), 'utf8'));
const events = json('events.json').events;
const clubs = json('clubs.json').clubs;
const sports = json('sports.json').sports;
const ctx = { today: '2026-10-14', clubsById: new Map(clubs.map((c) => [c.id, c])), sportsById: new Map(sports.map((s) => [s.id, s])) };
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('projection: Web Mercator, the OSM tile scheme', () => {
  assert.deepEqual(project(0, 0, 0), { x: 128, y: 128 });
  // The slippy-map formula from the OSM wiki, written independently.
  const tile = (lat, lon, z) => {
    const r = (lat * Math.PI) / 180;
    return [Math.floor(((lon + 180) / 360) * 2 ** z), Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z)];
  };
  for (const z of [10, 13, 17]) {
    const p = project(50.70732, 7.15703, z);
    assert.deepEqual([Math.floor(p.x / 256), Math.floor(p.y / 256)], tile(50.70732, 7.15703, z), `z${z}`);
  }
  const back = unproject(...Object.values(project(50.74367, 7.18878, 15)), 15);
  assert.ok(close(back.lat, 50.74367) && close(back.lon, 7.18878), JSON.stringify(back));
  assert.equal(TILE_URL, 'https://tile.openstreetmap.org/', 'the host the CSP admits');
});

test('tiles: exactly those that touch the viewport, at their screen offsets', () => {
  const view = { z: 3, cx: 1000, cy: 700 };
  const tiles = visibleTiles(view, { width: 400, height: 300 });
  // x from 800 to 1199 → tiles 3, 4; y from 550 to 849 → tiles 2, 3.
  assert.deepEqual(tiles.map((t) => `${t.x}/${t.y}`).sort(), ['3/2', '3/3', '4/2', '4/3']);
  const t = tiles.find((x) => x.x === 3 && x.y === 2);
  assert.deepEqual([t.left, t.top, t.z], [3 * 256 - 800, 2 * 256 - 550, 3]);
  assert.deepEqual(visibleTiles({ z: 1, cx: 0, cy: 0 }, { width: 2000, height: 2000 }).length, 4, 'clamped to the world');
  assert.deepEqual(visibleTiles(view, { width: 0, height: 300 }), [], 'a hidden map loads nothing');
});

test('fitting: the largest zoom that shows every point, centred', () => {
  const pts = [{ lat: 50.70732, lon: 7.15703 }, { lat: 50.74367, lon: 7.18878 }, { lat: 50.7029, lon: 7.04837 }];
  const size = { width: 800, height: 500 };
  const v = fitView(pts, size);
  const fits = (z) => {
    const xs = pts.map((p) => project(p.lat, p.lon, z));
    const span = (k) => Math.max(...xs.map((p) => p[k])) - Math.min(...xs.map((p) => p[k]));
    return span('x') + 80 <= size.width && span('y') + 80 <= size.height;
  };
  assert.ok(fits(v.z) && !fits(v.z + 1), `z${v.z}`);
  for (const p of pts) {
    const q = project(p.lat, p.lon, v.z);
    assert.ok(Math.abs(q.x - v.cx) <= size.width / 2 && Math.abs(q.y - v.cy) <= size.height / 2, 'every point on screen');
  }
  assert.equal(fitView([pts[0]], size).z, 16, 'one point: the closest default zoom');
  const bonn = fitView([], size);
  assert.ok(close(unproject(bonn.cx, bonn.cy, bonn.z).lat, 50.7374, 1e-4), 'nothing to show: Bonn');
});

test('zooming keeps the point under the cursor in place', () => {
  const size = { width: 600, height: 400 };
  const v = { z: 12, cx: 545000, cy: 352000 };
  const at = (view, px, py) => unproject(view.cx - size.width / 2 + px, view.cy - size.height / 2 + py, view.z);
  for (const z of [13, 11, 15]) {
    const next = zoomView(v, z, 100, 50, size);
    const a = at(v, 100, 50);
    const b = at(next, 100, 50);
    assert.ok(close(a.lat, b.lat) && close(a.lon, b.lon), `z${z}`);
  }
});

test('venues: the place a date names, else the only fitting venue — never for an away game', () => {
  const club = {
    venues: [
      { name: 'Sportpark Pennenfeld', address: 'Mallwitzstraße, 53177 Bonn', use: 'spiel' },
      { name: 'Sportplatz Brüser Berg', address: 'Schießstandweg 25, 53125 Bonn', use: 'training' },
    ],
  };
  const e = (o) => ({ kind: 'spiel', home: null, location: null, ...o });
  assert.equal(eventVenue(e({ location: 'Sportpark Pennenfeld, Bonn' }), club), 0);
  assert.equal(eventVenue(e({ kind: 'training', location: 'Schießstandweg 25' }), club), 1);
  assert.equal(eventVenue(e({ location: 'Sporthalle Ringstraße, Bonn' }), club), -1, 'a place elsewhere stays elsewhere');
  assert.equal(eventVenue(e({}), club), 0, 'no place: the game venue');
  assert.equal(eventVenue(e({ kind: 'training' }), club), 1, 'no place: the training venue');
  assert.equal(eventVenue(e({ home: false }), club), -1, 'an away game without place is not at home');
  assert.equal(eventVenue(e({ home: true }), club), 0);
  assert.equal(eventVenue(e({ kind: 'veranstaltung' }), club), -1, 'two venues, neither for events');
  assert.equal(eventVenue(e({}), { venues: [{ name: 'Platz' }, { name: 'Halle' }] }), -1, 'two venues for everything: unknown');
  assert.equal(eventVenue(e({ kind: 'veranstaltung' }), { venues: [{ name: 'Platz' }] }), 0);
  assert.equal(eventVenue(e({}), {}), -1);
});

test('places: venues of the clubs the filters leave, with their dates', () => {
  const every = { ...defaultState(), art: [], ort: 'alle' };
  const shown = applyFilters(events, every, ctx);
  const { places, elsewhere } = mapPlaces(shown, clubs, every);
  const withVenues = clubs.filter((c) => c.venues?.length);
  assert.equal(places.length, withVenues.reduce((n, c) => n + c.venues.length, 0));
  assert.equal(places.reduce((n, p) => n + p.events.length, 0) + elsewhere, shown.length, 'every date is on the map or counted elsewhere');
  const roleber = places.find((p) => p.id === 'bsv-roleber/0');
  assert.ok(roleber.events.length > 0 && roleber.events.every((x) => x.club === 'bsv-roleber' && x.location.includes('Roleber')));
  assert.ok(!roleber.events.some((x) => x.home === false), 'the away game in Rheinbach is not at Roleber');
  const rugby = mapPlaces(shown, clubs, { ...every, sport: ['rugby'] }).places;
  assert.deepEqual(rugby.map((p) => p.club.id), ['rc-bonn-rhein-sieg']);
  assert.deepEqual(mapPlaces(shown, clubs, { ...every, verein: 'bonn-gamecocks' }).places.map((p) => p.id), ['bonn-gamecocks/0', 'bonn-gamecocks/1']);
  const away = mapPlaces(applyFilters(events, { ...every, art: ['spiel'], ort: 'auswaerts' }, ctx), clubs, every);
  assert.deepEqual([away.places.reduce((n, p) => n + p.events.length, 0), away.elsewhere], [0, 1], 'away games are not pinned to a home venue');
});
