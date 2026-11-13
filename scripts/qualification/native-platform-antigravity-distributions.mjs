import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { downloadInterfaceArchive, extractInterfaceArchive } from './native-platform-interface-probes.mjs';
import { sha256 } from './native-platform-runtime.mjs';

const release = 'https://github.com/google-antigravity/antigravity-cli/releases/download/1.3.4/';
const distribution = (asset, digest) => Object.freeze({ version: '1.3.4', url: `${release}${asset}`, sha256: digest,
  format: asset.endsWith('.zip') ? 'zip' : 'tar.gz', entry: asset.endsWith('.zip') ? 'antigravity.exe' : 'antigravity',
  digestSource: 'fixed GitHub release asset SHA-256',
  digestReference: 'https://api.github.com/repos/google-antigravity/antigravity-cli/releases/tags/1.3.4' });

export const antigravityDistributions = Object.freeze({
  'linux-x64': distribution('agy_cli_linux_x64.tar.gz', 'db5e81e8dee72d282cb1fb5fcd98dc5a43680730d71e3d637a67c874ec077ad3'),
  'linux-arm64': distribution('agy_cli_linux_arm64.tar.gz', '56161a1849eff501fead19bc7c477ee80f26776bf470fda01c119cc345a1818c'),
  'darwin-x64': distribution('agy_cli_mac_x64.tar.gz', 'f4e5bc649cbbdc903516f5918194ffc74dc78014806dda6a6c6403df5382b4a2'),
  'darwin-arm64': distribution('agy_cli_mac_arm64.tar.gz', 'ede28149c568c69f549b796a6142ba592b44294111acf8b79cdbffae74e72147'),
  'win32-x64': distribution('agy_cli_windows_x64.zip', '051a928f45ce91daae0029de904ba03d4eb64ef9c4909ac6c2feef6d3ad65886'),
  'win32-arm64': distribution('agy_cli_windows_arm64.zip', '3c43eeee99e5bc2f515a7c6c5a7652d05333cb30e0291b22ae9402b0eddcd995'),
});

export function getAntigravityDistribution(host = process) {
  const selected = antigravityDistributions[`${host.platform}-${host.arch}`];
  if (!selected) throw new Error('official-antigravity-distribution-unavailable');
  return selected;
}

const zipExtractionScript = String.raw`
import json, os, stat, sys, zipfile
root = sys.argv[2]
limit = 768 * 1024 * 1024
seen = set()
total = 0
written = 0
with zipfile.ZipFile(sys.argv[1]) as archive:
    members = archive.infolist()
    if len(members) > 20000:
        raise ValueError('archive-expanded-limit')
    for member in members:
        name = member.orig_filename
        parts = name.rstrip('/').split('/')
        if name.startswith('/') or '\\' in name or '\x00' in name or any(p in ('', '.', '..') or ':' in p or p.endswith((' ', '.')) for p in parts):
            raise ValueError('unsafe-archive-path')
        if any(p.split('.')[0].upper() in ('CON', 'PRN', 'AUX', 'NUL') or p.split('.')[0].upper() in [prefix + str(i) for prefix in ('COM', 'LPT') for i in range(1, 10)] for p in parts):
            raise ValueError('unsafe-archive-path')
        key = '/'.join(parts).casefold()
        kind = stat.S_IFMT(member.external_attr >> 16)
        directory = member.is_dir()
        if key in seen or member.flag_bits & 1 or member.external_attr & 0x400 or kind not in (0, stat.S_IFREG, stat.S_IFDIR) or directory != (kind == stat.S_IFDIR or name.endswith('/')):
            raise ValueError('unsupported-or-duplicate-archive-entry')
        if not directory and kind == stat.S_IFDIR or directory and member.file_size != 0:
            raise ValueError('unsupported-archive-entry')
        seen.add(key)
        total += member.file_size
        if total > limit:
            raise ValueError('archive-expanded-limit')
        destination = os.path.join(root, *parts)
        if directory:
            os.makedirs(destination, mode=0o700, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(destination), mode=0o700, exist_ok=True)
            copied = 0
            with archive.open(member) as source, open(destination, 'xb') as output:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    copied += len(chunk)
                    written += len(chunk)
                    if copied > member.file_size or written > limit:
                        raise ValueError('archive-expanded-limit')
                    output.write(chunk)
            if copied != member.file_size:
                raise ValueError('archive-size-mismatch')
            os.chmod(destination, 0o600 | ((member.external_attr >> 16) & 0o111))
print(json.dumps({'archiveEntries': len(members), 'expandedBytes': total}))
`;

export async function extractAntigravityArchive(file, destination, selected, env) {
  if (selected.format === 'tar.gz') return { ...await extractInterfaceArchive(file, destination, env), entryLimit: 20000 };
  if (selected.format !== 'zip') throw new Error('unsupported-antigravity-archive');
  await fs.mkdir(destination, { mode: 0o700 });
  try {
    const result = await promisify(execFile)(process.platform === 'win32' ? 'python' : '/usr/bin/python3',
      ['-c', zipExtractionScript, file, destination], { cwd: path.dirname(destination), env,
        timeout: 60_000, maxBuffer: 16 * 1024, encoding: 'utf8', killSignal: 'SIGKILL', windowsHide: true });
    return { ...JSON.parse(result.stdout), timeoutMs: 60_000, expandedByteLimit: 768 * 1024 * 1024, entryLimit: 20000,
      links: 'rejected', processManagement: 'bounded direct child; not client process-tree evidence' };
  } catch (cause) {
    throw Object.assign(new Error('archive-extraction-failed'), { extractionFailure: {
      exitCode: cause.code, signal: cause.signal, killed: cause.killed, stderr: cause.stderr,
      processManagement: 'bounded direct child; not client process-tree evidence',
    } });
  }
}

export async function acquireAntigravityDistribution(root, env, options = {}) {
  const selected = getAntigravityDistribution(options.host);
  const archive = path.join(root, selected.format === 'zip' ? 'antigravity.zip' : 'antigravity.tar.gz');
  const acquisition = await downloadInterfaceArchive(selected, archive, options.fetchImpl);
  const directory = path.join(root, 'distribution');
  const extraction = await extractAntigravityArchive(archive, directory, selected, env);
  const executable = path.join(directory, selected.entry);
  const stat = await fs.lstat(executable);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('antigravity-entry-unavailable');
  const entry = { path: executable, sha256: sha256(await fs.readFile(executable)) };
  return { acquisition, extraction, entry, launcher: { executable, prefix: [] } };
}
