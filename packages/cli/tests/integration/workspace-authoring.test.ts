import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/index.js';
import { catalogPathProviderInternal } from '../../src/utils/path-catalog-provider.js';

const roots: string[] = [];
const placeholderPlanDigest = `sha256:${'0'.repeat(64)}`;

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

describe('public Catalog Workspace authoring commands', () => {
  it('creates an absent canonical root through public plugin init', async () => {
    const root = await createRoot();
    await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root, io: capture().io });
    const pluginRoot = path.join(root, 'plugins', 'context-create');
    await expect(fs.pathExists(pluginRoot)).resolves.toBe(false);

    expect(await runCli([
      'plugin', 'init', 'context-create', '--description', 'Context create fixture.',
      '--no-skills', '--workspace-root', root,
    ], { cwd: os.tmpdir(), io: capture().io })).toBe(0);
    await expect(fs.pathExists(path.join(pluginRoot, '.agents-plugin', 'plugin.json')))
      .resolves.toBe(true);
  });

  it('validates a canonical plugin with positional-first and options-first arguments', async () => {
    const root = await createRoot();
    await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root, io: capture().io });
    await runCli([
      'plugin', 'init', 'argument-order', '--description', 'Argument order fixture.',
      '--no-skills', '--workspace-root', root,
    ], { cwd: root, io: capture().io });
    const pluginRoot = path.join(root, 'plugins', 'argument-order');

    const positionalFirst = capture();
    expect(await runCli([
      'plugin', 'validate', pluginRoot, '--workspace-root', root,
      '--strict-agent-skills', '--json',
    ], { cwd: root, io: positionalFirst.io })).toBe(0);
    expect(JSON.parse(positionalFirst.stdout())).toMatchObject({ ok: true });

    const optionsFirst = capture();
    expect(await runCli([
      'plugin', 'validate', '--json', '--workspace-root', root,
      '--strict-agent-skills', '--claude-skill-profile', 'minimum', pluginRoot,
    ], { cwd: root, io: optionsFirst.io })).toBe(0);
    expect(JSON.parse(optionsFirst.stdout())).toMatchObject({ ok: true });

    const unknown = capture();
    expect(await runCli([
      'plugin', 'validate', '--json', '--unknown-option', pluginRoot,
      '--workspace-root', root,
    ], { cwd: root, io: unknown.io })).toBe(1);
    expect(JSON.parse(unknown.stdout())).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('Unknown option: --unknown-option')],
    });

    const nonCanonical = path.join(root, 'packages', 'argument-order');
    await fs.copy(pluginRoot, nonCanonical);
    const versionLikeOption = capture();
    expect(await runCli([
      'plugin', 'validate', '--version-base', '-x', '--json',
      '--workspace-root', root, nonCanonical,
    ], { cwd: root, io: versionLikeOption.io })).toBe(1);
    expect(JSON.parse(versionLikeOption.stdout())).toMatchObject({
      ok: false,
      errors: [expect.stringContaining(path.join(root, 'plugins', 'argument-order'))],
    });
  });

  it.each([
    ['plugin validate', ['plugin', 'validate', 'plugins/source-link']],
    ['plugin test', ['plugin', 'test', 'plugins/source-link']],
    ['plugin build', ['plugin', 'build', 'plugins/source-link']],
    ['catalog build', ['catalog', 'build']],
  ])('rejects an external authoring source symlink before %s reads it', async (_label, command) => {
    const root = await createRoot();
    await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root, io: capture().io });
    await runCli([
      'plugin', 'init', 'source-link', '--description', 'Source symlink fence fixture.',
      '--no-skills', '--workspace-root', root,
    ], { cwd: root, io: capture().io });
    const pluginRoot = path.join(root, 'plugins', 'source-link');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.mcpServers = './.mcp.json';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    const outside = path.join(root, 'outside-invalid.json');
    await fs.writeFile(outside, 'not JSON\n');
    await fs.symlink(outside, path.join(pluginRoot, '.mcp.json'));
    const output = capture();

    expect(await runCli([...command, '--workspace-root', root], {
      cwd: root,
      io: output.io,
    })).toBe(1);
    const failureOutput = `${output.stdout()}\n${output.stderr()}`;
    expect(failureOutput).toMatch(/symbolic link/u);
    expect(failureOutput).not.toContain('source JSON is invalid');
  });

  it('ignores nested Git and dependency directories without copying their external links', async () => {
    const root = await createRoot();
    const outsideRoot = await createRoot();
    await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root, io: capture().io });
    await runCli([
      'plugin', 'init', 'ignored-inputs', '--description', 'Ignored authoring inputs fixture.',
      '--no-skills', '--workspace-root', root,
    ], { cwd: root, io: capture().io });
    const pluginRoot = path.join(root, 'plugins', 'ignored-inputs');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.scripts = { node: { build: { runner: 'node', path: './build.mjs' } } };
    manifest.buildConfig = {
      fileRules: {
        claude: { include: ['nested/**'], exclude: [] },
        codex: { include: ['nested/**'], exclude: [] },
      },
    };
    const ignoredDirectories = [
      path.join(pluginRoot, 'nested', '.git'),
      path.join(pluginRoot, 'nested', 'node_modules'),
    ];
    const outsideFile = path.join(outsideRoot, 'private.txt');
    await Promise.all([
      fs.writeJson(manifestPath, manifest, { spaces: 2 }),
      fs.outputFile(path.join(pluginRoot, 'nested', 'visible.txt'), 'public fixture\n'),
      fs.writeFile(outsideFile, 'external private bytes\n'),
      ...ignoredDirectories.map((directory) => fs.ensureDir(directory)),
    ]);
    await Promise.all(ignoredDirectories.map((directory) =>
      fs.symlink(outsideFile, path.join(directory, 'external-link.txt'))));
    await fs.writeFile(path.join(pluginRoot, 'build.mjs'), `
import { existsSync } from 'node:fs';
for (const relativePath of ['nested/.git', 'nested/node_modules']) {
  if (existsSync(new URL(relativePath, import.meta.url))) {
    throw new Error(\`ignored authoring input reached staging: \${relativePath}\`);
  }
}
`);

    for (const command of [
      ['plugin', 'validate', 'plugins/ignored-inputs'],
      ['plugin', 'test', 'plugins/ignored-inputs'],
      ['plugin', 'build', 'plugins/ignored-inputs'],
      ['catalog', 'build'],
    ]) {
      expect(await runCli([...command, '--workspace-root', root], {
        cwd: root,
        io: capture().io,
      })).toBe(0);
    }

    for (const outputRoot of [
      path.join(root, '.aw', 'plugins', 'ignored-inputs'),
      path.join(root, '.aw', 'catalog', 'plugins', 'ignored-inputs'),
    ]) {
      for (const platform of ['claude', 'codex']) {
        await expect(fs.readFile(
          path.join(outputRoot, platform, 'nested', 'visible.txt'),
          'utf8',
        )).resolves.toBe('public fixture\n');
        for (const ignoredDirectory of ['.git', 'node_modules']) {
          await expect(fs.pathExists(
            path.join(outputRoot, platform, 'nested', ignoredDirectory),
          )).resolves.toBe(false);
        }
      }
    }
  });

  it('rejects ignored manifest source paths consistently before validate or build', async () => {
    const root = await createRoot();
    await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root, io: capture().io });
    await runCli([
      'plugin', 'init', 'ignored-source', '--description', 'Ignored source path fixture.',
      '--no-skills', '--workspace-root', root,
    ], { cwd: root, io: capture().io });
    const pluginRoot = path.join(root, 'plugins', 'ignored-source');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.mcpServers = './nested/node_modules/.mcp.json';
    await Promise.all([
      fs.writeJson(manifestPath, manifest, { spaces: 2 }),
      fs.outputJson(path.join(pluginRoot, 'nested', 'node_modules', '.mcp.json'), { mcpServers: {} }),
    ]);

    for (const command of [
      ['plugin', 'validate', 'plugins/ignored-source'],
      ['plugin', 'build', 'plugins/ignored-source'],
    ]) {
      const output = capture();
      expect(await runCli([...command, '--workspace-root', root], {
        cwd: root,
        io: output.io,
      })).toBe(1);
      expect(`${output.stdout()}\n${output.stderr()}`).toContain(
        'source paths must not enter node_modules',
      );
    }
  });

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

    const bumpOutput = capture();
    expect(await runCli(['catalog', 'version', '--bump', 'patch', '--workspace-root', root, '--json'], {
      cwd: root,
      io: bumpOutput.io,
    })).toBe(0);
    expect(JSON.parse(bumpOutput.stdout())).toMatchObject({
      command: 'catalog:version',
      ok: true,
      catalogVersion: '1.0.1',
      changed: true,
    });

    const conflictingOutput = capture();
    expect(await runCli([
      'catalog', 'version', '1.0.2', '--bump', 'minor', '--workspace-root', root, '--json',
    ], { cwd: root, io: conflictingOutput.io })).toBe(1);
    expect(JSON.parse(conflictingOutput.stdout())).toMatchObject({
      command: 'catalog:version',
      ok: false,
    });
    expect(conflictingOutput.stderr()).toContain('not both');

    const invalidBumpOutput = capture();
    expect(await runCli([
      'catalog', 'version', '--bump', 'prerelease', '--workspace-root', root, '--json',
    ], { cwd: root, io: invalidBumpOutput.io })).toBe(1);
    expect(JSON.parse(invalidBumpOutput.stdout())).toMatchObject({
      command: 'catalog:version',
      ok: false,
    });
    expect(invalidBumpOutput.stderr()).toContain('major, minor, or patch');

    for (const version of ['1.0.0-rc.1', '1.0.0+build.1']) {
      const invalidOutput = capture();
      expect(await runCli(['catalog', 'version', version, '--workspace-root', root, '--json'], {
        cwd: root,
        io: invalidOutput.io,
      })).toBe(1);
      expect(JSON.parse(invalidOutput.stdout())).toMatchObject({
        command: 'catalog:version',
        ok: false,
      });
      expect(invalidOutput.stderr()).toContain('stable SemVer or an exact x.y.z-beta.N');
    }
  });

  it('reads and writes Catalog versions without a CLI capability build import', async () => {
    const root = await createRoot();
    await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root, io: capture().io });
    await runCli([
      'plugin', 'init', 'reserved-import', '--description', 'Reserved import fixture.',
      '--no-skills', '--workspace-root', root,
    ], { cwd: root, io: capture().io });
    const readOutput = capture();
    expect(await runCli(['catalog', 'version', '--workspace-root', root, '--json'], {
      cwd: root,
      io: readOutput.io,
    })).toBe(0);
    expect(JSON.parse(readOutput.stdout())).toMatchObject({ catalogVersion: '0.1.0' });
    const writeOutput = capture();
    expect(await runCli(['catalog', 'version', '0.2.0', '--workspace-root', root, '--json'], {
      cwd: root,
      io: writeOutput.io,
    })).toBe(0);
    expect(JSON.parse(writeOutput.stdout())).toMatchObject({ catalogVersion: '0.2.0' });
  });

  it('prints only public authoring commands after third-party plugin init', async () => {
    const root = await createRoot();
    await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root, io: capture().io });
    const output = capture();
    expect(await runCli([
      'plugin', 'init', 'next-steps', '--description', 'Next-step output fixture.',
      '--no-skills', '--workspace-root', root,
    ], { cwd: root, io: output.io })).toBe(0);

    expect(output.stdout()).toContain('aw plugin validate');
    expect(output.stdout()).toContain('aw plugin test');
    expect(output.stdout()).toContain('aw plugin build');
    expect(output.stdout()).toContain('aw catalog build');
    expect(output.stdout()).not.toContain('pnpm build');
    expect(output.stdout()).not.toContain('pnpm release');
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
    await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root, io: capture().io });
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
    const resolution = await catalogPathProviderInternal.resolve({
      id: 'private-workspace',
      type: 'path',
      primary: true,
      path: path.join(root, '.aw', 'catalog'),
    }, {
      cliVersion: '99.0.0',
      env: { ...process.env, AW_HOME: path.join(root, 'aw-home') },
    });
    expect(resolution).toMatchObject({
      transport: 'path',
      manifest: { catalogVersion: '0.1.0' },
    });
    await resolution.cleanup();
  });

  it('requires explicit non-interactive publication confirmation with one JSON failure object', async () => {
    const output = capture();

    expect(await runCli([
      'catalog', 'publish', 'apply', '--expected-plan-digest', placeholderPlanDigest, '--json',
    ], {
      interactive: false,
      io: output.io,
    })).toBe(1);
    expect(JSON.parse(output.stdout())).toEqual({
      ok: false,
      code: 'catalogPublicationFailed',
      message: 'Catalog publish apply with --json requires --yes.',
    });
    expect(output.stderr()).toContain('requires --yes');
  });

  it('rejects a linked external plugin before build or test code executes', async () => {
    const root = await createRoot();
    const outside = await createRoot();
    const executed = path.join(outside, 'executed.txt');
    await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root });
    await fs.ensureDir(path.join(outside, '.agents-plugin'));
    await fs.writeJson(path.join(outside, '.agents-plugin', 'plugin.json'), {
      name: 'linked-plugin',
      version: '0.1.0',
      description: 'Linked plugin.',
      schemaVersion: 3,
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
