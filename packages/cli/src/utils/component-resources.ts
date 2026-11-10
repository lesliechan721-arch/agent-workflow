import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import {
  getComponentFeatureRequirements,
  parseAwPluginRequirementsReceipt,
  createAwPluginRequirementsReceipt,
  getUnmetFeatureRequirements,
  type ExpectedComponentSet,
  type PlatformCapabilitiesV1,
  type PlatformRenderContextV1,
  type PluginComponent,
  type SourceRef,
} from '@lesliechan721/aw-plugin-core/manifest';
import type { PluginMeta } from '../types.js';
import { assertNoSensitiveConfigValues, calculateFileDigest } from './plugin-scripts.js';
import { artifactValueDigest } from './artifact-plan.js';
import { validateRuntimeSkillClosure } from './runtime-skill-closure.js';
import { scanNodeImportContract } from './plugin-script-contract.js';

export interface VerifiedComponentFile {
  componentId: string;
  path: string;
  bytes: Buffer;
  source?: SourceRef;
  mode?: number;
}
export interface VerifiedResourceClosure {
  resources: PlatformRenderContextV1['resources'];
  files: VerifiedComponentFile[];
  bundleFiles: Array<{ path: string; bytes: Buffer; mode?: number; componentIds?: string[] }>;
  commandResources: VerifiedCommandResource[];
  digest: string;
}

export interface CommandResourceReference { start: number; end: number; path: string }
export interface VerifiedCommandResource extends CommandResourceReference {
  componentId: string;
  field: 'command' | 'args';
  index?: number;
  original: string;
}

