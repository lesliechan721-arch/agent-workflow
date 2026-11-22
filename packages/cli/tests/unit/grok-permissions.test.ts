import path from 'node:path';
import fs from 'fs-extra';
import { expect, it, vi } from 'vitest';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import { publicDiagnostic } from '../../src/commands/public-lifecycle-result.js';
import type { DeploymentBinding } from '../../src/platforms/contracts.js';
import { getInvocationPolicyPath, getInvocationPolicyPhysicalKey } from '../../src/platforms/layout.js';
import { hostPermissionClaims, selectPlatformInvocationPolicy } from '../../src/generators/permissions.js';
import { assertGrokPermissionPath, inspectGrokPermissionConfig, parseGrokPermissionDocument } from '../../src/platforms/grok-permission-config.js';
import { grokPrefixesOverlap, mergeGrokPermissions } from '../../src/platforms/grok-permissions.js';
import { hostPermissionDiagnostics } from '../../src/platforms/host-permission-policy.js';
import { permissionComponent, previewHostPermissions, updateHostPermissions } from '../../src/platforms/permission-ownership.js';
import type { PermissionClaim } from '../../src/platforms/permission-sidecar.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const argv = ['aw', 'command', 'run', 'catalog/guide', '--'];
const claim = (effect: PermissionClaim['effect'], ...tokens: string[]): PermissionClaim => ({ name: 'reports', effect, tokens });
const native = (action: PermissionClaim['effect'], pattern: string) => ({ action, tool: 'bash', pattern });
const nativeRules = (content: string) => getStaticTOMLValue(parseTOML(content)).permission;

function grokBinding(host: string, name: string, scope: DeploymentBinding['scope'] = { kind: 'user' }): DeploymentBinding {
  return { id: name, platform: 'grok', route: scope.kind === 'user' ? 'grok-cli' : 'grok-directory', scope,
    plugin: { pluginId: `catalog/${name}`, sourceId: 'catalog', sourceIdentity: 'sha256:' + 'a'.repeat(64), version: '1.0.0' },
    consumers: [{ id: 'cli', product: 'cli', version: '1.0.77', availability: 'available', reasonCodes: [],
      entry: { kind: 'cli', executable: process.execPath, configRoot: host } }], physicalKey: '', activationKey: '', renderUnitIds: [] };
}

it('projects each action for ordinary and managed commands and describes the resulting text matching', () => {
  const subject = { pluginId: 'catalog/guide', target: 'grok' as const, scope: 'user' as const };
  const selection = selectPlatformInvocationPolicy({ platform: 'grok', permissions: [
    { name: 'reports', allow: ['sample-report'], ask: [{ argsPrefix: ['draft'] }], deny: [{ argsPrefix: ['publish'] }] },
  ] }, subject);
  expect(selection.diagnostics).toEqual([]);
  const claims = hostPermissionClaims(selection.policy.permissions, subject.pluginId);
  const result = mergeGrokPermissions(claims, [], []);
  expect(result.skipped).toEqual([]);
  expect(result.effective).toEqual([
    { action: 'shell', effect: 'allow', resource: 'sample-report' },
    { action: 'shell', effect: 'ask', resource: 'aw command run catalog/guide -- draft' },
    { action: 'shell', effect: 'deny', resource: 'aw command run catalog/guide -- publish' },
  ]);
  expect(result.adjusted.map(({ effect, resource, message }) => ({ effect, resource, message }))).toEqual(result.effective.map(
    ({ effect, resource }) => ({ effect, resource, message: expect.stringContaining('Quoted arguments joined with spaces') }),
  ));
  const document = parseGrokPermissionDocument('');
  expect(nativeRules(document.writePermissions(result.after))).toEqual({ rules: [
    native('allow', 'sample-report'), native('ask', 'aw command run catalog/guide -- draft'),
    native('deny', 'aw command run catalog/guide -- publish'),
  ] });
});

