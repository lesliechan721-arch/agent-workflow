import { describe, expect, it } from 'vitest';
import {
  assertNativeComponentHookEvent, assertNativeHookEvent, assertPlatformCapabilities, assertPluginManifestStructure,
  assertPluginComponent, assertPlatformComponentPlan, partitionStaticPluginComponents,
  createHookHandlerResponse, getHookHandlerContract, getPluginAuthoringCapabilitySurface, getPlatformHookHandlerRegistry,
  renderPublicHookEvent, normalizeRenderedHookGroupIdentity, validatePlatformManifestProjection, validatePluginManifest, COMPONENT_KINDS,
  type PlatformCapabilitiesV1, type PluginComponent,
} from '../../src/manifest.js';
const raw = { schemaVersion: 4, name: 'example', version: '1.0.0', description: 'Example', platforms: ['codex'], marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } }, extensions: { nativeHooks: { codex: [{ id: 'child', event: 'SubagentStart', feedback: 'context', command: 'node child.mjs' }] } } };
describe('public Hook handler registry', () => {
  it('uses one event allowlist for schema, component, author query and retained bundle validation', async () => {
    assertPluginManifestStructure(raw);
    assertNativeComponentHookEvent('codex', 'SubagentStart');
    expect(assertNativeHookEvent('SubagentStart', 'codex', 'test')).toBe('SubagentStart');
    expect(getPluginAuthoringCapabilitySurface('hook-handlers').entries.find((entry) => entry.field === 'codex.native.SubagentStart')?.hookHandler)
      .toEqual(getHookHandlerContract('codex', 'native', 'SubagentStart'));
    const manifest = validatePluginManifest('/tmp', raw);
    await expect(validatePlatformManifestProjection({ rootDir: '/tmp', manifestPath: '/tmp/.agents-plugin/plugin.json', manifest }, 'codex', { name: 'example', version: '1.0.0', description: 'Example' })).resolves.toBeDefined();
    expect(normalizeRenderedHookGroupIdentity({ platform: 'codex', event: 'SubagentStart', command: 'node child.mjs' })).toMatchObject({ event: 'SubagentStart' });
    expect(renderPublicHookEvent('before_tool', 'antigravity')).toBe('PreToolUse');
    for (const event of ['tool.execute.before', 'session.created']) expect(() => assertNativeHookEvent(event, 'opencode', 'test')).toThrow();
    expect(assertNativeHookEvent('before', 'opencode', 'test')).toBe('before');
    expect(assertNativeHookEvent('tool_call', 'pi', 'test')).toBe('tool_call');
  });
  it('encodes context and blocking responses according to the registered wire and exit contract', () => {
    for (const platform of ['codex', 'claude'] as const) {
      const contract = getHookHandlerContract(platform, 'common', 'before_tool');
      expect(contract.protocol?.input).toMatchObject({ transport: 'stdin-json', eventField: 'hook_event_name', fields: expect.arrayContaining(['tool_name', 'tool_input']) });
      const context = createHookHandlerResponse({ platform, dialect: 'common', event: 'before_tool', feedback: 'context', message: 'Read the policy.' });
      expect(context.exitCode).toBe(0);
      expect(JSON.parse(context.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'Read the policy.' } });
      expect(createHookHandlerResponse({ platform, dialect: 'common', event: 'before_tool', feedback: 'block', message: 'Policy denied the action.' })).toEqual({ exitCode: 2, stdout: '', stderr: 'Policy denied the action.' });
    }
    expect(createHookHandlerResponse({ platform: 'antigravity', dialect: 'common', event: 'before_tool', feedback: 'block', message: 'Denied.' })).toEqual({ exitCode: 0, stdout: '{"decision":"deny","reason":"Denied."}', stderr: '' });
    expect(JSON.parse(createHookHandlerResponse({ platform: 'antigravity', dialect: 'common', event: 'session_start', feedback: 'context', message: 'Policy.' }).stdout)).toEqual({ injectSteps: [{ userMessage: 'Policy.' }] });
    expect(() => createHookHandlerResponse({ platform: 'codex', dialect: 'native', event: 'SubagentStart', feedback: 'block', message: 'Denied.' })).toThrow(/unverified or unsupported/u);
  });
  it('uses the Claude PermissionRequest deny object while preserving the Codex exit-code protocol', () => {
    const claude = createHookHandlerResponse({ platform: 'claude', dialect: 'native', event: 'PermissionRequest', feedback: 'block', message: 'Denied.' });
    expect({ ...claude, stdout: JSON.parse(claude.stdout) }).toEqual({ exitCode: 0, stderr: '', stdout: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied.' } } } });
    expect(createHookHandlerResponse({ platform: 'codex', dialect: 'native', event: 'PermissionRequest', feedback: 'block', message: 'Denied.' })).toEqual({ exitCode: 2, stdout: '', stderr: 'Denied.' });
    expect(getHookHandlerContract('claude', 'native', 'PermissionRequest').protocol?.blockEffect).toBe('deny-permission');
    expect(() => createHookHandlerResponse({ platform: 'claude', dialect: 'native', event: 'PostToolUse', feedback: 'block', message: 'Denied.' })).toThrow(/unverified or unsupported/u);
    expect(getHookHandlerContract('codex', 'native', 'PostToolUse').protocol?.blockEffect).toBe('reject-tool-result');
  });

  it.each([
    { platform: 'pi' as const, dialect: 'native' as const, event: 'tool_call', matcher: 'Bash' },
    { platform: 'opencode' as const, dialect: 'native' as const, event: 'before', matcher: 'Bash' },
    { platform: 'codex' as const, dialect: 'native' as const, event: 'UserPromptSubmit', matcher: '*' },
    { platform: 'claude' as const, dialect: 'native' as const, event: 'UserPromptSubmit', matcher: '*' },
    { platform: 'codex' as const, dialect: 'common' as const, event: 'before_tool' as const, matcher: '[' },
  ])('checks $platform $dialect $event matcher through all component and Manifest entry points', ({ platform, dialect, event, matcher }) => {
    const component: PluginComponent = { id: 'guard', kind: 'hook', name: 'guard', content: { dialect, event, feedback: 'notify', matcher, command: 'echo guard' } };
    const capabilities: PlatformCapabilitiesV1 = { schemaVersion: 1, platform, scope: 'user', basis: 'profile', profileId: 'test', consumers: [],
      kinds: Object.fromEntries(COMPONENT_KINDS.map((kind) => [kind, { status: 'supported', reasonCodes: [], delivery: ['native-package'] }])) as PlatformCapabilitiesV1['kinds'],
      features: { [`hook.${dialect}.${event}`]: { status: 'supported', reasonCodes: [], values: ['notify'] } },
    };
    expect(() => assertPluginComponent(component, { platform })).toThrow();
    expect(() => assertPlatformComponentPlan({ version: 3, components: [component], omitted: [], unmet: [] }, { platform, platformCapabilities: capabilities, allowedOutputKinds: ['hook'] })).toThrow();
    expect(() => partitionStaticPluginComponents([component], capabilities)).toThrow();
    const { matcher: _, ...validContent } = component.content;
    expect(partitionStaticPluginComponents([{ ...component, content: validContent }], capabilities).components).toHaveLength(1);
    const entry = { id: 'guard', event, feedback: 'notify', matcher, command: 'echo guard' };
    const extensions = dialect === 'native' ? { nativeHooks: { [platform]: [entry] } } : { hooks: [entry] };
    expect(() => validatePluginManifest('/tmp', { ...raw, platforms: [platform], extensions })).toThrow();
  });

  it.each(['CwdChanged', 'WorktreeCreate', 'WorktreeRemove'])('keeps Claude %s matcherless through the public source and component APIs', (event) => {
    expect(getHookHandlerContract('claude', 'native', event).matcherAllowed).toBe(false);
    const entry = { id: 'guard', event, feedback: 'notify', command: 'echo guard' };
    expect(() => validatePluginManifest('/tmp', { ...raw, platforms: ['claude'], extensions: { nativeHooks: { claude: [entry] } } })).not.toThrow();
    expect(() => validatePluginManifest('/tmp', { ...raw, platforms: ['claude'], extensions: { nativeHooks: { claude: [{ ...entry, matcher: '*' }] } } })).toThrow(/does not allow matcher/u);
    expect(() => assertPluginComponent({ id: 'guard', name: 'guard', kind: 'hook', content: { event, feedback: 'notify', command: 'echo guard', dialect: 'native', matcher: '*' } }, { platform: 'claude' })).toThrow(/does not allow matcher/u);
  });

  it.each(['pi', 'opencode'] as const)('preserves common matcher source intent and reports the concrete %s target gap', (platform) => {
    const hook: PluginComponent = { id: 'guard', name: 'guard', kind: 'hook', content: { dialect: 'common', event: 'before_tool', feedback: 'notify', matcher: 'Bash', command: 'echo guard' } };
    const { platforms: _, ...allPlatforms } = raw;
    const { dialect: __, ...sourceHook } = hook.content;
    expect(() => validatePluginManifest('/tmp', { ...allPlatforms, extensions: { hooks: [{ id: 'guard', ...sourceHook }] } })).not.toThrow();
    const capabilities: PlatformCapabilitiesV1 = { schemaVersion: 1, platform, scope: 'user', basis: 'profile', profileId: 'test', consumers: [],
      kinds: Object.fromEntries(COMPONENT_KINDS.map((kind) => [kind, { status: 'supported', reasonCodes: [], delivery: ['native-package'] }])) as PlatformCapabilitiesV1['kinds'],
      features: { 'hook.common.before_tool': { status: 'supported', reasonCodes: [], values: ['notify'] } },
    };
    const skill: PluginComponent = { id: 'independent', name: 'independent', kind: 'skill', content: { files: { 'SKILL.md': { text: '---\nname: independent\ndescription: Check.\n---\nCheck.\n' } } } };
    const expected = partitionStaticPluginComponents([hook, skill], capabilities);
    expect(expected.components.map((component) => component.id)).toEqual(['independent']);
    expect(expected.unmet).toEqual([{ id: 'guard', kind: 'hook', name: 'guard', requiredFeatures: [{ feature: 'hook.matcher', values: ['common.before_tool'] }], reasonCode: 'interface-unsupported' }]);
    expect(() => assertPlatformComponentPlan({ version: 3, components: [hook], omitted: [], unmet: [] }, { platform, platformCapabilities: capabilities, allowedOutputKinds: ['hook'] })).toThrow();
    expect(() => assertPlatformCapabilities({ ...capabilities, features: { ...capabilities.features, 'hook.matcher': { status: 'supported', reasonCodes: [], values: ['common.before_tool'] } } })).toThrow(/matcher is unverified or unsupported/u);
  });

  it('delivers a matched Hook only with the corresponding qualified matcher value', () => {
    const component: PluginComponent = { id: 'guard', name: 'guard', kind: 'hook', content: { dialect: 'common', event: 'before_tool', feedback: 'notify', matcher: 'Bash', command: 'echo guard' } };
    const capabilities: PlatformCapabilitiesV1 = { schemaVersion: 1, platform: 'codex', scope: 'user', basis: 'profile', profileId: 'test', consumers: [],
      kinds: Object.fromEntries(COMPONENT_KINDS.map((kind) => [kind, { status: 'supported', reasonCodes: [], delivery: ['native-package'] }])) as PlatformCapabilitiesV1['kinds'],
      features: { 'hook.common.before_tool': { status: 'supported', reasonCodes: [], values: ['notify'] }, 'hook.matcher': { status: 'supported', reasonCodes: [], values: ['common.before_tool'] } },
    };
    expect(partitionStaticPluginComponents([component], capabilities).components).toEqual([component]);
    expect(() => assertPlatformComponentPlan({ version: 3, components: [component], omitted: [], unmet: [] }, { platform: 'codex', allowedOutputKinds: ['hook'], platformCapabilities: capabilities })).not.toThrow();
    capabilities.features['hook.matcher'] = { status: 'unverified', reasonCodes: ['capability-unverified'], values: [] };
    expect(partitionStaticPluginComponents([component], capabilities).unmet).toEqual([{ id: 'guard', kind: 'hook', name: 'guard', requiredFeatures: [{ feature: 'hook.matcher', values: ['common.before_tool'] }], reasonCode: 'capability-unverified' }]);
  });

  it('rejects duplicate mapped public/native handlers even when their stable IDs differ', () => {
    const extensions = { hooks: [{ id: 'public', event: 'before_tool', feedback: 'notify', command: 'echo guard' }], nativeHooks: { codex: [{ id: 'native', event: 'PreToolUse', feedback: 'notify', matcher: '*', command: 'echo guard' }] } };
    expect(() => validatePluginManifest('/tmp', { ...raw, extensions })).toThrow(/duplicate codex hook handler/u);
    expect(() => validatePluginManifest('/tmp', { ...raw, extensions: { ...extensions, nativeHooks: { codex: [{ ...extensions.nativeHooks.codex[0], command: 'echo other' }] } } })).not.toThrow();
    expect(() => validatePluginManifest('/tmp', { ...raw, extensions: { hooks: [{ id: 'start-public', event: 'session_start', feedback: 'notify', matcher: 'resume|startup', command: 'echo start' }], nativeHooks: { codex: [{ id: 'start-native', event: 'SessionStart', feedback: 'notify', matcher: 'startup|resume', command: 'echo start' }] } } })).toThrow(/duplicate codex hook handler/u);
  });

  it('rejects equivalent host handlers in dynamic, static and mixed component collections', () => {
    const common: PluginComponent = { id: 'public', name: 'public', kind: 'hook', content: { dialect: 'common', event: 'before_tool', feedback: 'notify', command: 'echo guard' } };
    const native: PluginComponent = { id: 'native', name: 'native', kind: 'hook', content: { dialect: 'native', event: 'PreToolUse', feedback: 'notify', matcher: '*', command: 'echo guard' } };
    const capabilities: PlatformCapabilitiesV1 = { schemaVersion: 1, platform: 'codex', scope: 'user', basis: 'profile', profileId: 'test', consumers: [],
      kinds: Object.fromEntries(COMPONENT_KINDS.map((kind) => [kind, { status: 'supported', reasonCodes: [], delivery: ['native-package'] }])) as PlatformCapabilitiesV1['kinds'],
      features: { 'hook.common.before_tool': { status: 'supported', reasonCodes: [], values: ['notify'] }, 'hook.native.PreToolUse': { status: 'supported', reasonCodes: [], values: ['notify'] }, 'hook.matcher': { status: 'supported', reasonCodes: [], values: ['native.PreToolUse'] } },
    };
    const plan = (components: PluginComponent[]) => ({ version: 3, components, omitted: [], unmet: [] });
    const options = { platform: 'codex' as const, allowedOutputKinds: ['hook' as const], platformCapabilities: capabilities };
    expect(() => assertPlatformComponentPlan(plan([common, native]), options)).toThrow(/duplicate codex hook handler/u);
    expect(() => assertPlatformComponentPlan(plan([native]), { ...options, staticComponents: [common] })).toThrow(/duplicate codex hook handler/u);
    expect(() => partitionStaticPluginComponents([common, native], capabilities)).toThrow(/duplicate codex hook handler/u);
    expect(() => assertPlatformComponentPlan(plan([common, { ...native, content: { ...native.content, command: 'echo other' } }]), options)).not.toThrow();
    expect(() => assertPlatformComponentPlan(plan([common, { ...native, content: { ...native.content, matcher: 'Bash' } }]), options)).not.toThrow();
  });

  it('keeps missing wire definitions unverified and does not infer client qualification from a protocol', () => {
    expect(getHookHandlerContract('cursor', 'common', 'session_start')).toMatchObject({ qualification: 'required', protocol: null });
    expect(getHookHandlerContract('pi', 'native', 'tool_call')).toMatchObject({ api: 'pi.on', protocol: { id: 'aw.serialized-event-notify.v1', responses: { notify: { stdout: null } } } });
    const capabilities: PlatformCapabilitiesV1 = { schemaVersion: 1, platform: 'cursor', scope: 'user', basis: 'profile', profileId: 'test', consumers: [], kinds: Object.fromEntries(COMPONENT_KINDS.map((kind) => [kind, { status: 'unverified', reasonCodes: ['capability-unverified'], delivery: [] }])) as PlatformCapabilitiesV1['kinds'], features: { 'hook.common.session_start': { status: 'supported', reasonCodes: [], values: ['context'] } } };
    expect(() => assertPlatformCapabilities(capabilities)).toThrow(/protocol is unverified/u);
    expect(Object.values(getPlatformHookHandlerRegistry()).every((platform) => Object.values(platform.native).every((handler) => handler.qualification === 'required'))).toBe(true);
  });
});
