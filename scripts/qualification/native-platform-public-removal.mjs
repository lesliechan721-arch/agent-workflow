// Match surviving marketplace files to the exact scope's confirmed deactivation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { nativePackage, readPublicNativeState, targetOf } from './native-platform-public-state.mjs';
import { clients, sha256 } from './native-platform-runtime.mjs';

const routes = { codex: 'codex-marketplace', claude: 'claude-marketplace', copilot: 'copilot-marketplace' };

async function packageDigest(directory) {
  const { computeCanonicalDirectoryDigest } = await import('../../packages/agent-skill-eval/dist/runtime-skill.js');
  return computeCanonicalDirectoryDigest(directory);
}

function beneath(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function location(ctx, file) {
  if (!file) return undefined;
  return beneath(ctx.root, file) ? path.relative(ctx.root, file).split(path.sep).join('/') : '<outside isolated root>';
}

function removalEvidence(ctx, target) {
  return (target?.deploymentPlans ?? []).map(plan => {
    const receipt = target.deploymentReceipts?.find(item => item.bindingId === plan.bindingId);
    const after = receipt?.after;
    return { bindingId: plan.bindingId, physicalKey: plan.physicalKey, sharedReferences: plan.sharedReferences,
      effects: plan.effects.map(effect => {
        const actual = receipt?.effects.find(item => item.id === effect.id);
        return { kind: effect.kind, destination: location(ctx, effect.destination), status: actual?.status, mutation: actual?.mutation };
      }), package: after?.package, registration: after?.registration, ownership: after?.ownership,
      route: after?.nativeIdentity?.route, packageId: after?.nativeIdentity?.packageId,
      sourceLocation: location(ctx, after?.nativeIdentity?.sourceLocation), consumers: after?.consumers.map(row => ({
        productIdSha256: sha256(row.productId), activationKey: row.activationKey, activation: row.activation })),
      diagnostics: receipt?.diagnostics.map(item => item.code) };
  });
}

// Only this scoped receipt, rooted in the same package as the verified files,
// may justify retaining bytes. Independent Codex roles live outside that root.
export function confirmedSharedRetention(ctx, target, before) {
  if (!before || !routes[ctx.platform] || target?.execution !== 'applied' || target.pluginId !== ctx.id ||
      target.target !== ctx.platform || target.scope !== ctx.scope || target.blockerCodes.length) return false;
  return target.deploymentReceipts?.some(receipt => {
    const plan = target.deploymentPlans.find(item => item.bindingId === receipt.bindingId);
    const after = receipt.after;
    if (!plan?.bindingId || !before.physicalKey || plan.physicalKey !== before.physicalKey || after.physicalKey !== before.physicalKey ||
        !['present', 'unknown'].includes(plan.sharedReferences) || after.ownership !== 'aw' ||
        after.package !== 'present' || after.registration !== 'present' || after.nativeIdentity?.route !== routes[ctx.platform] ||
        after.nativeIdentity.packageId !== ctx.id.split('/')[1] || after.nativeIdentity.sourceLocation !== before.directory ||
        receipt.unmet.length) return false;
    const actual = plan.effects.filter(effect => effect.kind === 'deactivate');
    if (actual.length !== 1) return false;
    const [deactivate] = actual;
    const applied = receipt.effects.find(effect => effect.id === deactivate.id);
    if (deactivate.physicalKey !== before.physicalKey || applied?.status !== 'applied' || applied.mutation !== 'confirmed' ||
        !deactivate.activationKey || !after.consumers.length ||
        !after.consumers.every(consumer => consumer.activationKey === deactivate.activationKey && consumer.activation === 'disabled' &&
          receipt.products.some(product => product.id === consumer.productId && product.product === 'cli'))) return false;
    if (receipt.effects.length !== plan.effects.length) return false;
    for (const effect of plan.effects.filter(effect => effect.kind !== 'deactivate')) {
      const applied = receipt.effects.find(result => result.id === effect.id);
      if (effect.kind !== 'remove-owned' || !before.contributions?.has(effect.destination) ||
          applied?.status !== 'applied' || applied.mutation !== 'confirmed') return false;
    }
    const reason = plan.sharedReferences === 'unknown' ? 'sharedReferenceUnknown' : 'sharedPackageRetained';
    return receipt.diagnostics.some(item => item.code === reason && item.severity === 'warning' &&
      item.subject?.pluginId === ctx.id && item.subject.target === ctx.platform && item.subject.scope === ctx.scope);
  }) ?? false;
}

async function foreignControl(ctx, parent, controls) {
  const file = path.join(parent, 'unmanaged-matrix-control.txt');
  if (controls.has(file)) return;
  assert(beneath(ctx.root, file));
  await fs.writeFile(file, 'Owned independently of AW.\n', { flag: 'wx' });
  controls.add(file);
}

export async function verifyFixtureRemoval(ctx, report, observed, fixture, controls, remainingRoots) {
  const id = fixture.id;
  const prior = targetOf(observed, ctx, id);
  const directory = nativePackage(prior);
  let before;
  if (routes[ctx.platform] && directory) {
    assert(beneath(ctx.root, directory));
    const original = prior.deploymentObservations.map(r => r.after).find(state => state.nativeIdentity?.sourceLocation === directory);
    assert.equal(original.ownership, 'aw');
    const contributions = new Set(fixture.installed.filter(entry => ctx.platform === 'codex' && entry.kind === 'agent')
      .map(entry => path.join(ctx.root, entry.path)).filter(file => !beneath(directory, file)));
    before = { physicalKey: original.physicalKey, directory, digest: await packageDigest(directory), contributions };
    await foreignControl(ctx, path.dirname(directory), controls);
  }
  if (ctx.platform === 'codex') {
    for (const entry of fixture.installed.filter(item => item.kind === 'agent')) {
      await foreignControl(ctx, path.dirname(path.join(ctx.root, entry.path)), controls);
    }
  }
  const { value: result, exitCode } = await ctx.result(['plugin', 'remove', id, '--scope', ctx.scope, '--yes']);
  const target = result.data.targetResults?.find(row => row.pluginId === id && row.scope === ctx.scope && row.target === ctx.platform);
  const roots = result.data.requirements?.roots;
  const record = { id, exitCode, status: result.status, diagnostics: result.diagnostics.map(item => item.code), rootsAfter: roots, execution: target?.execution, plans: removalEvidence(ctx, target), files: [],
    ...(before ? { packageBefore: { directory: location(ctx, directory), digest: before.digest } } : {}) };
  report.removals.push(record);
  assert.equal(exitCode, 0, id + ': remove failed');
  assert.equal(result.status, 'success');
  assert.deepEqual(roots?.toSorted(), [...remainingRoots].sort(), id + ': remove must revoke only the requested root');
  assert.deepEqual(result.data.remainingTargets, []);
  const retained = confirmedSharedRetention({ ...ctx, id }, target, before);
  for (const entry of fixture.installed) {
    const file = path.join(ctx.root, entry.path);
    const stat = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const fact = { path: entry.path, kind: entry.kind, observed: stat ? 'present' : 'absent' };
    record.files.push(fact);
    if (!stat) continue;
    assert(retained && beneath(directory, file), id + ': unexpected surviving file ' + entry.path);
    assert(stat.isFile() && !stat.isSymbolicLink());
    fact.sha256 = sha256(await fs.readFile(file));
    assert.equal(fact.sha256, entry.sha256, id + ': retained component bytes changed');
  }
  if (retained) {
    const { runNativeCli } = await import('../../packages/cli/dist/src/utils/native-cli.js');
    const pluginName = id.split('/')[1];
    const native = { ...ctx, pluginName, async command(args, cwd) {
      let command = ctx.platform;
      if (process.platform === 'win32' && ctx.platform === 'copilot') {
        const { resolveWindowsNpmCommand } = await import('../../packages/cli/dist/src/utils/windows-npm-shim.js');
        const { bin, package: packageName } = clients.copilot;
        const launcher = await resolveWindowsNpmCommand({ command: bin, binName: bin, packageName, cwd, env: ctx.env });
        command = launcher.command;
        args = [...launcher.argsPrefix, ...args];
      }
      const output = await runNativeCli({ command, args, cwd, env: ctx.env, timeoutMs: 30_000 });
      assert.equal(output.exitCode, 0, id + ': native scope lookup failed');
      return output;
    } };
    const neutral = path.join(ctx.root, 'neutral-removal');
    await fs.mkdir(neutral, { recursive: true });
    const options = { active: false, version: fixture.id === report.updated.id ? '0.1.2' : '0.1.1' };
    record.activeAfter = { target: await readPublicNativeState(native, ctx.project, 1, options),
      neutral: await readPublicNativeState(native, neutral, 1, options) };
    record.retainedPackageDigest = await packageDigest(directory);
    assert.equal(record.retainedPackageDigest, before.digest);
  }
  for (const control of controls) assert.equal(await fs.readFile(control, 'utf8'), 'Owned independently of AW.\n');
  record.foreignControls = [...controls].map(control => location(ctx, control));
}
