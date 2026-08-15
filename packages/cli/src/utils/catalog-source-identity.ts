import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import { CATALOG_SOURCE_IDENTITY_VERSION } from '../constants.js';
import type { CatalogSource, SourceIdentity } from '../types.js';

const SCP_GIT_URL_PATTERN = /^([^@/:\s]+)@([^/:\s]+):(.+)$/;
const ALLOWED_GIT_URL_PROTOCOLS = new Set(['git:', 'http:', 'https:', 'ssh:']);

function normalizeGitPath(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, '');
  if (normalized === '' || normalized === '.') {
    throw new Error('Invalid catalog Git URL: expected a repository path.');
  }
  return normalized;
}

export function canonicalizeCatalogGitUrl(value: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
    throw new Error('Invalid catalog Git URL: expected a non-empty canonical URL.');
  }

  const scpMatch = SCP_GIT_URL_PATTERN.exec(value);
  if (scpMatch) {
    const [, username, hostname, pathname] = scpMatch;
    const hostUrl = new URL(`ssh://${hostname}/`);
    const pathKind = pathname.startsWith('/') ? 'absolute' : 'relative';
    return `scp-${pathKind}:${username}@${hostUrl.hostname.toLowerCase()}:${normalizeGitPath(pathname)}`;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid catalog Git URL: expected an absolute URL.');
  }
  if (!ALLOWED_GIT_URL_PROTOCOLS.has(url.protocol)) {
    throw new Error(`Invalid catalog Git URL protocol "${url.protocol}".`);
  }
  if (!url.hostname || url.password || (url.username && url.protocol !== 'ssh:')) {
    throw new Error('Invalid catalog Git URL: embedded credentials are not allowed.');
  }
  if (url.search || url.hash) {
    throw new Error('Invalid catalog Git URL: query strings and fragments are not allowed.');
  }

  const username = url.username ? `${url.username}@` : '';
  const port = url.port ? `:${url.port}` : '';
  return `${url.protocol}//${username}${url.hostname.toLowerCase()}${port}${normalizeGitPath(url.pathname)}`;
}

function normalizeIdentitySubdir(subdir: unknown): string | null {
  if (subdir === undefined) return null;
  if (typeof subdir !== 'string' || subdir.trim() === '' || subdir.includes('\\')) {
    throw new Error('Invalid catalog source subdir: expected a relative POSIX path.');
  }
  const normalized = path.posix.normalize(subdir);
  if (
    path.posix.isAbsolute(subdir)
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
  ) {
    throw new Error('Invalid catalog source subdir: path must stay inside the source.');
  }
  return normalized.replace(/^\.\//, '').replace(/\/$/, '');
}

async function realpathCatalogDirectory(value: string): Promise<string> {
  const location = await fs.realpath(value);
  const stat = await fs.stat(location);
  if (!stat.isDirectory()) {
    throw new Error('Invalid catalog path source: expected a directory.');
  }
  return location;
}

export async function canonicalizeCatalogPath(value: string, cwd: string): Promise<string> {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Invalid catalog path source: expected a non-empty path.');
  }
  if (typeof cwd !== 'string' || cwd.trim() === '' || !path.isAbsolute(cwd)) {
    throw new Error('Invalid catalog path source cwd: expected an absolute path.');
  }
  return realpathCatalogDirectory(path.resolve(cwd, value));
}

export async function calculateCatalogSourceIdentity(
  source: CatalogSource,
): Promise<SourceIdentity> {
  let location: string;
  if (source.type === 'git') {
    location = canonicalizeCatalogGitUrl(source.url);
  } else if (source.type === 'path') {
    if (!path.isAbsolute(source.path)) {
      throw new Error('Invalid catalog path source: expected a canonical absolute path.');
    }
    location = await realpathCatalogDirectory(source.path);
  } else {
    throw new Error('Invalid catalog source type: expected "git" or "path".');
  }

  const input = JSON.stringify({
    version: CATALOG_SOURCE_IDENTITY_VERSION,
    type: source.type,
    location,
    subdir: normalizeIdentitySubdir(source.type === 'git' ? source.subdir : undefined),
  });
  return `sha256:${crypto.createHash('sha256').update(input).digest('hex')}`;
}
