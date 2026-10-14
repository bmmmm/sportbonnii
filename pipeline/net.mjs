// The pipeline's only door to the network. Ported from scalendarii
// (src/ingest/fetcher.ts: capped read + encoding sniff; src/ingest/egress.ts:
// the private-address guard) onto Node's global fetch.
//
// - Every hop is checked: redirects are followed by hand, and each target
//   must be http(s), on a web port, and resolve to public addresses only.
//   Residual risk: without undici there is no DNS pinning, so a name that
//   answers public for the check and private for the connect (rebinding)
//   gets through. The intake bot feeds anonymous URLs into detect, so it runs
//   with https/443 only, four lookups (redirects and robots.txt not counted),
//   10 s and 2 MB each — on a GitHub runner that leaves little worth reaching.
// - robots.txt is honoured for crawl-type requests (→ NetError kind
//   "blocked"). A source's own subscription feed is fetched like a calendar
//   client would, without a robots check: calendar.google.com, for one,
//   disallows crawlers from the very ICS links it hands out for subscribing.
// - One request per host at a time, at least `minGapMs` apart.
// - Hard caps: timeout over the whole redirect chain, body bytes, redirects.
import { lookup as dnsLookup } from 'node:dns/promises';

export const USER_AGENT = 'sportbonnii/1.0 (+https://github.com/bmmmm/sportbonnii)';
const ROBOTS_TOKEN = 'sportbonnii';
const DEFAULTS = { timeoutMs: 20_000, maxBytes: 10 * 1024 * 1024, maxRedirects: 5, minGapMs: 1000 };
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const WEB_PORTS = new Set(['', '80', '443', '8080', '8443']);

/** A request that did not produce a usable body. `kind`: "blocked" (robots.txt, private target) or "error". */
export class NetError extends Error {
  constructor(message, kind = 'error') {
    super(message);
    this.name = 'NetError';
    this.kind = kind;
  }
}

// --- private-address guard (scalendarii egress.ts) -------------------------

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function ipv4LooksPrivate(dotted) {
  const [a, b, c] = dotted.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return true; // "this net", RFC 1918, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Eight 16-bit groups, or null when the spelling cannot be decoded with certainty. */
function parseIpv6(ip) {
  const bare = ip.split('%')[0];
  const halves = bare.split('::');
  if (halves.length > 2) return null;
  const side = (text) => {
    if (text === '') return [];
    const parts = text.split(':');
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.includes('.')) {
        if (i !== parts.length - 1 || !IPV4_LITERAL.test(part)) return null;
        const o = part.split('.').map(Number);
        if (o.some((n) => n > 255)) return null;
        out.push((o[0] << 8) | o[1], (o[2] << 8) | o[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };
  const head = side(halves[0]);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = side(halves[1]);
  if (tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...Array(fill).fill(0), ...tail];
}

/** The IPv4 address an IPv6 transition prefix carries (mapped, compatible, NAT64, 6to4), else null. */
function embeddedIpv4(g) {
  const dotted = (hi, lo) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zero = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 6)) return dotted(g[6], g[7]);
  if (zero(0, 5) && g[5] === 0xffff) return dotted(g[6], g[7]);
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return dotted(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b) return zero(2, 6) || (g[2] === 1 && zero(3, 6)) ? dotted(g[6], g[7]) : null;
  if (g[0] === 0x2002) return dotted(g[1], g[2]);
  return null;
}

/** Only global unicast (2000::/3) is public; everything undecodable is private. */
function ipv6LooksPrivate(bare) {
  const groups = parseIpv6(bare.toLowerCase());
  if (groups === null) return true;
  const v4 = embeddedIpv4(groups);
  if (v4 !== null) return ipv4LooksPrivate(v4);
  if (groups[0] === 0x2001 && (groups[1] === 0 || groups[1] === 0xdb8)) return true; // Teredo, documentation
  return (groups[0] & 0xe000) !== 0x2000;
}

/** True when a resolved address (no brackets) is private/internal. */
export function ipLooksPrivate(address, family) {
  return family === 6 ? ipv6LooksPrivate(address) : ipv4LooksPrivate(address);
}

/** True when the URL's host is a literal private/loopback/internal target, or unparseable (default deny). */
export function hostLooksPrivate(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return true;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host === 'home.arpa' || host.endsWith('.home.arpa')) return true;
  if (host.startsWith('[') && host.endsWith(']')) return ipv6LooksPrivate(host.slice(1, -1));
  if (IPV4_LITERAL.test(host)) return ipv4LooksPrivate(host);
  return false;
}