it('reports only decisions barred by a stronger policy or an unsupported shell prefix', () => {
  const grant = claim('allow', 'sample-report');
  const ask = claim('ask', 'sample-report', 'draft');
  const denied = claim('deny', 'sample-report', 'draft');
  const wrapper = claim('allow', 'env', 'sample-report');
  const indeterminate = claim('allow', 'env', '--unrecognized-option', 'sample-report');
  const invalid = claim('allow', 'sample-report', 'a\u0000b');
  const env = claim('allow', 'env');
  const glob = claim('allow', 'sample-report', 'café?');
  const result = mergeGrokPermissions([grant, ask, denied, wrapper, indeterminate, invalid, env, glob], [], []);
  expect(result.effective.map(({ effect, resource }) => [effect, resource])).toEqual([
    ['allow', 'env'], ['allow', 'sample-report'], ['allow', 'sample-report café?'], ['deny', 'sample-report draft'],
  ]);
  expect(result.skipped).toEqual(expect.arrayContaining([
    { ...ask, reasonCode: 'permission-rule-conflict' },
    { ...indeterminate, reasonCode: 'grok-shell-prefix-normalized' },
    { ...invalid, reasonCode: 'grok-shell-pattern-unrepresentable' },
  ]));
  expect(result.adjusted).toContainEqual(expect.objectContaining({ resource: 'sample-report café?',
    message: expect.stringContaining('characters Grok can interpret as wildcards') }));
  expect(result.adjusted).toContainEqual(expect.objectContaining({ ...wrapper, resource: 'sample-report',
    message: expect.stringContaining('Calling the inner command directly can also be allowed') }));
  const manual = { action: 'shell', resource: 'sample-*', effect: 'ask' };
  const partial = mergeGrokPermissions([grant], [manual], []);
  expect(partial.skipped).toEqual([{ ...grant, reasonCode: 'permission-rule-conflict' }]);
  expect(partial.effective).toHaveLength(1);
  expect(mergeGrokPermissions([wrapper], [{ action: 'shell', resource: 'env sample-report', effect: 'deny' }], []).skipped)
    .toEqual([{ ...wrapper, reasonCode: 'permission-rule-conflict' }]);
});

it('reports where narrower configured restrictions still apply while writing the broader allow', () => {
  const grant = claim('allow', ...argv);
  const denied = native('deny', [...argv, 'publish'].join(' '));
  const questioned = native('ask', [...argv, 'draft *'].join(' '));
  const result = mergeGrokPermissions([grant], [denied], [
    { layer: 'higher', path: '/sample/managed_config.toml', rule: questioned },
    { layer: 'higher', path: '/sample/managed_config.toml', rule: native('deny', 'aw command run catalog/[gh]uide -- audit') },
    { layer: 'higher', path: '/sample/managed_config.toml', rule: native('deny', 'sample-summary') },
    { layer: 'higher', path: '/sample/managed_config.toml', rule: native('deny', 'aw command run catalog/[xy]uide -- audit') },
  ]);

  expect(result.skipped).toEqual([]);
  expect(result.after).toEqual([{ action: 'shell', effect: 'allow', resource: argv.join(' ') }]);
  const preserved = result.adjusted.filter(({ reasonCode }) => reasonCode === 'grok-manual-restriction-preserved');
  expect(preserved).toHaveLength(1);
  expect(preserved[0]?.message).toContain(`deny ${JSON.stringify(denied.pattern)}`);
  expect(preserved[0]?.message).toContain(`ask ${JSON.stringify(questioned.pattern)}`);
  expect(preserved[0]?.message).toContain('catalog/[gh]uide -- audit');
  expect(preserved[0]?.message).not.toContain('sample-summary');
  expect(preserved[0]?.message).not.toContain('catalog/[xy]uide -- audit');
});

it('keeps independent grants when a restriction character class cannot match their command', () => {
  const covered = claim('allow', 'sample-report', 'draft');
  const independent = claim('allow', 'sample-report', 'print');
  const restriction = claim('deny', 'sample-report', '[ds]raft', 'notes\u0001');
  expect(mergeGrokPermissions([covered, independent, restriction], [], []).after)
    .toEqual([{ action: 'shell', effect: 'allow', resource: 'sample-report print' }]);
  expect(grokPrefixesOverlap(['sample-report', '[ds]raft'], ['sample-report', '[pr]raft'])).toBe(false);
});

