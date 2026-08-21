import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  calculateCanonicalDigest,
  calculateCliTrainContentDigest,
  canonicalJson,
  normalizeCandidateVersion,
  normalizeReleaseMetadata,
  normalizeStableTargetVersion,
} from './release-model.mjs';
import { assertReleaseWorktreeClean, repoRoot as defaultRepoRoot, runReleaseGit } from './common.mjs';
import {
  calculateReleaseStatus,
  normalizeCliRegistryHistory,
  resolveCliPublishedHistory,
} from './release-state.mjs';

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const HEAD_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ACTIONS = new Set(['publish', 'recover', 'skip', 'deferred']);
const CLI_PACKAGE_NAMES = ['@lesliechan721/agent-skill-eval', '@lesliechan721/aw'];

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${field}: expected an object.`);
  }
  return value;
}

function keys(value, field, allowed, required = allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Invalid ${field}: unknown field "${key}".`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`Invalid ${field}: missing field "${key}".`);
  }
}

function digest(value, field) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`Invalid ${field}: expected a canonical sha256 digest.`);
  }
  return value;
}

function reason(value, field) {
  const result = object(value, field);
  keys(result, field, ['code', 'details'], ['code']);
  if (typeof result.code !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result.code)) {
    throw new Error(`Invalid ${field}.code.`);
  }
  if (Object.hasOwn(result, 'details')) canonicalJson(result.details);
  return Object.hasOwn(result, 'details')
    ? { code: result.code, details: result.details }
    : { code: result.code };
}

function action(value, field) {
  if (!ACTIONS.has(value)) throw new Error(`Invalid ${field}.`);
  return value;
}

function candidate(value, field) {
  return value === null ? null : normalizeCandidateVersion(value, field);
}

function normalizeAxis(raw, field, contentField, extra = []) {
  const value = object(raw, field);
  keys(value, field, [
    'targetVersion', 'candidateVersion', contentField, 'action', 'reason', ...extra,
  ]);
  const targetVersion = normalizeStableTargetVersion(value.targetVersion, `${field}.targetVersion`);
  const candidateVersion = candidate(value.candidateVersion, `${field}.candidateVersion`);
  if (candidateVersion !== null && !candidateVersion.startsWith(`${targetVersion}-`) && candidateVersion !== targetVersion) {
    throw new Error(`Invalid ${field}.candidateVersion: target core does not match.`);
  }
  const normalizedAction = action(value.action, `${field}.action`);
  if (normalizedAction !== 'deferred' && candidateVersion === null) {
    throw new Error(`Invalid ${field}.candidateVersion: ${normalizedAction} requires a candidate.`);
  }
  if (normalizedAction === 'deferred' && candidateVersion !== null) {
    throw new Error(`Invalid ${field}.candidateVersion: deferred requires null.`);
  }
  return {
    targetVersion,
    candidateVersion,
    [contentField]: digest(value[contentField], `${field}.${contentField}`),
    action: normalizedAction,
    reason: reason(value.reason, `${field}.reason`),
  };
}

