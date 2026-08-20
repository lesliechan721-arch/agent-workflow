# Agent Workflows

面向 **Codex** 和 **Claude Code** 的轻量、可组合 Agent 插件集合。

Agent Workflows 不试图把一种完整开发方法强加给所有任务。它把需求澄清、决策原型、结构化开发、Git 操作、证据探索、Agent 内容、Skill 工具和插件维护拆成独立能力：用户可以显式启动宏流程，模型也可以在任务中按需调用小型 Skill。

项目同时提供 `@lesliechan721/aw` CLI，用于发现、安装、升级、配置和移除插件。

## 设计思想

- **Skill 保持薄而完整**：只补充模型容易缺失的判断、项目约定和高价值边界。
- **能力可以组合**：每个 Skill 负责一个连贯任务，不要求安装一套强制 SDLC。
- **用户控制宏流程**：会改变工作方式或产生重要副作用的入口保持显式。
- **机械工作交给工具**：安装、配置、物化和确定性校验由 CLI 或脚本完成。
- **状态留在项目中**：长期信息优先写入 Spec、Issue、PR、Git 和其它可恢复 artifact，而不是只留在对话里。
- **按风险增加保障**：小任务快速完成；复杂或高风险任务再增加澄清、规格、隔离、验证和独立审查。
- **通过 Eval 精简**：Skill 是否保留以及描述如何优化，应由真实任务的 with/without-skill 结果决定。

## 相对原生插件的优势

Codex 和 Claude Code 都有自己的原生 Skill、命令和插件能力。Agent Workflows 不替代这些机制，而是在其上提供统一的分发、组合和生命周期管理。

| 能力 | Agent Workflows 提供的增量 |
| --- | --- |
| 跨平台目录 | 同一插件源码面向 Codex 和 Claude Code，安装时保留各平台原生 invocation metadata |
| 统一管理 | 使用一个 `aw` CLI 完成发现、安装、升级、配置、状态检查、清理和重建 |
| 两种安装范围 | User scope 适合个人跨项目复用；Project scope 适合把受管能力随仓库共享 |
| 安全 ownership | 只更新或清理能够证明属于 AW 的组件，避免把平台目录中的其它内容误当作插件状态 |
| 动态原生产物 | 插件可以按平台和配置物化 Skill、Agent role、instructions、hooks 等平台能力 |
| 组合式工作流 | 需求澄清、结构化开发、Git、探索和作者工具保持独立，可按任务组合 |
| 作者与评测工具链 | 仓库同时提供脚手架、确定性测试、materialization 校验和 Skill Eval / Review 工作流 |

如果只需要单个平台的一个原生 Skill，可以直接使用平台原生机制。当需要跨平台分发、项目级共享、可重复升级与清理，或一组可以组合的能力时，AW 才提供额外价值。

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
aw install dev-workflow -p both
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
| [`ask-me`](plugins/ask-me/) | 澄清关键歧义、逐轮推演重要决定，或用可体验原型帮助用户作出决定 | Codex / Claude Code |
| [`dev-workflow`](plugins/dev-workflow/) | 用 Spec、实现切片和双轴 Review 组织中大型开发任务，并按需组合 `ask-me` | Codex / Claude Code |
| [`git`](plugins/git/) | 创建精确本地提交、隔离 worktree，或协调 merge 双方意图 | Codex / Claude Code |
| [`codex-enhance`](plugins/codex-enhance/) | 在 Codex 中执行大范围只读探索，并更稳妥地编排通用子代理 | Codex |

### Agent 内容、Skill 与插件作者工具

| 插件 | 适合什么场景 | 平台 |
| --- | --- | --- |
| [`agent-content-toolkit`](plugins/agent-content-toolkit/) | 编写或评审 AGENTS.md、prompt、role instructions 和 references 等 Agent-facing 内容 | Codex / Claude Code |
| [`agent-skill-toolkit`](plugins/agent-skill-toolkit/) | 创建、评审 Agent Skill，设计或审核 Skill Eval；人工依赖 `agent-content-toolkit` | Codex / Claude Code |
| [`aw-plugin-development`](plugins/aw-plugin-development/) | 在本仓库创建或评审 AW 插件；人工依赖前两个通用工具插件 | Codex / Claude Code |

## 使用示例

### 在实现前问清关键需求

```text
给团队邀请增加有效期。先帮我确认哪些行为必须由我决定。
```

`ask-me` 会先调查现有代码和约定，只询问会明显改变结果、范围或验收的问题。

### 用原型帮助作出决定

```text
这个审批页面怎么排版我说不清。做一个可点击原型让我试，再记录我确认的决定。
```

`decision-prototype` 会制作回答单一问题的轻量原型。原型默认可丢弃，确认后的决定可以继续交给 Spec 或其它工作流。

### 启动结构化开发流程

```text
/dev 为团队邀请增加 7 天有效期。这个任务需要跨会话继续。
```

`dev-workflow` 会选择当前最小能力：必要时组合 `ask-me` 补充决定或制作决策原型，再形成轻量 Spec、实施并执行双轴 Review。明确的小任务仍然走快速实现路径。

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

