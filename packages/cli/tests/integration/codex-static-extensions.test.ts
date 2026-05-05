import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { installCommand } from '../../src/commands/install.js';
import { statusCommand } from '../../src/commands/status.js';
import { uninstallCommand } from '../../src/commands/uninstall.js';
import { runCli } from '../../src/index.js';
import { resolveCodexPaths, setEmbeddedPluginsRootOverrideForTests } from '../../src/utils/paths.js';
import { readTrackingManifest } from '../../src/utils/tracking.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function copyExtensionsOnlyFixture(repoRoot: string): Promise<void> {
  await fs.copy(
    fixturePath('codex-project-repo-managed', 'plugins', 'extensions-only'),
    path.join(repoRoot, 'plugins', 'extensions-only'),
  );
}

async function addStaticConfigSchemaToExtensionsOnly(repoRoot: string): Promise<void> {
  const manifestPath = path.join(repoRoot, 'plugins', 'extensions-only', '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  manifest.config = {
    schema: {
      mode: {
        type: 'enum',
        values: ['baseline', 'guided', 'strict'],
        default: 'baseline',
      },
    },
  };
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
}

async function makeWorkspace(options?: {
  addConfigSchema?: boolean;
}): Promise<{
  repoRoot: string;
  embeddedRoot: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-static-extensions-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  await copyExtensionsOnlyFixture(repoRoot);
  if (options?.addConfigSchema) {
    await addStaticConfigSchemaToExtensionsOnly(repoRoot);
  }

  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

  return {
    repoRoot,
    embeddedRoot,
    env: {
      ...process.env,
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
      AW_FORCE_CODEX_AVAILABLE: '1',
      PATH: '',
    },
  };
}

function getExtensionsOnlyPaths(repoRoot: string, env: NodeJS.ProcessEnv) {
  const codexPaths = resolveCodexPaths(repoRoot, 'project', env);
  return {
    codexPaths,
    instructionConfigPath: codexPaths.configTomlPath,
    permissionPath: path.join(codexPaths.configDir, 'rules', 'aw-extensions-only-fixture-permissions.rules'),
    hooksPath: codexPaths.hooksPath,
    agentPath: path.join(codexPaths.configDir, 'agents', 'aw-extensions-only-fixture-reviewer.toml'),
  };
}

async function readHooksContentIfExists(hooksPath: string): Promise<string> {
  return await fs.pathExists(hooksPath)
    ? await fs.readFile(hooksPath, 'utf8')
    : '';
}

