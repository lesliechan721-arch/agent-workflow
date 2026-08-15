import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertPublishSkillTarget } from './publish-skill-review.js';
import {
  releasePublishedSkillReview,
  type SkillReportOwner,
} from './skill-reporting.js';

interface ParsedArgs {
  help?: boolean;
  plugin?: string;
  skill?: string;
  batchId?: string;
}

function usage(): string {
  return [
    'Usage: pnpm review:release -- --skill <name> [--plugin <name>] --batch-id <id>',
    '',
    'Updates the Skill README to point to an existing published full or release review.',
    'For plugin Skills, this changes the production source and requires a higher source manifest version.',
  ].join('\n');
}

function optionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--') continue;
    if (flag === '-h' || flag === '--help') {
      parsed.help = true;
      continue;
    }
    const value = optionValue(args, index, flag);
    index += 1;
    if (flag === '--plugin') parsed.plugin = value;
    else if (flag === '--skill') parsed.skill = value;
    else if (flag === '--batch-id') parsed.batchId = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (parsed.help) return parsed;
  if (!parsed.skill || !parsed.batchId) throw new Error(usage());
  return parsed;
}

function resolveRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const repoRoot = resolveRepoRoot();
  const owner: SkillReportOwner = parsed.plugin
    ? { kind: 'plugin-skill', plugin: parsed.plugin, skill: parsed.skill! }
    : { kind: 'static-skill', skill: parsed.skill! };
  await assertPublishSkillTarget(repoRoot, owner);
  const result = await releasePublishedSkillReview({
    repoRoot,
    owner,
    batchId: parsed.batchId!,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
