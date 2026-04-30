import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function readAwContext() {
  const contextPath = process.env.AW_PLUGIN_CONTEXT;
  if (!contextPath) {
    throw new Error('AW_PLUGIN_CONTEXT is required for code-review lifecycle.');
  }
  return JSON.parse(await readFile(contextPath, 'utf8'));
}

const context = await readAwContext();
const stateDir = path.join(context.paths.awHome, 'code-review');
await mkdir(stateDir, { recursive: true });

const snapshot = {
  event: context.event,
  platform: context.platform,
  scope: context.scope,
  pluginRoot: context.plugin.rootDir,
  reviewMode: context.config.values.reviewMode ?? 'standard',
  maxFilesPerReview: context.config.values.maxFilesPerReview ?? 20,
  artifactCount: Array.isArray(context.artifacts) ? context.artifacts.length : 0,
};

const fileName = context.event === 'uninstall'
  ? 'last-uninstall.json'
  : 'last-install.json';
await writeFile(path.join(stateDir, fileName), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

console.log(`[${context.plugin.name}] ${context.event} lifecycle completed in ${snapshot.reviewMode} mode.`);
