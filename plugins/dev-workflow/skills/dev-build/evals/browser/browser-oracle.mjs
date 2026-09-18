import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { check, regularText } from '../workflow-results.mjs';

/** Fixture-specific public relationships, not DOM/CSS implementation snapshots. */
export async function inspectVisualPage(workspace, relative = 'public/index.html', chromium) {
  let browser;
  let html;
  try {
    html = await regularText(workspace, relative);
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    return check('visual-product', 'unknown', `Browser or bounded product unavailable: ${error.message}`);
  }
  const observations = [];
  try {
    for (const [width, height] of [[1200, 800], [420, 820]]) {
      const context = await browser.newContext({ viewport: { width, height } });
      try {
        await context.route('**/*', (route) => route.abort());
        const page = await context.newPage();
        page.setDefaultTimeout(5_000);
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await page.setContent(html, { waitUntil: 'load', timeout: 8_000 });
        const settings = await page.getByRole('heading', { name: '声音设置', exact: true }).locator('..').boundingBox();
        const preview = await page.getByRole('heading', { name: '实时预览', exact: true }).locator('..').boundingBox();
        const relation = Boolean(settings && preview && (width === 1200
          ? preview.x >= settings.x + settings.width - 1 && Math.abs(preview.y - settings.y) < 2
          : preview.y + preview.height <= settings.y + 1));
        await page.getByRole('slider', { name: '音量', exact: true }).evaluate((element) => {
          element.value = '65'; element.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const live = await page.getByText('音量：65', { exact: true }).isVisible();
        await page.getByRole('button', { name: '保存偏好', exact: true }).click();
        const saved = await page.getByRole('status').innerText() === '已保存 65';
        observations.push({ width, height, settings, preview, relation, live, saved, errors });
      } finally {
        await context.close();
      }
    }
    const unchanged = await regularText(workspace, relative) === html;
    return check('visual-product', unchanged && observations.every((entry) => entry.relation && entry.live && entry.saved && !entry.errors.length) ? 'pass' : 'fail',
      JSON.stringify({ sha256: createHash('sha256').update(html).digest('hex'), unchanged, observations }));
  } catch (error) {
    return check('visual-product', 'fail', `Actual browser interaction failed: ${error.message}`);
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    process.stdout.write('Usage: node browser-oracle.mjs <workspace> <relative-page>\nRequires the declared Playwright package and its Chromium browser. No automatic installation.\n');
  } else {
    let result;
    try {
      if (process.argv.length !== 4) throw new Error('Expected workspace and relative page.');
      const module = await import('playwright');
      result = await inspectVisualPage(process.argv[2], process.argv[3], module.chromium ?? module.default?.chromium);
    } catch (error) {
      result = check('visual-product', 'unknown', `Browser capability unavailable: ${error.message}`);
    }
    process.stdout.write(JSON.stringify(result));
  }
}