function normalizeHistory(raw) {
  const value = object(raw, 'plan.history');
  keys(value, 'plan.history', ['npm', 'catalog']);
  const npm = object(value.npm, 'plan.history.npm');
  keys(npm, 'plan.history.npm', [
    'packages', 'distTags', 'legacyLatestAwOnly', 'legacyBetaAwOnly',
  ]);
  if (typeof npm.legacyLatestAwOnly !== 'boolean' || typeof npm.legacyBetaAwOnly !== 'boolean') {
    throw new Error('Invalid plan.history.npm legacy facts.');
  }
  if (!Array.isArray(npm.packages)) throw new Error('Invalid plan.history.npm.packages.');
  const packages = npm.packages.map((rawPackage, packageIndex) => {
    const packageValue = object(rawPackage, `plan.history.npm.packages[${packageIndex}]`);
    keys(packageValue, `plan.history.npm.packages[${packageIndex}]`, ['name', 'versions']);
    if (typeof packageValue.name !== 'string' || packageValue.name.trim() !== packageValue.name) {
      throw new Error(`Invalid plan.history.npm.packages[${packageIndex}].name.`);
    }
    if (!Array.isArray(packageValue.versions)) throw new Error('Invalid plan npm versions.');
    return {
      name: packageValue.name,
      versions: packageValue.versions.map((rawVersion, versionIndex) => {
        const version = object(rawVersion, `plan npm version ${versionIndex}`);
        keys(version, `plan npm version ${versionIndex}`, ['candidateVersion', 'metadata']);
        return {
          candidateVersion: normalizeCandidateVersion(version.candidateVersion),
          metadata: version.metadata === null ? null : normalizeReleaseMetadata(version.metadata),
        };
      }),
    };
  });
  if (
    packages.length !== 2
    || new Set(packages.map((entry) => entry.name)).size !== packages.length
    || !packages.some((entry) => entry.name === '@lesliechan721/agent-skill-eval')
    || !packages.some((entry) => entry.name === '@lesliechan721/aw')
  ) throw new Error('Invalid plan.history.npm.packages: expected the complete CLI train.');
  if (!Array.isArray(npm.distTags)) throw new Error('Invalid plan.history.npm.distTags.');
  const distTags = npm.distTags.map((rawEntry, index) => {
    const entry = object(rawEntry, `plan.history.npm.distTags[${index}]`);
    keys(entry, `plan.history.npm.distTags[${index}]`, ['name', 'latest', 'beta']);
    if (!CLI_PACKAGE_NAMES.includes(entry.name)) throw new Error('Invalid plan npm dist-tag package.');
    for (const tag of ['latest', 'beta']) {
      if (entry[tag] !== null) normalizeCandidateVersion(entry[tag], `plan npm dist-tag ${tag}`);
    }
    return { name: entry.name, latest: entry.latest, beta: entry.beta };
  });
  if (distTags.length !== 2 || new Set(distTags.map((entry) => entry.name)).size !== 2) {
    throw new Error('Invalid plan.history.npm.distTags: expected the complete CLI train.');
  }
  const registry = {
    ...Object.fromEntries(packages.map((entry) => [
      entry.name,
      entry.versions.map((version) => ({
        version: version.candidateVersion,
        awRelease: version.metadata,
      })),
    ])),
    distTags: Object.fromEntries(distTags.map((entry) => [entry.name, {
      latest: entry.latest,
      beta: entry.beta,
    }])),
  };
  const normalizedRegistry = normalizeCliRegistryHistory(registry);
  if (normalizedRegistry.legacyLatestAwOnly !== npm.legacyLatestAwOnly) {
    throw new Error('Invalid plan.history.npm.legacyLatestAwOnly: fact does not match observations.');
  }
  if (normalizedRegistry.legacyBetaAwOnly !== npm.legacyBetaAwOnly) {
    throw new Error('Invalid plan.history.npm.legacyBetaAwOnly: fact does not match observations.');
  }
  resolveCliPublishedHistory(registry);
  const catalog = object(value.catalog, 'plan.history.catalog');
  keys(catalog, 'plan.history.catalog', [
    'latest', 'beta', 'tag', 'publicationGuard', 'pluginPublications',
  ]);
  const normalizeChannel = (rawChannel, field, { tag = false } = {}) => {
    if (rawChannel === null) return null;
    const channel = object(rawChannel, field);
    keys(channel, field, [
      'commit', 'candidateVersion', 'contentDigest',
      ...(tag ? ['snapshotDigest', 'origin'] : []),
    ]);
    if (typeof channel.commit !== 'string' || !HEAD_PATTERN.test(channel.commit)) {
      throw new Error(`Invalid ${field}.commit.`);
    }
    const normalized = {
      commit: channel.commit,
      candidateVersion: normalizeCandidateVersion(channel.candidateVersion),
      contentDigest: digest(channel.contentDigest, `${field}.contentDigest`),
    };
    if (!tag) return normalized;
    const origin = channel.origin === null ? null : object(channel.origin, `${field}.origin`);
    if (origin !== null) {
      keys(origin, `${field}.origin`, [
        'targetVersion', 'planId', 'sourceHead', 'contentDigest',
      ]);
      if (typeof origin.sourceHead !== 'string' || !HEAD_PATTERN.test(origin.sourceHead)) {
        throw new Error(`Invalid ${field}.origin.sourceHead.`);
      }
    }
    return {
      ...normalized,
      snapshotDigest: channel.snapshotDigest === null
        ? null
        : digest(channel.snapshotDigest, `${field}.snapshotDigest`),
      origin: origin === null ? null : {
        targetVersion: normalizeStableTargetVersion(origin.targetVersion, `${field}.origin.targetVersion`),
        planId: digest(origin.planId, `${field}.origin.planId`),
        sourceHead: origin.sourceHead,
        contentDigest: digest(origin.contentDigest, `${field}.origin.contentDigest`),
      },
    };
  };
  if (catalog.publicationGuard !== null && (
    typeof catalog.publicationGuard !== 'string' || !HEAD_PATTERN.test(catalog.publicationGuard)
  )) throw new Error('Invalid plan.history.catalog.publicationGuard.');
  const normalizedTag = normalizeChannel(catalog.tag, 'plan.history.catalog.tag', { tag: true });
  if (catalog.publicationGuard !== null && (
    normalizedTag === null
    || normalizedTag.commit !== catalog.publicationGuard
    || normalizedTag.snapshotDigest === null
    || normalizedTag.origin === null
  )) {
    throw new Error('Invalid plan.history.catalog guarded tag origin.');
  }
  if (!Array.isArray(catalog.pluginPublications)) {
    throw new Error('Invalid plan.history.catalog.pluginPublications.');
  }
  const pluginPublications = catalog.pluginPublications.map((rawPublication, index) => {
    const publication = object(rawPublication, `plan.history.catalog.pluginPublications[${index}]`);
    keys(publication, `plan.history.catalog.pluginPublications[${index}]`, [
      'name', 'candidateVersion', 'contentDigest',
    ]);
    if (typeof publication.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(publication.name)) {
      throw new Error(`Invalid plan.history.catalog.pluginPublications[${index}].name.`);
    }
    return {
      name: publication.name,
      candidateVersion: normalizeCandidateVersion(publication.candidateVersion),
      contentDigest: digest(publication.contentDigest, `plan.history.catalog.pluginPublications[${index}].contentDigest`),
    };
  });
  if (new Set(pluginPublications.map((entry) =>
    `${entry.name}\0${entry.candidateVersion}\0${entry.contentDigest}`)).size !== pluginPublications.length) {
    throw new Error('Invalid plan.history.catalog.pluginPublications: duplicate identity.');
  }
  return {
    npm: {
      packages,
      distTags,
      legacyLatestAwOnly: npm.legacyLatestAwOnly,
      legacyBetaAwOnly: npm.legacyBetaAwOnly,
    },
    catalog: {
      latest: normalizeChannel(catalog.latest, 'plan.history.catalog.latest'),
      beta: normalizeChannel(catalog.beta, 'plan.history.catalog.beta'),
      tag: normalizedTag,
      publicationGuard: catalog.publicationGuard,
      pluginPublications,
    },
  };
}

