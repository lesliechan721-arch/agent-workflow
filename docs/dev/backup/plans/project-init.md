# 项目初始化计划

> 历史文档
> 适用背景：本文记录的是项目最早一轮的初始化与源码树 marketplace 方案。
> 失效说明：文中依赖 repo root marketplace、源码树 `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` 以及命令阶段生成 runtime manifest 的做法已经失效。
> 当前方案：请以 [docs/dev/plans/npm-plugin-marketplace-new.md](npm-plugin-marketplace-new.md) 和 [docs/dev/todos/npm-plugin-marketplace-new.md](../todos/npm-plugin-marketplace-new.md) 为准。

## 项目定位

一个 Codex + Claude Code 共用的工作流扩展项目，同时作为双端插件市场。通过 `@yiliang/aw` npm 包分发安装脚本，支持完整的安装生命周期管理。

仓库按“插件集合”组织。CLI 的 `install` / `uninstall` / `status` 面向插件名称集合执行，`upgrade` 额外支持全量更新。

## 架构三层

基于调研文档的推荐方案（方案 A：共享插件层 + 双端适配层），项目分为三层：

```
┌─────────────────────────────────────┐
│        Core Workflow Model          │  中立定义层
│  技能、事件语义、规则模型、agent 定义  │
├─────────────────────────────────────┤
│       Shared Plugin Surface         │  共享插件面
│       skills + MCP + metadata       │
├──────────────────┬──────────────────┤
│  Codex Adapter   │ Claude Adapter   │  平台适配层
│  hooks.json      │ plugin hooks     │
│  AGENTS.md       │ CLAUDE.md/rules  │
│  execpolicy      │ settings.json    │
│  agents/ roles   │ .claude/agents   │
└──────────────────┴──────────────────┘
```

## 目标目录结构

```
agent-workflows/
├── .claude-plugin/
│   └── marketplace.json              # 双端共享市场主入口
├── .agents/
│   └── plugins/
│       └── marketplace.json          # Codex 原生约定镜像
├── plugins/
│   └── git-commit/                   # Git 提交规范插件
│       ├── .agents-plugin/
│       │   └── plugin.json           # 中立源 manifest
│       ├── .claude-plugin/
│       │   └── plugin.json           # 由源 manifest 生成的 Claude manifest
│       ├── .codex-plugin/
│       │   └── plugin.json           # 由源 manifest 生成的 Codex manifest
│       └── skills/
│           └── commit/
│               └── SKILL.md          # 手动触发的提交工作流 skill
├── packages/
│   └── cli/                          # @yiliang/aw npm 包
│       ├── package.json
│       ├── tsconfig.json
│       ├── src/
│       │   ├── index.ts              # CLI 入口
│       │   ├── commands/
│       │   │   ├── install.ts
│       │   │   ├── uninstall.ts
│       │   │   ├── upgrade.ts
│       │   │   └── status.ts
│       │   ├── adapters/
│       │   │   ├── types.ts          # 适配器接口
│       │   │   ├── codex.ts          # Codex 平台适配
│       │   │   └── claude.ts         # Claude Code 平台适配
│       │   ├── generators/
│       │   │   ├── instructions.ts   # 指令规则生成
│       │   │   ├── permissions.ts    # 权限规则生成（Codex execpolicy / Claude settings）
│       │   │   ├── hooks.ts          # hooks 生成
│       │   │   └── agents.ts         # agent 定义生成
│       │   └── utils/
│       │       ├── detect.ts         # 检测当前环境（Codex/Claude/both）
│       │       ├── manifest.ts       # 源 manifest 读写与平台 manifest 生成
│       │       └── paths.ts          # 路径约定
│       └── tests/
│           ├── fixtures/             # marketplace / plugin / config 测试夹具
│           ├── unit/                 # 工具函数与生成器单元测试
│           └── integration/          # CLI 与安装流程集成测试
├── docs/
│   ├── codex-plugins.md
│   ├── codex-claude-code-extension-research.md
│   ├── codex-claude-plugin-marketplace-research.md
│   └── dev/
│       └── plans/
│           └── project-init.md       # 本文件
├── package.json                      # workspace root
└── tsconfig.base.json
```

