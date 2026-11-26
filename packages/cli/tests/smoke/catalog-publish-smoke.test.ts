import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, expect, it } from 'vitest';

import {
  prepareCatalogRelease,
  publishCatalogRelease,
  resolveCatalogPluginBaseVersions,
} from '../../../../scripts/release/catalog-publication.mjs';
import { catalogGitProviderInternal } from '../../src/utils/git-catalog-provider.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const execFileAsync = promisify(execFile);
let temporaryRoot: string | null = null;

afterEach(async () => {
  if (temporaryRoot) await fs.remove(temporaryRoot);
  temporaryRoot = null;
});

async function runAw(cliEntry: string, workspaceRoot: string, args: string[]) {
  return execFileAsync(process.execPath, [cliEntry, ...args], {
    cwd: workspaceRoot,
    env: getCurrentSourceTestIsolation().env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

it('validates the built dynamic Skill and Grok permissions before preparing a publication plan', async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-built-catalog-smoke-'));
  const workspaceRoot = path.join(temporaryRoot, 'workspace');
  const remoteUrl = path.join(temporaryRoot, 'catalog.git');
  const cliEntry = path.resolve(import.meta.dirname, '../../dist/index.js');
  await fs.ensureDir(workspaceRoot);
  await execFileAsync('git', ['init', '--bare', '--quiet', remoteUrl]);
  const git = (...args: string[]) => execFileAsync('git', args, { cwd: workspaceRoot });
  await git('init', '--quiet');
  await git('remote', 'add', 'origin', remoteUrl);
  await runAw(cliEntry, workspaceRoot, [
    'dev', 'catalog', 'create', '--workspace-root', workspaceRoot, '--catalog-version', '91.0.1',
    '--owner-url', 'https://catalog.example.com/build-demo',
  ]);
  await runAw(cliEntry, workspaceRoot, [
    'dev', 'plugin', 'create', 'build-demo', '--description', 'Built dynamic Skill.', '--no-skills',
    '--workspace-root', workspaceRoot,
  ]);
  const pluginRoot = path.join(workspaceRoot, 'plugins', 'build-demo');
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  await fs.writeJson(manifestPath, {
    ...await fs.readJson(manifestPath),
    platforms: ['generic', 'grok'],
    extensions: { permissions: [{ name: 'build-demo', allow: ['printf built-skill'], agentOverrides: { generic: null } }] },
    scripts: {
      node: { build: { runner: 'node', path: './build.mjs' } },
      artifacts: { render: { runner: 'node', path: './render.mjs' } },
    },
    config: {
      schemaVersion: 5,
      fields: {
        profile: { type: 'object', platformOnly: true, required: true,
          properties: { executor: { type: 'string' } }, additionalProperties: false },
        optionalProfile: { type: 'object', platformOnly: true,
          properties: { executor: { type: 'string' } }, additionalProperties: false },
        nonemptyProfile: { type: 'object', required: true,
          properties: { executor: { type: 'string', required: true } }, additionalProperties: false },
        requiredList: { type: 'array', required: true, items: { type: 'string' } },
      },
      platforms: { generic: { fields: {
        profile: { type: 'object', platformOnly: true, required: true,
          properties: { executor: { type: 'string' } }, additionalProperties: false,
          default: { executor: 'native' } },
      } } },
    },
    artifacts: { configKeys: ['profile', 'optionalProfile', 'nonemptyProfile', 'requiredList'], sourceDirs: ['./runtime'] },
  });
  await fs.outputFile(path.join(pluginRoot, 'runtime', 'entry.mjs'), 'import "unbundled-fixture-dependency";\n');
  await fs.writeFile(path.join(pluginRoot, 'render.mjs'), `
import fs from 'node:fs';
const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
if (context.allowedOutputKinds.includes('skill')) {
  const expected = context.platform === 'generic' ? { executor: 'native' } : {};
  if (JSON.stringify(context.config.values.profile) !== JSON.stringify(expected)
    || context.config.sources.profile !== (context.platform === 'generic' ? 'default' : 'platform')
    || JSON.stringify(context.config.values.requiredList) !== '[]'
    || context.config.sources.requiredList !== 'common'
    || Object.hasOwn(context.config.values, 'optionalProfile')
    || Object.hasOwn(context.config.values, 'nonemptyProfile')) {
    throw new Error('Expected only valid configured fixture values');
  }
}
const components = context.allowedOutputKinds.includes('skill') ? [{
  id: 'built-skill', kind: 'skill', name: 'built-skill', content: { files: {
    'SKILL.md': { text: '---\\nname: built-skill\\ndescription: A built dynamic Skill.\\n---\\nRun \\x60node scripts/entry.mjs\\x60.\\n' },
    'README.md': { text: '# Built Skill\\n' },
    'scripts/entry.mjs': { source: { kind: 'bundle', path: 'runtime/entry.mjs' } },
  } },
}] : [];
console.log(JSON.stringify({ version: 3, components, omitted: [], unmet: [] }));
`);
  const buildEntry = path.join(pluginRoot, 'build.mjs');
  const commit = async (message: string) => {
    await git('add', '.');
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', message);
  };
  const plan = () => runAw(cliEntry, workspaceRoot, [
    'dev', 'catalog', 'publish', 'plan', '--workspace-root', workspaceRoot,
    '--remote', 'origin', '--branch', 'catalog/build-smoke', '--json',
  ]);

  await fs.writeFile(buildEntry, 'export {};\n');
  await commit('Source with a missing build output');
  const failure = await plan().then(() => null, (error: unknown) => error as { stdout: string });
  expect(failure).not.toBeNull();
  expect(JSON.parse(failure!.stdout).diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: 'pluginValidationFailed',
      message: expect.stringMatching(/built bundle.*unbundled-fixture-dependency/iu),
    }),
  ]));
  await expect(fs.pathExists(path.join(workspaceRoot, '.aw', 'publish', '91.0.1', 'journal.json'))).resolves.toBe(false);

  await fs.writeFile(buildEntry, `
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./runtime/entry.mjs', import.meta.url), 'export const bundled = true;\\n');
`);
  await commit('Produce the self-contained runtime entry');
  expect(JSON.parse((await plan()).stdout)).toMatchObject({
    status: 'success',
    data: { prepared: true, state: 'prepared' },
  });
});

