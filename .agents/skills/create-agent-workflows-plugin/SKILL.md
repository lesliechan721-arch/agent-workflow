---
name: create-agent-workflows-plugin
description: 当用户明确要在 `agent-workflows` 仓库新增或维护 `plugins/<name>/` 插件项目时使用；涵盖 manifest 编写、能力选择与配置、extensions、buildConfig、MCP/Apps 集成、Claude 专属能力和 bundle 校验。
disable-model-invocation: true
---

# Create Agent Workflows Plugin

在当前仓库创建或维护同时支持 Codex 和 Claude Code 的双平台插件。这里描述的是 `agent-workflows` 源码层公共 contract，不是 Claude Code / Codex 原生插件 schema 的全集。插件作者只需维护 `plugins/<name>/` 下的源码文件；运行时 bundle 和本地 marketplace 镜像由 CLI 自动生成。

## 快速开始

按你要创建的插件类型，选择最短阅读路径。唯一必需的文件始终只有 `.agents-plugin/plugin.json`。

### 场景 A：纯 Skill 插件（最常见）

只提供一个可调用的工作流，无额外规则注入。

```text
plugins/<name>/
├── .agents-plugin/plugin.json
└── skills/<skill-name>/
    ├── SKILL.md
    └── agents/openai.yaml
```

**先读**：`references/plugin-manifest-spec.md` → `references/skills-and-triggers.md`

### 场景 B：纯 Extensions 插件

只注入规则、权限、hooks 或 agents，无 skill。

```text
plugins/<name>/
└── .agents-plugin/plugin.json        # extensions 声明在 manifest 内
```

**先读**：`references/plugin-manifest-spec.md` → `references/extensions-spec.md`

### 场景 C：混合型 / Claude 专属能力

包含 skill + MCP + commands 等多种能力，或需要 `buildConfig`。

```text
plugins/<name>/
├── .agents-plugin/plugin.json
├── skills/<skill-name>/
│   ├── SKILL.md
│   └── agents/openai.yaml
├── .mcp.json
├── commands/
│   └── *.md
└── output-styles/
    └── *.md
```

**先读**：场景 A 或 B 的路径 + `references/build-config-spec.md` + `references/claude-only-capabilities.md`

## 创建工作流

1. **确认命名**：插件名使用小写短横线格式（如 `code-review`），必须与目录名一致。
2. **选择能力组合**：参考上方场景或下方能力清单，确定需要哪些能力。
3. **脚手架**（可选）：新建插件先跑 `scripts/init_plugin.js`（见下方）；维护已有插件先读 `.agents-plugin/plugin.json`。
4. **编辑 manifest**：按需补齐 `.agents-plugin/plugin.json` 字段。字段规范见 `references/plugin-manifest-spec.md`。
5. **实现各能力**：
   - Skills → 编写 `SKILL.md` 和 `agents/openai.yaml`，配置触发策略
   - Extensions → 在 manifest 的 `extensions` 中声明
   - MCP/Apps → 创建 `.mcp.json` / `.app.json`
   - Claude 专属 → 创建对应目录 + 配置 `buildConfig`
6. **构建**：运行 `pnpm build` 生成 runtime bundle 到 `packages/cli/plugins-dist/`。
7. **验证**：运行 `scripts/validate_plugin.js` 校验插件结构。构建后会复用 CLI 的权威源码 contract 校验；未构建时只做轻量预检，预检通过不代表完整 contract 通过。`SKILL.md` frontmatter、TODO 占位和 `agents/openai.yaml` 仍属于作者工具体验检查。
8. **测试**：改到 manifest、bundle 或安装逻辑时，至少运行 `pnpm test` 相关用例。

## 脚手架脚本

```bash
node .agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js <plugin-name> \
  --description "插件描述" \
  --display-name "Display Name" \
  --short-description "简短描述" \
  [--skill-name <name>] \
  [--skill-description "skill 描述"] \
  [--no-skills] \
  [--with-mcp] \
  [--with-apps] \
  [--version 0.1.0] \
  [--repo-root .]
```

- 默认创建带 skill 的插件骨架
- `--no-skills`：创建不含 skill 的插件（不需要 `--skill-name` 和 `--skill-description`）
- `--with-mcp`：同时创建 `.mcp.json` 存根
- `--with-apps`：同时创建带示例 connector id 的最小 `.app.json`，作者需要替换成真实 id
- 不改 `plugins/marketplace-source.json`，不生成平台 manifest

## 完整参考

### 插件能力清单

