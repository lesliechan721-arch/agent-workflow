export const GENERATED_FILE_PREFIX = 'aw-';
export const TRACKING_MANIFEST_FILE = '.agent-workflows-manifest.json';
export const DEFAULT_CLAUDE_HOOKS_PATH = './hooks/hooks.json';
export const CLAUDE_MARKETPLACE_PATH = '.claude-plugin/marketplace.json';
export const CODEX_MARKETPLACE_PATH = '.agents/plugins/marketplace.json';
export const CURRENT_CATALOG_MANIFEST_FILE = 'catalog-manifest.json';
export const CURRENT_CATALOG_MANIFEST_PACKAGE = '@yiliang/aw-plugins-manifest';
export const CURRENT_CATALOG_FULL_PACKAGE = '@yiliang/aw-plugins';
export const DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS = 5000;
export const MINIMUM_AGENT_VERSIONS = {
  codex: '0.144.0',
  claude: '2.1.88',
} as const;
export const AGENT_VERSION_PROBE_COMMANDS = {
  codex: 'codex',
  claude: 'claude',
} as const;
export const AGENT_VERSION_DISPLAY_NAMES = {
  codex: 'Codex',
  claude: 'Claude Code',
} as const;
