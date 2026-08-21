import {
  calculateCanonicalDigest,
  calculateCliTrainContentDigest,
  normalizeCandidateVersion,
  normalizePublishedHistory,
  normalizeReleaseMetadata,
  resolveReleaseCandidate,
} from './release-model.mjs';
import { compareReleaseSemVer } from './common.mjs';

export const CLI_PACKAGES = [
  '@lesliechan721/agent-skill-eval',
  '@lesliechan721/aw',
];

function reason(code, details) {
  return details === undefined ? { code } : { code, details };
}

export function normalizeCliRegistryHistory(registry) {
  const packages = new Map();
  for (const packageName of CLI_PACKAGES) {
    const observations = registry?.[packageName] ?? [];
    if (!Array.isArray(observations)) {
      throw new Error(`Invalid registry history for ${packageName}.`);
    }
    const versions = new Set();
    packages.set(packageName, observations.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`Invalid registry history for ${packageName}[${index}].`);
      }
      const candidateVersion = entry.version;
      if (typeof candidateVersion !== 'string') {
        throw new Error(`Invalid registry version for ${packageName}[${index}].`);
      }
      if (versions.has(candidateVersion)) {
        throw new Error(`Invalid registry history: duplicate ${packageName}@${candidateVersion}.`);
      }
      versions.add(candidateVersion);
      return {
        candidateVersion,
        metadata: entry.awRelease == null ? null : normalizeReleaseMetadata(entry.awRelease),
      };
    }));
  }
  const distTags = {};
  for (const packageName of CLI_PACKAGES) {
    const raw = registry?.distTags?.[packageName] ?? {};
    distTags[packageName] = {
      latest: raw.latest ?? null,
      beta: raw.beta ?? null,
    };
    for (const tag of ['latest', 'beta']) {
      if (distTags[packageName][tag] !== null && typeof distTags[packageName][tag] !== 'string') {
        throw new Error(`Invalid registry dist-tag ${packageName}.${tag}.`);
      }
      if (distTags[packageName][tag] !== null) {
        normalizeCandidateVersion(distTags[packageName][tag], `registry dist-tag ${packageName}.${tag}`);
      }
    }
  }
  const evalEntries = packages.get(CLI_PACKAGES[0]);
  const awEntries = packages.get(CLI_PACKAGES[1]);
  const isLegacyAwOnlyVersion = (version) =>
    !evalEntries.some((entry) => entry.candidateVersion === version)
    && awEntries.some((entry) => entry.candidateVersion === version && entry.metadata === null);
  const legacyAwBeta1RemainsLatest = distTags[CLI_PACKAGES[1]].latest === '0.1.0-beta.1'
    && isLegacyAwOnlyVersion('0.1.0-beta.1');
  const legacyLatestAwOnly = legacyAwBeta1RemainsLatest
    && distTags[CLI_PACKAGES[0]].latest === null
    && evalEntries.length === 0;
  const legacyBetaAwOnly = distTags[CLI_PACKAGES[0]].beta === null
    && (distTags[CLI_PACKAGES[1]].beta === '0.1.0-beta.1'
      || distTags[CLI_PACKAGES[1]].beta === '0.1.0-beta.2')
    && isLegacyAwOnlyVersion(distTags[CLI_PACKAGES[1]].beta);
  for (const packageName of CLI_PACKAGES) {
    const latest = distTags[packageName].latest;
    const beta = distTags[packageName].beta;
    if (latest !== null && latest.includes('-') && !(legacyAwBeta1RemainsLatest
      && packageName === CLI_PACKAGES[1]
      && latest === '0.1.0-beta.1')) {
      throw new Error(`partial-candidate: ${packageName} latest dist-tag must reference a stable version.`);
    }
    if (beta !== null && !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-beta\.[1-9]\d*$/u.test(beta)) {
      throw new Error(`partial-candidate: ${packageName} beta dist-tag must reference a canonical beta version.`);
    }
  }
  return {
    packages,
    distTags,
    legacyLatestAwOnly,
    legacyAwBeta1RemainsLatest,
    legacyBetaAwOnly,
  };
}

