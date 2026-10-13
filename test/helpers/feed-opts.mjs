// The options the pinned feed test/fixtures/ics/alle.ics was written with —
// shared by test/ics.test.mjs and the web-smoke gate.
import { readFileSync } from 'node:fs';

const json = (n) => JSON.parse(readFileSync(new URL(`../fixtures/site-data/${n}`, import.meta.url), 'utf8'));
const events = json('events.json');

export const SNAPSHOT_EVENTS = events.events;
export const FEED_OPTS = {
  name: 'Sport in Bonn – alle Termine',
  windowFrom: events.window.from,
  labels: Object.fromEntries(json('sports.json').sports.map((s) => [s.id, s.label])),
  clubNames: Object.fromEntries(json('clubs.json').clubs.map((c) => [c.id, c.name])),
};
