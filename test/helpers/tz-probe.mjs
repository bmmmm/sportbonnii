// Prints conversions and a parsed DST series; model.test.mjs runs this under
// several TZ values and requires identical output.
import { readFileSync } from 'node:fs';
import { toBerlinIso, zonedToUtc, berlinDate, berlinMidnight } from '../../pipeline/tz.mjs';
import { parseIcal } from '../../pipeline/adapters/ical.mjs';
import { windowMs } from '../../pipeline/model.mjs';

const lines = [
  toBerlinIso(Date.parse('2026-10-25T01:30:00Z')),
  toBerlinIso(zonedToUtc({ year: 2026, month: 7, day: 1, hour: 12 })),
  berlinDate(Date.parse('2026-12-31T23:30:00Z')),
  new Date(berlinMidnight('2026-11-01')).toISOString(),
];
const ics = readFileSync(new URL('../fixtures/ical/edge-cases.ics', import.meta.url), 'utf8');
for (const e of parseIcal(ics, windowMs({ from: '2026-09-01', to: '2027-11-01' })).events) {
  lines.push(`${e.uid} ${e.allDay ? `${e.startDate}/${e.endDate}` : toBerlinIso(e.startMs)}`);
}
console.log(lines.join('\n'));
