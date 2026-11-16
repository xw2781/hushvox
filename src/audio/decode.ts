import { SAMPLE_RATE } from './protocol';
import { AppError } from './errors';

export class DecodeError extends AppError {
  constructor(code: 'read' | 'decode') { super(code, {}, code === 'read' ? 'Could not read that file.' : 'Your browser could not decode this file.'); }
}

/**
 * Decode any browser-supported audio/video file to a 48 kHz AudioBuffer (1 or 2 channels).
 * decodeAudioData resamples to the context's rate, so an OfflineAudioContext at 48 kHz does the resampling.
 */
export async function decodeFile(file: File): Promise<AudioBuffer> {
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    throw new DecodeError('read');
  }
  let decoded: AudioBuffer;
  try {
    const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
    decoded = await ctx.decodeAudioData(bytes);
  } catch {
    throw new DecodeError('decode');
  }
  if (decoded.numberOfChannels <= 2) return decoded;
  // Multichannel: let the browser's standard speaker downmix produce stereo.
  const off = new OfflineAudioContext(2, decoded.length, SAMPLE_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  return off.startRendering();
}
