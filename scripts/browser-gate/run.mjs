// Browser gate (local definition of done, not CI): the shipped page in
// headless Chrome on the committed snapshot test/fixtures/site-data/, with
// the clock frozen at 2026-10-14 14:00 Berlin and the browser in
// America/New_York — the page must still show Bonn dates and times.
//
// Checks: rows per sport chip and per kind chip equal what state.js computes
// in Node, with the kind badges; the page opens on home games and "Auswärts"
// shows the away games; the hash restores a view after a reload; the
// weekly training after the DST end lands on Tuesday 19:00; 390 px shows
// cards and the agenda; an <img onerror> title stays text; the .ics download
// carries exactly the shown dates; the stale banner appears after 48 h; the
// club directory; the map: no tile before its tab opens, a marker per venue
// with the dates state.js and map.js compute, zoom and drag; no console error,
// CSP violation, exception or request beyond the dev server (OSM tiles are
// answered inside the browser with a 1×1 PNG, so the gate stays offline).
//
// Needs Chrome and Node ≥ 22, outside a command sandbox (loopback server).
// Usage: node scripts/browser-gate/run.mjs [--keep]    CHROME=<path> overrides the binary.
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTarget } from './cdp.mjs';
import { applyFilters, defaultState } from '../../site/state.js';
import { mapPlaces, TILE_URL } from '../../site/map.js';
import { KIND_IDS } from '../../site/kinds.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const KEEP = process.argv.includes('--keep');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const NOW = Date.parse('2026-10-14T12:00:00Z'); // 14:00 in Bonn
const TODAY = '2026-10-14';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const failures = [];
const fail = (msg) => { failures.push(msg); console.log('FAIL', msg); };
const ok = (msg) => console.log('ok  ', msg);
const check = (cond, good, bad) => (cond ? ok(good) : fail(bad));

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
async function waitHttp(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error(`not reachable within ${ms} ms: ${url}`);
}

const children = [];
let stopping = false;
function start(cmd, args, label) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let tail = '';
  p.stderr.on('data', (d) => { tail = (tail + d).slice(-1500); });
  p.on('exit', (code, sig) => { if (!stopping) log(label, `exited (${code ?? sig})`, tail.trim().split('\n').slice(-3).join(' | ')); });
  children.push(p);
  return p;
}
const temp = [];
async function cleanup() {
  if (KEEP) return;
  stopping = true;
  for (const p of children) { try { p.kill(); } catch {} }
  for (const d of temp) await rm(d, { recursive: true, force: true }).catch(() => {});
}
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

/** The init script: frozen clock, alert/print traps. Runs before the page's own scripts (and outside its CSP). */
const initScript = (now) => `(() => {
  const NOW = ${now};
  const Real = Date;
  class Frozen extends Real { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } }
  globalThis.Date = Frozen;
  globalThis.__alerts = 0;
  globalThis.alert = () => { globalThis.__alerts++; };
})();`;

// --- expectations, computed in Node from the same modules the page runs
const json = async (n) => JSON.parse(await readFile(join(ROOT, 'test/fixtures/site-data', n), 'utf8'));
const events = (await json('events.json')).events;
const clubs = (await json('clubs.json')).clubs;
const sports = (await json('sports.json')).sports;
const ctx = { today: TODAY, clubsById: new Map(clubs.map((c) => [c.id, c])), sportsById: new Map(sports.map((s) => [s.id, s])) };
const expectRows = (patch) => applyFilters(events, { ...defaultState(), ...patch }, ctx).length;

