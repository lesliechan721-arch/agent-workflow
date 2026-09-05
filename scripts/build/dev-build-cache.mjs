import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  computeTreeDigest,
  findRegisteredSymlink,
  validateRequiredOutputs,
} from './build-cache.mjs';

const DEV_CACHE_SCHEMA_VERSION = 1;
const DEPENDENCY_INPUT_PATHS = [
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
];

const TARGETS = [
  {
    id: 'agent-skill-eval',
    inputPaths: [
      ...DEPENDENCY_INPUT_PATHS,
      'tsconfig.base.json',
      'packages/agent-skill-eval/package.json',
      'packages/agent-skill-eval/tsconfig.json',
      'packages/agent-skill-eval/tsconfig.dev.json',
      'packages/agent-skill-eval/src',
      'packages/agent-skill-eval/schemas',
      'packages/agent-skill-eval/native/windows',
      'packages/agent-skill-eval/scripts/embed-schemas.mjs',
      'packages/agent-skill-eval/scripts/copy-windows-job-helper.mjs',
      'packages/agent-skill-eval/scripts/windows-job-helper-artifacts.mjs',
    ],
    outputRoots: ['packages/agent-skill-eval/dist'],
    requiredOutputs: [
      { path: 'packages/agent-skill-eval/dist/index.js', type: 'text' },
      { path: 'packages/agent-skill-eval/dist/bin.js', type: 'text' },
      { path: 'packages/agent-skill-eval/dist/schemas/digests.json', type: 'text' },
      { path: 'packages/agent-skill-eval/dist/native/windows/manifest.json', type: 'json' },
      { path: 'packages/agent-skill-eval/dist/native/windows/x64/aw-windows-job.exe', type: 'file' },
      { path: 'packages/agent-skill-eval/dist/native/windows/arm64/aw-windows-job.exe', type: 'file' },
    ],
    tsBuildInfoPath: '.release/cache/dev-build/agent-skill-eval.tsbuildinfo',
    packageName: '@lesliechan721/agent-skill-eval',
    scriptName: 'build:dev',
  },
  {
    id: 'plugin-core',
    inputPaths: [
      ...DEPENDENCY_INPUT_PATHS,
      'tsconfig.base.json',
      'packages/plugin-core/package.json',
      'packages/plugin-core/tsconfig.json',
      'packages/plugin-core/tsconfig.dev.json',
      'packages/plugin-core/src',
      'packages/plugin-core/schemas',
      'packages/plugin-core/scripts/generate-manifest-types.mjs',
    ],
    outputRoots: ['packages/plugin-core/dist'],
    requiredOutputs: [
      { path: 'packages/plugin-core/dist/index.js', type: 'text' },
    ],
    tsBuildInfoPath: '.release/cache/dev-build/plugin-core.tsbuildinfo',
    packageName: '@lesliechan721/aw-plugin-core',
    scriptName: 'build:dev',
  },
  {
    id: 'cli-typescript',
    inputPaths: [
      ...DEPENDENCY_INPUT_PATHS,
      'tsconfig.base.json',
      'packages/cli/package.json',
      'packages/cli/tsconfig.json',
      'packages/cli/tsconfig.dev.json',
      'packages/cli/index.ts',
      'packages/cli/src',
      'packages/cli/scripts',
      'packages/cli/authoring',
    ],
    outputRoots: ['packages/cli/dist'],
    requiredOutputs: [
      { path: 'packages/cli/dist/index.js', type: 'text' },
      { path: 'packages/cli/dist/scripts/bundle-plugins.js', type: 'text' },
    ],
    tsBuildInfoPath: '.release/cache/dev-build/cli-typescript.tsbuildinfo',
    packageName: '@lesliechan721/aw',
    scriptName: 'build:dev:typescript',
  },
  {
    id: 'plugin-bundle',
    inputPaths: [
      ...DEPENDENCY_INPUT_PATHS,
      'package.json',
      'release/version-targets.json',
      'packages/agent-skill-eval/package.json',
      'packages/plugin-core/package.json',
      'packages/cli/package.json',
      'plugins',
    ],
    outputRoots: ['packages/cli/plugins-dist'],
    requiredOutputs: [
      { path: 'packages/cli/plugins-dist/.claude-plugin/marketplace.json', type: 'marketplace' },
      { path: 'packages/cli/plugins-dist/.agents/plugins/marketplace.json', type: 'marketplace' },
      { path: 'packages/cli/plugins-dist/catalog-manifest.json', type: 'catalog' },
    ],
  },
];

