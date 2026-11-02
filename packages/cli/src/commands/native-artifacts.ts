import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Command } from 'commander';
import {
  importNativeTool,
  nativeToolDescriptorDigest,
  parseNativeToolDescriptor,
  resolveNativeTool,
  type NativeToolDescriptor,
} from '@lesliechan721/aw-native-runtime';

import type { CliExecutionContext } from './runtime.js';
import { resolveAwHome } from '../utils/state-paths.js';

type NativeArtifactAction = 'import' | 'prefetch' | 'verify';

export interface NativeArtifactReceipt {
  schemaVersion: 1;
  command: `native.${NativeArtifactAction}`;
  ok: boolean;
  tool: NativeToolDescriptor['tool'] | null;
  descriptorDigest: string | null;
  variants: Array<{ platform: string; arch: string; sha256: string }>;
  errors: Array<{ code: string; message: string }>;
}

interface NativeArtifactOptions {
  action: NativeArtifactAction;
  descriptorPath: string;
  archivePath?: string;
  cacheRoot?: string;
  platform?: string;
  arch?: string;
  allVariants?: boolean;
}

const MAX_DESCRIPTOR_BYTES = 256 * 1024;

async function readDescriptor(file: string): Promise<NativeToolDescriptor> {
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  const segments = path.relative(current, absolute).split(path.sep).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (index === segments.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw Object.assign(new Error(), { code: 'nativeDescriptorUnsafePath' });
    }
    if (index === segments.length - 1 && stat.size > MAX_DESCRIPTOR_BYTES) {
      throw Object.assign(new Error(), { code: 'nativeDescriptorTooLarge' });
    }
  }
  const bytes = await fs.readFile(absolute);
  if (bytes.length > MAX_DESCRIPTOR_BYTES) throw Object.assign(new Error(), { code: 'nativeDescriptorTooLarge' });
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw Object.assign(new Error(), { code: 'nativeDescriptorInvalid' }); }
  return parseNativeToolDescriptor(value);
}

function failureCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^native[A-Za-z0-9]+$/u.test(code) ? code : 'nativeArtifactFailed';
}

export async function prepareNativeArtifacts(
  options: NativeArtifactOptions,
  context: Pick<CliExecutionContext, 'cwd' | 'env'>,
): Promise<NativeArtifactReceipt> {
  const receipt: NativeArtifactReceipt = {
    schemaVersion: 1,
    command: `native.${options.action}`,
    ok: false,
    tool: null,
    descriptorDigest: null,
    variants: [],
    errors: [],
  };
  let temporary: string | undefined;
  try {
    const descriptor = await readDescriptor(path.resolve(context.cwd, options.descriptorPath));
    receipt.tool = descriptor.tool;
    receipt.descriptorDigest = nativeToolDescriptorDigest(descriptor);
    if (options.allVariants && (options.action !== 'verify' || options.platform || options.arch)) {
      throw Object.assign(new Error(), { code: 'nativeArgumentsInvalid' });
    }
    const targets = options.allVariants
      ? descriptor.variants.map(({ platform, arch }) => ({ platform, arch }))
      : [{ platform: options.platform ?? process.platform, arch: options.arch ?? process.arch }];
    // The system temporary path can contain a symlink (for example /var on macOS).
    // Canonicalize this host-owned root before the resolver checks its path chain.
    const cacheRoot = options.action === 'verify'
      ? await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-native-verify-'))
      : path.resolve(context.cwd, options.cacheRoot ?? path.join(resolveAwHome(context.env), 'native-artifacts', 'v1'));
    if (options.action === 'verify') temporary = cacheRoot;
    // Offline import must work before the helper, registry, or any AW write lock exists.
    for (const target of targets) {
      const result = options.action === 'import'
        ? await importNativeTool({
            descriptor,
            archivePath: path.resolve(context.cwd, options.archivePath!),
            cacheRoot,
            ...target,
          })
        : await resolveNativeTool({ descriptor, cacheRoot, ...target, mode: 'network', registryEnvironment: context.env });
      receipt.variants.push({ ...target, sha256: result.sha256 });
    }
    receipt.ok = true;
  } catch (error) {
    const code = failureCode(error);
    receipt.errors.push({ code, message: `Native artifact operation failed (${code}).` });
  } finally {
    if (temporary) await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
  return receipt;
}

export function registerNativeArtifactCli(
  program: Command,
  context: () => CliExecutionContext,
  setExitCode: (code: number) => void,
): void {
  const native = program.command('native').description('Import, prefetch, and verify locked native artifacts');
  for (const action of ['import', 'prefetch', 'verify'] as const) {
    const command = native.command(action)
      .argument('<descriptor>', 'Native tool descriptor lock')
      .description(action === 'import' ? 'Import a local archive without network access' : action === 'verify' ? 'Verify published references in a temporary cache' : 'Prepare a native tool in the local cache')
      .option('--platform <platform>', 'Select an explicit platform')
      .option('--arch <arch>', 'Select an explicit architecture')
      .option('--json', 'Write one JSON receipt');
    if (action === 'import') command.requiredOption('--archive <file>', 'Local npm tarball');
    if (action === 'verify') command.option('--all-variants', 'Verify every locked platform and architecture');
    else command.option('--cache-root <directory>', 'Use an explicit isolated cache root');
    command.action(async (descriptorPath: string, raw: {
      archive?: string; cacheRoot?: string; platform?: string; arch?: string; allVariants?: boolean; json?: boolean;
    }) => {
      const execution = context();
      const receipt = await prepareNativeArtifacts({
        action, descriptorPath, archivePath: raw.archive, cacheRoot: raw.cacheRoot,
        platform: raw.platform, arch: raw.arch, allVariants: raw.allVariants,
      }, execution);
      if (raw.json) execution.io.stdout(`${JSON.stringify(receipt, null, 2)}\n`);
      else {
        if (receipt.ok) execution.io.stdout(`${receipt.command}: ${receipt.tool!.id}@${receipt.tool!.version}\n`);
        for (const error of receipt.errors) execution.io.stderr(`${error.code}: ${error.message}\n`);
      }
      setExitCode(receipt.ok ? 0 : 1);
    });
  }
}
