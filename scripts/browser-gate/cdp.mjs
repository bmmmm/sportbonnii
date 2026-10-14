// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket.
// Usage: const t = await openTarget(9333); await t.send('Page.enable'); t.on('Log.entryAdded', fn);
export async function openTarget(port = 9333, url = 'about:blank') {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`json/new: ${res.status}`);
  const info = await res.json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { ok, bad } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? bad(new Error(JSON.stringify(msg.error))) : ok(msg.result);
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) || []) fn(msg.params);
    }
  };
  const send = (method, params = {}) => new Promise((ok, bad) => {
    const n = ++id;
    pending.set(n, { ok, bad });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const on = (method, fn) => { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(fn); };
  /** Evaluates `expr` (an expression, may be a promise) in the page; returns the value or throws the page exception. */
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const close = async () => {
    try { await fetch(`http://127.0.0.1:${port}/json/close/${info.id}`); } catch {}
    ws.close();
  };
  return { send, on, evaluate, close, info };
}