/** Throws a "blocked" NetError unless `url` may be fetched. */
async function checkTarget(url, { lookupImpl, httpsOnly }) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new NetError(`not a valid URL: ${url}`);
  }
  if (u.protocol !== 'https:' && (httpsOnly || u.protocol !== 'http:')) throw new NetError(`refusing ${u.protocol} URL ${url}`, 'blocked');
  if (httpsOnly ? u.port !== '' && u.port !== '443' : !WEB_PORTS.has(u.port)) throw new NetError(`refusing port ${u.port} in ${url}`, 'blocked');
  if (hostLooksPrivate(url)) throw new NetError(`refusing private or internal target ${u.hostname}`, 'blocked');
  const host = u.hostname;
  if (IPV4_LITERAL.test(host) || host.startsWith('[')) return;
  let addrs;
  try {
    addrs = await lookupImpl(host);
  } catch (e) {
    throw new NetError(`DNS lookup failed for ${host} (${e.code ?? e.message})`);
  }
  if (!addrs.length) throw new NetError(`DNS lookup for ${host} returned no address`);
  for (const a of addrs) {
    if (ipLooksPrivate(a.address, a.family)) throw new NetError(`refusing ${host}: resolves to private address ${a.address}`, 'blocked');
  }
}

// --- robots.txt --------------------------------------------------------------

/**
 * Rules for our user agent from a robots.txt body (RFC 9309): the group
 * naming "sportbonnii" wins over "*"; `*` wildcards and `$` anchors.
 */
export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (!lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === 'allow' || field === 'disallow') && current) {
      lastWasAgent = false;
      if (value !== '') current.rules.push({ allow: field === 'allow', path: value });
    } else {
      lastWasAgent = false;
    }
  }
  // RFC 9309: the product token matches case-insensitively, a version suffix aside.
  const own = groups.filter((g) => g.agents.some((a) => a.split('/')[0].trim() === ROBOTS_TOKEN));
  const chosen = own.length ? own : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

function ruleMatches(path, pattern) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp('^' + body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''));
  return re.test(path);
}

