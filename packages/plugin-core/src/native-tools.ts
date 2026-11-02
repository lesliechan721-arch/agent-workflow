import path from 'node:path';

import fs from 'fs-extra';
import {
  nativeToolDescriptorDigest,
  parseNativeToolDescriptor,
  type NativeToolDescriptor,
} from '@lesliechan721/aw-native-runtime/descriptor';
import { createNativeToolReaderSource } from '@lesliechan721/aw-native-runtime/reader';

import { resolveCanonicalRuntimeSourceIdentity } from './runtime-export-source.js';
import type { NormalizedPluginManifest } from './types.js';

export type { NativeToolDescriptor, NativeToolVariant } from '@lesliechan721/aw-native-runtime/descriptor';
export { createNativeToolReaderSource } from '@lesliechan721/aw-native-runtime/reader';
export const DEFAULT_NATIVE_TOOL_READER = './.aw/native-tool-reader.mjs';
export const NATIVE_TOOLS_CAPABILITY = 'aw.native-tools.v1';
export interface NativeToolDefinition { key: string; protocol: string; descriptor: string }
export type NativeToolBinding = {
  key: string;
  platforms: ['win32'];
} & ({ policy: 'required'; fallback?: never } | { policy: 'preferred'; fallback: string });
export interface NativeToolConsumer {
  kind: 'managed-command-set' | 'plugin-test';
  key: string;
  tools: NativeToolBinding[];
}
export interface NativeTools { reader: string; definitions: NativeToolDefinition[]; consumers: NativeToolConsumer[] }
export interface NativeToolClosureDefinition {
  key: string;
  protocol: string;
  descriptorPath: string;
  descriptor: NativeToolDescriptor;
  descriptorDigest: string;
}
export interface NativeToolClosure {
  reader: string;
  definitions: NativeToolClosureDefinition[];
  consumers: NativeToolConsumer[];
}

function object(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${field}: expected an object.`);
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`Invalid ${field}: unknown field.`);
  return value as Record<string, unknown>;
}
function name(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(value)) throw new Error(`Invalid ${field}: expected a Name.`);
  return value;
}
function protocol(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 128 || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u.test(value)) throw new Error(`Invalid ${field}: expected a protocol ID.`);
  return value;
}
function relativeFile(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.startsWith('./') || value.length > 512
    || /[\\:\u0000-\u001f\u007f-\u009f<>"|?*]/u.test(value)
    || value.slice(2).split('/').some((segment) => !segment || segment === '.' || segment === '..'
      || /[. ]$/u.test(segment) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(segment))
    || value.slice(2).split('/').some((segment) => ['.git', 'node_modules', 'evals', 'reports', '.release', '.tmp'].includes(segment))) {
    throw new Error(`Invalid ${field}: expected a safe plugin-relative file.`);
  }
  return value;
}
function array(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) throw new Error(`Invalid ${field}: expected 1..${max} entries.`);
  return value;
}
function unique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Invalid ${field}: duplicate entry.`);
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function normalizeConsumers(value: unknown): NativeToolConsumer[] {
  const consumers = array(value, 'nativeTools.consumers', 128).map((value): NativeToolConsumer => {
    const input = object(value, 'nativeTools consumer', ['kind', 'key', 'tools']);
    if (input.kind !== 'managed-command-set' && input.kind !== 'plugin-test') throw new Error('Invalid nativeTools consumer.kind.');
    const tools = array(input.tools, 'nativeTools consumer.tools', 32).map((value): NativeToolBinding => {
      const binding = object(value, 'nativeTools binding', ['key', 'platforms', 'policy', 'fallback']);
      if (!Array.isArray(binding.platforms) || binding.platforms.length !== 1 || binding.platforms[0] !== 'win32') throw new Error('Invalid nativeTools binding.platforms: v1 supports win32 only.');
      const base = { key: name(binding.key, 'nativeTools binding.key'), platforms: ['win32'] as ['win32'] };
      if (binding.policy === 'preferred') return { ...base, policy: 'preferred', fallback: name(binding.fallback, 'nativeTools binding.fallback') };
      if (binding.policy !== 'required' || binding.fallback !== undefined) throw new Error('Invalid nativeTools binding: required forbids fallback; preferred requires fallback.');
      return { ...base, policy: 'required' };
    });
    unique(tools.map((tool) => tool.key), 'nativeTools consumer.tools');
    return { kind: input.kind, key: name(input.key, 'nativeTools consumer.key'), tools: tools.sort((a, b) => compare(a.key, b.key)) };
  });
  unique(consumers.map((consumer) => `${consumer.kind}/${consumer.key}`), 'nativeTools.consumers');
  return consumers.sort((a, b) => compare(`${a.kind}/${a.key}`, `${b.kind}/${b.key}`));
}
function validateReferences(definitions: readonly { key: string }[], consumers: readonly NativeToolConsumer[]): void {
  const keys = new Set(definitions.map((entry) => entry.key));
  const used = new Set(consumers.flatMap((entry) => entry.tools.map((tool) => tool.key)));
  if ([...used].some((key) => !keys.has(key))) throw new Error('Invalid nativeTools: unknown tool reference.');
  if ([...keys].some((key) => !used.has(key))) throw new Error('Invalid nativeTools: unused tool definition.');
}

