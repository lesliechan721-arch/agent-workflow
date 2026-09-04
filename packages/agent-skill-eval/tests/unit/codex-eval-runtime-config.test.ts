import os from 'node:os'
import path from 'node:path'

import fs from 'fs-extra'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_CODEX_EVAL_MODEL,
  materializeCodexEvalRuntimeHome,
  redactCodexEvalValue,
  resolveCodexEvalRuntimeConfig,
} from '../../src/index.js'

const tempDirs: string[] = []

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-provider-config-'))
  tempDirs.push(root)
  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
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

  it('redacts raw and JSON-escaped credentials discovered while materializing auth', async () => {
    const root = await tempRoot()
    const destination = await tempRoot()
    const secret = 'dynamic-"\\\n\t-secret'
    const encoded = JSON.stringify(secret).slice(1, -1)
    await fs.writeJson(path.join(root, 'auth.json'), { OPENAI_API_KEY: secret })
    const runtime = await resolveCodexEvalRuntimeConfig({
      sourceEnv: { CODEX_HOME: root },
      inheritUserConfig: false,
    })

    await materializeCodexEvalRuntimeHome(runtime, destination)

    expect(redactCodexEvalValue({
      [`raw-${secret}`]: `raw=${secret}`,
      [encoded]: encoded,
    }, runtime)).toEqual({
      'raw-[redacted]': 'raw=[redacted]',
      '[redacted]': '[redacted]',
    })
  })

  it.each(['auth.json', '.credentials.json'])(
    'stages the same %s bytes used to collect sensitive values when the source rotates',
    async (name) => {
      const root = await tempRoot()
      const destination = await tempRoot()
      const source = path.join(root, name)
      const oldToken = `old-${name}-token`
      const newToken = `new-${name}-token`
      const oldBytes = Buffer.from(JSON.stringify({ token: oldToken }))
      const newBytes = Buffer.from(JSON.stringify({ token: newToken }))
      await fs.writeFile(source, oldBytes)
      const runtime = await resolveCodexEvalRuntimeConfig({
        sourceEnv: { CODEX_HOME: root },
        inheritUserConfig: false,
      })
      const originalReadFile = fs.readFile.bind(fs) as (...args: any[]) => Promise<any>
      let rotated = false
      vi.spyOn(fs, 'readFile').mockImplementation((async (...args: any[]) => {
        const value = await originalReadFile(...args)
        if (!rotated && path.resolve(String(args[0])) === source) {
          rotated = true
          await fs.writeFile(source, newBytes)
        }
        return value
      }) as typeof fs.readFile)

      await materializeCodexEvalRuntimeHome(runtime, destination)

      expect(rotated).toBe(true)
      await expect(fs.readFile(source)).resolves.toEqual(newBytes)
      await expect(fs.readFile(path.join(destination, name))).resolves.toEqual(oldBytes)
      expect(runtime.sensitiveValues).toContain(oldToken)
      expect(runtime.sensitiveValues).not.toContain(newToken)
    },
  )
})
