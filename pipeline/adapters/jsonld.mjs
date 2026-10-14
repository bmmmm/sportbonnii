// schema.org Event JSON-LD adapter, ported from scalendarii
// (src/ingest/adapters/jsonld.ts, extractJsonLdEvents). Real pages embed
// malformed blocks, unrelated types and @graph wrappers; every step degrades
// to a warning instead of failing the page.
//
// One rule differs from the port, consistent with the iCal adapter: a
// datetime without zone means local time at the venue, which for this site
// is Europe/Berlin wall clock (scalendarii pinned it to UTC).
import { htmlToText, safeHttpUrl, singleLineText, createWarningSink } from '../text.mjs';
import { BERLIN, zonedToUtc } from '../tz.mjs';

const LD_JSON_SCRIPT_RE = /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
export const EVENT_SUBTYPES = new Set(['Festival', 'Hackathon', 'CourseInstance', 'ScreeningEvent']);
const MAX_CONTAINER_DEPTH = 16;

function isEventType(type) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => typeof t === 'string' && (t === 'Event' || t.endsWith('Event') || EVENT_SUBTYPES.has(t)));
}

/** Single objects, arrays and @graph wrappers, depth-bounded (hostile nesting). */
function collectNodes(parsed, depth = 0) {
  if (depth > MAX_CONTAINER_DEPTH) return [];
  if (Array.isArray(parsed)) return parsed.flatMap((n) => collectNodes(n, depth + 1));
  if (parsed && typeof parsed === 'object') {
    const graph = parsed['@graph'];
    if (Array.isArray(graph)) return graph.flatMap((n) => collectNodes(n, depth + 1));
    return [parsed];
  }
  return [];
}

const DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const RFC_2822_RE = /^(?:[a-z]{3},\s*)?(\d{1,2})\s+([a-z]{3})\s+(\d{4})\s+(\d{2}:\d{2}(?::\d{2})?)(?:\s*(Z|UTC?|GMT|[+-]\d{2}:?\d{2}))?$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The date exists (no Feb 30 rolled into March). */
function validDate(datePart) {
  const [y, m, d] = datePart.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function normalizeZone(zone) {
  if (/^[+-]\d{2}$/.test(zone)) return `${zone}:00`;
  if (/^[+-]\d{4}$/.test(zone)) return `${zone.slice(0, 3)}:${zone.slice(3)}`;
  return zone;
}

function parts(s) {
  const m = DATE_TIME_RE.exec(s);
  if (m) return { datePart: m[1], timePart: m[2], zone: m[3] };
  const r = RFC_2822_RE.exec(s);
  if (!r) return null;
  const month = MONTHS.indexOf(r[2].toLowerCase());
  if (month < 0) return null;
  const zone = r[5] === undefined ? undefined : /^[+-]/.test(r[5]) ? r[5] : 'Z';
  return { datePart: `${r[3]}-${String(month + 1).padStart(2, '0')}-${r[1].padStart(2, '0')}`, timePart: r[4], zone };
}

/** { allDay, date } | { allDay:false, ms, zoneless } | null */
export function parseDateValue(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return validDate(s) ? { allDay: true, date: s } : null;
  const p = parts(s);
  if (!p || !validDate(p.datePart)) return null;
  if (p.zone === undefined) {
    const [year, month, day] = p.datePart.split('-').map(Number);
    const [hour, minute, second = 0] = p.timePart.split(':').map((x) => Math.floor(Number(x)));
    return { allDay: false, ms: zonedToUtc({ year, month, day, hour, minute, second }, BERLIN), zoneless: true };
  }
  const ms = Date.parse(`${p.datePart}T${p.timePart}${normalizeZone(p.zone)}`);
  return Number.isNaN(ms) ? null : { allDay: false, ms, zoneless: false };
}

function addressText(address) {
  if (typeof address === 'string') return address.trim();
  if (address && typeof address === 'object') {
    return [address.streetAddress, address.postalCode, address.addressLocality].filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()).join(', ');
  }
  return '';
}

