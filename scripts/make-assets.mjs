// Generates public/og-image.png (1200x630) and public/apple-touch-icon.png (180x180) with Playwright.
// Usage: node scripts/make-assets.mjs
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const logo = readFileSync(join(root, 'public/favicon.svg'), 'utf8');
const dataLogo = 'data:image/svg+xml;base64,' + Buffer.from(logo).toString('base64');

const bars = [10, 22, 40, 70, 112, 150, 112, 70, 40, 22, 10, 6]
  .map((h, i) => `<rect x="${i * 30}" y="${90 - h / 2 + (0)}" width="14" rx="7" height="${h}" fill="#5fd0b4" opacity="${0.35 + (h / 150) * 0.65}"/>`).join('');
const og = `<html><body style="margin:0;width:1200px;height:630px;background:#0f1514;font-family:Georgia,'Palatino Linotype',serif;color:#e8eeeb;position:relative;overflow:hidden">
  <div style="position:absolute;left:80px;top:78px;display:flex;align-items:center;gap:22px"><img src="${dataLogo}" width="84" height="84"/><span style="font-size:52px;font-weight:700">HushVox</span></div>
  <div style="position:absolute;left:80px;top:230px;font-size:76px;line-height:1.05;font-weight:700;letter-spacing:-1px;width:900px">Noise out.<br/>Voice in.<br/><span style="color:#5fd0b4">Nothing uploaded.</span></div>
  <div style="position:absolute;left:80px;bottom:62px;font:28px system-ui,sans-serif;color:#93a09b">Free, open-source voice denoising that runs in your browser.</div>
  <svg style="position:absolute;right:70px;top:230px" width="340" height="180" viewBox="0 0 340 180"><g transform="translate(0,0)">${bars}</g></svg>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(og);
writeFileSync(join(root, 'public/og-image.png'), await page.screenshot());
const p2 = await browser.newPage({ viewport: { width: 180, height: 180 } });
await p2.setContent(`<body style="margin:0"><img src="${dataLogo}" width="180" height="180" style="display:block"/></body>`);
writeFileSync(join(root, 'public/apple-touch-icon.png'), await p2.screenshot());
await browser.close();
