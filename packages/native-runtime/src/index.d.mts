export * from './descriptor.mjs';
export * from './reader.mjs';
import type { NativeToolDescriptor, NativeToolReady } from './descriptor.mjs';
export type NativeToolMode = 'fixture' | 'cache-only' | 'network' | 'source-candidate';
export interface NativeToolRegistry {
  url: string;
  scopes?: Record<string, string>;
  headers?: Record<string, string>;
  registryHeaders?: Record<string, Record<string, string>>;
  proxy?: string;
}
export function resolveNativeRegistryConfig(environment?: Record<string, string | undefined>): NativeToolRegistry;
export interface NativeToolTestConfig {
  mode: NativeToolMode;
  archivePath?: string;
  cacheRoot: string;
  descriptorPath?: string;
}
export function readNativeToolTestConfig(environment?: Record<string, string | undefined>): NativeToolTestConfig | undefined;
export interface ResolveNativeToolOptions {
  descriptor: NativeToolDescriptor;
  cacheRoot: string;
  platform?: string;
  arch?: string;
  mode?: NativeToolMode;
  registry?: string | NativeToolRegistry;
  /** Read controlled registry configuration only after a network-mode cache miss. */
  registryEnvironment?: Record<string, string | undefined>;
  /** Explicit local fixture/current-source archive. Never inferred from PATH or a checkout. */
  archivePath?: string;
}
export function resolveNativeTool(options: ResolveNativeToolOptions): Promise<NativeToolReady>;
export function importNativeTool(options: Omit<ResolveNativeToolOptions, 'mode' | 'registry' | 'registryEnvironment'> & { archivePath: string }): Promise<NativeToolReady>;
