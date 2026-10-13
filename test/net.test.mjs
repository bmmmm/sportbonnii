// Network client: private-address table, per-hop redirect check, byte cap,
// robots.txt, per-host spacing, encoding sniff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNet, hostLooksPrivate, ipLooksPrivate, parseRobots, robotsAllows, NetError } from '../pipeline/net.mjs';

const PUBLIC = async () => [{ address: '93.184.216.34', family: 4 }];

/** A fake fetch over a routing table url → Response | (req) => Response. */
function fakeFetch(routes, log = []) {
  return async (url, init) => {
    log.push({ url: String(url), init });
    const r = routes[String(url)];
    if (!r) return new Response('not found', { status: 404 });
    return typeof r === 'function' ? r(init) : r.clone();
  };
}
const quiet = (extra) => ({ lookupImpl: PUBLIC, sleep: async () => {}, minGapMs: 0, ...extra });

test('private and internal targets are recognised', () => {
  const priv = ['http://127.0.0.1/', 'http://10.1.2.3/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/',
    'http://100.64.0.1/', 'http://0.0.0.0/', 'http://224.0.0.1/', 'http://localhost/', 'http://localhost./', 'http://x.localhost/',
    'http://nas.local/', 'http://db.internal/', 'http://router.lan/', 'http://[::1]/', 'http://[::ffff:10.0.0.1]/',
    'http://[fe80::1]/', 'http://[fc00::1]/', 'http://[64:ff9b::a9fe:a9fe]/', 'http://[2002:a00:1::]/', 'not a url'];
  for (const u of priv) assert.equal(hostLooksPrivate(u), true, u);
  for (const u of ['https://bonn.jetzt/', 'https://93.184.216.34/', 'https://[2606:4700::1111]/', 'https://calendar.google.com/']) {
    assert.equal(hostLooksPrivate(u), false, u);
  }
  assert.equal(ipLooksPrivate('10.0.0.5', 4), true);
  assert.equal(ipLooksPrivate('2a00:1450:4001::200e', 6), false);
});

test('a public name resolving to a private address is blocked', async () => {
  const net = createNet(quiet({ lookupImpl: async () => [{ address: '192.168.0.10', family: 4 }], fetchImpl: fakeFetch({}) }));
  await assert.rejects(net.get('https://evil.example/', { robots: false }), (e) => e instanceof NetError && e.kind === 'blocked' && /private address/.test(e.message));
});

test('every redirect hop is re-checked', async () => {
  const routes = {
    'https://club.example/feed.ics': new Response('', { status: 302, headers: { location: 'http://127.0.0.1/admin' } }),
    'https://club.example/ok.ics': new Response('', { status: 301, headers: { location: '/final.ics' } }),
    'https://club.example/final.ics': new Response('BEGIN:VCALENDAR'),
  };
  const net = createNet(quiet({ fetchImpl: fakeFetch(routes) }));
  await assert.rejects(net.get('https://club.example/feed.ics', { robots: false }), /private or internal/);
  const r = await net.get('https://club.example/ok.ics', { robots: false });
  assert.equal(r.body, 'BEGIN:VCALENDAR');
  assert.equal(r.url, 'https://club.example/final.ics');
});

test('redirect loops stop at the cap', async () => {
  const loop = () => new Response('', { status: 302, headers: { location: 'https://club.example/loop' } });
  const net = createNet(quiet({ fetchImpl: fakeFetch({ 'https://club.example/loop': loop }) }));
  await assert.rejects(net.get('https://club.example/loop', { robots: false }), /more than 5 redirects/);
});

test('the byte cap holds with and without content-length', async () => {
  const big = 'x'.repeat(2000);
  const routes = {
    'https://club.example/declared': new Response(big, { headers: { 'content-length': '2000' } }),
    'https://club.example/stream': () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 4; i++) c.enqueue(new TextEncoder().encode(big)); c.close(); } })),
  };
  const net = createNet(quiet({ fetchImpl: fakeFetch(routes), maxBytes: 1000 }));
  await assert.rejects(net.get('https://club.example/declared', { robots: false }), /too large/);
  await assert.rejects(net.get('https://club.example/stream', { robots: false }), /too large/);
});

