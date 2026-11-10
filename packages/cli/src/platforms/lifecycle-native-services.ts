import path from 'node:path';
import fs from 'fs-extra';

import { applyCodexConfigTransactionFile, readCodexConfigFile } from '../utils/codex-config.js';
import { atomicReplaceSafeFile } from '../utils/safe-fs.js';
import { runNativeCliChecked } from '../utils/native-cli.js';
import { installationInvocation } from './discovery.js';
import { getDeploymentLayout } from './layout.js';
import { inspectClaudeMarketplaceSource, inspectCopilotMarketplaceSource } from './inspection-native.js';
import type { DeploymentBinding, MutationContext, NativeIdentity, PreparationEvidence, ReadContext } from './contracts.js';

async function readObject(file: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('nativeConfigInvalid');
    return value as Record<string, unknown>;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}
function fail(code: string): never { throw Object.assign(new Error(code), { code, mutation: 'none' }); }

/** Fixed host operations for the existing lock-owning execution pipeline. */
export function createNativeLifecycleServices(ctx: ReadContext, evidence: PreparationEvidence):
  Pick<MutationContext['services'], 'registerMarketplace' | 'setActivation'> {
  const run = async (binding: DeploymentBinding, args: string[]): Promise<void> => {
    const product = binding.consumers.find((item) => item.availability === 'available' && item.entry?.kind === 'cli');
    if (!product) fail('clientInstallEntryUnavailable');
    const invocation = await installationInvocation(product, { ...ctx, cwd: binding.scope.kind === 'project' ? binding.scope.projectRoot : ctx.cwd }, args);
    await runNativeCliChecked({ ...invocation, timeoutMs: 60_000 }, ctx.runner);
  };
  return {
    async registerMarketplace(binding, identity) {
      const layout = await getDeploymentLayout(ctx, binding);
      if (identity.route !== binding.route || identity.sourceLocation !== layout.packageRoot
        || !layout.marketplaceRoot || !layout.marketplaceName) fail('nativeIdentityUnconfirmed');
      if (binding.route === 'codex-marketplace') {
        const product = binding.consumers.find((item) => item.entry?.kind === 'cli');
        if (!product || product.entry?.kind !== 'cli') fail('clientInstallEntryUnavailable');
        const { snapshot } = await readCodexConfigFile(path.join(product.entry.configRoot, 'config.toml'));
        const old = snapshot.marketplaces[layout.marketplaceName];
        if (old) {
          if (old.sourceType !== 'local' || old.sourcePointsToManifest || path.normalize(old.source ?? '') !== path.normalize(layout.marketplaceRoot)) fail('marketplaceRegistrationForeign');
          return { changed: false, mutation: 'none' };
        }
        await run(binding, ['plugin', 'marketplace', 'add', layout.marketplaceRoot]);
      } else if (binding.route === 'claude-marketplace' || binding.route === 'copilot-marketplace') {
        // The common preflight has frozen marketplace ownership. Recheck that
        // evidence before entering the host's own precise registration command.
        if (evidence.ownership.some((item) => item.state === 'foreign' || item.state === 'error')) fail('marketplaceRegistrationForeign');
        if (binding.route === 'claude-marketplace') {
          const state = await inspectClaudeMarketplaceSource(ctx, binding, layout.marketplaceName, layout.marketplaceRoot);
          if (state === 'foreign') fail('marketplaceRegistrationForeign');
          if (state === 'canonical') return { changed: false, mutation: 'none' };
        } else {
          const state = await inspectCopilotMarketplaceSource(ctx, binding, layout.marketplaceName, layout.marketplaceRoot);
          if (state === 'foreign') fail('marketplaceRegistrationForeign');
          if (state === 'unknown') fail('nativeIdentityUnconfirmed');
          if (state === 'canonical') return { changed: false, mutation: 'none' };
        }
        await run(binding, ['plugin', 'marketplace', 'add', layout.marketplaceRoot]);
      } else fail('nativeRouteUnsupported');
      return { changed: true, mutation: 'confirmed' };
    },
    async setActivation(binding: DeploymentBinding, identity: NativeIdentity, enabled: boolean) {
      if (identity.route !== binding.route || !identity.registrationId) fail('nativeIdentityUnconfirmed');
      const product = binding.consumers.find((item) => item.entry?.kind === 'cli'
        || !enabled && binding.route === 'codex-marketplace' && item.entry?.kind === 'directory');
      if (!product?.entry || product.entry.kind === 'generic') fail('clientInstallEntryUnavailable');
      const id = identity.registrationId;
      if (binding.route === 'codex-marketplace') {
        let changed = false;
        if (binding.scope.kind === 'project') {
          if (enabled) {
            if (typeof evidence.userActivationEnabled !== 'boolean') fail('nativeActivationEvidenceUnknown');
            // add enables user by default; activation restores the frozen user intent.
            changed = (await applyCodexConfigTransactionFile(path.join(product.entry.configRoot, 'config.toml'), {
              upsertPluginActivations: { [id]: evidence.userActivationEnabled },
            })).wrote;
          }
          changed = (await applyCodexConfigTransactionFile(path.join(binding.scope.projectRoot, '.codex', 'config.toml'), enabled
            ? { upsertPluginActivations: { [id]: true } } : { removePluginActivations: [id] })).wrote || changed;
        } else {
          changed = (await applyCodexConfigTransactionFile(path.join(product.entry.configRoot, 'config.toml'), {
            upsertPluginActivations: { [id]: enabled },
          })).wrote;
        }
        return { changed, mutation: changed ? 'confirmed' : 'none' };
      }
      if (binding.route !== 'copilot-marketplace') fail('nativeRouteUnsupported');
      let changed = false;
      const write = async (file: string, value: boolean): Promise<void> => {
        const settings = await readObject(file);
        const current = settings.enabledPlugins;
        if (current !== undefined && (!current || typeof current !== 'object' || Array.isArray(current))) fail('nativeConfigInvalid');
        const entries = (current ?? {}) as Record<string, unknown>;
        if (entries[id] === value) return;
        const content = `${JSON.stringify({ ...settings, enabledPlugins: { ...entries, [id]: value } }, null, 2)}\n`;
        const baseline = JSON.stringify(settings);
        await atomicReplaceSafeFile({ filePath: file, allowedRoot: path.dirname(file), content, label: 'Copilot plugin activation',
          beforeRename: async () => { if (JSON.stringify(await readObject(file)) !== baseline) fail('operationPlanStale'); } });
        changed = true;
      };
      if (binding.scope.kind === 'project') {
        if (typeof evidence.userActivationEnabled !== 'boolean') fail('nativeActivationEvidenceUnknown');
        await write(path.join(product.entry.configRoot, 'settings.json'), evidence.userActivationEnabled);
        await write(path.join(binding.scope.projectRoot, '.github', 'copilot', 'settings.local.json'), enabled);
      } else await write(path.join(product.entry.configRoot, 'settings.json'), enabled);
      return { changed, mutation: changed ? 'confirmed' : 'none' };
    },
  };
}