function normalizeRelativePath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function isExcludedDevInput(relativePath) {
  const normalizedPath = normalizeRelativePath(relativePath);
  const segments = normalizedPath.split('/');
  const name = segments.at(-1) ?? '';
  return segments.some((segment) => (
    segment === 'node_modules'
    || segment === 'dist'
    || segment === 'plugins-dist'
    || segment === 'tests'
    || segment === 'evals'
    || segment === 'reports'
    || segment === 'docs'
    || segment === '.changes'
  ))
    || /(?:^|\.)(?:test|spec)\.[^.]+$/u.test(name)
    || /^vitest(?:\.[^.]+)*\.config\.[^.]+$/u.test(name)
    || name === 'clean-dist.mjs'
    || name === '.DS_Store';
}

function cachePath(repoRoot, target) {
  return path.join(repoRoot, '.release', 'cache', 'dev-build', `${target.id}.json`);
}

function digestJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function listInputFiles(repoRoot, roots) {
  const files = [];
  async function visit(relativePath) {
    if (isExcludedDevInput(relativePath)) return;
    const absolutePath = path.join(repoRoot, relativePath);
    let stats;
    try {
      stats = await fs.lstat(absolutePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      files.push(normalizeRelativePath(relativePath));
      return;
    }
    for (const name of (await fs.readdir(absolutePath)).sort()) {
      await visit(path.join(relativePath, name));
    }
  }
  for (const root of [...roots].sort()) await visit(root);
  return files.sort();
}

async function readInputIdentity(repoRoot, target, upstream) {
  const [inputDigest, inputFiles] = await Promise.all([
    computeTreeDigest(repoRoot, target.inputPaths, isExcludedDevInput),
    listInputFiles(repoRoot, target.inputPaths),
  ]);
  const identity = {
    schemaVersion: DEV_CACHE_SCHEMA_VERSION,
    target: target.id,
    inputDigest,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    upstream,
  };
  return { identity, inputFiles, key: digestJson(identity) };
}

async function readState(repoRoot, target) {
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath(repoRoot, target), 'utf8'));
    if (
      parsed?.schemaVersion !== DEV_CACHE_SCHEMA_VERSION
      || parsed.target !== target.id
      || typeof parsed.key !== 'string'
      || typeof parsed.inputDigest !== 'string'
      || !Array.isArray(parsed.inputFiles)
      || parsed.inputFiles.some((entry) => typeof entry !== 'string')
      || typeof parsed.outputDigest !== 'string'
      || (target.tsBuildInfoPath && typeof parsed.tsBuildInfoDigest !== 'string')
    ) {
      return { state: null, reason: 'invalid cache metadata' };
    }
    return { state: parsed };
  } catch (error) {
    return {
      state: null,
      reason: error?.code === 'ENOENT' ? 'missing cache metadata' : 'invalid cache metadata',
    };
  }
}

async function digestTsBuildInfo(repoRoot, target) {
  if (!target.tsBuildInfoPath) return null;
  try {
    const contents = await fs.readFile(path.join(repoRoot, target.tsBuildInfoPath));
    const parsed = JSON.parse(contents.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return crypto.createHash('sha256').update(contents).digest('hex');
  } catch {
    return null;
  }
}

async function validateOutputs(repoRoot, target, computeOutputDigest = computeTreeDigest) {
  const symlink = await findRegisteredSymlink(repoRoot, target.outputRoots);
  if (symlink) return { valid: false, reason: `unsupported output symlink ${symlink}` };
  const required = await validateRequiredOutputs(repoRoot, target.requiredOutputs);
  if (!required.valid) return required;
  return {
    valid: true,
    outputDigest: await computeOutputDigest(repoRoot, target.outputRoots),
  };
}

async function inspectTarget(repoRoot, target, upstream, options) {
  const input = await readInputIdentity(repoRoot, target, upstream);
  const cached = await readState(repoRoot, target);
  if (!cached.state) {
    return { reusable: false, clean: true, reason: cached.reason, input };
  }
  const deletedInput = cached.state.inputFiles.some((entry) => !input.inputFiles.includes(entry));
  if (deletedInput) {
    return { reusable: false, clean: true, reason: 'input file deleted', input };
  }

  let outputs;
  try {
    outputs = await validateOutputs(repoRoot, target, options.computeOutputDigest);
  } catch (error) {
    return {
      reusable: false,
      clean: true,
      reason: `output inspection failed: ${error instanceof Error ? error.message : String(error)}`,
      input,
    };
  }
  if (!outputs.valid) {
    return { reusable: false, clean: true, reason: outputs.reason, input };
  }
  if (cached.state.outputDigest !== outputs.outputDigest) {
    return { reusable: false, clean: true, reason: 'output digest changed', input };
  }

  const tsBuildInfoDigest = await digestTsBuildInfo(repoRoot, target);
  if (target.tsBuildInfoPath && cached.state.tsBuildInfoDigest !== tsBuildInfoDigest) {
    return { reusable: false, clean: true, reason: 'tsbuildinfo changed', input };
  }
  if (cached.state.key !== input.key) {
    return { reusable: false, clean: false, reason: 'input identity changed', input };
  }
  return {
    reusable: true,
    clean: false,
    reason: 'input and output identity match',
    input,
    outputDigest: outputs.outputDigest,
    tsBuildInfoDigest,
  };
}

async function runChild(command, args, repoRoot) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env: process.env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(signal
        ? `Development build terminated by signal ${signal}.`
        : `Development build exited with code ${code}.`));
    });
  });
}