### 编写或评审 Agent 内容与 Skill

```text
为这项重复工作设计一个 Agent Skill，并准备可验证的触发用例。
```

`agent-skill-toolkit` 组合 `agent-content-toolkit`，把 Agent-facing 内容、Skill 作者、Skill 评审、Eval 设计和 Eval 审核保持为独立能力。

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
make stage-catalog CATALOG_VERSION=1.2.0-beta.1
```

`pnpm build` 生成 `packages/cli/plugins-dist/` schema 3 本地 snapshot。catalog 最低 CLI 版本取插件声明与 schema 3 Git 分发 floor `0.1.0-beta.2` 的最大值。`stage-catalog` 在 `.release/catalog-staging/catalog/` 生成带 `plugin-release-ledger.json` 的完整发布交接目录。

发布入口：

```bash
make publish-catalog-beta CATALOG_VERSION=1.2.0-beta.1
make publish-catalog-release CATALOG_VERSION=1.2.0
make beta-release CLI_VERSION=0.2.0-beta.3 CATALOG_VERSION=1.2.0-beta.1
make release CLI_VERSION=0.2.0 CATALOG_VERSION=1.2.0
```

首次迁移顺序固定如下：

```bash
make stage-catalog CATALOG_VERSION=1.2.0-beta.1
make verify-catalog
make bootstrap-catalog-beta CATALOG_VERSION=1.2.0-beta.1
make stage-catalog CATALOG_VERSION=1.2.0
make verify-catalog
make bootstrap-catalog-release CATALOG_VERSION=1.2.0
pnpm test:smoke:bootstrap:catalog
# 验证 Git provider 可以 fetch 两个 official ref 后，再发布使用 Git source 的新 CLI。
```

bootstrap 只建立首次 official refs，不发布 CLI。它使用私有 build/staging generation，并在发布前核对 generation identity。它是旧 CLI compatibility 的一次性迁移例外；普通 catalog-only 入口没有绕过参数。目标 channel 已有其它内容或同版本 tag 单独存在时它会拒绝；首次迁移完成后必须使用上面的普通 catalog-only 或 combined 入口。所有 Git catalog 写入口在远端 ref 写入前拒绝 dirty worktree；release clean/live gate 拒绝 registered source/build input 和 `scripts/release/**` 上的 `assume-unchanged`、`skip-worktree`，并和 snapshot 复制前门禁一起拒绝这些 input path chain 中的符号链接，但不拒绝生成的 `plugins-dist` 中通过 schema 3 校验的合法相对符号链接。combined 和 promotion recovery 只允许前置 version sync 对两个 package manifest 产生未暂存的顶层 `version` 语义变化；promotion recovery 仅用于 tag 与 CLI 均已发布但 channel 尚未推进的固定恢复命令。catalog-only、bootstrap、combined 和 standalone CLI 在 publication lease、catalog ref 或 npm 写入前重新核对 semantic clean 状态、live input/package digest 和 HEAD。Git publisher 使用固定 SHA-1 object format、私有 `core.symlinks=true` 配置、`catalog/latest`、`catalog/beta` 独立 orphan channel 和 immutable annotated `catalog-v<version>` tag；内部 `aw-release/publication-lock` branch 串行 catalog 和 CLI 发布事务，standalone CLI publisher 在锁内重读 dist-tag，`aw-release/tag-first-pending` guard 保护 tag-first 到 promotion 的失败恢复窗口，二者都不是发布历史。不支持 atomic push 时不降级。release ledger 使用 schema 2 digest 语义，path identity 包含 node kind 和规范 Git mode；snapshot digest 把目录归一为 `040000`，并忽略 non-executable checkout 权限差异；validator 拒绝 Git commit 无法表示的空目录。合法相对 symlink 以 `120000` mode 和 target 原样通过 build snapshot、release staging 和 Git 发布；不能物化 symlink 的平台明确失败，不降级为普通文件。旧 schema 1 会被拒绝。publisher 在拒绝 `.gitattributes` 后强制 stage 全部 snapshot 文件，并验证 commit tree 完整匹配。组合发布的 promotion 失败时，错误会输出可复制的 `release:promote:catalog:<channel>` 命令。

新 CLI 只读取 schema 1 Git/path sources。默认 `official` URL 是 `https://github.com/lesliechan721-arch/agent-workflow.git`；stable 使用 `refs/heads/catalog/latest`，prerelease 使用 `refs/heads/catalog/beta`。旧 npm catalog packages 在 cutover 后冻结，不删除或 unpublish，也不再更新。

维护者入口：

- [架构说明](docs/architecture.md)
- [编码约定](docs/coding-conventions.md)
- [测试指南](docs/testing.md)
- [插件维护指南](docs/plugin-maintenance.md)
- [插件与 Skill README 规范](docs/readme-standard.md)
- [Agent 项目指令](AGENTS.md)

插件源码位于 `plugins/`。`packages/cli/plugins-dist/`、`packages/cli/dist/`、`.release/` 和本机 `~/.aw/` 都是生成或运行目录，不手工维护。