function recomputePlanDecision(plan) {
  const registry = {
    ...Object.fromEntries(plan.history.npm.packages.map((entry) => [entry.name,
      entry.versions.map((version) => ({
        version: version.candidateVersion,
        awRelease: version.metadata,
      }))])),
    distTags: Object.fromEntries(plan.history.npm.distTags.map((entry) => [entry.name, {
      latest: entry.latest,
      beta: entry.beta,
    }])),
  };
  const observation = (entry, { tag = false } = {}) => entry === null ? null : {
    commit: entry.commit,
    manifest: {
      ...(tag ? { schemaVersion: 4 } : {}),
      catalogVersion: entry.candidateVersion,
      ...(tag && entry.origin ? { release: { state: 'published', ...entry.origin } } : {}),
    },
    catalogContentDigest: entry.contentDigest,
    ...(tag ? { snapshotDigest: entry.snapshotDigest } : {}),
    ledger: { schemaVersion: 2, records: [] },
  };
  const ledger = {
    schemaVersion: 2,
    records: plan.history.catalog.pluginPublications.map((entry) => ({
      plugin: entry.name,
      version: entry.candidateVersion,
      contentDigest: entry.contentDigest,
    })),
  };
  return calculateReleaseStatus({
    channel: plan.channel,
    targets: {
      schemaVersion: 1,
      cli: plan.cli.targetVersion,
      catalog: plan.catalog.targetVersion,
    },
    content: {
      source: {
        head: plan.source.head,
        releaseInputDigest: plan.source.releaseInputDigest,
        buildOutputDigest: plan.source.buildOutputDigest,
        cliPackageDigest: plan.source.cliPackageDigest,
      },
      cli: {
        trainContentDigest: plan.cli.trainContentDigest,
        packages: plan.cli.packages.map(({ name, contentDigest, tarballDigest }) => ({
          name, contentDigest, tarballDigest,
        })),
      },
      catalog: {
        minCliVersion: plan.catalog.minCliVersion,
        contentDigest: plan.catalog.catalogContentDigest,
        plugins: plan.plugins.map(({ name, targetVersion, contentDigest }) => ({
          name, targetVersion, contentDigest,
        })),
      },
    },
    history: {
      registry,
      catalog: {
        latest: observation(plan.history.catalog.latest),
        beta: observation(plan.history.catalog.beta),
        tag: observation(plan.history.catalog.tag, { tag: true }),
        pending: plan.history.catalog.publicationGuard,
        ledger,
      },
    },
  });
}

