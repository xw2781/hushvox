import { SAMPLE_RATE } from './protocol';

export class DecodeError extends Error {}

/**
 * Decode any browser-supported audio/video file to a 48 kHz AudioBuffer (1 or 2 channels).
 * decodeAudioData resamples to the context's rate, so an OfflineAudioContext at 48 kHz does the resampling.
 */
export async function decodeFile(file: File): Promise<AudioBuffer> {
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    throw new DecodeError('Could not read that file.');
  }
  let decoded: AudioBuffer;
  try {
    const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
    decoded = await ctx.decodeAudioData(bytes);
  } catch {
    throw new DecodeError(
      "Your browser couldn't decode this file. Try WAV, MP3, M4A/AAC, OGG, FLAC or WebM — or a video file that contains an audio track in one of those formats.",
    );
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
