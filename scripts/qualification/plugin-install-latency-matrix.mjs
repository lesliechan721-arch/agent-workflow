import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const harness = fileURLToPath(new URL('./plugin-install-latency.mjs', import.meta.url));
const modes = ['dedup', 'width', 'low-core', 'middle-core', 'entry-proof'];
const proposal = {
  rounds: 5, minimumFasterRounds: 4, macDedupMs: 2_000,
  otherDedupMs: 300, combinedOverBestSingleMs: 300, widthMs: 300,
  maxRegressionMs: 300, maxRegressionFraction: 0.05,
};
const clientSkillRoots = {
  antigravity: 'home/.gemini/config/plugins/', claude: 'claude/plugins/cache/',
  codex: 'codex/plugins/cache/', pi: 'pi/aw-packages/', generic: 'home/.agents/skills/',
};
const mainPlugins = ['human-content', 'frontend-design', 'decision-kit'];
const mainTargets = ['claude', 'pi', 'codex', 'antigravity', 'generic'];
const scenarios = {
  batch: { plugins: mainPlugins, targets: mainTargets, declarations: 'empty', entry: 'tui' },
  'single-codex': { plugins: ['agent-subagent'], targets: ['codex'], declarations: 'populated', entry: 'tui' },
  'single-pi': { plugins: ['human-content'], targets: ['pi'], declarations: 'populated', entry: 'tui' },
  'public-cli': { plugins: mainPlugins, targets: mainTargets, declarations: 'empty', entry: 'cli' },
  'larger-batch': { plugins: [...mainPlugins, 'agent-content-toolkit'], targets: mainTargets, declarations: 'empty', entry: 'tui' },
};
const hash = /^sha256:[a-f\d]{64}$/u;
const gitObject = /^[a-f\d]{40}$/u;
const readOptions = new Set(['--help', '--version', '-h', '-v', 'version', 'help']);
const inventoryWords = new Set(['list', 'ls', 'inspect', 'GET']);
const mutationWords = new Set(['add', 'install', 'update', 'enable', 'disable', 'remove', 'uninstall']);

