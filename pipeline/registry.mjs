// Club registry: loading, validation and the canonical file form.
//
// registry/clubs/<id>.json (one club per file), registry/platforms/<id>.json
// (city-wide sources that are not a club) and registry/sports.json are the
// pipeline's only input. Validation is hand-written (no schema library) and
// collects every problem instead of stopping at the first, so one run names
// everything a contributor has to fix. The canonical form — keys sorted at
// every level, two-space indent, trailing newline, each file named after its
// id — keeps a bot's change to exactly one new file. Clubs and platforms are
// ordered by id, never by file name (`bonn-x.json` sorts before `bonn.json`,
// the id `bonn` before `bonn-x`).
//
// Zero dependencies on purpose: the club-intake workflow runs this without
// `pnpm install`.
//
// CLI: node pipeline/registry.mjs [--fmt]   (validate; --fmt rewrites every file canonically first and,
// once the registry is valid, regenerates docs/vereine.md)
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTER_TYPES } from './adapters/index.mjs';
import { KIND_IDS, VENUE_USES } from '../site/kinds.js';
import { renderOverview } from './overview.mjs';

export const DISTRICTS = ['Bonn', 'Bad Godesberg', 'Beuel', 'Hardtberg'];
export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const COLOUR = /^#[0-9a-f]{6}$/;

/** Relative luminance bounds: ≥ 3:1 against both #fff and the dark background #121212. */
export const LUMINANCE = { min: 0.118, max: 0.3 };

const CLUB_FIELDS = new Set(['id', 'name', 'sports', 'district', 'website', 'aliases', 'active', 'sources', 'venues']);
const PLATFORM_FIELDS = new Set(['id', 'name', 'website', 'sources']);
const SOURCE_FIELDS = new Set(['id', 'type', 'url', 'enabled', 'note', 'sports', 'tagMap', 'exclude', 'params', 'expectEmpty', 'kind']);
const SPORT_FIELDS = new Set(['id', 'label', 'emoji', 'colour', 'keywords']);
const VENUE_FIELDS = new Set(['name', 'address', 'lat', 'lon', 'osm', 'use']);

/** A club lists at most this many venues; the first is its main one. */
export const MAX_VENUES = 3;
/** Venue coordinates must fall in this box around Bonn — a guard against swapped or mistyped numbers. */
export const VENUE_BOUNDS = { lat: [50.6, 50.8], lon: [7.0, 7.3] };
/** An OpenStreetMap object: node/<n>, way/<n> or relation/<n>. */
export const OSM_REF = /^(node|way|relation)\/[1-9]\d*$/;

export const REGISTRY_DIR = fileURLToPath(new URL('../registry/', import.meta.url));
/** The generated club overview (pipeline/overview.mjs). */
export const OVERVIEW_PATH = fileURLToPath(new URL('../docs/vereine.md', import.meta.url));

/** Keys sorted at every level; arrays keep their order. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

/** The canonical text of a registry document. */
export function canonicalJson(doc) {
  return JSON.stringify(sortKeys(doc), null, 2) + '\n';
}

const idOf = (o) => (o !== null && typeof o === 'object' && typeof o.id === 'string' ? o.id : '');
const byId = (a, b) => (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0);

/** The clubs document with clubs and platforms in id order (the canonical order). */
export function canonicalClubs(doc) {
  return { ...doc, clubs: [...(doc.clubs ?? [])].sort(byId), platforms: [...(doc.platforms ?? [])].sort(byId) };
}

function channelLuminance(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of '#rrggbb'. */
export function relativeLuminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '' && v === v.trim();

function httpUrl(value, { httpsOnly }) {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return httpsOnly ? u.protocol === 'https:' : u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

// --- one club, one entry ----------------------------------------------------
// A department ("SSF Bonn Tischtennis") is a sport in its club's `sports`
// (its calendar a source with `sports`), never an entry of its own. The
// validator and the intake bot share one test for "is this already listed".

/**
 * A name compared loosely: accents gone, ß → ss, lowercase, a trailing
 * "e.V." dropped, every run of characters other than letters, digits and
 * hyphens one space ("Bonn-Rhein-Sieg" keeps its hyphens).
 */
export function nameKey(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/\be\.\s?v\.?\s*$/, '')
    .replace(/[^\p{L}\p{N}-]+/gu, ' ')
    .trim();
}

/** Host (lowercase, without www.) and path (lowercase, no trailing slash) of a URL; null when it has no host. */
export function siteOf(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return host ? { host, path: u.pathname.replace(/\/+$/, '').toLowerCase() } : null;
  } catch {
    return null;
  }
}

