import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import {
  getAwCapabilityRegistry,
  getPluginAuthoringCapabilitySurface,
  loadPluginNativeToolClosure,
  materializeNativeToolClosureFiles,
  validatePluginManifest,
} from '@lesliechan721/aw-plugin-core';

it('ships the native author contract and produces a reader usable without AW or private runtime packages', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-core-native-dist-'));
  try {
    const lock = {
      schemaVersion: 1, tool: { id: '@third-party/job', version: '1.0.0', protocol: 'example.job.v1' },
      variants: [{ platform: 'win32', arch: 'arm64',
        transport: { kind: 'npm', package: '@third-party/job-win32-arm64', version: '1.0.0', archiveIntegrity: `sha512-${Buffer.alloc(64).toString('base64')}`, entry: 'package/job.exe' },
        file: { sha256: `sha256:${'a'.repeat(64)}`, size: 128, format: 'pe', machine: '0xaa64' },
        limits: { archiveBytes: 4096, expandedBytes: 4096, entries: 8 } }],
    };
    await fs.writeFile(path.join(root, 'tool.lock.json'), JSON.stringify(lock));
    const manifest = validatePluginManifest(root, {
      schemaVersion: 3, name: 'third-party', version: '1.0.0', description: 'Third-party native test',
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      scripts: { tests: { node: ['tests/native.test.mjs'] } },
      nativeTools: { definitions: [{ key: 'job', protocol: 'example.job.v1', descriptor: './tool.lock.json' }],
        consumers: [{ kind: 'plugin-test', key: 'node', tools: [{ key: 'job', platforms: ['win32'], policy: 'required' }] }] },
    });
    const closure = await loadPluginNativeToolClosure(root, manifest);
    const generated = materializeNativeToolClosureFiles(closure!);
    for (const [relative, content] of Object.entries(generated.files)) {
      await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await fs.writeFile(path.join(root, relative), content);
    }
    await fs.unlink(path.join(root, 'tool.lock.json'));
    const ready = { state: 'ready', protocol: 'example.job.v1', executable: path.join(root, 'job.exe'), sha256: `sha256:${'a'.repeat(64)}` };
    const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      'const {readNativeTool}=await import(process.argv[1]); console.log(JSON.stringify(readNativeTool("job","example.job.v1")));',
      pathToFileURL(path.resolve(root, generated.closure.reader)).href], {
      cwd: root,
      env: { AW_NATIVE_TOOL_CONTEXT: JSON.stringify({ schemaVersion: 1, tools: { job: ready } }) },
    });
    expect(JSON.parse(child.stdout)).toEqual(ready);
    expect(child.stderr).toBe('');
    expect(getAwCapabilityRegistry()).toContain('aw.native-tools.v1');
    expect(getPluginAuthoringCapabilitySurface('native-tools').entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'nativeTools.consumers[].tools[].policy', acceptedValues: ['required', 'preferred'] }),
    ]));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
