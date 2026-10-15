// The remembered filter choices: what is kept, what is ignored, and that a
// blocked or hostile storage never breaks the page. localStorage is replaced
// by a Map-backed stand-in (or a throwing one) around every test.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadChoices, remember } from '../site/store.js';
import { defaultState } from '../site/state.js';

const KEY = 'sportbonnii:auswahl';
const known = { sportIds: new Set(['rugby', 'fussball']), clubIds: new Set(['bsv-roleber']) };

function install(storage) {
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
}
function memory() {
  const map = new Map();
  install({
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  });
  return map;
}
afterEach(() => { delete globalThis.localStorage; });

const defaultChoices = () => {
  const { sport, art, ort, zeit } = defaultState();
  return { sport, art, ort, zeit };
};

test('nothing is kept until the visitor chooses something', () => {
  const map = memory();
  assert.equal(loadChoices(known), null);
  assert.equal(map.size, 0);
});

test('a choice is kept as hash text and comes back whole', () => {
  const map = memory();
  remember({ sport: ['rugby'] });
  assert.equal(map.get(KEY), '#sport=rugby');
  remember({ zeit: 'alle' });
  assert.equal(map.get(KEY), '#sport=rugby&zeit=alle', 'a new choice leaves the earlier ones');
  remember({ art: [] });
  assert.equal(map.get(KEY), '#sport=rugby&art=alle&zeit=alle');
  assert.deepEqual(loadChoices(known), { sport: ['rugby'], art: [], ort: 'heim', zeit: 'alle' });
  assert.deepEqual([...map.keys()], [KEY], 'one key, nothing else');
});

test('only sport, kind, home/away and range are kept', () => {
  const map = memory();
  remember({ verein: 'bsv-roleber', q: 'camp', ansicht: 'karte', monat: '2026-11' });
  assert.equal(map.size, 0, 'a club, a search, a view and a month are no preference');
  remember({ sport: ['fussball'], verein: 'bsv-roleber', q: 'camp', ansicht: 'karte', monat: '2026-11' });
  assert.equal(map.get(KEY), '#sport=fussball');
});

test('back at the defaults removes the entry', () => {
  const map = memory();
  remember({ sport: ['rugby'], ort: 'alle' });
  assert.equal(map.size, 1);
  remember({ sport: [] });
  assert.equal(map.get(KEY), '#ort=alle');
  remember(defaultState());
  assert.equal(map.size, 0, 'the brand and "Filter zurücksetzen" forget');
  assert.equal(loadChoices(known), null);
});

test('a stored value is untrusted: unknown ids and values fall away, other fields are never read', () => {
  const map = memory();
  map.set(KEY, '#sport=quidditch,rugby&ansicht=karte&q=x&verein=bsv-roleber&monat=2026-11&zeit=jahr&ort=zuhause&art=foo');
  const got = loadChoices(known);
  assert.deepEqual(got, { sport: ['rugby'], art: ['spiel'], ort: 'heim', zeit: 'woche' });
  assert.deepEqual(Object.keys(got).sort(), ['art', 'ort', 'sport', 'zeit']);
  map.set(KEY, `#q=${'a'.repeat(3000)}`);
  assert.equal(loadChoices(known), null, 'a value no choice could produce is ignored');
  map.set(KEY, '<script>alert(1)</script>');
  assert.deepEqual(loadChoices(known), defaultChoices(), 'text without a known field is the default');
});

test('blocked or failing storage never throws', () => {
  Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('SecurityError'); }, configurable: true });
  assert.equal(loadChoices(known), null);
  assert.doesNotThrow(() => remember({ sport: ['rugby'] }));
  install({ getItem: () => null, setItem() { throw new Error('QuotaExceededError'); }, removeItem() { throw new Error('nope'); } });
  assert.doesNotThrow(() => remember({ sport: ['rugby'] }));
  assert.doesNotThrow(() => remember(defaultState()));
  assert.equal(loadChoices(known), null);
});
