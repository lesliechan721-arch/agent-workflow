import type { Confirmation } from '../output/public-result.js';
import { analyzePluginConfigMutationImpact, type PluginConfigImpactMutation } from '../utils/plugin-config-impact.js';
import { preparePluginConfigApply, disposePluginConfigApply, resolveConfigPreApplyAuthorization, type ApplyPluginConfigOptions } from '../utils/plugin-config-write.js';
import { resolvePluginConfigReferencePlugins } from '../utils/plugin-config-references.js';
import type { ReceiptTargetIdentity } from '../types.js';

/** The candidate impact is computed in memory while the caller holds the existing mutation lock. */
export async function preparePublicConfigConfirmation(options: ApplyPluginConfigOptions & {
  yes?: boolean;
  mutation?: PluginConfigImpactMutation;
}): Promise<Confirmation> {
  const prepared = await preparePluginConfigApply(options);
  try {
    const referencePlugins = await resolvePluginConfigReferencePlugins({ sourceId: options.plugin.sourceId,
      sourceIdentity: options.plugin.sourceIdentity, logicalIdentity: options.plugin.catalogLogicalIdentity,
      env: options.env, plugins: options.rebuildRuntime?.referencePlugins });
    const requested = prepared.plan.receipt.requestedTargets.filter((target) => !prepared.plan.receipt.targetResults.some((result) =>
      result.pluginId === target.pluginId && result.agent === target.agent && result.scope === target.scope
      && (result.satisfaction === 'unsupported' || result.satisfaction === 'excluded')));
    const native: ReceiptTargetIdentity[] = requested.flatMap((target) => target.agent === 'codex' || target.agent === 'claude'
      ? [{ pluginName: target.pluginId.split('/').at(-1)!, pluginId: target.pluginId, platform: target.agent, scope: target.scope }] : []);
    const impact = options.mutation ? await analyzePluginConfigMutationImpact({ plugin: options.plugin,
      scope: options.context ?? options.scope, platform: options.platform, cwd: options.cwd, env: options.env,
      visibleTargets: native, mutation: options.mutation, referencePlugins,
      commandDiscovery: { packages: prepared.commandPackages, errors: prepared.commandDiscoveryErrors } }) : undefined;
    const effects: Confirmation['effects'] = [];
    const affected = impact ? requested.filter((target) => target.agent !== 'codex' && target.agent !== 'claude'
      ? impact.storeChanged : impact.affectedTargets.some((candidate) => candidate.pluginId === target.pluginId && candidate.platform === target.agent && candidate.scope === target.scope)) : requested;
    const authorization = await resolveConfigPreApplyAuthorization({
      ...options,
      applyTargets: impact?.affectedTargets ?? native,
      rebuildRuntime: { ...prepared.plan.runtime, referencePlugins },
    });
    if (authorization.unavailableTargetResults.length > 0) {
      throw Object.assign(new Error('The preApply authorization scope cannot be resolved for the affected outputs.'), { code: 'sourceUnavailable' });
    }
    // Configuration consumers and their dependency scripts have different identities.
    // Use the script closure of the affected consumers, not a same-plugin match.
    for (const target of authorization.targets) {
      effects.push({ code: 'runPreApply', message: 'Run the plugin preApply script before applying configuration.', subject: { pluginId: target.pluginId, target: target.platform, scope: target.scope }, impact: 'unknown' });
    }
    for (const target of affected) {
      const plugin = referencePlugins.find((entry) => entry.pluginId === target.pluginId) ?? options.plugin;
      const scripted = target.agent !== 'codex' && target.agent !== 'claude'
        && (plugin.manifest.scripts?.preApply !== undefined || prepared.preApplyAuthorization.some((entry) => entry.pluginId === target.pluginId && entry.platform === target.agent && entry.scope === target.scope));
      if (scripted) effects.push({ code: 'runPreApply', message: 'Run the plugin preApply script before applying configuration.', subject: { pluginId: target.pluginId, target: target.agent, scope: target.scope }, impact: 'unknown' });
      if (target.agent === 'codex' && (impact === undefined || impact.sharedNativeRenderTargets.some((entry) => (entry.pluginName ?? options.plugin.manifest.name) === plugin.manifest.name && (entry.platform ?? 'codex') === target.agent))) {
        effects.push({ code: 'replaceSharedOutput', message: 'Refresh the shared native output with the proposed configuration.', subject: { pluginId: target.pluginId, target: target.agent, scope: target.scope }, impact: 'shared' });
      }
    }
    for (const item of impact?.affectedCommandPackages ?? prepared.commandPackages) effects.push({ code: 'replaceSharedOutput', message: 'Refresh the installed command package with the proposed configuration.', subject: { pluginId: `${item.producer.sourceId}/${item.producer.pluginName}`, scope: item.producer.scope }, impact: item.producer.scope === 'user' ? 'shared' : 'selected-scope' });
    const confirmation: Confirmation = { required: effects.length > 0, provided: options.yes === true, effects };
    if (confirmation.required && !confirmation.provided) throw Object.assign(new Error('Repeat the command with --yes to confirm the listed effects.'), { code: 'confirmationRequired', confirmation });
    return confirmation;
  } finally { await disposePluginConfigApply(prepared.plan); }
}
