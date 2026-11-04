import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtureVersion = '9.8.7-beta.1';
const packagePath = (root, name) => path.join(root, 'node_modules', ...name.split('/'));

async function archive(root, metadata, files) {
  const source = path.join(root, metadata.name.split('/')[1]);
  const packageRoot = path.join(source, 'package');
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify(metadata));
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(packageRoot, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
  }
  const tarballPath = `${source}.tgz`;
  await exec('tar', ['-czf', tarballPath, '-C', source, 'package']);
  const bytes = await fs.readFile(tarballPath);
  return { metadata, tarballPath, bytes, integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}` };
}

// Test Value Gate: normal npm installation must use the published OS/CPU
// metadata to omit Windows optional packages on macOS/Linux. A compatible
// install proves that missing optional packages cannot make this pass.
test('npm selects optional Windows packages from real platform package metadata', { timeout: 60_000 }, async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-npm-platform-selection-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const native = await Promise.all(['x64', 'arm64'].map(async (arch) => {
    const metadata = JSON.parse(await fs.readFile(path.join(repoRoot, 'packages', `aw-windows-job-win32-${arch}`, 'package.json'), 'utf8'));
    // Preserve the production OS, CPU and exports. Only the version and payload
    // are fixtures; the placeholder is never executed as a Windows program.
    return archive(root, { ...metadata, version: fixtureVersion }, { 'dist/aw-windows-job.exe': `fixture-${arch}` });
  }));
  const evalSource = JSON.parse(await fs.readFile(path.join(repoRoot, 'packages/agent-skill-eval/package.json'), 'utf8'));
  assert.deepEqual(Object.keys(evalSource.optionalDependencies).sort(), native.map((entry) => entry.metadata.name).sort());
  const evaluator = await archive(root, {
    name: evalSource.name,
    version: fixtureVersion,
    optionalDependencies: Object.fromEntries(Object.keys(evalSource.optionalDependencies).map((name) => [name, fixtureVersion])),
  }, { 'index.js': 'module.exports = {};\n' });
  const requests = [];
  const unexpected = [];
  let registryUrl;
  const server = http.createServer((request, response) => {
    const route = decodeURIComponent(request.url.split('?')[0]);
    requests.push(route);
    const entry = native.find((candidate) => route === `/${candidate.metadata.name}`);
    if (request.method === 'GET' && entry) {
      const metadata = { ...entry.metadata, dist: { integrity: entry.integrity, tarball: `${registryUrl}archives/${path.basename(entry.tarballPath)}` } };
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        name: metadata.name, 'dist-tags': { beta: fixtureVersion }, versions: { [fixtureVersion]: metadata },
      }));
      return;
    }
    const archiveEntry = native.find((candidate) => route === `/archives/${path.basename(candidate.tarballPath)}`);
    if (request.method === 'GET' && archiveEntry) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(archiveEntry.bytes);
      return;
    }
    unexpected.push(`${request.method} ${route}`);
    response.writeHead(404).end('Not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  registryUrl = `http://127.0.0.1:${server.address().port}/`;
  const npmConfig = path.join(root, 'npmrc');
  await fs.writeFile(npmConfig, `registry=${registryUrl}\n@lesliechan721:registry=${registryUrl}\n`);
  const globalConfig = path.join(root, 'global-npmrc');
  await fs.writeFile(globalConfig, '');

  for (const target of ['darwin', 'linux', 'win32']) {
    await t.test(`${target === process.platform ? 'host default' : 'npm target override'} ${target}`, async () => {
      const project = path.join(root, target);
      await fs.mkdir(project);
      await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ private: true }));
      const requestStart = requests.length;
      const npm = process.platform === 'win32' ? process.execPath : 'npm';
      const npmEntry = process.platform === 'win32' ? [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')] : [];
      await exec(npm, [
        ...npmEntry, 'install', evaluator.tarballPath,
        '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund', '--prefer-online', '--update-notifier=false',
        '--registry', registryUrl, '--cache', path.join(project, 'cache'),
        '--userconfig', npmConfig, '--globalconfig', globalConfig,
        ...(target === process.platform ? [] : [`--os=${target}`]),
        ...(target === 'win32' ? ['--cpu=x64'] : []), '--fetch-retries=0',
      ], { cwd: project, env: { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' }, timeout: 20_000 });
      const installedEval = JSON.parse(await fs.readFile(path.join(packagePath(project, evalSource.name), 'package.json'), 'utf8'));
      assert.equal(installedEval.version, fixtureVersion);
      const selected = requests.slice(requestStart);
      for (const entry of native) {
        assert.ok(selected.includes(`/${entry.metadata.name}`), 'npm must read the real platform metadata');
        const installed = await fs.lstat(packagePath(project, entry.metadata.name)).catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (target === 'win32' && entry.metadata.name.endsWith('-x64')) {
          assert.ok(installed?.isDirectory(), 'compatible optional package must install');
          assert.ok(selected.includes(`/archives/${path.basename(entry.tarballPath)}`));
          const probe = await exec(process.execPath, ['--input-type=module', '--eval',
            'import { createRequire } from "node:module"; const require = createRequire(process.argv[1]); console.log(require.resolve(process.argv[2]));',
            path.join(packagePath(project, evalSource.name), 'index.js'), `${entry.metadata.name}/aw-windows-job.exe`,
          ], { cwd: project });
          assert.ok(probe.stdout.trim().startsWith(packagePath(project, entry.metadata.name)));
        } else {
          assert.equal(installed, null, 'incompatible platform package must not install');
          assert.ok(!selected.includes(`/archives/${path.basename(entry.tarballPath)}`), 'incompatible archive must not be fetched');
        }
      }
      assert.deepEqual(unexpected, [], 'installation must only read this local fixture registry');
    });
  }
});
