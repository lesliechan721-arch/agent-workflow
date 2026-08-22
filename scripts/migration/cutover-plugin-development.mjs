#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyPluginDevelopmentMigration } from './verify-plugin-development-migration.mjs';

const LEGACY_AUTHOR_ROUTE = '- 创建或维护 `plugins/<name>/` 时，使用 [create-aw-plugin](.agents/skills/create-aw-plugin/SKILL.md)。修改 manifest/schema、adapter、scope、插件分发/安装流程或作者合同工具时，读取[插件维护指南](docs/plugin-maintenance.md)和相关架构说明。';
const LEGACY_REVIEW_ROUTE = '- 只读评审静态 Skill 或插件 Skill 时，使用 [skill-review](.agents/skills/skill-review/SKILL.md)。';
const REPLACEMENT_AUTHOR_ROUTE = '- 创建或维护 `plugins/<name>/` 时，使用 [author-aw-plugin](plugins/aw-plugin-development/skills/author-aw-plugin/SKILL.md)。修改 manifest/schema、adapter、scope、插件分发/安装流程或作者合同工具时，读取[插件维护指南](docs/plugin-maintenance.md)和相关架构说明。';
const REPLACEMENT_REVIEW_ROUTE = '- 只读评审 AW 插件时，使用 [review-aw-plugin](plugins/aw-plugin-development/skills/review-aw-plugin/SKILL.md)；评审非 AW 的 portable Skill 时，使用 [review-agent-skill](plugins/agent-skill-toolkit/skills/review-agent-skill/SKILL.md)；评审 repo-local `.agents/skills` 时，继续使用 [skill-review](.agents/skills/skill-review/SKILL.md)。';

function parseArgs(args) {
  const options = { root: process.cwd(), apply: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root') options.root = path.resolve(args[++index] ?? '');
    else if (args[index] === '--apply') options.apply = true;
    else throw new Error(`unknown argument: ${args[index]}`);
  }
  return options;
}

async function replaceFileAtomically(filePath, content) {
  const temporary = `${filePath}.cutover-${randomUUID()}.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, filePath);
}

export async function cutoverPluginDevelopment(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const before = await verifyPluginDevelopmentMigration({ root });
  if (!before.ok || before.status !== 'ready-for-cutover' || !before.cutoverReady) {
    throw new Error('plugin development migration is not verified as ready-for-cutover');
  }
  if (options.apply !== true) {
    return {
      schemaVersion: 1,
      applied: false,
      status: before.status,
      changes: ['activate replacement author/review routes', 'set migration status to retired'],
    };
  }

  const agentsPath = path.join(root, 'AGENTS.md');
  const contractPath = path.join(root, 'docs/plugin-development-migration.json');
  const [agentsBefore, contractBefore] = await Promise.all([
    readFile(agentsPath, 'utf8'),
    readFile(contractPath, 'utf8'),
  ]);
  if (
    !agentsBefore.includes(LEGACY_AUTHOR_ROUTE)
    || !agentsBefore.includes(LEGACY_REVIEW_ROUTE)
  ) {
    throw new Error('AGENTS.md does not contain the exact verified legacy routes');
  }
  const agentsAfter = agentsBefore
    .replace(LEGACY_AUTHOR_ROUTE, REPLACEMENT_AUTHOR_ROUTE)
    .replace(LEGACY_REVIEW_ROUTE, REPLACEMENT_REVIEW_ROUTE);
  const contract = JSON.parse(contractBefore);
  contract.status = 'retired';
  const contractAfter = `${JSON.stringify(contract, null, 2)}\n`;

  try {
    await replaceFileAtomically(agentsPath, agentsAfter);
    await replaceFileAtomically(contractPath, contractAfter);
    const after = await verifyPluginDevelopmentMigration({ root });
    if (!after.ok || after.status !== 'retired') {
      throw new Error(`post-cutover verification failed: ${after.errors.join('; ')}`);
    }
  } catch (error) {
    await replaceFileAtomically(agentsPath, agentsBefore);
    await replaceFileAtomically(contractPath, contractBefore);
    throw error;
  }
  return { schemaVersion: 1, applied: true, status: 'retired', changes: [] };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.stdout.write(`${JSON.stringify(await cutoverPluginDevelopment(
      parseArgs(process.argv.slice(2)),
    ))}\n`);
  } catch (error) {
    process.stderr.write(`[ERROR] ${error.message}\n`);
    process.exitCode = 1;
  }
}
