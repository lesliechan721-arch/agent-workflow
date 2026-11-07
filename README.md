# Agent Workflows

面向 **Codex**、**Claude Code**、**Antigravity**、**Cursor** 等平台的轻量、可组合 Agent 插件系统。

Agent Workflows (AW) 不试图将单一开发方法强加给所有任务。它把需求澄清、原型制作、结构化开发、Git 操作、代码探索、内容编写与插件工具解耦为独立能力：用户可显式触发宏流程，模型也可在对话中按需调用轻量 Skill。

项目提供全局 `@lesliechan721/aw` CLI，用于发现、安装、配置、同步、检查与清理跨平台插件。完整 25 个活动主文档索引见 [AW 文档导航总览](docs/README.md)。

---

## 设计思想

- **Skill 保持薄而完整**：只补充模型容易缺失的关键判断、项目约定与高价值安全边界。
- **能力可以自由组合**：每个 Skill 专注单一连贯任务，不要求全盘绑定强制的 SDLC 方法论。
- **用户控制宏流程**：会产生重要副作用或改变工作流向的入口保持用户显式触发。
- **机械工作交给工具**：安装、配置、物化与确定性校验由 CLI 自动完成。
- **状态留在项目中**：长期信息写入 Spec、Issue、Git 等可恢复载体，不只留在对话上下文中。
- **按风险增加保障**：小任务快速完成；高风险任务按需增加澄清、规格、隔离与双轴审查。
- **通过真实评测精简**：Skill 存废与提示词优化由真实的 with/without-skill 评测结果驱动。

---

## 相对原生插件的优势

- **跨平台统一分发**：一份源码同时面向 Codex、Claude Code 以及其他平台，保留原生调用元数据。
- **统一生命周期 CLI**：使用 `aw` 统一处理发现、安装、配置、状态检查、刷新同步与安全清理。
- **双层需求声明**：区分 User（个人跨项目通用）与 Project（团队仓库共享）范围，共享一份本机目标偏好。
- **严格所有权保护**：仅清理带有 AW owner marker 的专属产物，严格保护宿主原生配置与外部文件。
- **动态原生产物**：支持根据用户配置在安装时动态生成定制 Skill 或 instructions。

---

## 快速开始

### 运行环境

需要 **Node.js 22 或更高版本**。

### 最短成功路径

```bash
# 1. 全局安装 CLI
npm install -g @lesliechan721/aw

# 2. 同步并激活官方 Catalog 快照（首次安装插件前必须取得本地 Active 快照）
aw catalog source sync official

# 3. 启动交互式管理控制台 (TUI)
aw
```

> [!TIP]
> `aw init` 是纯离线就绪检查命令，不会联网，也不在磁盘生成或写入配置文件。在尚未同步快照的新环境中运行 `aw init` 会因缺少 Active 快照报告未就绪（非零退出）；先执行上述 `source sync official` 激活快照即可顺利通过检查。

非交互命令行使用示例：

```bash
# 配置本机启用的平台目标（例如 Codex 与 Claude Code）
aw plugin targets set codex claude

# 为当前用户安装核心工作流插件
aw plugin install decision-kit --scope user
aw plugin install dev-workflow --scope user

# 检查当前现场安装状态
aw plugin status --context user
```

完整用户入门教程见 [用户快速入门指南](docs/guide/getting-started.md)；遇到异常见 [用户排障指南](docs/guide/troubleshooting.md)。

---

## 选择插件

### 日常 Agent 能力

| 插件 | 适用场景 | 支持平台 |
| --- | --- | --- |
| [`decision-kit`](plugins/decision-kit/) | 澄清关键歧义、制作轻量决策原型、记录重要决策 | 七平台（Codex / Claude / Antigravity / Cursor / OpenCode / Pi / Generic） |
| [`dev-workflow`](plugins/dev-workflow/) | 结构化全流程开发交付，协调设计、实施、测试与审查 | Codex / Claude Code |
| [`human-content`](plugins/human-content/) | 解释复杂资料，输出保留原意的图表、文档或交互式阅读页 | 七平台（Codex / Claude / Antigravity / Cursor / OpenCode / Pi / Generic） |
| [`frontend-design`](plugins/frontend-design/) | 选择视觉方向，设计与打磨网页排版、交互与响应式细节 | 七平台（Codex / Claude / Antigravity / Cursor / OpenCode / Pi / Generic） |
| [`browser-use`](plugins/browser-use/) | 网页浏览器自动化交互与信息检索能力 | 七平台（Codex / Claude / Antigravity / Cursor / OpenCode / Pi / Generic） |
| [`git-toolkit`](plugins/git-toolkit/) | 创建规范本地原子提交、隔离 worktree、协调合并冲突 | Codex / Claude Code |
| [`agent-subagent`](plugins/agent-subagent/) | 选择通用委派配置并管理外部子代理执行 | Codex / Claude Code |
| [`codex-enhance`](plugins/codex-enhance/) | 在 Codex 中组织大范围只读探索与技术咨询；依赖 `agent-subagent` | Codex |

### Agent 内容、Skill 与插件作者工具

