# 项目初始化计划

## 项目定位

一个 Codex + Claude Code 共用的工作流扩展项目，同时作为双端插件市场。通过 `@yiliang/agent-workflows` npm 包分发安装脚本，支持完整的安装生命周期管理。

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
│       ├── .claude-plugin/
│       │   └── plugin.json           # Claude 入口 manifest
│       ├── .codex-plugin/
│       │   └── plugin.json           # Codex 入口 manifest，与 Claude 保持一致
│       └── skills/
│           └── commit/
│               └── SKILL.md          # 手动调用的 skill：/commit
├── packages/
│   └── cli/                          # @yiliang/agent-workflows npm 包
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
│       │   │   ├── rules.ts          # 规则生成（指令规则 + 权限规则）
│       │   │   ├── hooks.ts          # hooks 生成
│       │   │   └── agents.ts         # agent 定义生成
│       │   └── utils/
│       │       ├── detect.ts         # 检测当前环境（Codex/Claude/both）
│       │       ├── manifest.ts       # manifest 读写
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

- 第一阶段同时维护 `plugins/<name>/.claude-plugin/plugin.json` 与 `plugins/<name>/.codex-plugin/plugin.json`
- 两份 manifest 推荐由同一份插件元数据生成；至少要有自动化测试校验共享字段不漂移
- 原因是 Codex 会优先读取 `.codex-plugin/plugin.json`，两份文件一旦漂移，Codex 和 Claude 看到的能力面就会分叉

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

创建第一个实际插件：通过手动调用的 skill（`/commit`）执行符合 Conventional Commits 规范的 git 提交。

- [ ] 2.1 创建 `plugins/git-commit/` 目录
- [ ] 2.2 创建 `.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json`
  - 两份 manifest 默认保持内容一致，路径值都相对插件根目录
  - `skills` 用字符串路径（Codex 窄类型兼容）
  - 本插件不需要 MCP，manifest 不含 `mcpServers`
  - 如果将来插件接 Claude hooks 且文件放在默认 `hooks/hooks.json`，不要在 `manifest.hooks` 里重复声明这一路径
- [ ] 2.3 创建 `skills/commit/SKILL.md`（手动调用的 skill）
  - 用户通过 `/commit` 触发
  - skill 指导 agent 执行完整的提交流程（见下方 skill 设计）
- [ ] 2.4 更新两份 `marketplace.json`，注册 `git-commit` 插件

**`/commit` skill 设计：**

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
4. 将草拟的 commit message 展示给用户确认
5. 用户确认后执行 `git add` 和 `git commit`
6. 提交后运行 `git status` 验证

### Phase 3：CLI 安装工具

实现 `@yiliang/agent-workflows` npm 包，承载完整生命周期。

- [ ] 3.1 初始化 `packages/cli/` 项目结构
  - `package.json`（bin 入口 `agent-workflows`）
  - `tsconfig.json`
  - 依赖：commander（CLI 框架）、chalk（输出着色）、fs-extra、vitest（测试）
- [ ] 3.2 实现环境检测模块 `utils/detect.ts`
  - 检测 Codex 是否安装及配置路径
  - 检测 Claude Code 是否安装及配置路径
  - 检测当前是 project scope 还是 user scope
- [ ] 3.3 实现 manifest 模块 `utils/manifest.ts`
  - 定义插件元数据的中立模型
  - 从同一份模型生成 `.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json`
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

- [ ] 3.5 实现 Claude Code 适配器 `adapters/claude.ts`
  - **插件部分**：注册 marketplace 到 `extraKnownMarketplaces`，安装插件
  - **自定义扩展**：
    - 指令规则 → `.claude/rules/*.md` 或全局 `~/.claude/rules/*.md`
    - 权限规则 → `settings.json.permissions`
    - agent 定义 → `.claude/agents/*.md` 或全局 `~/.claude/agents/*.md`
    - hooks → `settings.json` hooks 配置
