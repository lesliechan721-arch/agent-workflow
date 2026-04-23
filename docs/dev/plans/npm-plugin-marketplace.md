# NPM 插件市场分发方案

## Context

当前插件安装流程直接操作 agent 配置文件（Claude 的 settings.json、Codex 的 config.toml），实现脆弱且与平台内部格式强耦合。本方案将插件分发迁移到私有 npm 仓库，引入本地插件市场（`~/.aw`），让 Codex 和 Claude Code 通过各自 CLI 的原生插件命令完成安装/卸载，降低对平台内部配置的直接依赖。

## 核心变更概览

| 维度 | 当前 | 目标 |
|------|------|------|
| 分发渠道 | 本地相对路径 `./plugins/*` | 私有 npm 包 `@yiliang/aw` (阿里云 registry) |
| 市场名称 | `agent-workflows` | `aw` |
| 插件存储 | 仓库内 `plugins/` 目录 | `~/.aw/plugins/` 本地市场 |
| 安装方式 | 适配器直写 settings.json / config.toml | 先注册本地市场，再通过 agent 原生命令从市场安装插件 |
| 插件内容 | 所有 agent 共用一份文件 | 按 agent 差异化生成（独立内容目录 + 文件包含/排除） |
| marketplace 注册 | aw CLI 直接修改配置文件 | aw 初始化本地市场 → agent 原生命令读取本地市场 |

---

## Agent 原生 CLI 命令参考

### Claude Code 安装流程

两步操作：先注册本地市场目录，再从市场安装插件。

```bash
# 第1步: 注册本地市场 (directory 源，需含 .claude-plugin/marketplace.json)
claude plugin marketplace add ~/.aw --scope user

# 第2步: 从已注册市场安装插件
claude plugin install git-commit@aw --scope project
```

**内部行为**:
- `marketplace add <dir>` → 读取 `<dir>/.claude-plugin/marketplace.json`，提取 name，写入 `settings.json` 的 `extraKnownMarketplaces` 和 `~/.claude/plugins/known_marketplaces.json`
- `plugin install <name>@<market>` → 从已注册市场查找插件 → 加载 manifest → 缓存到 `~/.claude/plugins/cache/` → 写入 `enabledPlugins`
- Claude 原生插件系统自动加载: skills、agents (.md)、hooks、mcpServers、commands
- Claude 原生不支持的: permissions (allow/deny 规则) → 需脚本补充

**卸载**:
```bash
claude plugin uninstall git-commit@aw
```

### Codex 安装流程

两步操作：先注册本地市场目录，再通过 config.toml 启用插件。

```bash
# 第1步: 注册本地市场 (需含 .agents/plugins/marketplace.json)
codex plugin marketplace add ~/.aw

# 第2步: 启用插件 (Codex 没有单独的 plugin install CLI)
# 需要在 ~/.codex/config.toml 中添加:
#   [plugins."git-commit@aw"]
#   enabled = true
```

