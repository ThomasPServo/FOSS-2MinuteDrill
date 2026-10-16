// Web Worker entry (module worker): loads the data set once and runs simulation jobs for
// pool.js. Messages: {type: 'init', baseUrl} -> {type: 'ready'} | {type: 'error'};
// {type: 'eval', id, ctx, state, options, n, seed, start} -> {type: 'result', id, sums}.

import { loadLibrary } from './data.js';
import { evaluateSums } from './sim.js';

let loading = null;

const fetchJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
};

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    loading = loadLibrary(msg.baseUrl, fetchJson);
    loading.then(() => self.postMessage({ type: 'ready' }), (err) => self.postMessage({ type: 'error', message: String(err) }));
    return;
  }
  if (msg.type === 'eval') {
    try {
      const lib = await loading;
      const sums = evaluateSums(lib, msg.ctx, msg.state, msg.options, msg);
      self.postMessage({ type: 'result', id: msg.id, sums }, [sums.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, message: String(err) });
    }
  }
};