export function normalizeNativeTools(value: unknown): NativeTools {
  const input = object(value, 'nativeTools', ['reader', 'definitions', 'consumers']);
  const reader = relativeFile(input.reader === undefined ? DEFAULT_NATIVE_TOOL_READER : input.reader, 'nativeTools.reader');
  if (!reader.endsWith('.mjs')) throw new Error('Invalid nativeTools.reader: expected an .mjs file.');
  const definitions = array(input.definitions, 'nativeTools.definitions', 32).map((value) => {
    const entry = object(value, 'nativeTools definition', ['key', 'protocol', 'descriptor']);
    return { key: name(entry.key, 'nativeTools definition.key'), protocol: protocol(entry.protocol, 'nativeTools definition.protocol'), descriptor: relativeFile(entry.descriptor, 'nativeTools definition.descriptor') };
  }).sort((a, b) => compare(a.key, b.key));
  unique(definitions.map((entry) => entry.key), 'nativeTools.definitions');
  unique(definitions.map((entry) => entry.key.toLowerCase()), 'nativeTools.definitions generated file names');
  if (definitions.some((entry) => entry.descriptor.toLowerCase() === reader.toLowerCase())) throw new Error('Invalid nativeTools: reader conflicts with a descriptor.');
  const consumers = normalizeConsumers(input.consumers);
  validateReferences(definitions, consumers);
  return { reader, definitions, consumers };
}

export function validateNativeToolsManifest(manifest: NormalizedPluginManifest, options: { source?: boolean } = {}): void {
  if (!manifest.nativeTools) return;
  for (const consumer of manifest.nativeTools.consumers) {
    if (consumer.kind === 'managed-command-set') {
      if (!manifest.managedCommands?.sets.some((set) => set.set === consumer.key)) throw new Error('Invalid nativeTools consumer: unknown managed command set.');
    } else if (consumer.key !== 'node' || (options.source && (manifest.scripts?.tests?.node?.length ?? 0) === 0)) {
      throw new Error('Invalid nativeTools consumer: unknown plugin test runner.');
    }
  }
}

export function normalizeNativeToolClosure(value: unknown): NativeToolClosure {
  const input = object(value, 'native tool closure', ['reader', 'definitions', 'consumers']);
  relativeFile(input.reader, 'native tool closure.reader');
  const definitions = array(input.definitions, 'native tool closure.definitions', 32).map((value) => {
    const entry = object(value, 'native tool closure definition', ['key', 'protocol', 'descriptorPath', 'descriptor', 'descriptorDigest']);
    const descriptor = parseNativeToolDescriptor(entry.descriptor);
    if (entry.descriptorDigest !== nativeToolDescriptorDigest(descriptor)) throw new Error('nativeDescriptorDigestMismatch');
    if (entry.protocol !== descriptor.tool.protocol) throw new Error('nativeProtocolMismatch');
    return { key: name(entry.key, 'native tool closure definition.key'), protocol: descriptor.tool.protocol, descriptorPath: relativeFile(entry.descriptorPath, 'native tool closure definition.descriptorPath'), descriptor, descriptorDigest: entry.descriptorDigest as string };
  }).sort((a, b) => compare(a.key, b.key));
  const normalized = normalizeNativeTools({ reader: input.reader, definitions: definitions.map((entry) => ({ key: entry.key, protocol: entry.protocol, descriptor: entry.descriptorPath })), consumers: input.consumers });
  return { reader: normalized.reader, definitions, consumers: normalized.consumers };
}

export async function loadPluginNativeToolClosure(pluginRoot: string, manifest: NormalizedPluginManifest): Promise<NativeToolClosure | undefined> {
  if (!manifest.nativeTools) return undefined;
  validateNativeToolsManifest(manifest);
  const definitions = await Promise.all(manifest.nativeTools.definitions.map(async (entry) => {
    const source = await resolveCanonicalRuntimeSourceIdentity(pluginRoot, entry.descriptor, 'nativeTools descriptor');
    const stat = await fs.stat(source.sourceRealPath);
    if (stat.size > 64 * 1024) throw new Error('nativeDescriptorTooLarge');
    const descriptor = parseNativeToolDescriptor(JSON.parse(await fs.readFile(source.sourceRealPath, 'utf8')));
    if (entry.protocol !== descriptor.tool.protocol) throw new Error('nativeProtocolMismatch');
    return { key: entry.key, protocol: entry.protocol, descriptorPath: entry.descriptor, descriptor, descriptorDigest: nativeToolDescriptorDigest(descriptor) };
  }));
  const closure = normalizeNativeToolClosure({ reader: manifest.nativeTools.reader, definitions, consumers: manifest.nativeTools.consumers });
  if (await fs.pathExists(path.resolve(pluginRoot, closure.reader))) {
    await validateNativeToolReader(pluginRoot, closure.reader);
  }
  return closure;
}

