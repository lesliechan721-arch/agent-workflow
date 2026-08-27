import fs from 'node:fs/promises';
import path from 'node:path';

import { publishPreparedRelease } from '../../../../scripts/release/prepared-release.mjs';

const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const descriptor = JSON.parse(await fs.readFile(path.join(config.preparedRoot, 'descriptor.json'), 'utf8'));
const events = [];

async function catalogAttemptState() {
  if (!descriptor.axes.catalog) return null;
  try {
    const attempt = JSON.parse(await fs.readFile(path.join(
      config.workspaceRoot,
      '.aw',
      'publish',
      'attempts',
      `${descriptor.candidates.catalog}.json`,
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
  await publishPreparedRelease({
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
    readPublishedCliVersion: async () => config.publishedCliVersion,
    computeTarballTreeDigest: async (file) => file.includes('eval')
      ? 'eval-tree'
      : file.includes('core') ? 'core-tree' : 'cli-tree',
    runNpmCommand: async (_command, args) => {
      const event = args[1].includes('eval')
        ? 'eval'
        : args[1].includes('core') ? 'core' : 'cli';
      events.push(event);
      if (config.fail === event) throw new Error('fake npm failure');
    },
    publishCliTag: async () => {
      events.push('tag');
    },
    beforeRemoteWrite: async (target) => {
      if (target === undefined) events.push('catalog');
    },
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    events,
    catalogAttempt: await catalogAttemptState(),
    releaseAttempt: await releaseAttemptCandidates(),
  }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    events,
    error: String(error?.message),
    catalogAttempt: await catalogAttemptState(),
    releaseAttempt: await releaseAttemptCandidates(),
  }));
}
