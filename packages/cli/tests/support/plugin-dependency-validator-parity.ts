export interface PluginDependencyValidatorParityCase {
  name: string;
  manifest: Record<string, unknown>;
  siblingPluginNames?: string[];
  expectedError?: string;
}

function baseManifest(name = 'dependency-parent'): Record<string, unknown> {
  return {
    name,
    version: '0.1.0',
    description: `${name} parity fixture`,
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'NONE',
      },
    },
  };
}

export function createDependencySiblingManifest(name: string): Record<string, unknown> {
  return baseManifest(name);
}

export const pluginDependencyValidatorParityCases: PluginDependencyValidatorParityCase[] = [
  {
    name: 'accepts valid platform-scoped dependencies',
    manifest: {
      ...baseManifest(),
      dependencies: {
        plugins: [
          {
            name: 'shared-helper',
            target: {
              scope: 'user',
            },
            inheritInstallOptions: true,
            when: {
              platforms: ['codex'],
            },
          },
          {
            name: 'shared-helper',
            when: {
              platforms: ['claude'],
            },
          },
        ],
      },
    },
    siblingPluginNames: ['shared-helper'],
  },
  {
    name: 'rejects unknown dependencies block fields',
    manifest: {
      ...baseManifest(),
      dependencies: {
        tools: [],
      },
    },
    expectedError: 'unknown field "tools"',
  },
  {
    name: 'rejects unknown dependency entry fields',
    manifest: {
      ...baseManifest(),
      dependencies: {
        plugins: [
          {
            name: 'shared-helper',
            version: '^1.0.0',
          },
        ],
      },
    },
    siblingPluginNames: ['shared-helper'],
    expectedError: 'unknown field "version"',
  },
  {
    name: 'rejects self dependency',
    manifest: {
      ...baseManifest(),
      dependencies: {
        plugins: [
          {
            name: 'dependency-parent',
          },
        ],
      },
    },
    expectedError: 'cannot depend on itself',
  },
  {
    name: 'rejects invalid dependency platform conditions',
    manifest: {
      ...baseManifest(),
      dependencies: {
        plugins: [
          {
            name: 'shared-helper',
            when: {
              platforms: ['codex', 'codex'],
            },
          },
        ],
      },
    },
    siblingPluginNames: ['shared-helper'],
    expectedError: 'duplicate platform "codex"',
  },
  {
    name: 'rejects overlapping dependency platform coverage',
    manifest: {
      ...baseManifest(),
      dependencies: {
        plugins: [
          {
            name: 'shared-helper',
          },
          {
            name: 'shared-helper',
            when: {
              platforms: ['codex'],
            },
          },
        ],
      },
    },
    siblingPluginNames: ['shared-helper'],
    expectedError: 'overlaps with dependencies.plugins[0]',
  },
  {
    name: 'rejects missing catalog dependency references',
    manifest: {
      ...baseManifest(),
      dependencies: {
        plugins: [
          {
            name: 'missing-helper',
          },
        ],
      },
    },
    expectedError: 'current catalog is missing plugin "missing-helper"',
  },
];
