import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PLAN_REVIEW_CASE_IDS = new Set([
  'n03_one_shot_plan_review',
  'plan_review',
  'direct_plan_review',
]);

const MIGRATION_PLAN = [
  '# Session expiry migration plan',
  '',
  '## Goal',
  '',
  'Introduce a 30-day expiry for new sessions without invalidating existing sessions.',
  '',
  '## Plan',
  '',
  '1. Add a nullable `expires_at` column.',
  '2. Deploy reads that accept NULL and writes that set the expiry.',
  '3. Verify old and new sessions before removing the rollout flag.',
  '',
  '## Rollback',
  '',
  'Restore the previous write path and keep the nullable column.',
  '',
  '## Known risks',
  '',
  '- Clock skew can produce inconsistent expiry checks.',
  '- The monitoring plan does not yet define an alert threshold for rejected sessions.',
  '',
].join('\n');

export async function ensurePlanReviewFixture({ workspaceRoot, evalCase }) {
  if (!PLAN_REVIEW_CASE_IDS.has(evalCase?.id)) {
    return;
  }
  const target = path.join(workspaceRoot, 'docs', 'migration-plan.md');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, MIGRATION_PLAN, 'utf8');
}
