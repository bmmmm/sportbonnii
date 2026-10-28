// Date-dependent source warnings belong in meta.json, so status and feeds
// remain unchanged when the clock advances without news from a source.
import { addDays } from './tz.mjs';

export const NOTICE_DAYS = 30;

/** Advisory warnings; a season ending is not a failed fetch and never drops dates. */
export function sourceWarnings({ registry, events, status, today }) {
  const bySource = new Map();
  for (const e of events) {
    const delivery = bySource.get(e.source) ?? { dates: [], count: 0 };
    delivery.count++;
    if (e.status !== 'cancelled' && e.start.slice(0, 10) >= today) delivery.dates.push(e.start.slice(0, 10));
    bySource.set(e.source, delivery);
  }
  const warnings = [];
  const soon = addDays(today, NOTICE_DAYS);
  for (const owner of [...registry.clubs, ...registry.platforms]) for (const source of owner.sources) {
    const key = `${owner.id}/${source.id}`;
    if (source.enabled === false || owner.active === false) continue;
    let warning;
    if (source.reviewAfter && source.reviewAfter <= soon) {
      warning = { code: 'review', message: `Kalender zum Saisonwechsel prüfen (Prüftermin: ${source.reviewAfter}).` };
    } else if (status[key]?.state === 'ok' && !source.expectEmpty) {
      // Delivered count includes dedup losers; their absence in events.json is not an empty delivery.
      const { dates, count } = bySource.get(key) ?? { dates: [], count: 0 };
      if (status[key].count !== count) continue; // Incomplete deliveries cannot establish a source's horizon.
      if (count === 0 || (source.kind === 'spiel' && !dates.length)) {
        warning = { code: 'empty', message: 'Keine kommenden Termine veröffentlicht. Kalender und Saison prüfen.' };
      } else if (source.kind === 'spiel' && dates.length) {
        const last = dates.reduce((a, b) => a > b ? a : b);
        if (last <= soon) warning = { code: 'ending', message: `Spielplan reicht nur bis ${last}. Folgetermine oder Saisonwechsel prüfen.` };
      }
    }
    if (warning) warnings.push({ source: key, ...warning });
  }
  return warnings;
}
