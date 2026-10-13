// HTML → plain text for event fields, ported verbatim from scalendarii
// (src/ingest/adapters/text.ts). Platform adapters receive HTML in titles
// and descriptions (WordPress encodes entities even in titles); events.json
// stores plain text only, so the page can show it with textContent and the
// ICS writer can emit it verbatim.
//
// Contract (every adapter): one-line fields (title) go through
// singleLineText, multi-line descriptions through htmlToText.

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bdquo: '„',
  laquo: '«', raquo: '»', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß',
  euro: '€', copy: '©', trade: '™', reg: '®',
};

/** Decode numeric (&#8211; / &#x2013;) and common named HTML entities. */
export function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const cp = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    if (body.startsWith('#')) {
      const cp = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/**
 * Accept only http(s) URLs — upstream url values are rendered as hrefs, so
 * javascript:/data:/file: schemes are rejected at ingest. Scheme-less bare
 * domains get https:// prefixed; with a base, relative paths resolve against it.
 */
export function safeHttpUrl(value, base) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  const parse = (input) => {
    try {
      return base ? new URL(input, base) : new URL(input);
    } catch {
      return null;
    }
  };
  let u = parse(s);
  if (!u && !/^[a-z][a-z0-9+.-]*:/i.test(s)) u = parse(`https://${s}`);
  if (!u) return null;
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
}

/**
 * Strip tags, decode entities, normalize whitespace — block-level elements
 * become newlines so paragraph structure survives as readable plain text.
 */
export function htmlToText(html) {
  const withBreaks = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(withBreaks)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * One-line text fields: strip tags, decode entities, collapse all whitespace
 * to single spaces. Tags are stripped BEFORE decoding so an encoded literal
 * like "&lt;3" survives as "<3" instead of being eaten as markup.
 */
export function singleLineText(raw) {
  return decodeEntities(raw.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Bounded warning collector: a hostile feed with 100k broken items must not
 * drown the run log. Keeps the first (most diagnostic) warnings and counts
 * the rest.
 */
export function createWarningSink(cap = 50) {
  const warnings = [];
  let suppressed = 0;
  return {
    push(w) {
      if (warnings.length < cap) warnings.push(w);
      else suppressed++;
    },
    list() {
      return suppressed > 0 ? [...warnings, `…${suppressed} further warning(s) suppressed`] : [...warnings];
    },
  };
}
