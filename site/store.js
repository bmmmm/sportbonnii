// The visitor's filter choices — sport, kind, home/away, time range — kept in
// this browser so a return visit opens on them instead of on the default. The
// one place on the page that touches storage (web-smoke.mjs pins that to one
// key and three calls). Nothing else is kept: no search text, club or month
// (a search or a club link is an errand, not a preference), no view (a stored
// Karte would load map tiles before the visitor asked for them), nothing that
// identifies anyone, and nothing leaves the device.
//
// The value is the hash text of the four fields, so reading goes through
// parseHash: unknown ids and values fall away, a link-sized value or anything
// foreign is ignored. A Pages origin is shared by every project site of the
// account, hence the namespaced key; the value is treated as untrusted input.
import { parseHash, formatHash, defaultState } from './state.js';

const KEY = 'sportbonnii:auswahl';
const MAX = 2000;
const CHOICES = ['sport', 'art', 'ort', 'zeit'];

const pick = (o) => Object.fromEntries(CHOICES.filter((k) => k in o).map((k) => [k, o[k]]));

/** The stored text, or null: none, too long, or storage unavailable (blocked, private mode). */
function read() {
  try {
    const text = localStorage.getItem(KEY);
    return typeof text === 'string' && text.length <= MAX ? text : null;
  } catch {
    return null;
  }
}

/** The remembered { sport, art, ort, zeit } (ids checked against `known`), or null when nothing is kept. */
export function loadChoices(known) {
  const text = read();
  return text === null ? null : pick(parseHash(text, known));
}

/**
 * Keep the fields of `patch` the visitor just chose; the other three stay as
 * they were. Everything back at its default removes the entry.
 */
export function remember(patch) {
  const next = { ...defaultState(), ...(loadChoices() ?? {}), ...pick(patch) };
  const text = formatHash({ ...defaultState(), ...pick(next) });
  try {
    if (text) localStorage.setItem(KEY, text);
    else localStorage.removeItem(KEY);
  } catch {
    // Blocked or full: the page works the same, it just forgets.
  }
}