it('writes inner rules for Grok shell-builtin execution prefixes and preserves native query and restriction patterns', () => {
  const cases: Array<[PermissionClaim['effect'], string[], string]> = [
    ['allow', ['command', 'printf', 'sample'], 'printf sample'],
    ['allow', ['command', '-p', '--', 'printf', 'sample'], 'printf sample'],
    ['allow', ['command', '-v', 'printf'], 'command -v printf'],
    ['allow', ['command', '-pV', 'printf'], 'command -pV printf'],
    ['allow', ['command', '--version'], 'command --version'],
    ['allow', ['exec', '-cl', '-a', 'sample', '--', 'printf', 'sample'], 'printf sample'],
    ['allow', ['exec', '-asample', 'printf', 'sample'], 'printf sample'],
    ['allow', ['builtin', 'printf', 'sample'], 'printf sample'],
    ['allow', ['env', 'command', '-p', 'timeout', '5', 'printf', 'sample'], 'printf sample'],
    ['allow', ['nohup', 'printf', 'sample'], 'nohup printf sample'],
    ['ask', ['command', 'printf', 'sample'], 'command printf sample'],
    ['deny', ['exec', 'printf', 'sample'], 'exec printf sample'],
  ];
  for (const [effect, tokens, pattern] of cases) {
    const result = mergeGrokPermissions([claim(effect, ...tokens)], [], []);
    expect(result.skipped, tokens.join(' ')).toEqual([]);
    expect(nativeRules(parseGrokPermissionDocument('').writePermissions(result.after)), tokens.join(' '))
      .toEqual({ rules: [native(effect, pattern)] });
    expect(result.adjusted[0]?.message.includes('Calling the inner command directly can also be allowed'), tokens.join(' '))
      .toBe(pattern !== tokens.join(' '));
  }
});

it('writes the outer rule for an unresolved Grok wrapper and reports its uncovered execution forms', () => {
  const cases = [[['exec'], 'exec'], [['exec', '-a', 'sample'], 'exec -a sample'], [['builtin'], 'builtin'],
    [['command', '-p'], 'command -p'], [['env'], 'env'], [['env', 'command'], 'command']] as const;
  for (const [tokens, pattern] of cases) {
    const request = claim('allow', ...tokens);
    const result = mergeGrokPermissions([request], [], []);
    expect(nativeRules(parseGrokPermissionDocument('').writePermissions(result.after)), tokens.join(' '))
      .toEqual({ rules: [native('allow', pattern)] });
    expect(result.skipped).toEqual([{ ...request, reasonCode: 'grok-wrapper-target-not-covered' }]);
    expect(result.adjusted[0]?.message).toContain('If additional arguments name an inner command');
    const binding = { platform: 'grok', scope: { kind: 'user' }, plugin: { pluginId: 'catalog/guide' } } as DeploymentBinding;
    const diagnostic = hostPermissionDiagnostics({ skipped: result.skipped, ownershipDegraded: false }, binding, '/sample/config.toml')[0]!;
    expect(publicDiagnostic(diagnostic, undefined, 'warning')).toMatchObject({
      message: expect.stringContaining('additional arguments'),
      detail: { reasonCode: 'grok-wrapper-target-not-covered', skippedPermissionActions: ['allow'] },
    });
  }
  const queriesAndRestrictions = mergeGrokPermissions([
    claim('allow', 'command', '-v'), claim('ask', 'builtin'), claim('deny', 'exec'),
  ], [], []);
  expect(queriesAndRestrictions.skipped).toEqual([]);
  expect(queriesAndRestrictions.effective.map(({ resource }) => resource)).toEqual(['command -v', 'builtin', 'exec']);
  const bare = claim('allow', 'exec');
  const blocked = mergeGrokPermissions([bare, claim('deny', 'exec')], [], []);
  expect(blocked.skipped).toEqual([{ ...bare, reasonCode: 'permission-rule-conflict' }]);
  expect(blocked.effective).toEqual([{ action: 'shell', effect: 'deny', resource: 'exec' }]);
});