test('HTTP errors and non-web ports are reported', async () => {
  const net = createNet(quiet({ fetchImpl: fakeFetch({}) }));
  await assert.rejects(net.get('https://club.example/missing', { robots: false }), /HTTP 404/);
  await assert.rejects(net.get('https://club.example:22/', { robots: false }), (e) => e.kind === 'blocked');
  const strict = createNet(quiet({ fetchImpl: fakeFetch({}), httpsOnly: true }));
  await assert.rejects(strict.get('http://club.example/', { robots: false }), (e) => e.kind === 'blocked');
  await assert.rejects(strict.get('https://club.example:8443/', { robots: false }), (e) => e.kind === 'blocked');
});

test('robots.txt: own group beats *, longest match wins, Allow wins ties, $ anchors', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: sportbonnii\nDisallow: /private\nAllow: /private/public\n');
  assert.equal(robotsAllows(rules, '/events'), true);
  assert.equal(robotsAllows(rules, '/private/x'), false);
  assert.equal(robotsAllows(rules, '/private/public/x'), true);
  const google = parseRobots('User-agent: *\nAllow: /$\nDisallow: /\n');
  assert.equal(robotsAllows(google, '/'), true);
  assert.equal(robotsAllows(google, '/calendar/ical/x/public/basic.ics'), false);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow:\n'), '/anything'), true);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /*.php$\n'), '/index.php'), false);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /*.php$\n'), '/index.php?x=1'), true);
});

test('crawl requests honour robots.txt; subscription feeds may skip it', async () => {
  const routes = {
    'https://cal.example/robots.txt': new Response('User-agent: *\nDisallow: /cal/\n'),
    'https://cal.example/cal/feed.ics': new Response('BEGIN:VCALENDAR'),
  };
  const log = [];
  const net = createNet(quiet({ fetchImpl: fakeFetch(routes, log) }));
  await assert.rejects(net.get('https://cal.example/cal/feed.ics'), (e) => e.kind === 'blocked' && /robots\.txt/.test(e.message));
  assert.equal((await net.get('https://cal.example/cal/feed.ics', { robots: false })).body, 'BEGIN:VCALENDAR');
  await assert.rejects(net.get('https://cal.example/cal/other.ics'), /robots/);
  assert.equal(log.filter((l) => l.url.endsWith('/robots.txt')).length, 1, 'robots.txt is fetched once per origin');
  const missing = createNet(quiet({ fetchImpl: fakeFetch({ 'https://open.example/x': new Response('ok') }) }));
  assert.equal((await missing.get('https://open.example/x')).body, 'ok', 'no robots.txt allows everything');
});

test('one request per host at a time, spaced by minGapMs; user agent sent', async () => {
  let clock = 0;
  const starts = [];
  let active = 0;
  let maxActive = 0;
  const fetchImpl = async (url, init) => {
    starts.push({ url: String(url), t: clock });
    assert.match(init.headers['user-agent'], /^sportbonnii\/1\.0 \(\+https:\/\/github\.com\/bmmmm\/sportbonnii\)$/);
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return new Response('ok');
  };
  const net = createNet({ fetchImpl, lookupImpl: PUBLIC, now: () => clock, sleep: async (ms) => { clock += ms; }, minGapMs: 1000 });
  await Promise.all([1, 2, 3].map((i) => net.get(`https://same.example/${i}`, { robots: false })));
  assert.equal(maxActive, 1);
  assert.deepEqual(starts.map((s) => s.t), [0, 1000, 2000]);
});

test('encoding: header charset, then meta sniff', async () => {
  const latin1 = new Uint8Array([0x3c, 0x6d, 0x65, 0x74, 0x61, 0x20, 0x63, 0x68, 0x61, 0x72, 0x73, 0x65, 0x74, 0x3d, 0x22, 0x69, 0x73, 0x6f, 0x2d, 0x38, 0x38, 0x35, 0x39, 0x2d, 0x31, 0x22, 0x3e, 0x46, 0xfc, 0xdf]);
  const routes = { 'https://old.example/': new Response(latin1, { headers: { 'content-type': 'text/html' } }) };
  const net = createNet(quiet({ fetchImpl: fakeFetch(routes) }));
  assert.match((await net.get('https://old.example/', { robots: false })).body, /Füß$/);
});