it('publishes complete v3 dynamic source through the built public CLI and Git provider', async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-public-catalog-smoke-'));
  const workspaceRoot = path.join(temporaryRoot, 'workspace');
  const remoteUrl = path.join(temporaryRoot, 'catalog.git');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const cliEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
  await Promise.all([
    fs.ensureDir(workspaceRoot),
    execFileAsync('git', ['init', '--bare', '--quiet', remoteUrl]),
  ]);
  await execFileAsync('git', ['init', '--quiet'], { cwd: workspaceRoot });
  await runAw(cliEntry, workspaceRoot, [
    'dev', 'catalog', 'create', '--workspace-root', workspaceRoot, '--catalog-version', '91.0.0',
    '--owner-url', 'https://catalog.example.com/smoke-demo',
  ]);
  await runAw(cliEntry, workspaceRoot, [
    'dev', 'plugin', 'create', 'smoke-demo', '--description', 'Smoke demo.', '--no-skills',
    '--workspace-root', workspaceRoot,
  ]);
  const pluginManifestPath = path.join(workspaceRoot, 'plugins', 'smoke-demo', '.agents-plugin', 'plugin.json');
  const pluginManifest = await fs.readJson(pluginManifestPath);
  await fs.writeJson(pluginManifestPath, {
    ...pluginManifest,
    platforms: ['codex', 'claude'],
    scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
    artifacts: { configKeys: [] },
  }, { spaces: 2 });
  await fs.writeFile(path.join(workspaceRoot, 'plugins', 'smoke-demo', 'render.mjs'), [
    'import fs from "node:fs";',
    'const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
    `const files = ${JSON.stringify({
      'SKILL.md': '---\nname: dynamic\ndescription: Dynamic smoke Skill.\n---\n# Dynamic\n',
      'README.md': '# Dynamic\n\nDynamic smoke Skill.\n',
      'agents/openai.yaml': 'policy:\n  allow_implicit_invocation: true\n',
    })};`,
    'const offered = context.allowedOutputKinds.includes("skill");',
    'const supported = context.platformCapabilities.kinds.skill.status === "supported";',
    'console.log(JSON.stringify({ version: 3, components: offered && supported ? [{',
    'id: "dynamic", kind: "skill", name: "dynamic", content: { files: Object.fromEntries(Object.entries(files).map(([name,text])=>[name,{text}])) },',
    '}]:[], omitted:[], unmet:offered && !supported ? [{id:"dynamic",kind:"skill",name:"dynamic",',
    'requiredFeatures:[{feature:"component.kind.skill"}],reasonCode:"interface-unsupported"}]:[] }));',
  ].join('\n'));
  await execFileAsync('git', ['add', '.'], { cwd: workspaceRoot });
  await execFileAsync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', 'source',
  ], { cwd: workspaceRoot });
  await execFileAsync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: workspaceRoot });

  const plan = await runAw(cliEntry, workspaceRoot, [
    'dev', 'catalog', 'publish', 'plan', '--workspace-root', workspaceRoot,
    '--remote', 'origin', '--branch', 'catalog/smoke', '--json',
  ]);
  const planResult = JSON.parse(plan.stdout);
  expect(planResult).toMatchObject({
    schemaVersion: 2, command: 'dev.catalog.publish.plan', status: 'success',
    data: { prepared: true, state: 'prepared', planDigest: expect.stringMatching(/^sha256:/u) },
    diagnostics: expect.any(Array), nextActions: expect.any(Array),
  });
  const planDigest = planResult.data.planDigest as string;
  // A rejected real push must retain execution evidence through the shipped CLI boundary.
  const hook = path.join(remoteUrl, 'hooks', 'pre-receive');
  await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  try {
    const failure = await runAw(cliEntry, workspaceRoot, [
      'dev', 'catalog', 'publish', 'apply', '--workspace-root', workspaceRoot,
      '--remote', 'origin', '--branch', 'catalog/smoke',
      '--expected-plan-digest', planDigest, '--yes', '--json',
    ]).then(() => null, (error: unknown) => error as { code: number; stdout: string });
    expect(failure?.code).toBe(4);
    expect(JSON.parse(failure!.stdout)).toMatchObject({
      schemaVersion: 2, command: 'dev.catalog.publish.apply', status: 'partial',
      data: {
        state: 'uncertain', journalState: 'uncertain', planDigest,
        expectedCommit: planResult.data.expectedCommit,
        catalogVersion: '91.0.0', branch: 'catalog/smoke', tag: 'catalog-v91.0.0',
        remoteWriteAttempted: true, remoteVerified: false,
      },
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'catalogPublicationFailed', severity: 'error' })]),
      nextActions: expect.any(Array),
    });
    await expect(fs.readJson(path.join(workspaceRoot, '.aw', 'publish', '91.0.0', 'journal.json')))
      .resolves.toMatchObject({ schemaVersion: 2, state: 'uncertain', planDigest });
    await expect(fs.pathExists(path.join(workspaceRoot, '.aw', 'publish', '91.0.0', 'repository')))
      .resolves.toBe(true);
  } finally {
    await fs.remove(hook);
  }
  const result = await runAw(cliEntry, workspaceRoot, [
    'dev', 'catalog', 'publish', 'apply', '--workspace-root', workspaceRoot,
    '--remote', 'origin', '--branch', 'catalog/smoke',
    '--expected-plan-digest', planDigest, '--yes', '--json',
  ]);
  const appliedResult = JSON.parse(result.stdout);
  expect(appliedResult).toMatchObject({
    schemaVersion: 2, command: 'dev.catalog.publish.apply', status: 'success',
    data: { state: 'published', planDigest, commit: planResult.data.expectedCommit },
    diagnostics: expect.any(Array), nextActions: expect.any(Array),
  });
  const receipt = appliedResult.data as { commit: string; snapshotDigest: string };
  expect((await execFileAsync('git', [
    '--git-dir', remoteUrl, 'rev-parse', 'refs/heads/catalog/smoke',
  ])).stdout.trim()).toBe(receipt.commit);
  expect((await execFileAsync('git', [
    '--git-dir', remoteUrl, 'cat-file', '-t', 'refs/tags/catalog-v91.0.0',
  ])).stdout.trim()).toBe('tag');

  const resolved = await catalogGitProviderInternal.resolve({
    id: 'smoke',
    type: 'git',
    primary: true,
    url: remoteUrl,
    refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/smoke' },
  }, {
    cliVersion: '99.0.0',
    freshnessPolicy: 'forceRemote',
    env: getCurrentSourceTestIsolation().env,
  });
  expect(resolved.resolvedCommit).toBe(receipt.commit);
  expect(resolved.manifest.catalogVersion).toBe('91.0.0');
  const pluginRoot = path.join(resolved.rootDir, 'plugins', 'smoke-demo');
  for (const platform of ['codex', 'claude']) {
    const manifest = await fs.readJson(path.join(pluginRoot, `.${platform}-plugin`, 'plugin.json'));
    expect(manifest).toMatchObject({ name: 'smoke-demo', version: '0.1.0' });
    expect(manifest).not.toHaveProperty('skills');
    await expect(fs.pathExists(path.join(pluginRoot, platform, 'skills', 'dynamic'))).resolves.toBe(false);
  }
  await expect(fs.readFile(path.join(pluginRoot, 'render.mjs'), 'utf8')).resolves.toContain('version: 3');
  await expect(fs.readJson(path.join(
    workspaceRoot,
    '.aw',
    'publish',
    '91.0.0',
    'journal.json',
  ))).resolves.toMatchObject({
    schemaVersion: 2,
    state: 'published',
    repository: null,
    descriptor: {
      branch: 'catalog/smoke',
      snapshotDigest: receipt.snapshotDigest,
    },
  });
});

