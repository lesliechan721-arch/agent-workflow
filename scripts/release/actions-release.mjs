#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function parseActionsArgs(argv) {
  const [command, ...args] = argv;
  if (!['beta', 'source', 'inspect', 'prepare', 'unpack', 'publish'].includes(command)) throw new Error('Expected beta, source, inspect, prepare, unpack, or publish.');
  const result = { command };
  const booleans = new Set(['repair-cli', 'repair-cli-tag']);
  const values = new Set(['product', 'version', 'source', 'tag', 'archive', 'digest']);
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index].replace(/^--/u, '');
    if (!args[index].startsWith('--') || Object.hasOwn(result, key)) throw new Error('Invalid or duplicate release argument.');
    if (booleans.has(key)) result[key] = true;
    else if (values.has(key) && args[index + 1] && !args[index + 1].startsWith('--')) result[key] = args[++index];
    else throw new Error(`Unknown or missing release argument: ${args[index]}`);
  }
  if (command !== 'beta' && command !== 'unpack' && !['cli', 'catalog'].includes(result.product)) throw new Error('Select product cli or catalog.');
  if (result['repair-cli'] && result['repair-cli-tag']) throw new Error('Select one CLI repair mode.');
  if ((result['repair-cli'] || result['repair-cli-tag']) && result.product !== 'cli') throw new Error('CLI repair accepts only the CLI product.');
  return result;
}

