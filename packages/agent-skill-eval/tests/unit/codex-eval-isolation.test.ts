import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyCodexEvalGitIsolation,
  assertCodexEvalKeychainWrapperAbsent,
  codexEvalConfigOverrides,
  inspectCodexEvalHostIsolation,
  validateCodexEvalRpcIsolation,
} from '../../dist/index.js';

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((root) => fs.remove(root)));
});

function validFixture(): {
  config: Record<string, unknown>;
  requirements: Record<string, unknown>;
  skills: Record<string, unknown>;
  mcpServers: Record<string, unknown>;
  codexHome: string;
  workspaceRoot: string;
  allowedSkillRoot: string;
  allowedSkillRoots: string[];
} {
  const workspaceRoot = path.resolve('/tmp/aw-eval/project');
  const codexHome = path.resolve('/tmp/aw-eval/codex-home');
  const allowedSkillRoot = path.join(
    workspaceRoot,
    '.agents',
    'skills',
    'target-skill',
  );
  return {
    config: {
      config: {
        cli_auth_credentials_store: 'file',
        mcp_oauth_credentials_store: 'file',
        include_apps_instructions: false,
        include_collaboration_mode_instructions: false,
        mcp_servers: {},
        features: {
          secret_auth_storage: false,
          default_mode_request_user_input: true,
          apps: false,
          plugins: false,
          remote_plugin: false,
          plugin_sharing: false,
          tool_suggest: false,
          skill_mcp_dependency_install: false,
        },
        skills: { bundled: { enabled: false } },
        orchestrator: {
          skills: { enabled: false },
          mcp: { enabled: false },
        },
      },
      origins: {},
      layers: [
        {
          name: { type: 'system', file: '/etc/codex/config.toml' },
          version: '1',
          config: {},
        },
        {
          name: { type: 'user', file: path.join(codexHome, 'config.toml') },
          version: '1',
          config: {},
        },
        {
          name: { type: 'sessionFlags' },
          version: '1',
          config: {},
        },
      ],
    },
    requirements: { requirements: null },
    skills: {
      data: [{
        cwd: workspaceRoot,
        skills: [{
          name: 'target-skill',
          path: path.join(allowedSkillRoot, 'SKILL.md'),
          scope: 'repo',
          enabled: true,
        }],
        errors: [],
      }],
    },
    mcpServers: { data: [], nextCursor: null },
    codexHome,
    workspaceRoot,
    allowedSkillRoot,
    allowedSkillRoots: [allowedSkillRoot],
  };
}

