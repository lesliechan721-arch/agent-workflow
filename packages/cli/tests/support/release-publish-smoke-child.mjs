import fs from 'node:fs/promises';
import path from 'node:path';

import { publishPreparedRelease } from '../../../../scripts/release/prepared-release.mjs';
import { runRelease } from '../../../../scripts/release/release.mjs';

const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const descriptor = JSON.parse(await fs.readFile(path.join(config.preparedRoot, 'descriptor.json'), 'utf8'));
const events = [];

async function catalogJournalState() {
  if (!descriptor.axes.catalog) return null;
  try {
    const attempt = JSON.parse(await fs.readFile(path.join(
      config.workspaceRoot,
      '.aw',
      'publish',
      descriptor.candidates.catalog,
      'journal.json',
    ), 'utf8'));
    return attempt.state;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function releaseAttemptCandidates() {
  try {
    return JSON.parse(await fs.readFile(config.attemptPath, 'utf8')).candidates ?? null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

try {
  const options = {
    preparedRoot: config.preparedRoot,
    repoRoot: config.workspaceRoot,
    attemptPath: config.attemptPath,
    remoteUrl: config.remoteUrl,
    assertClean: async () => undefined,
    resolveHead: async () => descriptor.source.head,
    readTargets: async () => config.targets,
    assertPackageVersions: async () => ({ targetVersion: config.targets.cli }),
    withSnapshot: async (callback) => callback(descriptor.build),
    resolveCandidates: async () => descriptor.candidates,
    readPackageVersions: async () => [],
    assertCliTagAvailable: async () => undefined,
    computeTarballTreeDigest: async (file) => {
      if (file.includes('windows-x64')) return 'windows-x64-tree';
      if (file.includes('windows-arm64')) return 'windows-arm64-tree';
      if (file.includes('eval')) return 'eval-tree';
      return file.includes('core') ? 'core-tree' : 'cli-tree';
    },
    runNpmCommand: async (_command, args) => {
      const event = path.basename(args[1], '.tgz');
      events.push(event);
      if (config.fail === event) throw new Error('fake npm failure');
    },
    publishCliTag: async () => {
      events.push('tag');
    },
    beforeRemoteWrite: async (target) => {
      if (target === undefined) events.push('catalog');
    },
  };
  if (config.entry === 'release') {
    await runRelease(['release', '--catalog'], {
      ...options,
      commitMetadata: async () => null,
      runVerification: async () => undefined,
      prepare: async () => descriptor,
    });
  } else {
    await publishPreparedRelease(options);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    events,
    catalogJournal: await catalogJournalState(),
    releaseAttempt: await releaseAttemptCandidates(),
  }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    events,
    error: String(error?.message),
    catalogJournal: await catalogJournalState(),
    releaseAttempt: await releaseAttemptCandidates(),
  }));
}
