// Venue links and the kind lists they share with the registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { osmUrl, venueIndex } from '../site/venue.js';
import { KIND_IDS, VENUE_USES } from '../site/kinds.js';

test('osmUrl: the mapped object when the registry names one', () => {
  assert.equal(osmUrl({ osm: 'way/123977272', lat: 50.70732, lon: 7.15703 }), 'https://www.openstreetmap.org/way/123977272');
});

test('osmUrl: a marker at lat/lon otherwise', () => {
  assert.equal(
    osmUrl({ lat: 50.7029, lon: 7.04837 }),
    'https://www.openstreetmap.org/?mlat=50.7029&mlon=7.04837#map=18/50.7029/7.04837',
  );
});

test('every venue use is an event kind', () => {
  for (const use of VENUE_USES) assert.ok(KIND_IDS.includes(use), use);
  assert.equal(new Set(KIND_IDS).size, KIND_IDS.length);
});

test('venueIndex: the venue a location names, by name or street with number', () => {
  const venues = [
    { name: 'Sporthalle Beuel-Ost (Gesamtschule)', address: 'Siegburger Str. 321, 53229 Bonn' },
    { name: 'Rugbyplatz Rheinaue', address: 'Martin-Luther-King-Str. 22, 53175 Bonn' },
    { name: 'Baseballstadion', address: 'Martin-Luther-King-Straße, 53175 Bonn' },
  ];
  assert.equal(venueIndex('SPORTHALLE BEUEL-OST GESAMTSCHULE, BONN', venues), 0, 'name, case and punctuation folded');
  assert.equal(venueIndex('Rugby Club e.V., Martin-Luther-King-Straße 22, 53175 Bonn', venues), 1, 'Str. = Straße');
  assert.equal(venueIndex('Martin-Luther-King-Straße 2, Bonn', venues), -1, 'another house number');
  assert.equal(venueIndex('Martin-Luther-King-Straße, Bonn', venues), -1, 'a street without number names no venue');
  assert.equal(venueIndex('Siegburger Straße 321', venues), 0);
  assert.equal(venueIndex(null, venues), -1);
  assert.equal(venueIndex('Sporthalle Beuel-Ost', undefined), -1);
});
