// End-to-end test. Run `npm run build` first (the npm script does it). Serves dist/ with vite preview.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { OUT, SR, makeMix, writeWav16, readWav, rms, db, startPreview, watchRequests, processViaUi, MARKS_SCRIPT, hasFfmpeg, probeDuration } from './lib.mjs';

const srv = await startPreview(4173);
let failed = 0;
const step = async (name, fn) => {
  try { await fn(); console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n      ', e.message.split('\n')[0]); }
};
const browser = await chromium.launch();
try {
  const mix = makeMix(5);
  const input = path.join(OUT, 'e2e-noisy.wav');
  writeWav16(input, mix.noisy);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await context.addInitScript(MARKS_SCRIPT);
  const reqs = watchRequests(context, srv.url);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(srv.url + '/');

  await step('idle page: title, privacy note, CSP meta', async () => {
    assert.match(await page.title(), /HushVox/i);
    assert.match(await page.locator('body').innerText(), /never leave your device/i);
    assert.match(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), /default-src 'self'/);
    assert.equal(await page.locator('script[type="application/ld+json"]').count() >= 1, true);
  });

  let outWavPath;
  await step('full flow: file -> processing -> result', async () => {
    const r = await processViaUi(page, input);
    outWavPath = r.wavPath;
    assert.equal(r.filename, 'e2e-noisy-hushvox.wav');
    assert.ok(await page.isVisible('#wave-a') && await page.isVisible('#wave-b'));
  });

  await step('WAV export is valid, same length, 48k 16-bit mono', async () => {
    const w = readWav(outWavPath);
    assert.equal(w.tag, 1); assert.equal(w.bits, 16); assert.equal(w.rate, SR); assert.equal(w.ch, 1);
    assert.equal(w.declaredDataBytes, w.actualDataBytes);
    assert.equal(w.length, mix.noisy.length);
  });

  await step('noise energy is reduced in noise-only segments (> 10 dB)', async () => {
    const w = readWav(outWavPath).f;
    let ei = 0, eo = 0, n = 0;
    for (const [s, e] of mix.noiseOnly) { for (let i = s; i < e; i++) { ei += mix.noisy[i] ** 2; eo += w[i] ** 2; } n += e - s; }
    const red = db(Math.sqrt(ei / n)) - db(Math.sqrt(eo / n));
    console.log(`        noise-only RMS reduction ${red.toFixed(1)} dB`);
    assert.ok(red > 10, `reduction only ${red.toFixed(1)} dB`);
    assert.ok(rms(w) > 0.01, 'output is (nearly) silent: speech was lost');
  });

  await step('strength slider: 0% export equals the original', async () => {
    await page.fill('#strength', '0');
    await page.dispatchEvent('#strength', 'input');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dl-wav')]);
    const p = path.join(OUT, 'e2e-strength0.wav'); await dl.saveAs(p);
    const w = readWav(p).f; let maxd = 0;
    for (let i = 0; i < w.length; i++) maxd = Math.max(maxd, Math.abs(w[i] - mix.noisy[i]));
    assert.ok(maxd < 2 / 32768 + 1e-6, `max diff ${maxd}`);
    await page.fill('#strength', '100'); await page.dispatchEvent('#strength', 'input');
  });

  await step('MP3 export is valid', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dl-mp3')]);
    assert.equal(dl.suggestedFilename(), 'e2e-noisy-hushvox.mp3');
    const p = path.join(OUT, 'e2e-out.mp3'); await dl.saveAs(p);
    const b = fs.readFileSync(p);
    assert.ok(b.length > 10000);
    const sync = (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) || b.toString('ascii', 0, 3) === 'ID3';
    assert.ok(sync, 'no MP3 frame sync / ID3 header');
    if (hasFfmpeg()) {
      const d = probeDuration(p);
      assert.ok(Math.abs(d - mix.noisy.length / SR) < 0.15, `mp3 duration ${d}`);
    } else console.log('        (ffprobe missing: header check only)');
  });

  await step('player: A/B toggle, keyboard shortcuts, seek', async () => {
    await page.keyboard.press('a'); assert.equal(await page.isChecked('#ab-a'), true);
    await page.keyboard.press('b'); assert.equal(await page.isChecked('#ab-b'), true);
    await page.keyboard.press('x'); assert.equal(await page.isChecked('#ab-a'), true);
    await page.click('#ab-b', { force: true });
    await page.click('#play'); assert.equal(await page.getAttribute('#play', 'aria-label'), 'Pause');
    await page.keyboard.press('Space'); assert.equal(await page.getAttribute('#play', 'aria-label'), 'Play');
    await page.fill('#seek', '500');
    assert.notEqual(await page.textContent('#time-now'), '0:00');
  });

  await step('"process another file" returns to idle; non-audio file shows a friendly error', async () => {
    await page.click('#another');
    assert.ok(await page.isVisible('#state-idle'));
    const bad = path.join(OUT, 'not-audio.txt'); fs.writeFileSync(bad, 'hello');
    await page.setInputFiles('#file', bad);
    await page.waitForSelector('#state-error:not([hidden])', { timeout: 20000 });
    assert.ok((await page.textContent('#error-msg')).length > 10);
  });

  await step('no external network requests, no page errors', async () => {
    console.log(`        ${reqs.all.length} requests total, all same-origin/blob/data`);
    assert.deepEqual(reqs.external, []);
    const real = errors.filter((e) => !/Failed to load resource.*(not-audio|decode)/i.test(e) && !/decod/i.test(e));
    assert.deepEqual(real, []);
  });

  await step('mobile viewport (390x844): no horizontal scroll, idle and result', async () => {
    const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true });
    await m.addInitScript(MARKS_SCRIPT);
    const mp = await m.newPage();
    await mp.goto(srv.url + '/');
    assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'idle overflows');
    await processViaUi(mp, input);
    assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'result overflows');
    await m.close();
  });
} catch (e) { console.error(e); failed++; } finally {
  await browser.close();
  srv.stop();
}
console.log(failed ? `\n${failed} FAILED` : '\nall e2e checks passed');
process.exit(failed ? 1 : 0);
