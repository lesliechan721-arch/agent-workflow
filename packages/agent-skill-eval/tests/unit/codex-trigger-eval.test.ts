import { describe, expect, it } from 'vitest'

import {
  summarizeTriggerCase,
  type TriggerRunEvidence,
} from '../../src/index.js'
import type {
  AwSkillEvalTriggerCase,
  AwSkillEvalTriggerSuiteCaseContract,
} from '../../src/index.js'

function suite(
  overrides: Partial<AwSkillEvalTriggerSuiteCaseContract> = {},
): AwSkillEvalTriggerSuiteCaseContract {
  return {
    id: 'trigger',
    kind: 'trigger',
    skill: 'eval-fixture',
    skills: ['eval-fixture'],
    cases: 'trigger-cases.json',
    observeSpawnAgent: true,
    isolation: 'standard',
    strictNegativeSplits: [],
    forbidMultipleSkillLoads: false,
    profiles: ['project-default'],
    defaultRuns: 1,
    perRunTimeoutMs: 10_000,
    ...overrides,
  }
}

function runEvidence(overrides: Partial<TriggerRunEvidence>): TriggerRunEvidence {
  return {
    loaded: false,
    first_loaded_skill: null,
    all_loaded_skills: [],
    load_evidence_by_skill: {},
    spawned: false,
    load_evidence: null,
    spawn_evidence: null,
    spawn_calls: [],
    termination: 'completed',
    exit_code: 0,
    signal: null,
    execution_error: false,
    fixture_unchanged: true,
    request_user_input_called: false,
    waiting_on_user_input: false,
    final_response_emitted: false,
    final_message: null,
    duration_ms: 1,
    usage: null,
    event_trace: [],
    diagnostics: [],
    ...overrides,
  }
}

describe('Codex trigger provider grading', () => {
  it('preserves per-suite strict negative scoring', () => {
    const evalCase: AwSkillEvalTriggerCase = {
      id: 'negative',
      split: 'validation',
      query: 'Do not load it.',
      should_load_skill: false,
      should_spawn_agent: false,
    }
    const runs = [runEvidence({ loaded: true }), runEvidence({}), runEvidence({})]
    expect(summarizeTriggerCase(suite(), evalCase, runs).passed).toBe(true)
    expect(summarizeTriggerCase(
      suite({ strictNegativeSplits: ['validation'] }),
      evalCase,
      runs,
    ).passed).toBe(false)
  })

  it('applies strict negative scoring to an empty exact route', () => {
    const evalCase: AwSkillEvalTriggerCase = {
      id: 'negative_route',
      split: 'validation',
      query: 'Do not load a participant Skill.',
      expected_loaded_skills: [],
      should_spawn_agent: false,
    }
    const runs = [
      runEvidence({
        loaded: true,
        first_loaded_skill: 'eval-fixture',
        all_loaded_skills: ['eval-fixture'],
        load_evidence_by_skill: { 'eval-fixture': 'read fixture' },
      }),
      runEvidence({}),
      runEvidence({}),
    ]
    expect(summarizeTriggerCase(suite({ minimumPassRate: 0.5 }), evalCase, runs).passed)
      .toBe(true)
    expect(summarizeTriggerCase(
      suite({ minimumPassRate: 0.5, strictNegativeSplits: ['validation'] }),
      evalCase,
      runs,
    ).passed).toBe(false)
  })

  it('fails a strict no-spawn case after one delegation in three runs', () => {
    const evalCase: AwSkillEvalTriggerCase = {
      id: 'must_not_delegate',
      split: 'validation',
      query: 'Load the guide but do not delegate.',
      should_load_skill: true,
      should_spawn_agent: false,
    }
    const runs = [
      runEvidence({ loaded: true, spawned: true }),
      runEvidence({ loaded: true }),
      runEvidence({ loaded: true }),
    ]
    expect(summarizeTriggerCase(suite(), evalCase, runs).passed).toBe(true)
    expect(summarizeTriggerCase(
      suite({ strictNegativeSplits: ['validation'] }),
      evalCase,
      runs,
    ).passed).toBe(false)
  })

  it('rejects a route that also loads a sibling Skill', () => {
    const routingSuite = suite({
      skill: 'author-aw-catalog',
      skills: ['author-aw-catalog', 'review-aw-catalog'],
      observeSpawnAgent: false,
      minimumPassRate: 0.9,
      forbidMultipleSkillLoads: true,
    })
    const evalCase: AwSkillEvalTriggerCase = {
      id: 'catalog_review',
      split: 'validation',
      query: 'Review the Catalog inventory and dependency graph.',
      expected_loaded_skills: ['review-aw-catalog'],
    }
    const correct = runEvidence({
      first_loaded_skill: 'review-aw-catalog',
      all_loaded_skills: ['review-aw-catalog'],
      load_evidence_by_skill: { 'review-aw-catalog': 'read Catalog review Skill' },
    })
    const combined = runEvidence({
      loaded: true,
      first_loaded_skill: 'author-aw-catalog',
      all_loaded_skills: ['author-aw-catalog', 'review-aw-catalog'],
      load_evidence_by_skill: {
        'author-aw-catalog': 'read Catalog author Skill',
        'review-aw-catalog': 'read Catalog review Skill',
      },
    })
    expect(summarizeTriggerCase(
      routingSuite,
      evalCase,
      [...Array.from({ length: 9 }, () => correct), combined],
    )).toMatchObject({
      observed: { route_match_rate: 0.9, multiple_skill_loads: 1 },
      passed: false,
    })
  })

  it('accepts a declared downstream handoff after the expected first route', () => {
    const routingSuite = suite({
      skill: 'author-aw-catalog',
      skills: ['author-aw-catalog', 'author-aw-plugin'],
      observeSpawnAgent: false,
      minimumPassRate: 0.9,
      forbidMultipleSkillLoads: true,
    })
    const evalCase: AwSkillEvalTriggerCase = {
      id: 'catalog_author_then_plugin_author',
      split: 'validation',
      query: 'Add a Plugin to the Catalog, then edit its source.',
      expected_first_loaded_skill: 'author-aw-catalog',
    }
    const correct = runEvidence({
      loaded: true,
      first_loaded_skill: 'author-aw-catalog',
      all_loaded_skills: ['author-aw-catalog', 'author-aw-plugin'],
      load_evidence_by_skill: {
        'author-aw-catalog': 'read Catalog author Skill',
        'author-aw-plugin': 'read Plugin author Skill',
      },
    })
    const incorrect = runEvidence({
      loaded: true,
      first_loaded_skill: 'author-aw-plugin',
      all_loaded_skills: ['author-aw-plugin', 'author-aw-catalog'],
      load_evidence_by_skill: {
        'author-aw-plugin': 'read Plugin author Skill',
        'author-aw-catalog': 'read Catalog author Skill',
      },
    })
    expect(summarizeTriggerCase(
      routingSuite,
      evalCase,
      [...Array.from({ length: 9 }, () => correct), incorrect],
    )).toMatchObject({
      expected: { first_loaded_skill: 'author-aw-catalog' },
      observed: { first_route_match_rate: 0.9, multiple_skill_loads: 10 },
      passed: true,
    })
  })
})
