import type { ErrorCode, ErrorParams } from './errors';

export const SAMPLE_RATE = 48000;
/** Algorithmic latency of DeepFilterNet3 (measured by cross-correlation: 3 hops of 480 samples = 30 ms). */
export const LATENCY_SAMPLES = 1440;
/** Size of the model binary, used for download progress when no length is available. */
export const MODEL_BYTES = 34135648;

export type ToWorker =
  | { type: 'init'; wasmUrl: string; channels: number; lengths: number[]; attenLimit: number }
  | { type: 'chunk'; ch: number; data: Float32Array; last: boolean };

export type FromWorker =
  | { type: 'model-progress'; loaded: number; total: number; cached: boolean }
  | { type: 'ready' }
  | { type: 'chunk'; ch: number; data: Float32Array; last: boolean }
  | { type: 'error'; message: string; code?: ErrorCode; params?: ErrorParams };
