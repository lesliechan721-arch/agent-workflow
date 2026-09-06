import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acquireBuildLock,
  buildCacheContract,
  buildWithCache,
  computeBuildInputDigest,
  computeBuildOutputDigest,
  createBuildSnapshot,
  inspectBuildCache,
  resolvePnpmInvocation,
  withBuildSnapshot,
} from '../../../../scripts/build/build-cache.mjs';

const tempDirs: string[] = [];
const originalNpmExecPath = process.env.npm_execpath;
const originalNpmUserAgent = process.env.npm_config_user_agent;

async function createRepo(): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-build-cache-'));
  tempDirs.push(repoRoot);
  await fs.mkdir(path.join(repoRoot, 'plugins', 'demo'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'tools'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'packages', 'agent-skill-eval', 'node_modules'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'packages', 'agent-skill-eval', 'schemas'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'packages', 'aw-windows-job-win32-x64'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'packages', 'aw-windows-job-win32-arm64'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'packages', 'plugin-core', 'node_modules'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'packages', 'plugin-core', 'schemas'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'packages', 'cli'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'packages', 'cli', 'node_modules'), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, 'packages', 'agent-skill-eval', 'package.json'),
    JSON.stringify({ name: '@lesliechan721/agent-skill-eval', type: 'module', files: ['dist/'] }),
  );
  await fs.writeFile(
    path.join(repoRoot, 'packages', 'aw-windows-job-win32-x64', 'package.json'),
    JSON.stringify({ name: '@lesliechan721/aw-windows-job-win32-x64', files: ['dist/'] }),
  );
  await fs.writeFile(
    path.join(repoRoot, 'packages', 'aw-windows-job-win32-arm64', 'package.json'),
    JSON.stringify({ name: '@lesliechan721/aw-windows-job-win32-arm64', files: ['dist/'] }),
  );
  await fs.writeFile(
    path.join(repoRoot, 'packages', 'plugin-core', 'package.json'),
    JSON.stringify({ name: '@lesliechan721/aw-plugin-core', type: 'module', files: ['dist/', 'schemas/'] }),
  );
  await fs.writeFile(
    path.join(repoRoot, 'packages', 'plugin-core', 'schemas', 'plugin-manifest-v3.json'),
    '{}\n',
  );
  await fs.writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ packageManager: 'pnpm@10.33.0' }),
  );
  await fs.writeFile(path.join(repoRoot, 'plugins', 'demo', 'SKILL.md'), 'initial\n');
  await fs.writeFile(
    path.join(repoRoot, 'packages', 'cli', 'package.json'),
    JSON.stringify({ name: '@lesliechan721/aw', type: 'module', files: ['dist/'] }),
  );
  const fakePnpmPath = path.join(repoRoot, 'tools', 'pnpm.cjs');
  await fs.writeFile(fakePnpmPath, '/* deterministic pnpm fixture */\n');
  process.env.npm_execpath = fakePnpmPath;
  process.env.npm_config_user_agent = 'pnpm/10.33.0 npm/? node/test test test';
  return repoRoot;
}

async function writeRequiredOutputs(repoRoot: string, generation = 1): Promise<void> {
  await Promise.all(buildCacheContract.requiredOutputs.map(async (relativePath: string) => {
    const outputPath = path.join(repoRoot, relativePath);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    let contents = `export const generation = ${generation};\n`;
    if (relativePath.endsWith('marketplace.json')) {
      contents = `{"plugins":[],"generation":${generation}}\n`;
    } else if (relativePath.endsWith('catalog-manifest.json')) {
      contents = `{"schemaVersion":7,"release":{"state":"development"},"entries":[],"generation":${generation}}\n`;
    }
    await fs.writeFile(outputPath, contents);
  }));
}

async function writeBuildOutputs(repoRoot: string, generation = 1): Promise<void> {
  await Promise.all(buildCacheContract.outputRoots.map((relativePath: string) =>
    fs.rm(path.join(repoRoot, relativePath), { recursive: true, force: true })
  ));
  await writeRequiredOutputs(repoRoot, generation);
  const nonrequiredModule = path.join(repoRoot, 'packages', 'cli', 'dist', 'src', 'nonrequired.js');
  await fs.mkdir(path.dirname(nonrequiredModule), { recursive: true });
  await fs.writeFile(nonrequiredModule, `export const generation = ${generation};\n`);
}

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(async () => {
  if (originalNpmExecPath === undefined) {
    delete process.env.npm_execpath;
  } else {
    process.env.npm_execpath = originalNpmExecPath;
  }
  if (originalNpmUserAgent === undefined) {
    delete process.env.npm_config_user_agent;
  } else {
    process.env.npm_config_user_agent = originalNpmUserAgent;
  }
  await Promise.all(tempDirs.splice(0).map((tempDir) =>
    fs.rm(tempDir, { recursive: true, force: true })
  ));
});

export {
  acquireBuildLock,
  afterEach,
  buildCacheContract,
  buildWithCache,
  computeBuildInputDigest,
  computeBuildOutputDigest,
  createBuildSnapshot,
  createDeferred,
  createRepo,
  describe,
  expect,
  fs,
  fsSync,
  inspectBuildCache,
  it,
  originalNpmExecPath,
  originalNpmUserAgent,
  os,
  path,
  pathToFileURL,
  resolvePnpmInvocation,
  tempDirs,
  vi,
  withBuildSnapshot,
  writeBuildOutputs,
  writeRequiredOutputs,
};
