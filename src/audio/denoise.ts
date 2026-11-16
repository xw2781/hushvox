import wasmUrl from '@lofcz/deepfilternet-web/df_bg.wasm?url';
import { AppError } from './errors';
import { SAMPLE_RATE, type FromWorker, type ToWorker } from './protocol';

export interface Progress {
  phase: 'model' | 'processing';
  /** 0..1 */
  fraction: number;
  /** MB loaded / total (model phase) */
  loadedMB?: number;
  totalMB?: number;
  cached?: boolean;
  /** processing phase */
  etaSec?: number;
  speed?: number; // x realtime
}

export class CancelledError extends Error {
  constructor() { super('cancelled'); }
}

export interface Job {
  promise: Promise<AudioBuffer>;
  cancel(): void;
}

const CHUNK = 480 * 200; // 2 s, multiple of the 480-sample hop

/**
 * Runs DeepFilterNet3 over `input` in a Web Worker, chunk by chunk, and returns an AudioBuffer of
 * identical length / channel count (latency-compensated). Only Float32 data is held: the output
 * buffer is filled in place from transferred chunks.
 */
export function denoise(input: AudioBuffer, attenLimit: number, onProgress: (p: Progress) => void): Job {
  const worker = new Worker(new URL('./denoise.worker.ts', import.meta.url), { type: 'module' });
  const channels = input.numberOfChannels;
  const length = input.length;
  const output = new AudioBuffer({ length, numberOfChannels: channels, sampleRate: SAMPLE_RATE });
  const outData = Array.from({ length: channels }, (_, c) => output.getChannelData(c));
  const outPos = new Array(channels).fill(0);
  let rejectFn: (e: unknown) => void = () => {};

  const send = (m: ToWorker, t: Transferable[] = []) => worker.postMessage(m, t);

  const promise = new Promise<AudioBuffer>((resolve, reject) => {
    rejectFn = reject;
    const inPos = new Array(channels).fill(0);
    const totalSamples = length * channels;
    let doneIn = 0; // input samples whose output we've received
    let t0 = 0;
    // Work list: for each chunk index, each channel.
    let curCh = 0;
    let finished = 0;

    const sendNext = () => {
      const start = inPos[curCh];
      const end = Math.min(length, start + CHUNK);
      const data = input.getChannelData(curCh).slice(start, end);
      inPos[curCh] = end;
      send({ type: 'chunk', ch: curCh, data, last: end >= length }, [data.buffer]);
    };

    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === 'model-progress') {
        onProgress({ phase: 'model', fraction: m.loaded / m.total, loadedMB: m.loaded / 1048576, totalMB: m.total / 1048576, cached: m.cached });
      } else if (m.type === 'ready') {
        t0 = performance.now();
        onProgress({ phase: 'processing', fraction: 0 });
        if (length === 0) { resolve(output); return; }
        sendNext();
      } else if (m.type === 'chunk') {
        outData[m.ch].set(m.data, outPos[m.ch]);
        outPos[m.ch] += m.data.length;
        doneIn += m.data.length;
        if (m.last) finished++;
        if (finished === channels) {
          onProgress({ phase: 'processing', fraction: 1, etaSec: 0, speed: (length / SAMPLE_RATE) / ((performance.now() - t0) / 1000) });
          worker.terminate();
          resolve(output);
          return;
        }
        const el = (performance.now() - t0) / 1000;
        const frac = doneIn / totalSamples;
        const speed = (doneIn / channels / SAMPLE_RATE) / Math.max(el, 1e-3);
        onProgress({ phase: 'processing', fraction: frac, etaSec: el * (1 - frac) / Math.max(frac, 1e-6), speed });
        // alternate channels per chunk; skip channels that are fully sent
        for (let i = 1; i <= channels; i++) {
          const c = (curCh + i) % channels;
          if (inPos[c] < length) { curCh = c; sendNext(); return; }
        }
      } else if (m.type === 'error') {
        worker.terminate();
        reject(m.code ? new AppError(m.code, m.params, m.message) : new Error(m.message));
      }
    };
    worker.onerror = (ev) => { worker.terminate(); reject(new AppError('worker', {}, ev.message || 'Worker failed')); };
    send({ type: 'init', wasmUrl, channels, lengths: new Array(channels).fill(length), attenLimit });
  });

  return {
    promise,
    cancel() {
      worker.terminate();
      rejectFn(new CancelledError());
    },
  };
}