it('reports ambiguous Grok shell-builtin options and checks preserved restrictions against inner grants', () => {
  const ambiguous = [claim('allow', 'command', '-x', 'printf'), claim('allow', 'exec', '-a'), claim('allow', 'builtin', '--', 'printf'),
    claim('allow', ...Array<string>(9).fill('command'), 'printf')];
  const skipped = mergeGrokPermissions(ambiguous, [], []);
  expect(skipped.effective).toEqual([]);
  expect(skipped.skipped).toEqual(ambiguous.map((source) => ({ ...source, reasonCode: 'grok-shell-prefix-normalized' })));

  const grant = claim('allow', 'command', 'printf', 'sample');
  const restriction = { action: 'shell', resource: 'printf sample', effect: 'deny' };
  const conflicted = mergeGrokPermissions([grant], [restriction], []);
  expect(conflicted.effective).toEqual([]);
  expect(conflicted.skipped).toEqual([{ ...grant, reasonCode: 'permission-rule-conflict' }]);
});

it('reports that Grok evaluates an inline script separately from its outer shell rule', () => {
  const result = mergeGrokPermissions([claim('allow', 'command', '/bin/bash', '--noprofile', '-lc'), claim('allow', 'sh', 'sample.sh', '-c')], [], []);
  expect(nativeRules(parseGrokPermissionDocument('').writePermissions(result.after))).toEqual({ rules: [
    native('allow', '/bin/bash --noprofile -lc'), native('allow', 'sh sample.sh -c'),
  ] });
  expect(result.adjusted[0]?.message).toContain('Grok checks the commands inside the inline script separately');
  expect(result.adjusted[1]?.message).not.toContain('inline script');
});

it.each([
  '[permission]\r\nrules = [{ action = "ask", tool = "read", pattern = "notes/**" }, # preserve me\r\n]\r\n',
  'permission.rules = [{ action = "ask", tool = "read", pattern = "notes/**" }] # preserve me\n',
  'permission = { rules = [{ action = "ask", tool = "read", pattern = "notes/**" }] } # preserve me\n',
  '[[permission.rules]] # preserve me\naction = "ask"\ntool = "read"\npattern = "notes/**"\n',
])('preserves manual rule bytes, comments, and unrelated tables while adding and withdrawing a native rule', (configured) => {
  const source = configured + '[ui]\npermission_mode = "ask" # unrelated\n';
  const document = parseGrokPermissionDocument(source);
  const generated = { action: 'shell', resource: 'sample-report', effect: 'deny' };
  const written = document.writePermissions([...document.permissions, generated]);
  expect(nativeRules(written)).toEqual({ rules: [ { action: 'ask', tool: 'read', pattern: 'notes/**' }, native('deny', 'sample-report') ] });
  const next = parseGrokPermissionDocument(written);
  expect(next.writePermissions(next.permissions)).toBe(written);
  const retracted = next.writePermissions(next.permissions.slice(0, 1));
  expect(nativeRules(retracted)).toEqual(nativeRules(source));
  expect(retracted).toContain('[ui]\npermission_mode = "ask" # unrelated\n');
  expect(retracted).toContain('# preserve me');
});

it('syncs two User owners without duplicating rules and withdraws only the last owned copy', async () => {
  const { env, layout } = getCurrentSourceTestIsolation();
  const host = path.join(layout.homeDir, '.grok-custom');
  const ctx = { cwd: layout.fixtureCwd, env: { ...env, GROK_HOME: host } };
  const manual = native('allow', 'sample-report');
  const destination = path.join(host, 'config.toml');
  await fs.outputFile(destination, '[permission]\nrules = [{ action = "allow", tool = "bash", pattern = "sample-report" }]\n');
  const rules = async () => nativeRules(await fs.readFile(destination, 'utf8'));
  const owners = await Promise.all(['first', 'second'].map(async (name) => {
    const binding = grokBinding(host, name);
    const target = await getInvocationPolicyPath(ctx, binding);
    expect(target).toBe(destination);
    const locator = permissionComponent(binding, target, await getInvocationPolicyPhysicalKey(ctx, binding)).locator;
    return {
      sync: async () => {
        const permissions = [claim('allow', 'sample-report'), claim('deny', 'sample-report', 'private')];
        const { effective, reviewDigest } = await previewHostPermissions(ctx, binding, target, permissions);
        return updateHostPermissions(ctx, locator, { kind: 'grok-permissions', permissions, effective, reviewDigest });
      },
      remove: () => updateHostPermissions(ctx, locator),
    };
  }));
  expect(await owners[0]!.sync()).toBe(true);
  expect(await owners[1]!.sync()).toBe(true);
  expect(await owners[0]!.sync()).toBe(false);
  expect(await rules()).toEqual({ rules: [manual, native('deny', 'sample-report private')] });
  await owners[0]!.remove();
  expect(await rules()).toEqual({ rules: [manual, native('deny', 'sample-report private')] });
  await owners[1]!.remove();
  expect(await rules()).toEqual({ rules: [manual] });
});

