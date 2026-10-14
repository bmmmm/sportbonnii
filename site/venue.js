// Venue links: a club's venue opens in OpenStreetMap — the mapped object when
// the registry names one (`osm`: node/way/relation), else a marker at lat/lon.
// Built as a string: the page never parses or fetches the URL.

const OSM = 'https://www.openstreetmap.org/';

/** @param {{ osm?: string, lat: number, lon: number }} venue */
export function osmUrl({ osm, lat, lon }) {
  if (osm) return `${OSM}${osm}`;
  return `${OSM}?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`;
}
