---
name: create-agent-workflows-plugin
description: 当用户明确要在 `agent-workflows` 仓库新增或维护 `plugins/<name>/` 插件项目时使用；涵盖 manifest 编写、能力选择与配置、extensions、buildConfig、公共 slashCommands、MCP/Apps 集成、Claude 专属能力和 bundle 校验。
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

### 场景 C：混合型 / 公共 slashCommands / Claude 专属能力

包含 skill + MCP + 公共 slashCommands + output styles 等多种能力，或需要 `buildConfig`。

```text
plugins/<name>/
├── .agents-plugin/plugin.json
├── skills/<skill-name>/
│   ├── SKILL.md
│   └── agents/openai.yaml          # 面向 Codex 时必需；Claude-only skill 可省略
├── .mcp.json
├── slash-commands/
│   └── *.md
└── output-styles/
    └── *.md
```

**先读**：场景 A 或 B 的路径 + `references/mcp-and-apps.md` + `references/build-config-spec.md` + `references/slash-commands.md` + `references/claude-only-capabilities.md`

### 场景 D：带 AW Config / Lifecycle / 脚本测试的插件

插件需要安装初始化、卸载清理、跨 Claude/Codex 共享配置，或需要为配置 helper/lifecycle 写 Node 测试时使用。

```text
plugins/<name>/
├── .agents-plugin/plugin.json
└── scripts/
    ├── aw-config.mjs
    ├── lifecycle.mjs
    └── *.test.mjs
```

**先读**：`references/aw-scripts-config-lifecycle.md` → `references/plugin-manifest-spec.md` 的 `scripts / config block`。可用脚手架 `--with-config-api` / `--with-lifecycle` 生成样板。

## 能力速查

| 能力 | 平台 | 配置位置 | 细节 |
|------|------|----------|------|
| Skills | 双平台 | `skills/`、`SKILL.md`、`agents/openai.yaml` | `references/skills-and-triggers.md` |
| Extensions | 双平台 | `extensions.instructions` / `permissions` / `hooks` / `nativeHooks` / `agents` | `references/extensions-spec.md` |
| MCP Servers | 双平台 | `.mcp.json` + manifest `mcpServers` | `references/mcp-and-apps.md` |
| Apps | Codex | `.app.json` + manifest `apps` | `references/mcp-and-apps.md` |
| Public Slash Commands | 双平台 | `slashCommands`、`slash-commands/`、`slash-commands/assets/` | `references/slash-commands.md` |
| Claude 专属能力 | Claude | `output-styles/`、`buildConfig.manifestOverrides.claude` | `references/claude-only-capabilities.md` |
| Build Config | 双平台 | `buildConfig.templates` / `fileRules` / `manifestOverrides` | `references/build-config-spec.md` |
| AW Scripts / Config / Lifecycle | 双平台 | `scripts` / `config`、`scripts/aw-config.mjs`、`scripts/lifecycle.mjs`、`scripts/**/*.test.mjs` | `references/aw-scripts-config-lifecycle.md` |

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
   - Public slashCommands → 创建 `slash-commands/*.md`；Claude 生成原生 `/command`，Codex 生成 manual-only skill，图标只能引用 `./assets/...`
   - Claude 专属 → 创建对应目录 + 配置 `buildConfig`
   - AW Config / Lifecycle → 先读 `references/aw-scripts-config-lifecycle.md`，再在 manifest 声明 `config.schema`、`scripts.helpers.config`、`scripts.lifecycle` 和 `scripts.tests.node`
6. **构建**：运行 `pnpm build` 生成 runtime bundle 到 `packages/cli/plugins-dist/`。
7. **验证**：运行 `scripts/validate_plugin.js` 校验插件结构。构建后会复用 CLI 的权威源码 contract 校验；未构建时只做轻量预检，预检通过不代表完整 contract 通过。`SKILL.md` frontmatter、TODO 占位和 `agents/openai.yaml` schema 仍属于作者工具体验检查。
8. **测试**：插件内 Node 脚本用 `pnpm plugin:test <plugin>`；改到 manifest、bundle 或安装逻辑时，再运行相关 `pnpm test:*`。

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
  [--with-config-api] \
  [--with-lifecycle] \
  [--version 0.1.0] \
  [--repo-root .]