补充约束：

- 每个插件以 `plugins/<name>/.agents-plugin/plugin.json` 作为唯一源 manifest
- `.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json` 都由源 manifest 生成；至少要有自动化测试校验生成结果不漂移
- 原因是 Codex 会优先读取 `.codex-plugin/plugin.json`，如果平台产物可手写，Codex 和 Claude 看到的能力面很容易分叉
- 仓库内面向 agent 的脚手架和辅助脚本优先使用 Node.js，避免把 Python 当成默认前置环境；如果必须引入其他运行时，需要先说明理由

## 实施步骤

### Phase 1：仓库骨架与市场入口

搭建可被双端识别的 marketplace 仓库结构。

- [ ] 1.1 创建 workspace root `package.json`（pnpm workspace）
- [ ] 1.2 创建 `.claude-plugin/marketplace.json`（共享市场主入口）
- [ ] 1.3 创建 `.agents/plugins/marketplace.json`（Codex 镜像，内容与 1.2 保持一致）
- [ ] 1.4 创建 `.gitignore`

**marketplace.json 设计要点：**

- `owner` 字段：Claude Code 要求
- `interface` 字段：Codex 使用，Claude Code 忽略
- 插件 source 使用相对路径字符串：`"./plugins/<name>"`
- 不使用 Claude 专属 source 类型（`github` / `npm` / `pip`）
- 可以带 `policy` 字段：Codex 使用，Claude Code 忽略

### Phase 2：Git 提交规范插件

创建第一个实际插件：通过手动触发的提交工作流 skill 执行符合 Conventional Commits 规范的 git 提交。

- [ ] 2.1 创建 `plugins/git-commit/` 目录
- [ ] 2.2 创建 `.agents-plugin/plugin.json`
  - 作为插件唯一源 manifest
  - 描述共享字段、平台特定字段和生成约束
- [ ] 2.3 从 `.agents-plugin/plugin.json` 生成 `.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json`
  - 两份生成结果的共享字段保持一致；平台差异由生成器按目标端能力面展开
  - 路径值都相对插件根目录
  - `skills` 用字符串路径（Codex 窄类型兼容）
  - 本插件不需要 MCP，manifest 不含 `mcpServers`
  - 如果将来插件接 Claude hooks 且文件放在默认 `hooks/hooks.json`，不要在 `manifest.hooks` 里重复声明这一路径
- [ ] 2.4 创建 `skills/commit/SKILL.md`（手动触发的提交工作流 skill）
  - 共享协议只定义“手动触发 skill”，不把 `/commit` 当成双端统一入口
  - skill 指导 agent 执行完整的提交流程（见下方 skill 设计）
- [ ] 2.5 更新两份 `marketplace.json`，注册 `git-commit` 插件

**提交工作流 skill 设计：**

skill 名称可以继续使用 `commit`，但入口语义只定义为“用户手动调用该 skill”，不定义为 slash command。

skill 被调用后，指导 agent 按以下流程执行：

1. 运行 `git status` 和 `git diff` 查看当前变更
2. 运行 `git log` 查看近期提交风格
3. 分析变更内容，按 Conventional Commits 规范草拟 commit message：
   - 格式：`<type>(<scope>): <description>`
   - description 使用中文
   - type 从 `feat` / `fix` / `docs` / `refactor` / `test` / `chore` 中选择
   - scope 涉及具体模块时填写，否则可省略
   - 多处改动或行为变更原因不明显时，必须写 body（说明"为什么"改）
   - body 每条变更以 `-` 列出，多模块按模块分组
   - 涉及不兼容变更时，footer 必须声明 `BREAKING CHANGE: xxx`
   - 关联 issue/PR 时在 footer 使用 `Closes #N` / `See #N`