function planDecision(status, minCliVersion) {
  return {
    source: status.source,
    cli: {
      targetVersion: status.cli.targetVersion,
      candidateVersion: status.cli.candidateVersion,
      trainContentDigest: status.cli.trainContentDigest,
      packages: status.cli.packages.map((entry) => ({ ...entry, action: status.cli.action })),
      action: status.cli.action,
      reason: status.cli.reason,
    },
    catalog: {
      targetVersion: status.catalog.targetVersion,
      candidateVersion: status.catalog.candidateVersion,
      catalogContentDigest: status.catalog.contentDigest,
      minCliVersion,
      snapshotDigest: status.catalog.snapshotDigest ?? null,
      publicationMode: status.catalog.publicationMode,
      action: status.catalog.action,
      reason: status.catalog.reason,
    },
    plugins: status.plugins.map((plugin) => ({
      name: plugin.name,
      targetVersion: plugin.targetVersion,
      candidateVersion: plugin.candidateVersion,
      contentDigest: plugin.contentDigest,
      action: plugin.action,
      reason: plugin.reason,
    })),
  };
}

function planIdentityInput(plan) {
  const { planId, planDigest, ...base } = plan;
  const { snapshotDigest, ...catalogIdentity } = base.catalog;
  return {
    ...base,
    cli: {
      ...base.cli,
      packages: base.cli.packages.map(({ tarballDigest, ...entry }) => entry),
    },
    catalog: catalogIdentity,
  };
}

