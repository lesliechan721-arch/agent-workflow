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
| 可选 Portable Skill 层 | 插件可在完整 native plugin closure 之外显式声明 Agent Skills 分发；该层是增量能力，不把原生 Skill 自动转换为 portable source |
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

# 先导出并检查一个声明了 Portable 能力的合成本地 Catalog 插件
aw skill materialize <source>/<plugin> --scope project --out ./.aw-review/<plugin>

# Review 完整依赖闭包后，通过 PATH 中的兼容 Skills CLI 安装
aw skill install <source>/<plugin> --scope project

# 清理 AW 管理的现场组件，再按 catalog 重建
aw cleanup git -p codex -s project
aw reinstall git -p codex -s user
```

`cleanup`、`uninstall` 和 `reinstall` 不会删除 AW 保存的插件配置；配置只由 `aw config reset` 删除。

Portable 命令必须显式传 `--scope project|user`。`aw skill install` 使用 PATH 中 `skills >=1.5.23 <2.0.0`：project scope 使用当前项目根，user scope 使用 Skills CLI 的 global 模式。Agent 默认使用 Skills CLI 的自动选择；命令行可传 `--agent <id...>`，TUI 也可改为显式 Agent。`--skill` 只筛选最终安装项；验证仍覆盖完整 plugin dependency closure。外部安装允许部分成功，不做补偿回滚；失败后可重跑命令，或按 receipt 提示使用外部 `skills remove`。

`aw skill materialize` 先在临时目录验证完整候选，再写 schema 1 `.aw-materialization.json` ownership marker。它只替换由相同 plugin ID 和 scope 证明属于 AW 的目标；foreign、符号链接或身份不匹配目标会停止操作。TUI 从插件详情进入 Portable 流程，依次选择 Skill、Agent 和 scope，再显示 Review。详情页的 P13 只表示插件声明了该能力，安装状态仍是未知；AW 不维护 Portable installed state 或 Agent registry。

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

## 本地开发与发版流程

插件开发工作流迁移当前保持 `parallel`。发布验证会先运行机器迁移门禁；该状态允许 cutover evidence 未完成，因此不会阻塞正常发布，但会阻止缩减或改址固定路由、入口、能力 owner 和 gate 声明。当前验证器不支持 cutover 验证，`ready-for-cutover` 和 `retired` 会 fail closed：

```bash
pnpm migration:verify:plugin-development
```

状态、能力 owner 和完整 cutover 清单见[插件维护指南](docs/plugin-maintenance.md#旧入口迁移门禁)及[机器迁移合同](docs/plugin-development-migration.json)。

插件作者先确认已安装的 CLI，再使用稳定、非交互的公开入口：

```bash
aw --version
aw plugin init <plugin-name> --description "..." --skill-description "..."
aw plugin add-skill <plugin-name> --skill-name <skill-name> --skill-description "..."
aw plugin validate plugins/<plugin-name>
aw plugin status --all --base HEAD
```

四个命令可用 `--help` 查看完整参数。`validate --json` 输出一个机器结果对象；`status --json` 输出 schema 3 development 结果。deprecated `check-versions` 返回相同对象，并向 stderr 输出迁移提示。不要用 `npx` 隐式安装作者工具。
目标插件不在默认 `plugins/<plugin-name>` 时，`init`、`add-skill` 和单插件
`status` 传 `--plugin-root <path>`；相对路径按 `--repo-root` 解析，且目标必须位于该 Git 工作区内。
`validate` 和 `status` 会拒绝 repo/plugin root、`.agents-plugin` 或 manifest 路径链中的符号链接和错误节点类型；不要用链接重定向作者根或 manifest。

```bash
make install
make build
make test
```

本地 CLI 包含一个精确版本的共享 Eval 依赖。打包命令从同一 build snapshot 生成两个
tarball；本地安装必须同时提供它们，不能从 registry 补齐依赖：

```bash
pnpm release:pack:cli
pnpm release:install:local
# 或安装已经生成的两个文件：
pnpm release:install:local -- <cli.tgz> <eval.tgz>
```

`pnpm build` 生成 `packages/cli/plugins-dist/` schema 4 本地 snapshot。Catalog staging 和本地 release prepared 文件都是生成状态，不手工修改。

正常维护只使用 `status`、`target`、`prepare`、`publish`。先检查状态，再选择要 bump 的轴：

```bash
pnpm release:status

# 提升 CLI target
pnpm release:target -- --cli patch

# 提升 Catalog target；有插件版本变更时同时指定 --plugin
pnpm release:target -- --catalog patch --plugin <plugin-name>=patch

# 提升多个 target；--plugin 可按需重复
pnpm release:target -- --cli patch --catalog patch --plugin <plugin-name>=patch
```

`release:target` 的参数只表示要提升哪些 target，不保证本次会发布哪些轴。实际 CLI、Catalog 轴由 `release:status` 和 `release:prepare` 的输出决定。bump 只能是 `major`、`minor` 或 `patch`。命令会更新对应 source 文件：CLI target 更新时还会同步两个 public package version 和 `pnpm-lock.yaml`。提交本次有意的 source 改动后，再 prepare 和 publish：

```bash
git add \
  release/version-targets.json \
  packages/cli/package.json \
  packages/agent-skill-eval/package.json \
  pnpm-lock.yaml \
  plugins/git/.agents-plugin/plugin.json \
  README.md
git commit -m "chore(release): set release targets"
pnpm release:prepare -- beta
# 或：pnpm release:prepare -- stable
pnpm release:publish
```

示例中的 `plugins/git/.agents-plugin/plugin.json` 和 `README.md` 只是本次选择的 source 路径；只暂存实际有意的插件与 source 改动。`release:prepare` 必须在干净、已提交的 source HEAD 上运行，并在 gitignored 的 `.release/prepared/` 创建本地 artifact 和 descriptor。它是可删除的弱状态，不需要也不得提交。`release:publish` 不接受参数，只验证该 prepared state，并按 `Eval → CLI → Catalog` 的顺序发布已启用的轴。

远端发布失败或结果不确定后，不要重试同一版本。提升相关 target，重新提交 source 改动，再运行 prepare 和 publish。`attempted.json` 是本地安全门禁，不要手动删除；工具会在 target digest 改变后处理它。不需要额外的恢复命令或提交生成状态。

新 CLI 只读取 schema 1 Git/path sources。默认 `official` URL 是 `https://github.com/lesliechan721-arch/agent-workflow.git`；stable 使用 `refs/heads/catalog/latest`，prerelease 使用 `refs/heads/catalog/beta`。旧 npm catalog packages 在 cutover 后冻结，不删除或 unpublish，也不再更新。

维护者入口：

- [架构说明](docs/architecture.md)
- [编码约定](docs/coding-conventions.md)
- [测试指南](docs/testing.md)
- [插件维护指南](docs/plugin-maintenance.md)
- [发布迁移交接与回归矩阵](docs/release-migration.md)
- [插件与 Skill README 规范](docs/readme-standard.md)
- [Agent 项目指令](AGENTS.md)

插件源码位于 `plugins/`。`packages/cli/plugins-dist/`、`packages/cli/dist/`、`.release/` 和本机 `~/.aw/` 都是生成或运行目录，不手工维护。
