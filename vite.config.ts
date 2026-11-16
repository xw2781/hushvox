import { defineConfig, type Plugin } from 'vite';
import { SITE_URL } from './site.config';

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const plain = (h: string) =>
  h.replace(/<[^>]+>/g, '').replaceAll('&nbsp;', '\u00a0').replace(/\s+/g, ' ').trim();

function siteFiles(): Plugin {
  return {
    name: 'hushvox-site',
    transformIndexHtml(html, ctx) {
      let out = html.replaceAll('__SITE_URL__', SITE_URL);
      // Dev server injects inline <style>/HMR sockets, so the strict CSP is applied to builds only.
      out = out.replace('<!--CSP-->', ctx.server ? '' : `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
      const faqs = [...out.matchAll(/<details>\s*<summary[^>]*>([\s\S]*?)<\/summary>\s*<p[^>]*>([\s\S]*?)<\/p>\s*<\/details>/g)].map((m) => ({
        '@type': 'Question',
        name: plain(m[1]),
        acceptedAnswer: { '@type': 'Answer', text: plain(m[2]) },
      }));
      const ld = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faqs };
      return out.replace('<!--FAQ-JSONLD-->', `<script type="application/ld+json">${JSON.stringify(ld).replaceAll('<', '\\u003c')}</script>`);
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}sitemap.xml\n` });
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${SITE_URL}</loc></url>\n</urlset>\n`,
      });
    },
  };
}

export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [siteFiles()],
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 1000 },
  worker: { format: 'es' },
});
