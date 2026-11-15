// Screenshots into shots/ + README animation. Run: npm run shots  (needs a build; ffmpeg for the animation)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, OUT, makeMix, writeWav16, startPreview } from './lib.mjs';

const SHOTS = path.join(ROOT, 'shots');
const FR = path.join(OUT, 'frames');
fs.mkdirSync(SHOTS, { recursive: true }); fs.rmSync(FR, { recursive: true, force: true }); fs.mkdirSync(FR, { recursive: true });
const srv = await startPreview(4176);
const browser = await chromium.launch();
const input = path.join(OUT, 'noisy-speech.wav');
writeWav16(input, makeMix(5).noisy);

async function session(name, viewport, scheme, dpr, frames) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: dpr });
  if (frames) await ctx.route('**/*.wasm', async (route) => { if (route.request().url().includes('df_bg')) await new Promise((r) => setTimeout(r, 1800)); await route.continue(); });
  const page = await ctx.newPage();
  await page.goto(srv.url + '/');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}-idle.png`) });
  if (frames) await page.screenshot({ path: path.join(FR, '1.png') });
  await page.setInputFiles('#file', input);
  if (frames) { await page.waitForSelector('#state-busy:not([hidden])'); await page.waitForTimeout(900); await page.screenshot({ path: path.join(FR, '2.png') }); }
  await page.waitForSelector('#state-result:not([hidden])', { timeout: 120000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, `${name}-result.png`) });
  if (frames) {
    await page.click('#ab-a', { force: true }); await page.fill('#seek', '420'); await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(FR, '3.png') });
    await page.click('#ab-b', { force: true }); await page.fill('#strength', '60'); await page.dispatchEvent('#strength', 'input'); await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(FR, '4.png') });
  }
  await ctx.close();
}
const D = { width: 1440, height: 900 }, M = { width: 390, height: 844 };
await session('desktop-light', D, 'light', 1, true);
await session('desktop-dark', D, 'dark', 1, false);
await session('mobile-light', M, 'light', 2, false);
await session('mobile-dark', M, 'dark', 2, false);
// full-page landing capture (desktop light)
{
  const ctx = await browser.newContext({ viewport: D, colorScheme: 'light' });
  const p = await ctx.newPage(); await p.goto(srv.url + '/'); await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(SHOTS, 'desktop-light-fullpage.png'), fullPage: true });
  await ctx.close();
}
await browser.close(); srv.stop();

// animation: 4 frames, 1.6 s each, 960 px wide
const run = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
const vf = 'scale=960:-1:flags=lanczos';
run(['-framerate', '0.625', '-i', path.join(FR, '%d.png'), '-vf', vf, '-loop', '0', '-c:v', 'libwebp_anim', '-q:v', '70', path.join(SHOTS, 'demo.webp')]);
run(['-framerate', '0.625', '-i', path.join(FR, '%d.png'), '-vf', `${vf},split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse`, '-loop', '0', path.join(SHOTS, 'demo.gif')]);
console.log(fs.readdirSync(SHOTS).map((f) => `${f} ${(fs.statSync(path.join(SHOTS, f)).size / 1024).toFixed(0)}KB`).join('\n'));
