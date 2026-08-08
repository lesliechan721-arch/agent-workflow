import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupActiveCodexEvalRuntimeCapsules,
  createCodexEvalTemporaryRoot,
  createCodexEvalRuntimeCapsule,
  materializeCodexEvalRuntimeHome,
  redactCodexEvalValue,
  registerCodexEvalTemporaryRoot,
  resetCodexEvalSignalShutdownForTests,
  resolveCodexEvalRuntimeConfig,
} from '../../scripts/codex-eval-runtime-config.js';

const tempDirs: string[] = [];

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
      model: 'inherited-model',
      modelProvider: 'custom',
      credentialSource: 'embedded',
      copyOpenAiAuth: false,
      providerEnvironment: {},
    });
    expect(runtime.configToml).toContain('[model_providers.custom]');
    expect(runtime.configToml).toContain('model_reasoning_effort = "high"');
    expect(runtime.configToml).not.toContain('model_providers.unused');
    expect(runtime.configToml).not.toContain('[plugins.');
    expect(runtime.configToml).not.toContain('[mcp_servers.');

    const destination = path.join(root, 'isolated-home');
    await materializeCodexEvalRuntimeHome(runtime, destination);
    await expect(fs.pathExists(path.join(destination, 'config.toml'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(destination, 'auth.json'))).resolves.toBe(false);
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.join(destination, 'config.toml'))).mode & 0o777).toBe(0o600);
    }
  });

  it('inherits model settings from the active profile', async () => {
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
      model: 'work-model',
      modelProvider: 'work-provider',
      credentialSource: 'environment',
      providerEnvironment: { WORK_API_KEY: 'work-key' },
    });
    expect(runtime.configToml).toContain('model = "work-model"');
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
