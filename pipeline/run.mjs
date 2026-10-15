// The ingest run: registry → every enabled source → normalised, merged,
// deduplicated → site/data/{events,status,clubs,sports,meta}.json and the
// ICS feeds site/data/ics/{alle,sport-<id>,verein-<id>}.ics.
//
// Window: the 1st of the previous month up to the 1st of the month 13 months
// ahead (Berlin), so it moves monthly and two runs in one month agree.
// Previous state: site/data/ when present, else $PREVIOUS_STATE_URL (the live
// site); anything that fails the shape check is ignored. Events published
// before the `kind` or `home` field get them first (upgradeLegacyEvent).
//
// Only sources with news are re-read in full. A single-request adapter
// (CONDITIONAL: ical, gancio, jsonld) whose last ok answer carried an ETag or
// Last-Modified is asked conditionally, and a 304 keeps its previous events
// untouched. That reuse needs a previous state produced by the same build
// ($BUILD_ID, the commit — set by the Pages workflow, unset locally and on a
// manual full run) for the same window, and events.json holding the source's
// whole delivery (a dedup loser is read in full). A registry or code change
// is a new build and refetches everything. Change detection itself (`changed`
// in status.json) compares the published events with their previous version
// and therefore works for servers without validators too.
//
// Prints a Markdown summary (the CI job summary) on stdout, warnings on
// stderr. Exits non-zero only for an invalid registry or a write error.
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry, REGISTRY_DIR } from './registry.mjs';
import { loadAdapter } from './adapters/index.mjs';
import { createNet, NetError } from './net.mjs';
import { buildContext, normalizeEvent, eventKind, homeGame, titleCancels } from './model.mjs';
import { mergeRun } from './merge.mjs';
import { formatEventsJson, formatJson, checkEvent, EVENT_KEYS, STATES } from './contract.mjs';
import { addMonths, berlinDate } from './tz.mjs';
import { serializeFeed } from '../site/ics.js';

export const DEFAULT_OUT = fileURLToPath(new URL('../site/data/', import.meta.url));
export const MAX_PARALLEL = 4;
export const WARN_ABOVE = 5000;

