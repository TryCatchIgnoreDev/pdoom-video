import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

async function main() {
  const url = 'http://localhost:5173';
  const outDir = path.resolve('..', 'out');
  mkdirSync(outDir, { recursive: true });

  console.log('Connecting to app for Universe-77 render...');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--enable-gpu-rasterization',
      '--ignore-gpu-blocklist',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });

  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(`${url}/?export=1`);
  await page.waitForFunction(() => (window as any).__pdoom?.ready, null, { timeout: 30000 });

  const times = [24.2, 35.0];
  for (const t of times) {
    await page.evaluate(([time]) => (window as any).__pdoom.still(time, 1, 0.5), [t] as const);
    const outFile = path.join(outDir, `frame_${t}_alt.png`);
    await page.screenshot({ path: outFile, clip: { x: 0, y: 0, width: 1920, height: 1080 } });
    console.log(`Rendered Universe-77 frame at ${t}s -> ${outFile}`);
  }

  await browser.close();
  console.log('Universe-77 render complete!');
}

main().catch(console.error);