export function resolveCliPublishedHistory(registry) {
  const normalized = normalizeCliRegistryHistory(registry);
  const versions = new Set([...normalized.packages.values()].flatMap((entries) =>
    entries.map((entry) => entry.candidateVersion)));
  const history = [];
  for (const candidateVersion of versions) {
    const packages = CLI_PACKAGES.map((packageName) => ({
      packageName,
      entry: normalized.packages.get(packageName).find((candidate) =>
        candidate.candidateVersion === candidateVersion) ?? null,
    }));
    const metadata = packages.filter(({ entry }) => entry?.metadata).map(({ entry }) => entry.metadata);
    if (metadata.length === 0) {
      const legacy = (candidateVersion === '0.1.0-beta.1' || candidateVersion === '0.1.0-beta.2')
        && packages[1].entry !== null
        && packages[0].entry === null;
      if (!legacy) {
        throw new Error(`partial-candidate: ${candidateVersion} is missing schema-1 CLI train metadata.`);
      }
      history.push({ candidateVersion, contentDigest: null });
      continue;
    }
    if (metadata.length > 0) {
      if (
        metadata.length !== CLI_PACKAGES.length
        || packages.some(({ entry }) => entry === null)
        || metadata.some((entry) => entry.candidateVersion !== candidateVersion)
        || metadata.some((entry) =>
          entry.planId !== metadata[0].planId
          || entry.trainContentDigest !== metadata[0].trainContentDigest
          || entry.targetVersion !== metadata[0].targetVersion
          || entry.candidateVersion !== metadata[0].candidateVersion
          || entry.sourceHead !== metadata[0].sourceHead)
      ) {
        throw new Error(`partial-candidate: incomplete or inconsistent CLI train ${candidateVersion}.`);
      }
      const calculatedTrainDigest = calculateCliTrainContentDigest(packages.map(({ packageName, entry }) => ({
        name: packageName,
        contentDigest: entry.metadata.packageContentDigest,
      })));
      if (metadata.some((entry) => entry.trainContentDigest !== calculatedTrainDigest)) {
        throw new Error(`partial-candidate: CLI train ${candidateVersion} declares an invalid trainContentDigest.`);
      }
      history.push({ candidateVersion, contentDigest: calculatedTrainDigest });
      continue;
    }
  }
  return history;
}

function resolveTrainTag(registry, channel) {
  const normalized = normalizeCliRegistryHistory(registry);
  const tag = channel === 'stable' ? 'latest' : 'beta';
  const evalTag = normalized.distTags[CLI_PACKAGES[0]][tag];
  const awTag = normalized.distTags[CLI_PACKAGES[1]][tag];
  for (const [packageName, version] of [[CLI_PACKAGES[0], evalTag], [CLI_PACKAGES[1], awTag]]) {
    if (version !== null && !normalized.packages.get(packageName).some((entry) =>
      entry.candidateVersion === version)) {
      throw new Error(`partial-candidate: CLI train ${packageName} ${tag} dist-tag is not observed.`);
    }
  }
  if (evalTag === awTag) return awTag;
  if (channel === 'stable' && normalized.legacyLatestAwOnly) return awTag;
  if (channel === 'beta' && normalized.legacyBetaAwOnly) return awTag;
  throw new Error(`partial-candidate: CLI train ${tag} dist-tags are inconsistent.`);
}

function mergedLedgerRecords(catalogHistory) {
  if (Array.isArray(catalogHistory?.ledger?.records)) return catalogHistory.ledger.records;
  const records = [];
  for (const channel of ['latest', 'beta']) {
    for (const record of catalogHistory?.[channel]?.ledger?.records ?? []) records.push(record);
  }
  return records;
}

function catalogPublishedHistory(catalogHistory) {
  return ['latest', 'beta'].flatMap((channel) => {
    const observation = catalogHistory?.[channel];
    if (!observation) return [];
    return [{
      candidateVersion: observation.manifest?.catalogVersion ?? observation.catalogVersion,
      contentDigest: observation.catalogContentDigest ?? null,
    }];
  });
}