it('uses the compiled Core version owner to prepare only changed official Plugin bases', async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-official-catalog-base-smoke-'));
  const workspaceRoot = path.join(temporaryRoot, 'workspace');
  const remoteUrl = path.join(temporaryRoot, 'catalog.git');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const cliDistRoot = path.join(repoRoot, 'packages', 'cli', 'dist');
  const cliEntry = path.join(cliDistRoot, 'index.js');
  const env = getCurrentSourceTestIsolation().env;
  await Promise.all([
    fs.ensureDir(workspaceRoot),
    execFileAsync('git', ['init', '--bare', '--quiet', remoteUrl]),
  ]);
  await execFileAsync('git', ['init', '--quiet'], { cwd: workspaceRoot });
  await runAw(cliEntry, workspaceRoot, [
    'dev', 'catalog', 'create', '--workspace-root', workspaceRoot, '--catalog-version', '1.0.0',
    '--owner-url', 'https://catalog.example.com/base-smoke',
  ]);
  for (const name of ['unchanged-plugin', 'changed-plugin']) {
    await runAw(cliEntry, workspaceRoot, [
      'dev', 'plugin', 'create', name, '--description', 'Base smoke.', '--no-skills',
      '--workspace-root', workspaceRoot,
    ]);
  }
  async function commitSource() {
    await execFileAsync('git', ['add', '--all'], { cwd: workspaceRoot });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--quiet', '-m', 'source',
    ], { cwd: workspaceRoot });
  }
  await commitSource();
  const plan = await prepareCatalogRelease('latest', { repoRoot: workspaceRoot, remoteUrl, env });
  await publishCatalogRelease({
    channel: 'stable', expectedPlanDigest: plan.planDigest,
  }, { repoRoot: workspaceRoot, remoteUrl, env });

  const manifestPath = path.join(workspaceRoot, 'plugins', 'changed-plugin', '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  await fs.writeJson(manifestPath, { ...manifest, description: 'Changed production content.' }, { spaces: 2 });
  await runAw(cliEntry, workspaceRoot, [
    'dev', 'catalog', 'version', '1.0.1-beta.1', '--workspace-root', workspaceRoot,
  ]);
  await commitSource();
  await runAw(cliEntry, workspaceRoot, ['dev', 'catalog', 'build', '--workspace-root', workspaceRoot]);
  const sourceHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot })).stdout.trim();
  await expect(resolveCatalogPluginBaseVersions({
    channel: 'stable', repoRoot: workspaceRoot, remoteUrl, sourceHead, env, cliDistRoot,
  })).resolves.toEqual({ 'changed-plugin': '0.1.1' });
});
