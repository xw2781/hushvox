// Numeric quality + speed measurement through the real UI/worker pipeline. Writes tests/RESULTS.md.
// Usage: npm run measure   (builds first)   |   MEASURE_LONG=0 to skip the 10-minute run.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { OUT, ROOT, SR, makeMix, writeWav16, readWav, energy, rms, db, startPreview, MARKS_SCRIPT, processViaUi, watchRequests } from './lib.mjs';

const CHUNK = 96000; // keep in sync with src/audio/denoise.ts (480*200)
const srv = await startPreview(4174);
const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
const context = await browser.newContext({ acceptDownloads: true });
await context.addInitScript(MARKS_SCRIPT);
const reqs = watchRequests(context, srv.url);
const page = await context.newPage();
await page.goto(srv.url + '/?lang=en');
const version = browser.version();

// Peak RSS of the whole browser process tree (sampled; shared pages are counted per process, so this over-estimates).
const browserPid = process.pid; // children of this node process = chromium tree
function treeRssMB() {
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
    const kids = new Map(); for (const [p, pp, r] of out) { (kids.get(pp) ?? kids.set(pp, []).get(pp)).push([p, r]); }
    let sum = 0; const walk = (p) => { for (const [c, r] of kids.get(p) ?? []) { sum += r; walk(c); } };
    walk(browserPid);
    return sum / 1024;
  } catch { return NaN; }
}
let peak = 0; const timer = setInterval(() => { const v = treeRssMB(); if (v > peak) peak = v; }, 500);
const idleRss = treeRssMB();

const lines = [];
const log = (s = '') => { console.log(s); lines.push(s); };

function xcorrLag(a, b, from, to, maxLag = 2400) { // lag L maximising sum a[i]*b[i+L]
  let best = -Infinity, bl = 0;
  for (let L = -maxLag; L <= maxLag; L++) {
    let s = 0; for (let i = from; i < to; i += 2) s += a[i] * b[i + L];
    if (s > best) { best = s; bl = L; }
  }
  return bl;
}
const snr = (ref, x, s, e) => { let n = 0; for (let i = s; i < e; i++) n += (x[i] - ref[i]) ** 2; return 10 * Math.log10(energy(ref, s, e) / n); };
/** SNR after the optimal scalar gain (ignores plain level change). */
const snrFit = (ref, x, s, e) => { let xy = 0, xx = 0; for (let i = s; i < e; i++) { xy += x[i] * ref[i]; xx += x[i] * x[i]; } const g = xy / xx; let n = 0; for (let i = s; i < e; i++) n += (g * x[i] - ref[i]) ** 2; return 10 * Math.log10(energy(ref, s, e) / n); };