function pluginPublishedHistory(records, name) {
  const identities = new Map();
  for (const record of records.filter((entry) => entry.plugin === name)) {
    const current = identities.get(record.version);
    if (current !== undefined && current !== record.contentDigest) {
      throw new Error(`Plugin release identity ${name}@${record.version} maps to different content.`);
    }
    identities.set(record.version, record.contentDigest);
  }
  return [...identities].map(([candidateVersion, contentDigest]) => ({
    candidateVersion,
    contentDigest,
  }));
}

function actionFromCandidate(candidate) {
  return {
    targetVersion: candidate.targetVersion,
    candidateVersion: candidate.candidateVersion,
    action: candidate.status,
    reason: reason(candidate.reason, candidate.details),
  };
}

function latestPublishedVersions(history) {
  const normalized = normalizePublishedHistory(history);
  return {
    latestStable: normalized.filter((entry) => !entry.candidateVersion.includes('-')).at(-1)
      ?.candidateVersion ?? null,
    latestBeta: normalized.filter((entry) => entry.candidateVersion.includes('-beta.')).at(-1)
      ?.candidateVersion ?? null,
  };
}

function observedCliHistory(registry) {
  const normalized = normalizeCliRegistryHistory(registry);
  return [...new Set([...normalized.packages.values()].flatMap((entries) =>
    entries.map((entry) => entry.candidateVersion)))]
    .map((candidateVersion) => ({ candidateVersion, contentDigest: null }));
}

function pendingCatalogChannel(tag) {
  const manifestChannel = tag?.manifest?.channel;
  const version = tag?.manifest?.catalogVersion ?? tag?.catalogVersion;
  if (typeof version !== 'string') return null;
  try {
    normalizeCandidateVersion(version, 'pending Catalog version');
  } catch {
    return null;
  }
  const versionChannel = version.includes('-') ? 'beta' : 'stable';
  if (manifestChannel !== undefined) {
    const normalizedManifestChannel = manifestChannel === 'latest' || manifestChannel === 'stable'
      ? 'stable'
      : manifestChannel;
    if (normalizedManifestChannel !== versionChannel) {
      throw new Error('partial-candidate: pending catalog tag version and manifest channel are inconsistent.');
    }
  }
  return versionChannel;
}

