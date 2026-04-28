---
name: create-agent-workflows-plugin
description: 当用户明确要在 `agent-workflows` 仓库新增或维护 `plugins/<name>/` 插件项目时使用；涵盖 manifest 编写、能力选择与配置、extensions、buildConfig、MCP/Apps 集成、Claude 专属能力和 bundle 校验。
disable-model-invocation: true
---

# Create Agent Workflows Plugin

在当前仓库创建或维护同时支持 Codex 和 Claude Code 的双平台插件。这里描述的是 `agent-workflows` 源码层公共 contract，不是 Claude Code / Codex 原生插件 schema 的全集。插件作者只需维护 `plugins/<name>/` 下的源码文件；运行时 bundle 和本地 marketplace 镜像由 CLI 自动生成。

## 快速开始

按你要创建的插件类型，选择最短阅读路径。所有插件都必须有 `.agents-plugin/plugin.json`；如果包含面向 Codex 的 skill，还需要对应的 `SKILL.md` 和 `agents/openai.yaml`。

### 场景 A：纯 Skill 插件（最常见）

只提供一个可调用的工作流，无额外规则注入。

```text
plugins/<name>/
├── .agents-plugin/plugin.json
└── skills/<skill-name>/
    ├── SKILL.md
    └── agents/openai.yaml          # 面向 Codex 时必需；Claude-only skill 可省略
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
│   └── agents/openai.yaml          # 面向 Codex 时必需；Claude-only skill 可省略
├── .mcp.json
├── commands/
│   └── *.md
└── output-styles/
    └── *.md
```

**先读**：场景 A 或 B 的路径 + `references/mcp-and-apps.md` + `references/build-config-spec.md` + `references/claude-only-capabilities.md`

## 能力速查

| 能力 | 平台 | 配置位置 | 细节 |
|------|------|----------|------|
| Skills | 双平台 | `skills/`、`SKILL.md`、`agents/openai.yaml` | `references/skills-and-triggers.md` |
| Extensions | 双平台 | `extensions.instructions` / `permissions` / `hooks` / `nativeHooks` / `agents` | `references/extensions-spec.md` |
| MCP Servers | 双平台 | `.mcp.json` + manifest `mcpServers` | `references/mcp-and-apps.md` |
| Apps | Codex | `.app.json` + manifest `apps` | `references/mcp-and-apps.md` |
| Claude 专属能力 | Claude | `commands/`、`output-styles/`、`manifestOverrides.claude` | `references/claude-only-capabilities.md` |
| Build Config | 双平台 | `buildConfig.templates` / `fileRules` / `manifestOverrides` | `references/build-config-spec.md` |

插件不需要包含所有能力；先按场景选组合，再打开对应参考文档补字段细节。

## 创建工作流

1. **确认命名**：插件名使用小写短横线格式（如 `code-review`），必须与目录名一致。
2. **选择能力组合**：参考上方场景和能力速查，确定需要哪些能力。
3. **脚手架**（可选）：新建插件先跑 `scripts/init_plugin.js`（见下方）；维护已有插件先读 `.agents-plugin/plugin.json`。
4. **编辑 manifest**：按需补齐 `.agents-plugin/plugin.json` 字段。字段规范见 `references/plugin-manifest-spec.md`。
5. **实现各能力**：
   - Skills → 编写 `SKILL.md`；面向 Codex 的 skill 同时提供 `agents/openai.yaml`，配置触发策略
   - Extensions → 在 manifest 的 `extensions` 中声明
   - MCP/Apps → 创建 `.mcp.json` / `.app.json`
   - Claude 专属 → 创建对应目录 + 配置 `buildConfig`
6. **构建**：运行 `pnpm build` 生成 runtime bundle 到 `packages/cli/plugins-dist/`。
7. **验证**：运行 `scripts/validate_plugin.js` 校验插件结构。构建后会复用 CLI 的权威源码 contract 校验；未构建时只做轻量预检，预检通过不代表完整 contract 通过。`SKILL.md` frontmatter、TODO 占位和 `agents/openai.yaml` schema 仍属于作者工具体验检查。
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
- `--display-name` / `--short-description` 只写入插件级 `interface`；初始 skill 的 Codex 展示名默认由 `--skill-name` 推导，展示简述优先使用 `--skill-description`
- `--no-skills`：创建不含 skill 的插件（不需要 `--skill-name` 和 `--skill-description`）
- `--with-mcp` / `--with-apps`：创建 `.mcp.json` / `.app.json` 存根；细节见 `references/mcp-and-apps.md`
- 默认省略 `marketplace.policy.products`，让插件保持双平台可见；需要限制平台时再手动声明
- 默认不生成 `skillTriggers`，因此新 skill 不允许安装时覆盖触发策略；确实需要时再在 manifest 里显式添加 `allowInstallOverride`
- 不改 `plugins/marketplace-source.json`，不生成平台 manifest

## 最小检查

- `.agents-plugin/plugin.json` 是唯一手动维护的 manifest；不要手写 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`。
- `skills`、`mcpServers`、`apps` 只能写单个 `./` 开头的路径，且声明的路径必须存在。
- `plugins/marketplace-source.json` 通常不随单个插件改动；`packages/cli/plugins-dist/` 和 `~/.aw/` 都是生成或运行时目录，不手改。
- 面向 Codex 的 skill 必须带 `agents/openai.yaml`，并显式写出 `policy.allow_implicit_invocation`。
- 改到 manifest、bundle 或安装逻辑时，先跑 `pnpm build`，再跑相关 `pnpm test:*`。

更细的能力矩阵、平台差异、命令结果填充和长 checklist 都在下方参考文档里，按场景加载即可。

## 参考文档索引

| 文档 | 覆盖范围 |
|------|---------|
| `references/plugin-manifest-spec.md` | plugin.json 完整字段规范、marketplace、interface、三层分发模型 |
| `references/skills-and-triggers.md` | Skills 目录结构、SKILL.md 规范、命令结果填充、agents/openai.yaml、双平台触发配置 |
| `references/extensions-spec.md` | instructions / permissions / 公共 hooks / nativeHooks / agents + agentOverrides 机制 |
| `references/build-config-spec.md` | templates 模板渲染 / fileRules 平台文件规则 / manifestOverrides 覆盖 |
| `references/mcp-and-apps.md` | .mcp.json 和 .app.json 配置格式与平台行为 |
| `references/claude-only-capabilities.md` | commands（含命令结果填充）/ output-styles / lspServers / userConfig / channels |
| `references/comprehensive-example.md` | 综合示例说明 + 构建产物预览 |
| `references/code-review/` | 可直接读取的完整示例插件目录（code-review） |

## 现有样例

- `references/code-review/`：覆盖 skills、extensions、MCP、commands、output-styles、buildConfig 的完整示例插件目录，配合 `references/comprehensive-example.md` 阅读