export function normalizeReleasePlan(raw, { verifyDigests = true } = {}) {
  const value = object(raw, 'release plan');
  keys(value, 'release plan', [
    'schemaVersion', 'planId', 'planDigest', 'channel', 'source', 'history',
    'cli', 'catalog', 'plugins',
  ]);
  if (value.schemaVersion !== 1) throw new Error('Invalid release plan.schemaVersion.');
  if (value.channel !== 'beta' && value.channel !== 'stable') throw new Error('Invalid release plan.channel.');
  const source = object(value.source, 'release plan.source');
  keys(source, 'release plan.source', [
    'head', 'releaseInputDigest', 'buildOutputDigest', 'cliPackageDigest', 'targetsDigest',
  ]);
  if (typeof source.head !== 'string' || !HEAD_PATTERN.test(source.head)) {
    throw new Error('Invalid release plan.source.head.');
  }
  const cliValue = object(value.cli, 'release plan.cli');
  keys(cliValue, 'release plan.cli', [
    'targetVersion', 'candidateVersion', 'trainContentDigest', 'packages', 'action', 'reason',
  ]);
  if (!Array.isArray(cliValue.packages)) throw new Error('Invalid release plan.cli.packages.');
  const cli = {
    ...normalizeAxis(cliValue, 'release plan.cli', 'trainContentDigest', ['packages']),
    packages: cliValue.packages.map((rawPackage, index) => {
      const packageValue = object(rawPackage, `release plan.cli.packages[${index}]`);
      keys(packageValue, `release plan.cli.packages[${index}]`, [
        'name', 'contentDigest', 'tarballDigest', 'action',
      ]);
      if (typeof packageValue.name !== 'string' || packageValue.name.trim() !== packageValue.name) {
        throw new Error(`Invalid release plan.cli.packages[${index}].name.`);
      }
      return {
        name: packageValue.name,
        contentDigest: digest(packageValue.contentDigest, `release plan.cli.packages[${index}].contentDigest`),
        tarballDigest: digest(packageValue.tarballDigest, `release plan.cli.packages[${index}].tarballDigest`),
        action: action(packageValue.action, `release plan.cli.packages[${index}].action`),
      };
    }),
  };
  if (
    cli.packages.length !== 2
    || new Set(cli.packages.map((entry) => entry.name)).size !== cli.packages.length
    || !cli.packages.some((entry) => entry.name === '@lesliechan721/agent-skill-eval')
    || !cli.packages.some((entry) => entry.name === '@lesliechan721/aw')
  ) throw new Error('Invalid release plan.cli.packages: expected the complete CLI train.');
  if (cli.packages.some((entry) => entry.action !== cli.action)) {
    throw new Error('Invalid release plan.cli.packages: package actions must match the CLI axis.');
  }
  if (calculateCliTrainContentDigest(cli.packages.map(({ name, contentDigest }) => ({
    name,
    contentDigest,
  }))) !== cli.trainContentDigest) {
    throw new Error('Invalid release plan.cli.trainContentDigest: package content does not match.');
  }
  const catalogValue = object(value.catalog, 'release plan.catalog');
  keys(catalogValue, 'release plan.catalog', [
    'targetVersion', 'candidateVersion', 'catalogContentDigest', 'minCliVersion',
    'snapshotDigest', 'publicationMode', 'action', 'reason',
  ]);
  if (!['none', 'catalog-only', 'atomic-combined', 'tag-first', 'bootstrap', 'promotion'].includes(catalogValue.publicationMode)) {
    throw new Error('Invalid release plan.catalog.publicationMode.');
  }
  const catalog = {
    ...normalizeAxis(catalogValue, 'release plan.catalog', 'catalogContentDigest', [
      'minCliVersion', 'snapshotDigest', 'publicationMode',
    ]),
    minCliVersion: normalizeCandidateVersion(
      catalogValue.minCliVersion,
      'release plan.catalog.minCliVersion',
    ),
    snapshotDigest: catalogValue.snapshotDigest === null
      ? null
      : digest(catalogValue.snapshotDigest, 'release plan.catalog.snapshotDigest'),
    publicationMode: catalogValue.publicationMode,
  };
  if (!Array.isArray(value.plugins)) throw new Error('Invalid release plan.plugins.');
  const plugins = value.plugins.map((rawPlugin, index) => {
    const pluginValue = object(rawPlugin, `release plan.plugins[${index}]`);
    keys(pluginValue, `release plan.plugins[${index}]`, [
      'name', 'targetVersion', 'candidateVersion', 'contentDigest', 'action', 'reason',
    ]);
    if (typeof pluginValue.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pluginValue.name)) {
      throw new Error(`Invalid release plan.plugins[${index}].name.`);
    }
    return {
      name: pluginValue.name,
      ...normalizeAxis(pluginValue, `release plan.plugins[${index}]`, 'contentDigest', ['name']),
    };
  });
  if (new Set(plugins.map((entry) => entry.name)).size !== plugins.length) {
    throw new Error('Invalid release plan.plugins: duplicate plugin name.');
  }
  const normalized = {
    schemaVersion: 1,
    planId: digest(value.planId, 'release plan.planId'),
    planDigest: digest(value.planDigest, 'release plan.planDigest'),
    channel: value.channel,
    source: {
      head: source.head,
      releaseInputDigest: digest(source.releaseInputDigest, 'release plan.source.releaseInputDigest'),
      buildOutputDigest: digest(source.buildOutputDigest, 'release plan.source.buildOutputDigest'),
      cliPackageDigest: digest(source.cliPackageDigest, 'release plan.source.cliPackageDigest'),
      targetsDigest: digest(source.targetsDigest, 'release plan.source.targetsDigest'),
    },
    history: normalizeHistory(value.history),
    cli,
    catalog,
    plugins,
  };
  for (const [field, axis] of [
    ['release plan.cli', normalized.cli],
    ['release plan.catalog', normalized.catalog],
    ...normalized.plugins.map((plugin, index) => [`release plan.plugins[${index}]`, plugin]),
  ]) {
    if (axis.candidateVersion !== null && (axis.action === 'publish' || axis.action === 'recover')) {
      const isBeta = axis.candidateVersion.includes('-beta.');
      if ((normalized.channel === 'beta') !== isBeta) {
        throw new Error(`Invalid ${field}.candidateVersion: candidate does not match plan channel.`);
      }
    }
  }
  const catalogModeValid = (
    (normalized.catalog.action === 'recover' && normalized.catalog.publicationMode === 'promotion')
    || (normalized.catalog.action === 'publish' && normalized.cli.action === 'publish'
      && ['atomic-combined', 'tag-first'].includes(normalized.catalog.publicationMode))
    || (normalized.catalog.action === 'publish' && normalized.cli.action !== 'publish'
      && ['catalog-only', 'bootstrap'].includes(normalized.catalog.publicationMode))
    || (['skip', 'deferred'].includes(normalized.catalog.action)
      && normalized.catalog.publicationMode === 'none')
  );
  if (!catalogModeValid) throw new Error('Invalid release plan.catalog publication action/mode combination.');
  if (normalized.catalog.publicationMode === 'promotion') {
    const origin = normalized.history.catalog.tag?.origin;
    if (!origin) throw new Error('Invalid promotion plan: missing guarded Catalog tag origin.');
    const candidateVersion = normalized.catalog.candidateVersion;
    for (const packageName of CLI_PACKAGE_NAMES) {
      const entry = normalized.history.npm.packages.find((candidate) => candidate.name === packageName)
        .versions.find((candidate) => candidate.candidateVersion === candidateVersion);
      if (
        !entry?.metadata
        || entry.metadata.candidateVersion !== candidateVersion
        || entry.metadata.targetVersion !== normalized.cli.targetVersion
        || entry.metadata.planId !== origin.planId
        || entry.metadata.sourceHead !== origin.sourceHead
      ) {
        throw new Error(`Invalid promotion plan: ${packageName} metadata does not match the Catalog tag origin.`);
      }
    }
  }
  const catalogWrites = normalized.catalog.action === 'publish' || normalized.catalog.action === 'recover';
  if (catalogWrites !== (normalized.catalog.snapshotDigest !== null)) {
    throw new Error('Invalid release plan.catalog.snapshotDigest for the publication action.');
  }
  for (const tag of ['latest', 'beta']) {
    const [evalTag, awTag] = CLI_PACKAGE_NAMES.map((name) => {
      const version = normalized.history.npm.distTags.find((entry) => entry.name === name)[tag];
      const observations = normalized.history.npm.packages.find((entry) => entry.name === name).versions;
      if (version !== null && !observations.some((entry) => entry.candidateVersion === version)) {
        throw new Error(`Invalid release plan.history.npm.distTags: ${name} ${tag} is not observed.`);
      }
      return version;
    });
    const legacy = evalTag === null && (
      tag === 'beta'
        && normalized.history.npm.legacyBetaAwOnly
      || tag === 'latest'
        && awTag === '0.1.0-beta.1'
        && normalized.history.npm.legacyLatestAwOnly
    );
    if (evalTag !== awTag && !legacy) {
      throw new Error(`Invalid release plan.history.npm.distTags: ${tag} train tags differ.`);
    }
  }
  const recomputedDecision = planDecision(
    recomputePlanDecision(normalized),
    normalized.catalog.minCliVersion,
  );
  const recordedDecision = {
    source: normalized.source,
    cli: normalized.cli,
    catalog: { ...normalized.catalog },
    plugins: normalized.plugins,
  };
  delete recomputedDecision.catalog.snapshotDigest;
  delete recordedDecision.catalog.snapshotDigest;
  if (canonicalJson(recomputedDecision) !== canonicalJson(recordedDecision)) {
    throw new Error('Release plan decisions do not match the bound release observations.');
  }
  if (verifyDigests) {
    if (normalized.planId !== calculateCanonicalDigest(planIdentityInput(normalized))) {
      throw new Error('Release plan planId does not match its content.');
    }
    const { planDigest: omitted, ...digestInput } = normalized;
    if (normalized.planDigest !== calculateCanonicalDigest(digestInput)) {
      throw new Error('Release plan planDigest does not match its content.');
    }
  }
  return normalized;
}

