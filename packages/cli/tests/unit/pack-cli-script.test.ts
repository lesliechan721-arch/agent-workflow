import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { packCliBundle } from '../../../../scripts/release/pack-cli.mjs';

describe('pack-cli script', () => {
  it('packs both Windows helpers, Eval, core, and CLI from one build snapshot', async () => {
    const snapshot = { generationId: 'generation-1' };
    const destination = path.resolve('bundle-output');
    const evalTarballPath = path.join(destination, 'agent-skill-eval.tgz');
    const cliTarballPath = path.join(destination, 'aw.tgz');
    const coreTarballPath = path.join(destination, 'aw-plugin-core.tgz');
    const windowsX64TarballPath = path.join(destination, 'aw-windows-job-win32-x64.tgz');
    const windowsArm64TarballPath = path.join(destination, 'aw-windows-job-win32-arm64.tgz');
    const packEval = vi.fn(async () => evalTarballPath);
    const packCli = vi.fn(async () => cliTarballPath);
    const packCore = vi.fn(async () => coreTarballPath);
    const packWindowsJobX64 = vi.fn(async () => windowsX64TarballPath);
    const packWindowsJobArm64 = vi.fn(async () => windowsArm64TarballPath);
    const withBuildSnapshot = vi.fn(async (callback: (value: typeof snapshot) => Promise<unknown>) =>
      callback(snapshot)
    );

    await expect(packCliBundle({
      destination,
      packEval,
      packCore,
      packCli,
      packWindowsJobX64,
      packWindowsJobArm64,
      withBuildSnapshot,
    })).resolves.toEqual({
      windowsX64TarballPath,
      windowsArm64TarballPath,
      evalTarballPath,
      coreTarballPath,
      cliTarballPath,
    });
    expect(withBuildSnapshot).toHaveBeenCalledOnce();
    expect(packEval).toHaveBeenCalledWith({ destination, snapshot });
    expect(packCore).toHaveBeenCalledWith({ destination, snapshot });
    expect(packCli).toHaveBeenCalledWith({ destination, snapshot });
    expect(packWindowsJobX64).toHaveBeenCalledWith({ destination, snapshot });
    expect(packWindowsJobArm64).toHaveBeenCalledWith({ destination, snapshot });
  });
});