async function runDefaultBuilder(repoRoot, target) {
  if (target.packageName) {
    const npmExecPath = process.env.npm_execpath?.trim();
    if (!npmExecPath) {
      throw new Error('Cannot run the development build because npm_execpath is missing. Run it through pnpm.');
    }
    await runChild(
      process.execPath,
      [path.resolve(npmExecPath), '--filter', target.packageName, 'run', target.scriptName],
      repoRoot,
    );
    return;
  }
  await runChild(
    process.execPath,
    [path.join(repoRoot, 'packages', 'cli', 'dist', 'scripts', 'bundle-plugins.js')],
    repoRoot,
  );
}

async function cleanTarget(repoRoot, target) {
  await Promise.all([
    ...target.outputRoots.map((root) => fs.rm(path.join(repoRoot, root), {
      recursive: true,
      force: true,
    })),
    target.tsBuildInfoPath
      ? fs.rm(path.join(repoRoot, target.tsBuildInfoPath), { force: true })
      : Promise.resolve(),
  ]);
}

async function writeState(repoRoot, target, state) {
  const statePath = cachePath(repoRoot, target);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
  await fs.rename(temporaryPath, statePath);
}

async function buildTarget(repoRoot, target, upstream, options) {
  const inspection = await inspectTarget(repoRoot, target, upstream, options);
  if (inspection.reusable) {
    return {
      target: target.id,
      reused: true,
      cleaned: false,
      reason: inspection.reason,
      inputDigest: inspection.input.identity.inputDigest,
      outputDigest: inspection.outputDigest,
    };
  }

  await fs.rm(cachePath(repoRoot, target), { force: true });
  if (inspection.clean) await cleanTarget(repoRoot, target);
  const builder = options.builders?.[target.id];
  if (builder) {
    await builder({ repoRoot, target: target.id, cleaned: inspection.clean });
  } else {
    await runDefaultBuilder(repoRoot, target);
  }

  const finalInput = await readInputIdentity(repoRoot, target, upstream);
  if (finalInput.key !== inspection.input.key) {
    throw new Error(`Development build input changed while building target ${target.id}.`);
  }
  const outputs = await validateOutputs(repoRoot, target, options.computeOutputDigest);
  if (!outputs.valid) {
    throw new Error(`Development target ${target.id} completed without valid outputs: ${outputs.reason}.`);
  }
  const tsBuildInfoDigest = await digestTsBuildInfo(repoRoot, target);
  if (target.tsBuildInfoPath && !tsBuildInfoDigest) {
    throw new Error(`Development target ${target.id} completed without valid tsbuildinfo.`);
  }
  await writeState(repoRoot, target, {
    schemaVersion: DEV_CACHE_SCHEMA_VERSION,
    target: target.id,
    key: finalInput.key,
    inputDigest: finalInput.identity.inputDigest,
    inputFiles: finalInput.inputFiles,
    outputDigest: outputs.outputDigest,
    ...(tsBuildInfoDigest ? { tsBuildInfoDigest } : {}),
  });
  return {
    target: target.id,
    reused: false,
    cleaned: inspection.clean,
    reason: inspection.reason,
    inputDigest: finalInput.identity.inputDigest,
    outputDigest: outputs.outputDigest,
  };
}

export async function buildDevWithCache(repoRoot, options = {}) {
  const results = [];
  const upstream = {};
  for (const target of TARGETS) {
    const targetUpstream = target.id === 'agent-skill-eval' || target.id === 'plugin-core'
      ? {}
      : { ...upstream };
    const result = await buildTarget(repoRoot, target, targetUpstream, options);
    results.push(result);
    upstream[target.id] = result.outputDigest;
  }
  return { targets: results };
}

export const devBuildCacheContract = {
  schemaVersion: DEV_CACHE_SCHEMA_VERSION,
  targets: TARGETS.map((target) => ({
    id: target.id,
    inputPaths: target.inputPaths,
    outputRoots: target.outputRoots,
    requiredOutputs: target.requiredOutputs.map((output) => output.path),
    tsBuildInfoPath: target.tsBuildInfoPath ?? null,
    statePath: `.release/cache/dev-build/${target.id}.json`,
  })),
};