export function calculateReleaseStatus({ channel, targets, content, history }) {
  if (channel !== 'beta' && channel !== 'stable') {
    throw new Error('Release channel must be beta or stable.');
  }
  let cliCandidate;
  let cliHistory;
  let publishedTag;
  let publishedTrainComplete = false;
  try {
    cliHistory = resolveCliPublishedHistory(history.registry);
    publishedTag = resolveTrainTag(history.registry, channel);
    const registry = normalizeCliRegistryHistory(history.registry);
    const tag = channel === 'stable' ? 'latest' : 'beta';
    publishedTrainComplete = publishedTag !== null
      && CLI_PACKAGES.every((packageName) => registry.distTags[packageName][tag] === publishedTag);
    cliCandidate = resolveReleaseCandidate({
      intent: channel,
      targetVersion: targets.cli,
      contentDigest: content.cli.trainContentDigest,
      publishedHistory: channel === 'stable' && registry.legacyLatestAwOnly ? [] : cliHistory,
    });
  } catch (error) {
    if (!String(error?.message).startsWith('partial-candidate:')) throw error;
    cliCandidate = {
      status: 'blocked',
      reason: 'partial-candidate',
      details: error.message,
      targetVersion: targets.cli,
      candidateVersion: null,
    };
    cliHistory = observedCliHistory(history.registry);
    publishedTag = null;
  }
  const cli = {
    ...actionFromCandidate(cliCandidate),
    ...latestPublishedVersions(cliHistory),
    publishedTag,
    trainContentDigest: content.cli.trainContentDigest,
    packages: content.cli.packages.map((entry) => ({ ...entry })),
  };

  const ledgerRecords = mergedLedgerRecords(history.catalog);
  const plugins = content.catalog.plugins.map((plugin) => {
    const publishedHistory = pluginPublishedHistory(ledgerRecords, plugin.name);
    return {
      name: plugin.name,
      contentDigest: plugin.contentDigest,
      ...latestPublishedVersions(publishedHistory),
      ...actionFromCandidate(resolveReleaseCandidate({
      intent: channel,
      targetVersion: plugin.targetVersion,
      contentDigest: plugin.contentDigest,
      publishedHistory,
      })),
    };
  });
  const catalogHistory = catalogPublishedHistory(history.catalog);
  const catalogCandidate = resolveReleaseCandidate({
    intent: channel,
    targetVersion: targets.catalog,
    contentDigest: content.catalog.contentDigest,
    publishedHistory: catalogHistory,
  });
  let catalog = {
    ...actionFromCandidate(catalogCandidate),
    ...latestPublishedVersions(catalogHistory),
    contentDigest: content.catalog.contentDigest,
    minCliVersion: content.catalog.minCliVersion,
    publicationMode: 'none',
  };
  const recoveryTag = history.catalog?.tag ?? null;
  const channelObservation = history.catalog?.[channel === 'stable' ? 'latest' : 'beta'];
  const pendingCommit = history.catalog?.pending ?? null;
  const pendingTagFirst = pendingCommit !== null
    && recoveryTag !== null
    && pendingCommit === recoveryTag.commit;
  if (pendingCommit !== null && !pendingTagFirst) {
    throw new Error('partial-candidate: catalog publication guard does not identify a pending tag-first release.');
  }
  const pendingChannel = pendingTagFirst ? pendingCatalogChannel(recoveryTag) : null;
  if (pendingTagFirst && pendingChannel === null) {
    throw new Error('partial-candidate: pending catalog tag does not identify a strict release channel.');
  }
  const resumeTagFirst = pendingTagFirst
    && pendingChannel === channel
    && channelObservation?.commit !== recoveryTag.commit;
  const otherChannelPending = pendingTagFirst && pendingChannel !== channel;
  if (pendingTagFirst && pendingChannel === channel && channelObservation?.commit === recoveryTag.commit) {
    throw new Error('partial-candidate: catalog publication guard remains after channel promotion.');
  }
  if (otherChannelPending) {
    catalog = {
      ...catalog,
      candidateVersion: null,
      action: 'deferred',
      reason: reason('catalog-publication-pending', { channel: pendingChannel }),
      publicationMode: 'none',
    };
    for (const plugin of plugins) {
      plugin.action = 'deferred';
      plugin.candidateVersion = null;
      plugin.reason = reason('catalog-publication-pending', { channel: pendingChannel });
    }
  }
  if (resumeTagFirst) {
    const recoveryVersion = recoveryTag.manifest?.catalogVersion ?? recoveryTag.catalogVersion;
    const recoveryOrigin = recoveryTag.manifest?.release;
    if (
      recoveryVersion !== catalog.targetVersion && recoveryVersion !== catalog.candidateVersion
      || recoveryTag.catalogContentDigest !== content.catalog.contentDigest
      || recoveryTag.manifest?.schemaVersion !== 4
      || recoveryOrigin?.state !== 'published'
      || recoveryOrigin.targetVersion !== recoveryVersion.replace(/-beta\.[1-9]\d*$/u, '')
      || recoveryOrigin.contentDigest !== content.catalog.contentDigest
      || typeof recoveryTag.snapshotDigest !== 'string'
      || !/^sha256:[0-9a-f]{64}$/u.test(recoveryTag.snapshotDigest)
    ) {
      throw new Error('partial-candidate: pending catalog recovery does not match current release content.');
    }
    if (publishedTrainComplete && cli.publishedTag !== null) {
      const registry = normalizeCliRegistryHistory(history.registry);
      for (const packageName of CLI_PACKAGES) {
        const metadata = registry.packages.get(packageName).find((entry) =>
          entry.candidateVersion === cli.publishedTag)?.metadata;
        if (
          !metadata
          || metadata.candidateVersion !== cli.publishedTag
          || metadata.targetVersion !== targets.cli
          || metadata.planId !== recoveryOrigin.planId
          || metadata.sourceHead !== recoveryOrigin.sourceHead
        ) {
          throw new Error('partial-candidate: pending catalog and CLI train origins are inconsistent.');
        }
      }
    }
    const publishedCompatible = publishedTrainComplete
      && cli.publishedTag !== null
      && compareReleaseSemVer(cli.publishedTag, content.catalog.minCliVersion) >= 0;
    if (cli.action === 'skip' && publishedCompatible) {
      catalog = {
        ...catalog,
        candidateVersion: recoveryVersion,
        action: 'recover',
        reason: reason('tag-first-promotion-required'),
        publicationMode: 'promotion',
      };
    } else if (cli.action === 'skip') {
      catalog = {
        ...catalog,
        candidateVersion: null,
        action: 'deferred',
        reason: reason('published-cli-incompatible', {
          minCliVersion: content.catalog.minCliVersion,
          publishedTag: cli.publishedTag,
        }),
        publicationMode: 'none',
      };
    } else if (cli.action === 'publish') {
      catalog = {
        ...catalog,
        candidateVersion: recoveryVersion,
        action: 'publish',
        reason: reason('tag-first-resume-required'),
        publicationMode: 'tag-first',
      };
    } else {
      catalog = {
        ...catalog,
        candidateVersion: null,
        action: 'deferred',
        reason: reason('tag-first-cli-blocked'),
        publicationMode: 'none',
      };
    }
  }
  const pluginDeferred = plugins.filter((plugin) => plugin.action === 'deferred');
  if (catalog.action !== 'recover' && (catalog.action === 'deferred' || pluginDeferred.length > 0)) {
    catalog = {
      ...catalog,
      candidateVersion: null,
      action: 'deferred',
      reason: catalog.action === 'deferred'
        ? catalog.reason
        : reason('plugin-target-bump-required', pluginDeferred.map((entry) => entry.name)),
    };
    for (const plugin of plugins) {
      if (plugin.action === 'publish') {
        plugin.action = 'deferred';
        plugin.candidateVersion = null;
        plugin.reason = reason('catalog-target-bump-required');
      }
    }
  } else if (catalog.action !== 'recover' && catalog.publicationMode !== 'tag-first' && (
    catalog.action === 'publish' || plugins.some((plugin) => plugin.action === 'publish')
  )) {
    catalog.action = 'publish';
    const minCliVersion = content.catalog.minCliVersion;
    const publishedCompatible = cli.publishedTag !== null
      && compareReleaseSemVer(cli.publishedTag, minCliVersion) >= 0;
    if (cli.action === 'publish') {
      if (compareReleaseSemVer(cli.candidateVersion, minCliVersion) < 0) {
        catalog.action = 'deferred';
        catalog.candidateVersion = null;
        catalog.reason = reason('cli-candidate-incompatible', { minCliVersion });
      } else {
        catalog.publicationMode = publishedCompatible ? 'atomic-combined' : 'tag-first';
      }
    } else if (publishedCompatible) {
      catalog.publicationMode = 'catalog-only';
    } else {
      catalog.action = 'deferred';
      catalog.candidateVersion = null;
      catalog.reason = reason('published-cli-incompatible', { minCliVersion });
    }
    if (catalog.action === 'deferred') {
      for (const plugin of plugins) {
        if (plugin.action === 'publish') {
          plugin.action = 'deferred';
          plugin.candidateVersion = null;
          plugin.reason = reason('catalog-deferred');
        }
      }
    }
  }
  if (
    catalog.publicationMode === 'catalog-only'
    && channelObservation == null
    && recoveryTag == null
    && pendingCommit == null
  ) {
    catalog.publicationMode = 'bootstrap';
  }

  return {
    schemaVersion: 1,
    channel,
    source: {
      head: content.source.head,
      releaseInputDigest: content.source.releaseInputDigest,
      buildOutputDigest: content.source.buildOutputDigest,
      cliPackageDigest: content.source.cliPackageDigest,
      targetsDigest: calculateCanonicalDigest(targets),
    },
    history,
    cli,
    catalog,
    plugins,
  };
}

export function hasPlanAction(status) {
  return status.cli.action === 'publish'
    || status.cli.action === 'recover'
    || status.catalog.action === 'publish'
    || status.catalog.action === 'recover';
}

export function assertNoBlockedReleaseAction(status) {
  if (status.cli.action === 'blocked') {
    throw new Error(`partial-candidate: ${status.cli.reason.details ?? 'CLI train is incomplete.'}`);
  }
}
