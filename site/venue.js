// Venue links: a club's venue opens in OpenStreetMap — the mapped object when
// the registry names one (`osm`: node/way/relation), else a marker at lat/lon.
// Built as a string: the page never parses or fetches the URL.

const OSM = 'https://www.openstreetmap.org/';

/** @param {{ osm?: string, lat: number, lon: number }} venue */
export function osmUrl({ osm, lat, lon }) {
  if (osm) return `${OSM}${osm}`;
  return `${OSM}?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`;
}

// Lowercase, diacritics folded, "straße"/"str." → "str", punctuation → spaces,
// a house number joined to its letter ("58 a" → "58a"), padded so a containment
// test is a whole-word test.
function words(s) {
  const t = String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').toLowerCase()
    .replace(/strasse\b|str\./g, 'str ').replace(/[^a-z0-9]+/g, ' ').replace(/(\d+) ([a-z])\b/g, '$1$2').trim();
  return ` ${t} `;
}

/**
 * The index of the venue a free-text event location names, else -1: the
 * venue's name (also without a trailing "(…)"), or its street with house number ("Martin-Luther-King-Str. 22"
 * matches "Martin-Luther-King-Straße 22, 53175 Bonn").
 * @param {string | null} location
 * @param {{ name: string, address?: string }[]} [venues]
 */
export function venueIndex(location, venues = []) {
  if (!location) return -1;
  const hay = words(location);
  return venues.findIndex((v) => {
    if (hay.includes(words(v.name)) || hay.includes(words(v.name.replace(/\s*\([^)]*\)\s*$/, '')))) return true;
    const street = v.address?.split(',')[0] ?? '';
    return /\d/.test(street) && hay.includes(words(street));
  });
}

/**
 * The venue an event takes place at, as an index into its club's venues, or
 * -1: the venue its location names; without a location, the club's only venue
 * for that kind of date — unless it is an away game.
 */
export function eventVenue(e, club) {
  const venues = club?.venues ?? [];
  if (!venues.length) return -1;
  if (e.location) return venueIndex(e.location, venues);
  if (e.home === false) return -1;
  const fits = venues.map((v, i) => [v, i]).filter(([v]) => !v.use || v.use === e.kind);
  return fits.length === 1 ? fits[0][1] : -1;
}
