import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const CONFIG_KEYS = [
  'arenaRunners',
  'arenaCrossJudge',
  'reviewAdversaries',
];

const ALL_SKILLS = [
  'dev-workflow',
  'dev-design',
  'dev-investigate',
  'dev-debug',
  'dev-architect',
  'dev-arena',
  'dev-tdd',
  'dev-review',
  'dev-correct',
  'dev-verify',
  'dev-benchmark',
  'dev-verify-author',
];

const PLATFORMS = [
  'codex',
  'claude',
  'antigravity',
  'cursor',
  'opencode',
  'pi',
  'copilot',
  'grok',
  'generic',
];

const DESIGN_SHARED_SUPPORT_FILES = {
  'references/spec.md': 'shared/design/references/spec.md',
  'references/workspace.md': 'shared/design/references/workspace.md',
  'references/recovery.md': 'shared/design/references/recovery.md',
  'assets/shape-template.md': 'shared/design/assets/shape-template.md',
  'assets/spec-template.md': 'shared/design/assets/spec-template.md',
};

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function display(value) {
  return `\`${JSON.stringify(value)
    .replaceAll('|', '\\u007c')
    .replaceAll('`', '\\u0060')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')}\``;
}

function slot(template, marker, text) {
  const token = `<!-- ${marker} -->`;
  if (!template.includes(token)) {
    throw new Error(`Template is missing required slot: ${token}`);
  }
  return template.replace(token, () => text);
}

function stripLeadingHeading(markdown) {
  return markdown.replace(/^# [^\r\n]+\r?\n+/u, '').trimEnd();
}

function executionCells(profile, { platform, generic = false } = {}) {
  if (!isRecord(profile)) {
    throw new Error('Invalid execution profile object.');
  }
  const executor = Object.hasOwn(profile, 'executor') && profile.executor !== undefined ? profile.executor : 'native';
  if (generic && executor !== 'native') {
    return [
      `${display(executor)}（当前为 generic 产物，不支持 AW 托管外部执行器；未显式要求时回退宿主原生并说明）`,
      Object.hasOwn(profile, 'model') && profile.model !== undefined ? display(profile.model) : '—',
      Object.hasOwn(profile, 'reasoningEffort') && profile.reasoningEffort !== undefined ? display(profile.reasoningEffort) : '—',
    ];
  }
  const defaultModelLabel = executor === 'native' ? '宿主默认' : '后端默认（按需 inspect 选型）';
  const defaultEffortLabel = executor === 'native' && platform === 'antigravity'
    ? '—（由模型 ID 编码）'
    : defaultModelLabel;
  return [
    display(executor),
    Object.hasOwn(profile, 'model') && profile.model !== undefined ? display(profile.model) : defaultModelLabel,
    Object.hasOwn(profile, 'reasoningEffort') && profile.reasoningEffort !== undefined
      ? display(profile.reasoningEffort)
      : defaultEffortLabel,
  ];
}

function readOptionalConfig(context) {
  const sources = isRecord(context?.config?.sources) ? context.config.sources : {};
  const values = isRecord(context?.config?.values) ? context.config.values : {};
  const readProfile = (key) => {
    if (sources[key] === 'missing') return undefined;
    const value = values[key];
    if (value === undefined) return undefined;
    if (!isRecord(value)) {
      throw new Error(`Config field "${key}" must be an object.`);
    }
    return value;
  };
  const readArray = (key) => {
    if (sources[key] === 'missing') return [];
    const value = values[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      throw new Error(`Config field "${key}" must be an array.`);
    }
    return value;
  };
  return {
    arenaRunners: readArray('arenaRunners'),
    arenaCrossJudge: readProfile('arenaCrossJudge'),
    reviewAdversaries: readArray('reviewAdversaries'),
  };
}

function renderPanelTable(profiles, { emptyNative, emptyGeneric, labelPrefix, platform, generic }) {
  if (profiles.length === 0) {
    return generic ? emptyGeneric : emptyNative;
  }
  const lines = [
    '| 座次 | executor | model | reasoningEffort |',
    '| --- | --- | --- | --- |',
    ...profiles.map((profile, idx) =>
      `| ${labelPrefix}-${idx + 1} | ${executionCells(profile, { platform, generic }).join(' | ')} |`),
  ];
  if (!generic) {
    lines.push(
      '',
      '任务明确禁止外发材料时，将上表中的外部执行器改回宿主原生 `native`（若用户同时显式硬要求外部执行器，停止并报告冲突）。',
    );
  }
  return lines.join('\n');
}

function renderJudgeProfile(profile, { emptyNative, emptyGeneric, roleLabel, platform, generic }) {
  if (profile === undefined) {
    return generic ? emptyGeneric : emptyNative;
  }
  const lines = [
    '| 角色 | executor | model | reasoningEffort |',
    '| --- | --- | --- | --- |',
    `| ${roleLabel} | ${executionCells(profile, { platform, generic }).join(' | ')} |`,
  ];
  if (!generic) {
    lines.push(
      '',
      '任务明确禁止外发材料时，若上表为外部执行器则改回宿主原生 `native`（若用户同时显式硬要求外部执行器，停止并报告冲突）。',
    );
  }
  return lines.join('\n');
}

function readBundleResourceRoot(context, resourceName) {
  const resource = context.resources?.find(
    (entry) => entry.kind === 'bundle' && entry.name === resourceName,
  );
  if (!resource || !path.isAbsolute(resource.root)) {
    throw new Error(`Missing verified bundle resource: ${resourceName}`);
  }
  return resource.root;
}

async function collectBundleFiles(rootDir, bundlePrefix, relative = '', { skipAgents = false } = {}) {
  const currentDir = relative ? path.join(rootDir, relative) : rootDir;
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.DS_Store' || entry.name.endsWith('.test.mjs')) continue;
    if (!relative && (entry.name === 'evals' || entry.name === 'reports')) continue;
    if (skipAgents && !relative && entry.isDirectory() && entry.name === 'agents') continue;
    const relPath = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(files, await collectBundleFiles(rootDir, bundlePrefix, relPath, { skipAgents }));
    } else if (entry.isFile()) {
      files[relPath] = { source: { kind: 'bundle', path: `${bundlePrefix}/${relPath}` } };
    }
  }
  return files;
}

