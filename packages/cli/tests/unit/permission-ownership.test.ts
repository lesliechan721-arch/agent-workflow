import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import type { DeploymentBinding } from '../../src/platforms/contracts.js';
import { getInvocationPolicyPath, getInvocationPolicyPhysicalKey } from '../../src/platforms/layout.js';
import { missingPermissionOwnershipWarning, permissionComponent, previewOpenCodePermissions, previewPermissionBatch, relatedProjectPermissionNotices,
  reviewPermissionRemovals, updateHostPermissions, offlinePermissionComponents } from '../../src/platforms/permission-ownership.js';
import { commitPermissionOwnership, readPermissionSidecar, type PermissionClaim } from '../../src/platforms/permission-sidecar.js';
import * as safeFiles from '../../src/utils/safe-fs.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
const claim = (effect: PermissionClaim['effect'], ...tokens: string[]): PermissionClaim => ({ name: 'commands', tokens, effect });
const rule = (effect: PermissionClaim['effect'], ...tokens: string[]) => ({ action: 'shell', effect, resource: tokens.join(' ') + ' *' });

async function fixture(manual: unknown[] = []) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-permission-')));
  dirs.push(root);
  const hostConfigRoot = path.join(root, 'xdg/opencode');
  const env = { AW_HOME: path.join(root, 'aw'), HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.dirname(hostConfigRoot) };
  const ctx = { cwd: root, env, platform: 'linux' as const };
  await fs.mkdir(hostConfigRoot, { recursive: true });
  const base: DeploymentBinding = { id: 'binding', platform: 'opencode', route: 'opencode-directory', scope: { kind: 'user' },
    plugin: { pluginId: 'src/first', sourceId: 'src', sourceIdentity: 'sha256:' + 'a'.repeat(64), version: '1.0.0' },
    consumers: [{ id: 'cli', product: 'cli', version: '2.2.6', availability: 'available', reasonCodes: [], entry: { kind: 'directory', configRoot: hostConfigRoot } }],
    physicalKey: '', activationKey: '', renderUnitIds: [] };
  const target = await getInvocationPolicyPath(ctx, base);
  await fs.writeFile(target, JSON.stringify({ model: 'custom', permissions: manual }));
  const owner = async (name: string, projectRoot?: string) => {
    if (projectRoot) await fs.mkdir(projectRoot, { recursive: true });
    const scope = projectRoot ? { kind: 'project' as const, projectRoot } : base.scope;
    const binding = { ...base, scope, plugin: { ...base.plugin, pluginId: 'src/' + name } };
    const scoped = projectRoot ? { ...ctx, cwd: projectRoot } : ctx;
    const destination = await getInvocationPolicyPath(scoped, binding);
    const locator = permissionComponent(binding, destination, await getInvocationPolicyPhysicalKey(scoped, binding)).locator;
    const prepare = async (claims: PermissionClaim[]) => {
      const review = await previewOpenCodePermissions(scoped, binding, destination, claims);
      return { kind: 'opencode-permissions', permissions: claims, effective: review.effective, reviewDigest: review.reviewDigest };
    };
    return { binding, locator, prepare, destination, sync: async (claims: PermissionClaim[]) => {
      const plan = await prepare(claims);
      const owners = { [locator.ownerKey]: claims };
      const preview = await previewPermissionBatch(scoped, locator, claims, owners);
      return updateHostPermissions(scoped, locator, plan, undefined, { ...preview, owners });
    },
      remove: () => updateHostPermissions(scoped, locator) };
  };
  return { root, target, env, ctx, owner, first: await owner('first'), second: await owner('second'),
    rules: async () => JSON.parse(await fs.readFile(target, 'utf8')).permissions,
    sidecar: path.join(env.AW_HOME, 'platforms/opencode/permission-ownership', createHash('sha256').update(target).digest('hex') + '.json') };
}

