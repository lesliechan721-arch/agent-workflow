export interface NativeToolVariant {
  platform: 'win32';
  arch: 'x64' | 'arm64';
  transport: { kind: 'npm'; package: string; version: string; archiveIntegrity: string; entry: string };
  file: { sha256: string; size: number; format: 'pe'; machine: '0x8664' | '0xaa64' };
  limits: { archiveBytes: number; expandedBytes: number; entries: number };
}
export interface NativeToolDescriptor {
  schemaVersion: 1;
  tool: { id: string; version: string; protocol: string };
  variants: NativeToolVariant[];
}
export interface NativeToolReady { state: 'ready'; protocol: string; executable: string; sha256: string }
export class NativeToolError extends Error { readonly code: string; constructor(code: string); }
export const NATIVE_TOOL_LIMITS: Readonly<{ archiveBytes: number; expandedBytes: number; entries: number; timeoutMs: number }>;
export function parseNativeToolDescriptor(value: unknown): NativeToolDescriptor;
export function nativeToolDescriptorDigest(descriptor: NativeToolDescriptor): string;
export function selectNativeToolVariant(descriptor: NativeToolDescriptor, platform?: string, arch?: string): NativeToolVariant;
export function validateNativeBinary(bytes: Uint8Array, variant: NativeToolVariant): void;
export function isSafeNativeArchivePath(value: unknown, directory?: boolean): boolean;
