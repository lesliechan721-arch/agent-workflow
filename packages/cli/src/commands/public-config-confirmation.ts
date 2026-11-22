import { inactiveCommandPermissionEffects, type Confirmation } from '../output/public-result.js';
import { analyzePluginConfigMutationImpact, pluginSharedNativeConfigRenderUnits, type PluginConfigImpactMutation } from '../utils/plugin-config-impact.js';
import { preparePluginConfigApply, disposePluginConfigApply, resolveConfigPreApplyAuthorization, type ApplyPluginConfigOptions } from '../utils/plugin-config-write.js';
import { resolvePluginConfigReferencePlugins } from '../utils/plugin-config-references.js';
import { describeConfigCommandPackageReviews, type ConfigCommandPackageEvidence } from '../utils/plugin-config-command-apply.js';
import type { ReceiptTargetIdentity } from '../types.js';
import { recoveryHostPermissionEffects } from './deployment-confirmation.js';

/** The candidate impact is computed in memory while the caller holds the existing mutation lock. */
export async function preparePublicConfigConfirmation(options: ApplyPluginConfigOptions & {
  yes?: boolean;
  mutation?: PluginConfigImpactMutation;
}): Promise<{ confirmation: Confirmation; commandPackageEvidence: ConfigCommandPackageEvidence[]; evidence: unknown;
  hostPermissionEffects: Confirmation['effects'] }> {
  const prepared = await preparePluginConfigApply(options);
  try {
    const referencePlugins = await resolvePluginConfigReferencePlugins({ sourceId: options.plugin.sourceId,
      sourceIdentity: options.plugin.sourceIdentity, logicalIdentity: options.plugin.catalogLogicalIdentity,
      env: options.env, plugins: options.rebuildRuntime?.referencePlugins });
    const requested = prepared.plan.receipt.requestedTargets.filter((target) => !prepared.plan.receipt.targetResults.some((result) =>
      result.pluginId === target.pluginId && result.agent === target.agent && result.scope === target.scope
      && (result.satisfaction === 'unsupported' || result.satisfaction === 'excluded')));
    const native: ReceiptTargetIdentity[] = requested.flatMap((target) => target.agent !== 'generic'
      ? [{ pluginName: target.pluginId.split('/').at(-1)!, pluginId: target.pluginId, platform: target.agent, scope: target.scope }] : []);
    const impact = options.mutation ? await analyzePluginConfigMutationImpact({ plugin: options.plugin,
      scope: options.context ?? options.scope, platform: options.platform, cwd: options.cwd, env: options.env,
      visibleTargets: native, mutation: options.mutation, referencePlugins,
      commandDiscovery: { packages: prepared.commandPackages, errors: prepared.commandDiscoveryErrors } }) : undefined;
    const hostPermissionEffects = recoveryHostPermissionEffects(prepared.plan);
    const effects: Confirmation['effects'] = [...hostPermissionEffects];
    const affected = impact ? requested.filter((target) => target.agent === 'generic'
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
      const scripted = target.agent === 'generic'
        && (plugin.manifest.scripts?.preApply !== undefined || prepared.preApplyAuthorization.some((entry) => entry.pluginId === target.pluginId && entry.platform === target.agent && entry.scope === target.scope));
      if (scripted) effects.push({ code: 'runPreApply', message: 'Run the plugin preApply script before applying configuration.', subject: { pluginId: target.pluginId, target: target.agent, scope: target.scope }, impact: 'unknown' });
      if ((impact?.sharedNativeRenderUnits ?? pluginSharedNativeConfigRenderUnits(plugin)).some((entry) => entry.pluginName === plugin.manifest.name && entry.platform === target.agent)) {
        effects.push({ code: 'replaceSharedOutput', message: 'Refresh the shared native output with the proposed configuration.', subject: { pluginId: target.pluginId, target: target.agent, scope: target.scope }, impact: 'shared' });
      }
    }
    for (const review of prepared.commandPackageReviews) {
      const subject = { pluginId: review.selector, scope: 'user' as const };
      effects.push({ code: 'replaceSharedOutput', message: 'Refresh the installed command package with the proposed configuration.', subject, impact: 'shared' });
      effects.push(...describeConfigCommandPackageReviews([review]).map((message) => ({
        code: 'reviewCommandPackage', message, subject, impact: 'shared' as const,
      })));
    }
    for (const child of prepared.plan.joint?.children ?? [prepared.plan]) {
      for (const group of child.nativeGroups) {
        for (const deployment of group.preview.operationPlan?.deploymentPlans ?? []) {
          effects.push(...inactiveCommandPermissionEffects(deployment));
        }
      }
    }
    const confirmation: Confirmation = { required: effects.length > 0, provided: options.yes === true,
      effects: [...new Map(effects.map((effect) => [JSON.stringify(effect), effect])).values()] };
    if (confirmation.required && !confirmation.provided) throw Object.assign(new Error('Repeat the command with --yes to confirm the listed effects.'), { code: 'confirmationRequired', confirmation });
    return { confirmation, commandPackageEvidence: prepared.commandPackageEvidence, evidence: prepared.evidence, hostPermissionEffects };
  } finally { await disposePluginConfigApply(prepared.plan); }
}
