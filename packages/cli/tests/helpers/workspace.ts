import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';

import { getCatalogFullPackageRoot } from '../../src/utils/bundle-layout.js';
import { setEmbeddedPluginsRootOverrideForTests } from '../../src/utils/paths.js';
import {
  registerCurrentTestReadonlyFixtureRoot,
  registerCurrentTestWritableStateRoot,
} from '../setup/test-isolation.js';
import { resolveSafeCliEnv } from './cli-runtime.js';
import { createSyntheticEmbeddedRoot } from './embedded-root.js';

export interface CreateCliTestWorkspaceOptions {
  env?: NodeJS.ProcessEnv;
  repoDirName?: string;
  repoFixtureName?: string;
  rootDirPrefix?: string;
  createEmbeddedRoot?: boolean;
  activateEmbeddedRoot?: boolean;
  mutateRepo?: (repoRoot: string) => Promise<void>;
}

export interface CliTestWorkspace {
  rootDir: string;
  repoRoot: string;
  awHome: string;
  codexHome: string;
  claudeHome: string;
  env: NodeJS.ProcessEnv;
  embeddedRoot: string | null;
  catalogSourceRoot: string | null;
}

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

export function registerCliTempRoot(
  rootPath: string,
  source = 'registerCliTempRoot()',
): string {
  return registerCurrentTestWritableStateRoot(rootPath, source);
}

export function registerCliFixtureRepoRoot(
  rootPath: string,
  source = 'registerCliFixtureRepoRoot()',
): string {
  return registerCurrentTestWritableStateRoot(rootPath, source);
}

export function registerCliEmbeddedRoot(
  rootPath: string,
  source = 'registerCliEmbeddedRoot()',
): string {
  return registerCurrentTestReadonlyFixtureRoot(rootPath, source);
}

export function registerCliCatalogSourceRoot(
  rootPath: string,
  source = 'registerCliCatalogSourceRoot()',
): string {
  return registerCurrentTestReadonlyFixtureRoot(rootPath, source);
}

export function registerCliDistInputRoot(
  rootPath: string,
  source = 'registerCliDistInputRoot()',
): string {
  return registerCurrentTestReadonlyFixtureRoot(rootPath, source);
}

export function activateCliEmbeddedRoot(
  rootPath: string,
  source = 'activateCliEmbeddedRoot()',
): string {
  const registeredPath = registerCliEmbeddedRoot(rootPath, source);
  setEmbeddedPluginsRootOverrideForTests(registeredPath);
  return registeredPath;
}

export async function createCliTestWorkspace(
  options: CreateCliTestWorkspaceOptions = {},
): Promise<CliTestWorkspace> {
  const rootDir = await fs.mkdtemp(path.join(
    os.tmpdir(),
    options.rootDirPrefix ?? 'aw-cli-workspace-',
  ));
  registerCliTempRoot(rootDir, 'createCliTestWorkspace().rootDir');

  const repoRoot = path.join(rootDir, options.repoDirName ?? 'repo');
  await fs.copy(fixturePath(options.repoFixtureName ?? 'repo-template'), repoRoot);
  registerCliFixtureRepoRoot(repoRoot, 'createCliTestWorkspace().repoRoot');

  await options.mutateRepo?.(repoRoot);

  let embeddedRoot: string | null = null;
  let catalogSourceRoot: string | null = null;
  if (options.createEmbeddedRoot !== false) {
    embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    registerCliEmbeddedRoot(embeddedRoot, 'createCliTestWorkspace().embeddedRoot');
    catalogSourceRoot = getCatalogFullPackageRoot(embeddedRoot);
    registerCliCatalogSourceRoot(
      catalogSourceRoot,
      'createCliTestWorkspace().catalogSourceRoot',
    );
    if (options.activateEmbeddedRoot !== false) {
      setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
    }
  }

  const env = resolveSafeCliEnv({
    PATH: '',
    AW_FORCE_CODEX_AVAILABLE: '1',
    ...options.env,
  });

  return {
    rootDir,
    repoRoot,
    awHome: env.AW_HOME!,
    codexHome: env.AW_CODEX_HOME!,
    claudeHome: env.AW_CLAUDE_HOME!,
    env,
    embeddedRoot,
    catalogSourceRoot,
  };
}
