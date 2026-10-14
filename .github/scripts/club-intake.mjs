// Club intake: the issue form "Verein hinzufügen" → a pull request that adds
// exactly one entry to registry/clubs.json.
//
//   node .github/scripts/club-intake.mjs validate   (no token; the issue text arrives only via env ISSUE_BODY)
//   node .github/scripts/club-intake.mjs publish    (GH_TOKEN; reads nothing but the validate step's JSON)
//
// validate parses the form, derives the club id, checks it against the
// registry (unique id and website host, https, known sports), runs the
// source detection on the calendar URL (https/443 only, private-address
// guard per hop, four lookups — their redirects and robots.txt not counted —
// 10 s and 2 MB each) and validates the patched
// registry. It writes $RUNNER_TEMP/intake.json and exits 0 unless it broke.
//
// publish rebuilds the branch intake/issue-<n> from main with that one file
// changed, opens or updates the PR, and comments the result on the issue —
// user text only ever inside a code fence longer than any backtick run in it.
// Every gh call is an execFile argument array; nothing reaches a shell.
//
// Zero dependencies: it runs on the runner's Node without `pnpm install`.
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { validateRegistry, canonicalJson, canonicalClubs, DISTRICTS, REGISTRY_DIR } from '../../pipeline/registry.mjs';
import { detectSource, sourceSnippet } from '../../pipeline/detect.mjs';
import { createNet } from '../../pipeline/net.mjs';

export const FIELDS = {
  name: 'Vereinsname',
  sports: 'Sportart(en)',
  website: 'Website',
  calendar: 'Kalender-/Termin-URL',
  district: 'Stadtbezirk',
  contact: 'Kontakt',
  consent: 'Bestätigung',
};
export const UNKNOWN_DISTRICT = 'Weiß nicht';
export const LABEL_NEEDS_INFO = 'needs-info';
const MAX_NAME = 80;

/** `### Label` sections of an issue-form body → { label: text }; "_No response_" is empty. */
export function parseIssueForm(body) {
  const out = {};
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const parts = text.split(/^###[ \t]+/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const label = (nl === -1 ? part : part.slice(0, nl)).trim();
    const value = (nl === -1 ? '' : part.slice(nl + 1)).trim();
    if (!(label in out)) out[label] = value === '_No response_' ? '' : value;
  }
  return out;
}

/** Club id from a name: umlauts transliterated, everything else to single hyphens. */
export function slugify(name) {
  return String(name)
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\be\.\s?v\.?$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};
const pathOf = (url) => {
  try {
    return new URL(url).pathname.replace(/\/+$/, '').toLowerCase();
  } catch {
    return '';
  }
};
/**
 * Same club site: same host, and the same path when either has one — two
 * clubs on a shared host (sites.google.com/view/a, …/view/b) are different.
 */
