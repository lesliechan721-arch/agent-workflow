import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createProcessNameDiagnostic, createProcessMarkerRowDiagnostic, createLinuxEnvironmentDiagnostic } from './native-platform-process-names.mjs';
import { createMarkerIdentityConfirmationCapture } from './native-platform-marker-confirmations.mjs';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const clients = {
  codex: { version: '0.167.0', package: '@openai/codex', bin: 'codex', source: 'https://github.com/openai/codex' },
  pi: { version: '1.5.0', package: '@earendil-works/pi-coding-agent', bin: 'pi', source: 'https://github.com/earendil-works/pi' },
  claude: { version: '2.1.317', package: '@anthropic-ai/claude-code', bin: 'claude', source: 'https://code.claude.com/docs/en/setup' },
  gemini: { version: '0.67.0', package: '@google/gemini-cli', bin: 'gemini', source: 'https://github.com/google-gemini/gemini-cli' },
  copilot: { version: '1.0.95', package: '@github/copilot', bin: 'copilot', source: 'https://docs.github.com/en/copilot/get-started/cli-quickstart' },
  grok: { version: '1.0.77', package: '@xai-official/grok', bin: 'grok', source: 'https://github.com/xai-org/grok-build' },
  opencode: { version: '2.0.0', package: '@opencode/cli', bin: 'opencode', source: 'https://github.com/anomalyco/opencode/tree/v2.0.0' },
};

