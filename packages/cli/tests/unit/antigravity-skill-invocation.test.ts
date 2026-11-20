import { expect, it } from 'vitest';
import { skillInvocationWarning } from '../../src/utils/skill-invocation-warning.js';

const project = { pluginId: 'test/demo', target: 'antigravity', scope: 'project' } as const;
const manual = [{ feature: 'skill.invocation.manual', values: ['true'] },
  { feature: 'skill.visibility', values: ['visible'] }, { feature: 'skill.invocation.model', values: ['false'] }];

// Test Value Gate: a reader with no runtime evidence must not create a
// misleading warning, even next to a verified reader of the same Skill.
it('keeps missing Antigravity session evidence quiet only for Antigravity', () => {
  for (const scope of ['project', 'user'] as const) {
    expect(skillInvocationWarning('demo', manual, { ...project, scope }, undefined, undefined, [
      { product: 'cli', unsupported: [] }, { product: 'app', unsupported: [] },
    ])).toBeUndefined();
  }
  expect(skillInvocationWarning('demo', manual, { ...project, target: 'generic' })?.detail?.reasonCode).toBe('noBoundExecutor');
});

// Test Value Gate: contradicting model policy and known unsupported visibility
// retain each affected reader and control in a single nonblocking notice.
it('reports the actual evidence for each affected Antigravity reader', () => {
  const requirements = [{ feature: 'skill.visibility', values: ['hidden'] }, ...manual.filter(({ feature }) => feature !== 'skill.visibility')];
  const notice = skillInvocationWarning('demo', requirements, project, undefined, undefined, [
    { product: 'cli', unsupported: [{ feature: 'skill.visibility', values: ['hidden'] }] },
    { product: 'app', unsupported: [], observed: [{ feature: 'skill.invocation.model', values: ['true'] }] },
  ]);
  expect(notice).toMatchObject({ code: 'skillInvocationPolicyNotGuaranteed', severity: 'warning',
    subject: { ...project, field: 'skill.demo' }, detail: { reasonCode: 'invocationControlDegraded', skillInvocationControls: [
      { feature: 'skill.visibility', values: ['hidden'], reasonCode: 'invocationControlUnsupported', product: 'cli' },
      { feature: 'skill.invocation.model', values: ['false'], reasonCode: 'invocationControlDegraded', product: 'app' },
    ] } });
});
