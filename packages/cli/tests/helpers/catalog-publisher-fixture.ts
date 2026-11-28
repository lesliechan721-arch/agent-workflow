import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, beforeEach } from 'vitest';

import {
  applyCatalogPublicationPlan,
  prepareCatalogPublicationPlan,
  type CatalogPublishPlanReceipt,
} from '../../src/commands/catalog-publish.js';
import { runCli } from '../../src/index.js';
import { createIsolatedTestEnv } from './test-isolation.js';
import { TestCommandDiagnostics } from './test-command-diagnostics.js';

export const execFileAsync = promisify(execFile);

const publisherTempBase = os.tmpdir();
const publisherPackageRoot = fileURLToPath(new URL('../..', import.meta.url));
const diagnosedCase = /^(allows a renamed remote alias|rejects a changed (remote identity|branch) during apply|stops when the pending |rejects a published branch from a different Workspace identity|leaves no formal version directory when plan creation fails before the final rename|uses only the first-parent Catalog history|rejects stable Plugin identity reuse and downgrade after a deletion|reuses unchanged beta Plugin identity after deletion)/u;

export function quietIo() {
  return { stdout: () => undefined, stderr: () => undefined };
}

export async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).stdout.trim();
}

export async function plan(
  root: string,
  branch = 'catalog/latest',
): Promise<CatalogPublishPlanReceipt> {
  return prepareCatalogPublicationPlan({
    workspaceRoot: root,
    remote: 'origin',
    branch,
    env: process.env,
  });
}

export async function apply(root: string, publication: CatalogPublishPlanReceipt) {
  return applyCatalogPublicationPlan({
    workspaceRoot: root,
    remote: 'origin',
    branch: publication.branch,
    expectedPlanDigest: publication.planDigest,
    env: process.env,
  });
}

export async function pushPreparedRef(
  publication: CatalogPublishPlanReceipt,
  ref: 'branch' | 'tag' | 'both',
): Promise<void> {
  const repository = publication.repositoryPath!;
  const branch = `${publication.expectedCommit}:refs/heads/${publication.branch}`;
  const tag = `refs/tags/${publication.tag}:refs/tags/${publication.tag}`;
  const refs = ref === 'both' ? [branch, tag] : [ref === 'branch' ? branch : tag];
  await git(repository, ['push', '--quiet', '--atomic', publication.pushUrl, ...refs]);
}

export function createPublisherFixture() {
  const roots: string[] = [];

  let diagnostics: TestCommandDiagnostics | undefined;

  beforeEach(({ task, signal }) => {
    diagnostics = diagnosedCase.test(task.name)
      ? new TestCommandDiagnostics('publisher', task.name, signal)
      : undefined;
  });

  afterEach(async ({ task, signal }) => {
    try {
      await diagnostics?.finish();
    } catch (error) {
      // Leave unconfirmed state on disk, and do not let the next case delete it.
      roots.splice(0);
      throw error;
    }
    if (diagnostics) {
      // Windows can briefly hold directory handles after confirmed process-tree termination.
      await diagnostics.stage('cleanup', () => Promise.all(roots.splice(0).map((root) =>
        rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      )));
    } else {
      await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
    }
  });

  async function isolatedPublisherCase(testName: string): Promise<void> {
    await diagnostics!.run(async () => {
      const childRoot = await fs.mkdtemp(path.join(publisherTempBase, 'awp-'));
      roots.push(childRoot);
      const childIsolation = await createIsolatedTestEnv({ rootDir: childRoot, baseEnv: process.env });
      // Each case keeps its own process and fixtures. The managed command confirms tree cleanup
      // before afterEach removes the directory, including when the Vitest signal is cancelled.
      await diagnostics!.command(process.execPath, [
        path.resolve(publisherPackageRoot, 'tests/helpers/catalog-publisher-case.mjs'),
        testName,
        childRoot,
      ], {
        cwd: childIsolation.layout.fixtureCwd,
        env: childIsolation.env,
        onStderr: (text) => process.stderr.write(text),
      });
    });
  }

  async function temporaryRoot(prefix: string): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  async function createWorkspace(
    version = '1.0.0',
    existingRemote?: string,
  ): Promise<{ root: string; remote: string }> {
    const root = await temporaryRoot('aw-catalog-journal-workspace-');
    const remote = existingRemote ?? await temporaryRoot('aw-catalog-journal-remote-');
    if (existingRemote === undefined) {
      await execFileAsync('git', ['init', '--bare', '--quiet', remote]);
    }
    await execFileAsync('git', ['init', '--quiet'], { cwd: root });
    await runCli([
      'dev', 'catalog', 'create', '--workspace-root', root, '--catalog-version', version,
      '--owner-url', 'https://catalog.example.com/journal-test',
    ], { cwd: root, io: quietIo() });
    await runCli([
      'dev', 'plugin', 'create', 'journal-test', '--description', 'Journal test.', '--no-skills',
      '--workspace-root', root,
    ], { cwd: root, io: quietIo() });
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--quiet', '-m', 'initial',
    ], { cwd: root });
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    return { root, remote };
  }

  return { createWorkspace, temporaryRoot, isolatedPublisherCase };
}