- [ ] 3.6 实现 Codex 适配器 `adapters/codex.ts`
  - **插件部分**：注册 marketplace 到 `~/.codex/config.toml [marketplaces.*]`（仅 user scope，见设计决策 3）
  - **自定义扩展**（均写入 `.codex/` 配置层目录）：
    - 指令规则 → `.codex/AGENTS.md`（project）或 `~/.codex/AGENTS.md`（user）
    - 权限规则 → `.codex/rules/*.rules`（project）或 `~/.codex/rules/*.rules`（user）
    - agent 定义 → `.codex/agents/`（project）或 `~/.codex/agents/`（user）
    - hooks → `.codex/hooks.json`（project）或 `~/.codex/hooks.json`（user）（仅 command hook 稳定可用）
- [ ] 3.7 实现规则生成器 `generators/rules.ts`
  - 从中立规则模型生成双端产物
  - 指令规则：Codex → `.codex/AGENTS.md` / Claude → `.claude/rules/*.md`
  - 权限规则：Codex → `.codex/rules/*.rules` / Claude → `.claude/settings.json` permissions
- [ ] 3.8 实现 hooks 生成器 `generators/hooks.ts`
  - 定义公共事件语义（before tool / after tool / session start / stop）
  - Codex 端只生成 command hook
  - Claude 端生成完整插件 hooks
  - Claude 标准 hooks 文件输出到 `plugins/<name>/hooks/hooks.json`
  - 不在 `manifest.hooks` 重复声明默认 `hooks/hooks.json`；`manifest.hooks` 只留给额外 hooks 文件或内联 hooks
- [ ] 3.9 实现 agent 定义生成器 `generators/agents.ts`
  - 统一 agent 模型 → Codex config layer roles / Claude `.claude/agents`
- [ ] 3.10 实现四个命令
  - `install`：安装插件（原生 + 自定义扩展），支持 `--scope project|user`，支持 `--platform codex|claude|auto`
    - Codex 插件/marketplace 注册强制走 user scope（见设计决策 3），自定义扩展尊重 `--scope`
    - Claude 两者均尊重 `--scope`
  - `uninstall`：清理插件和自定义扩展产物
  - `upgrade`：拉取最新 marketplace，重新生成扩展产物
  - `status`：显示当前安装状态、平台检测结果、插件列表
- [ ] 3.11 实现 CLI 入口 `index.ts`

### Phase 4：测试用例

- [ ] 4.1 初始化测试框架与脚本
  - workspace root 与 `packages/cli/package.json` 补齐 `test` / `test:unit` / `test:integration`
  - 统一临时目录、fixture 装载和清理工具
- [ ] 4.2 为 `utils/manifest.ts` 编写单元测试
  - 校验 `.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json` 的共享字段一致
  - 校验路径规则：相对路径、`./` 前缀、不能逃出插件根目录
- [ ] 4.3 为生成器编写单元测试
  - 覆盖 `rules.ts` / `hooks.ts` / `agents.ts` 的双端输出
  - 覆盖 Claude 默认 `hooks/hooks.json` 不重复写入 `manifest.hooks`
- [ ] 4.4 为 CLI 命令编写集成测试
  - 覆盖 `install` / `uninstall` / `upgrade` / `status`
  - 覆盖 `--scope` 映射、Codex 回退到 user scope、manifest 清理逻辑
- [ ] 4.5 为 marketplace 与插件发现流程编写夹具测试
  - 覆盖两份 `marketplace.json` 注册插件
  - 覆盖 `git-commit` 插件在 `.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json` 下都能被正确发现
- [ ] 4.6 约定测试门禁
  - Phase 5 的手工验证前，先通过 `pnpm test`
  - 后续接 CI 时直接复用同一套测试命令

### Phase 5：构建与验证

