// Adapter registry. One file per source type; a v2 portal adapter is one new
// file plus one entry here. Loading is lazy so that the registry validator
// and the intake bot (which run without `pnpm install`) never pull in
// ical.js through this module.

export const ADAPTER_TYPES = ['ical', 'tec', 'gancio', 'jsonld', 'rss'];

/**
 * The adapter module for `type`: `{ fetchEvents(source, ctx) → { events,
 * warnings, partial? }, CONDITIONAL }` — CONDITIONAL is true only for
 * single-request adapters, where a 304 on that request stands for the source.
 */
export async function loadAdapter(type) {
  if (!ADAPTER_TYPES.includes(type)) throw new Error(`unknown source type "${type}"`);
  return import(`./${type}.mjs`);
}