/** Longest matching rule wins; on a tie Allow wins; no match allows. */
export function robotsAllows(rules, pathAndQuery) {
  let best = null;
  for (const r of rules) {
    if (!ruleMatches(pathAndQuery, r.path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

// --- body reading ------------------------------------------------------------

function charsetFromContentType(contentType) {
  const m = /charset\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(contentType ?? '');
  return m?.[1] ?? m?.[2] ?? null;
}

function decoderFor(label) {
  if (!label?.trim()) return null;
  try {
    return new TextDecoder(label.trim());
  } catch {
    return null;
  }
}

/** Encoding from a BOM, an XML declaration or an HTML meta tag in the first 4 KB. */
function sniffEncoding(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  if (buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  if (buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  const head = new TextDecoder('ascii').decode(buf.subarray(0, Math.min(4096, buf.length)));
  const xml = /<\?xml\b[^>]*\?>/i.exec(head)?.[0];
  const xmlEnc = xml && /encoding\s*=\s*["']([^"']+)["']/i.exec(xml)?.[1];
  if (xmlEnc) return xmlEnc;
  for (const tag of head.matchAll(/<meta\b[^>]*>/gi)) {
    const cs = /charset\s*=\s*["']?([^\s"';/>]+)/i.exec(tag[0])?.[1];
    if (cs) return cs;
  }
  return null;
}

async function readCapped(res, maxBytes, truncate = false) {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes && !truncate) {
    void res.body?.cancel().catch(() => {});
    throw new NetError(`response too large: ${declared} bytes (limit ${maxBytes})`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      // Not awaited: cancelling must never hold the reader (a tee'd stream waits for its twin).
      void reader.cancel().catch(() => {});
      if (!truncate) throw new NetError(`response too large: more than ${maxBytes} bytes`);
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      break;
    }
    total += value.byteLength;
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  const decoder = decoderFor(charsetFromContentType(res.headers.get('content-type'))) ?? decoderFor(sniffEncoding(buf)) ?? new TextDecoder('utf-8');
  return decoder.decode(buf);
}

function describe(err, timeoutMs) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `timeout after ${timeoutMs} ms`;
  const cause = err?.cause;
  const causeText = cause ? (cause.code ? `${cause.code}: ${cause.message}` : cause.message) : null;
  return `network error: ${err?.message ?? String(err)}${causeText ? ` (${causeText})` : ''}`;
}

// --- the client --------------------------------------------------------------

/**
 * A network client. `get(url, { accept, robots = true, timeoutMs, maxBytes,
 * ifNoneMatch, ifModifiedSince })` resolves to `{ body, url, status,
 * contentType, etag, lastModified }` (url = after redirects; the validators
 * are the response headers or null) or rejects with a NetError. With
 * ifNoneMatch / ifModifiedSince the request is conditional and a 304 resolves
 * to `{ notModified: true, status: 304, etag, lastModified, body: null }`.
 * Options: fetchImpl, lookupImpl, sleep, now, minGapMs, timeoutMs, maxBytes,
 * maxRedirects, httpsOnly, maxRequests.
 */
export function createNet(opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    lookupImpl = (host) => dnsLookup(host, { all: true }),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    httpsOnly = false,
    maxRequests = Infinity,
  } = opts;
  const cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([k]) => k in DEFAULTS)) };
  const hosts = new Map(); // host → { tail: Promise, last: ms }
  const robotsCache = new Map(); // origin → Promise<rules>
  let requests = 0; // get() calls; robots.txt and redirect hops ride along

  /** Runs `fn` when this host is free and `minGapMs` has passed since its last request. */
  function onHost(host, fn) {
    const slot = hosts.get(host) ?? { tail: Promise.resolve(), last: -Infinity };
    hosts.set(host, slot);
    const run = slot.tail.then(async () => {
      const wait = slot.last + cfg.minGapMs - now();
      if (wait > 0) await sleep(wait);
      try {
        return await fn();
      } finally {
        slot.last = now();
      }
    });
    slot.tail = run.catch(() => {});
    return run;
  }

  /**
   * One HTTP exchange (no redirect handling), body included: the host slot is
   * held until the body is read, so two requests to one host never overlap.
   */
  async function exchange(url, { accept, clock, maxBytes, timeoutMs, truncate, conditional }) {
    return onHost(new URL(url).host, async () => {
      // The timeout runs from the first moment this request holds a slot, not
      // from when it joined a queue behind other sources on the same host.
      clock.deadline ??= now() + timeoutMs;
      const deadline = clock.deadline;
      const headers = { 'user-agent': USER_AGENT, accept };
      if (conditional?.ifNoneMatch) headers['if-none-match'] = conditional.ifNoneMatch;
      if (conditional?.ifModifiedSince) headers['if-modified-since'] = conditional.ifModifiedSince;
      // A request carrying If-None-Match puts Node's fetch into cache mode
      // "no-store", which adds "Cache-Control: no-cache" — and Express's
      // fresh() reads that as "never answer 304" (measured on bonn.jetzt).
      // Mode "no-cache" sends "max-age=0" instead and the 304 comes through.
      const cache = conditional ? { cache: 'no-cache' } : {};
      let res;
      try {
        res = await fetchImpl(url, { redirect: 'manual', headers, ...cache, signal: AbortSignal.timeout(Math.max(1, deadline - now())) });
      } catch (e) {
        throw new NetError(describe(e, timeoutMs));
      }
      const location = res.headers.get('location');
      if (REDIRECTS.has(res.status) && location) {
        void res.body?.cancel().catch(() => {});
        return { status: res.status, location };
      }
      const validators = { etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
      if (res.status === 304) {
        void res.body?.cancel().catch(() => {});
        // Only an answer to our own validators means "unchanged"; an unsolicited 304 is a broken server.
        if (headers['if-none-match'] || headers['if-modified-since']) return { status: 304, notModified: true, ...validators };
        throw new NetError('HTTP 304 without a conditional request');
      }
      if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        throw new NetError(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
      }
      try {
        return { status: res.status, body: await readCapped(res, maxBytes, truncate), contentType: res.headers.get('content-type'), ...validators };
      } catch (e) {
        throw e instanceof NetError ? e : new NetError(describe(e, timeoutMs));
      }
    });
  }

  /** GET following redirects by hand, every hop vetted. */
  async function rawGet(url, { accept, timeoutMs = cfg.timeoutMs, maxBytes = cfg.maxBytes, robots, truncate = false, conditional }) {
    const clock = { deadline: null };
    let current = url;
    for (let hop = 0; ; hop++) {
      await checkTarget(current, { lookupImpl, httpsOnly });
      if (robots) await assertRobots(current);
      const res = await exchange(current, { accept, clock, maxBytes, timeoutMs, truncate, conditional });
      if (res.notModified) return { notModified: true, body: null, url: current, status: 304, contentType: null, etag: res.etag, lastModified: res.lastModified };
      if (res.location === undefined) {
        return { body: res.body, url: current, status: res.status, contentType: res.contentType, etag: res.etag, lastModified: res.lastModified };
      }
      if (hop >= cfg.maxRedirects) throw new NetError(`more than ${cfg.maxRedirects} redirects from ${url}`);
      try {
        current = new URL(res.location, current).toString();
      } catch {
        throw new NetError(`unparseable redirect target from ${current}`);
      }
    }
  }

  async function assertRobots(url) {
    const u = new URL(url);
    if (!robotsCache.has(u.origin)) {
      // RFC 9309 §2.5: parse at least the first 500 KiB; a longer file is cut, not refused.
      robotsCache.set(u.origin, rawGet(`${u.origin}/robots.txt`, { accept: 'text/plain', robots: false, timeoutMs: 10_000, maxBytes: 512 * 1024, truncate: true })
        .then((r) => parseRobots(r.body))
        .catch((e) => {
          // RFC 9309 §2.3.1: 4xx means there are no rules; an unreachable
          // robots.txt (5xx, network) means assume full disallow.
          if (/^HTTP 4\d\d/.test(e.message)) return [];
          return { unavailable: e.message };
        }));
    }
    const rules = await robotsCache.get(u.origin);
    if (rules.unavailable) throw new NetError(`robots.txt of ${u.host} unavailable (${rules.unavailable}) — not crawling`);
    if (!robotsAllows(rules, u.pathname + u.search)) throw new NetError(`robots.txt of ${u.host} disallows ${u.pathname}`, 'blocked');
  }

  return {
    get(url, { accept = '*/*', robots = true, timeoutMs, maxBytes, ifNoneMatch, ifModifiedSince } = {}) {
      if (++requests > maxRequests) return Promise.reject(new NetError(`request budget of ${maxRequests} exhausted`));
      const conditional = ifNoneMatch || ifModifiedSince ? { ifNoneMatch, ifModifiedSince } : undefined;
      return rawGet(url, { accept, robots, timeoutMs, maxBytes, conditional });
    },
    get requestCount() {
      return requests;
    },
  };
}
