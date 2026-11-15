// Single place for the public site URL used by canonical/OG tags, robots.txt and sitemap.xml.
// Override at build time: VITE_SITE_URL=https://example.org/hushvox/ npm run build
export const SITE_URL = (process.env.VITE_SITE_URL ?? 'https://xw2781.github.io/hushvox/').replace(/\/?$/, '/');
