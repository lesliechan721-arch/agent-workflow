import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { mergeOpenCodePermissions, parseOpenCodePermissionDocument, readOpenCodePermissionChain,
  type OpenCodeClaim, type OpenCodeEffect } from '../../src/platforms/opencode-permissions.js';

const tempRoots: string[] = [];
afterEach(async () => { await Promise.all(tempRoots.splice(0).map((dir) => fs.remove(dir))); });

const claim = (effect: OpenCodeEffect, ...tokens: string[]): OpenCodeClaim => ({ effect, tokens, name: 'checks' });
const shell = (effect: OpenCodeEffect, resource: string) => ({ action: 'shell' as const, effect, resource });

it('orders multiple owners independently of install order and protects existing stricter rules', () => {
  const allow = claim('allow', 'git'), ask = claim('ask', 'git', 'show'), deny = claim('deny', 'git', 'show', '--patch');
  const manual = [shell('allow', '*')];
  for (const claims of [[allow, ask, deny], [deny, ask, allow, ask]]) {
    const merged = mergeOpenCodePermissions(claims, manual, [], 'linux');
    expect([...merged.before, ...manual, ...merged.after]).toEqual([
      shell('allow', 'git *'), ...manual, shell('ask', 'git show *'), shell('deny', 'git show --patch *'),
    ]);
    expect(merged.skipped).toEqual([]);
    expect(merged.adjusted).toEqual(expect.arrayContaining([
      expect.objectContaining({ effect: 'allow', resource: 'git *', reasonCode: 'opencode-standard-spelling' }),
      expect.objectContaining({ effect: 'deny', resource: 'git show --patch *', reasonCode: 'opencode-standard-spelling' }),
    ]));
  }
  for (const strict of [shell('ask', '*'), shell('deny', '*'), shell('deny', 'git show --patch *'),
    { action: 'sh?ll', resource: 'g?t *', effect: 'deny' }]) {
    const merged = mergeOpenCodePermissions([allow, ask], [strict], [], 'linux');
    expect(merged.before).toEqual([]);
    expect(merged.skipped).toContainEqual({ ...allow, reasonCode: 'permission-rule-conflict' });
  }
});

it('reports narrower grants and prompts that are fully covered by a broader AW denial in either order', () => {
  const allow = claim('allow', 'reporter', 'summary');
  const ask = claim('ask', 'reporter', 'inspect');
  const deny = claim('deny', 'reporter');
  for (const declarations of [[allow, ask, deny], [deny, ask, allow]]) {
    const merged = mergeOpenCodePermissions(declarations, [], [], 'linux');
    expect(merged.effective).toEqual([shell('deny', 'reporter *')]);
    expect(merged.before).toEqual([]);
    expect(merged.after).toEqual([shell('deny', 'reporter *')]);
    expect(merged.skipped).toHaveLength(2);
    expect(merged.skipped).toEqual(expect.arrayContaining([allow, ask].map((item) => ({ ...item, reasonCode: 'permission-rule-conflict' }))));
  }
});

it('keeps a narrower manual restriction after a broader AW grant and names the overlapping rule', () => {
  const requested = claim('allow', 'reporter');
  const explicit = shell('deny', 'reporter details *');
  const merged = mergeOpenCodePermissions([requested], [explicit], [], 'linux');
  expect([...merged.before, explicit, ...merged.after]).toEqual([shell('allow', 'reporter *'), explicit]);
  expect(merged.effective).toEqual([shell('allow', 'reporter *')]);
  expect(merged.skipped).toEqual([]);
  expect(merged.adjusted).toContainEqual(expect.objectContaining({ resource: 'reporter *', reasonCode: 'opencode-manual-restriction-preserved',
    message: expect.stringContaining('reporter details *') }));
  expect(mergeOpenCodePermissions([requested], [], [{ layer: 'lower', rule: explicit }], 'linux').effective).toEqual([]);
});

