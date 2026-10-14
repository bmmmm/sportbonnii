// Venue links and the kind lists they share with the registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { osmUrl } from '../site/venue.js';
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
