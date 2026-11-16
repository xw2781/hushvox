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

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, locale: 'en-US' });
  await context.addInitScript(MARKS_SCRIPT);
  const reqs = watchRequests(context, srv.url);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(srv.url + '/?lang=en');

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
    const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true, locale: 'en-US' });
    await m.addInitScript(MARKS_SCRIPT);
    const mp = await m.newPage();
    await mp.goto(srv.url + '/?lang=en');
    assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'idle overflows');
    await processViaUi(mp, input);
    assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'result overflows');
    await m.close();
  });

  // ---- i18n -------------------------------------------------------------------------------
  const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  const fresh = async (opts = {}) => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US', ...opts });
    return { c, p: await c.newPage() };
  };
  const SAMPLE = { zh: { h1: '去除人声录音中的噪音', nav: '工作原理', btn: '下载 WAV', html: 'zh-CN', title: /在浏览器中私密地去除/, desc: /免费开源的人声降噪工具/ },
                   ja: { h1: '録音した声から、ノイズをなくします', nav: '仕組み', btn: 'WAV をダウンロード', html: 'ja', title: /ブラウザ内でプライバシーを守って除去/, desc: /無料のオープンソース音声ノイズ除去ツール/ },
                   ko: { h1: '녹음된 목소리에서 노이즈를 없애 보세요', nav: '작동 방식', btn: 'WAV 다운로드', html: 'ko', title: /브라우저에서 비공개로/, desc: /무료 오픈 소스 음성 노이즈 제거 도구/ } };

  await step('i18n: header switcher is visible, lists four languages in their own script, labelled accessibly', async () => {
    const { c, p } = await fresh();
    await p.goto(srv.url + '/?lang=en');
    assert.ok(await p.isVisible('header.top #lang'));
    assert.deepEqual(await p.locator('#lang option').allTextContents(), ['English', '简体中文', '日本語', '한국어']);
    assert.equal(await p.getAttribute('#lang', 'aria-label'), 'Language');
    assert.equal(await p.locator('html').getAttribute('lang'), 'en');
    await p.selectOption('#lang', 'ja');
    assert.equal(await p.getAttribute('#lang', 'aria-label'), '言語');
    await c.close();
  });

  for (const [lang, x] of Object.entries(SAMPLE)) {
    await step(`i18n: switching to ${lang} updates headline, nav, button, <html lang>, title, meta`, async () => {
      const { c, p } = await fresh();
      await p.goto(srv.url + '/?lang=en');
      await p.selectOption('#lang', lang);
      assert.match(await p.textContent('h1'), new RegExp(x.h1));
      assert.equal((await p.textContent('header nav a:first-child')).trim(), x.nav);
      assert.equal((await p.textContent('#dl-wav')).trim(), x.btn);
      assert.equal(await p.evaluate(() => document.documentElement.lang), x.html);
      assert.match(await p.title(), x.title);
      assert.match(await p.getAttribute('meta[name="description"]', 'content'), x.desc);
      assert.match(await p.getAttribute('meta[property="og:title"]', 'content'), /HushVox/);
      assert.notEqual(await p.getAttribute('meta[property="og:description"]', 'content'), 'Free, open-source speech enhancement. DeepFilterNet3 runs locally as WebAssembly — your audio never leaves your device.');
      assert.notEqual(await p.getAttribute('meta[name="twitter:title"]', 'content'), 'HushVox — private, in-browser voice noise removal');
      assert.equal(new URL(p.url()).searchParams.get('lang'), lang);
      // no raw message keys leaked, and no English leftovers in the privacy note
      const leaks = await p.evaluate(() => [...document.querySelectorAll('[data-i18n],[data-i18n-html]')].filter((e) => e.textContent.trim() === (e.dataset.i18n || e.dataset.i18nHtml)).length);
      assert.equal(leaks, 0);
      assert.doesNotMatch(await p.textContent('.privacy-note'), /never leave/i);
      await c.close();
    });
  }

  await step('i18n: choice persists across reload (localStorage); URL param keeps other params and the hash', async () => {
    const { c, p } = await fresh();
    await p.goto(srv.url + '/?x=1&lang=en#faq');
    await p.selectOption('#lang', 'ko');
    assert.equal(await p.evaluate(() => localStorage.getItem('hushvox-lang')), 'ko');
    const u = new URL(p.url());
    assert.equal(u.searchParams.get('x'), '1'); assert.equal(u.searchParams.get('lang'), 'ko'); assert.equal(u.hash, '#faq');
    await p.goto(srv.url + '/');
    await p.reload();
    assert.equal(await p.evaluate(() => document.documentElement.lang), 'ko');
    assert.equal(await p.inputValue('#lang'), 'ko');
    assert.match(await p.textContent('h1'), /노이즈/);
    await c.close();
  });

  await step('i18n: ?lang= overrides stored preference (case-insensitive, zh-Hans / ja-JP aliases)', async () => {
    const { c, p } = await fresh();
    await p.goto(srv.url + '/?lang=zh');
    await p.evaluate(() => localStorage.setItem('hushvox-lang', 'zh'));
    for (const [q, html, re] of [['ja', 'ja', /ノイズ/], ['JA-jp', 'ja', /ノイズ/], ['zh-Hans', 'zh-CN', /噪音/], ['KO-kr', 'ko', /노이즈/], ['EN', 'en', /Take the noise/]]) {
      await p.goto(srv.url + '/?lang=' + q);
      assert.equal(await p.evaluate(() => document.documentElement.lang), html, q);
      assert.match(await p.textContent('h1'), re, q);
    }
    await c.close();
  });

  await step('i18n: without ?lang= or storage, navigator language decides (zh-TW→zh, ja-JP→ja, ko-KR→ko, fr→en)', async () => {
    for (const [loc, html] of [['zh-TW', 'zh-CN'], ['ja-JP', 'ja'], ['ko-KR', 'ko'], ['fr-FR', 'en']]) {
      const { c, p } = await fresh({ locale: loc });
      await p.goto(srv.url + '/');
      assert.equal(await p.evaluate(() => document.documentElement.lang), html, loc);
      await c.close();
    }
  });

  await step('i18n: dynamic strings re-translate in place (error view, result view, aria labels) without losing state', async () => {
    const { c, p } = await fresh();
    await p.goto(srv.url + '/?lang=en');
    const bad = path.join(OUT, 'not-audio-i18n.txt'); fs.writeFileSync(bad, 'hello');
    await p.setInputFiles('#file', bad);
    await p.waitForSelector('#state-error:not([hidden])', { timeout: 20000 });
    assert.match(await p.textContent('#error-msg'), /couldn’t decode/);
    await p.selectOption('#lang', 'ja');
    assert.ok(await p.isVisible('#state-error'));
    assert.match(await p.textContent('#error-msg'), /デコードできませんでした/);
    await p.click('#error-back');
    await p.setInputFiles('#file', input);
    await p.waitForSelector('#state-result:not([hidden])', { timeout: 120000 });
    assert.match(await p.textContent('#result-meta'), /モノラル/);
    assert.equal(await p.getAttribute('#play', 'aria-label'), '再生');
    await p.click('#play');
    assert.equal(await p.getAttribute('#play', 'aria-label'), '一時停止');
    await p.fill('#strength', '40'); await p.dispatchEvent('#strength', 'input');
    await p.selectOption('#lang', 'ko');
    assert.ok(await p.isVisible('#state-result'), 'result view must survive a language change');
    assert.equal(await p.getAttribute('#play', 'aria-label'), '일시정지', 'playing state preserved');
    assert.match(await p.textContent('#result-meta'), /모노/);
    assert.equal(await p.inputValue('#strength'), '40');
    assert.equal(await p.getAttribute('#strength', 'aria-valuetext'), '40%');
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#dl-mp3')]);
    await dl.path();
    assert.match(await p.textContent('#export-status'), /준비 완료/);
    await p.selectOption('#lang', 'zh');
    assert.match(await p.textContent('#export-status'), /已就绪/);
    assert.equal(await p.getAttribute('.seg', 'aria-label'), '试听');
    await c.close();
  });

  await step('i18n mobile (390x844): switcher visible, no horizontal overflow in zh/ja/ko, idle and result', async () => {
    const { c, p } = await fresh({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await p.goto(srv.url + '/?lang=en');
    assert.ok(await p.isVisible('#lang'));
    for (const l of ['en', 'zh', 'ja', 'ko']) {
      await p.selectOption('#lang', l);
      assert.ok(await p.isVisible('#lang'), l);
      assert.ok(await noOverflow(p), `idle overflows in ${l}`);
      const box = await p.locator('#lang').boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 390, `switcher off-screen in ${l}`);
    }
    await p.setInputFiles('#file', input);
    await p.waitForSelector('#state-result:not([hidden])', { timeout: 120000 });
    for (const l of ['ko', 'ja', 'zh']) {
      await p.selectOption('#lang', l);
      assert.ok(await noOverflow(p), `result overflows in ${l}`);
    }
    await c.close();
  });
} catch (e) { console.error(e); failed++; } finally {
  await browser.close();
  srv.stop();
}
console.log(failed ? `\n${failed} FAILED` : '\nall e2e checks passed');
process.exit(failed ? 1 : 0);