/**
 * Same club site: the same host or a subdomain of it (lacrosse.ssfbonn.de
 * is ssfbonn.de), and the same path when both have one — two clubs on a
 * shared host (sites.google.com/view/a, …/view/b) are different.
 */
export function sameSite(a, b) {
  const sa = siteOf(a);
  const sb = siteOf(b);
  if (!sa || !sb) return false;
  if (sa.host !== sb.host && !sa.host.endsWith(`.${sb.host}`) && !sb.host.endsWith(`.${sa.host}`)) return false;
  const [pa, pb] = [sa.path, sb.path];
  return !pa || !pb || pa === pb || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`);
}

/** The non-empty name keys of an entry's name and aliases, with the text each came from. */
function namesOf(o) {
  const texts = [o?.name, ...(Array.isArray(o?.aliases) ? o.aliases : [])].filter((t) => typeof t === 'string');
  return texts.map((text) => ({ text, key: nameKey(text) })).filter((n) => n.key);
}

/**
 * Is `entry` already listed among `owners` (clubs and platforms; `entry`
 * itself is skipped)? The first hit by priority: the same id; the same name
 * (any name or alias, by nameKey); a department — one name is the other
 * plus more words (`parent` is the one that names the club); the same site.
 * → { owner, reason: 'id'|'name'|'department'|'website', parent?, names? } | null,
 * `names` = [entry's text, owner's text] that matched.
 */
export function departmentConflict(entry, owners) {
  const others = owners.filter((o) => isObject(o) && o !== entry);
  const mine = namesOf(entry);
  const pairs = (owner) => namesOf(owner).flatMap((theirs) => mine.map((own) => [own, theirs]));
  const sameId = typeof entry.id === 'string' && others.find((o) => o.id === entry.id);
  if (sameId) return { owner: sameId, reason: 'id' };
  for (const owner of others) {
    const hit = pairs(owner).find(([a, b]) => a.key === b.key);
    if (hit) return { owner, reason: 'name', names: [hit[0].text, hit[1].text] };
  }
  for (const owner of others) {
    for (const [a, b] of pairs(owner)) {
      if (a.key.startsWith(`${b.key} `)) return { owner, reason: 'department', parent: owner, names: [a.text, b.text] };
      if (b.key.startsWith(`${a.key} `)) return { owner, reason: 'department', parent: entry, names: [a.text, b.text] };
    }
  }
  const site = others.find((o) => sameSite(entry.website, o.website));
  return site ? { owner: site, reason: 'website' } : null;
}

/**
 * Every problem in the registry documents, as readable lines; [] means valid.
 * `texts` (optional, readRegistry's raw file contents: `{ sports, files }`)
 * adds the file checks — canonical text, file named after its id.
 */
export function validateRegistry({ clubs: clubsDoc, sports: sportsDoc }, { texts, adapterTypes = ADAPTER_TYPES } = {}) {
  const errors = [];
  const err = (msg) => errors.push(msg);

  // --- sports
  const sportIds = new Set();
  if (!isObject(sportsDoc) || !Array.isArray(sportsDoc.sports)) {
    err('sports.json: expected { "sports": [...] }');
  } else {
    for (const [i, s] of sportsDoc.sports.entries()) {
      const at = `sports[${i}]${s?.id ? ` (${s.id})` : ''}`;
      if (!isObject(s)) { err(`${at}: expected an object`); continue; }
      for (const k of Object.keys(s)) if (!SPORT_FIELDS.has(k)) err(`${at}: unknown field "${k}"`);
      if (typeof s.id !== 'string' || !SLUG.test(s.id)) err(`${at}: id must be a lowercase slug`);
      else if (sportIds.has(s.id)) err(`${at}: duplicate sport id`);
      else sportIds.add(s.id);
      if (!isText(s.label)) err(`${at}: label must be non-empty text`);
      if (!isText(s.emoji)) err(`${at}: emoji must be non-empty text`);
      if (typeof s.colour !== 'string' || !COLOUR.test(s.colour)) {
        err(`${at}: colour must be #rrggbb (lowercase)`);
      } else {
        const l = relativeLuminance(s.colour);
        if (l < LUMINANCE.min || l > LUMINANCE.max) {
          err(`${at}: colour ${s.colour} has luminance ${l.toFixed(3)}, outside ${LUMINANCE.min}–${LUMINANCE.max} (contrast against light and dark backgrounds)`);
        }
      }
      if (s.keywords !== undefined && (!Array.isArray(s.keywords) || !s.keywords.every((k) => isText(k) && k === k.toLowerCase()))) {
        err(`${at}: keywords must be lowercase text`);
      }
    }
    if (!sportIds.has('sonstiges')) err('sports.json: the catch-all sport "sonstiges" is missing');
  }

  // --- clubs and platforms
  if (!isObject(clubsDoc)) {
    err('clubs document: expected an object');
    return errors;
  }
  for (const k of Object.keys(clubsDoc)) if (k !== 'clubs' && k !== 'platforms') err(`clubs document: unknown top-level field "${k}"`);
  if (!Array.isArray(clubsDoc.clubs)) err('clubs document: "clubs" must be an array');
  if (clubsDoc.platforms !== undefined && !Array.isArray(clubsDoc.platforms)) err('clubs document: "platforms" must be an array');
  const clubs = Array.isArray(clubsDoc.clubs) ? clubsDoc.clubs : [];
  const platforms = Array.isArray(clubsDoc.platforms) ? clubsDoc.platforms : [];

  const inBounds = (n, [min, max]) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
  const checkVenues = (venues, at) => {
    if (!Array.isArray(venues)) { err(`${at}: venues must be a list`); return; }
    if (venues.length === 0 || venues.length > MAX_VENUES) err(`${at}: venues must list 1 to ${MAX_VENUES} venues (the first is the main one)`);
    for (const [j, v] of venues.entries()) {
      const vat = `${at}.venues[${j}]`;
      if (!isObject(v)) { err(`${vat}: expected an object`); continue; }
      for (const k of Object.keys(v)) if (!VENUE_FIELDS.has(k)) err(`${vat}: unknown field "${k}"`);
      if (!isText(v.name)) err(`${vat}: name must be non-empty text`);
      if (v.address !== undefined && !isText(v.address)) err(`${vat}: address must be non-empty text`);
      for (const axis of ['lat', 'lon']) {
        const [min, max] = VENUE_BOUNDS[axis];
        if (!inBounds(v[axis], VENUE_BOUNDS[axis])) err(`${vat}: ${axis} must be a number from ${min} to ${max} (Bonn)`);
      }
      if (v.osm !== undefined && !(typeof v.osm === 'string' && OSM_REF.test(v.osm))) err(`${vat}: osm must be node/<n>, way/<n> or relation/<n>`);
      if (v.use !== undefined && !VENUE_USES.includes(v.use)) err(`${vat}: use must be one of ${VENUE_USES.join(', ')} (leave it out for both)`);
    }
  };

  const ownerIds = new Set();
  const labels = new Map();
  const checkOwner = (o, i, kind) => {
    const at = `${kind}[${i}]${o?.id ? ` (${o.id})` : ''}`;
    if (!isObject(o)) { err(`${at}: expected an object`); return; }
    labels.set(o, at);
    const allowed = kind === 'clubs' ? CLUB_FIELDS : PLATFORM_FIELDS;
    for (const k of Object.keys(o)) if (!allowed.has(k)) err(`${at}: unknown field "${k}"`);
    if (typeof o.id !== 'string' || !SLUG.test(o.id)) err(`${at}: id must be a lowercase slug (a-z, 0-9, single hyphens)`);
    else if (ownerIds.has(o.id)) err(`${at}: duplicate id "${o.id}"`);
    else ownerIds.add(o.id);
    if (!isText(o.name)) err(`${at}: name must be non-empty text`);
    if (!httpUrl(o.website, { httpsOnly: false })) err(`${at}: website must be an http(s) URL`);

    let ownSports = null;
    if (kind === 'clubs') {
      if (!Array.isArray(o.sports) || o.sports.length === 0) {
        err(`${at}: sports must list at least one sport`);
      } else {
        ownSports = new Set(o.sports);
        if (ownSports.size !== o.sports.length) err(`${at}: sports lists a sport twice`);
        for (const s of o.sports) if (!sportIds.has(s)) err(`${at}: unknown sport "${s}"`);
      }
      if (o.district !== undefined && !DISTRICTS.includes(o.district)) err(`${at}: district must be one of ${DISTRICTS.join(', ')}`);
      if (o.aliases !== undefined && (!Array.isArray(o.aliases) || !o.aliases.every(isText))) err(`${at}: aliases must be a list of non-empty texts`);
      if (o.active !== undefined && typeof o.active !== 'boolean') err(`${at}: active must be true or false`);
      if (o.venues !== undefined) checkVenues(o.venues, at);
    }

    if (!Array.isArray(o.sources)) { err(`${at}: sources must be an array (empty when the club publishes no calendar)`); return; }
    const sourceIds = new Set();
    for (const [j, src] of o.sources.entries()) {
      const sat = `${at}.sources[${j}]${src?.id ? ` (${src.id})` : ''}`;
      if (!isObject(src)) { err(`${sat}: expected an object`); continue; }
      for (const k of Object.keys(src)) if (!SOURCE_FIELDS.has(k)) err(`${sat}: unknown field "${k}"`);
      if (typeof src.id !== 'string' || !SLUG.test(src.id)) err(`${sat}: id must be a lowercase slug`);
      else if (sourceIds.has(src.id)) err(`${sat}: duplicate source id "${src.id}"`);
      else sourceIds.add(src.id);
      if (!adapterTypes.includes(src.type)) err(`${sat}: type must be one of ${adapterTypes.join(', ')}`);
      if (!httpUrl(src.url, { httpsOnly: true })) err(`${sat}: url must be an https URL`);
      for (const flag of ['enabled', 'expectEmpty']) {
        if (src[flag] !== undefined && typeof src[flag] !== 'boolean') err(`${sat}: ${flag} must be true or false`);
      }
      if (src.note !== undefined && !isText(src.note)) err(`${sat}: note must be non-empty text`);
      if (src.sports !== undefined) {
        if (!Array.isArray(src.sports) || src.sports.length === 0) err(`${sat}: sports must list at least one sport`);
        else for (const s of src.sports) {
          if (!sportIds.has(s)) err(`${sat}: unknown sport "${s}"`);
          else if (ownSports && !ownSports.has(s)) err(`${sat}: sport "${s}" is not one of the club's sports`);
        }
      }
      if (src.tagMap !== undefined) {
        if (!isObject(src.tagMap)) err(`${sat}: tagMap must map tags to sport ids`);
        else for (const [tag, s] of Object.entries(src.tagMap)) {
          if (!isText(tag)) err(`${sat}: tagMap has an empty tag`);
          if (!sportIds.has(s)) err(`${sat}: tagMap maps "${tag}" to unknown sport "${s}"`);
        }
      }
      if (src.exclude !== undefined && (!Array.isArray(src.exclude) || !src.exclude.every(isText))) err(`${sat}: exclude must be a list of non-empty texts`);
      if (src.params !== undefined && !isObject(src.params)) err(`${sat}: params must be an object`);
      if (src.kind !== undefined && !KIND_IDS.includes(src.kind)) err(`${sat}: kind must be one of ${KIND_IDS.join(', ')}`);
    }
  };
  clubs.forEach((c, i) => checkOwner(c, i, 'clubs'));
  platforms.forEach((p, i) => checkOwner(p, i, 'platforms'));

  // --- one club, one entry: every pair of clubs and platforms
  const owners = [...labels.keys()];
  owners.forEach((o, i) => {
    for (const other of owners.slice(0, i)) {
      const c = departmentConflict(o, [other]);
      if (!c || c.reason === 'id') continue; // a duplicate id is reported above
      if (c.reason === 'name') {
        err(`${labels.get(o)}: "${c.names[0]}" is also a name of ${other.id} ("${c.names[1]}") — one club, one entry`);
      } else if (c.reason === 'website') {
        err(`${labels.get(o)}: website ${o.website} is the site of ${other.id} — one club, one entry`);
      } else {
        const [child, parent, childName, parentName] = c.parent === other ? [o, other, ...c.names] : [other, o, c.names[1], c.names[0]];
        err(`${labels.get(child)}: "${childName}" looks like a department of ${parent.id} ("${parentName}") — a department is a sport in ${parent.id}'s sports, not an entry of its own`);
      }
    }
  });

  // --- files: canonical text, one club or platform per file named after its id
  if (texts) {
    if (texts.sports !== undefined && texts.sports !== canonicalJson(sportsDoc)) err('sports.json is not in canonical form — run `pnpm run registry:fmt`');
    for (const f of texts.files ?? []) {
      const id = idOf(f.doc);
      if (f.path !== `${f.kind}/${id}.json`) err(`${f.path}: the file must be named after its id (${id ? `${f.kind}/${id}.json` : 'no id'})`);
      if (f.text !== canonicalJson(f.doc)) err(`${f.path} is not in canonical form (sorted keys, 2-space indent) — run \`pnpm run registry:fmt\``);
    }
  }
  return errors;
}

