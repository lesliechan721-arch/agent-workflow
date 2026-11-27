import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { candidateArtifactSha256, candidateFiles, prepareEnvironment, sha256, verifyCandidate } from './native-platform-runtime.mjs';

// Only leaf operations take a slot. A scope waiting for its component suites
// never occupies a worker that a nested suite needs in order to finish.
export function qualificationPool(limit = Number(process.env.AW_QUALIFICATION_CONCURRENCY ?? (process.platform === 'darwin' || process.platform === 'win32' ? 2 : 3))) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 3) throw new Error('invalid-qualification-concurrency');
  let available = limit;
  const waiting = [];
  return async function runUnit(action) {
    if (available) available--;
    else await new Promise(resolve => waiting.push(resolve));
    try { return await action(); }
    finally {
      if (waiting.length) waiting.shift()();
      else available++;
    }
  };
}

// Authoring is independent of acquired native clients. The template owns this
// environment until the group finishes, including the Node entry used by scripts.
export async function prepareTemplateEnvironment(root) {
  const env = await prepareEnvironment(root);
  if (process.platform === 'win32') {
    const { resolveWindowsPathCommand } = await import('../../packages/cli/dist/src/utils/windows-npm-shim.js');
    const git = await resolveWindowsPathCommand('git', root, env);
    if (!git) throw new Error('fixture-authoring-git-unavailable');
    env.PATH = [path.dirname(process.execPath), path.join(env.SystemRoot, 'System32'), path.dirname(git)].join(path.delimiter);
  } else {
    const bin = path.join(root, 'bin');
    await fs.mkdir(bin);
    await fs.symlink(process.execPath, path.join(bin, 'node'));
    env.PATH = [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);
  }
  return env;
}

export async function qualificationGroup({ manifest, candidateRoot } = {}) {
  const identity = async () => {
    if (manifest) return verifyCandidate(manifest, candidateRoot);
    const files = await candidateFiles(candidateRoot);
    return { artifactSha256: candidateArtifactSha256(files), filesSha256: sha256(JSON.stringify(files)) };
  };
  const candidate = await identity();
  const templates = new Map();
  const runUnit = qualificationPool();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-qualification-group-'));
  return {
    candidate, runUnit, root,
    template(key, build) {
      if (!templates.has(key)) templates.set(key, build());
      return templates.get(key);
    },
    async finish() {
      try {
        const final = await identity();
        if (final.manifestSha256 !== candidate.manifestSha256 || final.filesSha256 !== candidate.filesSha256) {
          throw new Error('candidate-content-mismatch');
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
      }
    },
  };
}
