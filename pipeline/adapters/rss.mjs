// RSS/Atom adapter, ported from scalendarii (src/ingest/adapters/rss.ts) —
// a change signal, never the data itself: the feed only yields item links,
// and each item page's schema.org JSON-LD supplies the event. The XML is read
// with a few regular expressions instead of fast-xml-parser: only <item>/<entry>
// links and dates are needed.
import { decodeEntities, createWarningSink } from '../text.mjs';
import { extractJsonLdEvents } from './jsonld.mjs';

export const MAX_ITEMS = 25;
const ITEM_BUDGET_MS = 120_000;

const blocks = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'))].map((m) => m[1]);

function textOf(xml, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml);
  if (!m) return null;
  const inner = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
  return decodeEntities(inner).trim() || null;
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag);
  return m ? decodeEntities(m[1]) : null;
}

/** [{ link, title, publishedMs }] from an RSS 2.0 or Atom body. */
export function feedItems(xml) {
  const body = xml.replace(/^\uFEFF/, '');
  const dateMs = (s) => { const t = s ? Date.parse(s) : NaN; return Number.isNaN(t) ? null : t; };
  if (/<rss\b/i.test(body) || /<channel\b/i.test(body)) {
    return blocks(body, 'item').map((item) => {
      let link = textOf(item, 'link');
      if (!link) {
        const guid = /<guid\b([^>]*)>([\s\S]*?)<\/guid>/i.exec(item);
        if (guid && /isPermaLink\s*=\s*["']true["']/i.test(guid[1])) link = decodeEntities(guid[2]).trim();
      }
      return { link, title: textOf(item, 'title'), publishedMs: dateMs(textOf(item, 'pubDate')) };
    });
  }
  if (/<feed\b/i.test(body)) {
    return blocks(body, 'entry').map((entry) => {
      const links = [...entry.matchAll(/<link\b[^>]*>/gi)].map((m) => ({ href: attr(m[0], 'href'), rel: attr(m[0], 'rel') }));
      const chosen = links.find((l) => l.rel === 'alternate') ?? links.find((l) => l.rel === null) ?? links[0];
      return { link: chosen?.href ?? null, title: textOf(entry, 'title'), publishedMs: dateMs(textOf(entry, 'updated') ?? textOf(entry, 'published')) };
    });
  }
  throw new Error('unrecognised feed format: expected an RSS <rss>/<channel> or an Atom <feed> document');
}

const sameSite = (a, b) => a.replace(/^www\./i, '').toLowerCase() === b.replace(/^www\./i, '').toLowerCase();

/** Adapter entry point. */
export async function fetchEvents(source, ctx) {
  const warnings = createWarningSink();
  const feed = await ctx.get(source.url, { accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5' });
  const feedHost = new URL(feed.url).hostname;
  const links = [];
  for (const it of feedItems(feed.body)) {
    let url = null;
    try { url = it.link ? new URL(it.link, feed.url) : null; } catch { url = null; }
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) { warnings.push(`skipped "${it.title ?? '?'}": no usable link`); continue; }
    if (!sameSite(url.hostname, feedHost)) { warnings.push(`skipped "${it.title ?? '?'}": link leaves the feed's host`); continue; }
    links.push({ url: url.toString(), publishedMs: it.publishedMs });
  }
  if (links.length && links.every((l) => l.publishedMs !== null)) links.sort((a, b) => b.publishedMs - a.publishedMs);
  const unique = [...new Set(links.map((l) => l.url))];
  let partial;
  const toFetch = unique.slice(0, MAX_ITEMS);
  if (unique.length > MAX_ITEMS) {
    warnings.push(`feed lists ${unique.length} items, only the newest ${MAX_ITEMS} are read`);
    partial = { reason: `only the newest ${MAX_ITEMS} of ${unique.length} item pages read` };
  }
  const events = [];
  const seen = new Set();
  const deadline = Date.now() + ITEM_BUDGET_MS;
  let pagesWithEvents = 0;
  for (const [i, link] of toFetch.entries()) {
    if (Date.now() > deadline) {
      warnings.push(`item budget exhausted, ${toFetch.length - i} item page(s) skipped`);
      partial ??= { reason: 'item-page budget exhausted' };
      break;
    }
    let page;
    try {
      page = await ctx.get(link, { accept: 'text/html,application/xhtml+xml', timeoutMs: 15_000 });
    } catch (e) {
      warnings.push(`${link}: ${e.message}`);
      partial ??= { reason: `item page ${link} could not be fetched` };
      continue;
    }
    const r = extractJsonLdEvents(page.body, page.url);
    if (r.events.length) pagesWithEvents++;
    for (const e of r.events) {
      if (seen.has(e.uid)) continue;
      seen.add(e.uid);
      events.push(e);
    }
  }
  if (toFetch.length && !pagesWithEvents) warnings.push(`none of the ${toFetch.length} item pages carries schema.org Event JSON-LD`);
  return { events, warnings: warnings.list(), ...(partial ? { partial } : {}) };
}

/** Several requests per fetch (pages or item pages): a 304 on the first would hide changes behind it, so run.mjs never asks conditionally. */
export const CONDITIONAL = false;
