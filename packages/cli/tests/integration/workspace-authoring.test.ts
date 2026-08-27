import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/index.js';
import { catalogPathProviderInternal } from '../../src/utils/path-catalog-provider.js';

const roots: string[] = [];
const execFileAsync = promisify(execFile);

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

async function createPublishWorkspace(root: string, pluginName: string): Promise<void> {
  await execFileAsync('git', ['init'], { cwd: root });
  await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root, io: capture().io });
  await runCli([
    'plugin', 'init', pluginName, '--description', `${pluginName} publication fixture.`,
    '--no-skills', '--workspace-root', root,
  ], { cwd: root, io: capture().io });
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-m', 'initial',
  ], { cwd: root });
}

describe('public Catalog Workspace authoring commands', () => {
  it('creates context for an absent canonical root before public plugin init', async () => {
    const root = await createRoot();
    await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root, io: capture().io });
    const pluginRoot = path.join(root, 'plugins', 'context-create');
    const componentsPath = path.join(root, 'components.json');
    await fs.writeJson(componentsPath, [{
      id: 'manifest',
      type: 'manifest',
      operation: 'create',
      paths: ['.agents-plugin/plugin.json'],
      profiles: ['CODEX', 'CLAUDE'],
    }]);
    const prepare = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../plugins/aw-plugin-development/skills/author-aw-plugin/scripts/prepare-aw-authoring-context.mjs',
    );
    await expect(fs.pathExists(pluginRoot)).resolves.toBe(false);
    const context = JSON.parse((await execFileAsync(process.execPath, [
      prepare,
      pluginRoot,
      '--mode', 'create',
      '--plugin', 'context-create',
      '--workspace-root', root,
      '--components', componentsPath,
    ], { cwd: os.tmpdir(), encoding: 'utf8' })).stdout);
    expect(context).toMatchObject({
      plugin: 'context-create',
      pluginRoot,
      changeMode: 'create',
    });
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

  it('reads and writes Catalog versions in a workspace with the reserved CLI import', async () => {
    const root = await createRoot();
    await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root, io: capture().io });
    await runCli([
      'plugin', 'init', 'reserved-import', '--description', 'Reserved import fixture.',
      '--no-skills', '--workspace-root', root,
    ], { cwd: root, io: capture().io });
    const pluginRoot = path.join(root, 'plugins', 'reserved-import');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.scripts = { node: { build: { runner: 'node', path: './build.mjs' } } };
    manifest.buildConfig = {
      cacheable: true,
      buildImports: [{
        plugin: '@aw/cli',
        export: 'skill-frontmatter-capabilities',
        env: 'AW_PLUGIN_IMPORT_FRONTMATTER',
      }],
    };
    await Promise.all([
      fs.writeJson(manifestPath, manifest, { spaces: 2 }),
      fs.writeFile(path.join(pluginRoot, 'build.mjs'), 'export {};\n'),
    ]);

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
    expect(output.stdout()).toContain('Publish only when explicitly requested: aw catalog publish');
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

  it('publishes immutable Git Catalog history without changing the source worktree', async () => {
    const root = await createRoot();
    const remote = await createRoot();
    await execFileAsync('git', ['init', '--bare', remote]);
    await execFileAsync('git', ['init'], { cwd: root });
    expect(await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root })).toBe(0);
    expect(await runCli([
      'plugin', 'init', 'published-demo', '--description', 'Published demo.', '--no-skills',
      '--workspace-root', root,
    ], { cwd: root })).toBe(0);
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial'], { cwd: root });
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    const sourceBranch = (await execFileAsync('git', ['branch', '--show-current'], { cwd: root })).stdout.trim();

    const firstOutput = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
      cwd: root,
      interactive: false,
      io: firstOutput.io,
    })).toBe(0);
    const first = JSON.parse(firstOutput.stdout()) as { commit: string };
    expect(firstOutput.stderr()).toBe('');
    expect((await execFileAsync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/catalog'])).stdout.trim())
      .toBe(first.commit);
    expect((await execFileAsync('git', ['--git-dir', remote, 'rev-parse', 'refs/tags/catalog-v0.1.0^{}'])).stdout.trim())
      .toBe(first.commit);

    const publishedRoot = await createRoot();
    await execFileAsync('git', [
      '--git-dir', remote,
      '--work-tree', publishedRoot,
      'checkout', '--quiet', first.commit, '--', '.',
    ]);
    const ledgerPath = path.join(publishedRoot, 'plugin-release-ledger.json');
    const ledger = await fs.readFile(ledgerPath);
    await fs.remove(ledgerPath);
    const missingLedgerOutput = capture();
    expect(await runCli(['catalog', 'validate', publishedRoot, '--json'], {
      cwd: root,
      io: missingLedgerOutput.io,
    })).toBe(1);
    expect(missingLedgerOutput.stderr()).toContain('must include plugin-release-ledger.json');
    await fs.writeFile(ledgerPath, ledger);

    expect(await runCli(['catalog', 'version', '0.2.0', '--workspace-root', root], { cwd: root, io: capture().io })).toBe(0);
    await execFileAsync('git', ['add', 'plugins/marketplace-source.json'], { cwd: root });
    await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'next'], { cwd: root });
    const cancelled = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root], {
      cwd: root,
      interactive: true,
      prompt: { confirm: async () => ({ cancelled: false, value: false }) },
      io: cancelled.io,
    })).toBe(0);
    expect(cancelled.stderr()).toContain('cancelled');
    expect((await execFileAsync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/catalog'])).stdout.trim())
      .toBe(first.commit);
    await expect(fs.pathExists(path.join(root, '.aw', 'publish', 'attempts', '0.1.0.json'))).resolves.toBe(true);
    await expect(fs.readJson(path.join(root, '.aw', 'publish', 'attempts', '0.1.0.json')))
      .resolves.toMatchObject({ catalogVersion: '0.1.0', state: 'published' });
    const secondOutput = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
      cwd: root,
      interactive: false,
      io: secondOutput.io,
    })).toBe(0);
    const second = JSON.parse(secondOutput.stdout()) as { commit: string };
    expect((await execFileAsync('git', ['--git-dir', remote, 'show', '-s', '--format=%P', second.commit])).stdout.trim())
      .toBe(first.commit);
    expect((await execFileAsync('git', ['branch', '--show-current'], { cwd: root })).stdout.trim()).toBe(sourceBranch);
    expect((await execFileAsync('git', ['status', '--porcelain=v1'], { cwd: root })).stdout).toBe('');

    const retry = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
      cwd: root,
      interactive: false,
      io: retry.io,
    })).toBe(1);
    expect(JSON.parse(retry.stdout())).toMatchObject({
      command: 'catalog:publish',
      ok: false,
      errors: [{ message: expect.stringContaining('version <higher>') }],
    });
  });

  it('requires explicit non-interactive publication confirmation with one JSON failure object', async () => {
    const root = await createRoot();
    const output = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--json'], {
      cwd: root,
      interactive: false,
      io: output.io,
    })).toBe(1);
    expect(JSON.parse(output.stdout())).toMatchObject({ command: 'catalog:publish', ok: false });
    expect(output.stdout().trim().split('\n').filter(Boolean).join('\n')).not.toBe('');
    expect(output.stderr()).toContain('requires --yes');
  });

  it('builds publication bytes only from sourceHead when ignored production files exist', async () => {
    const root = await createRoot();
    const remote = await createRoot();
    await execFileAsync('git', ['init', '--bare', remote]);
    await createPublishWorkspace(root, 'source-head-demo');
    const pluginRoot = path.join(root, 'plugins', 'source-head-demo');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.buildConfig = {
      fileRules: {
        codex: { include: ['nested/**'], exclude: [] },
        claude: { include: ['nested/**'], exclude: [] },
      },
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await fs.outputFile(path.join(pluginRoot, 'nested', 'committed.md'), 'committed production bytes\n');
    await fs.appendFile(path.join(root, '.gitignore'), '\nplugins/source-head-demo/nested/custom-secret.md\n');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'add committed production input',
    ], { cwd: root });
    const sourceHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    await fs.outputFile(path.join(pluginRoot, 'nested', '.aw', 'secret.md'), 'ignored nested secret\n');
    await fs.writeFile(path.join(pluginRoot, 'nested', 'custom-secret.md'), 'custom ignored secret\n');
    expect((await execFileAsync('git', [
      'status', '--porcelain=v1', '--untracked-files=all',
    ], { cwd: root })).stdout).toBe('');
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: root });

    const output = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
      cwd: root,
      interactive: false,
      io: output.io,
    })).toBe(0);
    const receipt = JSON.parse(output.stdout()) as { commit: string; sourceHead: string };
    expect(receipt.sourceHead).toBe(sourceHead);
    await expect(execFileAsync('git', [
      '--git-dir', remote,
      'grep', '-n', '-e', 'ignored nested secret', '-e', 'custom ignored secret', receipt.commit,
    ])).rejects.toBeDefined();
    await expect(fs.readFile(path.join(pluginRoot, 'nested', '.aw', 'secret.md'), 'utf8'))
      .resolves.toBe('ignored nested secret\n');
    await expect(fs.readFile(path.join(pluginRoot, 'nested', 'custom-secret.md'), 'utf8'))
      .resolves.toBe('custom ignored secret\n');
  });

  it('requires every sourceHead plugin to pass public validation before an attempt or remote write', async () => {
    const root = await createRoot();
    const remote = await createRoot();
    await execFileAsync('git', ['init', '--bare', remote]);
    await execFileAsync('git', ['init'], { cwd: root });
    await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root, io: capture().io });
    await runCli([
      'plugin', 'init', 'invalid-publish',
      '--description', 'Invalid publication fixture.',
      '--skill-description', 'Perform the publication fixture task.',
      '--workspace-root', root,
    ], { cwd: root, io: capture().io });
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'invalid plugin source',
    ], { cwd: root });
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: root });

    const invalidValidation = capture();
    expect(await runCli([
      'plugin', 'validate', path.join(root, 'plugins', 'invalid-publish'),
      '--workspace-root', root, '--json',
    ], { cwd: root, io: invalidValidation.io })).toBe(1);
    expect(invalidValidation.stdout()).toContain('TODO placeholders');
    const failed = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
      cwd: root,
      interactive: false,
      io: failed.io,
    })).toBe(1);
    expect(failed.stderr()).toContain('failed public source validation');
    await expect(fs.pathExists(path.join(root, '.aw', 'publish', 'attempts', '0.1.0.json'))).resolves.toBe(false);
    expect((await execFileAsync('git', ['ls-remote', remote])).stdout).toBe('');

    const skillPath = path.join(root, 'plugins', 'invalid-publish', 'skills', 'invalid-publish', 'SKILL.md');
    const skill = await fs.readFile(skillPath, 'utf8');
    await fs.writeFile(skillPath, skill.replace(/\[TODO:[^\]]+\]/gu, 'Complete the requested task and verify the result.'));
    await execFileAsync('git', ['add', skillPath], { cwd: root });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'fix plugin source',
    ], { cwd: root });
    const validValidation = capture();
    expect(await runCli([
      'plugin', 'validate', path.join(root, 'plugins', 'invalid-publish'),
      '--workspace-root', root, '--json',
    ], { cwd: root, io: validValidation.io })).toBe(0);
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
      cwd: root,
      interactive: false,
      io: capture().io,
    })).toBe(0);
  });

  it('retains an attempted marker after atomic push failure and recovers only after a version bump', async () => {
    const root = await createRoot();
    const remote = await createRoot();
    await execFileAsync('git', ['init', '--bare', remote]);
    await execFileAsync('git', ['init'], { cwd: root });
    await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root, io: capture().io });
    await runCli([
      'plugin', 'init', 'failure-demo', '--description', 'Failure demo.', '--no-skills',
      '--workspace-root', root,
    ], { cwd: root, io: capture().io });
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial'], { cwd: root });
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    const hook = path.join(remote, 'hooks', 'pre-receive');
    await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const failed = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
      cwd: root,
      interactive: false,
      io: failed.io,
    })).toBe(1);
    expect(JSON.parse(failed.stdout())).toMatchObject({
      ok: false,
      errors: [{ message: expect.stringContaining('result is uncertain') }],
    });
    await expect(fs.readJson(path.join(root, '.aw', 'publish', 'attempts', '0.1.0.json')))
      .resolves.toMatchObject({ state: 'attempted', catalogVersion: '0.1.0' });
    const retry = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
      cwd: root,
      interactive: false,
      io: retry.io,
    })).toBe(1);
    expect(JSON.parse(retry.stdout()).errors[0].message).toContain('version <higher>');

    await runCli(['catalog', 'version', '0.2.0', '--workspace-root', root], { cwd: root, io: capture().io });
    await execFileAsync('git', ['add', 'plugins/marketplace-source.json'], { cwd: root });
    await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'bump'], { cwd: root });
    await fs.remove(hook);
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
      cwd: root,
      interactive: false,
      io: capture().io,
    })).toBe(0);
  });

  it('uses the push endpoint for all publication history and the fetch endpoint for source guidance', async () => {
    const root = await createRoot();
    const fetchRemote = await createRoot();
    const pushRemote = await createRoot();
    await Promise.all([
      execFileAsync('git', ['init', '--bare', fetchRemote]),
      execFileAsync('git', ['init', '--bare', pushRemote]),
    ]);
    await createPublishWorkspace(root, 'split-remote-demo');
    await execFileAsync('git', ['remote', 'add', 'origin', fetchRemote], { cwd: root });
    await execFileAsync('git', ['remote', 'set-url', '--push', 'origin', pushRemote], { cwd: root });

    const output = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes'], {
      cwd: root,
      interactive: false,
      io: output.io,
    })).toBe(0);
    expect(output.stdout()).toContain(`--git ${fetchRemote} --ref refs/heads/catalog`);
    expect(output.stdout()).toContain(`to origin (${pushRemote})`);
    const pushedCommit = (await execFileAsync('git', [
      '--git-dir', pushRemote, 'rev-parse', 'refs/heads/catalog',
    ])).stdout.trim();
    expect((await execFileAsync('git', [
      '--git-dir', pushRemote, 'rev-parse', 'refs/tags/catalog-v0.1.0^{}',
    ])).stdout.trim()).toBe(pushedCommit);
    await expect(execFileAsync('git', [
      '--git-dir', fetchRemote, 'rev-parse', '--verify', 'refs/heads/catalog',
    ])).rejects.toBeDefined();
  });

  it('redacts fetch credentials, query, and fragment from confirmation, human, and JSON output', async () => {
    const secretTokens = ['user-secret', 'query-secret', 'fragment-secret'];
    for (const json of [false, true]) {
      const root = await createRoot();
      const pushRemote = await createRoot();
      await execFileAsync('git', ['init', '--bare', pushRemote]);
      await createPublishWorkspace(root, `redaction-demo-${json ? 'json' : 'human'}`);
      const unsafeFetch = 'https://author:user-secret@example.invalid/catalog.git?token=query-secret#fragment-secret';
      await execFileAsync('git', ['remote', 'add', 'origin', unsafeFetch], { cwd: root });
      await execFileAsync('git', ['remote', 'set-url', '--push', 'origin', pushRemote], { cwd: root });
      const output = capture();
      if (!json) {
        expect(await runCli(['catalog', 'publish', '--workspace-root', root], {
          cwd: root,
          interactive: true,
          prompt: { confirm: async () => ({ cancelled: false, value: true }) },
          io: output.io,
        })).toBe(0);
      } else {
        expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
          cwd: root,
          interactive: false,
          io: output.io,
        })).toBe(0);
        expect(JSON.parse(output.stdout())).toMatchObject({
          fetchUrl: 'https://example.invalid/catalog.git',
          pushUrl: pushRemote,
        });
      }
      for (const secret of secretTokens) {
        expect(output.stdout()).not.toContain(secret);
        expect(output.stderr()).not.toContain(secret);
      }
      if (!json) expect(output.stdout()).toContain('--git https://example.invalid/catalog.git');
    }
  });

  it('rejects a dirty ignored submodule before preparation or remote writes', async () => {
    const root = await createRoot();
    const submoduleSource = await createRoot();
    const remote = await createRoot();
    await execFileAsync('git', ['init', '--bare', remote]);
    await execFileAsync('git', ['init'], { cwd: submoduleSource });
    await fs.writeFile(path.join(submoduleSource, 'tracked.txt'), 'committed\n');
    await execFileAsync('git', ['add', '.'], { cwd: submoduleSource });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'submodule',
    ], { cwd: submoduleSource });
    await createPublishWorkspace(root, 'submodule-demo');
    await execFileAsync('git', [
      '-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleSource, 'vendor/dependency',
    ], { cwd: root });
    await execFileAsync('git', ['config', '-f', '.gitmodules', 'submodule.vendor/dependency.ignore', 'all'], { cwd: root });
    await execFileAsync('git', ['add', '.gitmodules', 'vendor/dependency'], { cwd: root });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'add ignored submodule',
    ], { cwd: root });
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    await fs.writeFile(path.join(root, 'vendor', 'dependency', 'tracked.txt'), 'uncommitted secret bytes\n');

    const output = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
      cwd: root,
      interactive: false,
      io: output.io,
    })).toBe(1);
    expect(output.stderr()).toContain('worktree to be clean');
    expect((await execFileAsync('git', ['ls-remote', remote])).stdout).toBe('');
    await expect(fs.pathExists(path.join(root, '.aw', 'publish', 'catalog-v0.1.0'))).resolves.toBe(false);
  });

  it('fails closed for a corrupt current attempt, recovers after bump, and keeps old versions blocked', async () => {
    const root = await createRoot();
    const remote = await createRoot();
    await execFileAsync('git', ['init', '--bare', remote]);
    await createPublishWorkspace(root, 'attempt-history-demo');
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    const oldAttempt = path.join(root, '.aw', 'publish', 'attempts', '0.1.0.json');
    await fs.outputFile(path.join(root, '.aw', 'publish', 'attempted.json'), '{ corrupt attempt');

    const corrupt = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
      cwd: root,
      interactive: false,
      io: corrupt.io,
    })).toBe(1);
    expect(corrupt.stderr()).toContain('version <higher>');
    expect((await execFileAsync('git', ['ls-remote', remote])).stdout).toBe('');
    await expect(fs.readFile(oldAttempt, 'utf8')).resolves.toBe('{ corrupt attempt');

    await runCli(['catalog', 'version', '0.2.0', '--workspace-root', root], { cwd: root, io: capture().io });
    await execFileAsync('git', ['add', 'plugins/marketplace-source.json'], { cwd: root });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'bump',
    ], { cwd: root });
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
      cwd: root,
      interactive: false,
      io: capture().io,
    })).toBe(0);
    await expect(fs.readFile(oldAttempt, 'utf8')).resolves.toBe('{ corrupt attempt');

    await runCli(['catalog', 'version', '0.1.0', '--workspace-root', root], { cwd: root, io: capture().io });
    await execFileAsync('git', ['add', 'plugins/marketplace-source.json'], { cwd: root });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'return old',
    ], { cwd: root });
    const oldRetry = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
      cwd: root,
      interactive: false,
      io: oldRetry.io,
    })).toBe(1);
    expect(oldRetry.stderr()).toContain('version <higher>');
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
