import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupActiveCodexEvalRuntimeCapsules,
  CODEX_EVAL_CLI_ENTRY_ENV,
  CODEX_EVAL_CLI_NODE_ENV,
  createCodexEvalTemporaryRoot,
  createCodexEvalRuntimeCapsule,
  DEFAULT_CODEX_EVAL_MODEL,
  materializeCodexEvalRuntimeHome,
  redactCodexEvalValue,
  registerCodexEvalTemporaryRoot,
  resetCodexEvalSignalShutdownForTests,
  resolveCodexEvalRuntimeConfig,
} from '../../scripts/codex-eval-runtime-config.js';

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-eval-config-test-'));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((root) => fs.remove(root)));
});

describe('Codex eval runtime config', () => {
  it('filters the selected provider and keeps embedded credentials ephemeral', async () => {
    const root = await tempRoot();
    const codexHome = path.join(root, 'codex-home');
    await fs.ensureDir(codexHome);
    await fs.writeFile(path.join(codexHome, 'auth.json'), '{"token":"official"}\n', 'utf8');
    await fs.writeFile(path.join(codexHome, 'config.toml'), [
      'model = "inherited-model"',
      'model_provider = "custom"',
      'model_reasoning_effort = "high"',
      'cli_auth_credentials_store = "keyring"',
      'mcp_oauth_credentials_store = "keyring"',
      'features.secret_auth_storage = true',
      '',
      '[model_providers.custom]',
      'name = "Custom"',
      'base_url = "https://example.invalid/v1"',
      'wire_api = "responses"',
      'requires_openai_auth = true',
      'experimental_bearer_token = "fixture-secret"',
      '',
      '[model_providers.unused]',
      'name = "Unused"',
      'base_url = "https://unused.invalid/v1"',
      'wire_api = "responses"',
      '',
      '[plugins."fixture@local"]',
      'enabled = true',
      '',
      '[mcp_servers.fixture]',
      'command = "fixture"',
    ].join('\n'), 'utf8');

    const runtime = await resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: codexHome },
      inheritUserConfig: true,
    });

    expect(runtime).toMatchObject({
      inherited: true,
      model: DEFAULT_CODEX_EVAL_MODEL,
      modelProvider: 'custom',
      credentialSource: 'embedded',
      copyOpenAiAuth: false,
      providerEnvironment: {},
    });
    expect(runtime.configToml).toContain('[model_providers.custom]');
    expect(runtime.configToml).toContain(`model = "${DEFAULT_CODEX_EVAL_MODEL}"`);
    expect(runtime.configToml).not.toContain('model = "inherited-model"');
    expect(runtime.configToml).toContain('model_reasoning_effort = "high"');
    expect(runtime.configToml).not.toContain('model_providers.unused');
    expect(runtime.configToml).not.toContain('[plugins.');
    expect(runtime.configToml).not.toContain('[mcp_servers.');
    expect(runtime.configToml).not.toContain('"keyring"');
    expect(runtime.configToml).toContain('cli_auth_credentials_store = "file"');
    expect(runtime.configToml).toContain('mcp_oauth_credentials_store = "file"');
    expect(runtime.configToml).toContain('features.secret_auth_storage = false');
    expect(runtime.configToml.indexOf('features.secret_auth_storage = false')).toBeLessThan(
      runtime.configToml.indexOf('[model_providers.custom]'),
    );

    const destination = path.join(root, 'isolated-home');
    await materializeCodexEvalRuntimeHome(runtime, destination);
    await expect(fs.pathExists(path.join(destination, 'config.toml'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(destination, 'auth.json'))).resolves.toBe(false);
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.join(destination, 'config.toml'))).mode & 0o777).toBe(0o600);
    }
  });

  it('uses the eval default model with provider settings from the active profile', async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, 'config.toml'), [
      'profile = "work"',
      'model = "default-model"',
      'model_provider = "default-provider"',
      'model_reasoning_summary = "concise"',
      '',
      '[profiles.work]',
      'model = "work-model"',
      'model_provider = "work-provider"',
      'model_reasoning_effort = "high"',
      '',
      '[model_providers.default-provider]',
      'name = "Default Provider"',
      '',
      '[model_providers.work-provider]',
      'name = "Work Provider"',
      'env_key = "WORK_API_KEY"',
    ].join('\n'), 'utf8');

    const runtime = await resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: root, WORK_API_KEY: 'work-key' },
      inheritUserConfig: true,
    });

    expect(runtime).toMatchObject({
      model: DEFAULT_CODEX_EVAL_MODEL,
      modelProvider: 'work-provider',
      credentialSource: 'environment',
      providerEnvironment: { WORK_API_KEY: 'work-key' },
    });
    expect(runtime.configToml).toContain(`model = "${DEFAULT_CODEX_EVAL_MODEL}"`);
    expect(runtime.configToml).not.toContain('model = "work-model"');
    expect(runtime.configToml).toContain('model_reasoning_effort = "high"');
    expect(runtime.configToml).toContain('model_reasoning_summary = "concise"');
    expect(runtime.configToml).toContain('[model_providers.work-provider]');
    expect(runtime.configToml).not.toContain('profile = "work"');
    expect(runtime.configToml).not.toContain('[profiles.work]');
    expect(runtime.configToml).not.toContain('[model_providers.default-provider]');

    const overridden = await resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: root },
      inheritUserConfig: true,
      modelOverride: 'override-model',
      modelProviderOverride: 'default-provider',
    });
    expect(overridden).toMatchObject({
      model: 'override-model',
      modelProvider: 'default-provider',
    });
    expect(overridden.configToml).toContain('model = "override-model"');
    expect(overridden.configToml).toContain('[model_providers.default-provider]');
    expect(overridden.configToml).not.toContain('[model_providers.work-provider]');
  });

  it('passes only provider-declared environment variables and fails when one is missing', async () => {
    const root = await tempRoot();
    const configPath = path.join(root, 'config.toml');
    await fs.writeFile(configPath, [
      'model_provider = "env-provider"',
      '',
      '[model_providers.env-provider]',
      'name = "Environment Provider"',
      'base_url = "https://example.invalid/v1"',
      'wire_api = "responses"',
      'env_key = "EVAL_API_KEY"',
      'env_http_headers = { X-Tenant = "EVAL_TENANT" }',
    ].join('\n'), 'utf8');

    const runtime = await resolveCodexEvalRuntimeConfig({
      sourceEnv: {
        CODEX_HOME: root,
        EVAL_API_KEY: 'key-value',
        EVAL_TENANT: 'tenant-value',
        UNRELATED_SECRET: 'do-not-pass',
      },
      inheritUserConfig: true,
    });
    expect(runtime.credentialSource).toBe('environment');
    expect(runtime.providerEnvironment).toEqual({
      EVAL_API_KEY: 'key-value',
      EVAL_TENANT: 'tenant-value',
    });

    await expect(resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: root, EVAL_API_KEY: 'key-value' },
      inheritUserConfig: true,
    })).rejects.toThrow('requires environment variable EVAL_TENANT');
  });

  it('rejects provider variables that could override the isolated process environment', async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, 'config.toml'), [
      'model_provider = "unsafe"',
      '[model_providers.unsafe]',
      'name = "Unsafe"',
      'env_key = "CODEX_HOME"',
    ].join('\n'), 'utf8');

    await expect(resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: root },
      inheritUserConfig: true,
    })).rejects.toThrow('cannot use reserved environment variable CODEX_HOME');
  });

  it('gives command harnesses only allowlisted and provider-declared environment variables', async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, 'config.toml'), [
      'model_provider = "custom"',
      '[model_providers.custom]',
      'name = "Custom"',
      'env_key = "CUSTOM_TOKEN"',
    ].join('\n'), 'utf8');
    const sourceEnv = {
      CODEX_HOME: root,
      PATH: process.env.PATH,
      CUSTOM_TOKEN: 'custom-token',
      OPENAI_API_KEY: 'official-key',
      UNRELATED_SECRET: 'unrelated-secret',
    };
    const runtime = await resolveCodexEvalRuntimeConfig({
      sourceEnv,
      inheritUserConfig: true,
    });
    const capsule = await createCodexEvalRuntimeCapsule(runtime, sourceEnv);
    const capsuleRoot = path.dirname(capsule.home);

    expect(capsule.env.CODEX_HOME).toBe(capsule.home);
    expect(capsule.env.CUSTOM_TOKEN).toBe('custom-token');
    expect(capsule.env.OPENAI_API_KEY).toBeUndefined();
    expect(capsule.env.UNRELATED_SECRET).toBeUndefined();
    expect(capsule.env.AW_CODEX_EVAL_SENSITIVE_ENV_NAMES).toBe('["CUSTOM_TOKEN"]');

    await cleanupActiveCodexEvalRuntimeCapsules();
    await expect(fs.pathExists(capsuleRoot)).resolves.toBe(false);
    await expect(capsule.cleanup()).resolves.toBeUndefined();
  });

  it('puts a run-owned current CLI launcher before an old host aw and removes it', async () => {
    const root = await tempRoot();
    const oldBin = path.join(root, 'old-bin');
    const oldMarker = path.join(root, 'old-aw-ran');
    const currentPackage = path.join(root, 'current-cli');
    const currentEntry = path.join(currentPackage, 'dist', 'index.js');
    await fs.outputJson(path.join(currentPackage, 'package.json'), {
      name: '@fixture/aw',
      version: '0.1.0',
    });
    await fs.ensureDir(oldBin);
    await fs.ensureDir(path.dirname(currentEntry));
    if (process.platform === 'win32') {
      await fs.writeFile(
        path.join(oldBin, 'aw.cmd'),
        `@echo old>"${oldMarker}"\r\n@exit /b 19\r\n`,
        'utf8',
      );
    } else {
      await fs.writeFile(
        path.join(oldBin, 'aw'),
        `#!/bin/sh\nprintf old > ${JSON.stringify(oldMarker)}\nexit 19\n`,
        { encoding: 'utf8', mode: 0o700 },
      );
    }
    await fs.writeFile(currentEntry, [
      '#!/usr/bin/env node',
      "if (process.argv[2] === '--version') process.stdout.write('aw-current 0.1.0\\n');",
      "else if (process.argv.slice(2).join(' ') === 'plugin validate --help') process.stdout.write('Usage: aw plugin validate\\n');",
      "else if (process.argv[2] === '--exit') process.exit(Number(process.argv[3]));",
      "else if (process.argv[2] === '--signal') process.kill(process.pid, 'SIGTERM');",
      'else process.exit(18);',
    ].join('\n'), { encoding: 'utf8', mode: 0o700 });
    await fs.outputFile(path.join(currentPackage, 'dist', 'index.js.map'), '{}');
    await fs.outputFile(path.join(currentPackage, 'dist', 'src', 'source.d.ts'), 'export {};\n');
    await fs.outputFile(path.join(currentPackage, 'plugins', 'host-source', 'SKILL.md'), '# no\n');
    await fs.outputFile(path.join(currentPackage, '.git', 'config'), 'no\n');
    await fs.outputFile(
      path.join(currentPackage, 'node_modules', 'fixture', 'index.js'),
      'export const fixture = true;\n',
    );
    for (const binRoot of [
      path.join(currentPackage, 'node_modules', '.bin'),
      path.join(
        currentPackage,
        'node_modules',
        '.pnpm',
        'fixture@1.0.0',
        'node_modules',
        '.bin',
      ),
    ]) {
      await fs.outputFile(
        path.join(binRoot, 'host-tool'),
        `#!/bin/sh\nexec ${JSON.stringify(currentEntry)} "$@"\n`,
      );
      await fs.outputFile(
        path.join(binRoot, 'host-tool.cmd'),
        `@node "${currentEntry}" %*\r\n`,
      );
      await fs.outputFile(
        path.join(binRoot, 'host-tool.ps1'),
        `& node "${currentEntry}" $args\r\n`,
      );
    }
    await fs.symlink(
      'fixture',
      path.join(currentPackage, 'node_modules', 'fixture-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const runtime = await resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: root },
      inheritUserConfig: false,
    });
    const capsule = await createCodexEvalRuntimeCapsule(runtime, {
      CODEX_HOME: root,
      PATH: [oldBin, process.env.PATH].filter(Boolean).join(path.delimiter),
    }, {
      cliPackageRoot: currentPackage,
      deployCli: (target) => fs.copy(currentPackage, target, { dereference: false }),
    });
    const capsuleRoot = path.dirname(capsule.home);
    const deployedPackage = path.join(capsuleRoot, 'cli');
    const deployedEntry = path.join(deployedPackage, 'dist', 'index.js');
    const launcher = path.join(capsuleRoot, 'bin', process.platform === 'win32' ? 'aw.cmd' : 'aw');

    expect((await execFileAsync('aw', ['--version'], { env: capsule.env })).stdout)
      .toBe('aw-current 0.1.0\n');
    expect((await execFileAsync('aw', ['plugin', 'validate', '--help'], { env: capsule.env })).stdout)
      .toBe('Usage: aw plugin validate\n');
    await expect(execFileAsync('aw', ['--exit', '7'], { env: capsule.env }))
      .rejects.toMatchObject({ code: 7 });
    if (process.platform !== 'win32') {
      await expect(execFileAsync('aw', ['--signal'], { env: capsule.env }))
        .rejects.toMatchObject({ signal: 'SIGTERM' });
    }
    await expect(fs.pathExists(oldMarker)).resolves.toBe(false);
    expect(capsule.env[CODEX_EVAL_CLI_ENTRY_ENV]).toBe(deployedEntry);
    expect(capsule.env[CODEX_EVAL_CLI_NODE_ENV]).toBe(process.execPath);
    expect(capsule.cli).toMatchObject({
      packageName: '@fixture/aw',
      packageVersion: '0.1.0',
      contentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(await fs.readFile(launcher, 'utf8')).not.toContain(currentPackage);
    expect(await fs.realpath(deployedEntry)).not.toContain(currentPackage);
    expect(await fs.realpath(path.join(deployedPackage, 'node_modules', 'fixture-link')))
      .toBe(await fs.realpath(path.join(deployedPackage, 'node_modules', 'fixture')));
    await expect(fs.pathExists(path.join(deployedPackage, 'plugins'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(deployedPackage, '.git'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(deployedPackage, 'dist', 'src', 'source.d.ts')))
      .resolves.toBe(false);
    await expect(fs.pathExists(path.join(deployedPackage, 'dist', 'index.js.map')))
      .resolves.toBe(false);
    const remainingBinDirectories: string[] = [];
    async function findBinDirectories(current: string, insideNodeModules = false): Promise<void> {
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const target = path.join(current, entry.name);
        if (insideNodeModules && entry.name === '.bin') {
          remainingBinDirectories.push(target);
        } else {
          await findBinDirectories(target, insideNodeModules || entry.name === 'node_modules');
        }
      }
    }
    await findBinDirectories(deployedPackage);
    expect(remainingBinDirectories).toEqual([]);
    if (process.platform !== 'win32') {
      expect((await fs.stat(launcher)).mode & 0o777).toBe(0o700);
    }
    expect(redactCodexEvalValue(
      `${deployedEntry} ${capsuleRoot}`,
      capsule.runtime,
    )).not.toContain(root);

    const matchingCapsule = await createCodexEvalRuntimeCapsule(runtime, {
      CODEX_HOME: root,
      PATH: process.env.PATH,
    }, {
      cliPackageRoot: currentPackage,
      deployCli: (target) => fs.copy(currentPackage, target, { dereference: false }),
    });
    expect(matchingCapsule.cli).toEqual(capsule.cli);
    await fs.writeFile(
      path.join(currentPackage, 'node_modules', 'fixture', 'index.js'),
      'export const fixture = false;\n',
    );
    const changedCapsule = await createCodexEvalRuntimeCapsule(runtime, {
      CODEX_HOME: root,
      PATH: process.env.PATH,
    }, {
      cliPackageRoot: currentPackage,
      deployCli: (target) => fs.copy(currentPackage, target, { dereference: false }),
    });
    expect(changedCapsule.cli?.contentDigest).not.toBe(capsule.cli?.contentDigest);

    await Promise.all([capsule.cleanup(), matchingCapsule.cleanup(), changedCapsule.cleanup()]);
    await expect(fs.pathExists(launcher)).resolves.toBe(false);
    await expect(fs.pathExists(capsuleRoot)).resolves.toBe(false);
  });

  it('rejects a deployed CLI dependency link that escapes the capsule', async () => {
    const root = await tempRoot();
    const sourcePackage = path.join(root, 'source-cli');
    const externalDependency = path.join(root, 'external-dependency');
    await fs.outputFile(path.join(sourcePackage, 'dist', 'index.js'), 'export {};\n');
    await fs.outputJson(path.join(sourcePackage, 'package.json'), {
      name: '@fixture/aw',
      version: '0.1.0',
    });
    await fs.outputFile(path.join(externalDependency, 'index.js'), 'export {};\n');
    const runtime = await resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: root },
      inheritUserConfig: false,
    });

    await expect(createCodexEvalRuntimeCapsule(runtime, { CODEX_HOME: root }, {
      cliPackageRoot: sourcePackage,
      deployCli: async (target) => {
        await fs.copy(sourcePackage, target);
        await fs.ensureDir(path.join(target, 'node_modules'));
        await fs.symlink(
          externalDependency,
          path.join(target, 'node_modules', 'external'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      },
    })).rejects.toThrow('contains escaping symlink');
  });

  it('supports explicit provider/model overrides and clean official fallback', async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, 'config.toml'), [
      'model = "source-model"',
      'model_provider = "first"',
      '',
      '[model_providers.first]',
      'name = "First"',
      'wire_api = "responses"',
      '',
      '[model_providers.second]',
      'name = "Second"',
      'wire_api = "responses"',
    ].join('\n'), 'utf8');
    const runtime = await resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: root },
      inheritUserConfig: true,
      modelOverride: 'override-model',
      modelProviderOverride: 'second',
    });
    expect(runtime).toMatchObject({ model: 'override-model', modelProvider: 'second' });
    expect(runtime.configToml).toContain('model = "override-model"');
    expect(runtime.configToml).toContain('[model_providers.second]');
    expect(runtime.configToml).not.toContain('[model_providers.first]');

    const clean = await resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: root },
      inheritUserConfig: false,
      modelOverride: 'clean-model',
    });
    expect(clean).toMatchObject({
      inherited: false,
      model: 'clean-model',
      modelProvider: 'openai',
      credentialSource: 'openai-auth',
    });
    expect(clean.configToml).toContain('cli_auth_credentials_store = "file"');
    expect(clean.configToml).toContain('mcp_oauth_credentials_store = "file"');
    expect(clean.configToml).toContain('features.secret_auth_storage = false');
  });

  it('always materializes the default model and file-only credential config', async () => {
    const root = await tempRoot();
    const runtime = await resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: root },
      inheritUserConfig: false,
    });
    const destination = path.join(root, 'runtime-no-model');

    await materializeCodexEvalRuntimeHome(runtime, destination);

    const config = await fs.readFile(path.join(destination, 'config.toml'), 'utf8');
    expect(runtime.model).toBe(DEFAULT_CODEX_EVAL_MODEL);
    expect(config).toContain(`model = "${DEFAULT_CODEX_EVAL_MODEL}"`);
    expect(config).toContain('cli_auth_credentials_store = "file"');
    expect(config).toContain('mcp_oauth_credentials_store = "file"');
    expect(config).toContain('features.secret_auth_storage = false');
  });

  it('trusts only the temporary project requested by the eval run', async () => {
    const root = await tempRoot();
    const workspace = path.join(root, 'project');
    const destination = path.join(root, 'runtime-trusted-project');
    await fs.ensureDir(workspace);
    const runtime = await resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: root },
      inheritUserConfig: false,
    });

    await materializeCodexEvalRuntimeHome(runtime, destination, {
      trustedProject: workspace,
    });

    const canonicalWorkspace = await fs.realpath(workspace);
    const config = await fs.readFile(path.join(destination, 'config.toml'), 'utf8');
    expect(config).toContain(`[projects.${JSON.stringify(canonicalWorkspace)}]`);
    expect(config).toContain('trust_level = "trusted"');
  });

  it('never copies official auth for a non-official provider', async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, 'config.toml'), [
      'model = "custom-model"',
      'model_provider = "custom"',
      '',
      '[model_providers.custom]',
      'name = "Custom"',
      'base_url = "https://custom.invalid/v1"',
      'requires_openai_auth = true',
    ].join('\n'), 'utf8');
    await fs.writeJson(path.join(root, 'auth.json'), { token: 'official-token' });

    const runtime = await resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: root },
      inheritUserConfig: true,
    });
    const destination = path.join(root, 'runtime');
    await materializeCodexEvalRuntimeHome(runtime, destination);

    expect(runtime).toMatchObject({
      modelProvider: 'custom',
      credentialSource: 'none',
      copyOpenAiAuth: false,
    });
    await expect(fs.pathExists(path.join(destination, 'auth.json'))).resolves.toBe(false);
  });

  it('treats an explicitly defined openai provider as custom for credential isolation', async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, 'config.toml'), [
      'model_provider = "openai"',
      '[model_providers.openai]',
      'name = "Custom OpenAI Alias"',
      'base_url = "https://attacker.invalid/v1"',
    ].join('\n'), 'utf8');
    await fs.writeJson(path.join(root, 'auth.json'), { token: 'official-token' });
    const runtime = await resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: root, OPENAI_API_KEY: 'official-key' },
      inheritUserConfig: true,
    });
    const capsule = await createCodexEvalRuntimeCapsule(runtime, {
      CODEX_HOME: root,
      OPENAI_API_KEY: 'official-key',
    });

    expect(runtime).toMatchObject({
      modelProvider: 'openai',
      credentialSource: 'none',
      providerEnvironment: {},
      copyOpenAiAuth: false,
    });
    expect(capsule.env.OPENAI_API_KEY).toBeUndefined();
    await expect(fs.pathExists(path.join(capsule.home, 'auth.json'))).resolves.toBe(false);
    await capsule.cleanup();
  });

  it('removes the runtime capsule and never exposes provider secrets in evidence', async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, 'config.toml'), [
      'model_provider = "custom"',
      '[model_providers.custom]',
      'name = "Custom"',
      'wire_api = "responses"',
      'experimental_bearer_token = "fixture-secret"',
    ].join('\n'), 'utf8');
    const runtime = await resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: root },
      inheritUserConfig: true,
    });
    expect(JSON.stringify({
      model: runtime.model,
      provider: runtime.modelProvider,
      credential: runtime.credentialSource,
      digest: runtime.evidenceDigest,
    })).not.toContain('fixture-secret');

    const capsule = await createCodexEvalRuntimeCapsule(runtime, { CODEX_HOME: root });
    const capsuleRoot = path.dirname(capsule.home);
    await expect(fs.pathExists(path.join(capsule.home, 'config.toml'))).resolves.toBe(true);
    await capsule.cleanup();
    await expect(fs.pathExists(capsuleRoot)).resolves.toBe(false);
  });

  it('retries capsule cleanup after a temporary root removal failure', async () => {
    const root = await tempRoot();
    const runtime = await resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: root },
      inheritUserConfig: false,
    });
    const capsule = await createCodexEvalRuntimeCapsule(runtime, { CODEX_HOME: root });
    const capsuleRoot = path.dirname(capsule.home);
    const removeSpy = vi.spyOn(fs, 'remove');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      removeSpy.mockRejectedValueOnce(new Error('temporary lock'));
    }

    try {
      await expect(capsule.cleanup()).rejects.toThrow(
        'Could not remove Codex eval temporary root after 4 attempts',
      );
      await expect(fs.pathExists(capsuleRoot)).resolves.toBe(true);
      await expect(capsule.cleanup()).resolves.toBeUndefined();
      await expect(fs.pathExists(capsuleRoot)).resolves.toBe(false);
    } finally {
      removeSpy.mockRestore();
    }
  });

  it('redacts provider endpoint, header, environment, and official auth values', async () => {
    const customRoot = await tempRoot();
    await fs.writeFile(path.join(customRoot, 'config.toml'), [
      'model_provider = "custom"',
      '[model_providers.custom]',
      'name = "Custom"',
      'base_url = "https://private.invalid/v1"',
      'env_key = "CUSTOM_TOKEN"',
      'http_headers = { X-Static = "static-header" }',
    ].join('\n'), 'utf8');
    const custom = await resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: customRoot, CUSTOM_TOKEN: 'environment-token' },
      inheritUserConfig: true,
    });
    const redacted = redactCodexEvalValue({
      stderr: 'https://private.invalid/v1 static-header environment-token',
    }, custom);
    expect(redacted.stderr).toBe('[redacted] [redacted] [redacted]');

    const officialRoot = await tempRoot();
    await fs.writeJson(path.join(officialRoot, 'auth.json'), {
      tokens: { access_token: 'official-access-token', refresh_token: 'official-refresh-token' },
    });
    const official = await resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: officialRoot },
      inheritUserConfig: false,
    });
    await materializeCodexEvalRuntimeHome(official, path.join(officialRoot, 'runtime'));
    expect(redactCodexEvalValue(
      'official-access-token official-refresh-token',
      official,
    )).toBe('[redacted] [redacted]');

    const overlapRoot = await tempRoot();
    await fs.writeFile(path.join(overlapRoot, 'config.toml'), [
      'model_provider = "overlap"',
      '[model_providers.overlap]',
      'name = "Overlap"',
      'base_url = "prefix-secret"',
      'experimental_bearer_token = "prefix-secret-sensitive-suffix"',
      'env_key = "OVERLAP_TOKEN"',
    ].join('\n'), 'utf8');
    const overlap = await resolveCodexEvalRuntimeConfig({
      sourceEnv: {
        CODEX_HOME: overlapRoot,
        OVERLAP_TOKEN: 'proxy-user',
        HTTPS_PROXY: 'http://proxy-user-sensitive-suffix@proxy.invalid',
      },
      inheritUserConfig: true,
    });
    expect(redactCodexEvalValue(
      'prefix-secret-sensitive-suffix http://proxy-user-sensitive-suffix@proxy.invalid',
      overlap,
    )).toBe('[redacted] [redacted]');
  });

  it('registers per-run credential roots for signal cleanup', async () => {
    const root = await tempRoot();
    const runRoot = path.join(root, 'per-run');
    await fs.ensureDir(path.join(runRoot, 'codex-home'));
    await fs.writeFile(path.join(runRoot, 'codex-home', 'config.toml'), 'secret');
    const unregister = registerCodexEvalTemporaryRoot(runRoot);

    await cleanupActiveCodexEvalRuntimeCapsules();
    await expect(fs.pathExists(runRoot)).resolves.toBe(false);
    unregister();
  });

  it('tracks an in-flight temporary-root allocation across signal cleanup', async () => {
    const root = await tempRoot();
    const runRoot = path.join(root, 'in-flight');
    let resolveAllocation: ((value: string) => void) | undefined;
    const allocation = new Promise<string>((resolve) => {
      resolveAllocation = resolve;
    });
    const baselineHandlers = new Set(process.listeners('SIGTERM'));
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === process.pid) return true;
      return originalKill(pid, signal);
    });

    try {
      const temporaryRoot = createCodexEvalTemporaryRoot('unused-', {
        allocate: () => allocation,
      });
      await vi.waitFor(() => {
        expect(process.listeners('SIGTERM').some((handler) => !baselineHandlers.has(handler)))
          .toBe(true);
      });
      const signalHandler = process.listeners('SIGTERM')
        .find((handler) => !baselineHandlers.has(handler));
      expect(signalHandler).toBeDefined();
      signalHandler!();
      await fs.ensureDir(runRoot);
      resolveAllocation!(runRoot);

      await expect(temporaryRoot).rejects.toThrow('signal shutdown is in progress');
      await vi.waitFor(() => {
        expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
      });
      await expect(fs.pathExists(runRoot)).resolves.toBe(false);
    } finally {
      resetCodexEvalSignalShutdownForTests();
      killSpy.mockRestore();
    }
  });
});
