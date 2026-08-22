---
name: author-aw-plugin
description: >-
  当用户要创建或维护一个 AW 插件根、Skill、extension、MCP/App、slash command、dynamic artifact、稳定版本或构建验证时使用。目标根由 `.agents-plugin/plugin.json` 标识，可以位于任意兼容工作区；拥有插件源码写入和作者验证，不做独立质量评分或发布裁决。
compatibility: 需要 Node.js 22+、提供所需 aw plugin 作者命令的已安装 aw CLI、目标工作区依赖、agent-content-toolkit >= 0.1.0 和 agent-skill-toolkit >= 0.1.0。真实模型 Eval 还需要 agent-skill-eval-runner >= 0.1.0 或其它兼容 runner。
user-invocable: true
metadata:
  short-description: 创建或维护 AW 插件并组合通用 Skill 作者能力
---

# Author AW Plugin

本 Skill 只负责 AW manifest、源码、README、构建、开发状态和 materialization；通用 Skill/Eval 标准由下层 toolkit 提供。稳定 release target 由目标工作区的统一 release workflow 拥有。

## 依赖 Gate

需要时检查 `author-agent-skill`、`design-agent-skill-evals`、`audit-agent-skill-evals`。真实模型 Eval 还需要显式 runner。缺失通用能力时停止，不复制简化标准；缺少 runner 时只交付结构和 Oracle 证据。

调用任何作者命令前，先运行 `aw --version`，再运行所选命令的 `aw plugin <command> --help`。只有 help 明确包含本分支需要的 flags 时才执行。缺少 capability 时停止并报告缺失命令或 flag；不得使用 `npx`，不得猜测仓库路径，也不得回退到本 Skill 的本地工具副本。

## 工作流

1. 明确 `<plugin-root>` 与 `<workspace-root>`，读取 manifest、现有源码、工作区规则和允许修改文件，然后选择最小作者路径：

   - **轻量 delta**：插件已存在，修改集中在一个已知组件和少量已知路径，不改变 manifest capability、支持 profile、Skill description/invocation、权限、build/materialization、lifecycle 或跨上下文 handoff，也不新增/删除组件或修改脚本/schema。只在运行 trace 与最终回复中记录意图、允许路径、可观察成功标准和实际验证；不要生成 `AWAuthoringContext`。
   - **结构化路径**：新建插件、增加/删除组件、一次请求包含多个组件、改变 manifest/profile/invocation/权限/build/materialization/lifecycle，或需要跨上下文交接。把全部组件请求写成 JSON 数组，再运行 `node scripts/prepare-aw-authoring-context.mjs <plugin-root> --repo-root <workspace-root> --components <json-file> [options]`。每个组件声明唯一 `id`、`type`、`operation`、`paths` 和 `profiles`；Skill 还必须声明 `skillInvocation`。

2. 按实际变更面读取 reference：

| 变更面 | reference |
| --- | --- |
| manifest 字段、路径、版本或兼容性 | `references/plugin-manifest-spec.md` |
| Skill | `references/aw-skill-integration.md`；客户端字段直接读 `references/skill-frontmatter-capabilities.generated.md` |
| Extension/hooks/permissions/agents | `references/extensions-spec.md` |
| Slash command | `references/slash-commands.md` |
| MCP/App | `references/mcp-and-apps.md` |
| Claude-only | `references/claude-only-capabilities.md` |
| Node/build | `references/build-config-spec.md` 与 `references/aw-script-testing.md` |
| config/helper | `references/aw-config-and-helper.md` |
| dynamic artifact | `references/aw-artifact-renderer.md` |
| lifecycle | `references/aw-lifecycle.md` |
| 用户可观察变化 | `references/aw-readme-authoring.md` |

结构化路径按 `components[]` 中的全部类型读取需要的 branch。轻量 delta 只读取实际修改面需要的 reference，不为可重算的插件事实扩展上下文。

3. 按确定性脚手架分支执行：

| 分支 | capability check | 确定性命令 | 后续作者工作 |
| --- | --- | --- | --- |
| 新建插件根 | `aw --version`；`aw plugin init --help` | `aw plugin init <plugin-name> --description <plugin-description> --skill-description <discovery-description> --skill-invocation <mode> --repo-root <workspace-root> --plugin-root <plugin-root>`；需要 config API 时加 `--with-config-api` | 命令只创建 manifest 和初始 Skill 骨架；fresh context 运行 `author-agent-skill` 编写真实内容 |
| 现有插件新增静态 Skill | `aw --version`；`aw plugin add-skill --help` | `aw plugin add-skill <plugin-name> --skill-name <skill-name> --skill-description <discovery-description> --skill-invocation <mode> --repo-root <workspace-root> --plugin-root <plugin-root>` | 命令只增加骨架和必要 manifest capability；fresh context 运行 `author-agent-skill` 编写真实内容；开发时不改 version |
| 任意源码修改后的作者验证 | `aw --version`；`aw plugin validate --help` | `aw plugin validate <plugin-root>`，按目标工作区规则增加 help 中存在的严格或 profile flags | 修复确定性错误并重跑；不把 validator 当作独立质量评分 |
| production bundle 的开发状态 | `aw --version`；`aw plugin status --help` | 单插件运行 `aw plugin status <plugin-name> --repo-root <workspace-root> --plugin-root <plugin-root> --base <git-ref>`；只有仓库标准 `plugins/` 布局的全量检查使用 `--all` | production 变化且目标未变时允许 `unreleasedChanges`；release train 开始时才设置稳定目标 |

4. 新建或重大变更 Skill：fresh context 运行 `author-agent-skill` 的完整设计路径。现有 Skill 的轻量 delta：把明确意图、允许路径和验收证据交给 `author-agent-skill(change)`，不创建完整 SkillDesignBrief 或跨上下文 handoff。需要 Eval 时，fresh context 运行 `design-agent-skill-evals`，再用另一个 fresh context 运行 `audit-agent-skill-evals(preflight)`。AW adapter 拥有组合流程，`evalStageOwner=caller`。
5. 写入插件 source truth；不手改 generated runtime、catalog 或 cache。README 由本 Skill按 `aw-readme-authoring.md` 维护。
6. 日常开发不直接提高 manifest 稳定版本；从目标工作区发现 build、test 和 materialization 命令，运行 `aw plugin validate`、适用的 `aw plugin status` 和直接测试。release 请求只声明目标由 workspace release workflow 设置；只有目标工作区实际提供 `release:status`、`release:target`、`release:prepare` 和 `release:publish` 时才使用这些正常入口，不指示作者手改每次开发版本，也不把历史 recovery 当作普通发布。
7. Eval preflight 通过且用户授权、runner 可用时，生成 `EvalExecutionPlan` 交给 `run-agent-skill-evals`；运行后由独立 `audit-agent-skill-evals(result-triage)` 归因。缺少 runner 时 `evalEvidenceLevel=structural`，不实现备用 runner。
8. 交付源码修改、采用的作者路径、验证、materialized artifacts、必要的 Eval audit/evidence 和未完成项。只有结构化路径才交付 `AWAuthoringContext`；轻量 delta 只交付简洁意图与验证记录。不输出独立 Review score、P0/P1 或 release pass。
