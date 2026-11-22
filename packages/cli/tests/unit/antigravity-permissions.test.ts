import path from 'node:path';
import fs from 'fs-extra';
import { expect, it } from 'vitest';

import { antigravityPermissionResources, mergeAntigravityPermissions, parseAntigravityPermissionDocument } from '../../src/platforms/antigravity-permissions.js';
import type { DeploymentBinding } from '../../src/platforms/contracts.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import { getInvocationPolicyPath, getInvocationPolicyPhysicalKey } from '../../src/platforms/layout.js';
import { inspectHostPermissionDelivery, permissionComponent, previewHostPermissions, updateHostPermissions } from '../../src/platforms/permission-ownership.js';
import { commitPermissionOwnership, readPermissionHost, readPermissionSidecar } from '../../src/platforms/permission-sidecar.js';
import { inspectManagedCommandRouteChanges } from '../../src/utils/managed-command-cli-review.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

it.each(['darwin', 'linux', 'win32'] as const)('renders plain command words with native action lists on %s', (platform) => {
  const document = parseAntigravityPermissionDocument(JSON.stringify({
    agentMode: 'auto',
    permissions: {
      allow: ['read_file(report)', 'command(probe manual)'],
      ask: ['mcp(service/tool)'],
      deny: ['command(regex:probe\\x20personal)'],
      futureSetting: 'keep',
    },
  }));
  const command = ['aw', 'command', 'run', 'fixture/report', '--'];
  const result = mergeAntigravityPermissions([
    { name: 'shared', effect: 'allow', tokens: ['probe', 'manual'] },
    { name: 'report', effect: 'allow', tokens: [...command, 'show'] },
    { name: 'report', effect: 'ask', tokens: [...command, 'confirm'] },
    { name: 'report', effect: 'deny', tokens: [...command, 'blocked'] },
  ], document.permissions, platform);
  expect(result.skipped).toEqual([]);
  expect(JSON.parse(document.writePermissions([...result.before, ...document.permissions, ...result.after]))).toEqual({
    agentMode: 'auto',
    permissions: {
      allow: ['read_file(report)', 'command(probe manual)', 'command(aw command run fixture/report -- show)'],
      ask: ['mcp(service/tool)', 'command(aw command run fixture/report -- confirm)'],
      deny: ['command(regex:probe\\x20personal)', 'command(aw command run fixture/report -- blocked)'],
      futureSetting: 'keep',
    },
  });
});

function rawMatcher(resource: string) {
  return new RegExp(`^(?:${resource.slice('command(regex:'.length, -1)})$`, 'u');
}

const legacyPosixRule = String.raw`command(regex:[\x20\t]*(?:probe|'probe'|"probe")[\x20\t]+(?:'report\?'|"report\?")(?:[\x20\t]+(?:[-\p{L}\p{M}\p{N}_./:@%+=,]+|'[^'\r\n]*'|"(?:[^"\\$\x60\r\n]|\\[^\r\n])*"|\\[^\r\n])+)*[\x20\t]*)`;
const legacyWindowsRule = String.raw`command(regex:[\x20\t]*(?:probe|"probe")[\x20\t]+(?:"report\?")(?:[\x20\t]+(?:[-\p{L}\p{M}\p{N}_./:@+=,]+|"[^"\r\n%!?^&|<>]*")+)*[\x20\t]*)`;

it('configures Windows command paths and punctuation without interpreting a literal word as a regex', () => {
  const { effective, skipped, adjusted } = mergeAntigravityPermissions([
    { name: 'report', effect: 'allow', tokens: [String.raw`C:\Tools\probe.exe`, 'text'] },
    { name: 'protect', effect: 'deny', tokens: ['C:/Tools/probe.exe', 'text', '%VARIABLE%'] },
    { name: 'ordinary', effect: 'ask', tokens: ['probe', 'confirm'] },
    { name: 'reserved', effect: 'deny', tokens: ['regex:probe', 'test.value'] },
    { name: 'special', effect: 'ask', tokens: ['probe', 'literal?'] },
  ], [], 'win32');
  expect(effective).toEqual(expect.arrayContaining([
    { action: 'shell', effect: 'allow', resource: String.raw`command(C:\Tools\probe.exe text)` },
    { action: 'shell', effect: 'ask', resource: 'command(probe confirm)' },
    { action: 'shell', effect: 'deny', resource: 'command(C:/Tools/probe.exe text %VARIABLE%)' },
    { action: 'shell', effect: 'deny', resource: String.raw`command(regex:regex:probe test\.value)` },
  ]));
  expect(skipped).toEqual([]);
  const pathRule = adjusted.find(({ name, reasonCode }) => name === 'report' && reasonCode === 'antigravity-command-raw-match')!;
  const matches = rawMatcher(pathRule.resource);
  expect(matches.test('C:/Tools/probe.exe text')).toBe(true);
  expect(matches.test(String.raw`"C:\Tools\probe.exe" text --format`)).toBe(true);
  expect(matches.test('"C:/Tools/probe.exe" text --format "long name"')).toBe(true);
  expect(matches.test('C:/Tools/probe.exe textual')).toBe(false);
  expect(matches.test('C:/Tools/probe.exe text | probe unrelated')).toBe(false);
  expect(matches.test('C:/Tools/probe.exe text "%UNTRUSTED%"')).toBe(false);
  const special = rawMatcher(adjusted.find(({ name }) => name === 'special')!.resource);
  expect(special.test('probe "literal?"')).toBe(true);
  expect(special.test('probe literalx')).toBe(false);
});

