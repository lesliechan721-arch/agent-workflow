import { describe, expect, it, vi } from 'vitest'
import {
  codexPermissionProfileStatus,
  normalizedCodexPermissionProfile,
  resolveEvalProcessManagement,
} from '../../dist/index.js'

describe('Eval process management preflight', () => {
  it('normalizes the permission profile and blocks restricted sessions before other probes', async () => {
    const readKeychains = vi.fn(async () => '')
    const inspectProcessTree = vi.fn(async () => undefined)

    expect(normalizedCodexPermissionProfile({ CODEX_PERMISSION_PROFILE: ':workspace-write' }))
      .toBe('workspace-write')
    expect(codexPermissionProfileStatus({ CODEX_PERMISSION_PROFILE: ':workspace-write' }))
      .toBe('restricted')
    await expect(resolveEvalProcessManagement({
      allowUnmanaged: false,
      sourceEnv: { CODEX_PERMISSION_PROFILE: ':workspace-write' },
      dependencies: {
        platform: 'darwin',
        readUserKeychainSearchList: readKeychains,
        inspectProcessTree,
      },
    })).rejects.toThrow('one-off sandbox_permissions=require_escalated')
    expect(readKeychains).not.toHaveBeenCalled()
    expect(inspectProcessTree).not.toHaveBeenCalled()
  })

  it('uses explicit unmanaged mode after the keychain check and skips process inspection', async () => {
    const order: string[] = []
    const result = await resolveEvalProcessManagement({
      allowUnmanaged: true,
      sourceEnv: { CODEX_PERMISSION_PROFILE: ':read-only' },
      dependencies: {
        platform: 'darwin',
        resolveCodexExecutable: async () => '/usr/local/bin/codex',
        readUserKeychainSearchList: async () => {
          order.push('keychain')
          return '"/Users/test/Library/Keychains/login.keychain-db"'
        },
        inspectProcessTree: async () => { order.push('process-tree') },
      },
    })

    expect(order).toEqual(['keychain'])
    expect(result).toMatchObject({
      mode: 'unmanaged-confirmed',
      inspectionAvailable: false,
      userAcknowledged: true,
      descendantCleanupGuaranteed: false,
    })
  })

  it('checks the keychain before process inspection and returns managed evidence', async () => {
    const order: string[] = []
    const result = await resolveEvalProcessManagement({
      allowUnmanaged: false,
      sourceEnv: { CODEX_PERMISSION_PROFILE: ':danger-full-access' },
      dependencies: {
        platform: 'darwin',
        resolveCodexExecutable: async () => '/usr/local/bin/codex',
        readUserKeychainSearchList: async () => {
          order.push('keychain')
          return '"/Users/test/Library/Keychains/login.keychain-db"'
        },
        inspectProcessTree: async () => { order.push('process-tree') },
      },
    })

    expect(order).toEqual(['keychain', 'process-tree'])
    expect(result).toEqual({
      mode: 'managed',
      inspectionAvailable: true,
      userAcknowledged: false,
      descendantCleanupGuaranteed: false,
      limitation: expect.stringContaining('not OS-enforced containment'),
    })
  })

  it('blocks an injected keychain before process inspection', async () => {
    const inspectProcessTree = vi.fn(async () => undefined)
    await expect(resolveEvalProcessManagement({
      allowUnmanaged: true,
      sourceEnv: { CODEX_PERMISSION_PROFILE: ':danger-full-access' },
      dependencies: {
        platform: 'darwin',
        resolveCodexExecutable: async () => '/usr/local/bin/codex',
        readUserKeychainSearchList: async () =>
          '"/private/tmp/accountsKeychainExport/keychain-db"',
        inspectProcessTree,
      },
    })).rejects.toThrow('accountsKeychainExport')
    expect(inspectProcessTree).not.toHaveBeenCalled()
  })

  it('blocks a cmux Codex shim before keychain and process inspection in every mode', async () => {
    for (const allowUnmanaged of [false, true]) {
      const readUserKeychainSearchList = vi.fn(async () => '')
      const inspectProcessTree = vi.fn(async () => undefined)
      await expect(resolveEvalProcessManagement({
        allowUnmanaged,
        sourceEnv: {
          CODEX_PERMISSION_PROFILE: ':danger-full-access',
          PATH: '/private/tmp/cmux-cli-shims/session:/usr/local/bin',
        },
        dependencies: {
          platform: 'darwin',
          resolveCodexExecutable: async () =>
            '/private/tmp/cmux-cli-shims/session/codex',
          readUserKeychainSearchList,
          inspectProcessTree,
        },
      })).rejects.toThrow('cmux Codex shim or wrapper')
      expect(readUserKeychainSearchList).not.toHaveBeenCalled()
      expect(inspectProcessTree).not.toHaveBeenCalled()
    }
  })

  it('requires explicit authorization after a managed inspection failure and then skips inspection', async () => {
    const inspectProcessTree = vi.fn(async () => { throw new Error('process inspection denied') })
    const dependencies = {
      platform: 'linux' as const,
      inspectProcessTree,
    }
    await expect(resolveEvalProcessManagement({
      allowUnmanaged: false,
      sourceEnv: {},
      dependencies,
    })).rejects.toThrow('Full Access process management is unavailable')
    await expect(resolveEvalProcessManagement({
      allowUnmanaged: true,
      sourceEnv: {},
      dependencies,
    })).resolves.toMatchObject({
      mode: 'unmanaged-confirmed',
      diagnostic: 'Unmanaged process execution was explicitly accepted; process-tree inspection was skipped.',
    })
    expect(inspectProcessTree).toHaveBeenCalledOnce()
  })
})