it.each(['ask', 'deny'] as const)('withdraws an overlapping allow from another owner while its unrepresentable %s remains', async (effect) => {
  const { env, layout } = getCurrentSourceTestIsolation();
  const host = path.join(layout.homeDir, 'grok');
  const ctx = { cwd: layout.fixtureCwd, env: { ...env, GROK_HOME: host } };
  const destination = path.join(host, 'config.toml');
  const grantor = grokBinding(host, 'grantor');
  const restrictor = grokBinding(host, 'restrictor');
  const grant = claim('allow', 'sample-report');
  const wildcardGrant = claim('allow', 'sample-r?port');
  const independent = claim('allow', 'sample-summary');
  const restriction = claim(effect, 'sample-report', 'draft\u0001');
  const grants = [grant, wildcardGrant, independent];
  const rules = async () => nativeRules(await fs.readFile(destination, 'utf8'));
  const originalRules = { rules: [native('allow', 'sample-r?port'), native('allow', 'sample-report'), native('allow', 'sample-summary')] };

  const grantorLocator = permissionComponent(grantor, destination, await getInvocationPolicyPhysicalKey(ctx, grantor)).locator;
  const original = await previewHostPermissions(ctx, grantor, destination, grants);
  await updateHostPermissions(ctx, grantorLocator, { ...original, kind: 'grok-permissions', permissions: grants });
  expect(await rules()).toEqual(originalRules);

  const restrictorLocator = permissionComponent(restrictor, destination, await getInvocationPolicyPhysicalKey(ctx, restrictor)).locator;
  const preview = await previewHostPermissions(ctx, restrictor, destination, [restriction]);
  expect(preview.skipped).toEqual(expect.arrayContaining([
    { ...grant, pluginId: 'catalog/grantor', reasonCode: 'permission-rule-conflict' },
    { ...wildcardGrant, pluginId: 'catalog/grantor', reasonCode: 'permission-rule-conflict' },
    { ...restriction, pluginId: 'catalog/restrictor', reasonCode: 'grok-shell-pattern-unrepresentable' },
  ]));
  await updateHostPermissions(ctx, restrictorLocator, { ...preview, kind: 'grok-permissions', permissions: [restriction] });
  expect(await rules()).toEqual({ rules: [native('allow', 'sample-summary')] });
  expect((await previewHostPermissions(ctx, grantor, destination, grants)).skipped).toContainEqual({
    ...grant, pluginId: 'catalog/grantor', reasonCode: 'permission-rule-conflict',
  });

  await updateHostPermissions(ctx, restrictorLocator);
  expect(await rules()).toEqual(originalRules);
});

