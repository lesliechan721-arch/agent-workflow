import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { packCliBundle } from '../../../../scripts/release/pack-cli.mjs';

describe('pack-cli script', () => {
  it('packs Eval, core, and CLI tarballs from one build snapshot and returns all paths', async () => {
    const snapshot = { generationId: 'generation-1' };
    const destination = path.resolve('bundle-output');
    const evalTarballPath = path.join(destination, 'agent-skill-eval.tgz');
    const cliTarballPath = path.join(destination, 'aw.tgz');
    const coreTarballPath = path.join(destination, 'aw-plugin-core.tgz');
    const packEval = vi.fn(async () => evalTarballPath);
    const packCli = vi.fn(async () => cliTarballPath);
    const packCore = vi.fn(async () => coreTarballPath);
    const withBuildSnapshot = vi.fn(async (callback: (value: typeof snapshot) => Promise<unknown>) =>
      callback(snapshot)
    );

    await expect(packCliBundle({
      destination,
      packEval,
      packCore,
      packCli,
      withBuildSnapshot,
    })).resolves.toEqual({ evalTarballPath, coreTarballPath, cliTarballPath });
    expect(withBuildSnapshot).toHaveBeenCalledOnce();
    expect(packEval).toHaveBeenCalledWith({ destination, snapshot });
    expect(packCore).toHaveBeenCalledWith({ destination, snapshot });
    expect(packCli).toHaveBeenCalledWith({ destination, snapshot });
  });
});