// Client processes receive no credentials, user configuration or NODE_OPTIONS.
// Only the download process may use the caller's HTTP(S) transport proxy.
export function isolatedEnvironment(root, network = false) {
  const home = path.join(root, 'home');
  const env = {
    PATH: process.env.PATH ?? process.env.Path ?? path.dirname(process.execPath),
    HOME: home, USERPROFILE: home,
    AW_HOME: path.join(root, 'aw'), CODEX_HOME: path.join(root, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'), PI_CODING_AGENT_DIR: path.join(root, 'pi'),
    GEMINI_CLI_HOME: path.join(root, 'gemini'), GROK_HOME: path.join(root, 'grok'),
    COPILOT_HOME: path.join(root, 'copilot'),
    COPILOT_OFFLINE: 'true', COPILOT_AUTO_UPDATE: 'false',
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
    APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'),
    TMPDIR: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_TERMINAL_PROMPT: '0',
    npm_config_userconfig: path.join(root, 'npmrc'), npm_config_globalconfig: path.join(root, 'npmrc-global'),
    npm_config_cache: path.join(root, 'npm-cache'), npm_config_registry: 'https://registry.npmjs.org',
    npm_config_audit: 'false', npm_config_fund: 'false',
    CI: '1', NO_COLOR: '1', TERM: 'dumb', DO_NOT_TRACK: '1', DISABLE_TELEMETRY: '1',
    DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    const actual = Object.keys(process.env).find((name) => name.toLowerCase() === key.toLowerCase());
    if (actual) env[key] = process.env[actual];
  }
  if (!network) for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[name] = 'http://127.0.0.1:1';
  if (!network) { env.NO_PROXY = ''; env.no_proxy = ''; }
  if (network) for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export async function prepareEnvironment(root) {
  const env = isolatedEnvironment(root);
  for (const [key, value] of Object.entries(env)) {
    if (['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TMP', 'TEMP'].includes(key)
      || key.endsWith('_HOME') || key === 'CLAUDE_CONFIG_DIR' || key === 'PI_CODING_AGENT_DIR') await fs.mkdir(value, { recursive: true });
  }
  for (const name of ['gitconfig', 'npmrc', 'npmrc-global']) await fs.writeFile(path.join(root, name), '');
  return env;
}

export const fixedClientVersion = platform => platform === 'antigravity' ? '1.3.4' : clients[platform].version;

export function usesAntigravityAgentObservation(args, options, host = process, hosted = process.env.GITHUB_ACTIONS) {
  return hosted === 'true' && host.platform === 'linux' && host.arch === 'x64'
    && options.nativeClient === 'antigravity' && options.nativeClientVersion === '1.3.4'
    && options.antigravityAgentObservation === true && args.length === 1 && args[0] === 'agents';
}

export async function execute(launcher, args, options) {
  if (options.nativeClient === 'copilot' && process.platform === 'darwin'
    || usesAntigravityAgentObservation(args, options)) {
    const { executePublicAw } = await import('./native-platform-public-process.mjs');
    return executePublicAw(launcher, args, { ...options, timeoutMs: options.timeoutMs ?? 30_000 });
  }
  const { runProviderProcess } = await import('../../packages/agent-skill-eval/dist/process.js');
  const windowsJobHelperPath = process.platform === 'win32'
    ? await (await import('../../packages/agent-skill-eval/dist/windows-job.js')).prepareWindowsJobHelper()
    : undefined;
  const names = options.captureProcessNames && process.platform === 'darwin'
    && process.env.GITHUB_ACTIONS === 'true' && process.env.AW_NATIVE_QUALIFICATION_PROCESS_NAMES === '1'
    ? createProcessNameDiagnostic() : undefined;
  const nativeLinux = ['gemini', 'grok'].includes(options.nativeClient) && process.platform === 'linux'
    && process.env.GITHUB_ACTIONS === 'true' && process.env.AW_NATIVE_QUALIFICATION_PROCESS_NAMES === '1';
  const markerRows = nativeLinux ? createProcessMarkerRowDiagnostic(undefined, {
    learnMarkerEnvironmentVariable: 'AW_AGENT_SKILL_EVAL_PROCESS_MARKER',
    environmentProbe: createLinuxEnvironmentDiagnostic({ deadlineAt: Date.now() + (options.timeoutMs ?? 30_000) }),
  }) : undefined;
  const confirmations = nativeLinux ? createMarkerIdentityConfirmationCapture() : undefined;
  try {
    const result = await runProviderProcess({ executable: launcher.executable, args: [...launcher.prefix, ...args],
      cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs ?? 30_000,
      maxBufferBytes: 2 * 1024 * 1024, ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    }, names || markerRows ? { onSpawn(handle) { names?.onSpawn(handle); markerRows?.onSpawn(handle); } } : {}, { containment: 'verified-observed',
      ...(windowsJobHelperPath ? { processTree: { windowsJobHelperPath } } : {}),
      ...(names ? { processTree: { execFile: names.execFile } } : {}),
      ...(markerRows ? { processTree: { execFile: markerRows.execFile,
        onLinuxMarkerIdentityConfirmation: confirmations.capture } } : {}),
    });
    const markerIdentityConfirmations = confirmations?.snapshot();
    return markerIdentityConfirmations ? { ...result, markerIdentityConfirmations } : result;
  } catch (error) {
    try {
      const observed = names?.snapshot(error?.processTreeDiagnostics);
      if (observed?.length) error.qualificationProcessNames = observed;
      const rows = markerRows?.snapshot(error?.processTreeDiagnostics);
      if (rows?.length) error.qualificationMarkerRows = rows;
      const evidence = confirmations?.snapshot();
      if (evidence) error.qualificationMarkerIdentityConfirmations = evidence;
    } catch { /* Private diagnostic data must not replace the original failure. */ }
    throw error;
  } finally { names?.stop(); markerRows?.stop(); confirmations?.stop(); }
}

export async function processManagementInfo() {
  if (process.platform !== 'win32') return { mode: 'verified-observed', osContainment: false };
  const { prepareWindowsJobHelper } = await import('../../packages/agent-skill-eval/dist/windows-job.js');
  const executable = await prepareWindowsJobHelper();
  return { mode: 'windows-job', osContainment: true, helperSha256: sha256(await fs.readFile(executable)) };
}

export function assertCommand(result) {
  if (result.timedOut) throw new Error('command-timeout');
  if (result.maxBufferExceeded) throw new Error('command-output-limit');
  if (result.exitCode !== 0) throw new Error('command-failed');
}

export async function resolveNpm() {
  for (const candidate of [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')]) {
    if (await fs.stat(candidate).then((s) => s.isFile(), () => false)) return { executable: process.execPath, prefix: [candidate] };
  }
  throw new Error('npm-entry-unavailable');
}

// The parent bin is a postinstall placeholder. Select only the fixed official
// optional native package; the Windows npm suffix is "windows", not "win32".
export function getOpenCodeDistribution(parent, host = process) {
  const system = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[host.platform];
  if (!system || !['x64', 'arm64'].includes(host.arch) || parent.name !== clients.opencode.package
    || parent.version !== clients.opencode.version) throw new Error('official-client-distribution-unavailable');
  const packageName = `${clients.opencode.package}-${system}-${host.arch}`;
  if (parent.optionalDependencies?.[packageName] !== clients.opencode.version) throw new Error('official-client-distribution-unavailable');
  return { packageName, version: clients.opencode.version, entry: `bin/opencode${host.platform === 'win32' ? '.exe' : ''}` };
}

export async function acquireClient(platform, root) {
  const client = clients[platform];
  const npm = await resolveNpm();
  await prepareEnvironment(root);
  const prefix = path.join(root, 'tool');
  // Downloads use bounded direct-child handling with installation scripts disabled.
  // Client commands use execute and its process-tree contract.
  try {
    await promisify(execFile)(npm.executable, [...npm.prefix, 'install', '--prefix', prefix, '--no-audit', '--no-fund',
    '--ignore-scripts', '--package-lock=true', `${client.package}@${client.version}`], {
      cwd: root, env: isolatedEnvironment(root, true), timeout: 180_000,
      maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', killSignal: 'SIGKILL', windowsHide: true,
    });
  }
  catch (cause) {
    const error = new Error('client-install-failed', { cause });
    let stderr = cause.stderr ?? '';
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
      if (process.env[key]) stderr = stderr.replaceAll(process.env[key], '<DOWNLOAD_PROXY>');
    }
    error.evidence = { exitCode: cause.code, signal: cause.signal, killed: cause.killed, stderr };
    throw error;
  }
  let packageRoot = path.join(prefix, 'node_modules', client.package);
  let metadata = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  if (metadata.name !== client.package || metadata.version !== client.version) throw new Error('installed-package-identity-mismatch');
  let relative = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.[client.bin];
  let executablePackage = client.package;
  if (platform === 'opencode') {
    const distribution = getOpenCodeDistribution(metadata);
    executablePackage = distribution.packageName;
    packageRoot = path.join(prefix, 'node_modules', executablePackage);
    metadata = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    if (metadata.name !== executablePackage || metadata.version !== distribution.version) throw new Error('installed-package-identity-mismatch');
    relative = distribution.entry;
  } else if (platform === 'codex' || platform === 'claude') {
    // Resolve the native binary selected by the fixed official wrapper/installer.
    // Claude's top-level bin is a placeholder without postinstall; Codex's Node
    // wrapper uses execve, which can invalidate POSIX process-marker inspection.
    const suffix = `${process.platform}-${process.arch}`;
    executablePackage = `${client.package}-${suffix}`;
    const expectedVersion = platform === 'codex' ? `${client.version}-${suffix}` : client.version;
    const expectedDependency = platform === 'codex' ? `npm:${client.package}@${expectedVersion}` : expectedVersion;
    if (metadata.optionalDependencies?.[executablePackage] !== expectedDependency) throw new Error('official-client-distribution-unavailable');
    packageRoot = path.join(prefix, 'node_modules', executablePackage);
    metadata = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    if (metadata.name !== (platform === 'codex' ? client.package : executablePackage)
      || metadata.version !== expectedVersion) throw new Error('installed-package-identity-mismatch');
    const binary = `${client.bin}${process.platform === 'win32' ? '.exe' : ''}`;
    if (platform === 'claude') relative = binary;
    else {
      const cpu = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
      const system = { darwin: 'apple-darwin', linux: 'unknown-linux-musl', win32: 'pc-windows-msvc' }[process.platform];
      if (!cpu || !system) throw new Error('official-client-distribution-unavailable');
      relative = `vendor/${cpu}-${system}/bin/${binary}`;
    }
  }
  if (!relative) throw new Error('client-entry-unavailable');
  const entry = await fs.realpath(path.resolve(packageRoot, relative));
  const realPackage = await fs.realpath(packageRoot);
  if (path.relative(realPackage, entry).startsWith('..') || path.isAbsolute(path.relative(realPackage, entry))) throw new Error('client-entry-outside-package');
  const bytes = await fs.readFile(entry);
  const node = /(?:^#!.*\bnode\b)|(?:\.[cm]?js$)/u.test(bytes.subarray(0, 160).toString('utf8')) || /\.[cm]?js$/u.test(entry);
  const lockBytes = await fs.readFile(path.join(prefix, 'package-lock.json'));
  const lock = JSON.parse(lockBytes.toString('utf8'));
  if (platform === 'opencode') {
    if (node) throw new Error('official-client-native-entry-required');
    for (const name of [client.package, executablePackage]) {
      const record = lock.packages?.[`node_modules/${name}`];
      if (record?.version !== client.version || !/^sha512-[A-Za-z0-9+/]+=*$/u.test(record?.integrity ?? '')) throw new Error('client-lock-integrity-missing');
    }
  }
  return { launcher: { executable: node ? process.execPath : entry, prefix: node ? [entry] : [] }, binDirectory: prefix,
    acquisition: { package: client.package, version: client.version, source: client.source,
      integrity: lock.packages?.[`node_modules/${client.package}`]?.integrity ?? null,
      executablePackage, executablePackageVersion: metadata.version,
      executablePackageIntegrity: lock.packages?.[`node_modules/${executablePackage}`]?.integrity ?? null,
      lockSha256: sha256(JSON.stringify(lock)), entrySha256: sha256(bytes), scripts: 'disabled',
      ...(platform === 'opencode' ? { lockFileSha256: sha256(lockBytes), entrySelection: 'fixed-official-optional-native-package; parent-placeholder-not-executed' } : {}) } };
}

const bundleDirectories = ['packages/cli/dist', 'packages/cli/plugins-dist', 'packages/plugin-core/dist', 'packages/agent-skill-eval/dist', 'scripts/qualification'];
export async function candidateFiles() {
  const files = {};
  async function walk(relative) {
    const absolute = path.join(repoRoot, relative);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error('candidate-symlink');
    if (stat.isDirectory()) for (const name of (await fs.readdir(absolute)).sort()) await walk(`${relative}/${name}`);
    else if (stat.isFile()) files[relative] = sha256(await fs.readFile(absolute));
    else throw new Error('candidate-special-file');
  }
  for (const directory of bundleDirectories) await walk(directory);
  return files;
}

export async function writeCandidate(output, sourceSha) {
  if (!/^[a-f0-9]{40}$/u.test(sourceSha ?? '')) throw new Error('candidate-source-sha-required');
  const files = await candidateFiles();
  await fs.writeFile(output, JSON.stringify({ schemaVersion: 1, sourceSha, files }, null, 2) + '\n');
}

export async function verifyCandidate(file) {
  const bytes = await fs.readFile(file);
  const manifest = JSON.parse(bytes);
  if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{40}$/u.test(manifest.sourceSha ?? '')) throw new Error('invalid-candidate-manifest');
  const files = await candidateFiles();
  if (JSON.stringify(files) !== JSON.stringify(manifest.files)) throw new Error('candidate-content-mismatch');
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== manifest.sourceSha) throw new Error('candidate-source-mismatch');
  return { sourceSha: manifest.sourceSha, manifestSha256: sha256(bytes), files: Object.keys(files).length };
}

export async function renderPackage(ctx, revision) {
  const { projectPlatform } = await import('../../packages/cli/dist/src/platforms/projection.js');
  const { projectPlatformMarketplace } = await import('../../packages/cli/dist/src/platforms/projection-marketplace.js');
  const platform = ctx.platform;
  const renderScope = ['codex', 'claude', 'gemini', 'copilot'].includes(platform) ? 'user' : ctx.scope;
  const scope = renderScope === 'user' ? { kind: 'user' } : { kind: 'project', projectRoot: ctx.project };
  const packageVersion = platform === 'opencode' ? revision === 1 ? '0.1.0' : '0.1.1'
    : platform === 'antigravity' ? revision === 1 ? '1.0.1' : '1.0.2' : `1.0.${revision}`;
  const binding = { id: 'qualification', platform,
    plugin: { sourceId: 'qualification', sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginId: `qualification/${ctx.pluginName}`, version: packageVersion },
    scope, route: { codex: 'codex-marketplace', claude: 'claude-marketplace', pi: 'pi-package', gemini: 'gemini-extension', copilot: 'copilot-marketplace', opencode: 'opencode-directory', antigravity: ctx.scope === 'user' ? 'antigravity-cli' : 'antigravity-directory', grok: ctx.scope === 'user' ? 'grok-cli' : 'grok-directory' }[platform],
    consumers: [], physicalKey: 'qualification', activationKey: 'qualification', renderUnitIds: ['qualification'],
  };
  if (platform === 'antigravity') {
    const { resolvePlatformConfigRoot } = await import('../../packages/cli/dist/src/platforms/discovery.js');
    binding.consumers.push({ id: 'qualification-antigravity-cli', product: 'cli', version: '1.3.4', availability: 'available',
      reasonCodes: [], entry: { kind: 'cli', executable: ctx.executable ?? '/qualification/antigravity',
        configRoot: resolvePlatformConfigRoot(platform, { cwd: ctx.project, env: ctx.env }) } });
  }
  // Explicit test candidate only. No production profile is changed or qualified by rendering.
  const capabilities = { schemaVersion: 1, platform, scope: renderScope, basis: 'profile',
    profileId: platform === 'antigravity' && ctx.observeAgent === true
      ? 'qualification-candidate:skill-and-uninvoked-agent-scope-observer' : 'qualification-candidate:ordinary-skill-only', consumers: [], features: {},
    kinds: Object.fromEntries(['skill', 'mcp', 'agent', 'hook', 'instruction'].map((kind) => [kind,
      { status: kind === 'skill' ? 'supported' : 'unverified', reasonCodes: kind === 'skill' ? [] : ['capability-unverified'], delivery: [platform === 'opencode' ? 'native-extension' : 'native-package'] }])) };
  const components = [{ id: 'skill:qualification', kind: 'skill', name: ctx.skillName, content: { files: {
      'SKILL.md': { text: `---\nname: ${ctx.skillName}\ndescription: AW qualification revision ${revision}\n---\n${['opencode', 'antigravity'].includes(platform) ? `Qualification fixture revision ${revision}.` : 'Qualification fixture.'} No model request is required.\n` },
    } } }];
  const observeAgent = platform === 'antigravity' && ctx.observeAgent === true;
  if (observeAgent) {
    capabilities.kinds.agent = { status: 'supported', reasonCodes: [], delivery: ['native-package'] };
    capabilities.features['agent.prompt-mode'] = { status: 'supported', reasonCodes: [], values: ['host-default'] };
    capabilities.features['agent.execution'] = { status: 'supported', reasonCodes: [], values: ['isolated-context'] };
    components.push({ id: 'agent:scope-observer', kind: 'agent', name: 'management-observer',
      content: { description: 'Local scope observation fixture.', prompt: 'No invocation is requested.' } });
  }
  const projected = await projectPlatform({ cwd: ctx.project, env: ctx.env, stagingRoot: path.join(ctx.root, `stage-${revision}`) }, {
    binding, renderUnit: { id: 'qualification', physicalKey: 'qualification', renderScope: scope, output: 'package', kinds: observeAgent ? ['skill', 'agent'] : ['skill'], consumers: [] },
    capabilities, components, policy: { platform, permissions: [] }, resources: { resources: [], files: [], bundleFiles: [], commandResources: [], digest: 'qualification' },
  });
  if (!projected.bundle) throw new Error('candidate-package-missing');
  await fs.rm(ctx.bundle, { recursive: true, force: true });
  await fs.mkdir(path.dirname(ctx.bundle), { recursive: true });
  await fs.cp(projected.bundle.stagingRoot, ctx.bundle, { recursive: true });
  if (['codex', 'claude', 'copilot'].includes(platform)) {
    const descriptor = projectPlatformMarketplace({ binding, marketplaceName: ctx.marketplaceName, entries: [{
      name: ctx.pluginName, source: `./plugins/${ctx.pluginName}`, version: `1.0.${revision}`, description: 'AW qualification fixture',
      category: 'development', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    }] });
    const file = path.join(ctx.marketplace, descriptor.relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, descriptor.bytes);
  }
  return { revision, contentDigest: projected.bundle.contentDigest, components: projected.components,
    ...(platform === 'antigravity' ? { nativeDirectory: (await (await import('../../packages/cli/dist/src/platforms/layout.js')).getDeploymentLayout({ cwd: ctx.project, env: ctx.env }, binding)).packageRoot } : {}),
    ...(platform === 'opencode' ? { version: packageVersion, projectionInput: { binding, renderScope: scope, capabilities },
      nativePluginId: (await import('../../packages/cli/dist/src/platforms/layout.js')).getDeploymentResourceKey(binding.plugin) } : {}) };
}

export function hostInfo() {
  return { platform: process.platform, arch: process.arch, release: os.release(), node: process.version,
    imageOS: process.env.ImageOS ?? null, imageVersion: process.env.ImageVersion ?? null };
}
