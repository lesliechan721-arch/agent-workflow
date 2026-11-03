export interface NativeToolReady { state: 'ready'; protocol: string; executable: string }
export interface NativeToolUnavailable { state: 'unavailable'; protocol: string; code: string }
export interface NativeToolContext { schemaVersion: 1; tools: Record<string, NativeToolReady | NativeToolUnavailable> }
export const NATIVE_TOOL_CONTEXT_ENV: 'AW_NATIVE_TOOL_CONTEXT';
export function readNativeTool(key: string, protocol: string, environment?: Record<string, string | undefined>): NativeToolReady | NativeToolUnavailable;
export function createNativeToolReaderSource(): string;
