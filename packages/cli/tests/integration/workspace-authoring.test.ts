import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/index.js';
import { catalogPathProviderInternal } from '../../src/utils/path-catalog-provider.js';

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cli-workspace-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: (text: string) => { stdout += text; },
      stderr: (text: string) => { stderr += text; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe('public workspace authoring commands', () => {
  it('initializes and versions a non-Git workspace with one JSON stdout object', async () => {
    const root = await createRoot();
    const initOutput = capture();
    expect(await runCli(['catalog', 'init', '--workspace-root', root, '--json'], {
      cwd: root,
      io: initOutput.io,
    })).toBe(0);
    expect(JSON.parse(initOutput.stdout())).toMatchObject({
      command: 'catalog:init',
      ok: true,
      catalogVersion: '0.1.0',
    });
    expect(initOutput.stderr()).toBe('');

    const versionOutput = capture();
    expect(await runCli(['catalog', 'version', '1.0.0-beta.1', '--workspace-root', root, '--json'], {
      cwd: root,
      io: versionOutput.io,
    })).toBe(0);
    expect(JSON.parse(versionOutput.stdout())).toMatchObject({
      command: 'catalog:version',
      ok: true,
      catalogVersion: '1.0.0-beta.1',
    });
  });

  it('rejects removed --repo-root and reports JSON failures safely', async () => {
    const root = await createRoot();
    const removed = capture();
    expect(await runCli(['catalog', 'init', '--repo-root', root], { cwd: root, io: removed.io }))
      .toBe(1);
    expect(removed.stderr()).toContain('unknown option');

    const removedJson = capture();
    expect(await runCli(['catalog', 'init', '--repo-root', root, '--json'], {
      cwd: root,
      io: removedJson.io,
    })).toBe(1);
    expect(JSON.parse(removedJson.stdout())).toMatchObject({
      command: 'catalog:init',
      ok: false,
      errors: [{ code: 'invalidArguments' }],
    });

    const invalid = capture();
    expect(await runCli(['catalog', 'version', 'not-semver', '--workspace-root', root, '--json'], {
      cwd: root,
      io: invalid.io,
    })).toBe(1);
    expect(JSON.parse(invalid.stdout())).toMatchObject({ command: 'catalog:version', ok: false });
    expect(invalid.stderr()).not.toBe('');
  });

  it('reports current status without Git and requires Git only for an explicit base', async () => {
    const root = await createRoot();
    await fs.ensureDir(path.join(root, 'plugins', 'demo', '.agents-plugin'));
    await fs.writeJson(path.join(root, 'plugins', 'demo', '.agents-plugin', 'plugin.json'), {
      schemaVersion: 1,
      name: 'demo',
      version: '0.1.0',
      description: 'Demo plugin.',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
    });
    const current = capture();
    expect(await runCli(['plugin', 'status', 'demo', '--workspace-root', root, '--json'], {
      cwd: root,
      io: current.io,
    })).toBe(0);
    expect(JSON.parse(current.stdout())).toMatchObject({
      ok: true,
      base: null,
      checks: [{ plugin: 'demo', status: 'current', currentVersion: '0.1.0' }],
    });

    const diff = capture();
    expect(await runCli([
      'plugin', 'status', 'demo', '--base', 'HEAD', '--workspace-root', root, '--json',
    ], { cwd: root, io: diff.io })).toBe(1);
    expect(diff.stderr()).toMatch(/Git|git/u);
  });

  it('completes the local author loop in a private non-Git package workspace', async () => {
    const root = await createRoot();
    await fs.writeJson(path.join(root, 'package.json'), { private: true });
    expect(await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root })).toBe(0);
    expect(await runCli([
      'plugin', 'init', 'private-demo',
      '--description', 'Private workspace demo plugin.',
      '--no-skills',
      '--with-mcp',
      '--workspace-root', root,
    ], { cwd: root })).toBe(0);
    expect(await runCli([
      'plugin', 'validate', 'plugins/private-demo', '--workspace-root', root, '--json',
    ], { cwd: root })).toBe(0);

    const testOutput = capture();
    expect(await runCli([
      'plugin', 'test', 'plugins/private-demo', '--workspace-root', root, '--json',
    ], { cwd: root, io: testOutput.io })).toBe(0);
    expect(JSON.parse(testOutput.stdout())).toMatchObject({ ok: true, exitCode: 0 });

    expect(await runCli([
      'plugin', 'build', 'plugins/private-demo', '--workspace-root', root,
    ], { cwd: root })).toBe(0);
    expect(await runCli(['catalog', 'build', '--workspace-root', root], { cwd: root })).toBe(0);
    expect(await runCli([
      'catalog', 'validate', path.join(root, '.aw', 'catalog'),
    ], { cwd: root })).toBe(0);
    await expect(catalogPathProviderInternal.resolve({
      id: 'private-workspace',
      type: 'path',
      primary: true,
      path: path.join(root, '.aw', 'catalog'),
    }, {
      cliVersion: '99.0.0',
      freshnessPolicy: 'forceRemote',
      env: { ...process.env, AW_HOME: path.join(root, 'aw-home') },
    })).resolves.toMatchObject({
      source: 'path',
      manifest: { catalogVersion: '0.1.0' },
    });
  });

  it('rejects a linked external plugin before build or test code executes', async () => {
    const root = await createRoot();
    const outside = await createRoot();
    const executed = path.join(outside, 'executed.txt');
    await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root });
    await fs.ensureDir(path.join(outside, '.agents-plugin'));
    await fs.writeJson(path.join(outside, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 1,
      name: 'linked-plugin',
      version: '0.1.0',
      description: 'Linked plugin.',
      compatibility: { aw: { minVersion: '0.0.0' } },
      scripts: { tests: { node: ['scripts/external.test.mjs'] } },
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
    });
    await fs.outputFile(
      path.join(outside, 'scripts', 'external.test.mjs'),
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(executed)}, 'ran');\n`,
    );
    await fs.symlink(outside, path.join(root, 'plugins', 'linked-plugin'));
    for (const command of ['test', 'build']) {
      const output = capture();
      expect(await runCli([
        'plugin', command, 'plugins/linked-plugin', '--workspace-root', root, '--json',
      ], { cwd: root, io: output.io })).toBe(1);
      expect(JSON.parse(output.stdout())).toMatchObject({ ok: false });
    }
    await expect(fs.pathExists(executed)).resolves.toBe(false);
  });
});