4. 按文件路径精确执行 `git add` 和 `git commit`，不要把无关改动一起纳入提交
5. 提交后运行 `git status` 验证

### Phase 3：CLI 安装工具

实现 `@yiliang/aw` npm 包，承载完整生命周期。

- [ ] 3.1 初始化 `packages/cli/` 项目结构
  - `package.json`（bin 入口 `aw`）
  - `tsconfig.json`
  - 依赖：commander（CLI 框架）、chalk（输出着色）、fs-extra、vitest（测试）
- [ ] 3.2 实现环境检测模块 `utils/detect.ts`
  - 检测 Codex 是否安装及配置路径
  - 检测 Claude Code 是否安装及配置路径
  - 检测当前是 project scope 还是 user scope
- [ ] 3.3 实现 manifest 模块 `utils/manifest.ts`
  - 定义 `.agents-plugin/plugin.json` 的中立模型与 schema
  - 从源 manifest 生成 `.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json`
  - 提供 manifest 读写与一致性校验能力，供 CLI 和测试共用
- [ ] 3.4 实现平台适配器接口 `adapters/types.ts`

```ts
interface PlatformAdapter {
  name: 'codex' | 'claude';
  detect(): Promise<boolean>;
  installPlugin(plugin: PluginMeta, scope: Scope): Promise<void>;
  uninstallPlugin(plugin: PluginMeta, scope: Scope): Promise<void>;
  installExtensions(plugin: PluginMeta, scope: Scope): Promise<void>;
  uninstallExtensions(plugin: PluginMeta, scope: Scope): Promise<void>;
  status(scope: Scope): Promise<StatusReport>;
}
```

CLI 层负责把用户指定的插件名称集合解析成 `PluginMeta[]`，再逐个调用 adapter；adapter 继续以“单插件”为最小操作单元。

- [ ] 3.5 实现 Claude Code 适配器 `adapters/claude.ts`
  - **插件部分**：优先复用 Claude 原生命令或等价内部流程
    - 注册 marketplace source 时，同时完成 `extraKnownMarketplaces`、`known_marketplaces.json` 和 marketplace cache 的物化
    - 安装指定插件集合时，优先走 Claude 原生 plugin / marketplace install 语义
    - `install` / `upgrade` / `status` 以 Claude 原生 marketplace / plugin 状态为准；CLI 不额外维护第二套 Claude marketplace mirror
  - **自定义扩展**：
    - 指令规则 → `.claude/rules/*.md` 或全局 `~/.claude/rules/*.md`
    - 权限规则 → `settings.json.permissions`
    - agent 定义 → `.claude/agents/*.md` 或全局 `~/.claude/agents/*.md`
    - hooks → `settings.json` hooks 配置
- [ ] 3.6 实现 Codex 适配器 `adapters/codex.ts`
  - **插件部分**：优先复用 Codex 原生命令或等价内部流程
    - 注册 marketplace 到 `~/.codex/config.toml [marketplaces.*]`（仅 user scope，见设计决策 4）
    - 安装指定插件集合时，优先走 Codex 原生 plugin install 语义
  - **自定义扩展**（均写入 `.codex/` 配置层目录）：
    - 指令规则 → `.codex/AGENTS.md`（project）或 `~/.codex/AGENTS.md`（user）
    - 审批规则（execpolicy）→ `.codex/rules/*.rules`（project）或 `~/.codex/rules/*.rules`（user）
    - agent 定义 → `.codex/agents/`（project）或 `~/.codex/agents/`（user）
    - hooks → `.codex/hooks.json`（project）或 `~/.codex/hooks.json`（user）（仅 command hook 稳定可用）
- [ ] 3.7 实现指令规则生成器 `generators/instructions.ts`
  - 从中立指令模型生成双端产物
  - Codex → `.codex/AGENTS.md` / Claude → `.claude/rules/*.md`