async function outputs(values, options) {
  const destination = (options.env ?? process.env).GITHUB_OUTPUT;
  if (destination) await fs.appendFile(destination, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
  return values;
}

async function summary(value, options) {
  const destination = (options.env ?? process.env).GITHUB_STEP_SUMMARY;
  if (destination) await fs.appendFile(destination, `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`);
  (options.log ?? console.log)(JSON.stringify(value));
}

async function candidateFor(args, options) {
  const source = await import('./source-candidate.mjs');
  const parsed = source.parseSourceTag(args.tag);
  if (parsed.product !== args.product) throw new Error('Source tag targets another product.');
  return { ...await source.validateSourceCandidate({ ...options, tag: args.tag }), tag: args.tag };
}

async function compiled(name, options) {
  const root = options.repoRoot ?? defaultRoot;
  const dist = options.cliDistRoot ?? path.join(root, 'packages/cli/dist');
  return import(pathToFileURL(path.join(dist, 'src/commands', `${name}.js`)).href);
}

async function prepareCandidate(candidate, options) {
  const repoRoot = options.repoRoot ?? defaultRoot;
  const destination = path.join(repoRoot, '.release/actions/candidate');
  const { sealCandidateDirectory, archiveCandidate } = await import('./candidate-archive.mjs');
  const { calculateCanonicalDigest } = await import('./release-model.mjs');
  const { resolveReleaseHead } = await import('./common.mjs');
  if (await resolveReleaseHead({ cwd: repoRoot }) !== candidate.candidateHead) throw new Error('Preparation must check out the exact source candidate.');
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  const metadata = { ...candidate, schemaVersion: 1 };
  if (candidate.product === 'cli') {
    const service = await import('./prepared-release.mjs');
    const descriptor = await service.prepareLocalRelease(candidate.channel, {
      ...options, axes: { cli: true, catalog: false },
      exactCandidates: { cli: candidate.version, catalog: null },
    });
    const intent = await service.markPreparedCliAttempt(options);
    await service.exportPreparedRelease({ ...options, destination: path.join(destination, 'cli') });
    metadata.descriptorDigest = calculateCanonicalDigest(descriptor);
    metadata.intentDigest = intent.intentDigest;
  } else {
    const { prepareCatalogRelease } = await import('./catalog-publication.mjs');
    const { packCliBundle } = await import('./pack-cli.mjs');
    const plan = await prepareCatalogRelease(candidate.channel === 'stable' ? 'latest' : 'beta', options);
    if (plan.sourceHead !== candidate.candidateHead || plan.catalogVersion !== candidate.version) throw new Error('Catalog plan does not match its exact source candidate.');
    await fs.cp(path.join(repoRoot, '.aw/publish', candidate.version), path.join(destination, 'catalog/publication'), { recursive: true, errorOnExist: true, force: false });
    const tools = path.join(destination, 'tools');
    await fs.mkdir(tools);
    await packCliBundle({ destination: tools });
    metadata.planDigest = plan.planDigest;
  }
  await sealCandidateDirectory(destination, metadata);
  const archive = path.join(repoRoot, '.release/actions/candidate.tar');
  const digest = await archiveCandidate(destination, archive);
  await fs.writeFile(path.join(repoRoot, '.release/actions/digest.txt'), `${digest}\n`);
  await summary({ product: candidate.product, version: candidate.version, sourceHead: candidate.sourceHead,
    candidateHead: candidate.candidateHead, bundleDigest: digest, recoveryRetentionDays: 30,
    recoveryLimit: 'Missing, damaged, or expired candidates require a new version.' }, options);
  return outputs({ bundle_digest: digest, version: candidate.version }, options);
}

async function importCatalog(root, candidate, options) {
  const { parseCatalogPublicationJournal } = await compiled('catalog-publication-journal', options);
  const source = path.join(root, 'catalog/publication');
  const journal = parseCatalogPublicationJournal(JSON.parse(await fs.readFile(path.join(source, 'journal.json'), 'utf8')), candidate.version);
  if (journal.planDigest !== candidate.planDigest || journal.descriptor.sourceHead !== candidate.candidateHead) throw new Error('Saved Catalog plan does not match the source candidate.');
  const repoRoot = options.repoRoot ?? defaultRoot;
  const target = path.join(repoRoot, '.aw/publish', candidate.version);
  for (const ancestor of [path.join(repoRoot, '.aw'), path.join(repoRoot, '.aw/publish')]) {
    await fs.mkdir(ancestor, { recursive: true });
    const stats = await fs.lstat(ancestor);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('Catalog recovery path is unsafe.');
  }
  try {
    const existing = parseCatalogPublicationJournal(JSON.parse(await fs.readFile(path.join(target, 'journal.json'), 'utf8')), candidate.version);
    if (existing.planDigest !== journal.planDigest) throw new Error('A different Catalog plan already occupies this version.');
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // A directory without its journal is damaged recovery state, not an empty runner.
  try {
    await fs.lstat(target);
    throw new Error('Catalog recovery journal is missing. Publish a new version.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const staging = await fs.mkdtemp(path.join(path.dirname(target), '.import-'));
  try {
    await fs.cp(source, staging, { recursive: true, force: false });
    await fs.rename(staging, target);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function saveFinal(root, candidate, options) {
  const repoRoot = options.repoRoot ?? defaultRoot;
  if (candidate.product === 'cli') {
    const service = await import('./prepared-release.mjs');
    const destination = path.join(root, 'cli');
    await fs.rm(destination, { recursive: true, force: true });
    await service.exportPreparedRelease({ ...options, destination });
  } else {
    const destination = path.join(root, 'catalog/publication');
    await fs.rm(destination, { recursive: true, force: true });
    await fs.cp(path.join(repoRoot, '.aw/publish', candidate.version), destination, { recursive: true });
  }
  const { sealCandidateDirectory, archiveCandidate } = await import('./candidate-archive.mjs');
  const { files, ...metadata } = candidate;
  await sealCandidateDirectory(root, metadata);
  const final = path.join(repoRoot, '.release/actions/final.tar');
  const digest = await archiveCandidate(root, final);
  await fs.mkdir(path.join(repoRoot, '.release/actions/final'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, '.release/actions/final/digest.txt'), `${digest}\n`);
  await outputs({ final_digest: digest }, options);
}

async function publishCandidate(args, options) {
  const { extractCandidate, verifyCandidateDirectory } = await import('./candidate-archive.mjs');
  const expected = await candidateFor(args, options);
  const root = path.join(options.repoRoot ?? defaultRoot, '.release/actions/candidate');
  await extractCandidate(args.archive, root, args.digest);
  const candidate = await verifyCandidateDirectory(root, expected);
  if (candidate.product === 'cli') {
    const service = await import('./prepared-release.mjs');
    const binding = await service.importPreparedRelease({
      ...options, from: path.join(root, 'cli'), expectedSourceHead: candidate.candidateHead,
      expectedVersion: candidate.version, expectedDescriptorDigest: candidate.descriptorDigest,
    });
    const publication = { ...options, portable: true, portableBinding: binding.portableBinding,
      expectedDescriptorDigest: candidate.descriptorDigest, npmCommand: 'npm' };
    try {
      if (args['repair-cli']) await service.repairPreparedCliRelease(publication);
      else if (args['repair-cli-tag']) {
        const { assertPublishedCliArtifactsMatch, ensureCliTag } = await import('./cli-git-tag.mjs');
        await service.assertPreparedCliAttempt(binding.descriptor, options);
        await assertPublishedCliArtifactsMatch(binding.root, binding.descriptor, publication);
        await ensureCliTag(candidate.version, candidate.candidateHead, publication);
      } else {
        const { assertFirstPublication } = await import('./actions-inspection.mjs');
        await assertFirstPublication(candidate, options);
        await service.publishPreparedRelease({ ...publication, initialAttemptDigest: candidate.intentDigest });
      }
    } finally {
      await saveFinal(root, candidate, options);
    }
  } else {
    // The publisher is loaded from the saved tooling packages. A fresh runner
    // does not rebuild the CLI or the already prepared Catalog snapshot.
    const { installCandidatePackages } = await import('./candidate-smoke.mjs');
    const toolsRoot = path.join(options.repoRoot ?? defaultRoot, '.release/actions/catalog-tools');
    await fs.mkdir(toolsRoot, { recursive: true });
    await installCandidatePackages(root, candidate, toolsRoot, options.env ?? process.env);
    const toolingOptions = { ...options, cliDistRoot: path.join(toolsRoot, 'node_modules/@lesliechan721/aw/dist') };
    toolingOptions.catalogPublicationService = {
      ...await compiled('catalog-publication-inspection', toolingOptions),
      ...await compiled('catalog-publish', toolingOptions),
    };
    await importCatalog(root, candidate, toolingOptions);
    try {
      const { publishCatalogRelease } = await import('./catalog-publication.mjs');
      await publishCatalogRelease({ channel: candidate.channel, expectedPlanDigest: candidate.planDigest }, toolingOptions);
    } finally {
      await saveFinal(root, candidate, options);
    }
  }
  await summary({ product: candidate.product, version: candidate.version, result: 'published', bundleDigest: args.digest }, options);
}

export async function runActionsRelease(argv = process.argv.slice(2), supplied = {}) {
  const args = parseActionsArgs(argv);
  const options = { repoRoot: defaultRoot, env: process.env, ...supplied };
  options.releaseRoot ??= path.join(options.repoRoot, '.release');
  if (args.command === 'unpack') {
    const { extractCandidate } = await import('./candidate-archive.mjs');
    return extractCandidate(args.archive, path.join(options.repoRoot, '.release/actions/candidate'), args.digest);
  }
  if (args.command === 'source') {
    const { prepareSourceCandidate } = await import('./source-candidate.mjs');
    const { parseSourceTag } = await import('./source-candidate.mjs');
    const parsed = parseSourceTag(`release/${args.product}/v${args.version}`);
    const pluginBaseVersions = args.product === 'catalog'
      ? await (await import('./catalog-publication.mjs')).resolveCatalogPluginBaseVersions({ ...options, channel: parsed.channel, sourceHead: args.source })
      : undefined;
    const candidate = await prepareSourceCandidate({ ...options, product: args.product,
      version: args.version, sourceHead: args.source, pluginBaseVersions, push: true });
    return summary(candidate, options);
  }
  if (args.command === 'beta') {
    const { planAutomaticBeta } = await import('./beta-plan.mjs');
    const { prepareSourceCandidate } = await import('./source-candidate.mjs');
    const plan = await planAutomaticBeta({ ...options, sourceHead: args.source });
    await summary(plan, options);
    if (plan.skipped) return plan;
    const env = options.env ?? process.env;
    const ciRun = env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/main'
      && env.GITHUB_SHA === plan.sourceHead && env.GITHUB_RUN_ID && env.GITHUB_RUN_ATTEMPT
      ? `${env.GITHUB_RUN_ID}/${env.GITHUB_RUN_ATTEMPT}` : undefined;
    const results = [];
    for (const product of ['cli', 'catalog']) {
      const selected = plan.products[product];
      if (selected.error) {
        results.push({ product, error: selected.error });
        continue;
      }
      if (!selected.changed) continue;
      try {
        results.push(await prepareSourceCandidate({ ...options, product, version: selected.version,
          sourceHead: plan.sourceHead, pluginBaseVersions: selected.pluginBaseVersions,
          ciRun, push: true, requireMainTip: true }));
      } catch (error) {
        results.push({ product, error: error.message });
      }
    }
    await summary({ candidates: results }, options);
    if (results.some((entry) => entry.error)) throw new Error('At least one product candidate could not be created. Other successful candidates remain valid.');
    return plan;
  }
  const candidate = await candidateFor(args, options);
  if (args.command === 'inspect') {
    const { readRemoteCompletion, findRecoveryArtifact, canReuseMainCi } = await import('./actions-inspection.mjs');
    const completed = await readRemoteCompletion(candidate, options);
    const recovery = completed ? { recovery_run: '', recovery_artifact: '', recovery_digest: '', recovery_archive: 'candidate.tar' }
      : await findRecoveryArtifact(candidate, options);
    const reuseMainCi = !completed && recovery.recovery_artifact === '' && await canReuseMainCi(candidate, options);
    await summary({ ...candidate, completed, ...recovery, reuseMainCi }, options);
    return outputs({ ...recovery, completed: String(completed), version: candidate.version, reuse_main_ci: String(reuseMainCi) }, options);
  }
  if (args.command === 'prepare') return prepareCandidate(candidate, options);
  return publishCandidate(args, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runActionsRelease();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