function projectHistory(history) {
  const packages = CLI_PACKAGE_NAMES.map((name) => ({
    name,
    versions: (history.registry?.[name] ?? []).map((entry) => ({
      candidateVersion: entry.version,
      metadata: entry.awRelease ?? null,
    })),
  }));
  const distTags = CLI_PACKAGE_NAMES.map((name) => ({
    name,
    latest: history.registry?.distTags?.[name]?.latest ?? null,
    beta: history.registry?.distTags?.[name]?.beta ?? null,
  }));
  const registry = {
    ...Object.fromEntries(packages.map((entry) => [entry.name, entry.versions.map((version) => ({
      version: version.candidateVersion,
      awRelease: version.metadata,
    }))])),
    distTags: Object.fromEntries(distTags.map((entry) => [entry.name, {
      latest: entry.latest,
      beta: entry.beta,
    }])),
  };
  const channel = (entry, { tag = false } = {}) => entry ? {
    commit: entry.commit,
    candidateVersion: entry.manifest?.catalogVersion ?? entry.catalogVersion,
    contentDigest: entry.catalogContentDigest,
    ...(tag ? {
      snapshotDigest: entry.snapshotDigest ?? null,
      origin: entry.manifest?.release?.state === 'published' ? {
        targetVersion: entry.manifest.release.targetVersion,
        planId: entry.manifest.release.planId,
        sourceHead: entry.manifest.release.sourceHead,
        contentDigest: entry.manifest.release.contentDigest,
      } : null,
    } : {}),
  } : null;
  return {
    npm: {
      packages,
      distTags,
      legacyLatestAwOnly: normalizeCliRegistryHistory(registry).legacyLatestAwOnly,
      legacyBetaAwOnly: normalizeCliRegistryHistory(registry).legacyBetaAwOnly,
    },
    catalog: {
      latest: channel(history.catalog?.latest),
      beta: channel(history.catalog?.beta),
      tag: channel(history.catalog?.tag, { tag: true }),
      publicationGuard: history.catalog?.pending ?? null,
      pluginPublications: (history.catalog?.ledger?.records ?? []).map((entry) => ({
        name: entry.plugin,
        candidateVersion: entry.version,
        contentDigest: entry.contentDigest,
      })).filter((entry, index, entries) => entries.findIndex((candidate) =>
        candidate.name === entry.name
        && candidate.candidateVersion === entry.candidateVersion
        && candidate.contentDigest === entry.contentDigest) === index),
    },
  };
}