function validateContext(context) {
  if (context?.schemaVersion !== 3 || context.surface !== 'agent-plugin') {
    throw new Error('A PlatformRenderContext v3 with surface=agent-plugin is required.');
  }
  if (!PLATFORMS.includes(context.platform)) {
    throw new Error(`Unsupported platform: ${context.platform}`);
  }
  if (
    !Array.isArray(context.allowedOutputKinds)
    || new Set(context.allowedOutputKinds).size !== context.allowedOutputKinds.length
    || context.allowedOutputKinds.some(
      (kind) => !['skill', 'mcp', 'agent', 'hook', 'instruction'].includes(kind),
    )
  ) {
    throw new Error('allowedOutputKinds must contain distinct component kinds.');
  }
  const caps = context.platformCapabilities;
  if (caps?.schemaVersion !== 3 || caps.platform !== context.platform || caps.scope !== context.scope) {
    throw new Error('Matching platformCapabilities v3 are required.');
  }
}

export async function readArtifactRenderContext() {
  if (!process.env.AW_PLUGIN_CONTEXT) {
    throw new Error('AW_PLUGIN_CONTEXT is required.');
  }
  return JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
}

export async function renderArtifactPlan(context) {
  validateContext(context);
  const plan = { version: 3, components: [], omitted: [], unmet: [] };
  const isGeneric = context.platform === 'generic';
  const sharedRoot = readBundleResourceRoot(context, './shared');

  if (context.allowedOutputKinds.includes('skill')) {
    const coreDiscipline = (await readFile(path.join(sharedRoot, 'core-discipline.md'), 'utf8')).trimEnd();
    const designPlaybookRaw = await readFile(path.join(sharedRoot, 'design/playbooks/design.md'), 'utf8');
    const designPlaybookBody = stripLeadingHeading(designPlaybookRaw);
    const { arenaRunners, arenaCrossJudge, reviewAdversaries } = readOptionalConfig(context);

    const sharedDesignSupport = Object.fromEntries(
      Object.entries(DESIGN_SHARED_SUPPORT_FILES).map(([target, bundlePath]) => [
        target,
        { source: { kind: 'bundle', path: bundlePath } },
      ]),
    );
    const sharedPrinciples = Object.fromEntries(
      Object.entries(
        await collectBundleFiles(path.join(sharedRoot, 'principles'), 'shared/principles'),
      ).map(([relPath, entry]) => [`principles/${relPath}`, entry]),
    );
    if (Object.keys(sharedPrinciples).length === 0) {
      throw new Error('Expected principle files under shared/principles.');
    }

    for (const skillName of ALL_SKILLS) {
      const skillRoot = readBundleResourceRoot(context, `./skills/${skillName}`);
      const files = await collectBundleFiles(skillRoot, `skills/${skillName}`, '', { skipAgents: isGeneric });

      if (skillName === 'dev-workflow') {
        const raw = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
        files['SKILL.md'] = { text: slot(raw, 'core-discipline', coreDiscipline) };
        files['playbooks/design.md'] = {
          source: { kind: 'bundle', path: 'shared/design/playbooks/design.md' },
        };
        Object.assign(files, sharedDesignSupport, sharedPrinciples);
      } else if (skillName === 'dev-design') {
        const raw = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
        const rendered = slot(
          slot(raw, 'core-discipline', coreDiscipline),
          'design-playbook',
          designPlaybookBody,
        );
        files['SKILL.md'] = { text: rendered };
        Object.assign(files, sharedDesignSupport, sharedPrinciples);
      } else if (skillName === 'dev-arena') {
        const raw = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
        const arenaCompatibility = isGeneric
          ? '通用 Agent Skills 产物，依赖可用的 spawn-subagent；不依赖 AW 托管外部执行器配置。'
          : 'AW 支持的宿主，依赖可用的 spawn-subagent；可选平台多候选与独立裁判面板覆盖由本插件及 agent-subagent 配置决定。';
        const runnersText = renderPanelTable(arenaRunners, {
          emptyNative: '当前无固定多候选座次：通过 `spawn-subagent` 并行派发 2–3 名隔离候选——若任务未禁止外发且存在可用异构外部执行器或宿主原生多家族模型，优先组合不同厂商/模型家族以取得视角多样性（可回退软偏好，按 `complex`/`advanced` 难度）；无可用异构能力时回退同源隔离运行并在综合说明中如实披露；任务明确禁止外发时一律限定宿主原生 `native`。',
          emptyGeneric: '当前为 `generic` 产物且无固定候选座次：通过 `spawn-subagent` 选用 `complex`/`advanced` 档位并行派发 2–3 名隔离候选，并在综合说明中如实说明实际模型覆盖。',
          labelPrefix: 'candidate',
          platform: context.platform,
          generic: isGeneric,
        });
        const judgeText = renderJudgeProfile(arenaCrossJudge, {
          emptyNative: '当前无固定独立裁判座次：默认通过 `spawn-subagent` 启动 1 名干净上下文中性只读独立裁判（不跳过独立裁判）——若任务未禁止外发且存在可用异构外部执行器或宿主原生不同模型家族，优先选用异构模型（可回退软偏好，按 `advanced`/`complex` 难度）；无可用异构能力时回退同源 `advanced`/`complex` 档并在综合说明中如实披露是否具备跨模型多样性；任务明确禁止外发时限定宿主原生 `native`。仅当当前环境无法委派子代理时，才由主代理严格按评分标准裁决并披露限制。',
          emptyGeneric: '当前为 `generic` 产物且无固定独立裁判座次：默认通过 `spawn-subagent` 启动 1 名干净上下文中性只读独立裁判（选用 `advanced`/`complex` 档，不跳过独立裁判）；仅当当前宿主不支持子代理委派时，才由主代理严格按评分标准裁决并披露限制。',
          roleLabel: 'cross-judge',
          platform: context.platform,
          generic: isGeneric,
        });
        files['SKILL.md'] = {
          text: slot(
            slot(slot(raw, 'compatibility', arenaCompatibility), 'arena-runners', runnersText),
            'arena-cross-judge',
            judgeText,
          ),
        };
      } else if (skillName === 'dev-review') {
        const skillRaw = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
        const reviewCompatibility = isGeneric
          ? '通用 Agent Skills 产物；独立视角审查与对抗实测破防依赖可用的 spawn-subagent，不依赖 AW 托管外部执行器配置。'
          : 'AW 支持的宿主；独立视角审查与对抗实测破防依赖可用的 spawn-subagent，可选平台对抗面板覆盖由本插件及 agent-subagent 配置决定。';
        files['SKILL.md'] = {
          text: slot(skillRaw, 'compatibility', reviewCompatibility),
        };
        const refPath = 'references/adversarial-interrogate.md';
        const raw = await readFile(path.join(skillRoot, refPath), 'utf8');
        const adversariesText = renderPanelTable(reviewAdversaries, {
          emptyNative: '当前无固定对抗座次：默认通过 `spawn-subagent` 并行派发 2 名隔离对抗者——若任务未禁止外发且存在可用异构外部执行器或宿主原生多家族模型，优先组合不同厂商/模型家族（可回退软偏好，按 `complex`/`advanced` 难度）；无可用异构能力时回退同源隔离运行并在输出中如实披露；任务明确禁止外发时一律限定宿主原生 `native`。',
          emptyGeneric: '当前为 `generic` 产物且无固定对抗座次：默认通过 `spawn-subagent` 并行派发 2 名隔离对抗者（选用 `complex`/`advanced` 档），并在输出中如实披露实际模型覆盖。',
          labelPrefix: 'adversary',
          platform: context.platform,
          generic: isGeneric,
        });
        files[refPath] = { text: slot(raw, 'review-adversaries', adversariesText) };
      } else if (skillName === 'dev-verify' || skillName === 'dev-verify-author') {
        files['references/formal-check.md'] = {
          source: { kind: 'bundle', path: 'shared/formal-check.md' },
        };
      }

      plan.components.push({
        id: `skill-${skillName}`,
        kind: 'skill',
        name: skillName,
        content: { files },
      });
    }
  }

  return plan;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  renderArtifactPlan(await readArtifactRenderContext())
    .then((plan) => {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
