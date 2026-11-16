import { t } from './i18n';

export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** Remaining-time phrase, e.g. "about 12 s left" (translated). */
export function fmtEta(sec: number): string {
  if (!isFinite(sec)) return t('eta.unknown');
  if (sec < 1.5) return t('eta.moment');
  if (sec < 90) return t('eta.sec', { n: Math.round(sec) });
  return t('eta.min', { n: Math.round(sec / 60) });
}

export function baseName(name: string): string {
  const i = name.lastIndexOf('.');
  return (i > 0 ? name.slice(0, i) : name) || 'audio';
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