it('preserves an equal manual rule and co-owned output across resync and removal in either order', async () => {
  const manual = [rule('ask', 'shell-check'), rule('deny', 'other')];
  const f = await fixture(manual);
  const claims = [claim('ask', 'shell-check'), claim('deny', 'lint')];
  expect(await f.first.sync(claims)).toBe(true);
  expect(await f.second.sync(claims)).toBe(true);
  const bytes = await fs.readFile(f.sidecar, 'utf8');
  expect(await f.first.sync(claims)).toBe(false);
  expect(await fs.readFile(f.sidecar, 'utf8')).toBe(bytes);
  expect(await f.rules()).toEqual([...manual, rule('deny', 'lint')]);
  expect((await offlinePermissionComponents(f.ctx, undefined)).map((component) => component.identity.plugin).sort()).toEqual(['first', 'second']);
  await f.first.remove();
  expect(await f.rules()).toEqual([...manual, rule('deny', 'lint')]);
  await f.second.remove();
  expect(await f.rules()).toEqual(manual);
  await expect(fs.stat(f.sidecar)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps a Project grant from covering a skipped User restriction', async () => {
  const f = await fixture();
  const project = await f.owner('project', path.join(f.root, 'project'));
  await f.first.sync([claim('deny', 'reports', 'personal', '#note')]);
  expect(await f.rules()).toEqual([]);
  const claims = [claim('allow', 'reports'), claim('allow', 'reports', 'public')];
  expect((await project.prepare(claims)).effective).toEqual([rule('allow', 'reports', 'public')]);
  await project.sync(claims);
  expect(JSON.parse(await fs.readFile(project.destination, 'utf8')).permissions).toEqual([rule('allow', 'reports', 'public')]);
});

it.each([false, true])('applies the stricter User restriction in recorded projects and reviews restoration (User first %s)', async (userFirst) => {
  const f = await fixture();
  const outer = await f.owner('outer', path.join(f.root, 'parent'));
  const nested = await f.owner('nested', path.join(f.root, 'parent', 'nested'));
  const elsewhere = await f.owner('elsewhere', path.join(f.root, 'elsewhere'));
  const grant = claim('allow', 'reporter', 'show');
  const restriction = claim('deny', 'reporter', 'show', '--details');
  const withdrawn = rule('allow', ...grant.tokens);
  const manual = rule('ask', 'unrelated');
  for (const project of [outer, nested, elsewhere]) {
    await fs.writeFile(project.destination, JSON.stringify({ permissions: [manual] }));
  }
  await elsewhere.sync([claim('allow', 'different')]);
  const untouched = await fs.readFile(elsewhere.destination);
  const owners = { [f.first.locator.ownerKey]: [restriction] };
  const prepareUser = () => previewPermissionBatch(f.ctx, f.first.locator, [restriction], owners);
  if (userFirst) await f.first.sync([restriction]);
  await outer.sync([grant]);
  await nested.sync([grant]);
  if (!userFirst) {
    const preview = await prepareUser();
    expect(preview.relatedProjects).toEqual([nested, outer].map(({ destination }) => ({ path: destination,
      fingerprint: expect.stringMatching(/^sha256:/u), removed: [withdrawn], added: [] })));
    const staged = await f.first.prepare([restriction]);
    await expect(updateHostPermissions(f.ctx, f.first.locator, staged)).rejects.toMatchObject({ code: 'permissionConfigurationConflict' });
    expect(JSON.parse(await fs.readFile(nested.destination, 'utf8')).permissions).toEqual([withdrawn, manual]);
    await updateHostPermissions(f.ctx, f.first.locator, staged, undefined, { ...preview, owners });
  }
  expect(await f.rules()).toEqual([rule('deny', ...restriction.tokens)]);
  for (const project of [outer, nested]) expect(JSON.parse(await fs.readFile(project.destination, 'utf8')).permissions).toEqual([manual]);
  expect(await fs.readFile(elsewhere.destination)).toEqual(untouched);

  const removal = (await reviewPermissionRemovals(f.ctx, [f.first.locator])).get(f.first.locator.ownerKey)!;
  expect(removal.batch?.relatedProjects).toEqual([nested, outer].map(({ destination }) => ({ path: destination,
    fingerprint: expect.stringMatching(/^sha256:/u), removed: [], added: [withdrawn], additionalImpacts: [expect.objectContaining({
      code: 'hostPermissionAdditionalImpact', detail: expect.objectContaining({ path: destination, permissionAction: 'allow' }),
    })] })));
  await updateHostPermissions(f.ctx, f.first.locator, undefined, undefined, removal.batch, undefined, removal.fingerprint);
  expect(await f.rules()).toEqual([]);
  for (const project of [outer, nested]) expect(JSON.parse(await fs.readFile(project.destination, 'utf8')).permissions).toEqual([withdrawn, manual]);
  expect(await fs.readFile(elsewhere.destination)).toEqual(untouched);
});

it('rechecks related projects before review replay and preserves a project edit made after the User write', async () => {
  const f = await fixture();
  const project = await f.owner('project', path.join(f.root, 'project'));
  const grant = claim('allow', 'reporter', 'show');
  const restriction = claim('ask', 'reporter', 'show');
  await project.sync([grant]);
  const owners = { [f.first.locator.ownerKey]: [restriction] };
  const prepared = await f.first.prepare([restriction]);
  const batch = { ...await previewPermissionBatch(f.ctx, f.first.locator, [restriction], owners), owners };
  const prior = await fs.readFile(project.destination, 'utf8');
  const edit = JSON.stringify({ permissions: [rule('allow', ...grant.tokens), rule('deny', 'private')] });
  await fs.writeFile(project.destination, edit);
  await expect(updateHostPermissions(f.ctx, f.first.locator, prepared, undefined, batch))
    .rejects.toMatchObject({ code: 'permissionConfigurationConflict', mutation: 'none' });
  expect(await f.rules()).toEqual([]);
  expect(await fs.readFile(project.destination, 'utf8')).toBe(edit);
  await fs.writeFile(project.destination, prior);
  // The fixture uses a real host write. The callback schedules an edit after
  // the User file and sidecar have both been committed.
  await expect(updateHostPermissions(f.ctx, f.first.locator, prepared, (_before, _after, target) => {
    if (target === f.target) writeFileSync(project.destination, edit);
  }, batch)).rejects.toMatchObject({ code: 'permissionRelatedProjectUpdateIncomplete', mutation: 'confirmed', path: project.destination });
  expect(await f.rules()).toEqual([rule('ask', ...restriction.tokens)]);
  expect(await fs.readFile(project.destination, 'utf8')).toBe(edit);
});

it.each([false, true])('preserves the confirmed User file change and reports every Project skipped after interruption (before sidecar %s)', async (beforeSidecar) => {
  const f = await fixture();
  const projects = [await f.owner('first-project', path.join(f.root, 'project-one')),
    await f.owner('second-project', path.join(f.root, 'project-two'))];
  const declaration = claim('allow', 'reporter', 'summary');
  await f.first.sync([claim('deny', ...declaration.tokens)]);
  for (const project of projects) await project.sync([declaration]);
  const review = (await reviewPermissionRemovals(f.ctx, [f.first.locator])).get(f.first.locator.ownerKey)!;
  const abort = new AbortController();
  const written: string[] = [];
  const options = { ...f.ctx, signal: abort.signal };
  if (beforeSidecar) {
    const replace = safeFiles.atomicReplaceSafeFile;
    const intercepted = vi.spyOn(safeFiles, 'atomicReplaceSafeFile').mockImplementation(async (mutation) => {
      await replace(mutation);
      if (mutation.filePath === f.target) abort.abort();
    });
    onTestFinished(() => intercepted.mockRestore());
  }
  const outcome = updateHostPermissions(options, f.first.locator, undefined, (_before, _after, destination) => {
    if (destination) written.push(destination);
    if (destination === f.target && !beforeSidecar) abort.abort();
  }, review.batch, undefined, review.fingerprint);
  await expect(outcome).rejects.toMatchObject({ code: 'operationInterrupted', mutation: 'confirmed',
    projects: projects.map(({ destination }) => destination) });
  if (beforeSidecar) expect(await outcome.catch((error: unknown) => relatedProjectPermissionNotices(error, { target: 'opencode', scope: 'user' })))
    .toContainEqual(expect.objectContaining({ code: 'permissionOwnershipWriteFailed', detail: expect.objectContaining({ path: f.target }) }));
  expect(written).toEqual(beforeSidecar ? [] : [f.target]);
  expect(await f.rules()).toEqual([]);
  for (const project of projects) {
    await expect(fs.stat(project.destination)).rejects.toMatchObject({ code: 'ENOENT' });
    if (beforeSidecar) continue;
    await project.sync([declaration]);
    expect(JSON.parse(await fs.readFile(project.destination, 'utf8')).permissions).toEqual([rule('allow', ...declaration.tokens)]);
  }
});

it('reports a weaker Project rule from the user and never withdraws the manual copy', async () => {
  const f = await fixture();
  const project = await f.owner('project', path.join(f.root, 'project'));
  const grant = claim('allow', 'reporter', 'summary');
  const restriction = claim('ask', 'reporter', 'summary');
  const host = JSON.stringify({ permissions: [rule('allow', ...grant.tokens)] });
  await fs.writeFile(project.destination, host);
  await project.sync([grant]);
  const owners = { [f.first.locator.ownerKey]: [restriction] };
  const preview = await previewPermissionBatch(f.ctx, f.first.locator, [restriction], owners);
  expect(preview.relatedProjects).toEqual([]);
  expect(preview.skipped).toContainEqual({ ...restriction, pluginId: 'src/first',
    reasonCode: 'permission-rule-conflict', path: project.destination });
  await updateHostPermissions(f.ctx, f.first.locator, await f.first.prepare([restriction]), undefined, { ...preview, owners });
  expect(await f.rules()).toEqual([rule('ask', ...restriction.tokens)]);
  expect(await fs.readFile(project.destination, 'utf8')).toBe(host);
});

it('reports a known higher Project rule that still conflicts after AW withdraws its grant', async () => {
  const f = await fixture();
  const project = await f.owner('project', path.join(f.root, 'project'));
  const grant = claim('allow', 'reporter', 'summary');
  const restriction = claim('deny', ...grant.tokens);
  const higher = path.join(path.dirname(project.destination), '.opencode', 'opencode.json');
  const bytes = JSON.stringify({ permissions: [rule('allow', ...grant.tokens)] });
  await fs.mkdir(path.dirname(higher), { recursive: true });
  await fs.writeFile(higher, bytes);
  await project.sync([grant]);
  const owners = { [f.first.locator.ownerKey]: [restriction] };
  const preview = await previewPermissionBatch(f.ctx, f.first.locator, [restriction], owners);
  expect(preview.relatedProjects).toEqual([expect.objectContaining({ path: project.destination, removed: [rule('allow', ...grant.tokens)] })]);
  expect(preview.skipped).toContainEqual({ ...restriction, pluginId: 'src/first', reasonCode: 'permission-rule-conflict', path: higher });
  await updateHostPermissions(f.ctx, f.first.locator, await f.first.prepare([restriction]), undefined, { ...preview, owners });
  expect(JSON.parse(await fs.readFile(project.destination, 'utf8')).permissions).toEqual([]);
  expect(await fs.readFile(higher, 'utf8')).toBe(bytes);
});

it('does not revisit a Project affected by another User owner during an unrelated installation', async () => {
  const f = await fixture();
  const project = await f.owner('project', path.join(f.root, 'project'));
  const grant = claim('allow', 'reporter', 'summary');
  const deny = claim('deny', ...grant.tokens);
  const unrelated = claim('allow', 'calendar', 'list');
  await project.sync([grant]);
  await f.first.sync([deny]);
  const projectEdit = JSON.stringify({ model: 'changed-by-user', permissions: [] });
  await fs.writeFile(project.destination, projectEdit);
  const plan = await f.second.prepare([unrelated]);
  expect(plan.effective).toEqual([rule('allow', ...unrelated.tokens)]);
  await f.second.sync([unrelated]);
  expect(await f.rules()).toEqual([rule('allow', ...unrelated.tokens), rule('deny', ...deny.tokens)]);
  expect(await fs.readFile(project.destination, 'utf8')).toBe(projectEdit);
});

it.each([false, true])('merges a broad grant with a narrower restriction independently of install order (%s)', async (reverse) => {
  const f = await fixture();
  const writes = [() => f.first.sync([claim('allow', 'lint')]), () => f.second.sync([claim('deny', 'lint', 'force')])];
  for (const write of reverse ? writes.reverse() : writes) await write();
  expect(await f.rules()).toEqual([rule('allow', 'lint'), rule('deny', 'lint', 'force')]);
  await f.first.remove();
  expect(await f.rules()).toEqual([rule('deny', 'lint', 'force')]);
});

it('retains indistinguishable copies in place when users edit a shared restriction', async () => {
  const manual = [rule('ask', 'lint'), { action: 'shell', resource: '*', effect: 'allow' }];
  const f = await fixture(manual);
  await f.first.sync([claim('ask', 'lint')]);
  expect(await f.rules()).toEqual([...manual, rule('ask', 'lint')]);
  const modified = [rule('ask', 'new'), ...await f.rules()];
  await fs.writeFile(f.target, JSON.stringify({ model: 'edited', permissions: modified }));
  await f.first.remove();
  expect(JSON.parse(await fs.readFile(f.target, 'utf8'))).toEqual({ model: 'edited', permissions: modified });
});

it('preserves the exact bytes and warns when a user adds an equal rule after installation', async () => {
  const f = await fixture();
  await f.first.sync([claim('ask', 'lint')]);
  const existing = JSON.stringify(rule('ask', 'lint'));
  const edited = `{"permissions":[${existing},\n${JSON.stringify(rule('ask', 'check'))},\n/* retained user copy */ ${existing}]}`;
  await fs.writeFile(f.target, edited);
  expect(await missingPermissionOwnershipWarning(f.ctx, 'src/first', 'user', f.target)).toMatchObject({
    code: 'permissionOwnershipDegraded', detail: { path: f.target },
  });
  expect(await previewOpenCodePermissions(f.ctx, f.first.binding, f.target, [claim('ask', 'lint')]))
    .toMatchObject({ ownershipDegraded: true });
  await f.first.remove();
  expect(await fs.readFile(f.target, 'utf8')).toBe(edited);
});

it('retains a single same-value restriction taken over by the user after an external edit', async () => {
  const personal = rule('ask', 'check');
  const f = await fixture([personal]);
  await f.first.sync([claim('deny', 'lint')]);
  const restriction = JSON.stringify(rule('deny', 'lint'));
  const edited = `{"permissions":[/* kept by user */ ${restriction},${JSON.stringify(personal)}]}`;
  await fs.writeFile(f.target, edited);
  expect(await missingPermissionOwnershipWarning(f.ctx, 'src/first', 'user', f.target))
    .toMatchObject({ code: 'permissionOwnershipDegraded' });
  await f.first.remove();
  expect(await fs.readFile(f.target, 'utf8')).toBe(edited);
  await expect(fs.stat(f.sidecar)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps a rewritten lone OpenCode rule without neighbours to establish its ownership', async () => {
  const f = await fixture();
  await f.first.sync([claim('deny', 'check')]);
  const ownedByUser = '{"permissions":[/* manual restriction */ {"resource":"check *","effect":"deny","action":"shell"}]}';
  await fs.writeFile(f.target, ownedByUser);
  await f.first.remove();
  expect(await fs.readFile(f.target, 'utf8')).toBe(ownedByUser);
});

it.each(['missing', 'invalid', 'damaged'])('retains existing rules with %s sidecar and rebuilds from a new sync', async (failure) => {
  const f = await fixture();
  await f.first.sync([claim('deny', 'a')]);
  if (failure === 'missing') await fs.unlink(f.sidecar);
  else if (failure === 'invalid') await fs.writeFile(f.sidecar, '{');
  else {
    const state = JSON.parse(await fs.readFile(f.sidecar, 'utf8'));
    state.after = [rule('ask', 'foreign')];
    await fs.writeFile(f.sidecar, JSON.stringify(state));
  }
  const original = await fs.readFile(f.target, 'utf8');
  expect(await f.first.remove()).toBe(false);
  expect(await fs.readFile(f.target, 'utf8')).toBe(original);
  await f.first.sync([claim('deny', 'a'), claim('deny', 'b')]);
  await f.first.remove();
  expect(await f.rules()).toEqual([rule('deny', 'a')]);
});

it('retains malformed host data and rejects reviewed rules after the user changes a restriction', async () => {
  const f = await fixture();
  const plan = await f.first.prepare([claim('allow', 'a')]);
  await fs.writeFile(f.target, JSON.stringify({ permissions: [rule('deny', 'a')] }));
  await expect(updateHostPermissions(f.ctx, f.first.locator, plan)).rejects.toMatchObject({ code: 'permissionConfigurationConflict' });
  expect(await f.rules()).toEqual([rule('deny', 'a')]);
  await fs.writeFile(f.target, '{');
  await expect(f.first.sync([claim('allow', 'test')])).rejects.toMatchObject({ code: 'permissionConfigurationConflict' });
  expect(await fs.readFile(f.target, 'utf8')).toBe('{');
});

it('rechecks bytes before replacing the shared file and retains a concurrent edit', async () => {
  const f = await fixture();
  const host = await fs.readFile(f.target, 'utf8');
  const snapshot = await readPermissionSidecar(f.env, 'opencode', f.target);
  await expect(commitPermissionOwnership({ snapshot, host, owners: { [f.first.locator.ownerKey]: [claim('deny', 'a')] },
    document: { permissions: [], writePermissions: () => JSON.stringify({ permissions: [rule('deny', 'a')] }) },
    manual: [], before: [], after: [rule('deny', 'a')], effective: [], verifyChain: async () => {
      await fs.writeFile(f.target, '{"model":"user-edit"}');
    } })).rejects.toMatchObject({ code: 'permissionConfigurationConflict' });
  expect(await fs.readFile(f.target, 'utf8')).toBe('{"model":"user-edit"}');
  await expect(fs.stat(f.sidecar)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('leaves a linked sidecar and its target untouched during removal and recovery', async () => {
  const f = await fixture();
  await f.first.sync([claim('deny', 'a')]);
  const external = path.join(path.dirname(f.target), 'foreign.json');
  await fs.rename(f.sidecar, external);
  await fs.symlink(external, f.sidecar);
  const original = await fs.readFile(external, 'utf8');
  expect(await f.first.remove()).toBe(false);
  await expect(f.first.sync([claim('allow', 'other')])).rejects.toMatchObject({ code: 'permissionConfigurationConflict' });
  expect(await fs.readFile(external, 'utf8')).toEqual(original);
  expect(await f.rules()).toEqual([rule('deny', 'a')]);
});

it.each([false, true])('reports a confirmed host write when its ownership record cannot be updated (new owner %s)', async (newOwner) => {
  const f = await fixture();
  await f.first.sync([claim('ask', 'check')]);
  const host = await fs.readFile(f.target, 'utf8');
  const snapshot = await readPermissionSidecar(f.env, 'opencode', f.target);
  const rules = [rule('ask', 'check'), rule('ask', 'lint')];
  const nextHost = JSON.stringify({ permissions: rules });
  const claims = { ...snapshot.state!.owners };
  const attempted = newOwner ? f.second : f.first;
  claims[attempted.locator.ownerKey] = [...claims[attempted.locator.ownerKey] ?? [], claim('ask', 'lint')];
  await expect(commitPermissionOwnership({ snapshot, host, document: { permissions: await f.rules(), writePermissions: () => nextHost }, owners: claims,
    manual: [], before: [], after: rules, effective: rules, verifyChain: async () => {
      if (await fs.readFile(f.target, 'utf8') === nextHost) throw new Error('Injected failure before sidecar rename');
    } })).rejects.toMatchObject({ code: 'permissionOwnershipWriteFailed', mutation: 'confirmed', path: f.target });
  expect(await fs.readFile(f.sidecar, 'utf8')).toBe(snapshot.raw);
  expect(await missingPermissionOwnershipWarning(f.ctx, attempted.binding.plugin.pluginId, 'user', f.target))
    .toMatchObject({ code: 'permissionOwnershipDegraded' });
  await f.first.remove();
  // The interrupted commit left a changed host and the old ownership record.
  // Neither surviving rule has verified provenance at the next cleanup.
  expect(await f.rules()).toEqual(rules);
});

it('requires a fresh review after a separately installed owner changes the approved prefix', async () => {
  const f = await fixture();
  const allow = await f.first.prepare([claim('allow', 'lint')]);
  await f.second.sync([claim('deny', 'lint')]);
  await expect(updateHostPermissions(f.ctx, f.first.locator, allow)).rejects.toMatchObject({ code: 'permissionConfigurationConflict' });
  await f.first.sync([claim('allow', 'lint')]);
  expect(await f.rules()).toEqual([rule('deny', 'lint')]);
  await f.second.remove();
  expect(await f.rules()).toEqual([rule('allow', 'lint')]);
});


it('withholds a grant between target writes and detects external drift before the next target', async () => {
  const f = await fixture();
  const allow = [claim('allow', 'lint')], deny = [claim('deny', 'lint', 'force')];
  const owners = { [f.first.locator.ownerKey]: allow, [f.second.locator.ownerKey]: deny };
  const first = await previewPermissionBatch(f.ctx, f.first.locator, allow, owners);
  const second = await previewPermissionBatch(f.ctx, f.second.locator, deny, owners);
  await updateHostPermissions(f.ctx, f.first.locator, await f.first.prepare(allow), undefined, { ...first, owners });
  expect(await f.rules()).toEqual([]);
  expect((await offlinePermissionComponents(f.ctx, undefined)).map((entry) => entry.identity.plugin)).toEqual(['first']);

  const next = await f.second.prepare(deny);
  await fs.writeFile(f.target, '{"permissions":[{"action":"shell","resource":"lint *","effect":"ask"}]}');
  await expect(updateHostPermissions(f.ctx, f.second.locator, next, undefined, { ...second, owners })).rejects.toMatchObject({ code: 'permissionConfigurationConflict' });
  expect(await f.rules()).toEqual([rule('ask', 'lint')]);
});

// Removing both owners must never temporarily publish the grant that the same batch retires.
it('freezes shared withdrawals and rejects unrelated edits between confirmed removals', async () => {
  const f = await fixture();
  await f.first.sync([claim('allow', 'fixture', 'inspect')]);
  await f.second.sync([claim('deny', 'fixture', 'inspect')]);
  const locators = [f.second.locator, f.first.locator];
  const review = await reviewPermissionRemovals(f.ctx, locators);
  const deny = review.get(f.second.locator.ownerKey)!;
  const allow = review.get(f.first.locator.ownerKey)!;
  expect(deny.batch?.restorations).toEqual([]);
  let afterFirstWrite = '';
  await updateHostPermissions(f.ctx, f.second.locator, undefined, (_before, after) => { afterFirstWrite = after; },
    deny.batch, undefined, deny.fingerprint);
  expect(await f.rules()).toEqual([]);
  const edit = JSON.stringify({ model: 'manually edited', permissions: [] });
  await fs.writeFile(f.target, edit);
  await expect(updateHostPermissions(f.ctx, f.first.locator, undefined, undefined, allow.batch, undefined, afterFirstWrite))
    .rejects.toMatchObject({ code: 'permissionConfigurationConflict' });
  expect(await fs.readFile(f.target, 'utf8')).toBe(edit);
  expect((await offlinePermissionComponents(f.ctx, undefined)).map((component) => component.identity.plugin)).toEqual(['first']);
});