export function createReleasePlan(status) {
  const planBase = {
    schemaVersion: 1,
    channel: status.channel,
    source: status.source,
    history: projectHistory(status.history),
    cli: {
      targetVersion: status.cli.targetVersion,
      candidateVersion: status.cli.candidateVersion,
      trainContentDigest: status.cli.trainContentDigest,
      packages: status.cli.packages.map((entry) => ({
        ...entry,
        action: status.cli.action,
      })),
      action: status.cli.action,
      reason: status.cli.reason,
    },
    catalog: {
      targetVersion: status.catalog.targetVersion,
      candidateVersion: status.catalog.candidateVersion,
      catalogContentDigest: status.catalog.contentDigest,
      minCliVersion: status.catalog.minCliVersion,
      snapshotDigest: status.catalog.action === 'publish' || status.catalog.action === 'recover'
        ? status.catalog.snapshotDigest ?? status.catalog.contentDigest
        : null,
      publicationMode: status.catalog.publicationMode,
      action: status.catalog.action,
      reason: status.catalog.reason,
    },
    plugins: status.plugins.map((plugin) => ({
      name: plugin.name,
      targetVersion: plugin.targetVersion,
      candidateVersion: plugin.candidateVersion,
      contentDigest: plugin.contentDigest,
      action: plugin.action,
      reason: plugin.reason,
    })),
  };
  let planId = calculateCanonicalDigest(planIdentityInput(planBase));
  let draft = normalizeReleasePlan({
    ...planBase,
    planId,
    planDigest: `sha256:${'0'.repeat(64)}`,
  }, { verifyDigests: false });
  planId = calculateCanonicalDigest(planIdentityInput(draft));
  draft = { ...draft, planId };
  const { planDigest: omitted, ...digestInput } = draft;
  return normalizeReleasePlan({
    ...draft,
    planDigest: calculateCanonicalDigest(digestInput),
  });
}

export function serializeReleasePlan(plan) {
  return `${JSON.stringify(normalizeReleasePlan(plan), null, 2)}\n`;
}

async function lstatOptional(targetPath) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertPlanWriteBoundary(repoRoot, planPath, pointerPath) {
  const releaseRoot = path.join(repoRoot, 'release');
  const plansRoot = path.join(releaseRoot, 'plans');
  const releaseStats = await fs.lstat(releaseRoot);
  if (releaseStats.isSymbolicLink() || !releaseStats.isDirectory()) {
    throw new Error('Release plan root must be a regular directory.');
  }
  const plansStats = await lstatOptional(plansRoot);
  if (plansStats && (plansStats.isSymbolicLink() || !plansStats.isDirectory())) {
    throw new Error('Release plans root must be a regular directory.');
  }
  for (const [targetPath, field] of [[planPath, 'plan'], [pointerPath, 'pointer']]) {
    const stats = await lstatOptional(targetPath);
    if (stats && (stats.isSymbolicLink() || !stats.isFile())) {
      throw new Error(`Existing release ${field} must be a regular file.`);
    }
  }
}

export function normalizeCurrentPlanPointer(raw) {
  const value = object(raw, 'current release plan pointer');
  keys(value, 'current release plan pointer', ['schemaVersion', 'planId', 'planDigest', 'path']);
  if (value.schemaVersion !== 1) throw new Error('Invalid current release plan pointer.schemaVersion.');
  const planId = digest(value.planId, 'current release plan pointer.planId');
  const planDigest = digest(value.planDigest, 'current release plan pointer.planDigest');
  const expectedPath = `release/plans/${planId.slice('sha256:'.length)}.json`;
  if (value.path !== expectedPath) throw new Error('Invalid current release plan pointer.path.');
  return { schemaVersion: 1, planId, planDigest, path: expectedPath };
}