```

- 默认创建带 skill 的插件骨架
- `--display-name` / `--short-description` 只写入插件级 `interface`；初始 skill 的 Codex 展示名默认由 `--skill-name` 推导，展示简述优先使用 `--skill-description`
- `--no-skills`：创建不含 skill 的插件（不需要 `--skill-name` 和 `--skill-description`）
- `--with-mcp` / `--with-apps`：创建 `.mcp.json` / `.app.json` 存根；细节见 `references/mcp-and-apps.md`
- `--with-config-api`：添加 AW 自管 `config.schema`、标准 `scripts.helpers.config` helper 和 Node 脚本测试样板
- `--with-lifecycle`：添加 Node lifecycle 样板和 Node 脚本测试样板
- 默认省略 `marketplace.policy.products`，让插件保持双平台可安装；声明后 `aw install` / 显式 `aw upgrade` 会拦截不匹配的平台
- 默认不生成 `skillTriggers`，因此新 skill 不允许安装时覆盖触发策略；确实需要时再在 manifest 里显式添加 `allowInstallOverride`
- 不改 `plugins/marketplace-source.json`，不生成平台 manifest

## 最小检查

- `.agents-plugin/plugin.json` 是唯一手动维护的 manifest；不要手写 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`。
- `skills`、`mcpServers`、`apps` 只能写单个 `./` 开头的路径，且声明的路径必须存在。
- 手动触发命令只使用公共 `slashCommands`。
- `slashCommands` 的 Codex 结果固定 manual-only，不能配置 `codex.policy`；Codex 图标资源只能来自 `slash-commands/assets/` 并写成 `./assets/...`。
- `plugins/marketplace-source.json` 通常不随单个插件改动；`packages/cli/plugins-dist/` 和 `~/.aw/` 都是生成或运行时目录，不手改。
- 面向 Codex 的 skill 必须带 `agents/openai.yaml`，并显式写出 `policy.allow_implicit_invocation`。
- 改到 manifest、bundle 或安装逻辑时，先跑 `pnpm build`，再跑相关 `pnpm test:*`。
- 插件内 Node 脚本测试通过仓库包脚本 `pnpm plugin:test <plugin>` 运行，不通过 `aw` 客户端子命令。
- lifecycle 支持 Node 和受控 shell 文件，不支持内联 shell 命令；Windows 优先写 Node 入口，或单独提供 `.ps1` / `.cmd`。
- Node lifecycle/helper/test 默认只能使用 `node:` 内置模块和插件内相对 import。需要第三方依赖时声明 `scripts.node.packageRoot`，提交 `package.json` 和 `pnpm-lock.yaml`，并只使用 registry-backed 依赖；运行时依赖离线随 bundle 携带。
- manifest build 只能通过 `scripts.node.build` 显式触发，并运行在隔离 staging 目录；不要期待 `package.json` scripts 或 npm lifecycle 自动执行，也不要依赖源码树被回写。

## 脚本测试入口

```bash
pnpm plugin:test <plugin>
pnpm plugin:test <plugin> --platform both --scope project
pnpm plugin:test --all
```

`pnpm plugin:test` 会先编译 CLI，再运行已编译 runner。它会为目标插件准备临时 bundle、隔离 `AW_HOME` 和受管临时 project root，然后执行 `scripts.tests.node` 匹配到的 Node 测试。没有匹配测试时是 skipped/no-op，退出码为 0；单插件模式不会被其它插件的坏 manifest 或测试失败阻断。`--platform both` 会分 Codex/Claude 两轮复制独立可写 bundle。测试中的 `AW_PLUGIN_CONTEXT.sourceRoot` 指向原始源码根，适合读取源码 fixture；实际运行时入口和 helper 应从临时 bundle import。更完整的 context、helper 和 config store 规则见 `references/aw-scripts-config-lifecycle.md`。

更细的能力矩阵、平台差异、命令结果填充和长 checklist 都在下方参考文档里，按场景加载即可。

## 参考文档索引

| 文档 | 覆盖范围 |
|------|---------|
| `references/plugin-manifest-spec.md` | plugin.json 完整字段规范、marketplace、interface、三层分发模型 |
| `references/skills-and-triggers.md` | Skills 目录结构、SKILL.md 规范、命令结果填充、agents/openai.yaml、双平台触发配置 |
| `references/extensions-spec.md` | instructions / permissions / 公共 hooks / nativeHooks / agents + agentOverrides 机制 |
| `references/build-config-spec.md` | templates 模板渲染 / fileRules 平台文件规则 / manifestOverrides 覆盖 |
| `references/mcp-and-apps.md` | .mcp.json 和 .app.json 配置格式与平台行为 |
| `references/slash-commands.md` | 公共 slashCommands 源码格式、分平台 frontmatter、生成产物和限制 |
| `references/aw-scripts-config-lifecycle.md` | AW config CLI、标准 config helper、lifecycle context、脚本测试和排障 |
| `references/claude-only-capabilities.md` | Claude 命令结果填充 / output-styles / lspServers / userConfig / channels |
| `references/comprehensive-example.md` | 综合示例说明 + 构建产物预览 |
| `references/.examples/code-review/` | 可直接读取的完整示例插件目录（隐藏父目录用于避免被 Codex 当作 repo skill） |

## 现有样例

- `references/.examples/code-review/`：覆盖 skills、slashCommands、extensions、MCP、output-styles、buildConfig、AW config、lifecycle 和 plugin:test 的完整示例插件目录。这里故意把样例放在隐藏父目录下，避免 Codex 递归扫描到示例里的 `SKILL.md` 并把它当成当前仓库的真实 skill