function locationOf(node) {
  const loc = Array.isArray(node.location) ? node.location[0] : node.location;
  if (typeof loc === 'string') return loc.trim() || null;
  if (!loc || typeof loc !== 'object') return null;
  const types = Array.isArray(loc['@type']) ? loc['@type'] : [loc['@type']];
  if (types.includes('VirtualLocation')) return 'Online';
  const name = typeof loc.name === 'string' ? singleLineText(loc.name) : '';
  const addr = addressText(loc.address);
  return [name, addr && !name.includes(addr) ? addr : ''].filter(Boolean).join(', ') || null;
}

/** WordPress SEO plugins double-encode descriptions; a second pass undoes it. */
function descriptionText(raw) {
  const first = htmlToText(raw);
  if (!/<[a-z][^>]*>/i.test(first)) return first;
  return htmlToText(first.replace(/\\n/g, '\n'));
}

function tagsOf(node) {
  const k = node.keywords;
  if (typeof k === 'string') return k.split(',').map((t) => t.trim()).filter(Boolean);
  if (Array.isArray(k)) return k.filter((t) => typeof t === 'string').map((t) => t.trim()).filter(Boolean);
  return [];
}

/** Raw events from every schema.org Event on an HTML page. */
export function extractJsonLdEvents(html, pageUrl) {
  const warnings = createWarningSink();
  const nodes = [];
  for (const match of html.matchAll(LD_JSON_SCRIPT_RE)) {
    const raw = match[1] ?? '';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      try {
        parsed = JSON.parse(raw.replace(/<!--[\s\S]*?-->/g, ''));
      } catch {
        warnings.push(`skipped malformed ld+json block: ${e.message}`);
        continue;
      }
    }
    for (const n of collectNodes(parsed)) nodes.push(n);
  }
  const eventNodes = nodes.filter((n) => isEventType(n['@type']));
  if (!eventNodes.length) {
    warnings.push('no schema.org JSON-LD events found on page');
    return { events: [], warnings: warnings.list() };
  }
  const events = [];
  const seen = new Set();
  let zoneless = 0;
  for (const node of eventNodes) {
    const title = typeof node.name === 'string' ? singleLineText(node.name) : '';
    if (!title) { warnings.push('skipped an event without name'); continue; }
    const start = parseDateValue(node.startDate);
    if (!start) { warnings.push(`skipped "${title}": missing/invalid startDate`); continue; }
    const end = parseDateValue(node.endDate);
    const url = safeHttpUrl(node.url, pageUrl) ?? safeHttpUrl(node['@id'], pageUrl);
    const startKey = start.allDay ? start.date : new Date(start.ms).toISOString();
    const uid = `${url ?? `${pageUrl}#${title}`}@${startKey}`;
    if (seen.has(uid)) continue;
    seen.add(uid);
    if (start.zoneless || end?.zoneless) zoneless++;
    const status = typeof node.eventStatus === 'string' && node.eventStatus.includes('EventCancelled') ? 'cancelled' : 'confirmed';
    const common = {
      uid, recurrenceId: '', title,
      description: descriptionText(typeof node.description === 'string' ? node.description : ''),
      location: locationOf(node), url, status, tags: tagsOf(node),
    };
    if (start.allDay) {
      // schema.org endDate is inclusive; events.json ends are exclusive.
      const endDate = end?.allDay ? new Date(Date.parse(`${end.date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : null;
      events.push({ ...common, allDay: true, startDate: start.date, endDate });
    } else {
      events.push({ ...common, allDay: false, startMs: start.ms, endMs: end && !end.allDay ? end.ms : null });
    }
  }
  if (zoneless) warnings.push(`${zoneless} event(s) without time zone read as Europe/Berlin wall clock`);
  return { events, warnings: warnings.list() };
}

/** Adapter entry point: the configured page itself carries the events. */
export async function fetchEvents(source, ctx) {
  const res = await ctx.get(source.url, { accept: 'text/html,application/xhtml+xml' });
  return extractJsonLdEvents(res.body, res.url);
}

/** One request per fetch: a 304 on it means the whole source is unchanged (run.mjs may ask conditionally). */
export const CONDITIONAL = true;
