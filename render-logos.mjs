import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logosDir = path.join(__dirname, 'brand_assets', 'logos');

const renderTargets = [
  { svg: 'wordmark-accent.svg',     png: 'wordmark-accent.png',      width: 1200, height: 240,  bg: 'transparent' },
  { svg: 'wordmark-light.svg',      png: 'wordmark-light.png',       width: 1200, height: 240,  bg: 'transparent' },
  { svg: 'wordmark-mono-white.svg', png: 'wordmark-mono-white.png',  width: 1200, height: 240,  bg: 'transparent' },
  { svg: 'wordmark-mono-black.svg', png: 'wordmark-mono-black.png',  width: 1200, height: 240,  bg: 'transparent' },
  { svg: 'horizontal-tagline.svg',  png: 'horizontal-tagline.png',   width: 1400, height: 360,  bg: 'transparent' },
  { svg: 'square.svg',              png: 'square.png',               width: 1024, height: 1024, bg: '#131313' },
  { svg: 'og-image.svg',            png: 'og-image.png',             width: 1200, height: 630,  bg: '#131313' },
  { svg: 'apple-touch-icon.svg',    png: 'apple-touch-icon.png',     width: 180,  height: 180,  bg: 'transparent' },
];

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: 'C:/Users/matbu/.cache/puppeteer/chrome/win64-146.0.7680.153/chrome-win64/chrome.exe',
});

for (const t of renderTargets) {
  const svgContent = fs.readFileSync(path.join(logosDir, t.svg), 'utf8');
  const html = `<!DOCTYPE html><html><head><style>
    body { margin: 0; padding: 0; background: ${t.bg}; display: flex; align-items: center; justify-content: center; width: 100vw; height: 100vh; }
    svg { width: ${t.width}px; height: ${t.height}px; }
  </style></head><body>${svgContent}</body></html>`;

  const page = await browser.newPage();
  await page.setViewport({ width: t.width, height: t.height, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'networkidle0' });
  // Wait for fonts to load
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise(r => setTimeout(r, 500)));

  await page.screenshot({
    path: path.join(logosDir, t.png),
    omitBackground: t.bg === 'transparent',
    clip: { x: 0, y: 0, width: t.width, height: t.height }
  });
  await page.close();
  console.log('Rendered: ' + t.png);
}

await browser.close();
console.log('Done.');
