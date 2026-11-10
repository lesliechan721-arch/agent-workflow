import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CATALOG_WORKSPACE_VERSION,
  getHookHandlerContract,
  assertNativeHookEvent,
  assertNativeComponentHookEvent,
  assertNoDuplicateHookHandlers,
  getAwCapabilityRegistry,
  PLATFORM_TARGETS,
  resolvePluginConfigObjectProperties,
  selectPluginConfigProfile,
  type PluginConfigObjectField,
  type PluginComponent,
} from '@lesliechan721/aw-plugin-core'
import {
  computeAwCapabilitySetDigest,
  createHookHandlerResponse,
  assertNoDuplicateHookHandlers as assertManifestHookHandlers,
  assertPluginManifestStructure,
  normalizePluginConfigDefinition,
  validatePluginConfigValue,
  PLUGIN_CONFIG_V3_MAX_DEFINITIONS,
  PLUGIN_CONFIG_V3_MAX_FIELDS,
  PLUGIN_CONFIG_V3_MAX_REF_DEPTH,
  PLUGIN_CONFIG_ARRAY_MAX_ITEMS,
  PLUGIN_CONFIG_ARRAY_MAX_BYTES,
  getPluginAuthoringCapabilities,
  getPluginAuthoringCapabilitySurface,
  PLUGIN_MANIFEST_SCHEMA_VERSION,
  getPluginCommandId,
  getManagedCommandArtifactTargets,
  validatePluginManifest,
  resolveSupportedPlatforms,
  compilePluginConfigDefinition,
  selectPluginConfigProfile as selectManifestConfigProfile,
} from '@lesliechan721/aw-plugin-core/manifest'

const require = createRequire(import.meta.url)