export function getNativeToolConsumerClosure(
  closure: NativeToolClosure | undefined,
  kind: NativeToolConsumer['kind'],
  key: string | readonly string[],
): NativeToolClosure | undefined {
  if (!closure) return undefined;
  const normalized = normalizeNativeToolClosure(closure);
  const keys = new Set(typeof key === 'string' ? [key] : key);
  const consumers = normalized.consumers.filter((entry) => entry.kind === kind && keys.has(entry.key));
  if (consumers.length === 0) return undefined;
  const tools = new Set(consumers.flatMap((entry) => entry.tools.map((tool) => tool.key)));
  return { reader: normalized.reader, definitions: normalized.definitions.filter((entry) => tools.has(entry.key)), consumers };
}

/** Returns producer-relative files and complete evidence for the selected consumers. */
export function materializeNativeToolClosureFiles(closure: NativeToolClosure): { closure: NativeToolClosure; files: Record<string, string> } {
  const normalized = normalizeNativeToolClosure(closure);
  const files: Record<string, string> = { [DEFAULT_NATIVE_TOOL_READER.slice(2)]: createNativeToolReaderSource() };
  const definitions = normalized.definitions.map((entry) => {
    const descriptorPath = `./.aw/native-tools/${entry.key}.lock.json`;
    files[descriptorPath.slice(2)] = `${JSON.stringify(entry.descriptor, null, 2)}\n`;
    return { ...entry, descriptorPath };
  });
  return { closure: { reader: DEFAULT_NATIVE_TOOL_READER, definitions, consumers: normalized.consumers }, files };
}

async function writeGeneratedFile(root: string, relative: string, content: string): Promise<void> {
  const segments = relative.replace(/^\.\//u, '').split('/');
  let current = root;
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('nativeToolUnsafePath');
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!stat) await fs.mkdir(current);
    else if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('nativeToolUnsafePath');
  }
  const target = path.join(root, ...segments);
  const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || await fs.readFile(target, 'utf8') !== content) throw new Error('nativeToolGeneratedFileConflict');
    return;
  }
  await fs.writeFile(target, content, { flag: 'wx' });
}

export async function preparePluginNativeTools(pluginRoot: string, manifest: NormalizedPluginManifest): Promise<string | undefined> {
  const closure = await loadPluginNativeToolClosure(pluginRoot, manifest);
  if (!closure) return undefined;
  await writeGeneratedFile(pluginRoot, closure.reader, createNativeToolReaderSource());
  return path.resolve(pluginRoot, closure.reader);
}

export async function validateNativeToolClosureFiles(root: string, closure: NativeToolClosure): Promise<void> {
  const normalized = normalizeNativeToolClosure(closure);
  for (const entry of normalized.definitions) {
    const source = await resolveCanonicalRuntimeSourceIdentity(root, entry.descriptorPath, 'native tool descriptor evidence');
    if ((await fs.stat(source.sourceRealPath)).size > 64 * 1024) throw new Error('nativeDescriptorTooLarge');
    const descriptor = parseNativeToolDescriptor(JSON.parse(await fs.readFile(source.sourceRealPath, 'utf8')));
    if (nativeToolDescriptorDigest(descriptor) !== entry.descriptorDigest) throw new Error('nativeDescriptorDigestMismatch');
  }
  await validateNativeToolReader(root, normalized.reader);
}

async function validateNativeToolReader(root: string, reader: string): Promise<void> {
  const source = await resolveCanonicalRuntimeSourceIdentity(root, reader, 'native tool reader');
  if ((await fs.stat(source.sourceRealPath)).size > 64 * 1024) throw new Error('nativeToolReaderMismatch');
  if (await fs.readFile(source.sourceRealPath, 'utf8') !== createNativeToolReaderSource()) throw new Error('nativeToolReaderMismatch');
}

export async function copyNativeToolClosureFiles(options: { sourceRoot: string; destinationRoot: string; closure: NativeToolClosure }): Promise<NativeToolClosure> {
  await validateNativeToolClosureFiles(options.sourceRoot, options.closure);
  const materialized = materializeNativeToolClosureFiles(options.closure);
  for (const [relative, content] of Object.entries(materialized.files)) await writeGeneratedFile(options.destinationRoot, relative, content);
  await validateNativeToolClosureFiles(options.destinationRoot, materialized.closure);
  return materialized.closure;
}
