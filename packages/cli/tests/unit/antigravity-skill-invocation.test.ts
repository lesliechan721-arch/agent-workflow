import { expect, it } from 'vitest';
import { getComponentFeatureRequirements, type PluginComponent } from '@lesliechan721/aw-plugin-core/manifest';
import { skillInvocationWarning } from '../../src/utils/skill-invocation-warning.js';

import { getAuthoringPlatformCapabilities } from '../../src/review/platform-profile.js';

const project = { pluginId: 'test/demo', target: 'antigravity', scope: 'project' } as const;
const manual = [{ feature: 'skill.invocation.manual', values: ['true'] },
  { feature: 'skill.visibility', values: ['visible'] }, { feature: 'skill.invocation.model', values: ['false'] }];

// Test Value Gate: a reader with no runtime evidence must not create a
// misleading warning, even next to a verified reader of the same Skill.
it('keeps missing Antigravity session evidence quiet only for Antigravity', () => {
  for (const scope of ['project', 'user'] as const) {
    expect(skillInvocationWarning('demo', manual, { ...project, scope }, getAuthoringPlatformCapabilities('antigravity', scope), [
      { product: 'cli' }, { product: 'app' },
    ])).toBeUndefined();
  }
  expect(skillInvocationWarning('demo', manual, { ...project, target: 'generic' })?.detail?.reasonCode).toBe('noBoundExecutor');
});

it.each(['project', 'user'] as const)('reports both unsupported controls from hidden Skill frontmatter in Antigravity %s', (scope) => {
  const skill: PluginComponent = { id: 'skill:scope-hidden', kind: 'skill', name: 'scope-hidden', content: { files: {
    'SKILL.md': { text: '---\nname: scope-hidden\ndescription: Hidden Skill.\nuser-invocable: false\n---\nLocal fixture.\n' },
  } } };
  const requirements = getComponentFeatureRequirements(skill);
  const notice = skillInvocationWarning(skill.name, requirements, { ...project, scope },
    getAuthoringPlatformCapabilities('antigravity', scope), [{ product: 'cli' }]);
  expect(notice).toMatchObject({ code: 'skillInvocationPolicyNotGuaranteed', severity: 'warning',
    subject: { ...project, scope, field: 'skill.scope-hidden' }, detail: { reasonCode: 'invocationControlUnsupported',
      skillInvocationControls: [
        { feature: 'skill.invocation.manual', values: ['false'], reasonCode: 'invocationControlUnsupported', product: 'cli' },
        { feature: 'skill.visibility', values: ['hidden'], reasonCode: 'invocationControlUnsupported', product: 'cli' },
      ] } });
});

// Test Value Gate: contradicting model policy and known unsupported visibility
// retain each affected reader and control in a single nonblocking notice.
it('reports the actual evidence for each affected Antigravity reader', () => {
  const requirements = [{ feature: 'skill.visibility', values: ['hidden'] }, ...manual.filter(({ feature }) => feature !== 'skill.visibility')];
  const notice = skillInvocationWarning('demo', requirements, project, getAuthoringPlatformCapabilities('antigravity', 'project'), [
    { product: 'cli' },
    { product: 'app', observed: [{ feature: 'skill.visibility', values: ['visible'] }, { feature: 'skill.invocation.model', values: ['true'] }] },
  ]);
  expect(notice).toMatchObject({ code: 'skillInvocationPolicyNotGuaranteed', severity: 'warning',
    subject: { ...project, field: 'skill.demo' }, detail: { reasonCode: 'invocationControlDegraded', skillInvocationControls: [
      { feature: 'skill.visibility', values: ['hidden'], reasonCode: 'invocationControlUnsupported', product: 'cli' },
      { feature: 'skill.visibility', values: ['hidden'], reasonCode: 'invocationControlDegraded', product: 'app' },
      { feature: 'skill.invocation.model', values: ['false'], reasonCode: 'invocationControlDegraded', product: 'app' },
    ] } });
});
