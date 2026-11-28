// Windows-only acquisition of the bytes used by the official 1.0.77 npm bootstrap.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { brotliDecompress } from 'node:zlib';

const parentName = '@xai-official/grok';
const distribution = '@xai-official/grok-win32-x64';
const version = '1.0.77';
const exeSha256 = '0cea32ee0b320301683d7e6b0d2ef48f5e28d914461330a48b9c94af2e104e6e';
const integrities = {
  [parentName]: 'sha512-zNGi+PGXR/cxL3URtxEIHX91Lm06jOb28ra98FWEO9keIJOO83Pr67rpmLtwufp7A51NvMM4Nm0Kh77/9l9rQg==',
  [distribution]: 'sha512-suC0MKHxQ5fQt7bVpAqFl1pdUMS35AOZiecDi+dIUKhYhrB+3cjpyLXUeCnUyS+nqZNyMnHl2dZMZpYM+chKfw==',
};

export async function prepareWindowsGrokBinary(prefix, parent, lock) {
  if (parent.name !== parentName || parent.version !== version || parent.bin?.grok !== 'bin/grok'
    || parent.optionalDependencies?.[distribution] !== version) throw new Error('installed-package-identity-mismatch');
  for (const [name, integrity] of Object.entries(integrities)) {
    const record = lock.packages?.['node_modules/' + name];
    if (record?.version !== version || record.integrity !== integrity) throw new Error('client-lock-integrity-mismatch');
  }
  const root = path.join(await fs.realpath(prefix), 'node_modules', distribution);
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (metadata.name !== distribution || metadata.version !== version
    || metadata.os?.length !== 1 || metadata.os[0] !== 'win32' || metadata.cpu?.length !== 1 || metadata.cpu[0] !== 'x64') {
    throw new Error('installed-package-identity-mismatch');
  }
  const archive = path.join(root, 'bin', 'grok.exe.br');
  if (path.relative(archive, await fs.realpath(archive)) !== '') throw new Error('client-entry-outside-package');
  const stat = await fs.stat(archive);
  if (!stat.isFile() || stat.size !== 52_337_791) throw new Error('client-distribution-payload-mismatch');
  const image = await promisify(brotliDecompress)(await fs.readFile(archive), { maxOutputLength: 181_605_888 });
  if (createHash('sha256').update(image).digest('hex') !== exeSha256) throw new Error('client-distribution-payload-mismatch');
  // Keep the npm entry and its child environment. The bootstrap uses a private copy in each fresh GROK_HOME.
  const binary = path.join(prefix, 'grok-1.0.77.exe');
  await fs.writeFile(binary, image, { flag: 'wx' });
  return { binary, evidence: { package: distribution, version, integrity: integrities[distribution], exeSha256 } };
}
