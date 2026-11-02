import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseNativeToolDescriptor, resolveNativeTool } from '@lesliechan721/aw-native-runtime';

import { runCli } from '../../src/index.js';
import type { NativeArtifactReceipt } from '../../src/commands/native-artifacts.js';
import { createIsolatedTestEnv, type IsolatedTestEnvironment } from '../helpers/test-isolation.js';

const execFileAsync = promisify(execFile);

function tarFile(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512)]);
}

function nativeFixture(arch: 'x64' | 'arm64') {
  const executable = Buffer.alloc(512);
  executable.write('MZ', 0, 'ascii');
  executable.writeUInt32LE(128, 60);
  executable.write('PE\0\0', 128, 'ascii');
  const machine = arch === 'x64' ? '0x8664' : '0xaa64';
  executable.writeUInt16LE(Number(machine), 132);
  const packageName = `@fixture/job-win32-${arch}`;
  const archive = gzipSync(Buffer.concat([
    tarFile('package/package.json', Buffer.from(JSON.stringify({ name: packageName, version: '1.0.0' }))),
    tarFile('package/dist/aw-windows-job.exe', executable),
    Buffer.alloc(1024),
  ]));
  const descriptor = parseNativeToolDescriptor({
    schemaVersion: 1,
    tool: { id: '@fixture/job', version: '1.0.0', protocol: 'aw.windows-job.v1' },
    variants: [{
      platform: 'win32', arch,
      transport: { kind: 'npm', package: packageName, version: '1.0.0', archiveIntegrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`, entry: 'package/dist/aw-windows-job.exe' },
      file: { sha256: `sha256:${createHash('sha256').update(executable).digest('hex')}`, size: executable.length, format: 'pe', machine },
      limits: { archiveBytes: 8192, expandedBytes: 16384, entries: 8 },
    }],
  });
  return { descriptor, archive, executable };
}

describe('native artifact management CLI', () => {
  let isolated: IsolatedTestEnvironment;
  beforeEach(async () => { isolated = await createIsolatedTestEnv(); });
  afterEach(async () => { await isolated.cleanup(); });

  async function invoke(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
    let stdout = '';
    let stderr = '';
    const exitCode = await runCli(['native', ...args], {
      cwd: isolated.layout.fixtureCwd,
      env: { ...isolated.env, ...extraEnv },
      interactive: false,
      io: { stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; } },
    });
    return { exitCode, stdout, stderr, receipt: stdout ? JSON.parse(stdout) as NativeArtifactReceipt : undefined };
  }

  // Protects the public offline recovery entry point and its one-object receipt.
  it('imports a locked local archive into an empty cache without consulting registry configuration', async () => {
    const { descriptor, archive, executable } = nativeFixture('x64');
    const descriptorPath = path.join(isolated.layout.fixtureCwd, 'tool.lock.json');
    const archivePath = path.join(isolated.layout.fixtureCwd, 'tool.tgz');
    const cacheRoot = path.join(isolated.layout.awHomeDir, 'native-artifacts', 'v1');
    await fs.writeFile(descriptorPath, JSON.stringify(descriptor));
    await fs.writeFile(archivePath, archive);
    const result = await invoke(['import', descriptorPath, '--archive', archivePath, '--platform', 'win32', '--arch', 'x64', '--json'], {
      AW_NATIVE_REGISTRY_CONFIG: 'not valid JSON and must not be read by offline import',
    });
    expect(result.exitCode, result.stdout || result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.receipt).toMatchObject({ schemaVersion: 1, command: 'native.import', ok: true, tool: descriptor.tool, variants: [{ platform: 'win32', arch: 'x64', sha256: descriptor.variants[0]!.file.sha256 }], errors: [] });
    const resolved = await resolveNativeTool({ descriptor, cacheRoot, platform: 'win32', arch: 'x64', mode: 'cache-only' });
    expect(await fs.readFile(resolved.executable)).toEqual(executable);
  });

  // Verifies the shipped command through a real registry and a symlinked system temp root.
  it('verifies every locked variant through the public CLI and cleans its canonical temporary cache', async () => {
    const fixtures = [nativeFixture('x64'), nativeFixture('arm64')];
    const descriptor = parseNativeToolDescriptor({
      ...fixtures[0]!.descriptor,
      variants: fixtures.flatMap((fixture) => fixture.descriptor.variants),
    });
    const descriptorPath = path.join(isolated.layout.fixtureCwd, 'verify.lock.json');
    await fs.writeFile(descriptorPath, JSON.stringify(descriptor));
    const realTemporary = path.join(isolated.layout.tmpDir, 'canonical');
    const linkedTemporary = path.join(isolated.layout.tmpDir, 'linked');
    await fs.mkdir(realTemporary);
    await fs.symlink(realTemporary, linkedTemporary, process.platform === 'win32' ? 'junction' : 'dir');
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url!);
      const fixture = fixtures.find(({ descriptor: value }) => request.url === `/${encodeURIComponent(value.variants[0]!.transport.package)}/1.0.0`);
      if (fixture) {
        const variant = fixture.descriptor.variants[0]!;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          name: variant.transport.package,
          version: '1.0.0',
          dist: { tarball: `http://127.0.0.1:${(server.address() as { port: number }).port}/${variant.arch}.tgz` },
        }));
        return;
      }
      const archive = fixtures.find(({ descriptor: value }) => request.url === `/${value.variants[0]!.arch}.tgz`);
      if (archive) { response.end(archive.archive); return; }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await execFileAsync(process.execPath, [
        fileURLToPath(new URL('../../dist/index.js', import.meta.url)),
        'native', 'verify', descriptorPath, '--all-variants', '--json',
      ], {
        cwd: isolated.layout.fixtureCwd,
        env: {
          ...isolated.env,
          TMPDIR: linkedTemporary, TEMP: linkedTemporary, TMP: linkedTemporary,
          AW_NATIVE_REGISTRY_CONFIG: JSON.stringify({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` }),
        },
        timeout: 30_000,
      });
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({
        command: 'native.verify', ok: true,
        variants: descriptor.variants.map(({ platform, arch, file }) => ({ platform, arch, sha256: file.sha256 })),
        errors: [],
      });
      expect(requests).toHaveLength(4);
      expect(await fs.readdir(realTemporary)).toEqual([]);
      await expect(fs.lstat(path.join(isolated.layout.awHomeDir, 'native-artifacts'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  // Protects safe diagnostics before network access or cache writes on invalid user input.
  it('rejects an invalid descriptor without exposing its contents or creating a native cache', async () => {
    const descriptorPath = path.join(isolated.layout.fixtureCwd, 'invalid.lock.json');
    await fs.writeFile(descriptorPath, '{"secret":"fixture-private-value",broken');
    const result = await invoke(['prefetch', descriptorPath, '--json']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.receipt).toMatchObject({ schemaVersion: 1, command: 'native.prefetch', ok: false, errors: [{ code: 'nativeDescriptorInvalid' }] });
    expect(result.stdout).not.toContain('fixture-private-value');
    expect(result.stdout).not.toContain(descriptorPath);
    await expect(fs.lstat(path.join(isolated.layout.awHomeDir, 'native-artifacts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
