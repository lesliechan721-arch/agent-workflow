import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

async function reportBatchRoots(): Promise<string[]> {
  const roots: string[] = [];
  const staticRoot = path.join(repoRoot, '.agents', 'reports');
  if (await fs.pathExists(staticRoot)) {
    for (const skill of await fs.readdir(staticRoot)) {
      const skillRoot = path.join(staticRoot, skill);
      for (const batch of await fs.readdir(skillRoot)) roots.push(path.join(skillRoot, batch));
    }
  }
  const pluginsRoot = path.join(repoRoot, 'plugins');
  for (const plugin of await fs.readdir(pluginsRoot)) {
    const reportsRoot = path.join(pluginsRoot, plugin, 'reports');
    if (!(await fs.pathExists(reportsRoot))) continue;
    for (const skill of await fs.readdir(reportsRoot)) {
      const skillRoot = path.join(reportsRoot, skill);
      for (const batch of await fs.readdir(skillRoot)) roots.push(path.join(skillRoot, batch));
    }
  }
  return roots.sort();
}

async function isIgnored(relativePath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['check-ignore', '--no-index', '-q', relativePath], {
      cwd: repoRoot,
    });
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return false;
    throw error;
  }
}

describe('committed Skill report layout', () => {
  it('keeps only a human report and compact schema v2 summary per published batch', async () => {
    const batches = await reportBatchRoots();
    expect(batches.length).toBeGreaterThan(0);
    for (const batchRoot of batches) {
      expect((await fs.readdir(batchRoot)).sort()).toEqual(['report.md', 'summary.json']);
      await expect(fs.readFile(path.join(batchRoot, 'report.md'), 'utf8'))
        .resolves.not.toHaveLength(0);
      await expect(fs.readJson(path.join(batchRoot, 'summary.json'))).resolves.toMatchObject({
        schemaVersion: 2,
        reportPath: 'report.md',
      });
    }
  });

  it('allows formal files and ignores any mechanical report-tree output', async () => {
    await expect(isIgnored(
      'plugins/demo/reports/demo-skill/20260812T000000Z-release-00000000/report.md',
    )).resolves.toBe(false);
    await expect(isIgnored(
      'plugins/demo/reports/demo-skill/20260812T000000Z-release-00000000/summary.json',
    )).resolves.toBe(false);
    await expect(isIgnored(
      'plugins/demo/reports/demo-skill/20260812T000000Z-release-00000000/evals/evaluation.json',
    )).resolves.toBe(true);
    await expect(isIgnored(
      '.agents/reports/demo-skill/20260812T000000Z-release-00000000/report.md',
    )).resolves.toBe(false);
    await expect(isIgnored(
      '.agents/reports/demo-skill/20260812T000000Z-release-00000000/reviews/review.json',
    )).resolves.toBe(true);
  });
});