/** Only literal package paths are portable. Shell expansion is not a resource declaration. */
export function commandResourceReferences(value: string, shell: boolean, platform: PlatformCapabilitiesV1['platform'], executable?: string): CommandResourceReference[] {
  const rootVariable = platform === 'codex' ? '${CODEX_PLUGIN_ROOT}/' : platform === 'claude' ? '${CLAUDE_PLUGIN_ROOT}/' : undefined;
  const tokens = shell ? [...value.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s"'`;&|<>]+/gu)].map((match) => ({ text: match[0], start: match.index }))
    : [{ text: value, start: 0 }];
  const references: CommandResourceReference[] = [];
  const runner = (executable ?? tokens[0]?.text ?? '').replace(/^["']|["']$/gu, '');
  const scriptRunner = /^(?:node|bun|deno|python[\d.]*|bash|sh|pwsh|powershell)(?:\.exe)?$/iu.test(path.posix.basename(runner ?? ''));
  for (const token of tokens) {
    const quoted = shell && (token.text.startsWith('"') || token.text.startsWith("'"));
    const text = quoted ? token.text.slice(1, -1) : token.text;
    const flag = /^--?[A-Za-z][A-Za-z0-9-]*=/u.exec(text)?.[0] ?? '';
    const candidate = text.slice(flag.length);
    const rooted = rootVariable && candidate.startsWith(rootVariable);
    const plainRelative = candidate.includes('/') && !/^(?:\/|[A-Za-z][A-Za-z\d+.-]*:|@|\$|-)/u.test(candidate);
    const scriptFile = scriptRunner && /^[A-Za-z0-9_. -]+\.(?:[cm]?js|[cm]?ts|py|sh|ps1)$/iu.test(candidate);
    const local = candidate.startsWith('./') || candidate.startsWith('../') || rooted || plainRelative || scriptFile;
    if (!local) {
      if (/(?:^|[=\s(])\.\.?[\/\\]|\$\{[^}]+\}\//u.test(candidate)) {
        throw new Error('componentResourceInvalid: Command resource syntax cannot be verified. Use a literal ./ package path.');
      }
      continue;
    }
    if (/[$`\r\n\0\\]/u.test(rooted ? candidate.slice(rootVariable.length) : candidate)) {
      throw new Error('componentResourceInvalid: Command resources cannot contain expansion or escapes.');
    }
    // A quoted flag is replaced as one shell word. Keep the flag outside the replacement.
    if (quoted && flag) throw new Error('componentResourceInvalid: Quote the resource value separately from its flag.');
    references.push({ start: token.start + (quoted ? 0 : flag.length), end: token.start + token.text.length,
      path: relativePath(rooted ? candidate.slice(rootVariable.length) : candidate, 'command resource') });
  }
  return references;
}

function relativePath(value: string, label: string): string {
  const relative = value.replace(/^\.\//u, '');
  if (!relative || relative.includes('\\') || path.posix.isAbsolute(relative) || /^[A-Za-z]:/u.test(relative)
    || path.posix.normalize(relative) !== relative || relative.split('/').some((segment) =>
      !segment || ['.', '..', '.git', 'node_modules'].includes(segment))) {
    throw new Error(`componentResourceInvalid: ${label} must be a normalized relative resource path.`);
  }
  return relative;
}

/** Check every parent with lstat: realpath alone would accept links that point back inside. */
async function regularPath(root: string, relative: string, directory?: boolean): Promise<string> {
  const rootStats = await fs.lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error('componentResourceInvalid: resource root must be a regular directory.');
  let current = root;
  const segments = relativePath(relative, 'source').split('/');
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    const last = index === segments.length - 1;
    if (stat.isSymbolicLink() || (!last && !stat.isDirectory())
      || (last && (directory === true ? !stat.isDirectory() : directory === false ? !stat.isFile() : !stat.isFile() && !stat.isDirectory()))) {
      throw new Error('componentResourceInvalid: sources require regular files and directories without symbolic links.');
    }
  }
  return current;
}

async function directoryDigest(root: string): Promise<string> {
  const entries: Array<[string, string, number]> = [];
  async function visit(directory: string, parent: string): Promise<void> {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = parent ? `${parent}/${entry.name}` : entry.name;
      relativePath(relative, 'resource');
      const location = path.join(directory, entry.name);
      const stat = await fs.lstat(location);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('componentResourceInvalid: resource trees cannot contain links or special files.');
      if (stat.isDirectory()) await visit(location, relative);
      else entries.push([relative, await calculateFileDigest(location), stat.mode & 0o111 ? 0o755 : 0o644]);
    }
  }
  await visit(root, '');
  return artifactValueDigest(entries);
}

export async function resolvePlatformComponentResources(plugin: PluginMeta): Promise<PlatformRenderContextV1['resources']> {
  const root = await fs.realpath(plugin.rootDir);
  const resources: PlatformRenderContextV1['resources'] = [];
  for (const sourceDir of plugin.manifest.artifacts?.sourceDirs ?? []) {
    const directory = await regularPath(root, sourceDir, true);
    resources.push({ kind: 'bundle', name: sourceDir, root: directory, digest: await directoryDigest(directory) });
  }
  for (const entry of plugin.manifest.artifacts?.runtimeImports ?? []) {
    if (!entry.resolved) throw new Error(`componentResourceInvalid: runtime import "${entry.name}" is unresolved.`);
    const location = await regularPath(root, entry.resolved.path, false);
    if (await calculateFileDigest(location) !== entry.resolved.digest) throw new Error(`componentResourceInvalid: runtime import "${entry.name}" has changed.`);
    resources.push({ kind: 'runtime-import', name: entry.name, root: path.dirname(location), digest: entry.resolved.digest });
  }
  return resources;
}

const RESERVED_FILES = new Set([
  '.agent-workflows-owner.json', 'owner.json', 'aw-plugin-requirements.json', '.aw-command-producer.json',
  '.aw-runtime-config.json', 'scripts/aw-runtime-config.mjs', '.aw-runtime-native-receipt.json',
]);

export async function verifyPlatformComponentResources(options: {
  plugin: PluginMeta; expected: ExpectedComponentSet; resources: PlatformRenderContextV1['resources'];
  capabilities: PlatformCapabilitiesV1; sensitiveValues: readonly string[]; staticResourceRoot?: string;
}): Promise<VerifiedResourceClosure> {
  const bundleRoot = await fs.realpath(options.plugin.rootDir);
  const files: VerifiedComponentFile[] = [];
  const { bundleFiles, commandResources } = await collectBundleResources(options);
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-component-closure-'));
  try {
    for (const component of options.expected.components) {
      if (component.kind !== 'skill') continue;
      const componentFiles: Record<string, Buffer> = Object.create(null);
      const modes: Record<string, number> = Object.create(null);
      for (const [file, resource] of Object.entries(component.content.files)) {
        const outputPath = relativePath(file, 'output');
        const staticReceipt = outputPath === 'aw-plugin-requirements.json' && options.expected.sources[component.id] === 'static';
        if ((!staticReceipt && RESERVED_FILES.has(outputPath)) || outputPath.split('/').some((part) => ['.agents-plugin', '.codex-plugin', '.claude-plugin'].includes(part))) {
          throw new Error(`componentResourceReserved: "${file}" is reserved for AW.`);
        }
        let bytes: Buffer;
        let source: SourceRef | undefined;
        let mode = 0o644;
        if ('text' in resource) bytes = Buffer.from(resource.text, 'utf8');
        else {
          source = resource.source;
          const sourcePath = relativePath(source.path, 'source');
          let location: string;
          if (source.kind === 'bundle') {
            const dynamic = options.expected.sources[component.id] === 'dynamic';
            if (dynamic && !options.resources.some((entry) => entry.kind === 'bundle'
              && (sourcePath === entry.name.replace(/^\.\//u, '') || sourcePath.startsWith(`${entry.name.replace(/^\.\//u, '')}/`)))) {
              throw new Error(`componentResourceDenied: source "${source.path}" is outside declared sourceDirs.`);
            }
            location = await regularPath(bundleRoot, sourcePath, false);
          } else {
            const importName = source.name;
            const entry = options.resources.find((entry) => entry.kind === 'runtime-import' && entry.name === importName);
            if (!entry) throw new Error(`componentResourceDenied: unknown runtime import "${source.name}".`);
            const declaration = options.plugin.manifest.artifacts?.runtimeImports?.find((candidate) => candidate.name === importName);
            if (!declaration?.resolved || sourcePath !== path.posix.basename(declaration.resolved.path)) {
              throw new Error('componentResourceDenied: runtime import path must identify its declared file.');
            }
            location = await regularPath(bundleRoot, declaration.resolved.path, false);
            if (await calculateFileDigest(location) !== entry.digest) throw new Error('componentResourceInvalid: runtime import changed during preparation.');
          }
          bytes = await fs.readFile(location);
          if ((await fs.stat(location)).mode & 0o111) mode = 0o755;
        }
        if (staticReceipt) {
          const actual = parseAwPluginRequirementsReceipt(JSON.parse(bytes.toString('utf8')));
          const expected = createAwPluginRequirementsReceipt({ name: options.plugin.manifest.name, version: options.plugin.manifest.version },
            options.plugin.manifest.requires?.aw.capabilities ?? []);
          if (artifactValueDigest(actual) !== artifactValueDigest(expected)) throw new Error('componentResourceInvalid: Static requirements receipt does not match the verified plugin.');
        } else assertNoSensitiveConfigValues(bytes.toString('utf8'), options.sensitiveValues,
          'componentSensitiveConfigExposed: Component resources contain sensitive config.');
        componentFiles[outputPath] = bytes;
        modes[outputPath] = mode;
        files.push({ componentId: component.id, path: outputPath, bytes, ...(source ? { source } : {}), ...(mode === 0o755 ? { mode } : {}) });
      }
      const skillText = componentFiles['SKILL.md']?.toString('utf8');
      if (!skillText || !componentFiles['SKILL.md']!.equals(Buffer.from(skillText, 'utf8'))) throw new Error('componentResourceInvalid: SKILL.md must be valid UTF-8 text.');
      const missing = getUnmetFeatureRequirements(getComponentFeatureRequirements(component, { skillText }), options.capabilities);
      if (missing.length) throw new Error(`componentCapabilityExceeded: Skill "${component.id}" requires ${JSON.stringify(missing)}.`);
      await validateSkillClosure(component, componentFiles, modes, staging);
    }
    const currentResources = await resolvePlatformComponentResources(options.plugin);
    if (artifactValueDigest(currentResources) !== artifactValueDigest(options.resources)) {
      throw new Error('componentResourceChanged: Declared resources changed during rendering.');
    }
    // The caller receives bytes, so a later source change cannot alter the frozen candidate.
    return { resources: options.resources, files, bundleFiles, commandResources,
      digest: artifactValueDigest({ resources: options.resources, commandResources, files: [...files.map((file) => ({ componentId: file.componentId, path: file.path,
        digest: `sha256:${crypto.createHash('sha256').update(file.bytes).digest('hex')}`, mode: file.mode ?? 0o644 })), ...bundleFiles.map((file) => ({ path: file.path,
          digest: `sha256:${crypto.createHash('sha256').update(file.bytes).digest('hex')}`, mode: file.mode ?? 0o644 }))] }) };
  } finally {
    await fs.remove(staging);
  }
}

async function validateSkillClosure(component: PluginComponent, files: Record<string, Buffer>, modes: Record<string, number>, staging: string): Promise<void> {
  const skillRoot = path.join(staging, crypto.createHash('sha256').update(component.id).digest('hex'));
  await fs.ensureDir(skillRoot);
  for (const [file, bytes] of Object.entries(files)) {
    const target = path.join(skillRoot, ...file.split('/'));
    await fs.ensureDir(path.dirname(target));
    await fs.writeFile(target, bytes, { mode: modes[file], flag: 'wx' });
  }
  const generated = component.kind === 'skill' && component.runtimeConfig ? ['.aw-runtime-config.json', 'scripts/aw-runtime-config.mjs'] : [];
  await validateRuntimeSkillClosure(skillRoot, { declaredGeneratedFiles: new Set(generated) });
  const entryFiles = Object.keys(files).filter((file) => /\.[cm]?js$/iu.test(file));
  if (entryFiles.length) {
    const textFiles = Object.fromEntries(Object.entries(files).filter(([file]) => entryFiles.includes(file) || file.endsWith('/package.json') || file === 'package.json')
      .map(([file, bytes]) => [file, bytes.toString('utf8')]));
    const scan = scanNodeImportContract({ files: { ...textFiles, ...Object.fromEntries(generated.map((file) => [file, ''])) },
      filePaths: [...Object.keys(files), ...generated], entryFiles, dependencies: [], devDependencies: [] });
    if (scan.errors.length) throw new Error(`componentResourceClosureInvalid: ${scan.errors.join('\n')}`);
  }
}

async function collectBundleResources(options: {
  plugin: PluginMeta; expected: ExpectedComponentSet; resources: PlatformRenderContextV1['resources'];
  sensitiveValues: readonly string[]; staticResourceRoot?: string; capabilities: PlatformCapabilitiesV1;
}): Promise<Pick<VerifiedResourceClosure, 'bundleFiles' | 'commandResources'>> {
  const root = await fs.realpath(options.plugin.rootDir);
  const output = new Map<string, { path: string; bytes: Buffer; mode?: number; componentIds: string[] }>();
  const commandResources: VerifiedCommandResource[] = [];
  const requests = options.expected.components.flatMap((component) => {
    const command = component.kind === 'hook' ? component.content.command
      : component.kind === 'mcp' && component.content.type === 'stdio' ? component.content.command : null;
    if (command === null) return [];
    const fields: Array<{ field: 'command' | 'args'; index?: number; original: string }> = [
      { field: 'command', original: command },
      ...(component.kind === 'mcp' && component.content.type === 'stdio'
        ? (component.content.args ?? []).map((original, index) => ({ field: 'args' as const, index, original })) : []),
    ];
    return fields.flatMap((field) => {
      if (field.original.includes(`${root}/`) || field.original.includes(`${root}${path.sep}`)) throw new Error('componentResourceDenied: Commands must not bind an absolute source-bundle path.');
      return commandResourceReferences(field.original, component.kind === 'hook', options.capabilities.platform,
        component.kind === 'mcp' ? command : undefined).map((reference) => ({
        ...field, ...reference, componentId: component.id, dynamic: options.expected.sources[component.id] === 'dynamic',
      }));
    });
  });
  if (!requests.length) return { bundleFiles: [], commandResources };
  const staticRoot = path.resolve(options.staticResourceRoot ?? root);
  const staticPrefix = path.relative(root, staticRoot).split(path.sep).join('/');
  if (staticPrefix === '..' || staticPrefix.startsWith('../') || path.isAbsolute(staticPrefix)) throw new Error('componentResourceDenied: Static resource root is outside the bundle.');
  if (staticPrefix) await regularPath(root, staticPrefix, true);
  const filePaths: string[] = [];
  const textFiles: Record<string, string> = Object.create(null);
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (['.git', 'node_modules'].includes(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const location = await regularPath(root, relative);
      if (entry.isDirectory()) await visit(location, relative);
      else {
        filePaths.push(relative);
        if (/\.[cm]?js$/iu.test(relative) || entry.name === 'package.json') textFiles[relative] = await fs.readFile(location, 'utf8');
      }
    }
  }
  await visit(root, '');
  const allowedDynamic = (relative: string): boolean => options.resources.some((resource) => resource.kind === 'bundle'
    ? relative.startsWith(`${resource.name.replace(/^\.\//u, '')}/`)
    : options.plugin.manifest.artifacts?.runtimeImports?.some((entry) => entry.name === resource.name
      && entry.resolved?.path.replace(/^\.\//u, '') === relative));
  for (const request of requests) {
    const relative = request.dynamic ? request.path : path.posix.join(staticPrefix, request.path);
    if (request.dynamic && !allowedDynamic(relative)) throw new Error('componentResourceDenied: Command resource is outside declared inputs.');
    await regularPath(root, relative, false);
    const scan = /\.[cm]?js$/iu.test(relative)
      ? scanNodeImportContract({ files: textFiles, filePaths, entryFiles: [relative], dependencies: [], devDependencies: [] })
      : { files: [relative], errors: [] };
    if (scan.errors.length) throw new Error(`componentResourceClosureInvalid: ${scan.errors.join('\n')}`);
    for (const source of scan.files) {
      if (request.dynamic && !allowedDynamic(source)) throw new Error('componentResourceDenied: Command import escapes declared inputs.');
      if (!request.dynamic && staticPrefix && !source.startsWith(`${staticPrefix}/`)) throw new Error('componentResourceDenied: Static command import escapes its platform projection.');
      const location = await regularPath(root, source, false);
      const bytes = await fs.readFile(location);
      assertNoSensitiveConfigValues(bytes.toString('utf8'), options.sensitiveValues, 'componentSensitiveConfigExposed: Command resources contain sensitive config.');
      const destination = request.dynamic ? source : staticPrefix ? source.slice(staticPrefix.length + 1) : source;
      const declaredRuntimeImport = source.startsWith('.agents-plugin/runtime-imports/')
        && !RESERVED_FILES.has(path.posix.basename(source))
        && options.plugin.manifest.artifacts?.runtimeImports?.some((entry) => entry.resolved?.path.replace(/^\.\//u, '') === source);
      if (RESERVED_FILES.has(destination) || destination.split('/').some((part) => part === '.agents-plugin' ? !declaredRuntimeImport
        : ['.codex-plugin', '.claude-plugin'].includes(part))) {
        throw new Error('componentResourceReserved: Command resources cannot replace AW metadata or generated runtime files.');
      }
      const previous = output.get(destination);
      if (previous && !previous.bytes.equals(bytes)) throw new Error('componentResourceConflict: Command resources have conflicting output paths.');
      output.set(destination, { path: destination, bytes, componentIds: [...new Set([...(previous?.componentIds ?? []), request.componentId])].sort(),
        ...((await fs.stat(location)).mode & 0o111 ? { mode: 0o755 } : {}) });
    }
    const { dynamic: _dynamic, ...binding } = request;
    commandResources.push(binding);
  }
  return { bundleFiles: [...output.values()].sort((left, right) => left.path.localeCompare(right.path)), commandResources };
}