it.each([
  { scope: 'user', name: 'managed_config.toml', manualAllow: true },
  { scope: 'project', name: 'config.toml', manualAllow: false },
] as const)('reports unreadable $name in Review and the $scope write receipt', async ({ scope, name, manualAllow }) => {
  const { env, layout } = getCurrentSourceTestIsolation();
  const projectRoot = await fs.realpath(layout.fixtureCwd);
  const host = path.join(layout.homeDir, 'grok');
  const ctx = { cwd: projectRoot, env: { ...env, GROK_HOME: host } };
  const binding = grokBinding(host, 'reports', scope === 'project' ? { kind: 'project', projectRoot } : { kind: 'user' });
  const unavailable = path.join(host, name);
  const malformed = '[permission]\nrules = [\n';
  await fs.outputFile(unavailable, malformed);
  if (scope === 'project') {
    await fs.outputFile(path.join(host, 'trusted_folders.toml'),
      `[folders.${JSON.stringify(projectRoot)}]\ntrusted = true\ndecided_at = 1700000000\n`);
  }
  const destination = (await getInvocationPolicyPath(ctx, binding))!;
  const manual = '[permission]\nrules = [{ action = "allow", tool = "bash", pattern = "sample-report" }] # local\n';
  if (manualAllow) await fs.outputFile(destination, manual);
  const locator = permissionComponent(binding, destination, await getInvocationPolicyPhysicalKey(ctx, binding)).locator;
  const permissions = [claim('allow', 'sample-report')];
  const preview = await previewHostPermissions(ctx, binding, destination, permissions);
  const warning = expect.objectContaining({ code: 'hostPermissionAdditionalImpact', severity: 'warning',
    detail: { reasonCode: 'grok-additional-rules-unverified', path: unavailable } });
  expect(preview.additionalImpacts).toContainEqual(warning);

  const onNotices = vi.fn();
  await updateHostPermissions(ctx, locator, { ...preview, kind: 'grok-permissions', permissions }, undefined, undefined, onNotices);
  expect(onNotices).toHaveBeenCalledWith(expect.arrayContaining([warning]));
  expect(preview.additionalImpacts.map((notice) => publicDiagnostic(notice, undefined, 'warning'))).toContainEqual(warning);
  expect(nativeRules(await fs.readFile(destination, 'utf8'))).toEqual({ rules: [native('allow', 'sample-report')] });
  if (manualAllow) expect(await fs.readFile(destination, 'utf8')).toBe(manual);
  expect(await fs.readFile(unavailable, 'utf8')).toBe(malformed);
});

it('reports an unreadable layer when a manual restriction covers the entire declaration', async () => {
  const { env, layout } = getCurrentSourceTestIsolation();
  const host = path.join(layout.homeDir, 'grok');
  const ctx = { cwd: layout.fixtureCwd, env: { ...env, GROK_HOME: host } };
  const binding = grokBinding(host, 'reports');
  const destination = path.join(host, 'config.toml');
  const unavailable = path.join(host, 'managed_config.toml');
  const manual = '[permission]\ndeny = ["Bash(sample-report)"]\n';
  await fs.outputFile(destination, manual);
  await fs.outputFile(unavailable, '[permission]\nrules = [\n');
  const locator = permissionComponent(binding, destination, await getInvocationPolicyPhysicalKey(ctx, binding)).locator;
  const permissions = [claim('allow', 'sample-report')];
  const preview = await previewHostPermissions(ctx, binding, destination, permissions);
  expect(preview.effective).toEqual([]);
  expect(preview.skipped).toContainEqual({ ...permissions[0], pluginId: 'catalog/reports', reasonCode: 'permission-rule-conflict' });
  const warning = expect.objectContaining({ code: 'hostPermissionAdditionalImpact',
    detail: { reasonCode: 'grok-additional-rules-unverified', path: unavailable } });
  expect(preview.additionalImpacts).toContainEqual(warning);
  const onNotices = vi.fn();
  await updateHostPermissions(ctx, locator, { ...preview, kind: 'grok-permissions', permissions }, undefined, undefined, onNotices);
  expect(onNotices).toHaveBeenCalledWith([warning]);
  expect(await fs.readFile(destination, 'utf8')).toBe(manual);
});

it('requires saved Project trust before reading or writing the project policy', async () => {
  const { env, layout } = getCurrentSourceTestIsolation();
  const project = await fs.realpath(layout.fixtureCwd);
  const host = path.join(layout.homeDir, 'grok');
  const ctx = { cwd: project, env: { ...env, GROK_HOME: host } };
  const destination = path.join(project, '.grok', 'config.toml');
  const invalid = '[permission]\nrules = [\n';
  await fs.outputFile(destination, invalid);
  await expect(assertGrokPermissionPath(ctx, destination, host, project)).rejects.toMatchObject({ code: 'grokProjectAuthorizationDenied' });
  expect(await fs.readFile(destination, 'utf8')).toBe(invalid);
  expect(await fs.pathExists(path.join(host, 'trusted_folders.toml'))).toBe(false);
});

