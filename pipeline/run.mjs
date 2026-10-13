// The ingest run: registry → every enabled source → normalised, merged,
// deduplicated → site/data/{events,status,clubs,sports,meta}.json and the
// ICS feeds site/data/ics/{alle,sport-<id>,verein-<id>}.ics.
//
// Window: the 1st of the previous month up to the 1st of the month 13 months
// ahead (Berlin), so it moves monthly and two runs in one month agree.
// Previous state: site/data/ when present, else $PREVIOUS_STATE_URL (the live
// site); anything that fails the shape check is ignored.
//
// Prints a Markdown summary (the CI job summary) on stdout, warnings on
// stderr. Exits non-zero only for an invalid registry or a write error.
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry, REGISTRY_DIR } from './registry.mjs';
import { loadAdapter } from './adapters/index.mjs';
import { createNet, NetError } from './net.mjs';
import { buildContext, normalizeEvent } from './model.mjs';
import { mergeRun } from './merge.mjs';
import { formatEventsJson, formatJson, checkEvent, STATES } from './contract.mjs';
import { addMonths, berlinDate } from './tz.mjs';
import { serializeFeed } from '../site/ics.js';

export const DEFAULT_OUT = fileURLToPath(new URL('../site/data/', import.meta.url));
export const MAX_PARALLEL = 4;
export const WARN_ABOVE = 5000;

/** The data window for the Berlin day `today`. */
export function windowFor(today) {
  return { from: addMonths(today, -1), to: addMonths(today, 13) };
}

/** Previous events/status if they pass the shape check, else null. */
export function acceptPrevious(eventsDoc, statusDoc) {
  if (!eventsDoc || eventsDoc.version !== 1 || !Array.isArray(eventsDoc.events)) return null;
  if (eventsDoc.events.some((e) => checkEvent(e).length)) return null;
  if (!statusDoc || typeof statusDoc !== 'object' || Array.isArray(statusDoc)) return null;
  for (const s of Object.values(statusDoc)) {
    if (!s || !STATES.includes(s.state) || !/^\d{4}-\d{2}-\d{2}$/.test(s.since)) return null;
  }
  return { events: eventsDoc.events, status: statusDoc };
}

