import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('./render-artifacts.mjs', import.meta.url));

async function readFirstExisting(urls) {
  let lastError;
  for (const url of urls) {
    try {
      return await readFile(fileURLToPath(url), 'utf8');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function createContext(overrides = {}) {
  return {
    event: 'install',
    platform: 'codex',
    scope: 'user',
    plugin: {
      name: 'codex-explore',
      version: '0.1.0',
    },
    config: {
      mode: 'artifact-render',
      targetScope: 'user',
      values: {
        enableLightweightInstruction: true,
        explorerModel: 'gpt-5.4',
        modelReasoningEffort: 'high',
      },
    },
    ...overrides,
  };
}

async function runRenderer(context) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-explore-render-'));
  const contextPath = path.join(tempDir, 'context.json');

  try {
    await writeFile(contextPath, JSON.stringify(context, null, 2), 'utf8');
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        AW_PLUGIN_CONTEXT: contextPath,
      },
      cwd: path.dirname(scriptPath),
    });

    assert.equal(stderr, '');
    return JSON.parse(stdout);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function findArtifact(plan, id) {
  const artifact = plan.artifacts.find((entry) => entry.id === id);
  assert.ok(artifact, `Missing artifact ${id}`);
  return artifact;
}

async function testPresentInstructionAndRole() {
  const plan = await runRenderer(createContext());
  const instruction = findArtifact(plan, 'lightweight-instruction');
  const role = findArtifact(plan, 'codex-explorer-role');

  assert.equal(plan.version, 1);
  assert.equal(instruction.state, 'present');
  assert.deepEqual(instruction.refreshKeys, [
    'enableLightweightInstruction',
    'explorerModel',
    'modelReasoningEffort',
  ]);
  assert.match(instruction.content, /Codex 内置 `explorer` role/);
  assert.match(instruction.content, /`agent_type`: `explorer`/);
  assert.match(instruction.content, /`model`: `gpt-5\.4`/);
  assert.match(instruction.content, /`reasoning_effort`: `high`/);
  assert.match(instruction.content, /只读要求/);
  assert.match(instruction.content, /等待并读取它的结果/);
  assert.match(instruction.content, /立即关闭本次启动的 explorer/);
  assert.equal(instruction.content.includes('agent_type = "codex-explorer"'), false);
  assert.equal(instruction.content.includes('codex-explorer'), false);
  assert.equal(instruction.content.includes('aw install'), false);
  assert.equal(instruction.content.includes('aw config'), false);

  assert.equal(role.state, 'present');
  assert.equal(role.roleKey, 'codex-explorer');
  assert.deepEqual(role.refreshKeys, ['explorerModel', 'modelReasoningEffort']);
  assert.equal(role.content.registration.description, 'Read-only codebase exploration role for Codex Explore.');
  assert.equal('config_file' in role.content.registration, false);
  assert.equal(role.content.roleFile.name, 'codex-explorer');
  assert.equal(role.content.roleFile.model, 'gpt-5.4');
  assert.equal(role.content.roleFile.model_reasoning_effort, 'high');
  assert.match(role.content.roleFile.developer_instructions, /只读边界/);
  assert.match(role.content.roleFile.developer_instructions, /不要创建、编辑、移动、删除、格式化或回退文件/);
  assert.match(role.content.roleFile.developer_instructions, /固定使用下面结构/);
  assert.match(role.content.roleFile.developer_instructions, /结论/);
  assert.match(role.content.roleFile.developer_instructions, /证据/);
  assert.match(role.content.roleFile.developer_instructions, /不确定点/);
  assert.match(role.content.roleFile.developer_instructions, /建议主 agent 下一步查看/);
  assert.equal('config_file' in role.content.roleFile, false);
}

async function testDisabledInstructionStillKeepsRole() {
  const plan = await runRenderer(
    createContext({
      config: undefined,
      renderConfig: {
        values: {
          enableLightweightInstruction: false,
          explorerModel: 'gpt-5.4-mini',
          modelReasoningEffort: 'xhigh',
        },
      },
    }),
  );
  const instruction = findArtifact(plan, 'lightweight-instruction');
  const role = findArtifact(plan, 'codex-explorer-role');

  assert.equal(instruction.state, 'disabled');
  assert.equal(instruction.disabledReason, 'config');
  assert.deepEqual(instruction.refreshKeys, [
    'enableLightweightInstruction',
    'explorerModel',
    'modelReasoningEffort',
  ]);
  assert.equal(instruction.content, undefined);

  assert.equal(role.state, 'present');
  assert.equal(role.roleKey, 'codex-explorer');
  assert.deepEqual(role.refreshKeys, ['explorerModel', 'modelReasoningEffort']);
  assert.equal(role.content.roleFile.model, 'gpt-5.4-mini');
  assert.equal(role.content.roleFile.model_reasoning_effort, 'xhigh');
}

async function testDefaultsComeFromManifestSchema() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-explore-manifest-'));

  try {
    const contextPath = path.join(tempDir, 'context.json');
    await writeFile(
      contextPath,
      JSON.stringify(
        {
          event: 'refresh',
          platform: 'codex',
          scope: 'project',
          config: {
            mode: 'artifact-render',
            targetScope: 'project',
            values: {},
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const { stdout } = await execFileAsync(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        AW_PLUGIN_CONTEXT: contextPath,
      },
      cwd: path.dirname(scriptPath),
    });
    const plan = JSON.parse(stdout);
    const role = findArtifact(plan, 'codex-explorer-role');

    assert.equal(role.content.roleFile.model, 'gpt-5.4-mini');
    assert.equal(role.content.roleFile.model_reasoning_effort, 'medium');

    const manifestPath = fileURLToPath(new URL('../.agents-plugin/plugin.json', import.meta.url));
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.config.schema.explorerModel.default, 'gpt-5.4-mini');
    assert.equal(manifest.config.schema.modelReasoningEffort.default, 'medium');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testStaticSkillAndRoleContracts() {
  const manifestPath = fileURLToPath(new URL('../.agents-plugin/plugin.json', import.meta.url));
  const [skill, metadata, rolePrompt] = await Promise.all([
    readFirstExisting([
      new URL('../skills/codex-explore/SKILL.md', import.meta.url),
      new URL('../codex/skills/codex-explore/SKILL.md', import.meta.url),
    ]),
    readFirstExisting([
      new URL('../skills/codex-explore/agents/openai.yaml', import.meta.url),
      new URL('../codex/skills/codex-explore/agents/openai.yaml', import.meta.url),
    ]),
    readFirstExisting([
      new URL('../roles/codex-explorer.md', import.meta.url),
      new URL('../codex/roles/codex-explorer.md', import.meta.url),
    ]),
  ]);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  assert.match(skill, /agent_type` 设为 `"codex-explorer"`/);
  assert.match(skill, /探索深度：只能使用 `quick`、`medium`、`very thorough`/);
  assert.match(skill, /必须等待它进入最终状态并读取结果/);
  assert.match(skill, /`wait_agent` 只代表等待结果/);
  assert.match(skill, /`close_agent` 关闭本 workflow 启动的 explorer/);

  assert.match(metadata, /allow_implicit_invocation:\s*false/);
  assert.equal(manifest.skillTriggers?.['codex-explore']?.allowInstallOverride, true);
  assert.deepEqual(manifest.marketplace?.policy?.products, ['CODEX']);

  assert.match(rolePrompt, /只读边界/);
  assert.match(rolePrompt, /不要创建、编辑、移动、删除、格式化或回退文件/);
  assert.match(rolePrompt, /不要产出实现计划/);
  assert.match(rolePrompt, /固定使用下面结构/);
  assert.match(rolePrompt, /结论/);
  assert.match(rolePrompt, /证据/);
  assert.match(rolePrompt, /不确定点/);
  assert.match(rolePrompt, /建议主 agent 下一步查看/);
}

async function main() {
  await testPresentInstructionAndRole();
  await testDisabledInstructionStillKeepsRole();
  await testDefaultsComeFromManifestSchema();
  await testStaticSkillAndRoleContracts();
  console.log('render-artifacts tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