it('configures Unicode, exact-line and inner-command forms, with concrete projection notices', () => {
  const { effective, skipped, adjusted } = mergeAntigravityPermissions([
    { name: 'normal', effect: 'allow', tokens: ['git', 'status'] },
    { name: 'international', effect: 'allow', tokens: ['echo', 'café'] },
    { name: 'pager', effect: 'deny', tokens: ['git', '-c', 'core.pager=probe'] },
    { name: 'wrapper', effect: 'ask', tokens: ['env', 'LC_ALL=C', 'probe', 'report'] },
    { name: 'options', effect: 'deny', tokens: ['env', '--unknown-option', 'git', 'status'] },
  ], [], 'darwin');
  expect(effective).toEqual(expect.arrayContaining([
    { action: 'shell', effect: 'allow', resource: 'command(git status)' },
    { action: 'shell', effect: 'allow', resource: 'command(echo café)' },
    { action: 'shell', effect: 'ask', resource: 'command(probe report)' },
  ]));
  expect(skipped).toEqual([expect.objectContaining({ name: 'options', effect: 'deny', reasonCode: 'antigravity-command-matching-unverified' })]);
  expect(adjusted).toContainEqual(expect.objectContaining({ name: 'wrapper', effect: 'ask', reasonCode: 'antigravity-unwraps-command',
    resource: 'command(probe report)', message: expect.stringContaining('invoked directly') }));
  const matches = rawMatcher(adjusted.find(({ name }) => name === 'pager')!.resource);
  expect(matches.test('git -c core.pager=probe')).toBe(true);
  expect(matches.test(`git -c 'core.pager=probe' log --oneline`)).toBe(true);
  expect(matches.test('git -c core.pager=probex')).toBe(false);
  expect(matches.test('git -c core.pager=probe log && probe unrelated')).toBe(false);
});

it('reports an action masked by a stronger Antigravity user rule', () => {
  const manual = parseAntigravityPermissionDocument('{"permissions":{"deny":["command(probe report)"]}}');
  const { effective, adjusted, skipped } = mergeAntigravityPermissions([
    { name: 'protected', effect: 'allow', tokens: ['env', 'probe', 'report', 'summary'] },
    { name: 'separate', effect: 'allow', tokens: ['echo', 'report'] },
    { name: 'other-subcommands', effect: 'allow', tokens: ['probe'] },
  ], manual.permissions, 'darwin');
  expect(effective).toEqual([
    { action: 'shell', effect: 'allow', resource: 'command(echo report)' },
    { action: 'shell', effect: 'allow', resource: 'command(probe)' },
  ]);
  expect(adjusted).toEqual([expect.objectContaining({
    name: 'other-subcommands', effect: 'allow', reasonCode: 'antigravity-user-rule-precedence', resource: 'command(probe)',
  })]);
  expect(skipped).toEqual([expect.objectContaining({ name: 'protected', effect: 'allow', reasonCode: 'permission-rule-conflict' })]);
});

const legacyRules = [['darwin', legacyPosixRule], ['win32', legacyWindowsRule]] as const;

