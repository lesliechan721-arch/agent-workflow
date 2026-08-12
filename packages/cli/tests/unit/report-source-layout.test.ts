import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

async function committedReportBatches(): Promise<Array<{ files: string[]; root: string }>> {
  const { stdout } = await execFileAsync('git', [
    'ls-files',
    '-z',
    '--',
    '.agents/reports/**',
    'plugins/*/reports/**',
  ], { cwd: repoRoot });
  const batches = new Map<string, string[]>();
  for (const file of stdout.split('\0')) {
    if (!file) continue;
    const match = file.match(
      /^((?:\.agents\/reports\/[^/]+|plugins\/[^/]+\/reports\/[^/]+)\/[^/]+)\/(.+)$/,
    );
    if (!match) throw new Error(`Invalid committed Skill report path: ${file}`);
    const root = path.join(repoRoot, match[1]);
    const files = batches.get(root) ?? [];
    files.push(match[2]);
    batches.set(root, files);
  }
  return [...batches]
    .map(([root, files]) => ({ files: files.sort(), root }))
    .sort((left, right) => left.root.localeCompare(right.root));
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
    const batches = await committedReportBatches();
    expect(batches.length).toBeGreaterThan(0);
    for (const batch of batches) {
      expect(batch.files).toEqual(['report.md', 'summary.json']);
      await expect(fs.readFile(path.join(batch.root, 'report.md'), 'utf8'))
        .resolves.not.toHaveLength(0);
      await expect(fs.readJson(path.join(batch.root, 'summary.json'))).resolves.toMatchObject({
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
