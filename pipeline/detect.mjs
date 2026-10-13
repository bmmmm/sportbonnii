// Source detection, ported from scalendarii (src/ingest/detect.ts,
// detectSource): any URL of a club — homepage, .ics link, JSON endpoint — to
// the richest machine-readable endpoint behind it. Ladder, first match wins:
//
//   1. the body is iCalendar                  → ical at the given URL
//   2. JSON: a Gancio event array             → gancio
//            The Events Calendar response     → tec
//   3. XML <rss>/<feed>                       → rss
//   4. HTML: origin/feed/json is Gancio       → gancio there
//            WordPress marker + TEC REST API  → tec there
//            a linked iCal export (not on WordPress — TEC's export is the
//            current list page only)          → ical there
//            schema.org Event JSON-LD         → jsonld at the given URL
//            <link rel=alternate rss>         → rss there
//
// Zero dependencies (net.mjs and text helpers only): the intake bot runs it
// without `pnpm install`. The URL the user gave is fetched like a browser
// would; the probes behind it honour robots.txt.
//
// CLI: node pipeline/detect.mjs <url>   → prints a registry source entry
import { fileURLToPath } from 'node:url';
import { createNet } from './net.mjs';
import { decodeEntities } from './text.mjs';
import { EVENT_SUBTYPES } from './adapters/jsonld.mjs';

const MAX_NOTE = 600;
const SUBTYPES = [...EVENT_SUBTYPES].join('|');
const EVENT_TYPE_RE = new RegExp(`"@type"\\s*:\\s*(?:"[^"]*Event"|"(?:${SUBTYPES})"|\\[[^\\]]*"(?:[^"]*Event|${SUBTYPES})")`);

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const tryJson = (s) => { try { return JSON.parse(s); } catch { return undefined; } };

function isGancioPath(url) {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, '');
    return p === '/feed/json' || p === '/api/events';
  } catch {
    return false;
  }
}

function isGancio(json, url) {
  if (!Array.isArray(json)) return false;
  if (json.length === 0) return isGancioPath(url);
  const o = json[0];
  return !!o && typeof o === 'object' && 'start_datetime' in o && ('slug' in o || 'ap_id' in o || 'place' in o);
}

function isTec(json) {
  return !!json && typeof json === 'object' && !Array.isArray(json) && Array.isArray(json.events) && typeof json.rest_url === 'string' && json.rest_url.includes('tribe/events');
}

function xmlRoot(text) {
  const m = /^<([a-zA-Z][\w:-]*)/.exec(text.replace(/^<\?xml[^>]*\?>\s*/i, '').replace(/^(?:<!--[\s\S]*?-->\s*)+/, ''));
  return m ? m[1].toLowerCase() : null;
}

const looksLikeHtml = (t) => /^<!doctype\s+html/i.test(t) || /<html[\s>]/i.test(t) || /<body[\s>]/i.test(t);
const hasWordpress = (html) => /wp-content|wp-json/i.test(html) || /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*WordPress/i.test(html);

function links(html) {
  const out = [];
  for (const m of html.matchAll(/<(?:a|link)\b[^>]*>/gi)) {
    const tag = m[0];
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!href) continue;
    out.push({ href: decodeEntities(href[1]), type: /\btype\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1], rel: /\brel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] });
  }
  return out;
}

