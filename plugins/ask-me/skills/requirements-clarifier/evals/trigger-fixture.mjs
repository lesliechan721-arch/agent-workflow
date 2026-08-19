import {
  setupTriggerWorkspace as setupBaseTriggerWorkspace,
  TRIGGER_WORKSPACE_FIXTURES,
} from '../../../scripts/trigger-fixture.mjs';
import { ensurePlanReviewFixture } from '../../../scripts/plan-review-fixture.mjs';

export { TRIGGER_WORKSPACE_FIXTURES };

export async function setupTriggerWorkspace(options) {
  await setupBaseTriggerWorkspace(options);
  await ensurePlanReviewFixture(options);
}
