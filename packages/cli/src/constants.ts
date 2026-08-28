export const GENERATED_FILE_PREFIX = 'aw-';
export const TRACKING_MANIFEST_FILE = '.agent-workflows-manifest.json';
export const DEFAULT_CLAUDE_HOOKS_PATH = './hooks/hooks.json';
export const CLAUDE_MARKETPLACE_PATH = '.claude-plugin/marketplace.json';
export const CODEX_MARKETPLACE_PATH = '.agents/plugins/marketplace.json';
export const CURRENT_CATALOG_MANIFEST_FILE = 'catalog-manifest.json';
export const CATALOG_SOURCES_FILE = 'catalog-sources.json';
export const CATALOG_SOURCES_SCHEMA_VERSION = 1;
export const CATALOG_SOURCE_IDENTITY_VERSION = 1;
export const CATALOG_GENERATIONS_FILE = 'catalog-generations.json';
export const CATALOG_GENERATIONS_SCHEMA_VERSION = 1;
export const CATALOG_GENERATIONS_DIRECTORY = 'catalog-generations';
export const CATALOG_GENERATION_METADATA_FILE = 'generation.json';
export const OFFICIAL_CATALOG_SOURCE_URL =
  'https://github.com/lesliechan721-arch/agent-workflow.git';
export const CATALOG_LATEST_REF = 'refs/heads/catalog/latest';
export const CATALOG_BETA_REF = 'refs/heads/catalog/beta';
export const DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS = 5000;
export const MINIMUM_AGENT_VERSIONS = {
  codex: '0.145.0',
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