it.each(legacyRules)('recognizes both spellings of the same manual Antigravity rule on %s', (platform, legacy) => {
  const claim = { name: 'report', effect: 'allow' as const, tokens: ['probe', 'report?'] };
  const resources = antigravityPermissionResources(claim, platform);
  expect(resources).toHaveLength(2);
  const literal = resources[0]!;
  const raw = resources[1]!;
  expect(raw).not.toBe(legacy);
  for (const resource of [raw, legacy]) {
    const matches = rawMatcher(resource);
    expect(matches.test('probe "report?"')).toBe(true);
    expect(matches.test('"probe" "report?" --format "short name"')).toBe(true);
    expect(matches.test('probe "report?" --name=ab"cd"')).toBe(true);
    expect(matches.test('probe "report?" --format | other')).toBe(false);
    expect(matches.test('probe "report?extra"')).toBe(false);
  }
  const reconcile = (permissions: Record<string, string[]>) => {
    const { permissions: manual } = parseAntigravityPermissionDocument(JSON.stringify({ permissions }));
    return mergeAntigravityPermissions([claim], manual, platform);
  };

  for (const manualResource of [raw, legacy]) {
    const bothBlocked = reconcile({ deny: [literal, manualResource] });
    expect(bothBlocked.effective).toEqual([]);
    expect(bothBlocked.skipped).toEqual([{ ...claim, reasonCode: 'permission-rule-conflict' }]);

    const blockedRaw = reconcile({ ask: [manualResource] });
    expect(blockedRaw.effective).toEqual([{ action: 'shell', effect: 'allow', resource: literal }]);
    expect(blockedRaw.skipped).toEqual([]);
    expect(blockedRaw.adjusted).toContainEqual(expect.objectContaining({
      resource: literal, reasonCode: 'antigravity-user-rule-precedence', message: expect.stringContaining('raw command form'),
    }));

    const suppliedRaw = reconcile({ allow: [manualResource] });
    expect(suppliedRaw.after).toEqual([{ action: 'shell', effect: 'allow', resource: literal }]);
    expect(suppliedRaw.effective).toContainEqual({ action: 'shell', effect: 'allow', resource: manualResource });
  }

  const blockedLiteral = reconcile({ deny: [literal] });
  expect(blockedLiteral.effective).toEqual([{ action: 'shell', effect: 'allow', resource: raw }]);
  expect(blockedLiteral.adjusted).toContainEqual(expect.objectContaining({
    resource: raw, reasonCode: 'antigravity-user-rule-precedence', message: expect.stringContaining('parsed command words'),
  }));

  const restored = reconcile({});
  expect(restored.skipped).toEqual([]);
  expect(restored.effective.map(({ resource }) => resource)).toEqual([...resources].sort());
});

it.each([false, true])('recognizes prior Global rules through status, sync and removal (manual: %s)', async (manualLegacy) => {
  const { env, layout } = getCurrentSourceTestIsolation();
  const cwd = layout.fixtureCwd;
  const ctx = { cwd, env, platform: 'darwin' as const };
  const binding: DeploymentBinding = { id: 'binding', platform: 'antigravity', route: 'antigravity-cli', scope: { kind: 'user' },
    plugin: { pluginId: 'fixture/report', sourceId: 'fixture', sourceIdentity: 'sha256:' + 'a'.repeat(64), version: '1.0.0' },
    consumers: [{ id: 'cli', product: 'cli', version: '1.5.14', availability: 'available', reasonCodes: [],
      entry: { kind: 'cli', executable: process.execPath, configRoot: resolvePlatformConfigRoot('antigravity', { cwd, env }) } }],
    physicalKey: '', activationKey: '', renderUnitIds: [] };
  const destination = await getInvocationPolicyPath(ctx, binding);
  const { locator } = permissionComponent(binding, destination, await getInvocationPolicyPhysicalKey(ctx, binding));
  const claims = [{ name: 'report', effect: 'ask' as const, tokens: ['probe', 'report?'] }];
  const literal = 'command(probe report?)';
  const initial = ['read_file(report)', ...(manualLegacy ? [legacyPosixRule] : [])];
  await fs.outputJson(destination, { permissions: { ask: initial } });
  const host = await readPermissionHost(destination);
  const document = parseAntigravityPermissionDocument(host!);
  const snapshot = await readPermissionSidecar(env, 'antigravity', destination);
  const priorRules = [literal, legacyPosixRule].map((resource) => ({ action: 'shell', resource, effect: 'ask' }));
  await commitPermissionOwnership({ snapshot, host, document, owners: { [locator.ownerKey]: claims },
    manual: document.permissions, before: [], after: manualLegacy ? priorRules.slice(0, 1) : priorRules,
    effective: priorRules, verifyChain: async () => {} });
  const oldBytes = await fs.readFile(destination);
  expect(await inspectHostPermissionDelivery(ctx, binding, claims)).toBeUndefined();
  await fs.writeJson(destination, { permissions: { ask: ['read_file(report)', literal] } });
  expect(await inspectHostPermissionDelivery(ctx, binding, claims)).toMatchObject({ content: 'drifted', diagnostic: { code: 'componentOutputMissing' } });
  await fs.writeFile(destination, oldBytes);

  const review = await previewHostPermissions(ctx, binding, destination, claims);
  await updateHostPermissions(ctx, locator, { kind: 'antigravity-permissions', permissions: claims,
    effective: review.effective, reviewDigest: review.reviewDigest });
  const newRaw = antigravityPermissionResources(claims[0]!, 'darwin')[1];
  expect((await fs.readJson(destination)).permissions.ask).toEqual(manualLegacy ? [...initial, literal] : [...initial, literal, newRaw]);
  if (manualLegacy) expect(await fs.readFile(destination)).toEqual(oldBytes);
  expect(await inspectHostPermissionDelivery(ctx, binding, claims)).toBeUndefined();
  await updateHostPermissions(ctx, locator);
  expect((await fs.readJson(destination)).permissions.ask).toEqual(initial);
});

