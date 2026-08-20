import {
  setupTriggerWorkspace as setupBaseTriggerWorkspace,
  TRIGGER_WORKSPACE_FIXTURES,
} from '../../../../ask-me/scripts/trigger-fixture.mjs';
import { ensurePlanReviewFixture } from '../../../../ask-me/scripts/plan-review-fixture.mjs';

export { TRIGGER_WORKSPACE_FIXTURES };

export async function setupTriggerWorkspace(options) {
  await setupBaseTriggerWorkspace(options);
  await ensurePlanReviewFixture(options);
}
