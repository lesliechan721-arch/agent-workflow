import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fs from 'fs-extra';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';

import { registerCurrentTestReadonlyFixtureRoot, registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const source = path.join(repo, 'plugins/dev-workflow/skills/dev-build/evals');
const require = createRequire(import.meta.url);
const roots: string[] = [];
// Resolve the installed dependency before the per-test HOME is isolated. Keep the
// child HOME isolated; only its read-only browser executable cache is shared.
let browserDirectory = path.dirname(chromium.executablePath());
while (!/^chromium(?:_headless_shell)?-\d+$/u.test(path.basename(browserDirectory))) {
  const parent = path.dirname(browserDirectory);
  if (parent === browserDirectory) throw new Error('Cannot locate the installed Chromium cache.');
  browserDirectory = parent;
}
const browserCache = path.dirname(browserDirectory);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

describe('dev-workflow isolated browser Oracle', () => {
  it.each(['reference', 'equivalent', 'misaligned'])('checks the actual %s product through the external Oracle process', async (name) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-browser-oracle-'));
    roots.push(root);
    registerCurrentTestWritableStateRoot(root, 'workflow browser Eval tool and product fixture');
    registerCurrentTestReadonlyFixtureRoot(browserCache, 'installed Playwright browser executables');
    process.env.PLAYWRIGHT_BROWSERS_PATH = browserCache;
    const tool = path.join(root, 'eval');
    const workspace = path.join(root, 'subject');
    await fs.ensureDir(tool);
    await fs.ensureDir(workspace);
    await fs.copyFile(path.join(source, 'workflow-results.mjs'), path.join(tool, 'workflow-results.mjs'));
    await fs.copy(path.join(source, 'browser'), path.join(tool, 'browser'));
    await fs.copyFile(path.join(source, `fixtures/visual/${name}.html`), path.join(workspace, 'page.html'));
    // Only the Eval tool host has this already-declared CLI development dependency.
    // Nothing is installed into the product, source plugin, or user configuration.
    await fs.ensureDir(path.join(tool, 'browser/node_modules'));
    await fs.symlink(path.dirname(require.resolve('playwright/package.json')),
      path.join(tool, 'browser/node_modules/playwright'), process.platform === 'win32' ? 'junction' : 'dir');
    const before = await fs.readFile(path.join(workspace, 'page.html'), 'utf8');
    const { verifyVisualPage } = await import(pathToFileURL(path.join(tool, 'workflow-results.mjs')).href);
    const result = await verifyVisualPage(workspace, 'page.html');
    expect(result.verdict, result.evidence).toBe(name === 'misaligned' ? 'fail' : 'pass');
    const evidence = JSON.parse(result.evidence);
    expect(evidence.observations.map((entry: { width: number }) => entry.width)).toEqual([1200, 420]);
    expect(evidence.observations.every((entry: { live: boolean; saved: boolean }) => entry.live && entry.saved)).toBe(true);
    expect(await fs.readFile(path.join(workspace, 'page.html'), 'utf8')).toBe(before);
  });
});