**内部行为**:
- `marketplace add <dir>` → 验证 `<dir>/.agents/plugins/marketplace.json` 存在 → 在 `config.toml` 中记录 `[marketplaces.aw]` 段（source_type=local, source=绝对路径）
- 本地市场不复制文件，直接引用目录
- 插件启用后，Codex 自动加载: skills、mcpServers
- Codex 不支持或部分支持: instructions → 写入 .codex/config.toml 的 instructions 字段（见 Phase 4.3）；permissions → 需写入 .codex/rules/*.rules；hooks → 仅 command 类型写入 hooks.json；agents → 需写入 .codex/agents/*.json

**卸载/禁用**:
```bash
# 删除整个市场
codex plugin marketplace remove aw

# 或在 config.toml 中将 enabled 设为 false
```

---

## Phase 1: npm 发布改造

### 1.1 配置私有 npm 仓库

**Registry**: `https://packages.aliyun.com/5fa510142f8cc15c287b3dcd/npm/npm-registry/`

通过 `publishConfig` 控制发布目标，无需 `.npmrc` 文件。消费端用户在自己的环境中配置 registry 即可。

### 1.2 调整 packages/cli/package.json 发布配置

**文件**: `packages/cli/package.json`

- 移除 `"private": true`
- 添加 `files` 字段，包含 CLI 编译产物和插件数据
- 添加 `publishConfig` 指向私有 registry

```json
{
  "name": "@yiliang/aw",
  "version": "0.2.0",
  "type": "module",
  "bin": { "aw": "./dist/index.js" },
  "files": ["dist/", "plugins-dist/"],
  "publishConfig": {
    "registry": "https://packages.aliyun.com/5fa510142f8cc15c287b3dcd/npm/npm-registry/"
  }
}
```

### 1.3 构建时打包插件数据

**当前**: `plugins/` 在仓库根目录，与 `packages/cli` 平级。

在 build 脚本中增加 copy 步骤，将仓库根目录 `plugins/` 复制到 CLI 包内：

```json
{
  "scripts": {
    "prebuild": "rm -rf plugins-dist",
    "build": "tsc -p tsconfig.json && node scripts/bundle-plugins.js"
  }
}
```

### 1.4 打包脚本 bundle-plugins.js

**文件**: `packages/cli/scripts/bundle-plugins.js`（新建）

职责：
1. 复制 `../../plugins` → `plugins-dist/plugins/`
2. 复制 `../../.claude-plugin/marketplace.json` → `plugins-dist/.claude-plugin/marketplace.json`
3. 复制 `../../.agents/plugins/marketplace.json` → `plugins-dist/.agents/plugins/marketplace.json`
4. 将 marketplace.json 中的 `name` 字段改为 `"aw"`
5. 将 marketplace.json 中 source 路径重写为 `"./plugins/<name>"`

同时仓库根 `.gitignore` 添加 `packages/cli/plugins-dist`。

### 1.5 新增 resolveEmbeddedPluginsRoot()

**文件**: `packages/cli/src/utils/paths.ts`

```typescript
export function resolveEmbeddedPluginsRoot(): string {
  return path.resolve(__dirname, '../../plugins-dist');
}
```

---

## Phase 2: 本地插件市场（~/.aw）

### 2.1 目录结构设计

`~/.aw` 需同时满足 Claude Code 和 Codex 的市场目录发现约定。**关键设计**：每个插件内部按 agent 分设独立内容目录，两份平台清单分别指向各自的内容路径，实现差异化。

```
~/.aw/
├── .claude-plugin/
│   └── marketplace.json              # Claude Code 市场发现入口
├── .agents/
│   └── plugins/
│       └── marketplace.json          # Codex 市场发现入口
├── config.json                       # aw 本地市场元配置
├── installed.json                    # 已安装插件的元数据
└── plugins/
    └── git-commit/
        ├── .agents-plugin/
        │   └── plugin.json           # 源清单（从 npm 包复制，含 buildConfig）
        ├── .claude-plugin/
        │   └── plugin.json           # Claude 适配清单 → skills: "./claude/skills"
        ├── .codex-plugin/
        │   └── plugin.json           # Codex 适配清单 → skills: "./codex/skills"
        ├── claude/                    # Claude 专属内容
        │   ├── skills/
        │   │   └── commit/
        │   │       └── SKILL.md
        │   ├── commands/             # Claude 独有: slash commands
        │   │   └── commit.md
        │   └── agents/
        │       └── reviewer.md
        ├── codex/                    # Codex 专属内容
        │   └── skills/
        │       └── commit/
        │           └── SKILL.md      # 含融入的 instructions 内容
        └── shared/                   # 双端共享资源（可选）
            └── config/
                └── sample.mcp.json
```

**关键约定**:
- `.claude-plugin/plugin.json` 中路径指向 `"./claude/skills"`, `"./claude/commands"` 等
- `.codex-plugin/plugin.json` 中路径指向 `"./codex/skills"` 等
- 两份平台清单读取各自的内容目录，实现同一插件下的 agent 差异化
- 共享资源（如 MCP 配置）放在 `shared/`，双端清单均可引用 `"./shared/config/sample.mcp.json"`

### 2.2 新增 `aw init` 命令

**文件**: `packages/cli/src/commands/init.ts`（新建）

职责：将 npm 包内嵌的插件数据复制到 `~/.aw`，并执行定制化生成。

```
aw init [--force]
  │
  ├─ 1. 检查 ~/.aw/config.json 版本是否匹配当前 aw 版本
  │     匹配且无 --force → 跳过，打印 "已是最新"
  │
  ├─ 2. 读取 resolveEmbeddedPluginsRoot() 下所有插件
  │     遍历 plugins-dist/plugins/*/.agents-plugin/plugin.json
  │
  ├─ 3. 对每个插件执行定制化生成（Phase 4）
  │     ├─ 复制源插件到 ~/.aw/plugins/<name>/
  │     ├─ 读取 .agents-plugin/plugin.json 中的 buildConfig
  │     ├─ 按 agent 处理文件包含/排除（fileRules）
  │     ├─ 按 agent 处理文本模板变量（templates）
  │     ├─ 生成 claude/ 和 codex/ 内容目录
  │     ├─ 生成 .claude-plugin/plugin.json（路径指向 ./claude/）
  │     └─ 生成 .codex-plugin/plugin.json（路径指向 ./codex/）
  │
  ├─ 4. 生成 ~/.aw/.claude-plugin/marketplace.json
  │
  ├─ 5. 生成 ~/.aw/.agents/plugins/marketplace.json（镜像）
  │
  ├─ 6. 初始化 ~/.aw/installed.json（空安装记录）
  │
  └─ 7. 写入 ~/.aw/config.json