| 插件 | 适用场景 | 支持平台 |
| --- | --- | --- |
| [`agent-content-toolkit`](plugins/agent-content-toolkit/) | 编写、整理与只读评审 AGENTS.md、Prompt 与 Role 说明 | 七平台（Codex / Claude / Antigravity / Cursor / OpenCode / Pi / Generic） |
| [`agent-skill-toolkit`](plugins/agent-skill-toolkit/) | 创建 Agent Skill、设计 Eval 测试用例与技能架构评审 | Codex / Claude Code |
| [`aw-development-toolkit`](plugins/aw-development-toolkit/) | 创建与维护 AW Catalog 及 Plugin Source，提供物化与分析工具 | Codex / Claude Code |
| [`aw-skill-eval-runner`](plugins/aw-skill-eval-runner/) | 准备并执行 AW Skill 自动化评测（Eval），验证模型表现 | Codex / Claude Code |

---

## 使用示例

### 在实现前问清关键需求
`decision-kit` 调查现有代码与项目约定，只询问会明显改变设计、范围或验收的核心问题。

### 用原型帮助作出决定
`decision-prototype` 制作回答单一问题的轻量可丢弃原型，记录用户确认的技术决策。

### 启动结构化开发流程
Codex 使用 `$dev-workflow`（或 `$dev-design` / `$dev-build` / `$dev-review-loop`），Claude Code 使用 `/dev-workflow:dev-workflow`（平台插件 Skill 命名空间调用语法）协调规范开发，小任务走快速通道，复杂任务跨会话接续。详见 [dev-workflow README](plugins/dev-workflow/README.md)。

### 创建一个只包含本次改动的提交
`git-commit` 保护范围外的 index 与工作树，创建符合规范的本地提交，绝不隐式 push。

### 探索陌生代码库
`codex-explore` 将大范围证据调查交给只读探索子代理，主代理完成最终分析，不修改代码。

### 编写或评审 Agent 内容与 Skill
`agent-content` 整理面向 Agent 的正文；`agent-skill-toolkit` 辅助设计可验证的 Eval 测试用例。

---

## Skill 如何触发

每个 Skill 均声明触发方式：
- **模型自动调用**：模型根据名称和任务描述自主判断适用性；
- **用户显式调用**：适合授权敏感或重要流程切换操作（Codex 使用 `$skill`，Claude Code 使用 `/plugin:skill`）；
- **Slash Command**：为常用宏流程提供快捷入口。

---

## 常用 CLI

常用命令汇总参见 [用户快速入门指南：命令速查](docs/guide/getting-started.md#7-常用命令速查)；底层生命周期细节见 [插件生命周期架构说明](docs/maintainers/architecture/lifecycle.md)。

### 托管命令

托管命令提供跨平台稳定的 `cmdp_` 包装入口，声明与权限规范见 [托管命令参考合同](docs/reference/managed-commands.md)。

### User 与 Project 插件恢复

需求声明保存在无平台的 Intent 文件中，用户与项目范围分工见 [用户快速入门指南：两种需求范围](docs/guide/getting-started.md#两种需求范围-user-vs-project)。

---

## 配置子代理

配置修改与应用生效流程见 [用户快速入门指南：插件配置](docs/guide/getting-started.md#4-插件配置保存设置与应用生效)；子代理档位与执行器配置见 [Agent Subagent README](plugins/agent-subagent/README.md)。

---

## 安装范围

- **User scope (`--scope user`)**：为当前用户全局安装，跨项目复用。
- **Project scope (`--scope project`)**：项目专属，需求保存在 `.agent-workflows/plugin-intents.json` 中随仓库共享。

详见 [用户快速入门指南：两种需求范围](docs/guide/getting-started.md#两种需求范围-user-vs-project)。

---

## 对安全边界的约定

- **权限不扩散**：插件安装绝不自动获得超出宿主平台的系统权限。
- **写操作受控**：涉及文件修改或重要副作用的操作保持显式确认；Git 插件绝不隐式执行 `git push`。
- **只读探索保证**：代码探索子代理是严格行为只读的，绝不把最终修改交给子代理。
- **严格所有权保护**：清理（cleanup）仅处理可证明为 AW 拥有的专属产物；外部（foreign）文件与共享包体（shared）绝对受保护。
- **保存与生效解耦**：强配置原子写入存储，应用生效阶段失败绝不回滚已存盘配置。

---

## 本地开发与发版流程

### 第三方 Catalog 与 Plugin 作者

第三方创作者无需检出本 monorepo，教程参见：
- [开发你的第一个插件](docs/authoring/first-plugin.md)
- [Catalog 作者指南](docs/authoring/catalog.md)
- [插件与 Skill README 规范](docs/authoring/readme-standard.md)
- [公开参考合同目录](docs/reference/)

### 本仓库维护与官方发版

官方 CLI 五包分发、Windows Helper 原生协议与 GitHub Actions 自动化发布参见：
- [AW 维护者指南](docs/maintainers/README.md)
- [测试指南与 Test Value Gate](docs/maintainers/testing.md)
- [CI 说明](docs/maintainers/ci.md)
- [官方发布与失败恢复指南](docs/maintainers/release.md)