it('retains an effective duplicate only when a user rule later relaxes a matching request', () => {
  const ask = claim('ask', 'git', 'show'), same = shell('ask', 'git show *');
  expect(mergeOpenCodePermissions([ask], [same], [], 'linux').after).toEqual([]);
  expect(mergeOpenCodePermissions([ask], [same, shell('allow', '*')], [], 'linux').after).toEqual([same]);
  expect(mergeOpenCodePermissions([ask], [same, shell('allow', 'git showroom *')], [], 'linux').after).toEqual([]);
});

it('reports a restrictive rule masked in a higher scope while keeping it for other consumers', () => {
  const allow = claim('allow', 'git'), deny = claim('deny', 'git', 'push');
  const merged = mergeOpenCodePermissions([allow, deny], [], [{ path: 'agent.md', layer: 'higher', rule: shell('allow', '*') }], 'linux');
  expect(merged.before).toEqual([]);
  expect(merged.after).toEqual([shell('deny', 'git push *')]);
  expect(merged.effective).toEqual([]);
  expect(merged.skipped).toEqual([{ ...deny, reasonCode: 'permission-rule-conflict' }, { ...allow, reasonCode: 'permission-rule-conflict' }]);
});

it('withholds a broad grant when a literal restriction cannot be encoded and preserves unrelated tokens', () => {
  const allow = claim('allow', 'git'), deny = claim('deny', 'git', '#note'), other = claim('allow', 'git-other', 'a+b');
  const merged = mergeOpenCodePermissions([allow, deny, other], [], [], 'linux');
  expect(merged.skipped).toEqual([{ ...deny, reasonCode: 'permission-prefix-unrepresentable' }, { ...allow, reasonCode: 'permission-rule-conflict' }]);
  expect(merged.before).toEqual([shell('allow', 'git-other a+b *')]);
});

it('projects standard Windows spellings with a case and slash warning and respects existing case-insensitive rules', () => {
  const supported = claim('allow', 'aw', 'command', 'run', 'fixture/report', '--', 'show');
  const unsupported = [claim('ask', 'tool', '1,'), claim('deny', 'tool', '@1'), claim('allow', 'tool', '%ROOT%')];
  const percent = claim('allow', 'reporter', '100%');
  const windows = mergeOpenCodePermissions([supported, percent, ...unsupported], [], [], 'win32');
  const resource = 'aw command run fixture/report -- show *';
  expect(windows.effective).toEqual([shell('allow', resource), shell('allow', 'reporter 100% *')]);
  expect(windows.skipped).toEqual(unsupported.map((item) => ({ ...item, reasonCode: 'opencode-windows-command-syntax' })));
  expect(windows.adjusted).toContainEqual(expect.objectContaining({ effect: 'allow', resource,
    reasonCode: 'opencode-standard-spelling', message: expect.stringContaining('case and slash variants') }));

  const existing = { ...shell('deny', 'AW COMMAND RUN FIXTURE\\REPORT -- SHOW *'), action: 'SHELL' };
  const protectedRules = mergeOpenCodePermissions([supported], [existing], [], 'win32');
  expect(protectedRules.before).toEqual([]);
  expect(protectedRules.skipped).toEqual([{ ...supported, reasonCode: 'permission-rule-conflict' }]);

  const skippedRestriction = claim('deny', 'AW', 'COMMAND', 'RUN', 'FIXTURE/REPORT', '--', 'SHOW', '@1');
  const overlapping = mergeOpenCodePermissions([supported, skippedRestriction], [], [], 'win32');
  expect(overlapping.before).toEqual([]);
  expect(overlapping.skipped).toContainEqual({ ...supported, reasonCode: 'permission-rule-conflict' });
});