const OWNER_KINDS = ['clubs', 'platforms'];

/** The sorted `*.json` file names in `dir`; [] when an optional `dir` is missing. */
async function jsonFiles(dir, { optional }) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (optional && e.code === 'ENOENT') return [];
    throw e;
  }
  return entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name).sort();
}

function parseFile(path, text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`invalid registry: ${path} is not valid JSON (${e.message})`);
  }
}

/**
 * Reads the registry without judging it: the documents in validateRegistry's
 * shape plus the raw texts for its file checks. `files` lists every club and
 * platform file ({ path: 'clubs/<name>.json', kind, text, doc }); clubs and
 * platforms come in id order. `platforms/` may be missing. Throws only when a
 * file cannot be read or parsed, naming the file.
 */
export async function readRegistry(dir = REGISTRY_DIR) {
  const files = [];
  for (const kind of OWNER_KINDS) {
    const own = [];
    for (const name of await jsonFiles(join(dir, kind), { optional: kind === 'platforms' })) {
      const path = `${kind}/${name}`;
      const text = await readFile(join(dir, kind, name), 'utf8');
      own.push({ path, kind, text, doc: parseFile(path, text) });
    }
    files.push(...own.sort((a, b) => byId(a.doc, b.doc)));
  }
  const sports = await readFile(join(dir, 'sports.json'), 'utf8');
  const ofKind = (kind) => files.filter((f) => f.kind === kind).map((f) => f.doc);
  return {
    docs: { clubs: { clubs: ofKind('clubs'), platforms: ofKind('platforms') }, sports: parseFile('sports.json', sports) },
    texts: { sports, files },
  };
}

