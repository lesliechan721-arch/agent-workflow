import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createProxy } from 'node:http';
import { createServer as createRegistry } from 'node:https';
import { connect } from 'node:net';
import { createSecureContext } from 'node:tls';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tempFixture } from './fixtures.mjs';

const certificatePath = fileURLToPath(new URL('./tls/registry-cert.pem', import.meta.url));
const keyPath = fileURLToPath(new URL('./tls/registry-key.pem', import.meta.url));
const runtimeUrl = new URL('../src/index.mjs', import.meta.url).href;

function resolveInNode(options, trustCertificate) {
  // A fresh Node process loads the explicit test CA without changing the test
  // runner's TLS defaults. The fixture key is public test data, not a credential.
  const script = `import { resolveNativeTool } from ${JSON.stringify(runtimeUrl)};
    const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
    try { const ready = await resolveNativeTool(JSON.parse(Buffer.concat(chunks).toString('utf8'))); console.log(JSON.stringify({ state: ready.state })); }
    catch (error) { console.log(JSON.stringify({ code: error.code })); }`;
  return new Promise((resolve, reject) => {
    const environment = { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '1' };
    if (trustCertificate) environment.NODE_EXTRA_CA_CERTS = certificatePath;
    else delete environment.NODE_EXTRA_CA_CERTS;
    const child = execFile(process.execPath, ['--input-type=module', '-e', script],
      { env: environment, timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
        if (error) reject(error);
        else {
          try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
        }
      });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(options));
  });
}

test('HTTPS CONNECT includes the default or explicit port and retains TLS identity and credential scopes', async (t) => {
  const input = await tempFixture(t);
  const cert = await readFile(certificatePath);
  const key = await readFile(keyPath);
  const secureContext = createSecureContext({ cert, key });
  const connections = new Set();
  const authorities = [];
  const serverNames = [];
  const requests = [];
  let registryUrl;
  const registry = createRegistry({ cert, key, SNICallback(servername, callback) {
    serverNames.push(servername);
    callback(null, secureContext);
  } }, (request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    if (request.url === '/%40example%2Fjob-win32-x64/1.2.3') {
      response.end(JSON.stringify({ name: '@example/job-win32-x64', version: '1.2.3', dist: { tarball: `${registryUrl}artifact.tgz` } }));
    } else if (request.url === '/artifact.tgz') response.end(input.archive);
    else { response.statusCode = 404; response.end(); }
  });
  const proxy = createProxy();
  proxy.on('connect', (request, client) => {
    authorities.push({ path: request.url, host: request.headers.host, authorization: request.headers.authorization });
    const upstream = connect({ host: '127.0.0.1', port: registry.address().port }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      client.pipe(upstream);
      upstream.pipe(client);
    });
    connections.add(upstream);
    upstream.on('error', () => client.destroy());
    upstream.on('close', () => connections.delete(upstream));
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  for (const server of [registry, proxy]) {
    server.on('connection', (socket) => {
      connections.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => connections.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  }
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await Promise.all([registry, proxy].map((server) => new Promise((resolve) => server.close(resolve))));
  });
  const cases = [
    { url: 'https://registry.example.invalid/', authority: 'registry.example.invalid:443', trust: true, ready: true },
    { url: 'https://registry.example.invalid:443/', authority: 'registry.example.invalid:443', trust: true, ready: true },
    { url: 'https://registry.example.invalid:8443/', authority: 'registry.example.invalid:8443', trust: true, ready: true },
    { url: 'https://registry.example.invalid/', authority: 'registry.example.invalid:443', trust: false, ready: false },
    { url: 'https://other.registry.invalid/', authority: 'other.registry.invalid:443', trust: true, ready: false },
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const current = cases[index];
    registryUrl = current.url;
    authorities.length = 0;
    serverNames.length = 0;
    requests.length = 0;
    const result = await resolveInNode({
      descriptor: input.descriptor, cacheRoot: `${input.cacheRoot}-${index}`, platform: 'win32', arch: 'x64', mode: 'network',
      registry: { url: 'https://default.registry.invalid/', headers: { authorization: 'Bearer DEFAULT_TOKEN' },
        scopes: { '@example': current.url }, registryHeaders: { [current.url]: { authorization: 'Bearer SCOPE_TOKEN' } },
        proxy: `http://127.0.0.1:${proxy.address().port}/` },
    }, current.trust);
    assert.deepEqual(result, current.ready ? { state: 'ready' } : { code: 'nativeDownloadFailed' });
    assert.equal(authorities.length, current.ready ? 2 : 1);
    assert.ok(authorities.every((value) => value.path === current.authority && value.host === current.authority && value.authorization === undefined));
    assert.ok(serverNames.length > 0);
    assert.ok(serverNames.every((name) => name === new URL(current.url).hostname));
    if (current.ready) {
      assert.deepEqual(requests, [
        { path: '/%40example%2Fjob-win32-x64/1.2.3', authorization: 'Bearer SCOPE_TOKEN' },
        { path: '/artifact.tgz', authorization: 'Bearer SCOPE_TOKEN' },
      ]);
    } else assert.deepEqual(requests, []);
  }
});