function sameSite(a, b) {
  if (hostOf(a) !== hostOf(b)) return false;
  const pa = pathOf(a);
  const pb = pathOf(b);
  return !pa || !pb || pa === pb || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`);
}

/**
 * Form fields + registry → { club, problems, detection, calendarUrl }.
 * `detect(url)` resolves like detectSource (injected in tests).
 */
export async function buildEntry(form, { clubsDoc, sportsDoc, detect }) {
  const problems = [];
  const name = (form[FIELDS.name] ?? '').replace(/\s+/g, ' ').trim();
  if (!name) problems.push('Der Vereinsname fehlt.');
  else if (name.length > MAX_NAME) problems.push(`Der Vereinsname ist länger als ${MAX_NAME} Zeichen.`);
  else if (/[@`<>{}[\]\\|#*_~]/.test(name)) problems.push('Der Vereinsname enthält Zeichen, die in einem Namen nicht vorkommen (@ ` < > { } [ ] \\ | # * _ ~).');

  const id = name ? slugify(name) : '';
  const clubs = clubsDoc.clubs ?? [];
  const owners = [...clubs, ...(clubsDoc.platforms ?? [])];
  if (name && !id) problems.push('Aus dem Vereinsnamen lässt sich keine Kennung bilden.');
  else if (id && owners.some((o) => o.id === id)) problems.push(`Den Verein gibt es schon (Kennung \`${id}\`).`);

  const labelToId = new Map(sportsDoc.sports.map((s) => [s.label.toLowerCase(), s.id]));
  const picked = (form[FIELDS.sports] ?? '').split(/,\s+/).map((s) => s.trim()).filter(Boolean);
  const sports = [];
  for (const label of picked) {
    const sid = labelToId.get(label.toLowerCase());
    if (!sid) problems.push(`Unbekannte Sportart „${label}".`);
    else if (!sports.includes(sid)) sports.push(sid);
  }
  if (!picked.length) problems.push('Bitte mindestens eine Sportart wählen.');

  const website = (form[FIELDS.website] ?? '').trim();
  let websiteOk = false;
  try {
    const u = new URL(website);
    // http is fine for a website the page only links to (the registry allows it); feeds must be https.
    websiteOk = u.protocol === 'https:' || u.protocol === 'http:';
  } catch { /* reported below */ }
  if (!websiteOk) problems.push('Die Website muss eine vollständige Adresse sein (https://…).');
  else {
    const taken = owners.find((o) => sameSite(o.website, website));
    if (taken) problems.push(`Ein Verein mit der Website ${hostOf(website)}${pathOf(website)} steht schon im Verzeichnis (${taken.name}).`);
  }

  const districtRaw = (form[FIELDS.district] ?? '').trim();
  const district = districtRaw && districtRaw !== UNKNOWN_DISTRICT ? districtRaw : null;
  if (district && !DISTRICTS.includes(district)) problems.push(`Unbekannter Stadtbezirk „${districtRaw}".`);

  if (!/^- \[[xX]\]/m.test(form[FIELDS.consent] ?? '')) problems.push('Bitte bestätigen, dass du den Verein eintragen darfst.');

  const calendarUrl = (form[FIELDS.calendar] ?? '').trim();
  let detection = null;
  const sources = [];
  if (calendarUrl) {
    detection = await detect(calendarUrl);
    if (detection.ok) sources.push(sourceSnippet(detection));
    else problems.push(`Unter der Kalender-Adresse wurde kein lesbarer Kalender gefunden: ${detection.diagnosis}`);
  }

  const club = {
    id, name, sports,
    ...(district ? { district } : {}),
    website, aliases: [name], active: true, sources,
  };
  return { club, problems, detection, calendarUrl };
}