it('discloses native wildcard widening and withholds rules that would weaken a known explicit restriction', () => {
  const wildcard = claim('allow', 'reporter', 'task?');
  const anotherGrant = claim('allow', 'reporter', 'task1');
  const restriction = claim('deny', 'reporter', 'task?');
  const merged = mergeOpenCodePermissions([wildcard], [], [], 'linux');
  expect(merged.before).toEqual([shell('allow', 'reporter task? *')]);
  expect(merged.adjusted).toContainEqual(expect.objectContaining({ resource: 'reporter task? *', reasonCode: 'opencode-single-character-wildcard' }));
  expect(mergeOpenCodePermissions([wildcard], [shell('deny', 'reporter task1 *')], [], 'linux').before).toEqual([]);
  const constrained = mergeOpenCodePermissions([anotherGrant, restriction], [], [], 'linux');
  expect(constrained.effective).toEqual([shell('deny', 'reporter task? *')]);
  expect(constrained.skipped).toEqual([{ ...anotherGrant, reasonCode: 'permission-rule-conflict' }]);
});

it('supports Unicode words and preserves strict selection for equivalent Windows spellings', () => {
  const allow = claim('allow', 'reporter', 'café');
  const ask = claim('ask', 'Reporter', 'CAFÉ');
  const windows = mergeOpenCodePermissions([allow, ask], [], [], 'win32');
  expect(windows.effective).toEqual([shell('ask', 'Reporter CAFÉ *')]);
  expect(windows.adjusted).toEqual([expect.objectContaining({ effect: 'ask', resource: 'Reporter CAFÉ *',
    message: expect.stringContaining('Remembered OpenCode approvals') })]);
  const linux = mergeOpenCodePermissions([allow], [], [], 'linux');
  expect(linux.effective).toEqual([shell('allow', 'reporter café *')]);
  expect(linux.adjusted).toEqual([expect.objectContaining({ resource: 'reporter café *', reasonCode: 'opencode-standard-spelling' })]);
});

it('preserves literal brackets and braces while disclosing possible shell expansion', () => {
  const declaration = claim('ask', 'reporter', 'section[1]', 'version{1}');
  const merged = mergeOpenCodePermissions([declaration], [], [], 'linux');
  const resource = 'reporter section[1] version{1} *';
  expect(merged.after).toEqual([shell('ask', resource)]);
  expect(merged.adjusted).toContainEqual(expect.objectContaining({ resource, reasonCode: 'opencode-shell-expansion' }));
  const substituted = claim('allow', 'reporter', '{env:REPORT}');
  expect(mergeOpenCodePermissions([substituted], [], [], 'linux').skipped)
    .toEqual([{ ...substituted, reasonCode: 'permission-prefix-unrepresentable' }]);
});

it('edits only generated entries, retaining the source spelling and comments of manual controls', () => {
  const original = '{\n// my configuration\n"revision":90071992547409931,\n"permissions":[ /*manual*/ {"action":"shel\\u006c", "resource":"git *","effect":"ask"}, // note\n],\n}';
  const doc = parseOpenCodePermissionDocument(original);
  const changed = doc.writePermissions([shell('allow', 'aw check *'), ...doc.permissions, shell('deny', 'git push *')]);
  expect(changed).toContain('"revision":90071992547409931');
  expect(changed).toContain('/*manual*/ {"action":"shel\\u006c", "resource":"git *","effect":"ask"}');
  expect(changed).toContain('// note');
  const updated = parseOpenCodePermissionDocument(changed);
  expect(updated.permissions).toEqual([shell('allow', 'aw check *'), shell('ask', 'git *'), shell('deny', 'git push *')]);
  const restored = updated.writePermissions(updated.permissions.slice(1, 2));
  expect(parseOpenCodePermissionDocument(restored).permissions).toEqual(doc.permissions);
  expect(restored).toContain('// note');
  expect(() => parseOpenCodePermissionDocument('{"permissions":[],"permissions":[]}')).toThrow('permissionConfigConflict');
  expect(() => parseOpenCodePermissionDocument('{"permissions":[{"action":"shell","resource":"report *","effect":false}]}')).toThrow('permissionConfigConflict');
});

