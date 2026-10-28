// DAV Bonn publishes a complete, server-rendered overview instead of a feed.
// Import the selected activity cards, linking each to its original details.
// The overview gives dates only: one-day entries explicitly have an unknown
// time; multi-day tours use an exclusive date end. Never invent an hour.
import { htmlToText, decodeEntities } from '../text.mjs';
import { addDays } from '../tz.mjs';

export const CONDITIONAL = true;
export const MAX_EVENTS = 500;

function dateValue(text) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const time = Date.parse(iso);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === iso ? iso : null;
}

export function parseOverview(html, baseUrl, activities) {
  if (!/\bisotope-container\b/.test(html)) throw new Error('DAV calendar layout changed: event container missing');
  const chunks = html.split(/<div\b[^>]*class=["'][^"']*\bisotope-item\b[^"']*\bactivity-(\d+)[^"']*["'][^>]*>/i);
  const events = [];
  const warnings = [];
  let broken = false;
  for (let i = 1; i < chunks.length; i += 2) {
    if (!activities.includes(chunks[i])) continue;
    if (events.length >= MAX_EVENTS) { broken = true; warnings.push(`DAV overview capped at ${MAX_EVENTS} events`); break; }
    const card = chunks[i + 1];
    const title = htmlToText(/<h4\b[^>]*>([\s\S]*?)<\/h4>/i.exec(card)?.[1] ?? '').trim();
    const dates = htmlToText(/<p\b[^>]*class=["']no-m["'][^>]*>([\s\S]*?)<\/p>/i.exec(card)?.[1] ?? '').trim().split(/\s+[–-]\s+/);
    const start = dateValue(dates[0]);
    const last = dates.length === 2 ? dateValue(dates[1]) : start;
    const href = /<a\b[^>]*class=["']overlay-link["'][^>]*href=["']([^"']+)["']/i.exec(card)?.[1];
    let url;
    try { url = new URL(decodeEntities(href ?? ''), baseUrl); } catch { /* rejected below */ }
    if (!title || !start || !last || last < start || dates.length > 2 || !href || !url || url.origin !== new URL(baseUrl).origin || !url.pathname.startsWith('/termine/')) {
      broken = true;
      warnings.push('DAV overview: skipped an invalid activity card');
      continue;
    }
    events.push({ uid: url.pathname, title, allDay: true, startDate: start, endDate: addDays(last, 1),
      ...(last === start ? { timeUnknown: true } : {}), url: url.href, tags: [], location: null, description: null, status: 'confirmed' });
  }
  if (chunks.length === 1 && !/Keine Termine in der ausgewählten Kategorie/.test(html)) throw new Error('DAV calendar layout changed: activity cards missing');
  return { events, warnings, ...(broken ? { partial: { reason: 'DAV overview contains invalid or truncated cards' } } : {}) };
}

export async function fetchEvents(source, { get }) {
  const response = await get(source.url);
  return parseOverview(response.body, response.url, source.params?.activities ?? ['10', '11']);
}