function resolve(href, base) {
  try {
    const u = new URL(href, base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function icalLinks(list, base) {
  const out = [];
  for (const l of list) {
    const path = l.href.split('?')[0];
    const isIcal = /\.ics$/i.test(path) || /^webcal:\/\//i.test(l.href) || /text\/calendar/i.test(l.type ?? '')
      || (l.href.includes('?export') && /dav|calendar/i.test(l.href))
      || /calendar\.google\.com\/calendar\/ical\//i.test(l.href);
    if (!isIcal) continue;
    const href = /^webcal:\/\//i.test(l.href) ? `https://${l.href.slice(9)}` : l.href;
    const r = resolve(href, base);
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}

/** A Google Calendar embed (iframe src=…/calendar/embed?src=<id>) → its public ICS URL. */
function googleEmbed(html) {
  const m = /calendar\.google\.com\/calendar\/(?:u\/\d+\/)?embed\?[^"'>]*?\bsrc=([^&"'>]+)/i.exec(html);
  if (!m) return null;
  const id = decodeURIComponent(decodeEntities(m[1]));
  return `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`;
}

function hasJsonLdEvent(html) {
  for (const m of html.matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    if (EVENT_TYPE_RE.test(m[1]) || m[1].includes('schema.org/Event')) return true;
  }
  return false;
}

const unsupported = (url) => `could not find a supported calendar at ${url} — supported: iCal (.ics/webcal, Google Calendar embeds), Gancio, WordPress The Events Calendar, schema.org Event JSON-LD, RSS`;

/**
 * Detect the richest source behind `url`. opts.net: a createNet() client
 * (default: a fresh one). → { ok: true, type, url, note } | { ok: false, diagnosis }
 */
export async function detectSource(url, opts = {}) {
  const net = opts.net ?? createNet();
  // The given URL is fetched like a browser asks for a page: Gancio answers a
  // homepage request that prefers text/calendar with its ICS export.
  const PAGE = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8';
  const API = 'application/json, application/xml;q=0.9, */*;q=0.5';
  const get = (u, robots, accept = API) => net.get(u, { accept, robots });
  let first;
  let pageUrl = url;
  try {
    first = await get(url, false, PAGE);
    // A meta refresh (www.bthv.de → /blog) is followed once.
    const refresh = /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>\s]+)/i.exec(first.body);
    const target = refresh && first.body.length < 4096 ? resolve(decodeEntities(refresh[1]), first.url) : null;
    if (target && target !== first.url) {
      first = await get(target, false, PAGE);
      pageUrl = target;
    }
  } catch (e) {
    return { ok: false, diagnosis: `could not fetch ${url}: ${e.message}` };
  }
  const result = await ladder(pageUrl, first, get);
  return result.ok && result.note.length > MAX_NOTE ? { ...result, note: `${result.note.slice(0, MAX_NOTE - 1)}…` } : result;
}

async function ladder(url, first, get) {
  const body = first.body;
  const trimmed = stripBom(body).trim();
  const base = first.url;
  if (trimmed.startsWith('BEGIN:VCALENDAR')) return { ok: true, type: 'ical', url, note: 'the URL serves an iCalendar document' };
  const json = tryJson(trimmed);
  if (json !== undefined) {
    if (isGancio(json, url)) return { ok: true, type: 'gancio', url, note: 'JSON array shaped like a Gancio event export' };
    if (isTec(json)) return { ok: true, type: 'tec', url, note: 'The Events Calendar REST response' };
    return { ok: false, diagnosis: `${url} returned JSON, but neither a Gancio event array nor a The Events Calendar response` };
  }
  const root = xmlRoot(trimmed);
  if (root === 'rss' || root === 'feed') return { ok: true, type: 'rss', url, note: `the URL serves an XML <${root}> feed — events come from the item pages' JSON-LD` };
  if (!looksLikeHtml(trimmed)) return { ok: false, diagnosis: unsupported(url) };

  const origin = new URL(base).origin;
  const probe = async (path, test) => {
    const u = new URL(path, origin).toString(); // an absolute path ignores origin
    try {
      const r = await get(u, true);
      const j = tryJson(stripBom(r.body).trim());
      return j !== undefined && test(j, u) ? u : null;
    } catch {
      return null;
    }
  };
  const gancio = await probe('/feed/json', isGancio);
  if (gancio) return { ok: true, type: 'gancio', url: new URL('/api/events', origin).toString(), note: `Gancio instance (found ${gancio})` };
  const wordpress = hasWordpress(body);
  const list = links(body);
  if (wordpress) {
    // WordPress in a subdirectory announces its REST root: <link rel="https://api.w.org/" href="…/wp-json/">.
    const apiRoot = list.find((l) => l.rel === 'https://api.w.org/')?.href;
    const root = (apiRoot && resolve(apiRoot, base)) || new URL('/wp-json/', origin).toString();
    const tec = await probe(new URL('tribe/events/v1/events', root.endsWith('/') ? root : `${root}/`).toString(), (j) => isTec(j));
    if (tec) return { ok: true, type: 'tec', url: tec, note: 'WordPress site with The Events Calendar — its REST API is richer than any export' };
  }
  const google = googleEmbed(body);
  // On WordPress, plain .ics links are TEC's export of the current list page only; a Google embed is not.
  const icals = [...(google ? [google] : []), ...(wordpress ? [] : icalLinks(list, base))].filter((v, i, a) => a.indexOf(v) === i);
  if (icals.length) {
    const others = icals.slice(1, 4).filter((u) => u.length <= 160);
    return {
      ok: true, type: 'ical', url: icals[0],
      note: google && icals[0] === google ? 'the page embeds a public Google Calendar'
        : others.length ? `the page links ${icals.length} iCal exports — took the first; if it is a single-event export, use one of: ${others.join(', ')}`
          : 'the page links an iCal export',
    };
  }
  if (hasJsonLdEvent(body)) return { ok: true, type: 'jsonld', url, note: 'the page embeds schema.org Event JSON-LD' };
  const rss = list.find((l) => /alternate/i.test(l.rel ?? '') && /rss\+xml|atom\+xml/i.test(l.type ?? ''));
  const rssUrl = rss ? resolve(rss.href, base) : null;
  if (rssUrl) return { ok: true, type: 'rss', url: rssUrl, note: 'only an RSS feed found — events come from item pages that carry JSON-LD (often none)' };
  return { ok: false, diagnosis: unsupported(url) };
}

const SOURCE_IDS = { ical: 'kalender', tec: 'termine', gancio: 'termine', jsonld: 'termine', rss: 'feed' };

/** The registry source entry for a detection result. */
export function sourceSnippet(result) {
  return { id: SOURCE_IDS[result.type], type: result.type, url: result.url };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: pnpm run detect <url>');
    process.exitCode = 2;
  } else {
    const r = await detectSource(url);
    if (r.ok) {
      console.error(`${r.type}: ${r.note}`);
      console.log(JSON.stringify(sourceSnippet(r), null, 2));
    } else {
      console.error(r.diagnosis);
      process.exitCode = 1;
    }
  }
}
