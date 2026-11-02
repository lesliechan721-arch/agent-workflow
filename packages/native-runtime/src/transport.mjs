import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { NativeToolError, NATIVE_TOOL_LIMITS } from './descriptor.mjs';

function reject(code = 'nativeRegistryConfigInvalid') { throw new NativeToolError(code); }

function url(value, proxy = false) {
  let parsed;
  try { parsed = new URL(value); } catch { reject(); }
  if (!(proxy ? ['http:'] : ['http:', 'https:']).includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.hash || parsed.search) reject();
  return parsed;
}

function headers(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject();
  for (const [name, content] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || typeof content !== 'string'
      || /[\r\n\x00]/.test(content) || /^(?:host|content-length|connection|transfer-encoding|proxy-authorization)$/i.test(name)) reject();
  }
  return { ...value };
}

export function resolveNativeRegistryConfig(environment = process.env) {
  const raw = environment.AW_NATIVE_REGISTRY_CONFIG;
  if (raw === undefined || raw === '') return { url: 'https://registry.npmjs.org/' };
  if (typeof raw !== 'string' || raw.length > 64 * 1024) reject();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { reject(); }
  return normalizeRegistry(parsed);
}

function normalizeRegistry(value) {
  const config = typeof value === 'string' ? { url: value } : value;
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some((key) => !['url', 'scopes', 'headers', 'registryHeaders', 'proxy'].includes(key))) reject();
  const normalized = { url: url(config.url).href, headers: headers(config.headers), scopes: {}, registryHeaders: {} };
  for (const mapping of [config.scopes, config.registryHeaders]) {
    if (mapping !== undefined && (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)
      || Object.keys(mapping).length > 64)) reject();
  }
  for (const [scope, registry] of Object.entries(config.scopes ?? {})) {
    if (!/^@[a-z0-9][a-z0-9._-]*$/.test(scope)) reject();
    normalized.scopes[scope] = url(registry).href;
  }
  for (const [registry, credentials] of Object.entries(config.registryHeaders ?? {})) {
    normalized.registryHeaders[url(registry).href] = headers(credentials);
  }
  if (config.proxy !== undefined) normalized.proxy = url(config.proxy, true).href;
  return normalized;
}

function requestBytes(target, requestHeaders, maximum, signal, proxy) {
  return new Promise((resolve, rejectPromise) => {
    let request;
    let tunnel;
    let activeSocket;
    let finished = false;
    function finish(error, result) {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', aborted);
      if (error) { request?.destroy(); tunnel?.destroy(); activeSocket?.destroy(); rejectPromise(error); }
      else resolve(result);
    }
    function aborted() { finish(new NativeToolError('nativeDownloadTimeout')); }
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    function start(socket) {
      const transport = target.protocol === 'https:' ? https : http;
      const options = { method: 'GET', headers: requestHeaders, signal };
      if (socket) options.createConnection = () => socket;
      else options.agent = false;
      const destination = proxy && target.protocol === 'http:' ? proxy : target;
      if (proxy && target.protocol === 'http:') {
        options.path = target.href;
        options.headers = { ...requestHeaders, host: target.host };
      }
      request = transport.request(destination, options, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          finish(new NativeToolError(response.statusCode === 404 ? 'nativePackageUnavailable' : 'nativeDownloadFailed'));
          return;
        }
        const declared = response.headers['content-length'];
        if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
          response.destroy(); finish(new NativeToolError('nativeArchiveLimitExceeded')); return;
        }
        let length = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          length += chunk.length;
          if (length > maximum) { response.destroy(); finish(new NativeToolError('nativeArchiveLimitExceeded')); }
          else chunks.push(chunk);
        });
        response.on('end', () => finish(undefined, Buffer.concat(chunks, length)));
        response.on('error', () => finish(new NativeToolError('nativeDownloadFailed')));
      });
      request.on('error', () => finish(new NativeToolError(signal.aborted ? 'nativeDownloadTimeout' : 'nativeDownloadFailed')));
      request.end();
    }
    if (proxy && target.protocol === 'https:') {
      const authority = `${target.hostname}:${target.port || '443'}`;
      tunnel = http.request(proxy, { method: 'CONNECT', path: authority, headers: { host: authority }, signal, agent: false });
      tunnel.on('connect', (response, socket, head) => {
        if (response.statusCode !== 200 || head.length) { socket.destroy(); finish(new NativeToolError('nativeDownloadFailed')); return; }
        activeSocket = tls.connect({ socket, servername: target.hostname });
        activeSocket.on('error', () => finish(new NativeToolError('nativeDownloadFailed')));
        activeSocket.once('secureConnect', () => start(activeSocket));
      });
      tunnel.on('error', () => finish(new NativeToolError(signal.aborted ? 'nativeDownloadTimeout' : 'nativeDownloadFailed')));
      tunnel.end();
    } else start();
  });
}

export async function downloadNativeArchive(variant, input) {
  const config = normalizeRegistry(input ?? resolveNativeRegistryConfig());
  const scope = variant.transport.package.startsWith('@') ? variant.transport.package.split('/')[0] : '';
  const selected = config.scopes[scope] ?? config.url;
  const registry = url(selected);
  if (!registry.pathname.endsWith('/')) registry.pathname += '/';
  const credentials = selected === config.url ? config.headers : {};
  const requestHeaders = { accept: 'application/json', ...credentials, ...config.registryHeaders[selected] };
  const proxy = config.proxy ? url(config.proxy, true) : undefined;
  const signal = AbortSignal.timeout(NATIVE_TOOL_LIMITS.timeoutMs);
  try {
    const metadataUrl = new URL(`${encodeURIComponent(variant.transport.package)}/${encodeURIComponent(variant.transport.version)}`, registry);
    const bytes = await requestBytes(metadataUrl, requestHeaders, 1024 * 1024, signal, proxy);
    let metadata;
    try { metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { reject('nativeRegistryMetadataInvalid'); }
    if (metadata.name !== variant.transport.package || metadata.version !== variant.transport.version) reject('nativePackageMismatch');
    const archiveUrl = url(metadata.dist?.tarball);
    // An untrusted package response cannot redirect credentials or probe another service.
    if (archiveUrl.origin !== registry.origin || !archiveUrl.pathname.startsWith(registry.pathname)) reject('nativeRegistryArchiveOriginInvalid');
    return await requestBytes(archiveUrl, { ...requestHeaders, accept: 'application/octet-stream' }, variant.limits.archiveBytes, signal, proxy);
  } catch (error) {
    if (error instanceof NativeToolError) throw error;
    reject(signal.aborted ? 'nativeDownloadTimeout' : 'nativeDownloadFailed');
  }
}