try {
  // Site + snapshot data in a scratch directory: site/data/ (a real fetch) never enters the gate.
  const dir = await mkdtemp(join(tmpdir(), 'sportbonnii-gate-site-'));
  temp.push(dir);
  const liveData = join(ROOT, 'site', 'data');
  await cp(join(ROOT, 'site'), dir, { recursive: true, filter: (src) => src !== liveData && !src.startsWith(`${liveData}/`) });
  await mkdir(join(dir, 'data'), { recursive: true });
  await cp(join(ROOT, 'test/fixtures/site-data'), join(dir, 'data'), { recursive: true });

  const httpPort = await freePort();
  const cdpPort = await freePort();
  const BASE = `http://127.0.0.1:${httpPort}/`;
  start('python3', [join(ROOT, 'scripts/serve.py'), String(httpPort), dir], 'serve.py');
  await waitHttp(`${BASE}index.html`, 5000);
  const profile = await mkdtemp(join(tmpdir(), 'sportbonnii-gate-chrome-'));
  temp.push(profile);
  start(CHROME, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-background-networking', 'about:blank'], 'chrome');
  await waitHttp(`http://127.0.0.1:${cdpPort}/json/version`, 10000);

  const t = await openTarget(cdpPort);
  const requests = [];
  const loud = [];
  const exceptions = [];
  t.on('Network.requestWillBeSent', (p) => requests.push(p.request.url));
  t.on('Log.entryAdded', (p) => { if (p.entry.level === 'error' || p.entry.level === 'warning') loud.push(p.entry.text); });
  t.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error' || p.type === 'warning') loud.push(p.args.map((a) => a.value ?? a.description).join(' ')); });
  t.on('Runtime.exceptionThrown', (p) => exceptions.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text));
  for (const d of ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable']) await t.send(d);
  // OSM tiles never leave the machine: the browser gets a 1×1 PNG for each.
  const served = new Set();
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  t.on('Fetch.requestPaused', (p) => {
    served.add(p.request.url);
    t.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }], body: PNG }).catch(() => {});
  });
  await t.send('Fetch.enable', { patterns: [{ urlPattern: `${TILE_URL}*` }] });
  const isTile = (u) => u.startsWith(TILE_URL);
  await t.send('Network.setCacheDisabled', { cacheDisabled: true });
  await t.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' });
  await t.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  let initId = (await t.send('Page.addScriptToEvaluateOnNewDocument', { source: initScript(NOW) })).identifier;

  const evaluate = (expr) => t.evaluate(expr);
  async function waitFor(expr, ms = 4000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evaluate(expr).catch(() => false)) return true;
      await sleep(80);
    }
    return false;
  }
  const ready = `document.body.classList.contains('is-ready')`;
  let loads = 0;
  // A fresh query per load: navigating to the same document with another hash would only fire hashchange.
  async function open(hash = '') {
    await t.send('Page.navigate', { url: `${BASE}index.html?load=${++loads}${hash}` });
    await sleep(150);
    if (!await waitFor(ready, 8000)) {
      const why = [...exceptions, ...loud].slice(-3).join(' | ') || await evaluate(`document.getElementById('load-error').textContent`).catch(() => '?');
      throw new Error(`page did not become ready (${hash || 'no hash'}): ${why}`);
    }
  }
  const rows = () => evaluate(`document.querySelectorAll('#table tbody tr').length`);
  const settle = () => sleep(120);

  // --- 1. first load, the visitor's zone is New York
  await open();
  check(await evaluate(`new Date().getTimezoneOffset()`) === 240, 'browser runs in America/New_York (UTC−4)', 'timezone override did not apply');
  const firstRows = await rows();
  check(firstRows === expectRows({}), `table shows ${firstRows} upcoming dates, as state.js computes`, `table shows ${firstRows} rows, expected ${expectRows({})}`);
  const firstTime = await evaluate(`document.querySelector('#table tbody tr .col-zeit .time').textContent`);
  const firstEvent = applyFilters(events, defaultState(), ctx)[0];
  check(firstTime.startsWith(firstEvent.start.slice(11, 16)), `times stay Bonn wall clock (${firstTime})`, `first time ${firstTime}, expected ${firstEvent.start.slice(11, 16)}`);
  check(await evaluate(`document.getElementById('checked').textContent.includes('heute, 12:23 Uhr')`), 'check time in Bonn time, relative ("heute, 12:23 Uhr")', `header says ${await evaluate(`document.getElementById('checked').textContent`)}`);
  check(await evaluate(`document.getElementById('stale').hidden`), 'no stale banner for fresh data', 'stale banner shown for fresh data');

  // --- 2. every visible chip narrows the table to what state.js computes
  await evaluate(`document.querySelector('#sport-chips [data-more]')?.click(), true`);
  await settle();
  const chipIds = await evaluate(`[...document.querySelectorAll('#sport-chips [data-sport]')].map((b) => b.dataset.sport)`);
  const mismatches = [];
  for (const id of chipIds) {
    await evaluate(`document.querySelector('#sport-chips [data-sport="${id}"]').click(), true`);
    await settle();
    const got = await evaluate(`document.querySelector('#table .empty') ? 0 : document.querySelectorAll('#table tbody tr').length`);
    const want = expectRows({ sport: [id] });
    const label = Number(await evaluate(`document.querySelector('#sport-chips [data-sport="${id}"] .count').textContent`));
    if (got !== want || label !== want) mismatches.push(`${id}: ${got} rows, chip says ${label}, expected ${want}`);
    await evaluate(`document.querySelector('#sport-chips [data-sport="${id}"]').click(), true`);
    await settle();
  }
  check(chipIds.length === sports.length && !mismatches.length, `${chipIds.length} sport chips: rows and counts match state.js`, `chip counts: ${mismatches.join('; ') || `${chipIds.length} chips`}`);
  // Every kind chip likewise, starting from "Alle Arten" (the page opens on games); a match or training row carries its badge, an event none.
  await evaluate(`document.getElementById('kind-clear').click(), true`);
  await settle();
  check(await evaluate('location.hash') === '#art=alle' && await rows() === expectRows({ art: [] }), '"Alle Arten" lifts the default kind filter (#art=alle)', `kind clear: ${await evaluate('location.hash')}`);
  const kindIds = await evaluate(`[...document.querySelectorAll('#kind-chips [data-kind]')].map((b) => b.dataset.kind)`);
  const kindMismatches = [];
  for (const id of kindIds) {
    await evaluate(`document.querySelector('#kind-chips [data-kind="${id}"]').click(), true`);
    await settle();
    const got = await evaluate(`document.querySelector('#table .empty') ? 0 : document.querySelectorAll('#table tbody tr').length`);
    const want = expectRows({ art: [id] });
    const label = Number(await evaluate(`document.querySelector('#kind-chips [data-kind="${id}"] .count').textContent`));
    const badges = await evaluate(`[...document.querySelectorAll('#table tbody tr')].map((tr) => tr.querySelector('.badge-kind')?.textContent ?? '')`);
    const badge = { spiel: 'Spiel', training: 'Training', veranstaltung: '' }[id];
    const hash = await evaluate('location.hash');
    if (got !== want || label !== want || !want || badges.some((b) => b !== badge) || hash !== (id === 'spiel' ? '' : `#art=${id}`)) kindMismatches.push(`${id}: ${got} rows, chip says ${label}, expected ${want}, badges ${[...new Set(badges)].join('/')}, hash ${hash}`);
    await evaluate(`document.querySelector('#kind-chips [data-kind="${id}"]').click(), true`);
    await settle();
  }
  check(kindIds.join() === KIND_IDS.join() && !kindMismatches.length, `${kindIds.length} kind chips: rows, counts and badges match state.js`, `kind chips: ${kindMismatches.join('; ') || kindIds.join()}`);

  // --- 2b. home/away: the page opens on games without the recognised away games
  await open();
  const ortInfo = async () => evaluate(`({ hidden: document.getElementById('ort-field').hidden, pressed: document.querySelector('#f-ort [aria-pressed=true]')?.dataset.ort, hash: location.hash, reset: !document.getElementById('reset').hidden, titles: [...document.querySelectorAll('#table tbody tr .col-titel .title')].map((x) => x.textContent) })`);
  const home = await ortInfo();
  check(!home.hidden && home.pressed === 'heim' && home.hash === '' && !home.reset && home.titles.length === expectRows({}) && !home.titles.some((x) => x.includes('(auswärts)'))
    && home.titles.length === expectRows({ art: ['spiel'], ort: 'heim' }),
  `default view: ${home.titles.length} games, "Heimspiele" pressed, no away game, no hash`, `ort default: ${JSON.stringify(home)}`);
  await evaluate(`document.querySelector('#f-ort [data-ort="auswaerts"]').click(), true`);
  await settle();
  const away = await ortInfo();
  check(away.pressed === 'auswaerts' && away.hash === '#ort=auswaerts' && away.reset && away.titles.length === expectRows({ ort: 'auswaerts' }) && away.titles.length > 0 && away.titles.every((x) => x.includes('(auswärts)')),
    `"Auswärts" shows the ${away.titles.length} away game(s) only (#ort=auswaerts)`, `ort away: ${JSON.stringify(away)}`);
  await evaluate(`document.getElementById('reset').click(), true`);
  await settle();
  check((await ortInfo()).hash === '', '"Filter zurücksetzen" returns to the default (games, home)', `reset: ${(await ortInfo()).hash}`);
  await open('#art=training');
  check((await ortInfo()).hidden, 'the home/away switch hides while games are not among the kinds', 'ort field shown for trainings only');
  await open();
  await evaluate(`document.getElementById('kind-clear').click(), true`);
  await settle();

  // --- 3. the hash restores a view after a reload
  await evaluate(`document.querySelector('#sport-chips [data-sport="rugby"]').click(), true`);
  await settle();
  await evaluate(`document.querySelector('#kind-chips [data-kind="training"]').click(), true`);
  await settle();
  await evaluate(`document.querySelector('#f-zeit [data-zeit="woche"]').click(), true`);
  await settle();
  await evaluate(`document.getElementById('tab-kalender').click(), true`);
  await settle();
  await evaluate(`document.querySelector('.cal-nav [data-nav]:not(:disabled)[aria-label^="Nächster"]').click(), true`);
  await settle();
  const hash = await evaluate('location.hash');
  check(hash === '#ansicht=kalender&sport=rugby&art=training&zeit=woche&monat=2026-11', `filters write the hash (${hash})`, `hash after clicks: ${hash}`);
  await t.send('Page.reload', { ignoreCache: true });
  await sleep(150);
  await waitFor(ready, 8000);
  const restored = await evaluate(`({ title: document.querySelector('.cal-title')?.textContent, tab: document.querySelector('[role=tab][aria-selected=true]').dataset.view, pressed: [...document.querySelectorAll('#sport-chips [aria-pressed=true]')].map((b) => b.dataset.sport), kinds: [...document.querySelectorAll('#kind-chips [aria-pressed=true]')].map((b) => b.dataset.kind), chips: [...document.querySelectorAll('.cal-ev')].map((c) => c.className), hash: location.hash })`);
  check(restored.title === 'November 2026' && restored.tab === 'kalender' && restored.pressed.join() === 'rugby' && restored.kinds.join() === 'training' && restored.hash === hash
    && restored.chips.length > 0 && restored.chips.every((c) => c.split(' ').includes('cal-ev-training')),
  'a reload restores view, month, sport and kind chips from the hash; the calendar marks the trainings', `after reload: ${JSON.stringify(restored)}`);
  await open('#ansicht=kalender&sport=quidditch&art=foo&monat=1999-01&verein=nope');
  check(await evaluate(`location.hash === '#ansicht=kalender&monat=1999-01' && document.querySelector('.cal-title').textContent === 'September 2026'`), 'unknown hash values are dropped, an out-of-window month clamps to the data', `stale link gives ${await evaluate('location.hash')} / ${await evaluate(`document.querySelector('.cal-title').textContent`)}`);

  // --- 4. the DST end: the Tuesday training stays on Tuesday 19:00
  await open('#ansicht=kalender&sport=rugby&art=alle');
  const dst = await evaluate(`(() => {
    const day = (d) => [...document.querySelectorAll('[data-date="' + d + '"] .cal-ev')].map((c) => c.textContent);
    return { d20: day('2026-10-20'), d26: day('2026-10-26'), d27: day('2026-10-27'), d28: day('2026-10-28') };
  })()`);
  check(dst.d27.includes('19:00Training Herren') && dst.d20.includes('19:00Training Herren') && !dst.d26.some((x) => x.includes('Training Herren')) && !dst.d28.some((x) => x.includes('Training Herren')),
    'after the DST end the training is on Tuesday 27 Oct, 19:00 (and 20 Oct, 19:00 before it)', `DST days: ${JSON.stringify(dst)}`);
  // 00:30 in Bonn = 19:30 the day before in New York: the night run belongs to Saturday 31 Oct.
  await open('#ansicht=kalender&art=alle');
  const night = await evaluate(`(() => {
    const at = (d) => [...document.querySelectorAll('[data-date="' + d + '"] .cal-ev')].map((c) => c.textContent).filter((x) => x.includes('Mitternachtslauf'));
    return { d30: at('2026-10-30'), d31: at('2026-10-31') };
  })()`);
  await open('#q=Mitternachtslauf&art=alle');
  const nightRow = await evaluate(`({ date: document.querySelector('#table tbody tr .col-datum .date')?.textContent, time: document.querySelector('#table tbody tr .col-zeit .time')?.textContent })`);
  check(night.d30.length === 0 && night.d31.join() === '00:30Mitternachtslauf durch die Rheinaue' && nightRow.date === 'Sa., 31. Okt.' && nightRow.time === '00:30–02:00',
    'a 00:30 Bonn date stays on its Bonn day in New York (calendar and table)', `night probe: ${JSON.stringify({ night, nightRow })}`);
  await open('#ansicht=kalender&sport=rugby&art=alle');
  const busy = await evaluate(`(() => { const b = document.querySelector('[data-date="2026-10-17"]'); return { chips: b.querySelectorAll('.cal-ev').length, more: b.querySelector('.cal-more')?.textContent }; })()`);
  await open('#ansicht=kalender&art=alle&ort=alle');
  const busyAll = await evaluate(`(() => { const b = document.querySelector('[data-date="2026-10-17"]'); return { chips: b.querySelectorAll('.cal-ev').length, more: b.querySelector('.cal-more')?.textContent }; })()`);
  check(busyAll.chips === 3 && busyAll.more === '+1 weitere' && busy.chips === 1, 'a day with four dates shows three chips and "+1 weitere"', `busy day: ${JSON.stringify({ busy, busyAll })}`);
  await evaluate(`document.querySelector('[data-date="2026-10-26"]').click(), true`);
  await settle();
  const dayList = await evaluate(`({ title: document.querySelector('.cal-list-title').textContent, items: [...document.querySelectorAll('.cal-list .card .title')].map((x) => x.textContent) })`);
  check(dayList.title === 'Montag, 26. Oktober 2026' && dayList.items.some((x) => x.startsWith('Herbst: Fußballcamp')), 'a day click lists that day (the camp on its first day)', `day list: ${JSON.stringify(dayList)}`);

  // --- 5. foreign text stays text
  await open('#q=PSV');
  const xss = await evaluate(`({ text: document.querySelector('#table .col-titel .title')?.textContent ?? '', imgs: document.querySelectorAll('#table img, .cards img').length, alerts: globalThis.__alerts })`);
  check(xss.text.startsWith('<img src=x onerror=alert(1)>') && xss.imgs === 0 && xss.alerts === 0, 'an <img onerror> title renders as text, nothing executes', `xss probe: ${JSON.stringify(xss)}`);

  // --- 6. the download carries exactly what is shown
  await open('#sport=rugby&art=alle');
  const dl = await evaluate(`(async () => {
    let blob = null, name = null;
    const create = URL.createObjectURL;
    URL.createObjectURL = (b) => { blob = b; return create.call(URL, b); };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { name = this.download; };
    document.getElementById('download').click();
    HTMLAnchorElement.prototype.click = click;
    URL.createObjectURL = create;
    const text = blob ? await blob.text() : '';
    return { name, vevents: (text.match(/BEGIN:VEVENT/g) || []).length, crlf: text.includes('\\r\\n'), rows: document.querySelectorAll('#table tbody tr').length };
  })()`);
  check(dl.name === 'sportbonnii-rugby.ics' && dl.vevents === dl.rows && dl.rows === expectRows({ sport: ['rugby'], art: [] }) && dl.crlf, `.ics download: ${dl.vevents} VEVENTs = ${dl.rows} rows, ${dl.name}`, `download: ${JSON.stringify(dl)}`);
  const sub = await evaluate(`({ hidden: document.getElementById('subscribe').hidden, webcal: document.getElementById('sub-webcal').getAttribute('href'), url: document.getElementById('sub-url').value })`);
  check(!sub.hidden && sub.webcal === `webcal://127.0.0.1:${httpPort}/data/ics/sport-rugby.ics` && sub.url === `${BASE}data/ics/sport-rugby.ics`, 'one sport offers its feed, derived from the page location', `subscribe: ${JSON.stringify(sub)}`);

  // --- 7. clubs
  await open('#ansicht=vereine');
  const dirInfo = await evaluate(`({ result: document.getElementById('result').textContent, cards: document.querySelectorAll('.club').length, sources: document.querySelectorAll('table.sources tbody tr').length, zeit: document.getElementById('zeit-field').hidden, kind: document.getElementById('kind-field').hidden, actions: document.getElementById('view-actions').hidden })`);
  check(dirInfo.result === `${clubs.length} Vereine` && dirInfo.cards >= clubs.length && dirInfo.sources === 5 && dirInfo.zeit && dirInfo.kind && dirInfo.actions, `club directory: ${clubs.length} clubs, 5 sources listed, no range or kind filter`, `clubs: ${JSON.stringify(dirInfo)}`);
  // Venues sit on the club card as OpenStreetMap links: the mapped object when the registry names one, else a marker; the prefix says what the venue is for.
  const venues = await evaluate(`(() => {
    const links = (name) => { const card = [...document.querySelectorAll('.club')].find((c) => c.querySelector('.club-name').textContent === name); return [...(card?.querySelectorAll('.club-venues a.club-venue') ?? [])].map((a) => [a.textContent, a.getAttribute('href'), a.rel, a.title]); };
    return { gamecocks: links('Bonn Gamecocks'), rugby: links('Rugby Club Bonn-Rhein-Sieg'), roleber: links('BSV Roleber'), none: links('Bonner SC') };
  })()`);
  check(JSON.stringify(venues) === JSON.stringify({
    gamecocks: [
      ['📍 Spiele: Sportpark Pennenfeld', 'https://www.openstreetmap.org/way/26839678', 'noopener', 'Sportpark Pennenfeld, Mallwitzstraße, 53177 Bonn – in OpenStreetMap öffnen'],
      ['📍 Training: Sportplatz Brüser Berg', 'https://www.openstreetmap.org/?mlat=50.7029&mlon=7.04837#map=18/50.7029/7.04837', 'noopener', 'Sportplatz Brüser Berg, Schießstandweg 25, 53125 Bonn – in OpenStreetMap öffnen'],
    ],
    rugby: [['📍 Rugbyplatz Rheinaue', 'https://www.openstreetmap.org/way/123977272', 'noopener', 'Rugbyplatz Rheinaue, Martin-Luther-King-Str. 22, 53175 Bonn – in OpenStreetMap öffnen']],
    roleber: [['📍 Sportplatz Roleber', 'https://www.openstreetmap.org/way/50752096', 'noopener', 'Sportplatz Roleber, Siebengebirgsstraße 181, 53229 Bonn – in OpenStreetMap öffnen']],
    none: [],
  }), 'club cards link their venues to OpenStreetMap (object or marker, "Spiele:"/"Training:" prefix, none without venues)', `venues: ${JSON.stringify(venues)}`);
  // The "Neues zuletzt" column shows status.json's `changed` as a short date, a dash without one (the two disabled sources).
  const newsCol = await evaluate(`(() => { const th = [...document.querySelectorAll('table.sources thead th')].map((t) => t.textContent); const i = th.indexOf('Neues zuletzt'); return { i, cells: [...document.querySelectorAll('table.sources tbody tr')].map((tr) => [tr.children[0].textContent, tr.children[i]?.textContent]) }; })()`);
  const jetzt = newsCol.cells.find(([name]) => name === 'bonn.jetzt')?.[1];
  check(newsCol.i === 4 && jetzt === 'Mo., 12. Okt.' && newsCol.cells.filter(([, c]) => c === '–').length === 2 && newsCol.cells.filter(([, c]) => /^\w{2}\., \d{1,2}\. /.test(c)).length === 3, 'sources table: "Neues zuletzt" shows the changed date (bonn.jetzt: Mo., 12. Okt.), a dash for disabled sources', `news column: ${JSON.stringify(newsCol)}`);
  await evaluate(`document.querySelector('[data-show-club="bsv-roleber"]').click(), true`);
  await settle();
  check(await evaluate(`location.hash === '#art=alle&ort=alle&verein=bsv-roleber' && document.getElementById('f-club').value === 'BSV Roleber'`) && await rows() === expectRows({ verein: 'bsv-roleber', art: [], ort: 'alle' }), '"Termine" on a club card filters the table to all its dates', `club jump: ${await evaluate('location.hash')}`);

  // --- 7b. the map: venues with their dates, tiles only once it is open
  check(requests.filter(isTile).length === 0, 'no map tile is requested before the Karte tab opens', `tiles before the map: ${requests.filter(isTile).length}`);
  await open('#ansicht=karte');
  await waitFor(`document.querySelectorAll('#map .map-tile').length > 0 && [...document.querySelectorAll('#map .map-tile')].every((i) => i.complete)`, 6000);
  const every = { ...defaultState() };
  const { places } = mapPlaces(applyFilters(events, every, ctx), clubs, every);
  const mapInfo = await evaluate(`({
    markers: [...document.querySelectorAll('#map .map-marker')].map((b) => [b.dataset.marker, b.textContent, b.getAttribute('aria-label')]),
    tiles: [...document.querySelectorAll('#map .map-tile')].map((i) => [i.getAttribute('src'), i.naturalWidth]),
    list: document.querySelectorAll('#map .map-list-item').length,
    result: document.getElementById('result').textContent,
    zeit: document.getElementById('zeit-field').hidden, kind: document.getElementById('kind-field').hidden, actions: document.getElementById('view-actions').hidden,
    attrib: document.querySelector('#map .map-attrib a')?.getAttribute('href'),
  })`);
  const wantMarkers = places.map((p) => [p.id, p.events.length ? String(p.events.length) : '']);
  const located = places.reduce((n, p) => n + p.events.length, 0);
  check(JSON.stringify(mapInfo.markers.map(([id, n]) => [id, n])) === JSON.stringify(wantMarkers) && mapInfo.list === places.length
    && mapInfo.result === `${located} ${located === 1 ? 'Termin' : 'Termine'} auf der Karte` && !mapInfo.zeit && !mapInfo.kind && mapInfo.actions
    && mapInfo.attrib === 'https://www.openstreetmap.org/copyright',
  `map: ${places.length} venue markers with the dates map.js computes (${located} on the map), filters shown, OSM attribution`, `map: ${JSON.stringify({ mapInfo, wantMarkers, located })}`);
  check(mapInfo.tiles.length > 0 && mapInfo.tiles.every(([src, w]) => src.startsWith(TILE_URL) && /\/\d+\/\d+\/\d+\.png$/.test(src) && w === 1),
    `${mapInfo.tiles.length} tiles from tile.openstreetmap.org (answered locally)`, `tiles: ${JSON.stringify(mapInfo.tiles.slice(0, 4))}`);
  // A marker opens its venue: name, club, the next dates.
  const roleber = places.find((p) => p.id === 'bsv-roleber/0');
  await evaluate(`document.querySelector('#map [data-marker="bsv-roleber/0"]').click(), true`);
  await settle();
  const panel = await evaluate(`({ title: document.querySelector('.map-panel-title')?.textContent, club: document.querySelector('.map-panel-where [data-club]')?.textContent, dates: [...document.querySelectorAll('.map-dates .card .title')].map((x) => x.textContent), pressed: document.querySelector('#map [data-marker="bsv-roleber/0"]').getAttribute('aria-pressed') })`);
  check(panel.title === 'Sportplatz Roleber' && panel.club === 'BSV Roleber' && panel.pressed === 'true' && panel.dates.length === Math.min(5, roleber.events.length) && panel.dates.every((d, i) => d.startsWith(roleber.events[i].title)),
    `a marker opens its venue with its ${panel.dates.length} next dates`, `panel: ${JSON.stringify({ panel, want: roleber.events.map((e) => e.title) })}`);
  // Picking a place from the list keeps the keyboard focus on it.
  await evaluate(`(() => { const b = document.querySelector('#map [data-place="rc-bonn-rhein-sieg/0"]'); b.focus(); b.click(); return true; })()`);
  await settle();
  const kept = await evaluate(`({ focus: document.activeElement?.dataset?.place, title: document.querySelector('.map-panel-title')?.textContent })`);
  check(kept.focus === 'rc-bonn-rhein-sieg/0' && kept.title === 'Rugbyplatz Rheinaue', 'choosing a place in the list keeps the focus on it', `focus after pick: ${JSON.stringify(kept)}`);
  await evaluate(`document.querySelector('#map [data-marker="bsv-roleber/0"]').click(), true`);
  await settle();
  // Zoom and drag move the map.
  const zOf = () => evaluate(`Math.max(...[...document.querySelectorAll('#map .map-tile')].map((i) => Number(i.getAttribute('src').split('/').at(-3))))`);
  const z0 = await zOf();
  await evaluate(`document.querySelector('#map .map-zoom-in').click(), true`);
  await settle();
  const z1 = await zOf();
  const markerAt = () => evaluate(`document.querySelector('#map [data-marker="bsv-roleber/0"]').getBoundingClientRect().x`);
  const box = await evaluate(`(() => { const m = document.querySelector('#map .map'); m.scrollIntoView({ block: 'center' }); const r = m.getBoundingClientRect(); return { x: r.x + 60, y: r.y + 80 }; })()`);
  const x0 = await markerAt();
  await t.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 5; i++) await t.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + i * 20, y: box.y, button: 'left', buttons: 1 });
  await t.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 100, y: box.y, button: 'left', clickCount: 1 });
  await settle();
  const x1 = await markerAt();
  check(z1 === z0 + 1 && Math.abs(x1 - x0 - 100) <= 2, `zoom in loads z${z1} tiles; a 100 px drag moves the markers by ${Math.round(x1 - x0)} px`, `zoom/drag: z ${z0}→${z1}, marker ${x0}→${x1}`);
  await evaluate(`document.querySelector('.map-panel-where [data-club]').click(), true`);
  await settle();
  check(await evaluate(`location.hash`) === '#verein=bsv-roleber' && await rows() === expectRows({ verein: 'bsv-roleber' }), 'the club in the panel opens its dates in the table', `map club jump: ${await evaluate('location.hash')}`);
  await open('#ansicht=karte&sport=rugby&ort=auswaerts');
  const rugbyAway = await evaluate(`[...document.querySelectorAll('#map .map-marker')].map((b) => [b.dataset.marker, b.textContent])`);
  check(JSON.stringify(rugbyAway) === JSON.stringify([['rc-bonn-rhein-sieg/0', '']]), 'the filters narrow the map (rugby, away: the venue without dates)', `rugby away: ${JSON.stringify(rugbyAway)}`);

  // --- 8. phone width: cards and agenda
  await t.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await open();
  const phone = await evaluate(`({ table: getComputedStyle(document.querySelector('.table-wrap')).display, cards: document.querySelectorAll('.cards .card').length, overflow: document.documentElement.scrollWidth > innerWidth + 1 })`);
  check(phone.table === 'none' && phone.cards === expectRows({}) && !phone.overflow, `390 px: ${phone.cards} cards instead of the table, no horizontal overflow`, `phone table: ${JSON.stringify(phone)}`);
  await open('#ansicht=kalender');
  const agenda = await evaluate(`({ chips: getComputedStyle(document.querySelector('.cal-evs')).display, dots: getComputedStyle(document.querySelector('.cal-dots')).display, agenda: document.querySelectorAll('.agenda .card').length, overflow: document.documentElement.scrollWidth > innerWidth + 1 })`);
  check(agenda.chips === 'none' && agenda.dots === 'flex' && agenda.agenda > 0 && !agenda.overflow, `390 px: the grid shows dots, the agenda lists ${agenda.agenda} dates`, `phone calendar: ${JSON.stringify(agenda)}`);
  await open('#ansicht=karte');
  await waitFor(`document.querySelectorAll('#map .map-tile').length > 0`, 6000);
  const phoneMap = await evaluate(`({ w: document.querySelector('#map .map').getBoundingClientRect().width, markers: document.querySelectorAll('#map .map-marker').length, overflow: document.documentElement.scrollWidth > innerWidth + 1 })`);
  check(phoneMap.w > 300 && phoneMap.markers > 0 && !phoneMap.overflow, `390 px: the map spans ${Math.round(phoneMap.w)} px, no horizontal overflow`, `phone map: ${JSON.stringify(phoneMap)}`);
  await t.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  // --- 9. stale data: three days later
  await t.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: initId });
  initId = (await t.send('Page.addScriptToEvaluateOnNewDocument', { source: initScript(NOW + 3 * 86_400_000) })).identifier;
  await open();
  check(await evaluate(`!document.getElementById('stale').hidden && document.getElementById('stale').textContent.includes('14. Okt.')`), 'data older than 48 h raises the stale banner', `stale banner: ${await evaluate(`document.getElementById('stale').outerHTML`)}`);

  // --- 10. fresh check, but no source answered: the page says so
  await t.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: initId });
  initId = (await t.send('Page.addScriptToEvaluateOnNewDocument', { source: initScript(NOW) })).identifier;
  const metaPath = join(dir, 'data', 'meta.json');
  const meta = await readFile(metaPath, 'utf8');
  await writeFile(metaPath, meta.replace(/"sourcesOk": \d+/, '"sourcesOk": 0'));
  await open();
  check(await evaluate(`!document.getElementById('stale').hidden && document.getElementById('stale').textContent.includes('keine Quelle')`), 'a run in which no source answered raises the banner too', `no-source banner: ${await evaluate(`document.getElementById('stale').outerHTML`)}`);
  await writeFile(metaPath, meta);

  // --- hygiene
  const off = requests.filter((u) => !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:') && !(isTile(u) && served.has(u)));
  check(!off.length, `${requests.length} requests, all to the dev server or answered locally (${served.size} tiles)`, `requests beyond the dev server: ${off.join(', ')}`);
  check(!loud.length, 'no console error or warning (no CSP violation)', `console: ${loud.join(' | ')}`);
  check(!exceptions.length, 'no uncaught exception', `exceptions: ${exceptions.join(' | ')}`);
  await t.close();
} catch (e) {
  fail(`gate aborted: ${e.message}`);
} finally {
  await cleanup();
}
console.log(failures.length ? `browser gate: ${failures.length} failure(s)` : 'browser gate: all checks passed');
process.exit(failures.length ? 1 : 0);
