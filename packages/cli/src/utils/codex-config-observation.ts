import path from 'node:path';
import type { NativeCliInput } from './native-cli.js';

const MAX_CONFIG_OBSERVATION_BYTES = 1024 * 1024;
const LAYER_VERSION = /^sha256:[a-f0-9]{64}$/u;

export type CodexProjectTrustObservation =
  | { state: 'observed'; trust: 'trusted' | 'denied' }
  | { state: 'unknown' }
  | { state: 'failed' };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('codexConfigObservationInvalid');
  }
  return value as Record<string, unknown>;
}

interface ExchangeState {
  initialized: boolean;
  config?: Record<string, unknown>;
}

function readMessage(state: ExchangeState, line: string): 'initialized' | 'config' | 'notification' {
  const message = record(JSON.parse(line));
  if (message.jsonrpc !== undefined && message.jsonrpc !== '2.0') throw new Error('codexConfigObservationInvalid');
  if (!Object.hasOwn(message, 'id') && typeof message.method === 'string' && message.method.length > 0
    && !Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error')
    && (message.params === undefined || message.params !== null && typeof message.params === 'object')) {
    return 'notification';
  }
  if (Object.hasOwn(message, 'error') || Object.hasOwn(message, 'method')
    || !Object.hasOwn(message, 'result')) throw new Error('codexConfigObservationInvalid');
  const result = record(message.result);
  if (message.id === 1 && !state.initialized && !state.config) {
    state.initialized = true;
    return 'initialized';
  }
  if (message.id === 2 && state.initialized && !state.config) {
    state.config = result;
    return 'config';
  }
  throw new Error('codexConfigObservationInvalid');
}

/** Notifications carry no trust evidence and are never retained by this reader. */
export function createCodexConfigReadInput(cwd: string): NativeCliInput {
  const state: ExchangeState = { initialized: false };
  let buffer = '';
  let bytes = 0;
  return {
    initial: `${JSON.stringify({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'aw_native_observation', version: '1.0.0' }, capabilities: { experimentalApi: true },
    } })}\n`,
    onStdout(chunk) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_CONFIG_OBSERVATION_BYTES) throw new Error('codexConfigObservationOutputLimit');
      buffer += chunk;
      let write = '';
      let end: true | undefined;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const response = readMessage(state, line);
        if (response === 'initialized') {
          write += `${JSON.stringify({ method: 'initialized', params: {} })}\n${JSON.stringify({
            id: 2, method: 'config/read', params: { includeLayers: true, cwd },
          })}\n`;
        } else if (response === 'config') end = true;
      }
      return { ...(write ? { write } : {}), ...(end ? { end } : {}) };
    },
  };
}

/** Accept only complete successful responses to this reader's fixed requests. */
export function parseCodexConfigReadOutput(stdout: string): Record<string, unknown> {
  if (Buffer.byteLength(stdout) > MAX_CONFIG_OBSERVATION_BYTES) throw new Error('codexConfigObservationOutputLimit');
  const state: ExchangeState = { initialized: false };
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    readMessage(state, line);
  }
  if (!state.initialized || !state.config) throw new Error('codexConfigObservationIncomplete');
  record(state.config.config);
  record(state.config.origins);
  if (!Array.isArray(state.config.layers)) throw new Error('codexConfigObservationInvalid');
  for (const value of state.config.layers) {
    const layer = record(value);
    if (typeof record(layer.name).type !== 'string' || typeof layer.version !== 'string'
      || Object.hasOwn(layer, 'disabledReason') && typeof layer.disabledReason !== 'string') {
      throw new Error('codexConfigObservationInvalid');
    }
    record(layer.config);
  }
  return state.config;
}

/**
 * This deliberately supports only an exact canonical project key and the
 * matching effective user and project layers. It does not reproduce Codex's
 * repository-root, alternate path spelling, or managed/cloud trust lookup.
 */
export function observeCodexExactProjectTrust(response: Record<string, unknown>, cwd: string,
  codexHome: string): CodexProjectTrustObservation {
  try {
    const config = record(response.config);
    const projects = record(config.projects);
    if (process.platform === 'win32' && Object.keys(projects).some((key) => key !== cwd && key.toLowerCase() === cwd.toLowerCase())) {
      return { state: 'unknown' };
    }
    const trust = record(projects[cwd]).trust_level;
    if (trust !== 'trusted' && trust !== 'untrusted') return { state: 'unknown' };
    const origin = record(record(response.origins)[`projects.${cwd}.trust_level`]);
    const source = record(origin.name);
    if (source.type !== 'user' || source.file !== path.join(codexHome, 'config.toml') || source.profile !== null
      || typeof origin.version !== 'string' || !LAYER_VERSION.test(origin.version)
      || !Array.isArray(response.layers)) return { state: 'unknown' };
    const layers = response.layers.map(record);
    const sourceLayers = layers.filter((layer) => {
      const name = record(layer.name);
      return name.type === source.type && name.file === source.file && name.profile === source.profile
        && layer.version === origin.version;
    });
    const projectLayers = layers.filter((layer) => {
      const name = record(layer.name);
      return name.type === 'project' && name.dotCodexFolder === path.join(cwd, '.codex');
    });
    if (sourceLayers.length !== 1 || projectLayers.length !== 1) return { state: 'unknown' };
    const sourceLayer = sourceLayers[0]!;
    const projectLayer = projectLayers[0]!;
    record(projectLayer.config);
    if (Object.hasOwn(sourceLayer, 'disabledReason')
      || record(record(record(sourceLayer.config).projects)[cwd]).trust_level !== trust
      || typeof projectLayer.version !== 'string' || !LAYER_VERSION.test(projectLayer.version)) return { state: 'unknown' };
    if (trust === 'trusted' && !Object.hasOwn(projectLayer, 'disabledReason')) return { state: 'observed', trust: 'trusted' };
    if (trust === 'untrusted' && typeof projectLayer.disabledReason === 'string' && projectLayer.disabledReason.length > 0) {
      return { state: 'observed', trust: 'denied' };
    }
    return { state: 'unknown' };
  } catch {
    return { state: 'unknown' };
  }
}