- [ ] 3.8 实现权限规则生成器 `generators/permissions.ts`
  - 从中立权限模型生成双端产物
  - Codex → execpolicy `.rules` 文件 / Claude → `.claude/settings.json` permissions
- [ ] 3.9 实现 hooks 生成器 `generators/hooks.ts`
  - 定义公共事件语义（before tool / after tool / session start / stop）
  - Codex 端只生成 command hook
  - Claude 端生成完整插件 hooks
  - Claude 标准 hooks 文件输出到 `plugins/<name>/hooks/hooks.json`
  - 不在 `manifest.hooks` 重复声明默认 `hooks/hooks.json`；`manifest.hooks` 只留给额外 hooks 文件或内联 hooks
- [ ] 3.10 实现 agent 定义生成器 `generators/agents.ts`
  - 统一 agent 模型 → Codex config layer roles / Claude `.claude/agents`
- [ ] 3.11 实现四个命令
  - `install <plugins...>`：按插件名称集合安装插件（原生 + 自定义扩展），支持 `--scope project|user`，支持 `--platform codex|claude|both|auto`
    - Codex 插件/marketplace 注册强制走 user scope（见设计决策 4），自定义扩展尊重 `--scope`
    - Claude 两者均尊重 `--scope`；marketplace source 写入 settings 后，必须继续完成原生物化
  - `uninstall <plugins...>`：按插件名称集合清理原生插件状态和自定义扩展产物，支持同样的 `--platform codex|claude|both|auto`
  - `upgrade [plugins...]`：支持按插件名称集合更新，也支持 `--all` 全量刷新平台原生状态并重新生成扩展产物；支持同样的 `--platform codex|claude|both|auto`
  - `status [plugins...]`：显示指定插件集合或全部插件的状态；先显示平台原生状态，再补充 CLI 生成产物状态与漂移告警；支持同样的 `--platform codex|claude|both|auto`
  - `--platform` 统一解析规则：
    - `codex` / `claude` 只操作单个平台
    - `both` 代表用户显式要求对双平台同时执行；如果当前环境只检测到单平台，直接报错，不静默降级
    - `auto` 在只检测到单平台时直接选择该平台
    - `status --platform auto` 在 `both` 环境下同时读取两端状态
    - `install` / `uninstall` / `upgrade` 在 `both` 环境下，如果当前 scope 下只有一个平台已经初始化，则只操作该平台；如果两端都已初始化或两端都未初始化，则拒绝执行并要求用户显式传 `--platform`
  - CLI 只用 `.agent-workflows-manifest.json` 追踪自定义扩展产物，不把它当插件安装真值来源
- [ ] 3.12 实现 CLI 入口 `index.ts`

### Phase 4：测试用例

- [ ] 4.1 初始化测试框架与脚本
  - workspace root 与 `packages/cli/package.json` 补齐 `test` / `test:unit` / `test:integration`
  - 统一临时目录、fixture 装载和清理工具
- [ ] 4.2 为 `utils/manifest.ts` 编写单元测试
  - 校验 `.agents-plugin/plugin.json` 到 `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` 的生成结果正确
  - 校验路径规则：相对路径、`./` 前缀、不能逃出插件根目录
- [ ] 4.3 为生成器编写单元测试
  - 覆盖 `instructions.ts` / `permissions.ts` / `hooks.ts` / `agents.ts` 的双端输出
  - 覆盖 Codex execpolicy `.rules` 文件生成结果
  - 覆盖 Claude 默认 `hooks/hooks.json` 不重复写入 `manifest.hooks`
- [ ] 4.4 为 CLI 命令编写集成测试
  - 覆盖 `install` / `uninstall` / `upgrade` / `status`
  - 覆盖 `--scope` 映射、插件名称集合解析、`--platform auto|both` 选择逻辑、Codex 回退到 user scope、status 数据源优先级、manifest 清理逻辑
