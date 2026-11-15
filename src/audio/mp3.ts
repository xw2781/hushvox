// Lazy-loaded MP3 encoder (LAME via wasm-media-encoders, LGPL — see NOTICE).
// Isolated in this single module so the encoder can be swapped out easily.
import { createEncoder } from 'wasm-media-encoders';
import mp3WasmUrl from 'wasm-media-encoders/wasm/mp3?url';
import { SAMPLE_RATE } from './protocol';
import type { Mixer } from './wav';

const BLOCK = 1152 * 40;

export async function encodeMp3(channels: number, length: number, mix: Mixer, onProgress?: (f: number) => void, bitrate: 128 | 192 | 256 | 320 = 192): Promise<Blob> {
  const enc = await createEncoder('audio/mpeg', mp3WasmUrl);
  enc.configure({ sampleRate: SAMPLE_RATE, channels: channels as 1 | 2, bitrate });
  const out: BlobPart[] = [];
  const keep = (b: Uint8Array) => { if (b.length) out.push(b.slice().buffer); };
  const bufs = Array.from({ length: channels }, () => new Float32Array(BLOCK));
  for (let s = 0; s < length; s += BLOCK) {
    const n = Math.min(BLOCK, length - s);
    const blocks = bufs.map((b, c) => {
      const t = n === BLOCK ? b : new Float32Array(n);
      mix(c, s, t);
      return t;
    });
    keep(enc.encode(blocks));
    if (((s / BLOCK) & 15) === 0) {
      onProgress?.(s / length);
      await new Promise((r) => setTimeout(r));
    }
  }
  keep(enc.finalize());
  return new Blob(out, { type: 'audio/mpeg' });
}
