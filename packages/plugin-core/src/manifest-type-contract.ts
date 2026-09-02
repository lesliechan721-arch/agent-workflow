import type { PluginManifestSourceV3 } from './generated/plugin-manifest-v3.js';
import type { PluginManifestSource } from './types.js';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Assert<Condition extends true> = Condition;

export type PluginManifestSourceMatchesGeneratedSchema = Assert<
  Equal<PluginManifestSource, PluginManifestSourceV3>
>;
export type MarketplaceInstallationMatchesGeneratedSchema = Assert<
  Equal<
    PluginManifestSource['marketplace']['policy']['installation'],
    'AVAILABLE' | 'NOT_AVAILABLE' | 'INSTALLED_BY_DEFAULT'
  >
>;