- [ ] 4.5 为 marketplace 与插件发现 / 物化流程编写夹具测试
  - 覆盖两份 `marketplace.json` 注册插件
  - 覆盖 Claude marketplace 物化完成后 `status` 读取一致状态
  - 覆盖 `git-commit` 插件在 `.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json` 下都能被正确发现
- [ ] 4.6 约定测试门禁
  - Phase 5 的手工验证前，先通过 `pnpm test`
  - 后续接 CI 时直接复用同一套测试命令

### Phase 5：构建与验证

- [ ] 5.1 配置 TypeScript 构建
- [ ] 5.2 验证 marketplace 可被 Codex repo-local discovery 发现
- [ ] 5.3 验证 marketplace 可被 Claude Code `plugin marketplace add` 消费并完成物化
- [ ] 5.4 验证 git-commit 插件的提交工作流 skill 在双端能手动加载和执行（功能等价，不要求命令名一致）
- [ ] 5.5 验证 CLI install / uninstall / upgrade / status 四个命令
- [ ] 5.6 验证自定义扩展在双端正确生成

## 关键设计决策

### 1. 插件 vs 自定义扩展的边界

根据调研文档，插件系统能承载的能力面：

| 能力 | 走插件 | 走自定义扩展 | 原因 |
| --- | --- | --- | --- |
| skills | 是 | 否 | 双端插件均支持 |
| MCP | 是 | 否 | 双端插件均支持 |
| agent 定义 | Claude 侧可以 | Codex 侧必须 | Codex agent 定义不在插件层 |
| 指令规则 | 否 | 是 | 两端文件格式和位置不同 |
| 权限规则 | 否 | 是 | 两端模型完全不同 |
| hooks | Claude 侧可以 | Codex 侧必须 | Codex hooks 不在插件层且仅 command hook 稳定 |

原则：安装生命周期优先复用平台原生 plugin / marketplace 命令或等价内部流程；只有原生面不承载的扩展项，才由 CLI 生成平台特定产物。

### 2. 源 manifest + 双 target manifest 策略

- 每个插件用 `.agents-plugin/plugin.json` 作为唯一源 manifest
- `.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json` 都由源 manifest 生成
- 重名字段按 Codex 窄类型写（`skills` / `mcpServers` 用字符串路径）
- Claude 独占字段可以使用，但要遵守 Claude 自己的默认发现规则
- `hooks/hooks.json` 走 Claude 的默认自动发现；`manifest.hooks` 只用来补充额外 hooks 文件或内联 hooks，不能重复声明默认路径
- 生成链路通过自动化测试校验一致性
- Codex 会忽略未知顶层字段，不会报错

### 2.1 脚本运行时约束

- 仓库内用于初始化、同步、校验插件骨架的脚本优先使用 Node.js
- 默认目标是“安装 agent 的环境通常已经有 Node.js”，不要让 Python 成为创建插件的隐性前置条件
- 如果脚本只是操作 JSON、文本文件、目录和 marketplace manifest，优先写成零依赖 Node.js 脚本
- 只有在 Node.js 明显不合适时，才考虑引入 Python 或其他运行时，并在文档里写明原因

### 3. `git-commit` 插件的入口契约

- 共享层只定义“提交工作流 skill”，不定义 `/commit` 这类 slash command
- 双端验收标准是“用户能手动触发该 skill，并完成等价提交流程”，不是“命令名一致”
- 如果后续某个平台要补命令别名或 UI 入口，只能放在平台适配层，不回写成共享协议

### 4. `--scope` 路径映射与平台约束

**Codex 关键约束**：Codex 的 `[plugins.*]` 和 `[marketplaces.*]` 仅从用户层 `~/.codex/config.toml` 读取，项目层 `.codex/config.toml` 不参与插件解析。因此 Codex 插件/marketplace 注册只能走 user scope。自定义扩展不受此限制，可以走 project scope。另一个容易混淆的点是：Codex 的审批规则概念层叫 `execpolicy`，但落盘形式仍然是 config layer 下的 `.rules` 文件。