describe('Codex eval isolation', () => {
  it('rejects macOS wrappers that inject accountsKeychainExport', async () => {
    await expect(assertCodexEvalKeychainWrapperAbsent({
      platform: 'darwin',
      sourceEnv: {},
      resolveCodexExecutable: async () => '/usr/local/bin/codex',
      readUserKeychainSearchList: async () => [
        '    "/private/var/folders/example/T/accountsKeychainExport123/accountsKeychainExport.keychain"',
        '    "/Users/example/Library/Keychains/login.keychain-db"',
      ].join('\n'),
    })).rejects.toThrow('ordinary Terminal');
  });

  it('accepts a normal macOS keychain list and skips other platforms', async () => {
    const readUserKeychainSearchList = vi.fn(async () =>
      '    "/Users/example/Library/Keychains/login.keychain-db"\n');
    await expect(assertCodexEvalKeychainWrapperAbsent({
      platform: 'darwin',
      sourceEnv: {},
      resolveCodexExecutable: async () => '/usr/local/bin/codex',
      readUserKeychainSearchList,
    })).resolves.toBeUndefined();
    await expect(assertCodexEvalKeychainWrapperAbsent({
      platform: 'linux',
      readUserKeychainSearchList,
    })).resolves.toBeUndefined();
    expect(readUserKeychainSearchList).toHaveBeenCalledTimes(1);
  });

  it('blocks macOS execution when the selected Codex executable cannot be resolved', async () => {
    const readUserKeychainSearchList = vi.fn(async () => '');
    await expect(assertCodexEvalKeychainWrapperAbsent({
      platform: 'darwin',
      sourceEnv: { PATH: '' },
      resolveCodexExecutable: async () => null,
      readUserKeychainSearchList,
    })).rejects.toThrow('Unable to resolve the selected Codex executable');
    expect(readUserKeychainSearchList).not.toHaveBeenCalled();
  });

  it('rejects a resolved cmux Codex shim before reading the keychain search list', async () => {
    const readUserKeychainSearchList = vi.fn(async () =>
      '    "/Users/example/Library/Keychains/login.keychain-db"\n');
    await expect(assertCodexEvalKeychainWrapperAbsent({
      platform: 'darwin',
      sourceEnv: {
        PATH: '/private/tmp/cmux-cli-shims/session:/usr/local/bin',
        CMUX_CODEX_WRAPPER_SHIM: '/private/tmp/cmux-cli-shims/session/codex',
      },
      resolveCodexExecutable: async () =>
        '/private/tmp/cmux-cli-shims/session/codex',
      readUserKeychainSearchList,
    })).rejects.toThrow('cmux Codex shim or wrapper');
    expect(readUserKeychainSearchList).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a normal-looking executable symlinked to a cmux Codex shim',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-eval-codex-link-'));
      tempDirs.push(root);
      const shim = path.join(root, 'cmux-cli-shims', 'session', 'codex');
      const bin = path.join(root, 'bin');
      await fs.ensureDir(path.dirname(shim));
      await fs.ensureDir(bin);
      await fs.writeFile(shim, '#!/bin/sh\nexit 0\n');
      await fs.chmod(shim, 0o755);
      await fs.symlink(shim, path.join(bin, 'codex'));
      const readUserKeychainSearchList = vi.fn(async () => '');

      await expect(assertCodexEvalKeychainWrapperAbsent({
        platform: 'darwin',
        sourceEnv: { PATH: bin },
        readUserKeychainSearchList,
      })).rejects.toThrow('cmux Codex shim or wrapper');
      expect(readUserKeychainSearchList).not.toHaveBeenCalled();
    },
  );

  it('forces file credential stores for every eval and disables strict surfaces', () => {
    expect(codexEvalConfigOverrides('standard')).toEqual([
      'cli_auth_credentials_store="file"',
      'mcp_oauth_credentials_store="file"',
      'features.secret_auth_storage=false',
      'shell_environment_policy.set.GIT_CONFIG_NOSYSTEM="1"',
      'shell_environment_policy.set.GIT_TERMINAL_PROMPT="0"',
      'shell_environment_policy.set.GIT_OPTIONAL_LOCKS="0"',
    ]);
    expect(codexEvalConfigOverrides('strict')).toEqual(expect.arrayContaining([
      'features.secret_auth_storage=false',
      'skills.bundled.enabled=false',
      'orchestrator.mcp.enabled=false',
      'features.apps=false',
      'features.plugins=false',
      'features.remote_plugin=false',
      'features.plugin_sharing=false',
      'features.tool_suggest=false',
      'features.skill_mcp_dependency_install=false',
    ]));
    expect(codexEvalConfigOverrides('strict')).not.toContain(
      'features.recommended_plugins=false',
    );
  });

  it('keeps an isolated HOME from re-enabling a system Git credential helper', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-eval-git-isolation-'));
    tempDirs.push(root);
    const systemConfig = path.join(root, 'system.gitconfig');
    await fs.writeFile(systemConfig, '[credential]\n\thelper = osxkeychain\n');
    const baseEnv = {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_SYSTEM: systemConfig,
    };
    const visible = await execFileAsync('git', ['config', '--get-all', 'credential.helper'], {
      cwd: root,
      env: baseEnv,
      encoding: 'utf8',
    });
    expect(visible.stdout.trim().split('\n')).toContain('osxkeychain');

    const isolatedEnv = applyCodexEvalGitIsolation(baseEnv);
    const isolated = await execFileAsync('git', ['config', '--list'], {
      cwd: root,
      env: isolatedEnv,
      encoding: 'utf8',
    });
    expect(isolated.stdout).not.toContain('credential.helper');
    expect(isolatedEnv).toMatchObject({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    });
  });

  it('accepts an empty host control plane and checks both macOS managed keys', async () => {
    const readManagedPreference = vi.fn(async () => false);
    await expect(inspectCodexEvalHostIsolation({
      platform: 'darwin',
      readSystemEntries: async () => [],
      readManagedPreference,
    })).resolves.toMatchObject({
      system_config_present: false,
      managed_preferences_checked: true,
      managed_preference_keys_present: [],
    });
    expect(readManagedPreference.mock.calls.map(([key]) => key)).toEqual([
      'config_toml_base64',
      'requirements_toml_base64',
    ]);
  });

  it('fails closed for system and managed configuration', async () => {
    await expect(inspectCodexEvalHostIsolation({
      platform: 'linux',
      readSystemEntries: async () => ['config.toml'],
    })).rejects.toThrow('system configuration exists');
    await expect(inspectCodexEvalHostIsolation({
      platform: 'darwin',
      readSystemEntries: async () => [],
      readManagedPreference: async (key) => key === 'requirements_toml_base64',
    })).rejects.toThrow('requirements_toml_base64');
  });

  it('accepts only isolated config layers, the target Skill, and no MCP servers', () => {
    const fixture = validFixture();
    expect(validateCodexEvalRpcIsolation(fixture)).toEqual({
      config_layers: ['system', 'user', 'sessionFlags'],
      config_requirements_absent: true,
      skill_paths: [path.join(fixture.allowedSkillRoot, 'SKILL.md')],
      mcp_server_count: 0,
      strict_overrides_effective: true,
    });
  });

  it('accepts exactly the declared participant Skills', () => {
    const fixture = validFixture();
    const companionRoot = path.join(
      fixture.workspaceRoot,
      '.agents',
      'skills',
      'companion-skill',
    );
    const data = fixture.skills.data as Array<Record<string, unknown>>;
    (data[0].skills as Array<Record<string, unknown>>).push({
      name: 'companion-skill',
      path: path.join(companionRoot, 'SKILL.md'),
      scope: 'repo',
      enabled: true,
    });
    fixture.allowedSkillRoots.push(companionRoot);

    expect(validateCodexEvalRpcIsolation(fixture).skill_paths).toEqual([
      path.join(companionRoot, 'SKILL.md'),
      path.join(fixture.allowedSkillRoot, 'SKILL.md'),
    ].sort());
  });

  it('requires the workspace project config layer to be active', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-isolation-project-'));
    tempDirs.push(root);
    const fixture = validFixture();
    fixture.workspaceRoot = path.join(root, 'project');
    fixture.allowedSkillRoot = path.join(
      fixture.workspaceRoot,
      '.agents',
      'skills',
      'target-skill',
    );
    fixture.allowedSkillRoots = [fixture.allowedSkillRoot];
    const skillEntry = ((fixture.skills.data as Array<Record<string, unknown>>)[0]
      .skills as Array<Record<string, unknown>>)[0];
    (fixture.skills.data as Array<Record<string, unknown>>)[0].cwd = fixture.workspaceRoot;
    skillEntry.path = path.join(fixture.allowedSkillRoot, 'SKILL.md');
    await fs.ensureDir(path.join(fixture.workspaceRoot, '.codex'));
    await fs.writeFile(
      path.join(fixture.workspaceRoot, '.codex', 'config.toml'),
      'developer_instructions = "check requirements"\n',
      'utf8',
    );
    const projectLayer: Record<string, unknown> = {
      name: {
        type: 'project',
        dotCodexFolder: path.join(fixture.workspaceRoot, '.codex'),
      },
      version: '1',
      config: { developer_instructions: 'check requirements' },
      disabledReason: null,
    };
    (fixture.config.layers as unknown[]).splice(2, 0, projectLayer);

    expect(validateCodexEvalRpcIsolation(fixture).config_layers).toContain('project');

    projectLayer.disabledReason = 'project is not trusted';
    expect(() => validateCodexEvalRpcIsolation(fixture)).toThrow(
      'disabled project config layer',
    );

    projectLayer.disabledReason = null;
    (fixture.config.layers as unknown[]).splice(2, 1);
    expect(() => validateCodexEvalRpcIsolation(fixture)).toThrow(
      'did not activate the workspace project config layer',
    );
  });

  it('accepts an empty Skill inventory for the baseline workspace', () => {
    const fixture = validFixture();
    const data = fixture.skills.data as Array<Record<string, unknown>>;
    data[0].skills = [];
    expect(validateCodexEvalRpcIsolation({
      ...fixture,
      allowedSkillRoots: [],
    }).skill_paths).toEqual([]);
  });

  it.each([
    {
      name: 'managed layer',
      mutate: (fixture: ReturnType<typeof validFixture>) => {
        (fixture.config.layers as unknown[]).push({
          name: { type: 'enterpriseManaged', id: 'managed', name: 'Managed' },
          version: '1',
          config: {},
        });
      },
      message: 'forbidden config layer',
    },
    {
      name: 'non-empty system layer',
      mutate: (fixture: ReturnType<typeof validFixture>) => {
        ((fixture.config.layers as Array<Record<string, unknown>>)[0]).config = {
          model: 'managed-model',
        };
      },
      message: 'non-empty system configuration',
    },
    {
      name: 'managed requirements',
      mutate: (fixture: ReturnType<typeof validFixture>) => {
        fixture.requirements.requirements = { allowed_sandbox_modes: ['read-only'] };
      },
      message: 'managed configuration requirements',
    },
    {
      name: 'non-target Skill',
      mutate: (fixture: ReturnType<typeof validFixture>) => {
        const data = fixture.skills.data as Array<Record<string, unknown>>;
        (data[0].skills as unknown[]).push({
          name: 'other',
          path: path.join(fixture.workspaceRoot, '.agents', 'skills', 'other', 'SKILL.md'),
          enabled: true,
        });
      },
      message: 'non-target Skill',
    },
    {
      name: 'missing target Skill',
      mutate: (fixture: ReturnType<typeof validFixture>) => {
        const data = fixture.skills.data as Array<Record<string, unknown>>;
        data[0].skills = [];
      },
      message: 'did not discover exactly the enabled participant Skills',
    },
    {
      name: 'disabled target Skill',
      mutate: (fixture: ReturnType<typeof validFixture>) => {
        const data = fixture.skills.data as Array<Record<string, unknown>>;
        ((data[0].skills as Array<Record<string, unknown>>)[0]).enabled = false;
      },
      message: 'invalid target Skill',
    },
    {
      name: 'wrong target Skill name',
      mutate: (fixture: ReturnType<typeof validFixture>) => {
        const data = fixture.skills.data as Array<Record<string, unknown>>;
        ((data[0].skills as Array<Record<string, unknown>>)[0]).name = 'wrong-name';
      },
      message: 'invalid target Skill',
    },
    {
      name: 'wrong target Skill file',
      mutate: (fixture: ReturnType<typeof validFixture>) => {
        const data = fixture.skills.data as Array<Record<string, unknown>>;
        ((data[0].skills as Array<Record<string, unknown>>)[0]).path = path.join(
          fixture.allowedSkillRoot,
          'README.md',
        );
      },
      message: 'non-target Skill',
    },
    {
      name: 'duplicate target Skill',
      mutate: (fixture: ReturnType<typeof validFixture>) => {
        const data = fixture.skills.data as Array<Record<string, unknown>>;
        (data[0].skills as unknown[]).push({
          name: 'target-skill',
          path: path.join(fixture.allowedSkillRoot, 'SKILL.md'),
          enabled: true,
        });
      },
      message: 'did not discover exactly the enabled participant Skills',
    },
    {
      name: 'Skill discovery error',
      mutate: (fixture: ReturnType<typeof validFixture>) => {
        const data = fixture.skills.data as Array<Record<string, unknown>>;
        data[0].errors = [{ path: 'bad', message: 'bad' }];
      },
      message: 'Skill discovery errors',
    },
    {
      name: 'MCP server',
      mutate: (fixture: ReturnType<typeof validFixture>) => {
        fixture.mcpServers.data = [{ name: 'external' }];
      },
      message: 'active MCP server',
    },
    {
      name: 'ineffective feature override',
      mutate: (fixture: ReturnType<typeof validFixture>) => {
        const effective = fixture.config.config as Record<string, unknown>;
        (effective.features as Record<string, unknown>).plugins = true;
      },
      message: 'did not disable features.plugins',
    },
    {
      name: 'disabled default-mode question tool',
      mutate: (fixture: ReturnType<typeof validFixture>) => {
        const effective = fixture.config.config as Record<string, unknown>;
        (effective.features as Record<string, unknown>).default_mode_request_user_input = false;
      },
      message: 'did not enable features.default_mode_request_user_input',
    },
  ])('rejects $name', ({ mutate, message }) => {
    const fixture = validFixture();
    mutate(fixture);
    expect(() => validateCodexEvalRpcIsolation(fixture)).toThrow(message);
  });
});