/** Reads and validates the registry; throws one error listing every problem. */
export async function loadRegistry(dir = REGISTRY_DIR) {
  const { docs, texts } = await readRegistry(dir);
  const errors = validateRegistry(docs, { texts });
  if (errors.length) throw new Error(`invalid registry:\n  ${errors.join('\n  ')}`);
  return { clubs: docs.clubs.clubs, platforms: docs.clubs.platforms, sports: docs.sports.sports };
}

/** Rewrites every registry file whose text is not canonical — in place, never renamed. Returns the changed paths. */
export async function formatRegistry(dir = REGISTRY_DIR) {
  const { docs, texts } = await readRegistry(dir);
  const changed = [];
  for (const f of [{ path: 'sports.json', text: texts.sports, doc: docs.sports }, ...texts.files]) {
    const canon = canonicalJson(f.doc);
    if (canon !== f.text) { await writeFile(join(dir, f.path), canon); changed.push(f.path); }
  }
  return changed;
}

/** Writes the overview of `reg` (loadRegistry's result) to `file` when its text differs. Returns whether it wrote. */
export async function writeOverview(reg, file = OVERVIEW_PATH) {
  const text = renderOverview(reg);
  const current = await readFile(file, 'utf8').catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
  if (current === text) return false;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  return true;
}

async function main(argv) {
  try {
    const fmt = argv.includes('--fmt');
    if (fmt) for (const path of await formatRegistry()) console.log(`rewrote registry/${path}`);
    const reg = await loadRegistry();
    if (fmt && await writeOverview(reg)) console.log('rewrote docs/vereine.md');
    const sources = [...reg.clubs, ...reg.platforms].flatMap((o) => o.sources);
    console.log(`registry ok: ${reg.clubs.length} clubs, ${reg.platforms.length} platforms, ${sources.length} sources, ${reg.sports.length} sports`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.argv.slice(2));