export async function writeReleasePlan(plan, options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const normalized = normalizeReleasePlan(plan);
  const plansRoot = path.join(repoRoot, 'release', 'plans');
  const planFileId = normalized.planId.slice('sha256:'.length);
  const planPath = path.join(plansRoot, `${planFileId}.json`);
  const pointerPath = path.join(repoRoot, 'release', 'current-plan.json');
  const contents = serializeReleasePlan(normalized);
  const pointer = `${JSON.stringify({
    schemaVersion: 1,
    planId: normalized.planId,
    planDigest: normalized.planDigest,
    path: `release/plans/${planFileId}.json`,
  }, null, 2)}\n`;
  await assertPlanWriteBoundary(repoRoot, planPath, pointerPath);
  await fs.mkdir(plansRoot, { recursive: true });
  let created = false;
  try {
    await fs.writeFile(planPath, contents, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    if (await fs.readFile(planPath, 'utf8') !== contents) {
      throw new Error(`Immutable release plan path already contains different bytes: ${planPath}.`);
    }
  }
  const temporaryPointer = `${pointerPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPointer, pointer, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
    await fs.rename(temporaryPointer, pointerPath);
  } catch (error) {
    await fs.rm(temporaryPointer, { force: true }).catch(() => undefined);
    if (created) await fs.rm(planPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return { planPath, pointerPath, created };
}

export async function readCurrentReleasePlan(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const pointerPath = path.join(repoRoot, 'release', 'current-plan.json');
  const pointerStats = await fs.lstat(pointerPath);
  if (!pointerStats.isFile() || pointerStats.isSymbolicLink()) {
    throw new Error('Current release plan pointer must be a regular file.');
  }
  const pointer = normalizeCurrentPlanPointer(JSON.parse(await fs.readFile(pointerPath, 'utf8')));
  const planPath = path.join(repoRoot, ...pointer.path.split('/'));
  const planStats = await fs.lstat(planPath);
  if (!planStats.isFile() || planStats.isSymbolicLink()) {
    throw new Error('Current release plan must be a regular file.');
  }
  const plan = normalizeReleasePlan(JSON.parse(await fs.readFile(planPath, 'utf8')));
  if (plan.planId !== pointer.planId || plan.planDigest !== pointer.planDigest) {
    throw new Error('Current release plan pointer does not match its immutable plan.');
  }
  return { plan, pointer, planPath };
}

export async function assertPlanOnlyCommit(plan, options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const normalized = normalizeReleasePlan(plan);
  await (options.assertClean ?? assertReleaseWorktreeClean)({ cwd: repoRoot });
  const git = async (args) => (options.runGit ?? runReleaseGit)(args, { cwd: repoRoot });
  const { stdout: headOutput } = await git(['rev-parse', '--verify', 'HEAD']);
  const head = headOutput.trim();
  const { stdout: parentsOutput } = await git(['rev-list', '--parents', '-n', '1', head]);
  const parents = parentsOutput.trim().split(/\s+/u).slice(1);
  if (parents.length !== 1) throw new Error('Plan-only commit must have exactly one parent.');
  if (parents[0] !== normalized.source.head) {
    throw new Error('Plan-only commit parent does not match plan.source.head.');
  }
  const { stdout: diffOutput } = await git([
    'diff-tree', '--no-commit-id', '--name-status', '-r', '-z', parents[0], head,
  ]);
  const records = diffOutput.split('\0').filter(Boolean);
  const expectedPlanPath = `release/plans/${normalized.planId.slice('sha256:'.length)}.json`;
  const observed = new Map();
  for (let index = 0; index < records.length; index += 2) observed.set(records[index + 1], records[index]);
  if (
    observed.size !== 2
    || observed.get(expectedPlanPath) !== 'A'
    || !['A', 'M'].includes(observed.get('release/current-plan.json'))
  ) throw new Error('HEAD is not an isolated plan-only commit.');
  const planContents = (await git(['show', `${head}:${expectedPlanPath}`])).stdout;
  if (planContents !== serializeReleasePlan(normalized)) throw new Error('Committed plan bytes do not match the plan.');
  const pointerContents = (await git(['show', `${head}:release/current-plan.json`])).stdout;
  const pointer = normalizeCurrentPlanPointer(JSON.parse(pointerContents));
  if (
    pointer?.schemaVersion !== 1
    || pointer.planId !== normalized.planId
    || pointer.planDigest !== normalized.planDigest
    || pointer.path !== expectedPlanPath
    || pointerContents !== `${JSON.stringify(pointer, null, 2)}\n`
  ) throw new Error('Committed current-plan pointer does not match the plan.');
  return { head, parent: parents[0], planPath: expectedPlanPath };
}
