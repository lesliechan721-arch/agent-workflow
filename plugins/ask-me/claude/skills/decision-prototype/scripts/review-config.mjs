import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const AW_CONFIG_TIMEOUT_MS = 5_000;

export const MAX_REVIEW_TTL_MS = 14_400_000;

function validateTtlMs(ttlMs, source) {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_REVIEW_TTL_MS) {
    throw new Error(`${source} must be an integer from 1 to ${MAX_REVIEW_TTL_MS} milliseconds.`);
  }
  return ttlMs;
}

function validatePluginSelector(pluginSelector) {
  const parts = typeof pluginSelector === 'string' ? pluginSelector.split('/') : [];
  if (!(
    pluginSelector === 'ask-me'
    || (parts.length === 2 && parts[0].length > 0 && parts[1] === 'ask-me')
  )) {
    throw new Error('The AW plugin selector must identify ask-me.');
  }
}

function readConfiguredTtl(receipt, pluginSelector) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  if (receipt.ok !== true || receipt.command !== 'config:get') return null;
  if (receipt.configSchemaVersion !== 4 || receipt.scope !== 'effective') return null;
  if (receipt.plugin !== receipt.pluginName) return null;
  if (!['ask-me', pluginSelector].includes(receipt.plugin)) return null;
  if (receipt.key !== 'reviewSessionTtlMinutes') return null;
  if (typeof receipt.pluginId !== 'string' || !receipt.pluginId.endsWith('/ask-me')) return null;
  const sourceId = receipt.pluginId.slice(0, -'/ask-me'.length);
  if (!sourceId || receipt.sourceId !== sourceId) return null;
  if (pluginSelector.includes('/') && receipt.pluginId !== pluginSelector) return null;
  if (!Array.isArray(receipt.fields) || receipt.fields.length !== 1) return null;

  const field = receipt.fields[0];
  if (!field || typeof field !== 'object' || Array.isArray(field)) return null;
  if (field.key !== 'reviewSessionTtlMinutes' || field.valid !== true) return null;
  if (!Array.isArray(field.issues) || field.issues.length !== 0) return null;
  if (!['default', 'configured'].includes(field.valueState)) return null;
  if (!['default', 'user', 'project'].includes(field.sourceLayer)) return null;
  if (field.valueState === 'default' && field.sourceLayer !== 'default') return null;
  if (field.valueState === 'configured' && field.sourceLayer === 'default') return null;
  if (!Number.isInteger(field.effectiveValue)) return null;
  if (field.effectiveValue < 1 || field.effectiveValue > 240) return null;
  return field.effectiveValue * 60_000;
}

export async function resolveReviewTtl({
  prototypePath,
  ttlMs,
  pluginSelector = 'ask-me',
}) {
  if (ttlMs !== undefined) return validateTtlMs(ttlMs, '--ttl');
  validatePluginSelector(pluginSelector);

  let stdout;
  try {
    const physicalPrototypePath = await realpath(prototypePath);
    ({ stdout } = await execFileAsync(
      'aw',
      ['config', 'get', pluginSelector, 'reviewSessionTtlMinutes', '--json'],
      {
        cwd: path.dirname(physicalPrototypePath),
        encoding: 'utf8',
        timeout: AW_CONFIG_TIMEOUT_MS,
      },
    ));
  } catch {
    throw new Error('Cannot read the Ask Me Review TTL from AW config. Use --ttl to set it for this session.');
  }

  let receipt;
  try {
    receipt = JSON.parse(stdout);
  } catch {
    throw new Error('AW returned an invalid config receipt. Use --ttl to set the Review TTL for this session.');
  }

  const configuredTtl = readConfiguredTtl(receipt, pluginSelector);
  if (configuredTtl === null) {
    throw new Error('AW returned an invalid Ask Me Review TTL. Use --ttl to set it for this session.');
  }
  return validateTtlMs(configuredTtl, 'The configured Review TTL');
}
