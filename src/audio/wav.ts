import { SAMPLE_RATE } from './protocol';

/** Mix function: fill `out` with blended samples of channel `ch` from sample `start`. */
export type Mixer = (ch: number, start: number, out: Float32Array) => void;

export function makeMixer(dry: AudioBuffer, wet: AudioBuffer, strength: number): Mixer {
  const d = Array.from({ length: dry.numberOfChannels }, (_, c) => dry.getChannelData(c));
  const w = Array.from({ length: wet.numberOfChannels }, (_, c) => wet.getChannelData(c));
  return (ch, start, out) => {
    const dc = d[ch], wc = w[ch];
    const n = out.length;
    if (strength >= 1) out.set(wc.subarray(start, start + n));
    else if (strength <= 0) out.set(dc.subarray(start, start + n));
    else for (let i = 0; i < n; i++) out[i] = dc[start + i] * (1 - strength) + wc[start + i] * strength;
  };
}

const BLOCK = 48000;

/** 16-bit PCM WAV, built block by block (no giant intermediate array). */
export async function encodeWav(channels: number, length: number, mix: Mixer, onProgress?: (f: number) => void): Promise<Blob> {
  const dataBytes = length * channels * 2;
  if (dataBytes > 0xffffffff - 44) throw new Error('This file is too long for a single WAV (4 GB limit). Try MP3.');
  const head = new DataView(new ArrayBuffer(44));
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) head.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); head.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE'); str(12, 'fmt ');
  head.setUint32(16, 16, true); head.setUint16(20, 1, true); head.setUint16(22, channels, true);
  head.setUint32(24, SAMPLE_RATE, true); head.setUint32(28, SAMPLE_RATE * channels * 2, true);
  head.setUint16(32, channels * 2, true); head.setUint16(34, 16, true); str(36, 'data'); head.setUint32(40, dataBytes, true);
  const parts: BlobPart[] = [head.buffer];
  const tmp = Array.from({ length: channels }, () => new Float32Array(BLOCK));
  for (let s = 0; s < length; s += BLOCK) {
    const n = Math.min(BLOCK, length - s);
    const pcm = new Int16Array(n * channels);
    for (let c = 0; c < channels; c++) {
      const t = n === BLOCK ? tmp[c] : new Float32Array(n);
      mix(c, s, t);
      for (let i = 0; i < n; i++) {
        const v = Math.max(-1, Math.min(1, t[i]));
        pcm[i * channels + c] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
      }
    }
    parts.push(pcm.buffer);
    if (((s / BLOCK) & 31) === 0) {
      onProgress?.(s / length);
      await new Promise((r) => setTimeout(r));
    }
  }
  return new Blob(parts, { type: 'audio/wav' });
}