/** A code fence longer than any backtick run inside `text` (snapii's quoted()). */
export function quoted(text) {
  const longest = Math.max(0, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/** The issue comment for a validation result. */
export function renderComment(result) {
  const lines = [];
  if (result.ok) {
    lines.push('Danke! Daraus ist ein Pull Request mit diesem Eintrag geworden:', '', quoted(JSON.stringify(result.club, null, 2)));
    if (result.detection?.ok) lines.push('', `Erkannte Kalenderquelle: **${result.detection.type}**`, '', quoted(result.detection.note));
    else lines.push('', 'Ohne Kalender-Adresse erscheint der Verein im Verzeichnis, aber noch ohne Termine.');
    lines.push('', 'Die Aufnahme prüft und übernimmt das Projekt von Hand.');
  } else {
    lines.push('Danke für den Vorschlag! Bevor daraus ein Eintrag werden kann, fehlt noch etwas:', '', quoted(result.problems.map((p) => `- ${p}`).join('\n')), '', 'Bitte bearbeite das Issue (oben „…" → „Edit"); die Prüfung läuft dann von selbst noch einmal.');
  }
  return lines.join('\n');
}

/** The validate step: environment in, intake.json out. */
export async function validate({ body, number, registryDir = REGISTRY_DIR, detect }) {
  const clubsText = await readFile(join(registryDir, 'clubs.json'), 'utf8');
  const sportsText = await readFile(join(registryDir, 'sports.json'), 'utf8');
  const clubsDoc = JSON.parse(clubsText);
  const sportsDoc = JSON.parse(sportsText);
  const form = parseIssueForm(body);
  const entry = await buildEntry(form, { clubsDoc, sportsDoc, detect });
  let patched = null;
  if (!entry.problems.length) {
    const doc = canonicalClubs({ ...clubsDoc, clubs: [...clubsDoc.clubs, entry.club] });
    patched = canonicalJson(doc);
    const errors = validateRegistry({ clubs: doc, sports: sportsDoc }, { texts: { clubs: patched, sports: sportsText } });
    if (errors.length) entry.problems.push(...errors.map((e) => `Der Eintrag passt nicht ins Verzeichnis: ${e}`));
  }
  const ok = entry.problems.length === 0;
  return { ok, number, club: entry.club, problems: entry.problems, detection: entry.detection, clubsJson: ok ? patched : null, comment: renderComment({ ok, ...entry }) };
}

// --- publish: GitHub side effects, from the JSON only -------------------------

const run = promisify(execFile);
async function gh(args, input) {
  const pending = run('gh', args, { maxBuffer: 16 * 1024 * 1024, env: process.env });
  pending.child.stdin.end(input ?? '');
  const { stdout } = await pending;
  return stdout;
}
const ghJson = async (args, input) => JSON.parse(await gh(args, input));

export async function publish(result, { repo }) {
  const n = String(result.number);
  if (!/^\d+$/.test(n)) throw new Error('issue number missing');
  if (!result.ok) {
    await gh(['issue', 'comment', n, '--repo', repo, '--body-file', '-'], result.comment);
    await gh(['issue', 'edit', n, '--repo', repo, '--add-label', LABEL_NEEDS_INFO]);
    return 'needs-info';
  }
  const branch = `intake/issue-${n}`;
  const main = await ghJson(['api', `repos/${repo}/git/ref/heads/main`]);
  const baseCommit = await ghJson(['api', `repos/${repo}/git/commits/${main.object.sha}`]);
  const blob = await ghJson(['api', `repos/${repo}/git/blobs`, '--input', '-'], JSON.stringify({ content: result.clubsJson, encoding: 'utf-8' }));
  const tree = await ghJson(['api', `repos/${repo}/git/trees`, '--input', '-'], JSON.stringify({ base_tree: baseCommit.tree.sha, tree: [{ path: 'registry/clubs.json', mode: '100644', type: 'blob', sha: blob.sha }] }));
  const message = `feat(registry): add ${result.club.name} (Closes #${n})`;
  const commit = await ghJson(['api', `repos/${repo}/git/commits`, '--input', '-'], JSON.stringify({ message, tree: tree.sha, parents: [main.object.sha] }));
  let exists = true;
  try {
    await gh(['api', `repos/${repo}/git/ref/heads/${branch}`]);
  } catch {
    exists = false;
  }
  if (exists) await gh(['api', '-X', 'PATCH', `repos/${repo}/git/refs/heads/${branch}`, '--input', '-'], JSON.stringify({ sha: commit.sha, force: true }));
  else await gh(['api', `repos/${repo}/git/refs`, '--input', '-'], JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }));
  const prBody = `Adds ${result.club.id} to registry/clubs.json from the issue form.\n\nCloses #${n}`;
  try {
    const open = await ghJson(['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open', '--json', 'number']);
    if (open.length) await gh(['pr', 'edit', String(open[0].number), '--repo', repo, '--title', message, '--body', prBody]);
    else await gh(['pr', 'create', '--repo', repo, '--head', branch, '--base', 'main', '--title', message, '--body', prBody]);
  } catch (e) {
    // The suggestion is fine; only the bot could not open the PR. Say so, then fail the job.
    await gh(['issue', 'comment', n, '--repo', repo, '--body-file', '-'], `${result.comment}\n\n_Der Pull Request ließ sich nicht automatisch anlegen; der Eintrag wird von Hand übernommen._`);
    throw e;
  }
  await gh(['issue', 'comment', n, '--repo', repo, '--body-file', '-'], result.comment);
  await gh(['issue', 'edit', n, '--repo', repo, '--remove-label', LABEL_NEEDS_INFO]).catch(() => {});
  return 'pr';
}

async function main(mode) {
  const out = join(process.env.RUNNER_TEMP ?? process.cwd(), 'intake.json');
  if (mode === 'validate') {
    // The intake's own network budget: https/443 only, four lookups (redirects and robots.txt ride along), 10 s and 2 MB each.
    const net = createNet({ httpsOnly: true, maxRequests: 4, timeoutMs: 10_000, maxBytes: 2 * 1024 * 1024 });
    const result = await validate({ body: process.env.ISSUE_BODY, number: Number(process.env.ISSUE_NUMBER), detect: (url) => detectSource(url, { net }) });
    await writeFile(out, JSON.stringify(result, null, 2));
    console.log(result.ok ? `ok: ${result.club.id}` : `needs info: ${result.problems.length} problem(s)`);
  } else if (mode === 'publish') {
    const result = JSON.parse(await readFile(out, 'utf8'));
    console.log(await publish(result, { repo: process.env.REPO }));
  } else {
    console.error('usage: club-intake.mjs validate|publish');
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.argv[2]);
