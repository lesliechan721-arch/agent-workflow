import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { reinstallCommand } from '../../src/commands/reinstall.js';
import {
  createMinimalPluginInstallStateFixtureBuilder,
  writeMinimalPluginInstallStateFixture,
} from '../helpers/minimal-plugin-install-state-fixtures.js';
import { rewriteSanitizedInstallRecordForP2 } from '../helpers/install-state-projection-fixtures.js';
import type {
  GeneratedArtifact,
  PlatformAdapter,
  PlatformName,
  PluginMeta,
  Scope,
  StatusReport,
} from '../../src/types.js';

const tempDirs: string[] = [];

async function makeBuilder() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-p9-reinstall-'));
  tempDirs.push(root);
  return createMinimalPluginInstallStateFixtureBuilder(root);
}

class FakeAdapter implements PlatformAdapter {
  async detect(): Promise<boolean> {
    return true;
  }

  async installPlugin(): Promise<void> {}
  async uninstallPlugin(): Promise<void> {}
  async installExtensions(): Promise<GeneratedArtifact[]> {
    return [];
  }
  async uninstallExtensions(): Promise<void> {}
  async upgradePlugin(): Promise<void> {}
  async status(_plugin: PluginMeta, scope: Scope): Promise<StatusReport> {
    return {
      platform: 'codex',
      scope,
      initialized: false,
      plugins: [],
    };
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('reinstall command (P9)', () => {
  it('stops on adoptable project artifacts instead of deleting them as residuals', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await fs.mkdtemp(path.join(os.tmpdir(), 'aw-p9-reinstall-adoptable-')),
      scenario: 'freshCloneProject',
    });
    tempDirs.push(fixture.paths.rootDir);
    const installSpy = vi.fn<typeof import('../../src/commands/install.js').installCommand>();

    await expect(
      reinstallCommand(
        ['git-commit'],
        {
          cwd: fixture.paths.repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          env: {
            ...process.env,
            AW_HOME: fixture.paths.awHome,
            AW_CODEX_HOME: fixture.paths.codexHome,
            AW_CLAUDE_HOME: fixture.paths.claudeHome,
          },
          adapters: {
            codex: new FakeAdapter(),
            claude: new FakeAdapter(),
          } satisfies Record<PlatformName, PlatformAdapter>,
          installCommandImpl: installSpy,
        },
      ),
    ).rejects.toThrow(/可认领状态/);

    expect(installSpy).not.toHaveBeenCalled();
  });

  it('does not proceed to install when uninstall fails closed on a missing dependency index', async () => {
    const builder = await makeBuilder();
    const target = builder.createTarget({ pluginName: 'git-commit', platform: 'codex', scope: 'user' });

    await builder.writeRepoArtifact(target);
    const lifecycle = await builder.writeHistoricalLifecycleRuntime(target);
    await builder.writeInstallRecord(target, lifecycle);
    await rewriteSanitizedInstallRecordForP2(path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${target.recordId}.json`,
    ));
    await fs.remove(path.join(builder.paths.awHome, 'dependency-index'));

    const installSpy = vi.fn<typeof import('../../src/commands/install.js').installCommand>();
    await expect(
      reinstallCommand(
        ['git-commit'],
        {
          cwd: builder.paths.repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          env: {
            ...process.env,
            AW_HOME: builder.paths.awHome,
            AW_CODEX_HOME: builder.paths.codexHome,
            AW_CLAUDE_HOME: builder.paths.claudeHome,
          },
          adapters: {
            codex: new FakeAdapter(),
            claude: new FakeAdapter(),
          } satisfies Record<PlatformName, PlatformAdapter>,
          installCommandImpl: installSpy,
        },
      ),
    ).rejects.toThrow(/dependency index/);

    expect(installSpy).not.toHaveBeenCalled();
  });
});