async function readPrevious({ outDir, previousStateUrl, fetchImpl, log }) {
  try {
    const ev = JSON.parse(await readFile(join(outDir, 'events.json'), 'utf8'));
    const st = JSON.parse(await readFile(join(outDir, 'status.json'), 'utf8'));
    const ok = acceptPrevious(ev, st);
    if (ok) return { ...ok, from: 'local' };
    log(`previous state in ${outDir} failed the shape check — ignored`);
  } catch {
    // no local state
  }
  if (!previousStateUrl) return null;
  try {
    const base = previousStateUrl.endsWith('/') ? previousStateUrl : `${previousStateUrl}/`;
    const get = async (name) => {
      const r = await fetchImpl(new URL(name, base), { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${name}`);
      return r.json();
    };
    const ok = acceptPrevious(await get('events.json'), await get('status.json'));
    if (ok) return { ...ok, from: base };
    log(`previous state at ${base} failed the shape check — ignored`);
  } catch (e) {
    log(`previous state not available (${e.message})`);
  }
  return null;
}

/** Interleave tasks by host so the parallel slots hit different hosts. */
function interleaveByHost(tasks) {
  const byHost = new Map();
  for (const t of tasks) {
    const host = new URL(t.source.url).host;
    (byHost.get(host) ?? byHost.set(host, []).get(host)).push(t);
  }
  const queues = [...byHost.values()];
  const out = [];
  while (queues.some((q) => q.length)) for (const q of queues) if (q.length) out.push(q.shift());
  return out;
}

async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Run the pipeline. Options (all optional): registryDir, outDir, now (Date),
 * fetchImpl, lookupImpl, sleep, minGapMs, previousStateUrl, log, out.
 * Returns { events, status, summary, warnings }.
 */
export async function run(opts = {}) {
  const {
    registryDir = REGISTRY_DIR,
    outDir = DEFAULT_OUT,
    now = new Date(),
    fetchImpl = globalThis.fetch,
    previousStateUrl = process.env.PREVIOUS_STATE_URL,
    log = (m) => console.error(m),
  } = opts;
  const registry = await loadRegistry(registryDir);
  const today = berlinDate(now.getTime());
  const window = windowFor(today);
  const net = createNet({ fetchImpl, lookupImpl: opts.lookupImpl, sleep: opts.sleep, minGapMs: opts.minGapMs });
  const ctx = buildContext(registry);
  const previous = await readPrevious({ outDir, previousStateUrl, fetchImpl, log });

  const owners = [
    ...registry.clubs.map((o) => ({ owner: o, kind: 'club' })),
    ...registry.platforms.map((o) => ({ owner: o, kind: 'platform' })),
  ];
  const order = new Map();
  const tasks = [];
  const results = new Map();
  const warnings = [];
  for (const { owner, kind } of owners) {
    for (const source of owner.sources) {
      const key = `${owner.id}/${source.id}`;
      order.set(key, order.size);
      results.set(key, null); // keeps registry order in status.json-independent output
      if (source.enabled === false || owner.active === false) results.set(key, { state: 'disabled', events: [] });
      else tasks.push({ key, owner, kind, source });
    }
  }

  await pool(interleaveByHost(tasks), MAX_PARALLEL, async ({ key, owner, kind, source }) => {
    let r;
    try {
      const adapter = await loadAdapter(source.type);
      r = await adapter.fetchEvents(source, { window, today, get: net.get });
    } catch (e) {
      const blocked = e instanceof NetError && e.kind === 'blocked';
      results.set(key, { state: blocked ? 'blocked' : 'error', events: [], error: e.message });
      log(`${key}: ${blocked ? 'blocked' : 'error'} — ${e.message}`);
      return;
    }
    const seen = new Set();
    const events = [];
    for (const raw of r.events) {
      const e = normalizeEvent(raw, { owner, kind, source, ctx, window });
      if (!e) continue;
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      events.push(e);
    }
    for (const w of r.warnings ?? []) warnings.push(`${key}: ${w}`);
    results.set(key, { state: r.partial ? 'partial' : 'ok', events, ...(r.partial ? { error: r.partial.reason } : {}) });
  });

  const merged = mergeRun({ results, previous, order, window, today });
  warnings.push(...merged.warnings);
  if (merged.events.length > WARN_ABOVE) warnings.push(`${merged.events.length} events — above ${WARN_ABOVE}, the table starts to get heavy`);

  await writeOutputs({ outDir, registry, window, events: merged.events, status: merged.status, now });
  const summary = summarize({ results, merged, previous, order });
  for (const w of warnings) log(`warning: ${w}`);
  return { events: merged.events, status: merged.status, summary, warnings, window };
}

/** Registry copy for the page: notes stripped. */
export function publicRegistry(registry) {
  const strip = (o) => ({ ...o, sources: o.sources.map(({ note, ...s }) => s) });
  return { clubs: registry.clubs.map(strip), platforms: registry.platforms.map(strip) };
}

async function writeOutputs({ outDir, registry, window, events, status, now }) {
  const icsDir = join(outDir, 'ics');
  await mkdir(icsDir, { recursive: true });
  for (const f of await readdir(icsDir)) if (f.endsWith('.ics')) await rm(join(icsDir, f));
  const enabled = Object.values(status).filter((s) => s.state !== 'disabled');
  const files = {
    'events.json': formatEventsJson({ window, events }),
    'status.json': formatJson(status),
    'clubs.json': formatJson(publicRegistry(registry)),
    'sports.json': formatJson({ sports: registry.sports }),
    'meta.json': formatJson({
      checkedAt: now.toISOString(),
      sourcesOk: enabled.filter((s) => s.state === 'ok' || s.state === 'partial').length,
      sourcesTotal: enabled.length,
    }),
  };
  for (const [name, text] of Object.entries(files)) await writeFile(join(outDir, name), text);

  const labels = Object.fromEntries(registry.sports.map((s) => [s.id, s.label]));
  const clubNames = Object.fromEntries(registry.clubs.map((c) => [c.id, c.name]));
  const feed = (name, list) => serializeFeed(list, { name, windowFrom: window.from, labels, clubNames });
  await writeFile(join(icsDir, 'alle.ics'), feed('Sport in Bonn – alle Termine', events));
  for (const s of registry.sports) {
    await writeFile(join(icsDir, `sport-${s.id}.ics`), feed(`Sport in Bonn – ${s.label}`, events.filter((e) => e.sports.includes(s.id))));
  }
  for (const c of registry.clubs) {
    await writeFile(join(icsDir, `verein-${c.id}.ics`), feed(`${c.name} – Termine`, events.filter((e) => e.club === c.id)));
  }
}

function summarize({ results, merged, previous, order }) {
  const prevCount = new Map();
  for (const e of previous?.events ?? []) prevCount.set(e.source, (prevCount.get(e.source) ?? 0) + 1);
  const rows = [...order.keys()].map((key) => {
    const s = merged.status[key];
    const before = prevCount.get(key) ?? 0;
    const delta = s.count - before;
    const sign = delta > 0 ? `+${delta}` : delta < 0 ? `−${-delta}` : '±0';
    return `| ${key} | ${s.state} | ${s.count} | ${previous ? sign : 'new'} | ${(s.error ?? results.get(key)?.error ?? '').replace(/\|/g, '/')} |`;
  });
  const total = merged.events.length;
  const before = previous?.events.length ?? 0;
  return [
    `## sportbonnii fetch — ${total} events${previous ? ` (${total - before >= 0 ? '+' : '−'}${Math.abs(total - before)})` : ''}`,
    '',
    '| source | state | events | change | note |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `${merged.dropped} cross-source duplicate(s) dropped${merged.allFailed ? ' · ALL SOURCES FAILED — previous events kept' : ''}`,
  ].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { summary } = await run();
    console.log(summary);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