describe('public package exports', () => {
  it('exposes the same complete-collection Hook identity check from both entries', () => {
    expect(assertNoDuplicateHookHandlers).toBe(assertManifestHookHandlers)
    const components: PluginComponent[] = [
      { id: 'public', name: 'public', kind: 'hook', content: { dialect: 'common', event: 'before_tool', feedback: 'notify', command: 'echo guard' } },
      { id: 'native', name: 'native', kind: 'hook', content: { dialect: 'native', event: 'PreToolUse', feedback: 'notify', matcher: '*', command: 'echo guard' } },
    ]
    expect(() => assertNoDuplicateHookHandlers(components, 'codex')).toThrow(/duplicate codex hook handler/u)
  })
  it('publishes one native event contract and executes its context/block command wire', () => {
    expect(assertNativeHookEvent('SubagentStart', 'codex', 'test')).toBe('SubagentStart')
    assertNativeComponentHookEvent('codex', 'SubagentStart')
    const handler = getHookHandlerContract('codex', 'common', 'before_tool')
    expect(handler.nativeEvent).toBe('PreToolUse')
    expect(handler.protocol?.input.fields).toEqual(expect.arrayContaining(['hook_event_name', 'tool_input']))
    const script = `import fs from 'node:fs';
import {createHookHandlerResponse} from '@lesliechan721/aw-plugin-core/manifest';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
if (input.hook_event_name !== 'PreToolUse') throw new Error('Wrong event');
const result = createHookHandlerResponse({platform:'codex',dialect:'common',event:'before_tool',feedback:process.argv[1],message:input.tool_input.command});
process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.exitCode;`
    for (const feedback of ['context', 'block']) {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, feedback], {
        cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), encoding: 'utf8',
        input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: { command: 'Read the policy.' } }),
      })
      if (feedback === 'block') expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({ status: 2, stdout: '', stderr: 'Read the policy.' })
      else {
        expect(result.status).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'Read the policy.' } })
      }
    }
  }, 30000)
  it('exports the event-specific Claude permission denial response', () => {
    const response = createHookHandlerResponse({ platform: 'claude', dialect: 'native', event: 'PermissionRequest', feedback: 'block', message: 'Denied.' })
    expect(response.exitCode).toBe(0)
    expect(response.stderr).toBe('')
    expect(JSON.parse(response.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied.' } } })
  })
  it('ships canonical platform targets and platform config compilation through package exports', () => {
    const manifest = validatePluginManifest('/plugin', {
      schemaVersion: 4, name: 'platform-config', version: '1.0.0', description: 'Platform contract',
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      platforms: ['cursor', 'pi'],
      config: { schemaVersion: 5, fields: { agent: { type: 'string', default: 'common' } }, platforms: {
        cursor: { fields: { agent: { type: 'string', default: 'Cursor' } } },
      } },
    })
    expect(PLATFORM_TARGETS).toEqual(['codex', 'claude', 'antigravity', 'cursor', 'opencode', 'pi', 'gemini', 'copilot', 'grok', 'generic'])
    expect([...resolveSupportedPlatforms(manifest)]).toEqual(['cursor', 'pi'])
    expect(compilePluginConfigDefinition(manifest.config, 'cursor').fields.agent?.default).toBe('Cursor')
    expect(compilePluginConfigDefinition(manifest.config, 'pi').fields.agent?.default).toBe('common')
    expect(selectPluginConfigProfile(manifest.config!, 'cursor').fields.agent?.default).toBe('Cursor')
    expect(selectManifestConfigProfile(manifest.config!, 'pi').fields.agent?.default).toBe('common')
    expect(() => selectManifestConfigProfile(manifest.config!, 'agent-skills' as never)).toThrow('config.platform')
    expect(getAwCapabilityRegistry()).toContain('aw.plugin-config.v5')
  })

  it('ships managed command normalization, target projection and identity through the published package', () => {
    const manifest = validatePluginManifest('/plugin', {
      schemaVersion: 4, name: 'managed-tools', version: '1.0.0', description: 'Managed tools',
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      managedCommands: { packages: [{ key: 'tools', scope: 'user', platforms: ['codex'], sourceDir: './tools' }], sets: [] },
    });
    expect(manifest.managedCommands?.packages[0]?.refreshKeys).toEqual([]);
    expect(getManagedCommandArtifactTargets(manifest)).toEqual([]);
    expect(getAwCapabilityRegistry()).toEqual(expect.arrayContaining(['aw.managed-commands.v1', 'aw.claude.sandbox-exclusions.v1']));
    expect(getPluginAuthoringCapabilitySurface('managed-commands').surface).toBe('managed-commands');
    expect(getPluginCommandId({ schemaVersion: 2, producer: {
      sourceId: 'official', sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginName: 'example-plugin',
      kind: 'package', key: 'tools', platform: null, scope: 'user', projectRoot: null, placementKey: null,
    }, set: 'tools', key: 'check', variant: 'default' })).toBe('cmdp_fef82b56d2543a37');
  });
  it('ships the v4 schema, capability and shared branch resolver through public exports', () => {
    const config = { schemaVersion: 4, fields: { backend: { type: 'object', properties: {
      adapter: { type: 'string' }, args: { type: 'array', items: { type: 'string' } },
      env: { type: 'object', additionalProperties: { type: 'string' } },
    }, variants: { discriminator: 'adapter', cases: {
      builtin: { properties: { mode: { type: 'string', const: 'workspace' } } },
      custom: { properties: { command: { type: 'string', required: true } } },
    } } } } }
    const manifest = { schemaVersion: 4, name: 'v4-reader', version: '1.0.0', description: 'Public contract',
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } }, config }
    assertPluginManifestStructure(manifest)
    const compiled = normalizePluginConfigDefinition(config)
    const backend = compiled.fields.backend as PluginConfigObjectField
    expect(resolvePluginConfigObjectProperties(backend, { adapter: 'builtin' }).properties.mode).toMatchObject({ const: 'workspace' })
    expect(validatePluginConfigValue(backend, { adapter: 'builtin', args: [''], env: { PATH: '' } })).toEqual([])
    expect(validatePluginConfigValue(backend, { adapter: 'builtin', command: '/tmp/command' })).toMatchObject([{ code: 'additionalProperty' }])
    expect(() => assertPluginManifestStructure({ ...manifest, config: { ...config, schemaVersion: 3 } })).toThrow()
    expect(getAwCapabilityRegistry()).toContain('aw.plugin-config.v4')
    expect(getPluginAuthoringCapabilitySurface('config').entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'config.schemaVersion', acceptedValues: [3, 4, 5] }),
    ]))
  })
  it('publishes the v3 reader, schema and budget constants through package exports', () => {
    const config = { schemaVersion: 3, definitions: { text: { type: 'string', validation: { minLength: 2 } } }, fields: { label: { $ref: '#/config/definitions/text', default: 'valid' } } };
    const manifest = { schemaVersion: 4, name: 'public-reader', version: '0.1.0', description: 'Public contract', marketplace: { category: 'workflow', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } }, config };
    expect(() => assertPluginManifestStructure(manifest)).not.toThrow();
    const compiled = normalizePluginConfigDefinition(config);
    expect(validatePluginConfigValue(compiled.fields.label!, 'x')).toMatchObject([{ code: 'minLength' }]);
    expect(compiled.schemaVersion).toBe(3);
    expect([PLUGIN_CONFIG_V3_MAX_DEFINITIONS, PLUGIN_CONFIG_V3_MAX_FIELDS, PLUGIN_CONFIG_V3_MAX_REF_DEPTH]).toEqual([64, 256, 8]);
    expect(getAwCapabilityRegistry()).toEqual(expect.arrayContaining(['aw.plugin-config.v3', 'aw.plugin-config-summary.v1']));
  });
  it('exposes the manifest runtime and published v4 schema subpaths', async () => {
    expect(DEFAULT_CATALOG_WORKSPACE_VERSION).toBe('0.1.0')
    expect(getAwCapabilityRegistry()).toContain('aw.self-check.v2')
    expect(computeAwCapabilitySetDigest(['aw.self-check.v2'])).toMatch(/^sha256:/u)
    expect(PLUGIN_MANIFEST_SCHEMA_VERSION).toBe(4)
    expect(getPluginAuthoringCapabilities().schemaVersion).toBe(1)
    expect(getPluginAuthoringCapabilitySurface('manifest').surface).toBe('manifest')
    const schemaPath = require.resolve(
      '@lesliechan721/aw-plugin-core/schemas/plugin-manifest-v4.json',
    )
    const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'))
    expect(schema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'PluginManifestSourceV4',
    })
  })
  it('ships array validation, schema and capability through the public package', async () => {
    const config = { schemaVersion: 3, fields: { labels: {
      type: 'array', items: { type: 'string', validation: { minLength: 1 } },
      default: [], validation: { maxItems: 2, uniqueItems: true },
    } } }
    const manifest = { schemaVersion: 4, name: 'array-reader', version: '0.1.0', description: 'Array contract',
      marketplace: { category: 'workflow', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      config }
    expect(() => assertPluginManifestStructure(manifest)).not.toThrow()
    const compiled = normalizePluginConfigDefinition(config)
    expect(validatePluginConfigValue(compiled.fields.labels!, ['ok', ''])).toMatchObject([
      { code: 'minLength', path: { segments: ['value', 1] } },
    ])
    expect([PLUGIN_CONFIG_ARRAY_MAX_ITEMS, PLUGIN_CONFIG_ARRAY_MAX_BYTES]).toEqual([128, 262144])
    expect(getAwCapabilityRegistry()).toContain('aw.plugin-config-array.v1')
  })
})