```

触发时机：
- 用户首次运行 `aw install` 时自动执行（检测 `~/.aw` 不存在或版本不匹配）
- 用户手动 `aw init` 或 `aw init --force` 强制重新初始化

### 2.3 marketplace.json 格式

市场名统一为 `aw`：

```json
{
  "name": "aw",
  "owner": { "name": "Leslie Chan" },
  "interface": { "displayName": "Agent Workflows" },
  "plugins": [
    {
      "name": "git-commit",
      "source": "./plugins/git-commit",
      "description": "...",
      "category": "workflow",
      "version": "0.1.0"
    }
  ]
}
```

### 2.4 config.json 格式

```json
{
  "version": "0.2.0",
  "initializedAt": "2026-04-23T10:00:00Z",
  "sourcePackage": "@yiliang/aw",
  "sourceVersion": "0.2.0"
}
```

### 2.5 installed.json —— 安装元数据

记录通过 `aw install` 安装到各平台的插件信息，用于 `aw status`、`aw uninstall`、`aw upgrade` 的状态查询和清理。

```json
{
  "version": 1,
  "plugins": {
    "git-commit": {
      "version": "0.1.0",
      "installedAt": "2026-04-23T10:00:00Z",
      "updatedAt": "2026-04-23T10:00:00Z",
      "platforms": {
        "claude": {
          "scope": "project",
          "installedAt": "2026-04-23T10:00:00Z",
          "extensions": ["permissions"]
        },
        "codex": {
          "scope": "user",
          "installedAt": "2026-04-23T10:00:00Z",
          "extensions": ["permissions", "hooks", "agents"]
        }
      }
    }
  },
  "marketplaceRegistrations": {
    "claude": {
      "registeredAt": "2026-04-23T10:00:00Z",
      "scope": "user"
    },
    "codex": {
      "registeredAt": "2026-04-23T10:00:00Z"
    }
  }
}
```

**字段说明**:
- `plugins.<name>.platforms.<agent>.scope`: 安装时使用的 scope
- `plugins.<name>.platforms.<agent>.extensions`: 通过脚本补充安装的扩展类型列表（agent 原生不支持的部分），卸载时据此清理
- `marketplaceRegistrations`: 本地市场在各平台的注册状态，避免重复注册

**使用场景**:
- `aw status` → 读取 installed.json 展示所有插件在各平台的安装状态
- `aw uninstall` → 根据 `platforms` 确定需要从哪些平台卸载，根据 `extensions` 确定需要清理哪些扩展产物
- `aw upgrade` → 对比 `version` 和本地市场中的版本决定是否需要升级
- `aw install` → 检测是否已安装，避免重复安装

---

## Phase 3: 基于 Agent 原生 CLI 安装/卸载

### 3.1 重构 ClaudeAdapter

**文件**: `packages/cli/src/adapters/claude.ts`

#### installPlugin()

```typescript
async installPlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
  const awHome = resolveAwHome(); // ~/.aw
  const marketplaceName = 'aw';
  const scopeFlag = `--scope ${scope}`;

  // 1. 注册本地市场（幂等，检查 installed.json）
  const installed = await readInstalledMetadata();
  if (!installed.marketplaceRegistrations.claude) {
    await execAsync(`claude plugin marketplace add "${awHome}" ${scopeFlag}`);
    await updateMarketplaceRegistration(installed, 'claude', scope);
  }

  // 2. 从市场安装插件
  const pluginId = `${plugin.manifest.name}@${marketplaceName}`;
  await execAsync(`claude plugin install "${pluginId}" ${scopeFlag}`);

  // 3. 记录安装元数据
  await recordPluginInstallation(installed, plugin.manifest.name, 'claude', scope);
}
```

#### installExtensions()

Claude 原生插件系统通过 `.claude-plugin/plugin.json` 自动加载 skills、agents、hooks、mcpServers、commands。仅对不支持的扩展保留脚本补充：

```typescript
async installExtensions(plugin: PluginMeta, scope: Scope): Promise<GeneratedArtifact[]> {
  const artifacts: GeneratedArtifact[] = [];
  const extensions = plugin.manifest.extensions ?? {};
  const installedExtTypes: string[] = [];

  // permissions (allow/deny) → Claude 插件系统不原生支持，需写入 settings.json
  if (extensions.permissions?.length) {
    const paths = resolveClaudePaths(this.cwd, scope);
    // 保留现有 mergeClaudePermissions + rebuildClaudeSettingsState 逻辑
    artifacts.push(...permissionArtifacts);
    installedExtTypes.push('permissions');
  }

  // 更新 installed.json 中的 extensions 列表
  await updateInstalledExtensions(plugin.manifest.name, 'claude', installedExtTypes);

  return artifacts;
}
```

#### uninstallPlugin()

```typescript
async uninstallPlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
  const pluginId = `${plugin.manifest.name}@aw`;
  await execAsync(`claude plugin uninstall "${pluginId}"`);

  // 从 installed.json 中移除记录
  await removePluginInstallation(plugin.manifest.name, 'claude');
}
```

### 3.2 重构 CodexAdapter

**文件**: `packages/cli/src/adapters/codex.ts`

#### installPlugin()

```typescript
async installPlugin(plugin: PluginMeta, _scope: Scope): Promise<void> {
  const awHome = resolveAwHome(); // ~/.aw
  const marketplaceName = 'aw';

  // 1. 注册本地市场（幂等，检查 installed.json）
  const installed = await readInstalledMetadata();
  if (!installed.marketplaceRegistrations.codex) {
    await execAsync(`codex plugin marketplace add "${awHome}"`);
    await updateMarketplaceRegistration(installed, 'codex');
  }

  // 2. 启用插件（Codex 无单独 plugin install CLI，操作 config.toml）
  const pluginId = `${plugin.manifest.name}@${marketplaceName}`;
  await enableCodexPluginInConfig(pluginId);

  // 3. 记录安装元数据
  await recordPluginInstallation(installed, plugin.manifest.name, 'codex', 'user');
}
```

#### installExtensions()

Codex 原生插件支持 skills 和 mcpServers。其余扩展保留现有生成逻辑：

```typescript
async installExtensions(plugin: PluginMeta, scope: Scope): Promise<GeneratedArtifact[]> {
  const installedExtTypes: string[] = [];

  // instructions → 写入 .codex/config.toml 的 instructions 字段（见 Phase 4.3）
  // permissions  → .codex/rules/*.rules
  // hooks        → .codex/hooks.json（仅 command 类型）
  // agents       → .codex/agents/*.json
  // 保留现有逻辑，记录安装的扩展类型

  await updateInstalledExtensions(plugin.manifest.name, 'codex', installedExtTypes);
  return artifacts;
}
```

#### uninstallPlugin()

```typescript
async uninstallPlugin(plugin: PluginMeta, _scope: Scope): Promise<void> {
  const pluginId = `${plugin.manifest.name}@aw`;
  await disableCodexPluginInConfig(pluginId);

  // 从 installed.json 中移除记录
  await removePluginInstallation(plugin.manifest.name, 'codex');
}
```

### 3.3 市场注册状态检测

通过 `~/.aw/installed.json` 的 `marketplaceRegistrations` 检测，无需直接读取平台配置文件：

```typescript
async function isMarketplaceRegistered(agent: 'claude' | 'codex'): Promise<boolean> {
  const installed = await readInstalledMetadata();
  return !!installed.marketplaceRegistrations[agent];
}
```

### 3.4 新增 execAsync 工具

**文件**: `packages/cli/src/utils/exec.ts`（新建）

```typescript
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execPromise = promisify(exec);