it('reads relevant native shell rules from the default or overridden User config without changing its bytes', async () => {
  const { env, layout } = getCurrentSourceTestIsolation();
  const ctx = { cwd: layout.fixtureCwd, env };
  const defaults = path.join(layout.homeDir, '.grok', 'config.toml');
  const override = path.join(layout.homeDir, 'grok-override');
  const config = path.join(override, 'config.toml');
  const managed = path.join(override, 'managed_config.toml');
  const source = [
    '# Preserve the user comment and other rules',
    '[permission]',
    'ask = ["Bash(aw command run catalog/guide -- status *)", "Read"]',
    'rules = [',
    '  { action = "allow", tool = "bash", pattern = "aw command run catalog/guide -- *" },',
    '  { action = "deny", tool = "bash", pattern = "aw command run catalog/other -- *" },',
    '  { action = "deny", tool = "bash", pattern = "*catalog/guide*" },',
    '  { action = "ask", tool = "read", pattern = "notes/**" },',
    ']',
    '[ui]',
    'permission_mode = "ask"',
    '',
  ].join('\r\n');
  await fs.outputFile(defaults, '[permission]\ndeny = ["*"]\n');
  await fs.outputFile(config, source);
  await fs.outputFile(managed, '[permission]\ndeny = ["Bash(aw command run catalog/guide -- export *)", "Bash(other)"]\n');

  expect(await inspectGrokPermissionConfig(ctx, argv)).toEqual({
    rules: [{ path: defaults, action: 'deny', pattern: '*' }], readFailures: [],
  });
  expect(await inspectGrokPermissionConfig({ ...ctx, env: { ...env, GROK_HOME: override } }, argv)).toEqual({
    rules: [
      { path: config, action: 'allow', pattern: 'aw command run catalog/guide -- *' },
      { path: config, action: 'deny', pattern: '*catalog/guide*' },
      { path: config, action: 'ask', pattern: 'aw command run catalog/guide -- status *' },
      { path: managed, action: 'deny', pattern: 'aw command run catalog/guide -- export *' },
    ], readFailures: [],
  });
  await fs.writeFile(managed, '[permission]\nrules = [\n');
  expect((await inspectGrokPermissionConfig({ ...ctx, env: { ...env, GROK_HOME: override } }, argv)).readFailures).toEqual([managed]);
  expect(await fs.readFile(config, 'utf8')).toBe(source);
});

it('leaves absent projects quiet and reads project TOML only after an explicit saved grant for that project', async () => {
  const { env, layout } = getCurrentSourceTestIsolation();
  const project = path.join(layout.fixtureCwd, 'project');
  const host = path.join(layout.homeDir, 'grok');
  const config = path.join(project, '.grok', 'config.toml');
  const trust = path.join(host, 'trusted_folders.toml');
  const ctx = { cwd: project, env: { ...env, GROK_HOME: host } };
  expect(await inspectGrokPermissionConfig(ctx, argv, project)).toEqual({ rules: [], readFailures: [] });

  const malformed = '[permission]\nrules = [\n';
  await fs.outputFile(config, malformed);
  const unverified = { rules: [], readFailures: [], unverifiedProjectPath: config };
  expect(await inspectGrokPermissionConfig(ctx, argv, project)).toEqual(unverified);
  expect(await fs.pathExists(trust)).toBe(false);

  const exactRoot = await fs.realpath(project);
  const denied = `[folders.${JSON.stringify(exactRoot)}]\ntrusted = false\ndecided_at = 1700000000\n`;
  await fs.outputFile(trust, denied);
  expect(await inspectGrokPermissionConfig(ctx, argv, project)).toEqual(unverified);
  expect(await fs.readFile(trust, 'utf8')).toBe(denied);
  expect(await fs.readFile(config, 'utf8')).toBe(malformed);

  const granted = `[folders.${JSON.stringify(exactRoot)}]\ntrusted = true\ndecided_at = 1700000000\n`;
  await fs.outputFile(trust, granted);
  expect(await inspectGrokPermissionConfig(ctx, argv, project)).toEqual({ rules: [], readFailures: [config] });
  const source = '# Project matcher\n[[permission.rules]]\naction = "ask"\ntool = "bash"\npattern = "aw command run catalog/guide -- *"\n';
  await fs.outputFile(config, source);
  expect(await inspectGrokPermissionConfig(ctx, argv, project)).toEqual({
    rules: [{ path: config, action: 'ask', pattern: 'aw command run catalog/guide -- *' }], readFailures: [],
  });
  expect(await fs.readFile(config, 'utf8')).toBe(source);
  expect(await fs.readFile(trust, 'utf8')).toBe(granted);
});