/** The data window for the Berlin day `today`. */
export function windowFor(today) {
  return { from: addMonths(today, -1), to: addMonths(today, 13) };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Earlier contract versions: before `kind` and `home`, and before `home`.
const LEGACY_SHAPES = [['kind', 'home'], ['home']].map((missing) => EVENT_KEYS.filter((k) => !missing.includes(k)).join());

/**
 * An event published before events carried a `kind` or `home` gets them from
 * its title (and, for `home`, its location and the club's venues), keys in
 * contract order; anything else is returned as it is. Known limit: tags and
 * the source's `kind` are not in events.json, so on the first run after the
 * upgrade `changed` moves for a source whose fresh kind needs them.
 * `clubsById` maps registry club ids to clubs (for their venues).
 */
export function upgradeLegacyEvent(e, clubsById = new Map()) {
  if (!e || typeof e !== 'object' || !LEGACY_SHAPES.includes(Object.keys(e).join()) || typeof e.title !== 'string') return e;
  const kind = 'kind' in e ? e.kind : eventKind(e.title, [], null);
  const home = homeGame(e.title, e.location, clubsById.get(e.club) ?? null, kind);
  return Object.fromEntries(EVENT_KEYS.map((k) => [k, k === 'kind' ? kind : k === 'home' ? home : e[k]]));
}

const KEEP = 'keep';
// eventKind's precedence: a training word beats a celebration, which beats a match word.
const KIND_RANK = { spiel: 1, veranstaltung: 2, training: 3 };

/**
 * A previous event under today's rules: kind, home and a title's cancellation
 * are derived again, so a rule change reaches the events a failing source
 * keeps (and the comparison behind `changed` sees the same rules on both
 * sides). Only the title is left of the raw event, and tags only ever raise
 * the kind (training over a celebration over a match): the title's kind
 * replaces the old one only where it ranks higher, so under unchanged rules
 * nothing moves (known limit: a rule that lowers a kind waits for the
 * source to answer);
 * a cancellation is only ever added: events.json cannot tell the feed's
 * from the title's, so a rule that narrows cancel words waits for the source.
 */
export function refreshEvent(e, clubsById = new Map()) {
  const byTitle = eventKind(e.title, [], { kind: KEEP });
  const kind = byTitle === KEEP || KIND_RANK[e.kind] > KIND_RANK[byTitle] ? e.kind : byTitle;
  const home = homeGame(e.title, e.location, clubsById.get(e.club) ?? null, kind);
  const status = e.status === 'cancelled' || titleCancels(e.title) ? 'cancelled' : 'confirmed';
  if (kind === e.kind && home === e.home && status === e.status) return e;
  return { ...e, kind, home, status };
}

/**
 * Previous events/status if they pass the shape check, else null. The window
 * and the build (meta.json, optional) decide whether validators may be reused.
 */
export function acceptPrevious(eventsDoc, statusDoc, metaDoc = null, clubsById = new Map()) {
  if (!eventsDoc || eventsDoc.version !== 1 || !Array.isArray(eventsDoc.events)) return null;
  const events = eventsDoc.events.map((e) => upgradeLegacyEvent(e, clubsById));
  if (events.some((e) => checkEvent(e).length)) return null;
  if (!statusDoc || typeof statusDoc !== 'object' || Array.isArray(statusDoc)) return null;
  for (const s of Object.values(statusDoc)) {
    if (!s || !STATES.includes(s.state) || !DATE.test(s.since)) return null;
  }
  const w = eventsDoc.window;
  const window = w && DATE.test(w.from) && DATE.test(w.to) ? { from: w.from, to: w.to } : null;
  const build = typeof metaDoc?.build === 'string' && metaDoc.build ? metaDoc.build : null;
  return { events, status: statusDoc, window, build };
}

async function readPrevious({ outDir, previousStateUrl, fetchImpl, log, clubsById }) {
  const parse = async (name) => JSON.parse(await readFile(join(outDir, name), 'utf8'));
  try {
    const ev = await parse('events.json');
    const st = await parse('status.json');
    const meta = await parse('meta.json').catch(() => null);
    const ok = acceptPrevious(ev, st, meta, clubsById);
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
    const ok = acceptPrevious(await get('events.json'), await get('status.json'), await get('meta.json').catch(() => null), clubsById);
    if (ok) return { ...ok, from: base };
    log(`previous state at ${base} failed the shape check — ignored`);
  } catch (e) {
    log(`previous state not available (${e.message})`);
  }
  return null;
}

/** Thrown by a source's first request when the server answered 304 to our validators. */
class NotModified extends Error {
  constructor() {
    super('not modified');
    this.name = 'NotModified';
  }
}

/**
 * A `get` for one source: its first request carries the previous validators
 * when `validators` is set and throws NotModified on a 304; the validators of
 * the first answer are recorded in `box.validators` for the next run.
 */
function sourceGet(get, validators, box) {
  let first = true;
  return async (url, opts = {}) => {
    if (!first) return get(url, opts);
    first = false;
    const res = await get(url, { ...opts, ...(validators ? { ifNoneMatch: validators.etag, ifModifiedSince: validators.lastModified } : {}) });
    if (res.notModified) throw new NotModified();
    box.validators = { etag: res.etag, lastModified: res.lastModified };
    return res;
  };
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
 * fetchImpl, lookupImpl, sleep, minGapMs, previousStateUrl, build (the
 * commit producing this data; default $BUILD_ID), log.
 * Returns { events, status, summary, warnings, window }.
 */
export async function run(opts = {}) {
  const {
    registryDir = REGISTRY_DIR,
    outDir = DEFAULT_OUT,
    now = new Date(),
    fetchImpl = globalThis.fetch,
    previousStateUrl = process.env.PREVIOUS_STATE_URL,
    build = process.env.BUILD_ID || null,
    log = (m) => console.error(m),
  } = opts;
  const registry = await loadRegistry(registryDir);
  const today = berlinDate(now.getTime());
  const window = windowFor(today);
  const net = createNet({ fetchImpl, lookupImpl: opts.lookupImpl, sleep: opts.sleep, minGapMs: opts.minGapMs });
  const ctx = buildContext(registry);
  const clubsById = new Map(registry.clubs.map((c) => [c.id, c]));
  const previous = await readPrevious({ outDir, previousStateUrl, fetchImpl, log, clubsById });
  log(previous ? `previous state: ${previous.events.length} events from ${previous.from}` : 'previous state: none (first run)');
  // Another build may have other rules: the previous events are classified again (the same build's are as it left them).
  if (previous && !(build && previous.build === build)) previous.events = previous.events.map((e) => refreshEvent(e, clubsById));
  // Validators may be reused only against a state the very same build produced for the same window.
  const reusable = Boolean(build && previous && previous.build === build && previous.window
    && previous.window.from === window.from && previous.window.to === window.to);
  log(`conditional requests: ${reusable ? 'on' : 'off'} (build ${build ?? 'unknown'}, previous ${previous?.build ?? 'unknown'}, window ${previous?.window ? `${previous.window.from}…${previous.window.to}` : 'unknown'} → ${window.from}…${window.to})`);

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
    const prev = previous?.status[key];
    const box = { validators: null };
    let conditional = false;
    let r;
    try {
      const adapter = await loadAdapter(source.type);
      conditional = adapter.CONDITIONAL === true;
      // Ask conditionally only where a 304 can stand for the whole source: a
      // single-request adapter, validators from the last ok answer, and a
      // published state that holds the source's entire delivery (an event
      // that lost a dedup contest is not in events.json and could not be
      // brought back from a 304).
      const complete = prev && prev.count === previous.events.filter((e) => e.source === key).length;
      const validators = reusable && conditional && complete && (prev.etag || prev.lastModified)
        ? { etag: prev.etag, lastModified: prev.lastModified }
        : null;
      r = await adapter.fetchEvents(source, { window, today, get: sourceGet(net.get, validators, box) });
    } catch (e) {
      if (e instanceof NotModified) {
        results.set(key, { state: 'ok', events: [], unchanged: true });
        log(`${key}: not modified — previous events kept (its normalisation warnings are not re-checked on a 304)`);
        return;
      }
      const blocked = e instanceof NetError && e.kind === 'blocked';
      results.set(key, { state: blocked ? 'blocked' : 'error', events: [], error: e.message });
      log(`${key}: ${blocked ? 'blocked' : 'error'} — ${e.message}`);
      return;
    }
    const { events, warnings: sink } = normalizeAll(r, { owner, kind, source, ctx, window });
    for (const w of sink) warnings.push(`${key}: ${w}`);
    // Validators are kept only where they can be used: a multi-request adapter's first answer does not describe the source.
    results.set(key, { state: r.partial ? 'partial' : 'ok', events, validators: conditional ? box.validators : null, ...(r.partial ? { error: r.partial.reason } : {}) });
  });

  const known = { sportIds: new Set(registry.sports.map((s) => s.id)), clubIds: new Set(registry.clubs.map((c) => c.id)) };
  const merged = mergeRun({ results, previous, order, window, today, known });
  warnings.push(...merged.warnings);
  if (merged.events.length > WARN_ABOVE) warnings.push(`${merged.events.length} events — above ${WARN_ABOVE}, the table starts to get heavy`);

  await writeOutputs({ outDir, registry, window, events: merged.events, status: merged.status, now, build });
  const summary = summarize({ results, merged, previous, order });
  for (const w of warnings) log(`warning: ${w}`);
  return { events: merged.events, status: merged.status, summary, warnings, window };
}