it('loads the selected project, JSONC siblings and agent restrictions while user scope excludes the working directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-opencode-policy-'));
  tempRoots.push(root);
  const home = path.join(root, 'home'), project = path.join(root, 'project'), cwd = path.join(project, 'nested');
  const target = path.join(project, 'opencode.json');
  const user = path.join(home, 'opencode.json');
  const claims = [claim('allow', 'git', 'status'), claim('ask', 'git', 'add')];
  await fs.outputFile(user, '{"permissions":[{"action":"shell","resource":"*","effect":"allow"}]}');
  await fs.outputFile(path.join(project, 'opencode.jsonc'), '{"permissions":[{"action":"shell","resource":"git status *","effect":"ask"},]}');
  await fs.outputFile(path.join(project, '.opencode/agents/nested/custom.md'), '---\npermissions:\n  - {action: shell, resource: "git add *", effect: deny}\n---\nReview the change.');
  const ctx = { cwd, env: { HOME: home }, platform: 'linux' as const };
  const empty = parseOpenCodePermissionDocument('{}');
  const chain = await readOpenCodePermissionChain(ctx, target, home, project, empty);
  expect(mergeOpenCodePermissions(claims, [], chain, 'linux').effective).toEqual([]);
  const userChain = await readOpenCodePermissionChain(ctx, user, home, undefined, empty);
  expect(mergeOpenCodePermissions(claims, [], userChain, 'linux').skipped).toEqual([]);
  const disabled = await readOpenCodePermissionChain({ ...ctx, env: { ...ctx.env, OPENCODE_CONFIG_PROJECT_DISABLE: '1' } }, target, home, project, empty);
  expect(mergeOpenCodePermissions(claims, [], disabled, 'linux').skipped.map((item) => item.reasonCode)).toEqual(['config-disabled', 'config-disabled']);
});

it('uses the configured global directory and preserves legitimate agent mode metadata', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-opencode-root-'));
  tempRoots.push(base);
  const user = path.join(base, 'global'), fallback = path.join(base, 'xdg'), project = path.join(base, 'project');
  const destination = path.join(project, 'opencode.json');
  const ctx = { cwd: project, env: { HOME: base, OPENCODE_CONFIG_DIR: user }, platform: 'linux' as const };
  await fs.outputJson(path.join(user, 'opencode.json'), { agents: { build: { mode: 'primary' } }, permissions: [shell('deny', 'blocked *')] });
  await fs.outputJson(path.join(fallback, 'opencode.json'), { permissions: [shell('deny', '*')] });
  await fs.outputFile(path.join(user, 'agents/reviewer.md'), '---\nmode: subagent\ndescription: Reviews files\n---\nReview documents.');
  const doc = parseOpenCodePermissionDocument('{"agents":{"general":{"mode":"all"}}}');
  const chain = await readOpenCodePermissionChain(ctx, destination, fallback, project, doc);
  const merged = mergeOpenCodePermissions([claim('allow', 'report'), claim('allow', 'blocked')], [], chain, 'linux');
  expect(merged.effective).toEqual([shell('allow', 'report *')]);
  expect(merged.skipped.map((entry) => entry.tokens)).toEqual([['blocked']]);
  const legacy = parseOpenCodePermissionDocument('{"agents":{"old":{"mode":"primary","tools":{"bash":false}}}}');
  expect(mergeOpenCodePermissions([claim('allow', 'report')], [], legacy.agentRules, 'linux').effective).toEqual([]);
});

it('discloses an unverified secondary layer while preserving positively identified manual restrictions', () => {
  const requested = claim('allow', 'reporter', 'summary');
  const layer = { layer: 'higher', path: 'opencode.jsonc', rule: null };
  const merged = mergeOpenCodePermissions([requested], [], [layer], 'linux');
  expect(merged.effective).toEqual([shell('allow', 'reporter summary *')]);
  expect(merged.adjusted).toContainEqual(expect.objectContaining({ effect: 'allow', reasonCode: 'opencode-additional-rules-unverified',
    message: expect.stringContaining('opencode.jsonc') }));
  const strict = { layer: 'higher', path: 'opencode.jsonc', rule: shell('deny', 'reporter *') };
  expect(mergeOpenCodePermissions([requested], [], [layer, strict], 'linux').skipped)
    .toEqual([{ ...requested, reasonCode: 'permission-rule-conflict' }]);
});
