import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertPublicClientDiscovery, preparePublicClientPaths, requireProductionSkillProfile,
  writePublicFixtureRevision } from './native-platform-public-aw.mjs';
import { assertPublicTarget, readDynamicConsumerContent, readPublicNativeState } from './native-platform-public-state.mjs';

export const mixedNativePlatforms = ['claude', 'pi'];

export function mixedNativeInstallIntervals(trace) {
  if (!trace) return undefined;
  const writes = trace.records.filter(({ nativeOperation }) => nativeOperation === 'install');
  const commands = writes.filter(({ phase }) => phase === 'start').map(start => {
    const spawn = writes.find(row => row.operationId === start.operationId && row.phase === 'spawn');
    const finish = writes.find(row => row.operationId === start.operationId && row.phase === 'finish');
    return { platform: start.nativeClient, operationId: start.operationId, startTime: start.startTime,
      childPid: spawn?.childPid ?? null, spawnTime: spawn?.spawnTime ?? null,
      finishTime: finish?.finishTime ?? null, exitCode: finish?.exitCode ?? null };
  });
  const starts = commands.map(command => Date.parse(command.startTime));
  const finishes = commands.map(command => Date.parse(command.finishTime));
  const paired = trace.state === 'captured' && commands.length === mixedNativePlatforms.length
    && mixedNativePlatforms.every(platform => commands.some(command => command.platform === platform && command.exitCode === 0))
    && finishes.every((finish, index) => Number.isFinite(starts[index]) && Number.isFinite(finish) && starts[index] <= finish);
  return { kind: 'managed-native-install', commands,
    overlapMs: paired ? Math.max(0, Math.min(...finishes) - Math.max(...starts)) : null };
}

export function assertMixedInstallReceipt(result, pluginId) {
  assert.equal(result.command, 'plugin.install');
  assert.equal(result.status, 'success');
  assert.deepEqual(result.data.request.plugins, [pluginId]);
  assert.deepEqual([...result.data.request.targets].sort(), mixedNativePlatforms);
  assert.equal(result.data.request.scope, 'user');
  assert.equal(result.data.changes.requirements, 'changed');
  const targets = result.data.targetResults;
  assert.equal(targets.length, mixedNativePlatforms.length);
  return mixedNativePlatforms.map((platform) => {
    const target = targets.find((item) => item.pluginId === pluginId && item.target === platform && item.scope === 'user');
    assert.equal(target?.execution, 'applied', `${platform} must apply an actual change in this batch.`);
    assert.equal(target.observation, 'verified', `${platform} must have a verified installation.`);
    assert.equal(target.content, 'satisfied', `${platform} must have satisfied content.`);
    const registrations = target.deploymentPlans.flatMap((plan) => plan.effects
      .filter((effect) => effect.kind === 'register').map((effect) => ({ binding: plan.bindingId, effect: effect.id })));
    assert.equal(registrations.length, 1, `${platform} must plan one native registration.`);
    const registration = registrations[0];
    const receipt = target.deploymentReceipts.find((item) => item.bindingId === registration.binding);
    const applied = receipt?.effects.find((effect) => effect.id === registration.effect);
    assert.equal(applied?.status, 'applied', `${platform} must apply its native registration.`);
    assert.equal(applied.mutation, 'confirmed', `${platform} must confirm its native mutation.`);
    return { platform, scope: target.scope, content: target.content,
      registration: { status: applied.status, mutation: applied.mutation } };
  });
}

export async function qualifyMixedPublicAw(ctx, acquiredClients) {
  const clients = mixedNativePlatforms.map((platform) => {
    const { launcher, binDirectory: clientBin } = acquiredClients.get(platform);
    return { ...ctx, platform, launcher, clientBin,
      command: (args, cwd) => ctx.command(args, cwd, { launcher, nativeClient: platform }),
      rpc: (cwd) => ctx.rpc(cwd, { platform, launcher }) };
  });
  await ctx.check('mixed-public-target-discovery', async () => {
    const entries = await preparePublicClientPaths(clients);
    ctx.publicAdditionalClientEntries = clients.flatMap(({ launcher }, index) => [launcher.prefix[0] ?? launcher.executable, entries[index]]);
    const result = await ctx.aw(['target', 'set', ...mixedNativePlatforms]);
    const discovered = [];
    for (const [index, client] of clients.entries()) {
      discovered.push(await assertPublicClientDiscovery(result, client, entries[index]));
      await requireProductionSkillProfile(client);
    }
    return { clients: discovered };
  });
  const pluginId = `qualification/${ctx.pluginName}`;
  await ctx.check('mixed-public-authoring-and-source', async () => {
    const workspace = path.join(ctx.root, 'workspace');
    await fs.mkdir(workspace);
    await ctx.aw(['dev', 'catalog', 'create', '--workspace-root', workspace, '--owner-url', 'https://example.com/qualification'], workspace);
    await ctx.aw(['dev', 'plugin', 'create', ctx.pluginName, '--description', 'Mixed native installation fixture.', '--no-skills', '--workspace-root', workspace], workspace);
    await writePublicFixtureRevision(ctx, path.join(workspace, 'plugins', ctx.pluginName), 1, mixedNativePlatforms);
    for (const client of clients) client.publicConsumedSkill = ctx.publicConsumedSkill;
    await ctx.aw(['dev', 'catalog', 'build', '--workspace-root', workspace], workspace);
    await ctx.aw(['source', 'add', 'qualification', '--path', path.join(workspace, '.aw/catalog'), '--no-auto-check', '--primary', '--yes']);
    return { pluginId, version: '0.1.0' };
  });
  await ctx.check('mixed-public-install-receipt', async () => {
    const result = await ctx.aw(['plugin', 'install', pluginId, '--scope', 'user', '--context', 'user',
      ...mixedNativePlatforms.flatMap((platform) => ['--target', platform]), '--yes']);
    return { command: result.command, targets: assertMixedInstallReceipt(result, pluginId) };
  });
  await ctx.check('mixed-public-status', async () => {
    const result = await ctx.aw(['plugin', 'status', pluginId, '--context', 'user']);
    assert.equal(result.command, 'plugin.status');
    assert.equal(result.data.context, 'user');
    assert.deepEqual(result.data.coverage.scopes, ['user']);
    assert.equal(result.data.allSatisfied, true);
    assert.deepEqual(result.data.counts, { ready: clients.length, pending: 0, blocked: 0, unconfirmed: 0 });
    const targets = clients.map((client) => {
      const { target, consumer } = assertPublicTarget(result, client, pluginId,
        { content: 'satisfied', activation: client.platform === 'claude' ? 'enabled' : 'unknown' });
      assert.equal(target.observation, 'verified', `${client.platform} must verify its target in fresh public status.`);
      assert.equal(target.satisfaction, 'installed');
      return { platform: client.platform, observation: target.observation, content: target.content, activation: consumer.activation };
    });
    return { command: result.command, coverage: result.data.coverage, targets };
  });
  for (const client of clients) {
    await ctx.check(`mixed-${client.platform}-native-scope-and-content`, async () => ({
      working: await readPublicNativeState(client, ctx.project, 1, { active: true }),
      neutral: await readPublicNativeState(client, ctx.neutral, 1, { active: true }),
      skill: await readDynamicConsumerContent(client, ctx.project, 1),
    }));
  }
}
