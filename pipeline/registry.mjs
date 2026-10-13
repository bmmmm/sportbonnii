// Club registry: loading, validation and the canonical file form.
//
// registry/clubs.json and registry/sports.json are the pipeline's only
// input. Validation is hand-written (no schema library) and collects every
// problem instead of stopping at the first, so one run names everything a
// contributor has to fix. The canonical form — keys sorted at every level,
// two-space indent, trailing newline, clubs and platforms sorted by id —
// keeps a bot's diff to exactly one block.
//
// Zero dependencies on purpose: the club-intake workflow runs this without
// `pnpm install`.
//
// CLI: node pipeline/registry.mjs [--fmt]   (validate; --fmt rewrites canonically first)
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTER_TYPES } from './adapters/index.mjs';

export const DISTRICTS = ['Bonn', 'Bad Godesberg', 'Beuel', 'Hardtberg'];
export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const COLOUR = /^#[0-9a-f]{6}$/;

/** Relative luminance bounds: ≥ 3:1 against both #fff and the dark background #121212. */
export const LUMINANCE = { min: 0.118, max: 0.3 };

const CLUB_FIELDS = new Set(['id', 'name', 'sports', 'district', 'website', 'aliases', 'active', 'sources']);
const PLATFORM_FIELDS = new Set(['id', 'name', 'website', 'sources']);
const SOURCE_FIELDS = new Set(['id', 'type', 'url', 'enabled', 'note', 'sports', 'tagMap', 'exclude', 'params', 'expectEmpty']);
const SPORT_FIELDS = new Set(['id', 'label', 'emoji', 'colour', 'keywords']);

export const REGISTRY_DIR = fileURLToPath(new URL('../registry/', import.meta.url));

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

/** The clubs document with clubs and platforms in id order (the canonical order). */
export function canonicalClubs(doc) {
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
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

/**
 * Every problem in the two registry documents, as readable lines; [] means valid.
 * `texts` (optional, the raw file contents) adds the canonical-form check.
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
    err('clubs.json: expected an object');
    return errors;
  }
  for (const k of Object.keys(clubsDoc)) if (k !== 'clubs' && k !== 'platforms') err(`clubs.json: unknown top-level field "${k}"`);
  if (!Array.isArray(clubsDoc.clubs)) err('clubs.json: "clubs" must be an array');
  if (clubsDoc.platforms !== undefined && !Array.isArray(clubsDoc.platforms)) err('clubs.json: "platforms" must be an array');
  const clubs = Array.isArray(clubsDoc.clubs) ? clubsDoc.clubs : [];
  const platforms = Array.isArray(clubsDoc.platforms) ? clubsDoc.platforms : [];

  const ownerIds = new Set();
  const checkOwner = (o, i, kind) => {
    const at = `${kind}[${i}]${o?.id ? ` (${o.id})` : ''}`;
    if (!isObject(o)) { err(`${at}: expected an object`); return; }
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
    }
  };
  clubs.forEach((c, i) => checkOwner(c, i, 'clubs'));
  platforms.forEach((p, i) => checkOwner(p, i, 'platforms'));

  // --- canonical form
  if (texts) {
    if (texts.sports !== undefined && texts.sports !== canonicalJson(sportsDoc)) err('sports.json is not in canonical form — run `pnpm run registry:fmt`');
    if (texts.clubs !== undefined && texts.clubs !== canonicalJson(canonicalClubs(clubsDoc))) err('clubs.json is not in canonical form (sorted keys, clubs by id) — run `pnpm run registry:fmt`');
  }
  return errors;
}

/** Reads both registry files; throws one error listing every problem. */
export async function loadRegistry(dir = REGISTRY_DIR) {
  const texts = {
    clubs: await readFile(join(dir, 'clubs.json'), 'utf8'),
    sports: await readFile(join(dir, 'sports.json'), 'utf8'),
  };
  const docs = { clubs: JSON.parse(texts.clubs), sports: JSON.parse(texts.sports) };
  const errors = validateRegistry(docs, { texts });
  if (errors.length) throw new Error(`invalid registry:\n  ${errors.join('\n  ')}`);
  return { clubs: docs.clubs.clubs, platforms: docs.clubs.platforms ?? [], sports: docs.sports.sports };
}

async function main(argv) {
  const fmt = argv.includes('--fmt');
  if (fmt) {
    for (const [name, canon] of [['sports.json', (d) => d], ['clubs.json', canonicalClubs]]) {
      const path = join(REGISTRY_DIR, name);
      const before = await readFile(path, 'utf8');
      const after = canonicalJson(canon(JSON.parse(before)));
      if (after !== before) { await writeFile(path, after); console.log(`rewrote registry/${name}`); }
    }
  }
  try {
    const reg = await loadRegistry();
    const sources = [...reg.clubs, ...reg.platforms].flatMap((o) => o.sources);
    console.log(`registry ok: ${reg.clubs.length} clubs, ${reg.platforms.length} platforms, ${sources.length} sources, ${reg.sports.length} sports`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.argv.slice(2));