const results = {};
for (const [kind, target] of [['real', 0], ['real', 10], ['white', 0], ['white', 10], ['pink', 0], ['pink', 10]]) {
  const key = `${kind}${target}`;
  const mix = makeMix(target, kind);
  const f = path.join(OUT, `measure-${key}.wav`); writeWav16(f, mix.noisy);
  const r = await processViaUi(page, f);
  const out = readWav(r.wavPath).f;
  const n = mix.noisy.length;
  let ei = 0, eo = 0, cnt = 0;
  for (const [s, e] of mix.noiseOnly) { for (let i = s; i < e; i++) { ei += mix.noisy[i] ** 2; eo += out[i] ** 2; } cnt += e - s; }
  const floorHit = Math.sqrt(eo / cnt) < 1e-5; // below -100 dBFS: 16-bit WAV floor, reduction is only a lower bound
  const red = db(Math.sqrt(ei / cnt)) - db(Math.max(Math.sqrt(eo / cnt), 1e-5));
  const snrIn = snr(mix.clean, mix.noisy, 0, n), snrOut = snr(mix.clean, out, 0, n);
  // Active-speech-only SNR (exclude digital-silence regions) to avoid rewarding noise removal there twice.
  const lag = xcorrLag(mix.clean, out, SR * 2, n - SR * 2 - 2400);
  const lagIn = xcorrLag(mix.clean, mix.noisy, SR * 2, n - SR * 2 - 2400);
  // chunk boundaries: |x[b]-x[b-1]| vs the mean |diff| in a +-5 ms neighbourhood; compare with non-boundary points (offset 48000)
  const ratio = (b) => { let s = 0, c = 0; for (let i = b - 240; i < b + 240; i++) if (i !== b) { s += Math.abs(out[i] - out[i - 1]); c++; } return Math.abs(out[b] - out[b - 1]) / (s / c + 1e-9); };
  const bnd = [], ctl = [];
  for (let b = CHUNK; b < n - 300; b += CHUNK) { bnd.push(ratio(b)); if (b + CHUNK / 2 < n - 300) ctl.push(ratio(b + CHUNK / 2)); }
  const tailN = Math.round(0.5 * SR);
  const tailSnr = snrFit(mix.clean, out, n - tailN, n);
  let zeros = 0; for (let i = n - 1; i >= 0 && out[i] === 0; i--) zeros++;
  let peakOut = 0, clipped = 0; for (const v of out) { const a = Math.abs(v); if (a > peakOut) peakOut = a; if (a >= 0.999) clipped++; }
  results[key] = { n, red, snrIn, snrOut, snrFitOut: snrFit(mix.clean, out, 0, n), lag, lagIn, bndMax: Math.max(...bnd), ctlMax: Math.max(...ctl), bndN: bnd.length, tailSnr, zeros, peakOut, clipped, floorHit, lenOk: out.length === n, procSec: r.procSec };
  const x = results[key];
  const label = { real: 'Real noise (CC0 Freesound 573577)', white: 'Synthetic white noise', pink: 'Synthetic low-passed ("pink-ish") noise' }[kind];
  log(`### ${label}, input SNR ${target} dB  (${(n / SR).toFixed(1)} s, mono)`);
  log(`- noise-only RMS reduction: **${x.floorHit ? '≥ ' : ''}${x.red.toFixed(1)} dB**  (input segments ${db(Math.sqrt(ei / cnt)).toFixed(1)} dBFS -> ${x.floorHit ? 'below -100' : db(Math.sqrt(eo / cnt)).toFixed(1)} dBFS)`);
  log(`- SNR vs clean reference (whole file, no gain fit): in ${x.snrIn.toFixed(1)} dB -> out ${x.snrOut.toFixed(1)} dB, **improvement ${(x.snrOut - x.snrIn).toFixed(1)} dB** (with best-fit gain: out ${x.snrFitOut.toFixed(1)} dB)`);
  log(`- lag check (cross-correlation vs clean ref, +-50 ms search): output ${x.lag} samples, noisy input ${x.lagIn} samples`);
  log(`- chunk boundaries (${x.bndN} at multiples of ${CHUNK} samples): worst sample-step / local mean step = ${x.bndMax.toFixed(2)}; same statistic at mid-chunk points = ${x.ctlMax.toFixed(2)}`);
  log(`- tail: output length ${x.lenOk ? '== input' : '!= input'}; trailing exact-zero samples ${x.zeros}; SNR of last 0.5 s (gain-fit) ${x.tailSnr.toFixed(1)} dB`);
  log(`- clipping: output peak ${x.peakOut.toFixed(3)}, samples >= 0.999: ${x.clipped}`);
  log(`- processing: ${x.procSec.toFixed(2)} s for ${(n / SR).toFixed(1)} s audio = **${(n / SR / x.procSec).toFixed(1)}× realtime**`);
  log();
}