function requireCondition(value, message) {
  if (!value) throw new Error(message);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

async function digestFile(file) {
  return `sha256:${createHash('sha256').update(await fs.readFile(file)).digest('hex')}`;
}

function compareStable(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
}

function median(values) {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function maximumOverlap(intervals) {
  const events = intervals.flatMap(({ startedMs, finishedMs }) => finishedMs > startedMs
    ? [[startedMs, 1], [finishedMs, -1]] : []);
  events.sort(([a, changeA], [b, changeB]) => a - b || changeA - changeB);
  let active = 0;
  let peak = 0;
  for (const [, change] of events) {
    active += change;
    peak = Math.max(peak, active);
  }
  return peak;
}

function nativeKind(call, nativeExecutables) {
  if (!call.nativeLabel) return null;
  const [executable, ...words] = call.nativeLabel.split(' ');
  if (!call.nativeAgent && !nativeExecutables.has(executable.toLowerCase())) return null;
  if (words.some((word) => readOptions.has(word))) return 'probe';
  if (words.some((word) => inventoryWords.has(word))) return 'inventory';
  if (words.some((word) => mutationWords.has(word))) return 'mutation';
  return 'unclassified';
}

function measurements(report) {
  const stages = ['review', 'execute'];
  const processes = stages.flatMap((stage) => report.stages[stage].processes);
  const nativeExecutables = new Set(report.measuredTargets.filter((target) => target !== 'generic').flatMap((target) => [
    target, ...(target === 'antigravity' ? ['agy'] : []),
    ...report.measuredClients[target].flatMap((entry) => entry.executable ? [path.basename(entry.executable).toLowerCase()] : []),
  ]).flatMap((name) => [name, `${name}.exe`, `${name}.cmd`]));
  const byKind = (kind) => processes.filter((row) => nativeKind(row, nativeExecutables) === kind);
  const nonHelperReadProcesses = [...byKind('probe'), ...byKind('inventory')]
    .filter((row) => row.systemRole !== 'windows-job-helper');
  return {
    wallMs: report.wallMs, reviewMs: report.reviewMs, executeMs: report.executeMs,
    sourceSyncMs: report.stages.sync.ms, tuiLoadMs: report.stages.load.ms,
    workerCpuMicroseconds: Object.fromEntries(stages.map((stage) => [stage, report.stages[stage].cpuMicroseconds])),
    workerPeakRssKiB: report.host.workerPeakRssKiB,
    loadAverage: report.host.loadAverage,
    transportScans: report.transportScans,
    effectiveConcurrency: report.effectiveInstallConcurrency,
    nativeProbeStarts: byKind('probe').length, nativeInventoryStarts: byKind('inventory').length,
    nativeMutationStarts: byKind('mutation').length, nativeRunnerCalls: report.nativeRunnerCalls,
    psStarts: processes.filter((row) => row.label === 'ps').length,
    posixMarkerScans: processes.filter((row) => row.systemRole === 'posix-marker-scan').length,
    posixIdentityScans: processes.filter((row) => row.systemRole === 'posix-identity-scan').length,
    windowsJobHelperStarts: processes.filter((row) => row.systemRole === 'windows-job-helper').length,
    directChildrenPeak: maximumOverlap(processes),
    directNativeReadPeak: maximumOverlap(nonHelperReadProcesses),
    directNativeMutationPeak: maximumOverlap(byKind('mutation').filter((row) => row.systemRole !== 'windows-job-helper')),
  };
}

export function verifySample(report, context) {
  const { plan, scenario, arm, host } = context;
  const issues = [];
  const check = (value, message) => { if (!value) issues.push(message); };
  check(!report.error, `runner error ${JSON.stringify(report.error)}`);
  check(report.buildArtifactDigest === arm.artifactDigest && report.buildRevision === arm.revision, 'Wrong build or source revision');
  check(report.activeDigest === plan.activeDigest, 'Wrong Active Catalog digest');
  check(['platform', 'arch', 'release', 'nodeVersion', 'availableParallelism']
    .every((key) => report.host[key] === host[key]), 'Host identity or effective core count changed');
  check(report.effectiveInstallConcurrency?.reads === Math.min(arm.readCap, host.availableParallelism)
    && report.effectiveInstallConcurrency?.writes === Math.min(2, host.availableParallelism), 'Effective scheduling limits differed');
  if (report.error) return { issues };
  const roots = scenario.plugins.map((name) => `official/${name}`);
  const populated = scenario.declarations === 'populated';
  check(report.entry === scenario.entry && report.scope === 'user' && report.declarationsFixture === scenario.declarations,
    'Wrong entry, scope or initial declarations fixture');
  check(compareStable(report.batchRoots) === compareStable(roots)
    && compareStable(report.measuredTargets) === compareStable(scenario.targets), 'Wrong requested targets or roots');
  check(report.userRoots.length === (populated ? 7 : 0) && report.projectRoots.length === (populated ? 2 : 0),
    'Wrong initial declaration counts');
  check(scenario.entry === 'cli' ? report.cli?.exitCode === 0
    : report.preview && !report.preview.errors.length && !report.preview.blockers.length, 'Review or public CLI failed');
  const receipt = report.result;
  check(receipt?.ok, 'Overall receipt failed');
  const expectedTargets = roots.flatMap((root) => scenario.targets.map((target) => `${root}:${target}`)).sort();
  const actual = receipt?.targets ?? [];
  check(compareStable(actual.map((row) => `${row.pluginId}:${row.agent}`).sort()) === compareStable(expectedTargets),
    'Receipt target list differed');
  const rawTargets = report.completeReceipt?.targetResults ?? report.completeReceipt?.data?.targetResults ?? [];
  const fixtures = report.skillOutputs?.fixtures ?? [];
  const outputs = report.skillOutputs?.outputs ?? [];
  for (const { pluginId, agent, scope, execution, observation, content } of actual) {
    const id = `${pluginId}:${agent}`;
    check(scope === 'user' && ['applied', 'no-op'].includes(execution) && observation === 'verified' && content === 'satisfied',
      `${id} installation was not fully verified`);
    const expectedSkills = fixtures.filter((fixture) => fixture.pluginId === pluginId);
    check(expectedSkills.length, `${id} missing fixture inventory`);
    for (const fixture of expectedSkills) {
      const installed = outputs.filter((row) => row.skill === fixture.skill && row.path.startsWith(clientSkillRoots[agent]));
      check(installed.length === 1, `${id}/${fixture.skill} missing an exact installed copy`);
      const row = installed[0];
      if (!row) continue;
      if (context.caseName === 'single-codex') {
        check(Object.keys(row.files).length === 61, `${id} did not deliver 61 generated Skill files`);
      } else {
        check(Object.entries(fixture.files).every(([name, digest]) => row.files[name] === digest),
          `${id}/${fixture.skill} source file bytes differed`);
      }
      if (agent === 'generic') {
        const owner = row.owner;
        check(owner?.owner === 'agent-workflows' && owner.pluginId === pluginId && owner.scope === 'user' && owner.platform === agent
          && owner.skill === fixture.skill && owner.logicalIdentity === report.catalogLogicalIdentity
          && owner.filesDigest && owner.configDigest, `${id}/${fixture.skill} ownership differed`);
      }
    }
    if (agent === 'generic') continue;
    const row = rawTargets.find((item) => item.pluginId === pluginId && (item.agent ?? item.target) === agent);
    const placements = row?.deploymentReceipts ?? row?.backend?.deploymentReceipts ?? [];
    const states = placements.map((item) => item.after).filter(Boolean);
    check(states.some((state) => state.ownership === 'aw' && state.registration === 'present'), `${id} lacks verified native registration`);
    check(states.some((state) => state.configuration?.activation === 'enabled'
      || state.consumers?.some((consumer) => consumer.activation === 'enabled')), `${id} lacks verified native activation`);
    const name = report.nativePackages?.find((item) => item.pluginId === pluginId && item.agent === agent);
    check(name?.owner?.owner === 'agent-workflows' && name.owner?.pluginId === pluginId
      && name.owner?.platform === agent && name.owner?.scope === 'user', `${id} lacks installed source package ownership`);
    const installedVersions = new Set([...(name?.manifests ?? []).map((item) => item.version), ...states.map((item) => item.packageVersion)]);
    check(expectedSkills.every((fixture) => installedVersions.has(fixture.version)), `${id} installed version differed`);
  }
  if (context.caseName === 'single-codex') {
    check(Object.keys(report.installedRoleDigests ?? {}).length === 1, 'Expected exactly one physical Codex role');
  }
  const saved = report.declarations;
  const userRoots = [...new Set([...report.userRoots, ...roots])].sort();
  check(saved && compareStable(saved.user.roots.map((root) => root.pluginId).sort()) === compareStable(userRoots)
    && compareStable(saved.project.roots.map((root) => root.pluginId).sort()) === compareStable(report.projectRoots.toSorted()),
  'Saved declarations differed');
  for (const client of scenario.targets.filter((target) => target !== 'generic')) {
    const versions = report.measuredClients?.[client]?.filter((item) => item.product === 'cli' && item.availability === 'available');
    check(versions?.length && versions.every((item) => item.version === plan.clientVersions[client]), `${client} did not use the pinned native CLI version`);
  }
  const measured = [report.stages.review, report.stages.execute];
  check(measured.every((stage) => Number.isFinite(stage.ms) && Object.values(stage.providerCalls).every((count) => count === 0)),
    'Incomplete duration or warm path invoked a Catalog provider');
  check(measured.every((stage) => stage.processes.every((call) => call.finishedMs !== null
    && call.nativeError !== 'timeout' && !call.cleanupUnconfirmed)), 'Unobserved exit, timeout or uncertain cleanup');
  const content = {
    preview: report.preview, receipt, declarations: saved, clients: report.measuredClients,
    skills: outputs.toSorted((a, b) => a.path.localeCompare(b.path)),
    roles: report.installedRoleDigests,
    nativePackages: (report.nativePackages ?? []).toSorted((a, b) => a.package.localeCompare(b.package)),
  };
  return { issues, content, metrics: measurements(report) };
}

function buildSchedule(plan) {
  requireCondition(modes.includes(plan.mode) && ['darwin', 'linux', 'win32'].includes(plan.platform), 'Unsupported mode or OS');
  requireCondition(hash.test(plan.activeDigest), 'A fixed Catalog Active digest is required');
  const names = plan.mode === 'dedup' && (plan.platform === 'darwin' || plan.platform === 'linux' && plan.markerScans)
    ? ['baseline', 'query', 'scan', 'combined']
    : plan.mode === 'dedup' ? ['baseline', 'query'] : ['baseline', 'candidate'];
  const rounds = names.length === 4 ? [
    [0, 1, 3, 2], [2, 3, 1, 0], [1, 2, 0, 3], [3, 0, 2, 1], [0, 2, 1, 3],
  ] : [[0, 1], [1, 0], [0, 1], [1, 0], [0, 1]];
  const required = plan.mode === 'entry-proof' ? ['public-cli', 'larger-batch'] : ['batch', 'single-codex', 'single-pi'];
  for (const name of names) {
    const arm = plan.arms?.[name];
    requireCondition(arm && hash.test(arm.artifactDigest) && gitObject.test(arm.revision) && gitObject.test(arm.sourceTree)
      && arm.readCap === (plan.mode === 'dedup' || name === 'baseline' || plan.mode === 'entry-proof' ? 4 : 8),
    `Invalid qualified build metadata for ${name}`);
  }
  const caseDetails = Object.fromEntries(required.map((name) => {
    const scenario = { ...scenarios[name], ...plan.scenarios?.[name] };
    requireCondition(scenario.plugins?.length && scenario.targets?.length && scenario.targets.every((target) => target in clientSkillRoots),
      `${name} has unsupported targets or fixtures`);
    requireCondition(scenario.targets.some((target) => target !== 'generic')
      && scenario.targets.every((target) => target === 'generic' || typeof plan.clientVersions?.[target] === 'string'),
    `${name} requires pinned real native clients`);
    if (name === 'batch' && plan.platform === 'darwin' && plan.mode === 'dedup') {
      requireCondition(compareStable(scenario) === compareStable(scenarios.batch), 'macOS dedup requires the fixed 3×5 case');
    }
    if (name.startsWith('single')) {
      requireCondition(compareStable(scenario) === compareStable(scenarios[name]), `Keep the fixed populated fixture for ${name}`);
    }
    return [name, scenario];
  }));
  const schedule = required.flatMap((caseName) => rounds.flatMap((order, index) =>
    order.map((slot) => ({ round: index + 1, caseName, name: names[slot] }))));
  return { names, caseDetails, schedule };
}

async function inspectHost(plan) {
  const host = {
    platform: process.platform, arch: process.arch, release: os.release(), nodeVersion: process.version,
    cpu: os.cpus()[0]?.model, availableParallelism: os.availableParallelism(),
    actions: process.env.GITHUB_ACTIONS === 'true' ? {
      runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, image: process.env.ImageOS,
      imageVersion: process.env.ImageVersion,
    } : undefined,
  };
  const blocked = [];
  if (plan.platform !== host.platform) blocked.push('This OS is outside the planned host');
  if (host.availableParallelism < (plan.mode === 'width' ? 8 : plan.mode === 'middle-core' ? 5 : 1)
    || host.availableParallelism > (plan.mode === 'middle-core' ? 7 : plan.mode === 'low-core' ? 4 : Infinity)) {
    blocked.push('This process does not have the required real CPU availability');
  }
  if (host.platform === 'darwin' || host.platform === 'linux') {
    const scans = [['-A', '-o', 'pid=,ppid=,pgid=,state=,lstart=']];
    if (host.platform === 'darwin' || plan.markerScans) scans.push(['eww', '-A', '-o', 'pid=,ppid=,pgid=,state=,lstart=,command=']);
    for (const args of scans) {
      try {
        const { stdout } = await exec('ps', args, { maxBuffer: 8 * 1024 * 1024, timeout: 3_000 });
        if (!stdout.trim()) blocked.push('Process inspection returned no rows');
      } catch (error) {
        blocked.push(`Process inspection unavailable (${error.code ?? error.name})`);
      }
    }
  }
  return { host, blocked };
}

async function runSample(context, location) {
  const { plan, scenario, arm } = context;
  const raw = `${location.prefix}.json`;
  const args = [harness, '--output', raw, '--build-root', arm.buildRoot,
    '--build-revision', arm.revision, '--expected-build-digest', arm.artifactDigest,
    '--catalog', plan.catalog, '--expected-active-digest', plan.activeDigest,
    '--entry', scenario.entry, '--declarations', scenario.declarations,
    '--sandbox-root', location.sandboxRoot,
    ...scenario.plugins.flatMap((plugin) => ['--plugin', plugin]),
    ...scenario.targets.flatMap((target) => ['--target', target])];
  const log = await fs.open(`${location.prefix}.log`, 'wx', 0o600);
  let exit;
  const start = new Date().toISOString();
  try {
    exit = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { stdio: ['ignore', log.fd, log.fd] });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } catch (error) {
    exit = { error: error.code ?? error.name };
  } finally {
    await log.close();
  }
  let verification;
  try {
    verification = verifySample(await readJson(raw), context);
  } catch (error) {
    verification = { issues: [`sample unavailable or malformed (${error.code ?? error.message})`] };
  }
  if (exit.code !== 0) verification.issues.push(`launcher failed (${JSON.stringify(exit)})`);
  return { start, end: new Date().toISOString(), raw: path.basename(raw), exit, ...verification };
}

function decide(plan, names, rows) {
  const comparisons = {};
  function pair(caseName, left, right) {
    const pairs = Array.from({ length: proposal.rounds }, (_item, index) => {
      const get = (name) => rows.find((row) => row.caseName === caseName && row.round === index + 1 && row.name === name);
      const a = get(left), b = get(right);
      return a?.metrics && b?.metrics && !a.issues.length && !b.issues.length ? [a.metrics, b.metrics] : null;
    });
    if (!pairs.every(Boolean)) return null;
    const delta = (key) => pairs.map(([a, b]) => a[key] - b[key]);
    const wallSavings = delta('wallMs');
    const baselineMedian = median(pairs.map(([row]) => row.wallMs));
    return {
      wallSavings, baselineMedian, pairedMedianSavings: median(wallSavings),
      fasterRounds: wallSavings.filter((ms) => ms > 0).length,
      baselineSlowest: Math.max(...pairs.map(([row]) => row.wallMs)),
      candidateSlowest: Math.max(...pairs.map(([, row]) => row.wallMs)),
      queryStartsSaved: delta('nativeProbeStarts'), markerScansSaved: delta('posixMarkerScans'),
      zeroPosixScans: pairs.every(([a, b]) => a.psStarts === 0 && b.psStarts === 0),
      maxCandidateDirectNativeReadPeak: Math.max(...pairs.map(([, row]) => row.directNativeReadPeak)),
      observedJobHelper: pairs.some(([a, b]) => a.windowsJobHelperStarts > 0 || b.windowsJobHelperStarts > 0),
    };
  }
  const enough = (row, ms) => row && row.pairedMedianSavings >= ms && row.fasterRounds >= proposal.minimumFasterRounds;
  const noRegression = (row) => row && row.pairedMedianSavings >= -Math.max(proposal.maxRegressionMs, row.baselineMedian * proposal.maxRegressionFraction);
  if (plan.mode === 'entry-proof') {
    for (const caseName of ['public-cli', 'larger-batch']) comparisons[caseName] = pair(caseName, 'baseline', 'candidate');
    return { comparisons, entryChecksPassed: Object.values(comparisons).every(Boolean) };
  }
  for (const name of names.slice(1)) {
    comparisons[name] = Object.fromEntries(['batch', 'single-codex', 'single-pi'].map((caseName) => [caseName, pair(caseName, 'baseline', name)]));
  }
  const singles = (row) => noRegression(row['single-codex']) && noRegression(row['single-pi']);
  if (plan.mode !== 'dedup') {
    const row = comparisons.candidate;
    const candidateReadObserved = row.batch && row.batch.maxCandidateDirectNativeReadPeak > 4
      && !(plan.platform === 'win32' && row.batch.observedJobHelper);
    const passed = plan.mode === 'width'
      ? candidateReadObserved && enough(row.batch, proposal.widthMs) : noRegression(row.batch);
    return { comparisons, candidateReadObserved, localTimingProposalPassed: Boolean(passed && singles(row)) };
  }
  const delta = plan.platform === 'darwin' ? proposal.macDedupMs : proposal.otherDedupMs;
  const eligible = (name, row) => enough(row.batch, delta) && singles(row)
    && (name === 'scan' || row.batch.queryStartsSaved.every((count) => count > 0))
    && (name === 'query' || row.batch.markerScansSaved.every((count) => count > 0))
    && (plan.platform !== 'linux' || plan.markerScans || row.batch.zeroPosixScans);
  const acceptableSingles = ['query', 'scan'].filter((name) => comparisons[name] && eligible(name, comparisons[name]))
    .sort((a, b) => comparisons[b].batch.pairedMedianSavings - comparisons[a].batch.pairedMedianSavings);
  const best = acceptableSingles[0];
  let localTimingChoice = best ?? 'baseline';
  if (comparisons.combined && eligible('combined', comparisons.combined)) {
    comparisons.combinedVersusBestSingle = best ? pair('batch', best, 'combined') : null;
    if (!best || enough(comparisons.combinedVersusBestSingle, proposal.combinedOverBestSingleMs)) localTimingChoice = 'combined';
  }
  return { comparisons, localTimingChoice };
}

async function main() {
  const [planFile, directory, flag, ...extra] = process.argv.slice(2);
  if (planFile === '--help') {
    process.stdout.write('Usage: node scripts/qualification/plugin-install-latency-matrix.mjs <plan.json> <new evidence directory> [--plan-only]\n');
    return;
  }
  requireCondition(planFile && directory && (!flag || flag === '--plan-only') && !extra.length, 'Supply a plan and fresh evidence directory. See --help.');
  const plan = await readJson(planFile);
  const { schedule, names, caseDetails } = buildSchedule(plan);
  const output = path.resolve(directory);
  await fs.mkdir(output, { mode: 0o700 });
  const { host, blocked } = await inspectHost(plan);
  const harnessFiles = [fileURLToPath(import.meta.url), harness, fileURLToPath(new URL('./plugin-install-latency-observation.mjs', import.meta.url)),
    fileURLToPath(new URL('./native-platform-runtime.mjs', import.meta.url))];
  const identity = {
    plan, caseDetails, schedule, host, blocked, proposal,
    harnessDigests: Object.fromEntries(await Promise.all(harnessFiles.map(async (file) => [path.basename(file), await digestFile(file)]))),
  };
  await writeJson(path.join(output, 'plan.json'), identity);
  if (flag === '--plan-only' || blocked.length) {
    await writeJson(path.join(output, 'summary.json'), { outcome: blocked.length ? 'blocked' : 'plan-only', blocked, samples: [] });
    if (blocked.length && flag !== '--plan-only') process.exitCode = 1;
    return;
  }
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-fixed-latency-'));
  const references = new Map();
  const failures = new Set();
  const rows = [];
  try {
    for (const step of schedule) {
      const prefix = path.join(output, `${String(step.round).padStart(2, '0')}-${step.caseName}-${step.name}`);
      const context = { ...step, plan, host, scenario: caseDetails[step.caseName], arm: plan.arms[step.name] };
      let row;
      if (failures.has('baseline') || failures.has(step.name)) {
        row = { skipped: true, issues: ['Arm suspended after failed verification'] };
      } else {
        row = await runSample(context, { prefix, sandboxRoot: path.join(parent, `aw-install-latency-${step.caseName}`) });
        const caseReferences = references.get(step.caseName) ?? new Map();
        if (row.content && !row.issues.length) {
          const first = caseReferences.get('baseline') ?? caseReferences.get(step.name);
          if (first && compareStable(first) !== compareStable(row.content)) {
            row.issues.push('Review, receipt or physical content differed from the matching reference');
          }
          caseReferences.set(step.name, row.content);
          references.set(step.caseName, caseReferences);
        }
        if (row.issues.length) failures.add(step.name);
      }
      const { content, ...summary } = row;
      if (step.name === 'baseline' && content && !row.issues.length) {
        for (const [name, previous] of references.get(step.caseName)) {
          if (compareStable(previous) !== compareStable(content)) failures.add(name);
        }
      }
      const record = { ...step, ...summary };
      rows.push(record);
      await writeJson(`${prefix}.result.json`, record);
      process.stdout.write(`${step.round}/${proposal.rounds} ${step.caseName} ${step.name} ${row.issues.length ? row.issues.join(', ') : `${row.metrics.wallMs}ms`}\n`);
    }
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
  const comparedRows = rows.map((row) => failures.has(row.name)
    ? { ...row, issues: [...row.issues, 'Arm failed correctness for this campaign'] } : row);
  await writeJson(path.join(output, 'summary.json'), {
    outcome: failures.size ? 'failed-verification' : 'measured',
    scope: 'Host timing and physical installation only. Selection also requires functional and process-cleanup qualification.',
    failedArms: [...failures], ...decide(plan, names, comparedRows), samples: comparedRows,
  });
  if (failures.size) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