export async function execAsync(
  command: string,
  options?: { timeout?: number; cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execPromise(command, {
    timeout: options?.timeout ?? 30_000,
    cwd: options?.cwd,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}
```

---

## Phase 4: 插件内容定制化生成

### 4.1 buildConfig —— 插件构建配置

在 `.agents-plugin/plugin.json` 源清单中新增 `buildConfig` 顶级字段，控制按 agent 生成差异化内容。`buildConfig` 仅在 `aw init` 构建时消费，不会出现在生成的平台清单中。

```json
{
  "name": "git-commit",
  "version": "0.1.0",
  "description": "...",
  "skills": "./skills",
  "buildConfig": {
    "templates": {
      "vars": {
        "agent_name": { "claude": "Claude Code", "codex": "Codex" },
        "thinking_support": { "claude": true, "codex": false }
      },
      "include": ["skills/**/*.md", "commands/**/*.md", "agents/**/*.md"]
    },
    "fileRules": {
      "claude": {
        "include": ["skills/**", "commands/**", "agents/**", "hooks/**", "config/**"],
        "exclude": []
      },
      "codex": {
        "include": ["skills/**", "config/**"],
        "exclude": ["commands/**", "agents/reviewer.md"]
      }
    },
    "manifestOverrides": {
      "claude": {
        "commands": "./commands",
        "agents": ["./agents/reviewer.md"],
        "hooks": "./hooks/hooks.json"
      },
      "codex": {}
    }
  },
  "extensions": {
    "permissions": [...],
    "hooks": [...],
    "agents": [...]
  }
}
```

#### 4.1.1 templates —— 文本模板化

任意文本文件均可参与模板化，不限于 skills。

- `vars`: 定义模板变量及其按 agent 的值。支持字符串和布尔值。
- `include`: glob 模式列表，匹配的文本文件会进行模板变量替换。

**模板语法**（简单字符串替换 + 条件块）：

```markdown
# Git Commit Skill

使用 {{agent_name}} 按 Conventional Commits 规范提交代码。

{{#if thinking_support}}
利用 extended thinking 深入分析变更内容...
{{/if}}
{{#unless thinking_support}}
分析变更内容并生成提交信息。
{{/unless}}
```

**处理时机**: `aw init` 对每个 agent 分别处理，输出到 `<plugin>/<agent>/` 目录。

#### 4.1.2 fileRules —— 文件包含/排除

- `include`: glob 数组，匹配的文件/目录复制到该 agent 的内容目录
- `exclude`: glob 数组，从 include 结果中排除

规则：先 include 再 exclude。不在任何 agent 的 include 中的文件不会出现在生成目录中。

**示例效果**:
- Claude 端得到: `skills/`、`commands/`、`agents/`、`hooks/`、`config/`
- Codex 端得到: `skills/`、`config/`（无 commands、无 reviewer agent）

#### 4.1.3 manifestOverrides —— 平台清单字段覆盖

生成 `.claude-plugin/plugin.json` 和 `.codex-plugin/plugin.json` 时，先从源清单提取共享字段（name、version、description、interface），再用 `manifestOverrides.<agent>` 深合并覆盖。

这允许 Claude 清单额外声明 commands、agents、hooks 等 Claude 独有能力，而 Codex 清单不包含这些字段。

### 4.2 Claude Code 独有扩展支持

Claude Code 原生插件系统支持以下 Codex 不支持的能力，通过 `manifestOverrides.claude` 声明：

| 扩展类型 | plugin.json 字段 | 说明 |
|----------|------------------|------|
| Slash Commands | `commands` | 路径或 Record，加载 .md 文件作为 `/命令` |
| Output Styles | `outputStyles` | 自定义输出样式 |
| LSP Servers | `lspServers` | 语言服务器集成 |
| User Config | `userConfig` | 安装时提示用户输入配置 |
| Channels | `channels` | MCP 通知频道声明 |

> **注**: Claude Code 的 rules 功能等同于 instructions，无需单独声明。instructions 内容通过 skills 或 commands 承载即可。

**目录约定**:

```
plugins/git-commit/
├── commands/                # Claude 独有: slash commands
│   └── commit.md           # /commit 命令
├── agents/
│   └── reviewer.md         # Claude Code agent 定义
├── hooks/
│   └── hooks.json          # Claude hooks 配置
├── skills/                  # 双端共享（模板化前的源文件）
│   └── commit/
│       └── SKILL.md
└── config/
    └── sample.mcp.json     # 双端共享 MCP 配置
```

### 4.3 Codex instructions 处理策略

**问题**: 之前方案直接写入 `.codex/AGENTS.md`，侵入性强且卸载困难。

**调研发现**: Codex 系统提示词除了 AGENTS.md 外，还会加载 `config.toml` 中的 `instructions` 字段。该字段的内容被注入到 user instructions 中（与 AGENTS.md 内容通过 `--- project-doc ---` 分隔符拼接），且支持 config layer stack 多层叠加（project scope 的 `.codex/config.toml` 覆盖 user scope）。

**新方案**: 将插件的 instructions 内容写入 **project scope 的 `.codex/config.toml` 的 `instructions` 字段**。语义等同于 Claude Code 的 `.claude/rules/*.md`——自动注入提示词，不依赖 skill，与插件本身解耦。

实现方式：

1. **安装时**，在 `installExtensions()` 中将插件的 instructions 内容汇聚写入 `.codex/config.toml`：

```toml
# .codex/config.toml (project scope)
[codex]
instructions = """
# aw:git-commit / commit-rules

## Git Commit Rules
- 使用 Conventional Commits 格式
- scope 必须与模块名一致
- 提交前检查 lint 和 test

# aw:git-commit / code-style

## Code Style
- 2 空格缩进
- 不要添加注释
"""
```

2. **多插件汇聚**: 多个插件的 instructions 用 `# aw:<plugin> / <instruction-name>` 标记分隔，类似当前 AGENTS.md 汇聚方案但写入 config.toml。

3. **卸载时**，从 `instructions` 字段中移除对应插件的段落。通过标记精确定位：
   - 按 `# aw:<plugin>` 前缀匹配并移除
   - 如果移除后 instructions 为空，删除整个字段

4. **与 AGENTS.md 的关系**: 两者在系统提示词中是拼接关系（用 `--- project-doc ---` 分隔），不会冲突。用户手写的 AGENTS.md 内容不受影响。

**优势**:
- 与 Claude Code rules 语义一致：自动注入提示词，不依赖 skill 存在
- 卸载干净：精确移除标记段落
- 不侵入 AGENTS.md：用户自己的 AGENTS.md 不被修改
- 支持 project/user scope：project scope 写入 `.codex/config.toml`，user scope 写入 `~/.codex/config.toml`

### 4.4 extensions 中的 agentOverrides

对于通过 `aw installExtensions()` 脚本补充的扩展（permissions、hooks、agents），沿用 `agentOverrides` 机制：

```json
{
  "extensions": {
    "permissions": [
      {
        "name": "git-ops",
        "allow": ["git commit", "git push"],
        "agentOverrides": {
          "codex": { "allow": ["git commit", "git push", "git rebase"] }
        }
      }
    ],
    "hooks": [
      {
        "event": "before_tool",
        "command": "echo check",
        "agentOverrides": {
          "codex": null
        }
      }
    ]
  }
}
```

语义规则：
- `agentOverrides.<agent>` 为 object → 深合并覆盖该条目的对应字段
- `agentOverrides.<agent>` 为 `null` → 该 agent 的生成中移除此条目
- `agentOverrides` 不存在 → 使用默认值

### 4.5 新增本地插件生成器

**文件**: `packages/cli/src/generators/local-plugin.ts`（新建）

```typescript
export async function generateLocalPlugin(
  sourcePluginDir: string,
  targetDir: string,
): Promise<void> {
  const manifest = await readSourceManifest(sourcePluginDir);
  const buildConfig = manifest.buildConfig ?? getDefaultBuildConfig();

  for (const agent of ['claude', 'codex'] as const) {
    const agentDir = path.join(targetDir, agent);

    // 1. 按 fileRules 复制文件到 <plugin>/<agent>/
    await copyWithFileRules(sourcePluginDir, agentDir, buildConfig.fileRules[agent]);

    // 2. 对匹配 templates.include 的文本文件执行模板替换
    await processTemplates(agentDir, buildConfig.templates, agent);

    // 3. 生成平台清单
    const platformManifest = buildPlatformManifest(manifest, agent, buildConfig);
    await writeJson(
      path.join(targetDir, `.${agent === 'claude' ? 'claude' : 'codex'}-plugin/plugin.json`),
      platformManifest,
    );
  }

  // 4. 复制共享资源到 shared/
  if (buildConfig.sharedDirs?.length) {
    for (const dir of buildConfig.sharedDirs) {
      await fs.copy(path.join(sourcePluginDir, dir), path.join(targetDir, 'shared', dir));
    }
  }

  // 5. 复制源清单
  await fs.copy(
    path.join(sourcePluginDir, '.agents-plugin'),
    path.join(targetDir, '.agents-plugin'),
  );
}
```

### 4.6 Manifest 验证扩展

**文件**: `packages/cli/src/utils/manifest.ts`

扩展 `validatePluginManifest()` 支持 `buildConfig` 字段验证：
- `templates.vars`: key 必须是字符串，value 必须是 `Record<'claude'|'codex', string|boolean>`
- `templates.include`: 必须是 glob 字符串数组
- `fileRules.<agent>.include/exclude`: 必须是 glob 字符串数组
- `manifestOverrides.<agent>`: 对象，字段与 PlatformPluginManifest 兼容

---

## Phase 5: aw install 流程重构

### 5.1 新的 install 流程

```
aw install git-commit --platform claude --scope project
  │
  ├─ 1. ensureLocalMarketplace()
  │     检查 ~/.aw/config.json 版本是否匹配
  │     不匹配 → 自动执行 aw init
  │
  ├─ 2. loadPluginsFromLocalMarketplace(pluginNames)
  │     从 ~/.aw/plugins/<name>/.agents-plugin/plugin.json 读取清单
  │
  ├─ 3. 检查 installed.json 避免重复安装
  │
  ├─ 4. resolveTargetPlatforms()（保持现有逻辑）
  │
  └─ 5. 按平台执行安装
        ├─ Claude:
        │   ├─ installPlugin()
        │   │   ├─ claude plugin marketplace add ~/.aw （幂等，检查 installed.json）
        │   │   └─ claude plugin install git-commit@aw --scope project
        │   ├─ installExtensions()
        │   │   └─ 仅处理 permissions（Claude 不原生支持的）
        │   └─ 更新 installed.json
        │
        └─ Codex:
            ├─ installPlugin()
            │   ├─ codex plugin marketplace add ~/.aw （幂等，检查 installed.json）
            │   └─ 写入 config.toml [plugins."git-commit@aw"] enabled=true
            ├─ installExtensions()
            │   └─ instructions（写入 config.toml）/permissions/hooks/agents
            └─ 更新 installed.json
```

### 5.2 新的 uninstall 流程

```
aw uninstall git-commit --platform claude
  │
  ├─ 1. 读取 installed.json 获取安装信息
  │
  ├─ Claude:
  │   ├─ claude plugin uninstall git-commit@aw
  │   ├─ 根据 installed.extensions 清理 permissions 等扩展产物
  │   └─ 从 installed.json 移除 claude 平台记录
  │
  └─ Codex:
      ├─ config.toml 中 [plugins."git-commit@aw"] enabled=false
      ├─ 根据 installed.extensions 清理 instructions（从 config.toml 移除标记段落）/permissions/hooks/agents
      └─ 从 installed.json 移除 codex 平台记录
```

### 5.3 upgrade 流程

```
aw upgrade [--all]
  │
  ├─ 1. npm update @yiliang/aw （用户手动执行或 aw 提示）
  ├─ 2. aw init --force （重新生成本地市场）
  ├─ 3. 读取 installed.json 获取已安装插件列表
  └─ 4. 对已安装的插件重新执行 installExtensions
```

---

## 涉及的关键文件清单

### 新建文件

| 文件 | 用途 |
|------|------|
| `packages/cli/src/commands/init.ts` | `aw init` 命令 |
| `packages/cli/src/generators/local-plugin.ts` | 本地插件定制化生成器（fileRules + templates + manifestOverrides） |
| `packages/cli/src/utils/exec.ts` | 子进程调用封装 |
| `packages/cli/src/utils/local-marketplace.ts` | ~/.aw 目录管理（读写 config.json、installed.json、marketplace 生成） |
| `packages/cli/src/utils/template-engine.ts` | 模板变量替换引擎（`{{var}}`、`{{#if}}`、`{{#unless}}`） |
| `packages/cli/scripts/bundle-plugins.js` | 构建时打包插件数据和 marketplace 清单 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `packages/cli/package.json` | 移除 private、添加 files/publishConfig、修改 build 脚本 |
| `packages/cli/src/index.ts` | 注册 `aw init` 命令 |
| `packages/cli/src/commands/install.ts` | 加入 ensureLocalMarketplace，从 ~/.aw 加载插件，更新 installed.json |
| `packages/cli/src/commands/uninstall.ts` | 基于 installed.json 卸载，精确清理扩展 |
| `packages/cli/src/commands/upgrade.ts` | 基于 installed.json 升级 |
| `packages/cli/src/commands/status.ts` | 从 installed.json 读取状态 |
| `packages/cli/src/commands/common.ts` | loadPluginsForCommand 改为从本地市场读取 |
| `packages/cli/src/adapters/claude.ts` | installPlugin 改为调用 claude CLI；installExtensions 精简为仅 permissions |
| `packages/cli/src/adapters/codex.ts` | installPlugin 改为调用 codex CLI + config.toml 启用；installExtensions 移除 AGENTS.md 写入 |
| `packages/cli/src/utils/paths.ts` | 新增 resolveEmbeddedPluginsRoot、resolveAwHome |
| `packages/cli/src/utils/manifest.ts` | 支持 buildConfig 字段验证 |
| `packages/cli/src/types.ts` | 新增 BuildConfig、FileRules、TemplateConfig、InstalledMetadata 等类型 |
| `.gitignore` | 添加 `packages/cli/plugins-dist` |
| `.claude-plugin/marketplace.json` | name 改为 `"aw"` |
| `.agents/plugins/marketplace.json` | name 改为 `"aw"` |

### 测试文件

| 文件 | 用途 |
|------|------|
| `packages/cli/tests/unit/init.test.ts` | init 命令单元测试 |
| `packages/cli/tests/unit/local-plugin-generator.test.ts` | 定制化生成器测试 |
| `packages/cli/tests/unit/file-rules.test.ts` | fileRules 包含/排除测试 |
| `packages/cli/tests/unit/template-engine.test.ts` | 模板引擎测试 |
| `packages/cli/tests/unit/installed-metadata.test.ts` | installed.json 读写测试 |
| `packages/cli/tests/integration/npm-install-flow.test.ts` | 完整安装流程集成测试 |

---

## 实施顺序

1. **Phase 1** (npm 发布改造): package.json、build 脚本、bundle-plugins.js、resolveEmbeddedPluginsRoot、marketplace name 改为 aw
2. **Phase 2** (~/.aw 本地市场): 目录结构（含 per-agent 子目录）、init 命令、installed.json、双份 marketplace.json 生成
3. **Phase 4** (定制化生成): buildConfig 机制（fileRules + templates + manifestOverrides）、模板引擎、local-plugin generator、Codex instructions 写入 config.toml
4. **Phase 3** (原生 CLI 安装): 适配器重构、execAsync、installed.json 驱动的幂等注册/安装/卸载
5. **Phase 5** (流程串联): install/uninstall/upgrade/status 命令对接新流程
6. **测试**: 单元测试 + 集成测试 + 手动验证

---

## 验证方式

沿用现有 Vitest 测试方案（临时工作区 + 夹具复制 + 环境变量隔离 + afterEach 清理）。

### 单元测试 (`pnpm test:unit`)

#### `tests/unit/template-engine.test.ts` — 模板引擎

```typescript
describe('template-engine', () => {
  it('replaces simple string variables', async () => {
    const result = processTemplate('Hello {{agent_name}}', { agent_name: 'Claude Code' });
    expect(result).toBe('Hello Claude Code');
  });

  it('handles {{#if}} blocks for truthy values', async () => {
    const tpl = '{{#if thinking}}use thinking{{/if}}';
    expect(processTemplate(tpl, { thinking: true })).toBe('use thinking');
    expect(processTemplate(tpl, { thinking: false })).toBe('');
  });

  it('handles {{#unless}} blocks', async () => {
    const tpl = '{{#unless thinking}}no thinking{{/unless}}';
    expect(processTemplate(tpl, { thinking: false })).toBe('no thinking');
  });

  it('preserves non-matching content unchanged', async () => {
    expect(processTemplate('no vars here', {})).toBe('no vars here');
  });
});
```

#### `tests/unit/file-rules.test.ts` — 文件包含/排除

```typescript
describe('file-rules', () => {
  it('copies only included files to agent directory', async () => {
    const src = await makeTempPluginDir(); // 含 skills/, commands/, agents/, config/
    const dst = path.join(await makeTempDir(), 'codex');

    await copyWithFileRules(src, dst, {
      include: ['skills/**', 'config/**'],
      exclude: [],
    });

    expect(await fs.pathExists(path.join(dst, 'skills', 'commit', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(dst, 'config', 'sample.mcp.json'))).toBe(true);
    expect(await fs.pathExists(path.join(dst, 'commands'))).toBe(false);
    expect(await fs.pathExists(path.join(dst, 'agents'))).toBe(false);
  });

  it('excludes files matching exclude patterns', async () => {
    const src = await makeTempPluginDir();
    const dst = path.join(await makeTempDir(), 'claude');

    await copyWithFileRules(src, dst, {
      include: ['skills/**', 'agents/**'],
      exclude: ['agents/reviewer.md'],
    });

    expect(await fs.pathExists(path.join(dst, 'agents'))).toBe(true);
    expect(await fs.pathExists(path.join(dst, 'agents', 'reviewer.md'))).toBe(false);
  });
});
```

#### `tests/unit/local-plugin-generator.test.ts` — 本地插件生成器

```typescript
describe('local-plugin-generator', () => {
  it('generates claude/ and codex/ directories with differentiated content', async () => {
    const src = fixturePath('repo-template', 'plugins', 'git-commit');
    const dst = path.join(await makeTempDir(), 'git-commit');

    await generateLocalPlugin(src, dst);

    // Claude 端有 commands 目录
    expect(await fs.pathExists(path.join(dst, 'claude', 'commands'))).toBe(true);
    // Codex 端无 commands 目录
    expect(await fs.pathExists(path.join(dst, 'codex', 'commands'))).toBe(false);
  });

  it('generates platform manifests with correct paths', async () => {
    const src = fixturePath('repo-template', 'plugins', 'git-commit');
    const dst = path.join(await makeTempDir(), 'git-commit');

    await generateLocalPlugin(src, dst);

    const claudeManifest = await fs.readJson(
      path.join(dst, '.claude-plugin', 'plugin.json'),
    );
    expect(claudeManifest.skills).toBe('./claude/skills');

    const codexManifest = await fs.readJson(
      path.join(dst, '.codex-plugin', 'plugin.json'),
    );
    expect(codexManifest.skills).toBe('./codex/skills');
  });

  it('applies manifestOverrides for claude-only fields', async () => {
    const src = fixturePath('repo-template', 'plugins', 'git-commit');
    const dst = path.join(await makeTempDir(), 'git-commit');

    await generateLocalPlugin(src, dst);

    const claudeManifest = await fs.readJson(
      path.join(dst, '.claude-plugin', 'plugin.json'),
    );
    expect(claudeManifest).toHaveProperty('commands');
    expect(claudeManifest).toHaveProperty('agents');

    const codexManifest = await fs.readJson(
      path.join(dst, '.codex-plugin', 'plugin.json'),
    );
    expect(codexManifest).not.toHaveProperty('commands');
    expect(codexManifest).not.toHaveProperty('agents');
  });

  it('applies template variables per agent', async () => {
    const src = fixturePath('repo-template', 'plugins', 'git-commit');
    const dst = path.join(await makeTempDir(), 'git-commit');

    await generateLocalPlugin(src, dst);

    const claudeSkill = await fs.readFile(
      path.join(dst, 'claude', 'skills', 'commit', 'SKILL.md'), 'utf-8',
    );
    expect(claudeSkill).toContain('Claude Code');
    expect(claudeSkill).not.toContain('{{agent_name}}');

    const codexSkill = await fs.readFile(
      path.join(dst, 'codex', 'skills', 'commit', 'SKILL.md'), 'utf-8',
    );
    expect(codexSkill).toContain('Codex');
  });
});
```

#### `tests/unit/installed-metadata.test.ts` — 安装元数据

```typescript
describe('installed-metadata', () => {
  it('records plugin installation for a platform', async () => {
    const awHome = await makeTempDir();
    const meta = createEmptyInstalledMetadata();

    await recordPluginInstallation(meta, 'git-commit', 'claude', 'project');
    await writeInstalledMetadata(awHome, meta);

    const saved = await readInstalledMetadata(awHome);
    expect(saved.plugins['git-commit'].platforms.claude).toMatchObject({
      scope: 'project',
    });
    expect(saved.plugins['git-commit'].platforms.claude.installedAt).toBeTruthy();
  });

  it('removes plugin platform record on uninstall', async () => {
    const awHome = await makeTempDir();
    const meta = createEmptyInstalledMetadata();
    await recordPluginInstallation(meta, 'git-commit', 'claude', 'project');
    await recordPluginInstallation(meta, 'git-commit', 'codex', 'user');

    await removePluginInstallation(meta, 'git-commit', 'claude');
    await writeInstalledMetadata(awHome, meta);

    const saved = await readInstalledMetadata(awHome);
    expect(saved.plugins['git-commit'].platforms).not.toHaveProperty('claude');
    expect(saved.plugins['git-commit'].platforms).toHaveProperty('codex');
  });

  it('removes plugin entry entirely when last platform removed', async () => {
    const awHome = await makeTempDir();
    const meta = createEmptyInstalledMetadata();
    await recordPluginInstallation(meta, 'git-commit', 'claude', 'project');

    await removePluginInstallation(meta, 'git-commit', 'claude');
    await writeInstalledMetadata(awHome, meta);

    const saved = await readInstalledMetadata(awHome);
    expect(saved.plugins).not.toHaveProperty('git-commit');
  });

  it('tracks marketplace registrations', async () => {
    const awHome = await makeTempDir();
    const meta = createEmptyInstalledMetadata();

    await updateMarketplaceRegistration(meta, 'claude', 'user');
    await writeInstalledMetadata(awHome, meta);

    const saved = await readInstalledMetadata(awHome);
    expect(saved.marketplaceRegistrations.claude).toMatchObject({ scope: 'user' });
  });
});
```

#### `tests/unit/build-config.test.ts` — buildConfig 验证

```typescript
describe('build-config validation', () => {
  it('accepts valid buildConfig with all fields', async () => {
    const manifest = await readPluginManifest(fixturePath('repo-template', 'plugins', 'git-commit'));
    expect(manifest.manifest.buildConfig).toBeDefined();
    expect(manifest.manifest.buildConfig.fileRules.claude.include).toContain('skills/**');
  });

  it('rejects invalid template var values', async () => {
    const repoRoot = await makeTempRepo();
    const manifestPath = path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.buildConfig = { templates: { vars: { bad: 'not-per-agent' }, include: [] } };
    await fs.writeJson(manifestPath, manifest);

    await expect(
      readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit')),
    ).rejects.toThrow();
  });

  it('rejects fileRules with unknown agent keys', async () => {
    const repoRoot = await makeTempRepo();
    const manifestPath = path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.buildConfig = { fileRules: { unknown: { include: ['**'] } } };
    await fs.writeJson(manifestPath, manifest);

    await expect(
      readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit')),
    ).rejects.toThrow();
  });
});
```

### 集成测试 (`pnpm test:integration`)

#### `tests/integration/init.test.ts` — aw init 完整流程

```typescript
describe('aw init', () => {
  it('initializes ~/.aw with marketplace manifests and plugin directories', async () => {
    const awHome = path.join(await makeTempDir(), '.aw');

    await initCommand({ awHome, force: false });

    // 双份 marketplace 入口
    await expect(
      fs.readJson(path.join(awHome, '.claude-plugin', 'marketplace.json')),
    ).resolves.toMatchObject({ name: 'aw' });
    await expect(
      fs.readJson(path.join(awHome, '.agents', 'plugins', 'marketplace.json')),
    ).resolves.toMatchObject({ name: 'aw' });

    // config.json
    await expect(
      fs.readJson(path.join(awHome, 'config.json')),
    ).resolves.toMatchObject({ sourcePackage: '@yiliang/aw' });

    // installed.json 初始为空
    await expect(
      fs.readJson(path.join(awHome, 'installed.json')),
    ).resolves.toMatchObject({ version: 1, plugins: {} });

    // 插件 per-agent 目录
    expect(await fs.pathExists(path.join(awHome, 'plugins', 'git-commit', 'claude', 'skills'))).toBe(true);
    expect(await fs.pathExists(path.join(awHome, 'plugins', 'git-commit', 'codex', 'skills'))).toBe(true);
  });

  it('skips when version matches and --force not set', async () => {
    const awHome = path.join(await makeTempDir(), '.aw');
    await initCommand({ awHome, force: false });
    const firstConfig = await fs.readJson(path.join(awHome, 'config.json'));

    await initCommand({ awHome, force: false });
    const secondConfig = await fs.readJson(path.join(awHome, 'config.json'));

    expect(secondConfig.initializedAt).toBe(firstConfig.initializedAt);
  });

  it('re-initializes when --force is set', async () => {
    const awHome = path.join(await makeTempDir(), '.aw');
    await initCommand({ awHome, force: false });
    const firstConfig = await fs.readJson(path.join(awHome, 'config.json'));

    await new Promise((r) => setTimeout(r, 10));
    await initCommand({ awHome, force: true });
    const secondConfig = await fs.readJson(path.join(awHome, 'config.json'));

    expect(secondConfig.initializedAt).not.toBe(firstConfig.initializedAt);
  });
});
```

#### `tests/integration/cli.test.ts` — install/uninstall 完整流程（扩展现有）

```typescript
describe('CLI integration (npm marketplace)', () => {
  it('installs plugin via claude CLI and updates installed.json', async () => {
    const { repoRoot, claudeHome, awHome } = await makeWorkspace();
    process.env.AW_CLAUDE_HOME = claudeHome;
    process.env.AW_HOME = awHome;
    process.env.AW_FORCE_CLAUDE_AVAILABLE = '1';

    await initCommand({ awHome });
    await installCommand(['git-commit'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'claude',
    });

    // installed.json 记录了安装
    const installed = await fs.readJson(path.join(awHome, 'installed.json'));
    expect(installed.plugins['git-commit'].platforms.claude).toMatchObject({
      scope: 'project',
    });
    expect(installed.marketplaceRegistrations.claude).toBeDefined();
  });

  it('installs plugin via codex CLI with instructions in config.toml', async () => {
    const { repoRoot, codexHome, awHome } = await makeWorkspace();
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_HOME = awHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';

    await initCommand({ awHome });
    await installCommand(['git-commit'], {
      cwd: repoRoot,
      scope: 'user',
      platform: 'codex',
    });

    // config.toml 包含 instructions（带标记）
    const configToml = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf-8');
    expect(configToml).toContain('# aw:git-commit');
    expect(configToml).toContain('[plugins."git-commit@aw"]');

    // installed.json 记录了安装和扩展类型
    const installed = await fs.readJson(path.join(awHome, 'installed.json'));
    expect(installed.plugins['git-commit'].platforms.codex.extensions).toContain('instructions');
  });

  it('uninstalls and cleans up codex instructions from config.toml', async () => {
    const { repoRoot, codexHome, awHome } = await makeWorkspace();
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_HOME = awHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';

    await initCommand({ awHome });
    await installCommand(['git-commit'], { cwd: repoRoot, scope: 'user', platform: 'codex' });
    await uninstallCommand(['git-commit'], { cwd: repoRoot, platform: 'codex' });

    // config.toml 不再包含插件 instructions
    const configToml = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf-8');
    expect(configToml).not.toContain('# aw:git-commit');

    // installed.json 已移除记录
    const installed = await fs.readJson(path.join(awHome, 'installed.json'));
    expect(installed.plugins).not.toHaveProperty('git-commit');
  });

  it('status reports installed plugins from installed.json', async () => {
    const { repoRoot, claudeHome, awHome } = await makeWorkspace();
    process.env.AW_CLAUDE_HOME = claudeHome;
    process.env.AW_HOME = awHome;
    process.env.AW_FORCE_CLAUDE_AVAILABLE = '1';

    await initCommand({ awHome });
    await installCommand(['git-commit'], { cwd: repoRoot, scope: 'project', platform: 'claude' });

    const status = await statusCommand([], { cwd: repoRoot, platform: 'claude' });
    expect(status.output).toContain('git-commit');
    expect(status.output).toContain('claude (project)');
  });
});
```

### 测试夹具更新

`tests/fixtures/repo-template/` 需扩展以支持新功能：

```
tests/fixtures/repo-template/
├── .claude-plugin/
│   └── marketplace.json          # name: "aw"
├── .agents/
│   └── plugins/
│       └── marketplace.json      # name: "aw" (镜像)
└── plugins/
    └── git-commit/
        ├── .agents-plugin/
        │   └── plugin.json       # 含 buildConfig（templates + fileRules + manifestOverrides）
        ├── skills/
        │   └── commit/
        │       └── SKILL.md      # 含 {{agent_name}} 等模板变量
        ├── commands/             # Claude 独有
        │   └── commit.md
        ├── agents/
        │   └── reviewer.md
        ├── hooks/
        │   └── hooks.json
        └── config/
            └── sample.mcp.json
```
