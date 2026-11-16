// Shared helpers for the e2e test and the measurement script.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = path.join(ROOT, 'tests', 'out');
export const FIX = path.join(ROOT, 'tests', 'fixtures');
export const SR = 48000;
fs.mkdirSync(OUT, { recursive: true });

export function readWav(file) {
  const b = Buffer.isBuffer(file) ? file : fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let o = 12, fmt = null, data = null;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), sz = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { tag: b.readUInt16LE(o + 8), ch: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === 'data') { data = { off: o + 8, size: Math.min(sz, b.length - o - 8), declared: sz }; break; }
    o += 8 + sz + (sz & 1);
  }
  if (!fmt || !data) throw new Error('missing fmt/data chunk');
  const frameBytes = (fmt.bits / 8) * fmt.ch;
  const n = Math.floor(data.size / frameBytes);
  const chans = Array.from({ length: fmt.ch }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < fmt.ch; c++) {
    const p = data.off + (i * fmt.ch + c) * (fmt.bits / 8);
    chans[c][i] = fmt.bits === 16 ? b.readInt16LE(p) / 32768 : fmt.bits === 32 && fmt.tag === 3 ? b.readFloatLE(p) : NaN;
  }
  return { ...fmt, length: n, declaredDataBytes: data.declared, actualDataBytes: data.size, chans, f: chans[0] };
}

export function writeWav16(file, f, rate = SR) {
  const n = f.length, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(f[i] * 32768))), 44 + i * 2);
  fs.writeFileSync(file, b);
}

export const energy = (a, s = 0, e = a.length) => { let t = 0; for (let i = s; i < e; i++) t += a[i] * a[i]; return t; };
export const rms = (a, s = 0, e = a.length) => Math.sqrt(energy(a, s, e) / Math.max(1, e - s));
export const db = (x) => 20 * Math.log10(Math.max(x, 1e-12));

/**
 * Builds the standard test signal: clean speech with 1.5 s of digital silence in front and a 1.0 s gap
 * inserted mid-clip (so there are real noise-only stretches), plus looping noise at `snrDb`.
 * SNR is speech power over the *active* (non-silent) samples vs noise power. The pair is scaled
 * together so the noisy mix peaks at 0.9 (no clipping in the 16-bit fixture).
 * Returns { clean, noisy, noiseOnly: [[start,end],...] (sample ranges, 100 ms guard) }.
 */
export function makeMix(snrDb, kind = 'real') {
  const sp = readWav(path.join(FIX, 'speech_librivox_gettysburg_10s.wav')).f;
  const nz = readWav(path.join(FIX, 'noise_freesound_573577.wav')).f;
  const lead = Math.round(1.5 * SR), gap = Math.round(1.0 * SR), at = Math.round(5.3 * SR);
  const clean = new Float32Array(lead + sp.length + gap);
  clean.set(sp.subarray(0, at), lead);
  clean.set(sp.subarray(at), lead + at + gap);
  const noise = new Float32Array(clean.length);
  if (kind !== 'real') { // synthetic: deterministic LCG, white or low-passed ("pink-ish", 1-pole 0.95)
    let seed = 1, y = 0; const r = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
    for (let i = 0; i < noise.length; i++) { y = (kind === 'pink' ? 0.95 : 0) * y + r() + r() + r(); noise[i] = y; }
  }
  const xf = 2400; // loop with a short crossfade so the loop point does not click
  if (kind === 'real') for (let i = 0, p = 0; i < noise.length; i++, p++) {
    if (p >= nz.length - xf) p = 0;
    noise[i] = p < xf && i >= xf ? nz[p] * (p / xf) + nz[nz.length - xf + p] * (1 - p / xf) : nz[p];
  }
  let ae = 0, an = 0;
  for (let i = 0; i < clean.length; i++) if (Math.abs(clean[i]) > 1e-4) { ae += clean[i] ** 2; an++; }
  const speechP = ae / an, noiseP = energy(noise) / noise.length;
  const g = Math.sqrt(speechP / noiseP / 10 ** (snrDb / 10));
  const noisy = new Float32Array(clean.length);
  let peak = 0;
  for (let i = 0; i < noisy.length; i++) { noisy[i] = clean[i] + g * noise[i]; peak = Math.max(peak, Math.abs(noisy[i])); }
  const k = 0.9 / peak;
  for (let i = 0; i < noisy.length; i++) { noisy[i] *= k; clean[i] *= k; }
  const guard = Math.round(0.1 * SR);
  const noiseOnly = [[guard, lead - guard], [lead + at + guard, lead + at + gap - guard]];
  return { clean, noisy, noiseOnly };
}

export async function startPreview(port = 4173) {
  const srv = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + '/')).ok) return { url, stop: () => srv.kill() }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  srv.kill();
  throw new Error('vite preview did not start (did you run `npm run build`?)');
}

/** Context-level request log: flags anything not served from the preview origin / blob: / data:. */
export function watchRequests(context, origin) {
  const external = [], all = [];
  context.on('request', (r) => {
    const u = r.url();
    all.push(u);
    if (!u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:')) external.push(u);
  });
  return { external, all };
}

export function hasFfmpeg() { try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } }
export function probeDuration(file) {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());
}

/** Install before page.goto: records when the processing phase (data-phase) starts and the result appears. */
export const MARKS_SCRIPT = () => {
  window.__marks = {};
  const watch = () => {
    const title = document.getElementById('busy-title'), result = document.getElementById('state-result');
    if (!title || !result) return requestAnimationFrame(watch);
    const upd = () => {
      if (title.dataset.phase === 'processing' && !window.__marks.procStart) window.__marks.procStart = performance.now();
      if (!result.hidden && !window.__marks.done) window.__marks.done = performance.now();
    };
    new MutationObserver(upd).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'data-phase'] });
  };
  document.addEventListener('DOMContentLoaded', watch);
};

/** Feeds `file` through the real UI, waits for the result, downloads the WAV export at current strength. */
export async function processViaUi(page, file, { timeout = 900000 } = {}) {
  await page.evaluate(() => { window.__marks = {}; });
  await page.setInputFiles('#file', file);
  await page.waitForSelector('#state-result:not([hidden])', { timeout });
  const marks = await page.evaluate(() => window.__marks);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dl-wav')]);
  const p = path.join(OUT, `dl-${Date.now()}.wav`);
  await dl.saveAs(p);
  return { wavPath: p, procSec: (marks.done - marks.procStart) / 1000, filename: dl.suggestedFilename() };
}