// ---- speed: ~10 s (already measured above, at 0 dB) and ~10 min ------------------------------------------
const speed = {};
speed.short = { dur: results.real0.n / SR, x: results.real0.n / SR / results.real0.procSec };
if (process.env.MEASURE_LONG !== '0') {
  const mix = makeMix(5);
  const reps = Math.ceil(600 / (mix.noisy.length / SR));
  const big = new Float32Array(mix.noisy.length * reps);
  for (let k = 0; k < reps; k++) big.set(mix.noisy, k * mix.noisy.length);
  const f = path.join(OUT, 'measure-long.wav'); writeWav16(f, big);
  peak = 0;
  const r = await processViaUi(page, f);
  const w = readWav(r.wavPath);
  speed.long = { dur: big.length / SR, x: big.length / SR / r.procSec, sec: r.procSec, lenOk: w.length === big.length, peakRss: peak };
  // continuity across all ~300 chunk boundaries of the long file
  const out = w.f; let worst = 0, ctl = 0;
  const ratio = (b) => { let s = 0, c = 0; for (let i = b - 240; i < b + 240; i++) if (i !== b) { s += Math.abs(out[i] - out[i - 1]); c++; } return Math.abs(out[b] - out[b - 1]) / (s / c + 1e-9); };
  for (let b = CHUNK; b < out.length - 300; b += CHUNK) { let s = 0, c = 0; for (let i = b - 240; i < b + 240; i++) if (i !== b) { s += Math.abs(out[i] - out[i - 1]); c++; } worst = Math.max(worst, ratio(b)); if (b + CHUNK / 2 < out.length - 300) ctl = Math.max(ctl, ratio(b + CHUNK / 2)); }
  speed.long.bndWorst = worst; speed.long.ctlWorst = ctl; speed.long.bndN = Math.floor((out.length - 300) / CHUNK);
  fs.rmSync(f); fs.rmSync(r.wavPath);
}
clearInterval(timer);
log('### Speed');
log(`- ${speed.short.dur.toFixed(1)} s file: **${speed.short.x.toFixed(1)}× realtime**`);
if (speed.long) {
  log(`- ${(speed.long.dur / 60).toFixed(1)} min file: **${speed.long.x.toFixed(1)}× realtime** (${speed.long.sec.toFixed(0)} s), output length ${speed.long.lenOk ? '== input' : 'MISMATCH'}`);
  log(`- chunk-boundary continuity over ${speed.long.bndN} boundaries of the long file: worst step ratio ${speed.long.bndWorst.toFixed(2)} vs ${speed.long.ctlWorst.toFixed(2)} at mid-chunk control points`);
  log(`- peak browser RSS during the 10-min run (sum over all Chromium processes, sampled every 0.5 s, shared pages double-counted): ${speed.long.peakRss.toFixed(0)} MB (idle page: ${idleRss.toFixed(0)} MB)`);
}
log(`- model download/instantiate time is excluded from the xRealtime numbers (they start when the "Removing noise…" phase begins).`);
log();
log('### Network');
log(`- ${reqs.all.length} requests during the whole measurement; external (non-origin, non-blob/data): **${reqs.external.length}**`);

const header = `# Measured results

Generated by \`npm run measure\` (tests/measure.mjs) on ${new Date().toISOString().slice(0, 10)}.
Machine: ${os.cpus()[0].model.trim()}, ${os.cpus().length} logical CPUs, ${(os.totalmem() / 2 ** 30).toFixed(0)} GB RAM, ${os.platform()} ${os.release()}; headless Chromium ${version} (Playwright), node ${process.version}.
Pipeline: the production build served by \`vite preview\`; each file goes through the real UI (file input -> decode -> worker -> WAV export at Strength 100%), the exported 16-bit WAV is what is analysed.

Method: clean speech (public-domain LibriVox, 10.2 s) with 1.5 s of digital silence prepended and a 1.0 s gap inserted mid-clip, mixed with looping CC0 noise at a known SNR (speech power over non-silent samples vs. noise power). Real-noise rows are the main result; white and low-passed synthetic noise rows give context. Noise-only segments are the inserted-silence regions minus 100 ms guards. SNR figures compare against the (identically scaled) clean reference over the whole file including the noise-only gaps, so the "in" value sits ~1 dB below the nominal speech-active SNR. Speech-waveform SNR is a harsh metric for a perceptual model (phase and spectral-shape changes count as error); the real-noise 10 dB row, where it goes down, is reported as measured. These are single-noise-type, single-speaker numbers: indicative, not a benchmark.

`;
fs.writeFileSync(path.join(ROOT, 'tests', 'RESULTS.md'), header + lines.join('\n') + '\n');
await browser.close(); srv.stop();
process.exit(0);