**Claude 关键约束**：Claude 原生区分 `project`（`.claude/settings.json`，团队共享）和 `local`（`.claude/settings.local.json`，个人）。`--scope project` 应映射到 `.claude/settings.json`，确保团队可见。

#### 自定义扩展路径映射

| scope | Claude Code | Codex |
| --- | --- | --- |
| `project` | `.claude/rules/*.md`, `.claude/agents/*.md`, `.claude/settings.json` | `.codex/AGENTS.md`, `.codex/agents/`, `.codex/hooks.json`, `.codex/rules/*.rules`（execpolicy） |
| `user` | `~/.claude/rules/*.md`, `~/.claude/agents/*.md`, `~/.claude/settings.json` | `~/.codex/AGENTS.md`, `~/.codex/agents/`, `~/.codex/hooks.json`, `~/.codex/rules/*.rules`（execpolicy） |

#### 插件/marketplace 注册路径映射

| scope | Claude Code | Codex |
| --- | --- | --- |
| `project` | `.claude/settings.json` extraKnownMarketplaces | **不支持**，强制回退到 user scope 并警告用户 |
| `user` | `~/.claude/settings.json` extraKnownMarketplaces | `~/.codex/config.toml [marketplaces.*]` |

补充约束：Claude 的 `extraKnownMarketplaces` 只是 source registry；`install` / `upgrade` 时还必须触发原生 materialization，保持 `known_marketplaces.json` 与 marketplace cache 同步。

### 5. `--platform` 目标解析策略

- 四个命令统一支持 `--platform codex|claude|both|auto`
- `codex` / `claude` 只操作单个平台，不推断另一端
- `both` 只在环境检测结果为 `both` 时允许使用；它代表用户明确接受双端同时变更
- `auto` 的解析规则：
  - 如果环境检测只返回 `codex` 或 `claude`，直接选择该平台
  - `status --platform auto` 在 `both` 环境下同时读取两端状态，并按平台分组展示
  - `install` / `uninstall` / `upgrade` 在 `both` 环境下，先检查当前 `--scope` 下是否只有一个平台已经初始化
- “已初始化”的判定标准：
  - 该平台已存在目标插件集合对应的原生 marketplace / plugin 注册或安装状态
  - 或该平台当前 scope 下已存在由 CLI 生成并记录在 `.agent-workflows-manifest.json` 里的扩展产物
- 如果 `auto` 在 `both` 环境下发现两端都已初始化，或两端都未初始化，命令直接失败，并提示用户显式传 `--platform codex|claude|both`

### 6. 自定义扩展产物的命名约定

为了支持 uninstall 精确清理，所有由 CLI 生成的文件使用统一前缀或 manifest 追踪：

- 生成文件统一带 `aw-` 前缀（agent-workflows 缩写）
- 在安装目标目录维护一份 `.agent-workflows-manifest.json`，记录所有生成的文件路径
- uninstall 时按 manifest 逐个清理

### 7. 状态模型与所有权

先明确“谁是事实来源”，避免 `install` / `upgrade` / `status` 互相覆盖。

- marketplace source 注册：
  - Codex 以 `~/.codex/config.toml [marketplaces.*]` 为准
  - Claude 以 `extraKnownMarketplaces` 为声明入口，并要求同时完成 `known_marketplaces.json` 与 marketplace cache 的物化
- 插件安装状态：
  - 优先读取平台原生已安装 / 可用状态
  - CLI 不单独维护第二份“插件已安装”数据库
- 自定义扩展产物：
  - 由本项目负责生成和清理
  - `.agent-workflows-manifest.json` 只记录这部分文件，不记录原生 marketplace / plugin 状态