| 能力 | 适用平台 | 配置位置 | 参考文档 |
|------|---------|---------|---------|
| Skills | 双平台 | `skills/` 目录 + `SKILL.md` + `agents/openai.yaml` | `references/skills-and-triggers.md` |
| Instructions | 双平台 | `extensions.instructions` | `references/extensions-spec.md` |
| Permissions | 双平台 | `extensions.permissions` | `references/extensions-spec.md` |
| Hooks | 双平台 | `extensions.hooks` | `references/extensions-spec.md` |
| Agents | 双平台 | `extensions.agents` | `references/extensions-spec.md` |
| MCP Servers | 双平台 | `.mcp.json` + manifest `mcpServers` 字段 | `references/mcp-and-apps.md` |
| Apps | Codex | `.app.json` + manifest `apps` 字段 | `references/mcp-and-apps.md` |
| Commands | Claude | `commands/` 目录 + `manifestOverrides` | `references/claude-only-capabilities.md` |
| Output Styles | Claude | `output-styles/` 目录 + `manifestOverrides` | `references/claude-only-capabilities.md` |
| LSP Servers | Claude | `manifestOverrides.claude.lspServers` | `references/claude-only-capabilities.md` |
| User Config | Claude | `manifestOverrides.claude.userConfig` | `references/claude-only-capabilities.md` |
| Channels | Claude | `manifestOverrides.claude.channels` | `references/claude-only-capabilities.md` |
| Template 渲染 | 双平台 | `buildConfig.templates` | `references/build-config-spec.md` |
| 平台文件规则 | 双平台 | `buildConfig.fileRules` | `references/build-config-spec.md` |

> **命令结果填充（Claude Code 专属）**：`commands` 和 `skills` 的 Markdown 文件支持 `` !`command` `` 行内语法和 `` ```! `` 代码块语法，在加载时执行 shell 命令并将输出内联到 prompt。Codex 不支持。详见 `references/claude-only-capabilities.md` § 命令结果填充。

插件不要求包含所有能力——按需选择。

### 文件组织规约

- 命名：插件名、skill 名、extension 名都用小写短横线格式
- 路径：`skills`、`mcpServers`、`apps` 字段只能是单个 `./` 开头的字符串
- 生成文件前缀：CLI 生成的文件统一以 `aw-` 开头（`GENERATED_FILE_PREFIX`）
- 三层分发：源码层 → Embedded Runtime Bundle → 本地 Marketplace 镜像

### 验证清单

- [ ] `.agents-plugin/plugin.json` 是唯一手动维护的 manifest
- [ ] manifest 已包含 `marketplace` block（category、strict、policy 必填）
- [ ] `plugins/marketplace-source.json` 未被无关改写
- [ ] 插件目录里没有 `.claude-plugin/` 或 `.codex-plugin/` 目录
- [ ] 声明的路径（skills、mcpServers、apps）都实际存在
- [ ] Skills（如有）：`SKILL.md` 无 TODO 占位符，已写入真实工作流
- [ ] Skills（如有）：`agents/openai.yaml` 已明确 Codex 触发策略
- [ ] MCP（如有）：`.mcp.json` 含有效的 `mcpServers` 配置
- [ ] Apps（如有）：`.app.json` 含有效的 `apps` 配置
- [ ] Extensions（如有）：各数组中条目的 `name` 不重复
- [ ] Claude 专属能力（如有）：`buildConfig` 中 fileRules 和 manifestOverrides 配合正确
- [ ] `pnpm build` 能生成 `packages/cli/plugins-dist/plugins/<name>/`
- [ ] 改到 manifest、bundle 或安装逻辑时，至少运行对应的 `pnpm test:*`

### 禁止操作

- 不要手改 `packages/cli/plugins-dist`、`~/.aw`、仓库根目录 marketplace manifest
- 不要在插件目录里手写 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`
- 不要给 `skills`、`mcpServers`、`apps` 写数组或对象
- 不要把 hooks / agents 塞进 `buildConfig.manifestOverrides`
- 不要混用平台触发字段（Claude 的 `user-invocable` 不影响 Codex，反之亦然）

## 参考文档索引

| 文档 | 覆盖范围 |
|------|---------|
| `references/plugin-manifest-spec.md` | plugin.json 完整字段规范、marketplace、interface、三层分发模型 |
| `references/skills-and-triggers.md` | Skills 目录结构、SKILL.md 规范、命令结果填充、agents/openai.yaml、双平台触发配置 |
| `references/extensions-spec.md` | instructions / permissions / hooks / agents 四种 extension + agentOverrides 机制 |
| `references/build-config-spec.md` | templates 模板渲染 / fileRules 平台文件规则 / manifestOverrides 覆盖 |
| `references/mcp-and-apps.md` | .mcp.json 和 .app.json 配置格式与平台行为 |
| `references/claude-only-capabilities.md` | commands（含命令结果填充）/ output-styles / lspServers / userConfig / channels |
| `references/comprehensive-example.md` | 综合示例说明 + 构建产物预览 |
| `references/code-review/` | 可直接读取的完整示例插件目录（code-review） |

## 现有样例

- `plugins/git-commit/`：skills + extensions 四种类型的简单示例
- `references/code-review/`：覆盖 skills、extensions、MCP、commands、output-styles、buildConfig 的完整示例插件目录，配合 `references/comprehensive-example.md` 阅读
