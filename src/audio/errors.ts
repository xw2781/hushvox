import type { MsgKey } from '../i18n';

/** User-facing error identified by a code; the UI translates it (so language can change after it is thrown). */
export type ErrorCode = 'read' | 'decode' | 'wavTooLong' | 'model' | 'worker';
export type ErrorParams = Record<string, string | number>;

export class AppError extends Error {
  constructor(public code: ErrorCode, public params: ErrorParams = {}, message?: string) {
    super(message ?? `${code} ${JSON.stringify(params)}`);
  }
  /** i18n key for this error's message. */
  get key(): MsgKey { return `err.${this.code}` as MsgKey; }
}
