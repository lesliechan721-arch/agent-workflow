import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  diagnoseCodexRoleVisibility,
  findCodexRoleNameConflict,
  getCodexRoleDescriptionMismatch,
  planCodexManagedRoleRemoval,
  resolveCodexRoleNamespace,
} from '../../src/utils/codex-roles.js';

async function makeCodexLayer(options: {
  configContent?: string;
  files?: Record<string, string>;
} = {}): Promise<{ root: string; layerRoot: string; configPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-roles-'));
  const layerRoot = path.join(root, '.codex');
  const configPath = path.join(layerRoot, 'config.toml');
  await fs.ensureDir(layerRoot);
  await fs.writeFile(configPath, options.configContent ?? '', 'utf8');

  for (const [relativePath, content] of Object.entries(options.files ?? {})) {
    const absolutePath = path.join(layerRoot, relativePath);
    await fs.ensureDir(path.dirname(absolutePath));
    await fs.writeFile(absolutePath, content, 'utf8');
  }

  return { root, layerRoot, configPath };
}

describe('codex-roles', () => {
  it('treats config_file-backed aliases as conflicts against the final role name', async () => {
    const { configPath } = await makeCodexLayer({
      configContent: [
        '[agents.foo]',
        'description = "foo alias"',
        'config_file = "agents/foo.toml"',
        '',
      ].join('\n'),
      files: {
        'agents/foo.toml': [
          'name = "codex-explorer"',
          'description = "Role layer"',
          'developer_instructions = "Explore code"',
          '',
        ].join('\n'),
      },
    });

    const namespace = await resolveCodexRoleNamespace(configPath, { strict: true });
    const conflict = findCodexRoleNameConflict(namespace, 'codex-explorer');

    expect(conflict).toMatchObject({
      roleName: 'codex-explorer',
      conflict: true,
      externalMatches: [
        {
          finalName: 'codex-explorer',
          tableKey: 'foo',
          source: 'registration',
        },
      ],
    });
  });

  it('detects unreferenced agents/*.toml files that expose the same final role name', async () => {
    const { configPath } = await makeCodexLayer({
      files: {
        'agents/nested/explorer.toml': [
          'name = "codex-explorer"',
          'description = "Nested file"',
          'developer_instructions = "Explore code"',
          '',
        ].join('\n'),
      },
    });

    const namespace = await resolveCodexRoleNamespace(configPath, { strict: true });
    const conflict = findCodexRoleNameConflict(namespace, 'codex-explorer');

    expect(conflict).toMatchObject({
      conflict: true,
      externalMatches: [
        {
          finalName: 'codex-explorer',
          source: 'discoveredRoleFile',
        },
      ],
    });
  });

  it('does not treat AW-managed same-name roles as external conflicts', async () => {
    const { configPath, layerRoot } = await makeCodexLayer({
      configContent: [
        '[agents.foo]',
        'description = "foo alias"',
        'config_file = "agents/foo.toml"',
        '',
      ].join('\n'),
      files: {
        'agents/foo.toml': [
          'name = "codex-explorer"',
          'description = "Role layer"',
          'developer_instructions = "Explore code"',
          '',
        ].join('\n'),
      },
    });
    const roleLayerPath = path.join(layerRoot, 'agents', 'foo.toml');

    const namespace = await resolveCodexRoleNamespace(configPath, {
      strict: true,
      awManagedTableKeys: ['foo'],
      awManagedRoleLayerPaths: [roleLayerPath],
    });
    const conflict = findCodexRoleNameConflict(namespace, 'codex-explorer');

    expect(conflict).toMatchObject({
      conflict: false,
      externalMatches: [],
      awManagedMatches: [
        {
          finalName: 'codex-explorer',
          source: 'registration',
          awManaged: true,
        },
      ],
    });
  });

  it('diagnoses user-scope role visibility from higher-priority final role names', async () => {
    const { configPath: projectConfigPath } = await makeCodexLayer({
      configContent: [
        '[agents.project-alias]',
        'description = "Project alias"',
        'config_file = "agents/project-role.toml"',
        '',
      ].join('\n'),
      files: {
        'agents/project-role.toml': [
          'name = "codex-explorer"',
          'description = "Project role"',
          'developer_instructions = "Project explorer"',
          '',
        ].join('\n'),
      },
    });
    const { configPath: ancestorConfigPath } = await makeCodexLayer({
      files: {
        'agents/tree-layer-role.toml': [
          'name = "codex-explorer"',
          'description = "Ancestor role"',
          'developer_instructions = "Ancestor explorer"',
          '',
        ].join('\n'),
      },
    });

    const projectNamespace = await resolveCodexRoleNamespace(projectConfigPath, { strict: true });
    const ancestorNamespace = await resolveCodexRoleNamespace(ancestorConfigPath, { strict: true });
    const visibility = diagnoseCodexRoleVisibility('codex-explorer', [
      projectNamespace,
      ancestorNamespace,
    ]);

    expect(visibility).toMatchObject({
      roleName: 'codex-explorer',
      state: 'unknownByExternalLayer',
      higherPriorityLayerMatches: [
        {
          configPath: projectConfigPath,
          matches: [
            {
              finalName: 'codex-explorer',
              tableKey: 'project-alias',
              source: 'registration',
            },
          ],
        },
        {
          configPath: ancestorConfigPath,
          matches: [
            {
              finalName: 'codex-explorer',
              source: 'discoveredRoleFile',
            },
          ],
        },
      ],
    });
  });

  it('reports all same-name matches inside one higher-priority layer', async () => {
    const { configPath } = await makeCodexLayer({
      configContent: [
        '[agents.project-alias]',
        'description = "Project alias"',
        'config_file = "agents/project-role.toml"',
        '',
      ].join('\n'),
      files: {
        'agents/project-role.toml': [
          'name = "codex-explorer"',
          'description = "Alias role"',
          'developer_instructions = "Alias explorer"',
          '',
        ].join('\n'),
        'agents/other-name.toml': [
          'name = "codex-explorer"',
          'description = "Loose role"',
          'developer_instructions = "Loose explorer"',
          '',
        ].join('\n'),
      },
    });

    const namespace = await resolveCodexRoleNamespace(configPath, { strict: true });
    const visibility = diagnoseCodexRoleVisibility('codex-explorer', [namespace]);

    expect(visibility.state).toBe('unknownByExternalLayer');
    expect(visibility.higherPriorityLayerMatches).toHaveLength(1);
    expect(visibility.higherPriorityLayerMatches[0]?.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          finalName: 'codex-explorer',
          tableKey: 'project-alias',
          source: 'registration',
        }),
        expect.objectContaining({
          finalName: 'codex-explorer',
          source: 'discoveredRoleFile',
        }),
      ]),
    );
  });

  it('stays visible when no higher-priority layer exposes the same final role name', async () => {
    const { configPath } = await makeCodexLayer({
      configContent: [
        '[agents.other-role]',
        'description = "Other role"',
        'config_file = "agents/other-role.toml"',
        '',
      ].join('\n'),
      files: {
        'agents/other-role.toml': [
          'name = "repo-reviewer"',
          'description = "Other role"',
          'developer_instructions = "Review code"',
          '',
        ].join('\n'),
      },
    });

    const namespace = await resolveCodexRoleNamespace(configPath, { strict: true });
    expect(diagnoseCodexRoleVisibility('codex-explorer', [namespace])).toEqual({
      roleName: 'codex-explorer',
      state: 'visible',
      higherPriorityLayerMatches: [],
    });
  });

  it('diagnoses description drift between the registration and the role layer', async () => {
    const { configPath } = await makeCodexLayer({
      configContent: [
        '[agents.codex-explorer]',
        'description = "Registration description"',
        'config_file = "agents/codex-explorer.toml"',
        '',
      ].join('\n'),
      files: {
        'agents/codex-explorer.toml': [
          'name = "codex-explorer"',
          'description = "Role file description"',
          'developer_instructions = "Explore code"',
          '',
        ].join('\n'),
      },
    });

    const namespace = await resolveCodexRoleNamespace(configPath, { strict: true });
    expect(getCodexRoleDescriptionMismatch(namespace.roles[0])).toEqual({
      registrationDescription: 'Registration description',
      roleFileDescription: 'Role file description',
    });
  });

  it('plans managed role removal without deleting a drifted user-owned config_file target', async () => {
    const { root, configPath, layerRoot } = await makeCodexLayer({
      configContent: [
        '[agents.codex-explorer]',
        'description = "User role"',
        'config_file = "../user-owned.toml"',
        '',
      ].join('\n'),
    });
    const managedRoleLayerPath = path.join(
      layerRoot,
      'agents',
      'aw-codex-explore-codex-explorer.toml',
    );
    const userOwnedPath = path.join(root, 'user-owned.toml');

    const removalPlan = planCodexManagedRoleRemoval({
      content: await fs.readFile(configPath, 'utf8'),
      configPath,
      roleKey: 'codex-explorer',
      managedRoleLayerPath,
    });

    expect(removalPlan.content).not.toContain('[agents.codex-explorer]');
    expect(removalPlan.roleLayerPathToDelete).toBe(managedRoleLayerPath);
    expect(removalPlan.driftedConfigFilePath).toBe(userOwnedPath);
  });

  it('degrades to warnings for broken role TOML in read-only mode and throws in strict mode', async () => {
    const { configPath } = await makeCodexLayer({
      configContent: [
        '[agents.codex-explorer]',
        'description = "Broken role"',
        'config_file = "agents/broken.toml"',
        '',
      ].join('\n'),
      files: {
        'agents/broken.toml': 'name = [\n',
      },
    });

    const degraded = await resolveCodexRoleNamespace(configPath, { strict: false });
    expect(degraded.warnings[0]).toContain('Unable to parse Codex role TOML');
    expect(degraded.roles[0]).toMatchObject({
      finalName: 'codex-explorer',
      roleLayerExists: true,
    });

    await expect(resolveCodexRoleNamespace(configPath, { strict: true })).rejects.toThrow(
      'agents/broken.toml',
    );
  });
});
