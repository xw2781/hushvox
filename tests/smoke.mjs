// Quick smoke test (iteration 1): node tests/smoke.mjs  (needs `npm run build` first)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 4173;
const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const readWav = (b) => { let o = 12, d, ch = 1; while (o < b.length) { const id = b.toString('ascii', o, o + 4), sz = b.readUInt32LE(o + 4); if (id === 'fmt ') ch = b.readUInt16LE(o + 10); if (id === 'data') { d = b.subarray(o + 8, o + 8 + sz); break; } o += 8 + sz + (sz & 1); } const n = d.length / 2 / ch; const f = new Float32Array(n); for (let i = 0; i < n; i++) f[i] = d.readInt16LE(i * 2 * ch) / 32768; return { f, ch }; };
let code = 0;
try {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const external = [];
  const errors = [];
  page.on('request', (r) => { if (!r.url().startsWith(`http://localhost:${PORT}`) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) external.push(r.url()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/`);
  await page.screenshot({ path: 'tests/out/idle.png' });
  const fixture = 'tests/local-fixtures/noisy_snr0.wav';
  const t0 = Date.now();
  await page.setInputFiles('#file', fixture);
  await page.waitForSelector('#state-result:not([hidden])', { timeout: 120000 });
  console.log('processed in ms', Date.now() - t0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'tests/out/result.png' });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dl-wav')]);
  console.log('wav name', dl.suggestedFilename());
  await dl.saveAs('tests/out/out.wav');
  await page.fill('#strength', '50').catch(() => {});
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#dl-mp3')]);
  console.log('mp3 name', dl2.suggestedFilename());
  await dl2.saveAs('tests/out/out.mp3');
  // playback sanity
  await page.click('#play'); await page.waitForTimeout(800);
  console.log('play label', await page.getAttribute('#play', 'aria-label'), '(headless has no real audio clock, so playhead time is not asserted)');
  await page.keyboard.press('a'); console.log('A key -> original checked:', await page.isChecked('#ab-a'));
  await page.keyboard.press('x'); console.log('X key -> enhanced checked:', await page.isChecked('#ab-b'));
  await page.keyboard.press('Space'); console.log('space ->', await page.getAttribute('#play', 'aria-label'));
  await page.fill('#seek', '500'); await page.waitForTimeout(200); console.log('seek 50% ->', await page.textContent('#time-now'));
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', deviceScaleFactor: 2 });
  await m.goto(`http://localhost:${PORT}/`);
  await m.setInputFiles('#file', fixture); await m.waitForSelector('#state-result:not([hidden])', { timeout: 120000 });
  await m.waitForTimeout(300); await m.screenshot({ path: 'tests/out/mobile-dark-result.png' });
  console.log('mobile h-scroll:', await m.evaluate(() => document.documentElement.scrollWidth > innerWidth));
  await browser.close();

  const inp = readWav(fs.readFileSync(fixture)), out = readWav(fs.readFileSync('tests/out/out.wav'));
  console.log('len in/out', inp.f.length, out.f.length, 'ch', out.ch);
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  console.log('rms in', rms(inp.f).toFixed(4), 'rms out', rms(out.f).toFixed(4));
  let best = -1, bl = 0;
  for (let L = -2000; L <= 2000; L += 1) { let s = 0; for (let i = 6000; i < inp.f.length - 6000; i += 3) s += inp.f[i] * out.f[i + L]; if (s > best) { best = s; bl = L; } }
  console.log('xcorr lag out vs noisy input (samples)', bl);
  const clean = readWav(fs.readFileSync('tests/local-fixtures/clean_freesound_33711.wav'));
  best = -1; bl = 0;
  for (let L = -2000; L <= 2000; L += 1) { let s = 0; for (let i = 6000; i < clean.f.length - 6000; i += 3) s += clean.f[i] * out.f[i + L]; if (s > best) { best = s; bl = L; } }
  console.log('xcorr lag out vs clean ref', bl);
  const mp3 = fs.readFileSync('tests/out/out.mp3'); console.log('mp3 bytes', mp3.length, 'head', mp3.subarray(0, 3).toString('hex'));
  console.log('external requests:', external.length ? external : 'none');
  console.log('page errors:', errors.length ? errors : 'none');
  if (external.length || errors.length) code = 1;
} catch (e) { console.error(e); code = 1; } finally { srv.kill(); }
process.exit(code);