it('merges identical words by the strongest declared action regardless of owner order', () => {
  const tokens = ['probe', 'report'];
  const claims = [
    { name: 'grant', effect: 'allow' as const, tokens },
    { name: 'confirm', effect: 'ask' as const, tokens },
    { name: 'restrict', effect: 'deny' as const, tokens },
    { name: 'narrow', effect: 'allow' as const, tokens: [...tokens, 'summary'] },
  ];
  const projected = (declarations: typeof claims) => {
    const document = parseAntigravityPermissionDocument('{}');
    const { before, after, skipped } = mergeAntigravityPermissions(declarations, document.permissions, 'darwin');
    return { config: JSON.parse(document.writePermissions([...before, ...after])), skipped };
  };
  expect(projected(claims).config).toEqual({ permissions: { deny: ['command(probe report)'] } });
  expect(projected([...claims].reverse()).config).toEqual(projected(claims).config);
  expect(projected(claims).skipped).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'grant', effect: 'allow', reasonCode: 'permission-rule-conflict' }),
    expect.objectContaining({ name: 'confirm', effect: 'ask', reasonCode: 'permission-rule-conflict' }),
    expect.objectContaining({ name: 'narrow', effect: 'allow', reasonCode: 'permission-rule-conflict' }),
  ]));
  expect(projected(claims.filter(({ name }) => name === 'narrow')).config)
    .toEqual({ permissions: { allow: ['command(probe report summary)'] } });
});

it('only reviews configured Global approval candidates and never infers a live decision', async () => {
  const { env, layout } = getCurrentSourceTestIsolation();
  const cwd = layout.fixtureCwd;
  const discovery = resolvePlatformConfigRoot('antigravity', { cwd, env });
  const global = path.join(path.dirname(discovery), 'antigravity-cli', 'settings.json');
  const command = ['aw', 'command', 'run', 'fixture/report', '--', 'summary'];
  const blocked = ['aw', 'command', 'run', 'fixture/report', '--', 'future'];
  await fs.outputJson(path.join(discovery, 'settings.json'), { permissions: { allow: ['command(*)'] } });
  await fs.outputJson(path.join(cwd, '.agents', 'settings.json'), { permissions: { allow: ['command(*)'] } });
  await fs.outputJson(global, { permissions: { allow: [
    `command(${command.join(' ')})`, 'command(aw command run other/report -- summary)', 'command(regex:example)',
  ], deny: [`command(${blocked.join(' ')})`], ask: ['read_file(report)', 'command(env aw command run fixture/report -- summary)'] } });
  const settings = await fs.readFile(global);
  const before = { subcommands: [{ name: 'summary', runner: 'node' as const, entry: 'old.mjs', args: [], cwd: 'caller' as const }] };
  const after = { subcommands: [{ ...before.subcommands[0]!, entry: 'new.mjs' }] };
  const review = await inspectManagedCommandRouteChanges({ selector: 'fixture/report', cwd, env, before, after, inspectInactiveRestrictions: true });
  expect(review.affectedPermissions.filter(({ platform }) => platform === 'antigravity')).toEqual([
    { platform: 'antigravity', path: global, action: 'allow', argvPrefix: command },
    { platform: 'antigravity', path: global, action: 'allow', argvPrefix: command.slice(0, 5), resourcePattern: 'configured command pattern' },
    { platform: 'antigravity', path: global, action: 'ask', argvPrefix: command.slice(0, 5), resourcePattern: 'configured command pattern' },
    { platform: 'antigravity', path: global, action: 'deny', argvPrefix: blocked, handlerUnavailable: true },
  ]);
  expect(await fs.readFile(global)).toEqual(settings);

  await fs.writeFile(global, '{"permissions":{"allow":[],"allow":[]}}\n');
  const invalid = await inspectManagedCommandRouteChanges({ selector: 'fixture/report', cwd, env, before, after });
  expect(invalid.permissionReadFailures).toContain(global);
  expect(invalid.affectedPermissions.filter(({ platform }) => platform === 'antigravity')).toEqual([]);
});
