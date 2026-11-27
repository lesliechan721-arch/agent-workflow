import { describe, expect, it } from 'vitest';
import {
  nativeComponentName, resolvePlatformAgentNamingMode, resolvePlatformAgentNaming,
  resolveProjectedAgentName, resolveAgentInvocationName, type PlatformId, type PlatformAgentNaming,
} from '../../src/manifest.js';

const identity = { sourceId: 'official', name: 'demo' };
const prefix = 'aw-official-demo-';
const flat: PlatformAgentNaming = { mode: 'aw-prefix', filePrefix: prefix, invocationPrefix: prefix };
const hostPlugin: PlatformAgentNaming = { mode: 'host-plugin', filePrefix: '', invocationPrefix: 'demo:' };
const unsupported: PlatformAgentNaming = { mode: 'unsupported', filePrefix: '', invocationPrefix: '' };

describe('Agent native naming contract', () => {
  it.each<[PlatformId, PlatformAgentNaming]>([
    ['claude', hostPlugin], ['codex', flat], ['pi', flat], ['antigravity', flat],
    ['cursor', flat], ['copilot', flat], ['grok', flat], ['opencode', unsupported], ['generic', unsupported],
  ])('resolves %s naming from either supported identity form', (platform, expected) => {
    expect(resolvePlatformAgentNamingMode(platform)).toBe(expected.mode);
    expect(resolvePlatformAgentNaming(platform, identity)).toEqual(expected);
    const naming = resolvePlatformAgentNaming(platform, { pluginId: 'official/demo', name: 'demo' });
    expect(naming).toEqual(expected);
    if (expected.mode === 'unsupported') {
      expect(() => resolveProjectedAgentName(naming, 'reviewer')).toThrow('platformProjectionNameInvalid');
      expect(() => resolveAgentInvocationName(naming, 'reviewer')).toThrow('platformProjectionNameInvalid');
    } else {
      expect(resolveProjectedAgentName(naming, 'Ｒｅｖｉｅｗｅｒ')).toBe(`${expected.filePrefix}reviewer`);
      expect(resolveAgentInvocationName(naming, 'Ｒｅｖｉｅｗｅｒ')).toBe(`${expected.invocationPrefix}reviewer`);
    }
  });
  it('uses one normalization rule and rejects empty or overlength native names', () => {
    expect(nativeComponentName('  Ｍy_Role!42  ')).toBe('my_role-42');
    expect(nativeComponentName('_reviewer')).toBe('_reviewer');
    expect(nativeComponentName('x'.repeat(128))).toHaveLength(128);
    for (const invalid of [' -- ', 'x'.repeat(129)]) expect(() => nativeComponentName(invalid)).toThrow('platformProjectionNameInvalid');
  });
  it('counts the complete file prefix against the limit without truncating names or paths', () => {
    const naming = resolvePlatformAgentNaming('codex', identity);
    const role = 'x'.repeat(128 - prefix.length);
    expect(resolveProjectedAgentName(naming, role)).toHaveLength(128);
    expect(resolveAgentInvocationName(naming, role)).toHaveLength(128);
    expect(() => resolveProjectedAgentName(naming, `${role}x`)).toThrow('platformProjectionNameInvalid');
    expect(() => resolveAgentInvocationName(naming, `${role}x`)).toThrow('platformProjectionNameInvalid');
    expect(() => resolveProjectedAgentName({ ...naming, filePrefix: '../' }, 'reviewer')).toThrow('platformProjectionNameInvalid');
    expect(resolveProjectedAgentName(hostPlugin, 'x'.repeat(128))).toHaveLength(128);
    expect(resolveAgentInvocationName(hostPlugin, 'x'.repeat(128))).toBe(`demo:${'x'.repeat(128)}`);
  });
  it('rejects malformed or conflicting identities even when the platform does not use a prefix', () => {
    for (const plugin of [
      { sourceId: '../outside', name: 'demo' }, { sourceId: 'official', name: '.hidden' },
      { sourceId: 'official', name: 'name with spaces' }, { pluginId: 'official' },
      { pluginId: 'official/demo/extra' }, { pluginId: '/demo' }, { pluginId: 'official/' },
      { pluginId: 'official/demo', name: 'other' }, { pluginId: 'official/demo', sourceId: 'other' },
    ]) {
      expect(() => resolvePlatformAgentNaming('codex', plugin)).toThrow('platformPluginIdentityInvalid');
      expect(() => resolvePlatformAgentNaming('generic', plugin)).toThrow('platformPluginIdentityInvalid');
    }
    for (const invalid of [{ sourceId: undefined, name: 'demo' }, { pluginId: 5 }]) {
      expect(() => resolvePlatformAgentNaming('codex', invalid as never)).toThrow('platformPluginIdentityInvalid');
    }
    expect(resolvePlatformAgentNaming('codex', { pluginId: 'review-source/Example_Name.1' })).toEqual({
      mode: 'aw-prefix', filePrefix: 'aw-review-source-Example_Name.1-', invocationPrefix: 'aw-review-source-Example_Name.1-',
    });
  });
});