- 版本与升级基准：
  - 所有状态都按插件名聚合
  - 优先读取平台原生 marketplace / plugin revision 或 version
  - 只有原生状态拿不到足够信息时，才回退到插件 manifest 的 version 做展示
- `status` 输出顺序：
  1. 平台检测结果
  2. 原生 marketplace / plugin 状态
  3. CLI 生成产物状态
  4. 两者不一致时的漂移告警

### 8. 升级策略

`upgrade` 命令的逻辑：

1. 刷新平台原生 marketplace / plugin 状态（Claude 走 marketplace materialization / refresh；Codex 走 marketplace upgrade 或等价刷新），不由 CLI 自己维护第二份 git clone
2. 基于原生状态里的 revision / version，判断指定插件集合或 `--all` 需要更新的插件
3. 重新生成所有自定义扩展产物（覆盖写入）
4. 更新本地 `.agent-workflows-manifest.json`
5. 如果原生状态与生成产物不一致，输出 drift 提示

### 9. 测试策略

- 单元测试优先覆盖 manifest 生成、路径校验、指令 / 权限生成器、execpolicy 输出与 hooks 去重逻辑
- 集成测试覆盖 CLI 四个命令、scope 路径映射、Claude marketplace 物化、状态归属、安装产物清理
- 手工验证只承担双端真实环境确认，回归逻辑尽量留给自动化测试

## 风险与约束

### 平台语义约束（已纳入设计）

1. **Codex 自定义扩展必须写入 `.codex/` 配置层目录**：Codex 只从 config layer 目录发现 hooks、agents、rules 等产物，写到仓库根目录不会被读取
2. **Codex 插件/marketplace 注册仅支持 user scope**：`[plugins.*]` 和 `[marketplaces.*]` 只从 `~/.codex/config.toml` 读取，项目层 `.codex/config.toml` 不参与解析。CLI 的 `--scope project` 对 Codex 插件注册必须回退到 user scope
3. **Claude project scope 写 `.claude/settings.json` 而非 `.claude/settings.local.json`**：Claude 原生区分 project（团队共享）和 local（个人），`--scope project` 应映射到 `.claude/settings.json`

### 能力面约束

4. **Codex 插件 skill 不支持 hooks / agent / fork context**：如果后续需要"技能触发 agent 工作流"，不能依赖 Codex skill metadata
5. **Claude 插件 agent 有安全限制**：`permissionMode` / `hooks` / `mcpServers` 会被忽略，这些需要走 `.claude/agents/` 显式定义
6. **Claude 插件 skill ≠ 普通 skill**：插件 skill 不支持 `hooks` / `context: fork` / `agent` frontmatter
7. **Codex hooks 仅 command hook 稳定**：prompt hook 和 agent hook 会被跳过
8. **Claude 会自动加载默认 `hooks/hooks.json`**：同一路径如果再写进 `manifest.hooks`，会触发重复 hooks 加载错误，并记录 `hook-load-failed`
9. **Codex 会优先读取 `.codex-plugin/plugin.json`**：因此它必须与 `.claude-plugin/plugin.json` 同源生成，并由自动化测试持续校验一致性
10. **marketplace.json 一旦需要 Claude 专属 source，必须拆成两份**
11. **共享入口只能定义为手动 skill，不是 slash command**：Codex 插件没有一等 `slash commands` 能力，`git-commit` 这类工作流插件必须把统一入口收敛到 skill 语义

## 预期产出

完成 Phase 1-5 后：

- 一个可被双端识别的 Git 插件市场仓库
- 一个 git-commit 插件，提供手动触发的提交工作流 skill，执行 Conventional Commits 规范的 git 提交
- 一个 `@yiliang/aw` npm 包，提供 `install` / `uninstall` / `upgrade` / `status` 命令
- 双端自定义扩展的自动生成能力（规则、hooks、agent 定义）
- 一套覆盖 manifest 同步、生成器输出和 CLI 安装流程的测试用例
