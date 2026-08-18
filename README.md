# Agent Workflows

面向 **Codex** 和 **Claude Code** 的轻量、可组合 Agent 插件集合。

Agent Workflows 不试图把一种完整开发方法强加给所有任务。它把需求澄清、Git 操作、证据探索、Skill 编写和插件维护拆成独立能力：用户可以显式启动宏流程，模型也可以在任务中按需调用小型 Skill。

项目同时提供 `@lesliechan721/aw` CLI，用于发现、安装、升级、配置和移除插件。

## 设计思想

- **Skill 保持薄而完整**：只补充模型容易缺失的判断、项目约定和高价值边界。
- **能力可以组合**：每个 Skill 负责一个连贯任务，不要求安装一套强制 SDLC。
- **用户控制宏流程**：会改变工作方式或产生重要副作用的入口保持显式。
- **机械工作交给工具**：安装、配置、物化和确定性校验由 CLI 或脚本完成。
- **状态留在项目中**：长期信息优先写入 Spec、Issue、PR、Git 和其它可恢复 artifact，而不是只留在对话里。
- **按风险增加保障**：小任务快速完成；复杂或高风险任务再增加澄清、规格、隔离、验证和独立审查。
- **通过 Eval 精简**：Skill 是否保留以及描述如何优化，应由真实任务的 with/without-skill 结果决定。

## 快速开始

需要 **Node.js 22 或更高版本**。

```bash
npm install -g @lesliechan721/aw
aw init
aw
```

`aw` 会打开交互式插件管理界面。也可以直接使用命令：

```bash
aw install ask-me -p both
aw install git -p both
aw status
```

- `-p codex|claude|both`：选择目标平台。
- `-s user|project`：选择用户级或项目级安装；默认是 `user`。
- `--json`：输出适合脚本消费的结构化结果。
- `--verbose`：在 stderr 展开诊断。

## 选择插件

### 日常 Agent 能力

| 插件 | 适合什么场景 | 平台 |
| --- | --- | --- |
| [`ask-me`](plugins/ask-me/) | 实施前澄清关键歧义，或通过逐轮访谈把重要决定想清楚 | Codex / Claude Code |
| [`git`](plugins/git/) | 创建精确本地提交、隔离 worktree，或协调 merge 双方意图 | Codex / Claude Code |
| [`codex-enhance`](plugins/codex-enhance/) | 在 Codex 中执行大范围只读探索，并更稳妥地编排通用子代理 | Codex |

### Agent 内容与插件作者工具

| 插件 | 适合什么场景 | 平台 |
| --- | --- | --- |
| [`agent-content-toolkit`](plugins/agent-content-toolkit/) | 编写、评审 Agent-facing 文档、Agent Skills 和 Skill Eval | Codex / Claude Code |
| [`aw-plugin-development`](plugins/aw-plugin-development/) | 在本仓库创建或评审 AW 插件；面向插件维护者 | Codex / Claude Code |

## 使用示例

### 在实现前问清关键需求

```text
给团队邀请增加有效期。先帮我确认哪些行为必须由我决定。
```

`ask-me` 会先调查现有代码和约定，只询问会明显改变结果、范围或验收的问题。

### 创建一个只包含本次改动的提交

```text
把刚才修改的三个文件提交，使用仓库现有提交规范。
```

`git-commit` 会保护范围外的 index 和 worktree 状态，创建并验证本地提交；它不会 push。

### 探索陌生代码库

```text
调查鉴权失败的可能路径，只收集证据，不修改代码。
```

`codex-explore` 可以把大范围只读调查交给专用探索角色，最终判断仍由主代理完成。

### 编写或评审一个 Skill

```text
为这项重复工作设计一个 Agent Skill，并准备可验证的触发用例。
```

`agent-content-toolkit` 会把内容编写、Skill 作者、Skill 评审和 Eval 设计保持为独立能力。

## Skill 如何触发

每个 Skill 都声明自己的触发策略：

- **模型调用**：模型根据 Skill 的名称和描述判断是否适用。
- **用户显式调用**：适合授权敏感或明确改变流程的能力。
- **Slash Command**：为常用宏流程提供稳定入口；复杂逻辑仍保存在 Skill 中。

AW 在安装时保留 Codex 和 Claude Code 的原生调用元数据，不使用 CLI 配置覆盖 Skill 的触发策略。

## 常用 CLI

```bash
# 预热 catalog 和 artifact cache
aw init

# 安装、升级或移除
aw install git -p both
aw upgrade git -p both
aw uninstall git -p both

# 查看现场状态
aw status
aw status git --verbose

# 项目级安装
aw install ask-me -p codex -s project

# 清理 AW 管理的现场组件，再按 catalog 重建
aw cleanup git -p codex -s project
aw reinstall git -p codex -s user
```

`cleanup`、`uninstall` 和 `reinstall` 不会删除 AW 保存的插件配置；配置只由 `aw config reset` 删除。

## 配置 `codex-enhance`

```bash
aw config list codex-enhance -s user
aw config set codex-enhance standardModel gpt-5.6-terra -s user
aw config set codex-enhance standardReasoningEffort high -s user
aw config set codex-enhance minimumInitialWaitMinutes 15 -s user
```

具体配置项和行为见 [`codex-enhance` README](plugins/codex-enhance/README.md)。

## 安装范围

- **User scope**：为当前用户安装，适合跨项目复用。
- **Project scope**：把受 AW 管理的 Skill、规则、Agent role 和相关配置写入当前仓库，适合团队共享。

Codex project scope 会写入 `.agents/skills`、`.codex/config.toml`、`.codex/hooks.json`、`.codex/rules/` 和 `.codex/agents/` 中实际需要的文件，并使用 AW owner marker 限定后续清理范围。

## 对安全边界的约定

- 插件不会因为安装而自动获得超出宿主平台的权限。
- 需要用户授权的写操作仍由当前会话、仓库政策和 Skill 本身约束。
- `git` 插件不执行 push。
- `codex-explore` 是行为只读的证据探索能力，不把最终判断或产品写入交给探索子代理。
- 作者和评审能力分离：Reviewer 不修改被审生产源码，Author 不给自己的结果生成独立发布结论。

## 开发与贡献

```bash
make install
make build
make test
```

维护者入口：

- [架构说明](docs/architecture.md)
- [编码约定](docs/coding-conventions.md)
- [测试指南](docs/testing.md)
- [插件维护指南](docs/plugin-maintenance.md)
- [Agent 项目指令](AGENTS.md)

插件源码位于 `plugins/`。`packages/cli/plugins-dist/`、`packages/cli/dist/`、`.release/` 和本机 `~/.aw/` 都是生成或运行目录，不手工维护。
