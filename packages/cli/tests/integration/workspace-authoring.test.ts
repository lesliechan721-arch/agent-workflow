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

function readResult(stdout: string, command: string) {
  const result = JSON.parse(stdout);
  expect(result).toMatchObject({
    schemaVersion: 1,
    command,
    data: expect.any(Object),
    diagnostics: expect.any(Array),
    nextActions: expect.any(Array),
  });
  expect(result).not.toHaveProperty('ok');
  expect(result).not.toHaveProperty('receiptSchemaVersion');
  return result;
}

describe('public Catalog Workspace authoring commands', () => {
  it.each(['valid', 'default-empty', 'wrong-type', 'unused-definition'] as const)(
    'validates renderer config references against the same Workspace dependency defaults (%s)',
    async (scenario) => {
      const root = await createRoot();
      await runCli(['dev', 'catalog', 'create', '--workspace-root', root], { cwd: root, io: capture().io });
      for (const name of ['config-consumer', 'config-provider']) {
        await runCli(['dev', 'plugin', 'create', name, '--description', 'Cross-plugin author config fixture.',
          '--no-skills', '--workspace-root', root], { cwd: root, io: capture().io });
      }
      const consumerRoot = path.join(root, 'plugins', 'config-consumer');
      const consumerPath = path.join(consumerRoot, '.agents-plugin', 'plugin.json');
      const consumer = await fs.readJson(consumerPath);
      consumer.dependencies = ['config-provider'];
      consumer.requires = { aw: { capabilities: ['aw.plugin-config-cross-plugin-value-ref.v1'] } };
      consumer.config = { schemaVersion: 4, fields: { selected: { type: 'string', default: 'external',
        valueRef: { plugin: 'config-provider', field: 'registry', key: 'key', include: ['native'] } } } };
      consumer.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
      consumer.artifacts = { configKeys: ['selected'] };
      await fs.writeJson(consumerPath, consumer);
      await fs.writeFile(path.join(consumerRoot, 'render.mjs'), [
        "import fs from 'node:fs';",
        "const c = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));",
        "if (Object.keys(c.config.values).join() !== 'selected') throw new Error('Provider config leaked');",
        "const requested = c.allowedOutputKinds.includes('instruction');",
        "const supported = c.platformCapabilities.kinds.instruction.status === 'supported';",
        "console.log(JSON.stringify({version:3,components:requested && supported ? [{id:'instruction',kind:'instruction',name:'instruction',content:{title:'Selected configuration',content:c.config.values.selected,coverage:['main']}}] : [],omitted:[],unmet:requested && !supported ? [{id:'instruction',kind:'instruction',requiredFeatures:[{feature:'component.kind.instruction'}],reasonCode:'capability-unverified'}] : []}));",
      ].join('\n'));
      const providerPath = path.join(root, 'plugins', 'config-provider', '.agents-plugin', 'plugin.json');
      const provider = await fs.readJson(providerPath);
      provider.config = { schemaVersion: 4, fields: { registry: { type: 'array', default: [{ key: 'external' }],
        validation: { uniqueBy: 'key' }, items: { type: 'object', properties: { key: { type: 'string', required: true } },
          additionalProperties: false } } } };
      if (scenario === 'default-empty') provider.config.fields.registry.default = [];
      if (scenario === 'wrong-type' || scenario === 'unused-definition') {
        provider.config.fields.registry = { type: 'string', default: 'external' };
      }
      if (scenario === 'unused-definition') {
        consumer.config = { schemaVersion: 4, definitions: { unused: { type: 'string',
          valueRef: { plugin: 'config-provider', field: 'registry', key: 'key' } } },
        fields: { selected: { type: 'string', default: 'native' } } };
        await fs.writeJson(consumerPath, consumer);
      }
      await fs.writeJson(providerPath, provider);
      const output = capture();
      const exitCode = await runCli(['dev', 'plugin', 'validate', consumerRoot, '--workspace-root', root, '--json'],
        { cwd: root, io: output.io });
      const result = { exitCode, receipt: readResult(output.stdout(), 'dev.plugin.validate') };
      expect(result).toMatchObject(scenario === 'valid'
        ? { exitCode: 0, receipt: { status: 'success', data: { profile: 'aw-source' } } }
        : { exitCode: 1, receipt: { status: 'failed', diagnostics: expect.arrayContaining([
            expect.objectContaining({ message: expect.stringContaining('config-provider/registry') }),
          ]) } });
    },
  );

  it('creates an absent canonical root through public plugin create', async () => {
    const root = await createRoot();
    await runCli(['dev', 'catalog', 'create', '--workspace-root', root], { cwd: root, io: capture().io });
    const pluginRoot = path.join(root, 'plugins', 'context-create');
    await expect(fs.pathExists(pluginRoot)).resolves.toBe(false);

    expect(await runCli([
      'dev', 'plugin', 'create', 'context-create', '--description', 'Context create fixture.',
      '--no-skills', '--workspace-root', root,
    ], { cwd: os.tmpdir(), io: capture().io })).toBe(0);
    await expect(fs.pathExists(path.join(pluginRoot, '.agents-plugin', 'plugin.json')))
      .resolves.toBe(true);
  });

  it('validates a canonical plugin with positional-first and options-first arguments', async () => {
    const root = await createRoot();
    await runCli(['dev', 'catalog', 'create', '--workspace-root', root], { cwd: root, io: capture().io });
    await runCli([
      'dev', 'plugin', 'create', 'argument-order', '--description', 'Argument order fixture.',
      '--no-skills', '--workspace-root', root,
    ], { cwd: root, io: capture().io });
    const pluginRoot = path.join(root, 'plugins', 'argument-order');

    const positionalFirst = capture();
    expect(await runCli([
      'dev', 'plugin', 'validate', pluginRoot, '--workspace-root', root,
      '--strict-agent-skills', '--json',
    ], { cwd: root, io: positionalFirst.io })).toBe(0);
    expect(readResult(positionalFirst.stdout(), 'dev.plugin.validate')).toMatchObject({ status: 'success' });

    const optionsFirst = capture();
    expect(await runCli([
      'dev', 'plugin', 'validate', '--json', '--workspace-root', root,
      '--strict-agent-skills', '--claude-skill-profile', 'minimum', pluginRoot,
    ], { cwd: root, io: optionsFirst.io })).toBe(0);
    expect(readResult(optionsFirst.stdout(), 'dev.plugin.validate')).toMatchObject({ status: 'success' });

    const unknown = capture();
    expect(await runCli([
      'dev', 'plugin', 'validate', '--json', '--unknown-option', pluginRoot,
      '--workspace-root', root,
    ], { cwd: root, io: unknown.io })).toBe(2);
    expect(readResult(unknown.stdout(), 'dev.plugin.validate')).toMatchObject({
      status: 'failed',
      data: {},
      diagnostics: [expect.objectContaining({ code: 'invalidArguments', message: expect.stringContaining('--unknown-option') })],
    });

    const nonCanonical = path.join(root, 'packages', 'argument-order');
    await fs.copy(pluginRoot, nonCanonical);
    const versionLikeOption = capture();
    expect(await runCli([
      'dev', 'plugin', 'validate', '--version-base', '-x', '--json',
      '--workspace-root', root, nonCanonical,
    ], { cwd: root, io: versionLikeOption.io })).toBe(1);
    expect(readResult(versionLikeOption.stdout(), 'dev.plugin.validate')).toMatchObject({
      status: 'failed',
      diagnostics: expect.arrayContaining([expect.objectContaining({
        message: expect.stringContaining(path.join(root, 'plugins', 'argument-order')),
      })]),
    });
  });

  it.each([
    ['plugin validate', ['dev', 'plugin', 'validate', 'plugins/source-link']],
    ['plugin test', ['dev', 'plugin', 'test', 'plugins/source-link']],
    ['plugin build', ['dev', 'plugin', 'build', 'plugins/source-link']],
    ['catalog build', ['dev', 'catalog', 'build']],
  ])('rejects an external authoring source symlink before %s reads it', async (_label, command) => {
    const root = await createRoot();
    await runCli(['dev', 'catalog', 'create', '--workspace-root', root], { cwd: root, io: capture().io });
    await runCli([
      'dev', 'plugin', 'create', 'source-link', '--description', 'Source symlink fence fixture.',
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
    await runCli(['dev', 'catalog', 'create', '--workspace-root', root], { cwd: root, io: capture().io });
    await runCli([
      'dev', 'plugin', 'create', 'ignored-inputs', '--description', 'Ignored authoring inputs fixture.',
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
      ['dev', 'plugin', 'validate', 'plugins/ignored-inputs'],
      ['dev', 'plugin', 'test', 'plugins/ignored-inputs'],
      ['dev', 'plugin', 'build', 'plugins/ignored-inputs'],
      ['dev', 'catalog', 'build'],
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
    await runCli(['dev', 'catalog', 'create', '--workspace-root', root], { cwd: root, io: capture().io });
    await runCli([
      'dev', 'plugin', 'create', 'ignored-source', '--description', 'Ignored source path fixture.',
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
      ['dev', 'plugin', 'validate', 'plugins/ignored-source'],
      ['dev', 'plugin', 'build', 'plugins/ignored-source'],
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
    expect(await runCli(['dev', 'catalog', 'create', '--workspace-root', root, '--json'], {
      cwd: root,
      io: initOutput.io,
    })).toBe(0);
    expect(readResult(initOutput.stdout(), 'dev.catalog.create')).toMatchObject({
      status: 'success',
      data: { catalogVersion: '0.1.0' },
    });
    expect(initOutput.stderr()).toBe('');

    const versionOutput = capture();
    expect(await runCli(['dev', 'catalog', 'version', '1.0.0-beta.1', '--workspace-root', root, '--json'], {
      cwd: root,
      io: versionOutput.io,
    })).toBe(0);
    expect(readResult(versionOutput.stdout(), 'dev.catalog.version')).toMatchObject({
      status: 'success',
      data: { catalogVersion: '1.0.0-beta.1' },
    });

    const bumpOutput = capture();
    expect(await runCli(['dev', 'catalog', 'version', '--bump', 'patch', '--workspace-root', root, '--json'], {
      cwd: root,
      io: bumpOutput.io,
    })).toBe(0);
    expect(readResult(bumpOutput.stdout(), 'dev.catalog.version')).toMatchObject({
      status: 'success',
      data: { catalogVersion: '1.0.1', changed: true },
    });

    const conflictingOutput = capture();
    expect(await runCli([
      'dev', 'catalog', 'version', '1.0.2', '--bump', 'minor', '--workspace-root', root, '--json',
    ], { cwd: root, io: conflictingOutput.io })).toBe(2);
    expect(readResult(conflictingOutput.stdout(), 'dev.catalog.version')).toMatchObject({
      status: 'failed', data: {},
      diagnostics: [expect.objectContaining({ code: 'invalidArguments', message: expect.stringContaining('not both') })],
    });

    const invalidBumpOutput = capture();
    expect(await runCli([
      'dev', 'catalog', 'version', '--bump', 'prerelease', '--workspace-root', root, '--json',
    ], { cwd: root, io: invalidBumpOutput.io })).toBe(2);
    expect(readResult(invalidBumpOutput.stdout(), 'dev.catalog.version')).toMatchObject({
      status: 'failed', data: {},
      diagnostics: [expect.objectContaining({ code: 'invalidArguments', message: expect.stringMatching(/(?=.*major)(?=.*minor)(?=.*patch)/u) })],
    });

    for (const version of ['1.0.0-rc.1', '1.0.0+build.1']) {
      const invalidOutput = capture();
      expect(await runCli(['dev', 'catalog', 'version', version, '--workspace-root', root, '--json'], {
        cwd: root,
        io: invalidOutput.io,
      })).toBe(2);
      expect(readResult(invalidOutput.stdout(), 'dev.catalog.version')).toMatchObject({
        status: 'failed', data: {},
        diagnostics: [expect.objectContaining({ code: 'invalidArguments', message: expect.stringMatching(/(?=.*stable)(?=.*x\.y\.z-beta\.N)/u) })],
      });
    }
  });

  it('reads and writes Catalog versions without a CLI capability build import', async () => {
    const root = await createRoot();
    await runCli(['dev', 'catalog', 'create', '--workspace-root', root], { cwd: root, io: capture().io });
    await runCli([
      'dev', 'plugin', 'create', 'reserved-import', '--description', 'Reserved import fixture.',
      '--no-skills', '--workspace-root', root,
    ], { cwd: root, io: capture().io });
    const readOutput = capture();
    expect(await runCli(['dev', 'catalog', 'version', '--workspace-root', root, '--json'], {
      cwd: root,
      io: readOutput.io,
    })).toBe(0);
    expect(readResult(readOutput.stdout(), 'dev.catalog.version')).toMatchObject({ status: 'success', data: { catalogVersion: '0.1.0' } });
    const writeOutput = capture();
    expect(await runCli(['dev', 'catalog', 'version', '0.2.0', '--workspace-root', root, '--json'], {
      cwd: root,
      io: writeOutput.io,
    })).toBe(0);
    expect(readResult(writeOutput.stdout(), 'dev.catalog.version')).toMatchObject({ status: 'success', data: { catalogVersion: '0.2.0' } });
  });

  it('prints only public authoring commands after third-party plugin create', async () => {
    const root = await createRoot();
    await runCli(['dev', 'catalog', 'create', '--workspace-root', root], { cwd: root, io: capture().io });
    const output = capture();
    expect(await runCli([
      'dev', 'plugin', 'create', 'next-steps', '--description', 'Next-step output fixture.',
      '--no-skills', '--workspace-root', root,
    ], { cwd: root, io: output.io })).toBe(0);

    expect(output.stdout()).toContain('aw dev plugin validate');
    expect(output.stdout()).toContain('aw dev plugin test');
    expect(output.stdout()).toContain('aw dev plugin build');
    expect(output.stdout()).toContain('aw dev catalog build');
    expect(output.stdout()).not.toContain('pnpm build');
    expect(output.stdout()).not.toContain('pnpm release');
  });

  it('rejects removed --repo-root and reports JSON failures safely', async () => {
    const root = await createRoot();
    const removed = capture();
    expect(await runCli(['dev', 'catalog', 'create', '--repo-root', root], { cwd: root, io: removed.io }))
      .toBe(2);
    expect(removed.stderr()).toMatch(/unknown option/iu);

    const removedJson = capture();
    expect(await runCli(['dev', 'catalog', 'create', '--repo-root', root, '--json'], {
      cwd: root,
      io: removedJson.io,
    })).toBe(2);
    expect(readResult(removedJson.stdout(), 'dev.catalog.create')).toMatchObject({
      status: 'failed', data: {},
      diagnostics: [expect.objectContaining({ code: 'invalidArguments' })],
    });

    const invalid = capture();
    expect(await runCli(['dev', 'catalog', 'version', 'not-semver', '--workspace-root', root, '--json'], {
      cwd: root,
      io: invalid.io,
    })).toBe(2);
    expect(readResult(invalid.stdout(), 'dev.catalog.version')).toMatchObject({
      status: 'failed', data: {}, diagnostics: [expect.objectContaining({ code: 'invalidArguments' })],
    });
  });

  it('reports current status without Git and requires Git only for an explicit base', async () => {
    const root = await createRoot();
    await runCli(['dev', 'catalog', 'create', '--workspace-root', root], { cwd: root, io: capture().io });
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
    expect(await runCli(['dev', 'plugin', 'status', 'demo', '--workspace-root', root, '--json'], {
      cwd: root,
      io: current.io,
    })).toBe(0);
    expect(readResult(current.stdout(), 'dev.plugin.status')).toMatchObject({
      status: 'success',
      data: { base: null, checks: [{ plugin: 'demo', status: 'current', currentVersion: '0.1.0' }] },
    });

    const diff = capture();
    expect(await runCli([
      'dev', 'plugin', 'status', 'demo', '--base', 'HEAD', '--workspace-root', root, '--json',
    ], { cwd: root, io: diff.io })).toBe(1);
    expect(readResult(diff.stdout(), 'dev.plugin.status')).toMatchObject({
      status: 'failed', diagnostics: expect.arrayContaining([expect.objectContaining({ message: expect.stringMatching(/Git|git/u) })]),
    });
  });

  it('completes the local author loop in a private non-Git package workspace', async () => {
    const root = await createRoot();
    await fs.writeJson(path.join(root, 'package.json'), { private: true });
    expect(await runCli(['dev', 'catalog', 'create', '--workspace-root', root], { cwd: root })).toBe(0);
    expect(await runCli([
      'dev', 'plugin', 'create', 'private-demo',
      '--description', 'Private workspace demo plugin.',
      '--no-skills',
      '--with-mcp',
      '--workspace-root', root,
    ], { cwd: root })).toBe(0);
    expect(await runCli([
      'dev', 'plugin', 'validate', 'plugins/private-demo', '--workspace-root', root, '--json',
    ], { cwd: root })).toBe(0);

    const testOutput = capture();
    expect(await runCli([
      'dev', 'plugin', 'test', 'plugins/private-demo', '--workspace-root', root, '--json',
    ], { cwd: root, io: testOutput.io })).toBe(0);
    expect(readResult(testOutput.stdout(), 'dev.plugin.test')).toMatchObject({ status: 'success', data: { exitCode: 0 } });

    expect(await runCli([
      'dev', 'plugin', 'build', 'plugins/private-demo', '--workspace-root', root,
    ], { cwd: root })).toBe(0);
    expect(await runCli(['dev', 'catalog', 'build', '--workspace-root', root], { cwd: root })).toBe(0);
    expect(await runCli([
      'dev', 'catalog', 'validate', path.join(root, '.aw', 'catalog'),
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
      'dev', 'catalog', 'publish', 'apply', '--expected-plan-digest', placeholderPlanDigest, '--json',
    ], {
      interactive: false,
      io: output.io,
    })).toBe(3);
    expect(readResult(output.stdout(), 'dev.catalog.publish.apply')).toMatchObject({
      status: 'blocked',
      data: { confirmation: { required: true, provided: false, effects: [expect.objectContaining({ code: 'publishRemote', impact: 'shared' })] } },
      diagnostics: [expect.objectContaining({ code: 'confirmationRequired' })],
    });
  });

  it('rejects a linked external plugin before build or test code executes', async () => {
    const root = await createRoot();
    const outside = await createRoot();
    const executed = path.join(outside, 'executed.txt');
    await runCli(['dev', 'catalog', 'create', '--workspace-root', root], { cwd: root });
    await fs.ensureDir(path.join(outside, '.agents-plugin'));
    await fs.writeJson(path.join(outside, '.agents-plugin', 'plugin.json'), {
      name: 'linked-plugin',
      version: '0.1.0',
      description: 'Linked plugin.',
      schemaVersion: 4,
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
        'dev', 'plugin', command, 'plugins/linked-plugin', '--workspace-root', root, '--json',
      ], { cwd: root, io: output.io })).toBe(1);
      expect(readResult(output.stdout(), `dev.plugin.${command}`)).toMatchObject({
        status: 'failed', diagnostics: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('symbolic link') })]),
      });
    }
    await expect(fs.pathExists(executed)).resolves.toBe(false);
  });
});
