// The club overview, docs/vereine.md: one row per club, generated from the
// registry so "is this club already listed?" can be answered by reading one
// page. `pnpm run registry:fmt` writes it, the intake bot's pull request
// carries it, and a test pins the committed file to this output.
//
// Zero dependencies on purpose (the club-intake workflow runs this without
// `pnpm install`); the two site modules it imports import nothing themselves.
// German text, since the page is for the clubs' people; no date, so the
// output depends on the registry alone.
import { osmUrl } from '../site/venue.js';

const SOURCE_LABELS = { ical: 'iCal', tec: 'TEC', gancio: 'Gancio', jsonld: 'schema.org', rss: 'RSS' };
const USE_PREFIX = { spiel: 'Spiele: ', training: 'Training: ' };
const NONE = '–';
const MAX_VENUES = 3;

/** Text safe inside a Markdown table cell: one line, markup characters escaped. */
export function escapeMarkdown(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().replace(/[\\|[\]*_<>`]/g, '\\$&');
}

/** A Markdown link whose target cannot end early; plain escaped text when `url` is not an absolute URL. */
function link(text, url) {
  let href;
  try {
    href = new URL(url).href;
  } catch {
    return escapeMarkdown(text);
  }
  href = href.replace(/[() |`<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  return `[${escapeMarkdown(text)}](${href})`;
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return String(url);
  }
};

const websiteCell = (url) => (url ? link(hostOf(url), url) : NONE);

/** "iCal", "TEC (aus)", repeats as "iCal ×2"; no source → "–". */
function calendarCell(sources) {
  const counts = new Map();
  for (const s of sources ?? []) {
    const label = `${SOURCE_LABELS[s.type] ?? escapeMarkdown(s.type)}${s.enabled === false ? ' (aus)' : ''}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (!counts.size) return NONE;
  return [...counts].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(', ');
}

function venueCell(venues) {
  if (!Array.isArray(venues) || venues.length === 0) return NONE;
  return venues.slice(0, MAX_VENUES).map((v) => {
    const hasPlace = v.osm || (Number.isFinite(v.lat) && Number.isFinite(v.lon));
    return `${USE_PREFIX[v.use] ?? ''}${hasPlace ? link(v.name, osmUrl(v)) : escapeMarkdown(v.name)}`;
  }).join('<br>');
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)];

/**
 * The overview text for `{ clubs, platforms, sports }` (loadRegistry's shape,
 * or the same from an unsaved registry): title, notice, statistics, the
 * department rule, a table of the clubs by id, then the platforms.
 */
export function renderOverview({ clubs, platforms = [], sports }) {
  const label = new Map(sports.map((s) => [s.id, s.label]));
  const order = new Map(sports.map((s, i) => [s.id, i]));
  const sportName = (id) => escapeMarkdown(label.get(id) ?? id);
  const sortedSports = (ids) => [...ids].sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity));

  const clubRows = [...clubs].sort(byId).map((c) => [
    `**${escapeMarkdown(c.name)}**${c.active === false ? ' (inaktiv)' : ''}<br>\`${c.id}\``,
    sortedSports(c.sports ?? []).map(sportName).join(', ') || NONE,
    c.district ? escapeMarkdown(c.district) : NONE,
    venueCell(c.venues),
    calendarCell(c.sources),
    websiteCell(c.website),
  ]);
  const withCalendar = clubs.filter((c) => (c.sources ?? []).some((s) => s.enabled !== false)).length;
  const sportCount = new Set(clubs.flatMap((c) => c.sports ?? [])).size;

  const lines = [
    '# Vereine in Bonn',
    '',
    'Generiert von `pnpm run registry:fmt` – nicht von Hand ändern.',
    '',
    `${clubs.length} Vereine · ${withCalendar} mit Online-Kalender · ${sportCount} Sportarten`,
    '',
    'Abteilungen stehen beim Verein, nie als eigener Eintrag. Neuer Verein? Erst hier nachsehen, dann [registry/README.md](../registry/README.md) lesen.',
    '',
    ...table(['Verein', 'Abteilungen', 'Bezirk', 'Spielstätten', 'Kalender', 'Website'], clubRows),
  ];
  if (platforms.length) {
    lines.push(
      '',
      '## Plattformen',
      '',
      'Stadtweite Kalender, die kein Verein sind; ihre Termine werden den Vereinen über deren Namen zugeordnet.',
      '',
      ...table(['Plattform', 'Kalender', 'Website'], [...platforms].sort(byId).map((p) => [
        `**${escapeMarkdown(p.name)}**<br>\`${p.id}\``, calendarCell(p.sources), websiteCell(p.website),
      ])),
    );
  }
  return `${lines.join('\n')}\n`;
}
