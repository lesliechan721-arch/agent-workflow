export type PlatformName = 'codex' | 'claude';
export type PlatformSelection = PlatformName | 'auto' | 'both';
export type Scope = 'project' | 'user';
export type CommandAction = 'install' | 'uninstall' | 'upgrade' | 'status';

export interface PluginInterfaceMeta {
  displayName?: string;
  shortDescription?: string;
  capabilities?: string[];
}

export interface InstructionDefinition {
  name: string;
  title: string;
  content: string;
  paths?: string[];
}

export interface PermissionDefinition {
  name: string;
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

export type HookEvent =
  | 'before_tool'
  | 'after_tool'
  | 'session_start'
  | 'session_stop'
  | 'command';

export interface HookDefinition {
  event: HookEvent;
  matcher?: string;
  command: string;
  description?: string;
}

export interface AgentDefinition {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
}

export interface PluginExtensions {
  instructions?: InstructionDefinition[];
  permissions?: PermissionDefinition[];
  hooks?: HookDefinition[];
  agents?: AgentDefinition[];
}

export interface PluginManifestSource {
  name: string;
  version: string;
  description: string;
  skills?: string;
  mcpServers?: string;
  apps?: string;
  interface?: PluginInterfaceMeta;
  extensions?: PluginExtensions;
  claude?: {
    agents?: string[];
    hooks?: string | Record<string, unknown>;
  };
}

export interface PluginMeta {
  rootDir: string;
  manifestPath: string;
  manifest: PluginManifestSource;
}

export interface PlatformPluginManifest {
  name: string;
  version: string;
  description: string;
  skills?: string;
  mcpServers?: string;
  apps?: string;
  interface?: PluginInterfaceMeta;
  agents?: string[];
  hooks?: string | Record<string, unknown>;
}

export interface GeneratedArtifact {
  path: string;
  kind: 'instruction' | 'permission' | 'hook' | 'agent';
  platform: PlatformName;
}

export interface TrackingPluginRecord {
  name: string;
  generatedAt: string;
  artifacts: GeneratedArtifact[];
}

export interface TrackingManifest {
  version: 1;
  plugins: Record<string, TrackingPluginRecord>;
}

export interface PlatformDetection {
  available: boolean;
  scopes: Scope[];
  preferredScope?: Scope;
  reason?: string;
}

export interface EnvironmentDetection {
  codex: PlatformDetection;
  claude: PlatformDetection;
}

export interface NativePluginStatus {
  marketplaceRegistered: boolean;
  pluginAvailable: boolean;
  pluginInstalled: boolean;
  version?: string;
  details?: string;
}

export interface GeneratedArtifactStatus {
  path: string;
  exists: boolean;
  kind: GeneratedArtifact['kind'];
}

export interface PluginStatusReport {
  pluginName: string;
  native: NativePluginStatus;
  generatedArtifacts: GeneratedArtifactStatus[];
  driftWarnings: string[];
}

export interface StatusReport {
  platform: PlatformName;
  scope: Scope;
  initialized: boolean;
  plugins: PluginStatusReport[];
}

export interface CommandOptions {
  scope: Scope;
  platform: PlatformSelection;
  cwd: string;
}

export interface PlatformAdapter {
  name: PlatformName;
  detect(cwd: string): Promise<boolean>;
  installPlugin(plugin: PluginMeta, scope: Scope): Promise<void>;
  uninstallPlugin(plugin: PluginMeta, scope: Scope): Promise<void>;
  installExtensions(plugin: PluginMeta, scope: Scope): Promise<GeneratedArtifact[]>;
  uninstallExtensions(plugin: PluginMeta, scope: Scope): Promise<void>;
  upgradePlugin(plugin: PluginMeta, scope: Scope): Promise<void>;
  status(plugin: PluginMeta, scope: Scope): Promise<StatusReport>;
}