- [ ] 5.1 配置 TypeScript 构建
- [ ] 5.2 验证 marketplace 可被 Codex repo-local discovery 发现
- [ ] 5.3 验证 marketplace 可被 Claude Code `plugin marketplace add` 消费
- [ ] 5.4 验证 git-commit 插件 `/commit` skill 在双端正常加载和执行
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

原则：能走插件的先走插件，哪怕只是一个 agent 去执行扩展安装。不能走插件的由 CLI 安装脚本生成平台特定产物。

### 2. 双 manifest 策略

- 仓库内同时维护 `.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json`
- 重名字段按 Codex 窄类型写（`skills` / `mcpServers` 用字符串路径）
- Claude 独占字段可以使用，但要遵守 Claude 自己的默认发现规则
- `hooks/hooks.json` 走 Claude 的默认自动发现；`manifest.hooks` 只用来补充额外 hooks 文件或内联 hooks，不能重复声明默认路径
- 两份 manifest 由同一份插件元数据生成，并通过自动化测试校验一致性
- Codex 会忽略未知顶层字段，不会报错

### 3. `--scope` 路径映射与平台约束

**Codex 关键约束**：Codex 的 `[plugins.*]` 和 `[marketplaces.*]` 仅从用户层 `~/.codex/config.toml` 读取，项目层 `.codex/config.toml` 不参与插件解析。因此 Codex 插件/marketplace 注册只能走 user scope。自定义扩展不受此限制，可以走 project scope。

**Claude 关键约束**：Claude 原生区分 `project`（`.claude/settings.json`，团队共享）和 `local`（`.claude/settings.local.json`，个人）。`--scope project` 应映射到 `.claude/settings.json`，确保团队可见。

#### 自定义扩展路径映射

| scope | Claude Code | Codex |
| --- | --- | --- |
| `project` | `.claude/rules/*.md`, `.claude/agents/*.md`, `.claude/settings.json` | `.codex/AGENTS.md`, `.codex/agents/`, `.codex/hooks.json`, `.codex/rules/*.rules` |
| `user` | `~/.claude/rules/*.md`, `~/.claude/agents/*.md`, `~/.claude/settings.json` | `~/.codex/AGENTS.md`, `~/.codex/agents/`, `~/.codex/hooks.json`, `~/.codex/rules/*.rules` |

#### 插件/marketplace 注册路径映射

| scope | Claude Code | Codex |
| --- | --- | --- |
| `project` | `.claude/settings.json` extraKnownMarketplaces | **不支持**，强制回退到 user scope 并警告用户 |
| `user` | `~/.claude/settings.json` extraKnownMarketplaces | `~/.codex/config.toml [marketplaces.*]` |

### 4. 自定义扩展产物的命名约定

为了支持 uninstall 精确清理，所有由 CLI 生成的文件使用统一前缀或 manifest 追踪：

- 生成文件统一带 `aw-` 前缀（agent-workflows 缩写）
- 在安装目标目录维护一份 `.agent-workflows-manifest.json`，记录所有生成的文件路径
- uninstall 时按 manifest 逐个清理

### 5. 升级策略

`upgrade` 命令的逻辑：

1. 拉取最新 marketplace（git pull 或重新 clone）
2. 对比已安装插件的版本
3. 重新生成所有自定义扩展产物（覆盖写入）
4. 更新本地 manifest

### 6. 测试策略

- 单元测试优先覆盖 manifest 生成、路径校验、规则生成器与 hooks 去重逻辑
- 集成测试覆盖 CLI 四个命令、scope 路径映射、安装产物清理
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

## 预期产出

完成 Phase 1-5 后：

- 一个可被双端识别的 Git 插件市场仓库
- 一个 git-commit 插件，提供 `/commit` skill 执行 Conventional Commits 规范的 git 提交
- 一个 `@yiliang/agent-workflows` npm 包，提供 `install` / `uninstall` / `upgrade` / `status` 命令
- 双端自定义扩展的自动生成能力（规则、hooks、agent 定义）
- 一套覆盖 manifest 同步、生成器输出和 CLI 安装流程的测试用例
