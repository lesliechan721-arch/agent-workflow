import os from 'node:os'
import path from 'node:path'

import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_CODEX_EVAL_MODEL,
  materializeCodexEvalRuntimeHome,
  redactCodexEvalValue,
  resolveCodexEvalRuntimeConfig,
} from '../../dist/index.js'

const tempDirs: string[] = []

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-provider-config-'))
  tempDirs.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((root) => fs.remove(root)))
})

describe('Codex eval provider runtime config', () => {
  it('keeps only the selected provider and file credential stores', async () => {
    const root = await tempRoot()
    await fs.writeFile(path.join(root, 'config.toml'), [
      'model = "inherited-model"',
      'model_provider = "custom"',
      'cli_auth_credentials_store = "keyring"',
      'features.secret_auth_storage = true',
      '[model_providers.custom]',
      'name = "Custom"',
      'experimental_bearer_token = "fixture-secret"',
      '[model_providers.unused]',
      'name = "Unused"',
      '[mcp_servers.fixture]',
      'command = "fixture"',
    ].join('\n'))

    const runtime = await resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: root },
      inheritUserConfig: true,
    })

    expect(runtime).toMatchObject({
      model: DEFAULT_CODEX_EVAL_MODEL,
      modelProvider: 'custom',
      credentialSource: 'embedded',
      copyOpenAiAuth: false,
    })
    expect(runtime.configToml).toContain('cli_auth_credentials_store = "file"')
    expect(runtime.configToml).toContain('features.secret_auth_storage = false')
    expect(runtime.configToml).not.toContain('model_providers.unused')
    expect(runtime.configToml).not.toContain('[mcp_servers.fixture]')
  })

  it('passes only provider-declared environment values', async () => {
    const root = await tempRoot()
    await fs.writeFile(path.join(root, 'config.toml'), [
      'model_provider = "custom"',
      '[model_providers.custom]',
      'name = "Custom"',
      'env_key = "EVAL_API_KEY"',
      'env_http_headers = { X-Tenant = "EVAL_TENANT" }',
    ].join('\n'))

    const runtime = await resolveCodexEvalRuntimeConfig({
      sourceEnv: {
        CODEX_HOME: root,
        EVAL_API_KEY: 'key-value',
        EVAL_TENANT: 'tenant-value',
        UNRELATED_SECRET: 'do-not-pass',
      },
      inheritUserConfig: true,
    })
    expect(runtime.providerEnvironment).toEqual({
      EVAL_API_KEY: 'key-value',
      EVAL_TENANT: 'tenant-value',
    })
  })

  it('rejects provider variables that override isolation', async () => {
    const root = await tempRoot()
    await fs.writeFile(path.join(root, 'config.toml'), [
      'model_provider = "unsafe"',
      '[model_providers.unsafe]',
      'name = "Unsafe"',
      'env_key = "CODEX_HOME"',
    ].join('\n'))

    await expect(resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: root },
      inheritUserConfig: true,
    })).rejects.toThrow('cannot use reserved environment variable CODEX_HOME')
  })

  it('materializes one trusted runtime home without copying auth to a custom provider', async () => {
    const root = await tempRoot()
    const workspace = path.join(root, 'project')
    await fs.ensureDir(workspace)
    await fs.writeJson(path.join(root, 'auth.json'), { token: 'official-token' })
    await fs.writeFile(path.join(root, 'config.toml'), [
      'model_provider = "custom"',
      '[model_providers.custom]',
      'name = "Custom"',
      'base_url = "https://custom.invalid/v1"',
    ].join('\n'))
    const runtime = await resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: root },
      inheritUserConfig: true,
    })
    const destination = path.join(root, 'runtime')

    await materializeCodexEvalRuntimeHome(runtime, destination, { trustedProject: workspace })

    const config = await fs.readFile(path.join(destination, 'config.toml'), 'utf8')
    expect(config).toContain('[projects.' + JSON.stringify(await fs.realpath(workspace)) + ']')
    await expect(fs.pathExists(path.join(destination, 'auth.json'))).resolves.toBe(false)
  })

  it('redacts provider endpoint, header, and environment credentials', async () => {
    const root = await tempRoot()
    await fs.writeFile(path.join(root, 'config.toml'), [
      'model_provider = "custom"',
      '[model_providers.custom]',
      'name = "Custom"',
      'base_url = "https://private.invalid/v1"',
      'env_key = "CUSTOM_TOKEN"',
      'http_headers = { X-Static = "static-header" }',
    ].join('\n'))
    const runtime = await resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: root, CUSTOM_TOKEN: 'environment-token' },
      inheritUserConfig: true,
    })

    expect(redactCodexEvalValue(
      'https://private.invalid/v1 static-header environment-token',
      runtime,
    )).toBe('[redacted] [redacted] [redacted]')
  })
})