/**
 * An adapter result → unique events.json entries plus warnings. One broken
 * item costs that item, never the source or the run.
 */
export function normalizeAll(result, opts) {
  const seen = new Set();
  const events = [];
  const warnings = [...(result.warnings ?? [])];
  for (const raw of result.events) {
    let e;
    try {
      e = normalizeEvent(raw, opts);
    } catch (err) {
      warnings.push(`skipped an event (${String(raw?.uid ?? '?').slice(0, 60)}): ${err.message}`);
      continue;
    }
    if (!e || seen.has(e.id)) continue;
    seen.add(e.id);
    events.push(e);
  }
  return { events, warnings };
}

/** Registry copy for the page: notes stripped. */
export function publicRegistry(registry) {
  const strip = (o) => ({ ...o, sources: o.sources.map(({ note, ...s }) => s) });
  return { clubs: registry.clubs.map(strip), platforms: registry.platforms.map(strip) };
}

async function writeOutputs({ outDir, registry, window, events, status, now, build }) {
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
      ...(build ? { build } : {}),
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
  let unchanged = 0;
  const rows = [...order.keys()].map((key) => {
    const s = merged.status[key];
    // Delivered count against delivered count (events.json holds the dedup survivors only).
    const before = previous?.status[key]?.count ?? 0;
    const delta = s.count - before;
    const sign = delta > 0 ? `+${delta}` : delta < 0 ? `−${-delta}` : '±0';
    const n = merged.news[key];
    const news = !n ? '' : n.unchanged ? 'unchanged (304)' : n.added || n.modified ? `${n.added} new, ${n.modified} modified` : 'unchanged';
    if (n && !n.added && !n.modified) unchanged++;
    // Foreign error text goes into the CI job summary: code-quote it so it cannot become markup.
    const note = String(s.error ?? results.get(key)?.error ?? '').replace(/[`|\r\n]/g, ' ').slice(0, 200);
    return `| ${key} | ${s.state} | ${s.count} | ${previous ? sign : 'new'} | ${news} | ${note ? `\`${note}\`` : ''} |`;
  });
  const total = merged.events.length;
  const before = previous?.events.length ?? 0;
  const fetched = Object.values(merged.status).filter((s) => s.state !== 'disabled').length;
  return [
    `## sportbonnii fetch — ${total} events${previous ? ` (${total - before >= 0 ? '+' : '−'}${Math.abs(total - before)})` : ''}`,
    '',
    '| source | state | events | change | news | note |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `${merged.dropped} cross-source duplicate(s) dropped · ${unchanged} of ${fetched} fetched source(s) without news${merged.allFailed ? ' · ALL SOURCES FAILED — previous events kept' : ''}`,
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