async function readStaticArtifactSnapshot(repoRoot: string, env: NodeJS.ProcessEnv): Promise<{
  configToml: string;
  permissionRules: string;
  hooksJson: string;
  agentToml: string;
  trackingArtifacts: unknown[];
}> {
  const paths = getExtensionsOnlyPaths(repoRoot, env);
  const tracking = await readTrackingManifest(paths.codexPaths.trackingDir);
  return {
    configToml: await fs.readFile(paths.instructionConfigPath, 'utf8'),
    permissionRules: await fs.readFile(paths.permissionPath, 'utf8'),
    hooksJson: await fs.readFile(paths.hooksPath, 'utf8'),
    agentToml: await fs.readFile(paths.agentPath, 'utf8'),
    trackingArtifacts: tracking.plugins['extensions-only']?.artifacts ?? [],
  };
}

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  delete process.env.AW_HOME;
  delete process.env.AW_CODEX_HOME;
  delete process.env.AW_FORCE_CODEX_AVAILABLE;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('static Codex extensions compatibility', () => {
  it('keeps legacy static extensions install/status/uninstall behavior without dynamic artifact metadata', async () => {
    const { repoRoot, env } = await makeWorkspace();

    await installCommand(
      ['extensions-only'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        env,
      },
    );

    const paths = getExtensionsOnlyPaths(repoRoot, env);
    const tracking = await readTrackingManifest(paths.codexPaths.trackingDir);
    const trackedArtifacts = tracking.plugins['extensions-only']?.artifacts ?? [];
    const trackedAgent = trackedArtifacts.find((artifact) => artifact.kind === 'agent');

    await expect(fs.readFile(paths.instructionConfigPath, 'utf8')).resolves.toContain(
      'Use this managed instruction only for Codex project repo-managed fixture assertions.',
    );
    await expect(fs.readFile(paths.permissionPath, 'utf8')).resolves.toContain(
      'prefix_rule(pattern = ["git","status"], decision = "allow")',
    );
    await expect(fs.readJson(paths.hooksPath)).resolves.toMatchObject({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo extensions-only hook' }],
          },
        ],
      },
    });
    await expect(fs.readFile(paths.agentPath, 'utf8')).resolves.toContain('name = "fixture-reviewer"');
    expect(trackedArtifacts.map((artifact) => artifact.kind).sort()).toEqual([
      'agent',
      'hook',
      'instruction',
      'permission',
    ]);
    expect(trackedArtifacts.every((artifact) =>
      artifact.id === undefined &&
      artifact.target === undefined &&
      artifact.refreshKeys === undefined &&
      artifact.configDigest === undefined,
    )).toBe(true);
    expect(trackedAgent).toMatchObject({
      kind: 'agent',
      path: paths.agentPath,
    });
    expect(trackedAgent?.target).toBeUndefined();
    expect(trackedAgent?.roleKey).toBeUndefined();

    const status = await statusCommand(
      ['extensions-only'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        json: true,
      },
      {
        env,
      },
    );
    const report = status.reports[0]?.plugins[0];

    expect(report).toMatchObject({
      pluginName: 'extensions-only',
      scopeInitialized: 'yes',
      artifactsInitialized: true,
      repoManagedSessionState: {
        instructions: 'projectTrustUnknown',
        rules: 'projectTrustUnknown',
        hooks: 'projectTrustUnknown',
        agents: 'projectTrustUnknown',
      },
    });
    expect(report?.managedArtifacts ?? []).toEqual([]);
    expect(report?.generatedArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'instruction' }),
      expect.objectContaining({ kind: 'permission' }),
      expect.objectContaining({ kind: 'hook' }),
      expect.objectContaining({ kind: 'agent' }),
    ]));
    expect(report?.generatedArtifacts.every((artifact) => artifact.target === undefined)).toBe(true);
    expect(report?.driftWarnings.join('\n') ?? '').not.toContain('config digest');
    expect(report?.driftWarnings.join('\n') ?? '').not.toContain('refresh');

    await uninstallCommand(
      ['extensions-only'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        env,
      },
    );

    await expect(fs.readFile(paths.instructionConfigPath, 'utf8')).resolves.not.toContain(
      'Use this managed instruction only for Codex project repo-managed fixture assertions.',
    );
    await expect(fs.pathExists(paths.permissionPath)).resolves.toBe(false);
    await expect(readHooksContentIfExists(paths.hooksPath)).resolves.not.toContain(
      'echo extensions-only hook',
    );
    await expect(fs.pathExists(paths.agentPath)).resolves.toBe(false);
    await expect(readTrackingManifest(paths.codexPaths.trackingDir)).resolves.toMatchObject({
      plugins: {},
    });
  });

  it('does not rewrite static artifacts or add dynamic status diagnostics when config stores change', async () => {
    const { repoRoot, env } = await makeWorkspace({ addConfigSchema: true });

    await installCommand(
      ['extensions-only'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        env,
      },
    );

    const before = await readStaticArtifactSnapshot(repoRoot, env);

    const setCapture = createCapturedCliIo();
    await expect(runCli(
      ['config', 'set', 'extensions-only', 'mode', 'strict', '-s', 'project'],
      {
        cwd: repoRoot,
        env,
        io: setCapture.io,
      },
    )).resolves.toBe(0);
    expect(setCapture.readStderr()).toBe('');

    const secondSetCapture = createCapturedCliIo();
    await expect(runCli(
      ['config', 'set', 'extensions-only', 'mode', 'guided', '-s', 'project'],
      {
        cwd: repoRoot,
        env,
        io: secondSetCapture.io,
      },
    )).resolves.toBe(0);
    expect(secondSetCapture.readStderr()).toBe('');

    const unsetCapture = createCapturedCliIo();
    await expect(runCli(
      ['config', 'unset', 'extensions-only', 'mode', '-s', 'project'],
      {
        cwd: repoRoot,
        env,
        io: unsetCapture.io,
      },
    )).resolves.toBe(0);
    expect(unsetCapture.readStderr()).toBe('');

    const resetCapture = createCapturedCliIo();
    await expect(runCli(
      ['config', 'reset', 'extensions-only', '-s', 'project', '--yes'],
      {
        cwd: repoRoot,
        env,
        io: resetCapture.io,
      },
    )).resolves.toBe(0);
    expect(resetCapture.readStderr()).toBe('');

    const after = await readStaticArtifactSnapshot(repoRoot, env);
    expect(after).toEqual(before);

    const status = await statusCommand(
      ['extensions-only'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        json: true,
      },
      {
        env,
      },
    );
    const report = status.reports[0]?.plugins[0];

    expect(report?.managedArtifacts ?? []).toEqual([]);
    expect(report?.generatedArtifacts.every((artifact) => artifact.configDigest === undefined)).toBe(true);
    expect(report?.driftWarnings.join('\n') ?? '').not.toContain('config digest');
    expect(report?.driftWarnings.join('\n') ?? '').not.toContain('refresh');
  });
});
