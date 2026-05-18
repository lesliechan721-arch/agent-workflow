import YAML from 'yaml';

import type { CodexSkillArtifact, SkillTriggerPolicy, SkillTriggerPreference } from '../types.js';
import { createGeneratedArtifactContentDigest } from './generated-artifacts.js';

const SKILL_FILE_PATH = 'SKILL.md';
const OPENAI_YAML_PATH = 'agents/openai.yaml';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeYamlError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CodexSkillStagingTree {
  skillKey: string;
  files: Record<string, string>;
}

function resolveEffectiveTriggerPreference(
  policy: SkillTriggerPolicy | undefined,
  preference: SkillTriggerPreference,
): Exclude<SkillTriggerPreference, 'default'> {
  const defaultTrigger = policy?.defaultTrigger ?? 'auto';
  if (preference === 'default' || policy?.allowDynamicTrigger === false) {
    return defaultTrigger;
  }
  return preference;
}

export function resolveDynamicCodexSkillAllowImplicitInvocation(options: {
  policy?: SkillTriggerPolicy;
  preference: SkillTriggerPreference;
}): boolean {
  return resolveEffectiveTriggerPreference(options.policy, options.preference) === 'auto';
}

export function renderCodexOpenAiYamlWithAllowImplicitInvocation(options: {
  rawContent: string;
  allowImplicitInvocation: boolean;
}): string {
  let parsed: unknown;
  try {
    parsed = YAML.parse(options.rawContent);
  } catch (error) {
    throw new Error(`openai.yaml YAML 解析失败：${normalizeYamlError(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('openai.yaml 根节点必须是 object。');
  }

  if (parsed.policy === undefined) {
    parsed.policy = {};
  } else if (!isRecord(parsed.policy)) {
    throw new Error('openai.yaml 的 policy 必须是 object。');
  }

  const policy = parsed.policy;
  if (!isRecord(policy)) {
    throw new Error('openai.yaml 的 policy 必须是 object。');
  }

  policy.allow_implicit_invocation = options.allowImplicitInvocation;
  return YAML.stringify(parsed);
}

export function createCodexSkillStagingTree(options: {
  skillKey: string;
  content: {
    skillFile: string;
    openaiYaml: string;
  };
  preference: SkillTriggerPreference;
  policy?: SkillTriggerPolicy;
}): CodexSkillStagingTree {
  return {
    skillKey: options.skillKey,
    files: {
      [SKILL_FILE_PATH]: options.content.skillFile,
      [OPENAI_YAML_PATH]: renderCodexOpenAiYamlWithAllowImplicitInvocation({
        rawContent: options.content.openaiYaml,
        allowImplicitInvocation: resolveDynamicCodexSkillAllowImplicitInvocation({
          policy: options.policy,
          preference: options.preference,
        }),
      }),
    },
  };
}

export function createCodexSkillExpectedTree(options: {
  artifact: Pick<CodexSkillArtifact, 'skillKey' | 'state' | 'content'>;
  preference: SkillTriggerPreference;
  policy?: SkillTriggerPolicy;
}): CodexSkillStagingTree {
  const skillKey = options.artifact.skillKey?.trim();
  if (!skillKey) {
    throw new Error('codex.skill expected tree 缺少 skillKey。');
  }

  if (options.artifact.state !== 'present') {
    return {
      skillKey,
      files: {},
    };
  }

  const skillFile = options.artifact.content?.skillFile;
  const openaiYaml = options.artifact.content?.openaiYaml;
  if (!skillFile?.trim()) {
    throw new Error(`codex.skill "${skillKey}" 缺少 SKILL.md 内容。`);
  }
  if (!openaiYaml?.trim()) {
    throw new Error(`codex.skill "${skillKey}" 缺少 agents/openai.yaml 内容。`);
  }

  return createCodexSkillStagingTree({
    skillKey,
    content: {
      skillFile,
      openaiYaml,
    },
    preference: options.preference,
    policy: options.policy,
  });
}

export function createCodexSkillStagingTreeContentDigest(
  tree: CodexSkillStagingTree,
): string {
  return createGeneratedArtifactContentDigest(tree.files);
}
