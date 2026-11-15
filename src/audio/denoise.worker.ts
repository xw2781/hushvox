/// <reference lib="webworker" />
import { DeepFilter } from '@lofcz/deepfilternet-web';
import { LATENCY_SAMPLES, MODEL_BYTES, type FromWorker, type ToWorker } from './protocol';

const post = (m: FromWorker, t: Transferable[] = []) => (self as unknown as Worker).postMessage(m, t);
const CACHE = 'hushvox-model-v1';

async function loadModelBytes(url: string): Promise<{ bytes: Uint8Array; cached: boolean }> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) {
      const bytes = new Uint8Array(await hit.arrayBuffer());
      post({ type: 'model-progress', loaded: bytes.length, total: bytes.length, cached: true });
      return { bytes, cached: true };
    }
  } catch {
    cache = null; // Cache API unavailable (e.g. private mode): just download.
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Could not download the model (HTTP ${res.status}).`);
  const headerLen = Number(res.headers.get('content-length')) || 0;
  const total = headerLen > MODEL_BYTES * 0.5 ? Math.max(headerLen, MODEL_BYTES) : MODEL_BYTES;
  const parts: Uint8Array[] = [];
  let loaded = 0;
  const reader = res.body.getReader();
  let lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    const now = performance.now();
    if (now - lastPost > 80) {
      lastPost = now;
      post({ type: 'model-progress', loaded: Math.min(loaded, total), total, cached: false });
    }
  }
  const bytes = new Uint8Array(loaded);
  let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }
  post({ type: 'model-progress', loaded: total, total, cached: false });
  if (cache) {
    try {
      await cache.put(url, new Response(bytes as BufferSource, { headers: { 'Content-Type': 'application/wasm' } }));
    } catch { /* quota etc.: not fatal */ }
  }
  return { bytes, cached: false };
}

interface Chan {
  df: DeepFilter;
  frame: number;
  pend: Float32Array;
  pendLen: number;
  skip: number; // latency samples still to drop from the output
  emitted: number;
  total: number;
}
let chans: Chan[] = [];

function feed(c: Chan, input: Float32Array, out: Float32Array, outPos: number): number {
  let i = 0;
  while (i < input.length) {
    const n = Math.min(c.frame - c.pendLen, input.length - i);
    c.pend.set(input.subarray(i, i + n), c.pendLen);
    c.pendLen += n;
    i += n;
    if (c.pendLen === c.frame) {
      const y = c.df.process(c.pend);
      c.pendLen = 0;
      let from = 0;
      if (c.skip > 0) { from = Math.min(c.skip, y.length); c.skip -= from; }
      const take = Math.min(y.length - from, c.total - c.emitted);
      if (take > 0) {
        out.set(y.subarray(from, from + take), outPos);
        outPos += take;
        c.emitted += take;
      }
    }
  }
  return outPos;
}

function handleChunk(ch: number, data: Float32Array, last: boolean) {
  const c = chans[ch];
  // Output can't exceed input + one frame of already pending samples (+ flush on last).
  const out = new Float32Array(data.length + c.frame + (last ? LATENCY_SAMPLES + c.frame * 2 : 0));
  let n = feed(c, data, out, 0);
  if (last) {
    // Flush: feed zeros until every input sample has produced time-aligned output.
    const zeros = new Float32Array(c.frame);
    let guard = 0;
    while (c.emitted < c.total && guard++ < 16) n = feed(c, zeros, out, n);
    // Anything still missing (shouldn't happen) stays zero-filled.
    n += Math.max(0, c.total - c.emitted);
    c.emitted = c.total;
  }
  const res = out.length === n ? out : out.slice(0, n);
  post({ type: 'chunk', ch, data: res, last }, [res.buffer]);
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      const { bytes, cached } = await loadModelBytes(m.wasmUrl);
      // DeepFilter.create() fetches the wasm by URL; hand it the bytes we already have
      // (this lets us report download progress and use the Cache API instead of HTTP caching).
      const realFetch = self.fetch.bind(self);
      self.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === m.wasmUrl
          ? Promise.resolve(new Response(bytes as BufferSource, { headers: { 'Content-Type': 'application/wasm' } }))
          : realFetch(input, init)) as typeof fetch;
      try {
        chans = [];
        for (let i = 0; i < m.channels; i++) {
          const df = await DeepFilter.create({ wasmUrl: m.wasmUrl, attenuationLimit: m.attenLimit });
          chans.push({ df, frame: df.frameLength, pend: new Float32Array(df.frameLength), pendLen: 0, skip: LATENCY_SAMPLES, emitted: 0, total: m.lengths[i] });
        }
      } finally {
        self.fetch = realFetch;
      }
      void cached;
      post({ type: 'ready' });
    } else if (m.type === 'chunk') {
      handleChunk(m.ch, m.data, m.last);
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
