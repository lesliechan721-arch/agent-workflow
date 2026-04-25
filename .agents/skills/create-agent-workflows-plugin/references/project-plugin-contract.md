# 当前插件契约

这份摘要只记录创建插件时经常要用到的代码约束。权威来源是当前实现：`packages/cli/src/types.ts`、`packages/cli/src/utils/manifest.ts`、`packages/cli/src/generators/local-plugin.ts`、`packages/cli/scripts/bundle-plugins.ts` 和平台适配器。不要把仓库里的历史材料当成当前约定。

## 三类目录

插件内容分成三类：

1. 作者维护的文件
   - `plugins/marketplace-source.json`
   - `plugins/<name>/.agents-plugin/plugin.json`
   - `plugins/<name>/skills/**`、配置文件和其他文件
2. embedded runtime bundle
   - `packages/cli/plugins-dist/**`
   - 由 `pnpm build` 生成，npm 包内的 runtime 数据以它为准
3. 本地 marketplace 镜像
   - `~/.aw/**`
   - 由 `aw init` 或安装流程复制和校验，不会再次生成

日常开发只改 `plugins/` 下的文件。embedded bundle 和 `~/.aw` 都不该手工编辑。

## 插件目录结构

最小稳定结构：

```text
plugins/<name>/
├── .agents-plugin/
│   └── plugin.json
└── skills/
    └── <skill-name>/
        ├── SKILL.md
        └── agents/
            └── openai.yaml
```

常见可选文件：

- `./.mcp.json` 或 `./config/mcp-servers.json`
- `./.app.json` 或 `./config/apps.json`
- `commands/`
- `output-styles/`
- `lsp/`
- 其他被 `buildConfig.fileRules` 明确包含的文件

这些文件只作为 build 输入，最终会被放到哪里由生成器决定。

## 唯一需要手动维护的 manifest

`plugins/<name>/.agents-plugin/plugin.json` 是唯一需要手动维护的 manifest。创建或修改插件时，只改这份文件和它引用到的文件。不要手改：

- 仓库根目录 `.claude-plugin/marketplace.json`
- 仓库根目录 `.agents/plugins/marketplace.json`
- 插件目录下的 `plugins/<name>/.claude-plugin/plugin.json`
- 插件目录下的 `plugins/<name>/.codex-plugin/plugin.json`
- `packages/cli/plugins-dist/**`
- `~/.aw/**`

## manifest 字段

允许的顶层字段只有：

- `name`
- `version`
- `description`
- `skills`
- `mcpServers`
- `apps`
- `marketplace`
- `interface`
- `extensions`
- `buildConfig`

`skills`、`mcpServers`、`apps` 都只能写成单个字符串路径，不能写数组或对象。路径必须以 `./` 开头，不能是绝对路径，也不能逃出插件根目录。插件目录里出现标准入口文件时，必须声明对应字段：`skills/` 对应 `skills`，`.mcp.json` 对应 `mcpServers`，`.app.json` 对应 `apps`。

## marketplace 写法

marketplace 元数据分两处写：

- 根级元数据：`plugins/marketplace-source.json`
  - 当前字段只接受 `owner` 与 `interface.displayName`
- 插件条目元数据：`plugins/<name>/.agents-plugin/plugin.json.marketplace`
  - 当前字段包括 `category`、`tags`、`strict`、`policy`

`plugins/marketplace-source.json` 不是运行时 marketplace manifest。创建单个插件时，通常不要改它。`pnpm build` 会根据这两处元数据重建 runtime marketplace manifest。

`marketplace` 条目字段：

- `category`: 非空字符串
- `tags`: 可选字符串数组，会 trim、去空、去重
- `strict`: boolean
- `policy.installation`: 非空字符串
- `policy.authentication`: 非空字符串
- `policy.products`: 可选字符串数组，会 trim、去空、去重

`interface` 只放展示信息，当前允许 `displayName`、`shortDescription`、`capabilities`，不要把它当运行时能力开关。

## extensions

`extensions` 描述安装或构建时要派生出的跨平台能力。共享的 `hooks` / `agents` 继续写在这里。不要新增顶层 `claude` block，也不要伪造 `manifestOverrides.claude.hooks` / `agents`。

当前生成结果：

- Codex instructions：安装时写入受管 `developer_instructions` block
- Claude instructions：安装时写入 `rules/<generated>.md`
- Codex permissions：安装时生成 `.rules` 文件
- Claude permissions：安装时合并到 `settings.awGenerated.permissions`
- Codex hooks：安装时只聚合 `event: "command"` 的 hook 到 `hooks.json`
- Claude hooks：build 时生成 `./claude/hooks/hooks.json`，并写进 Claude runtime manifest
- Codex agents：安装时生成 role TOML，当前不写 `tools`
- Claude agents：build 时生成 agent markdown，支持 `tools`

## buildConfig

`buildConfig` 只负责构建 bundle 时的平台差异，不是给平台私有字段开的通用出口。

- `templates.include`: 需要渲染的文本文件 glob
- `templates.vars`: 每个变量必须同时给出 `{ "claude": string|boolean, "codex": string|boolean }`
- `fileRules.claude` / `fileRules.codex`: 额外复制到对应平台 bundle 的 include/exclude glob
- `manifestOverrides.claude`: 只允许 `commands`、`outputStyles`、`lspServers`、`userConfig`、`channels`
- `manifestOverrides.codex`: 当前只允许空对象

模板只渲染 `.md`、`.markdown`、`.txt`、`.json`、`.yaml`、`.yml`、`.toml`、`.rules` 等文本文件，语法支持 `{{var}}`、`{{#if var}}...{{/if}}`、`{{#unless var}}...{{/unless}}`。

## 运行时生成结果

运行 `pnpm build` 后，生成器会把作者维护的文件展开为 bundle：

- `packages/cli/plugins-dist/plugins/<name>/.agents-plugin/plugin.json`
- `packages/cli/plugins-dist/plugins/<name>/.claude-plugin/plugin.json`
- `packages/cli/plugins-dist/plugins/<name>/.codex-plugin/plugin.json`
- `packages/cli/plugins-dist/.claude-plugin/marketplace.json`
- `packages/cli/plugins-dist/.agents/plugins/marketplace.json`

随后 `aw init` 或安装流程会把这套 bundle 复制到 `~/.aw` 并做校验。

## Skill 触发配置

skill 的自动 / 手动触发不属于共享 manifest 能力，而是由各平台分别解释 skill 元数据：

- Codex 看 `agents/openai.yaml` 里的 `policy.allow_implicit_invocation`
- Claude Code 看 `SKILL.md` frontmatter 里的 `user-invocable` 和 `disable-model-invocation`

需要调整触发方式时，不要只改其中一侧。

## 共享能力面和平台差异

共享插件层里比较稳定的能力：

- `skills`
- `MCP`
- `apps`
- 少量 manifest 展示信息

平台差异：

- Claude Code 插件原生支持 `agents`、`hooks`、`commands`、LSP 等 manifest 能力
- Codex 的 native plugin manifest 目前稳定识别 `skills`、`MCP`、`apps`
- Codex hooks、agent roles、repo-managed instructions 由适配器在安装期写入配置层

新插件先把共享层保持精简，再决定是否追加平台差异。

## 常见错误

- 把 `plugins/marketplace-source.json` 当成运行时 marketplace 去手改。
- 在插件目录里创建 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`。
- 想把仓库根目录 marketplace 当成运行时依据，绕过 build 产物和 `~/.aw`。
- 把 Claude 的 `user-invocable` / `disable-model-invocation` 当成 Codex 也会识别的字段。
- 直接给 `skills`、`mcpServers`、`apps` 写数组或对象。
- 共享 `hooks` / `agents` 没写 `extensions.*`，反而去滥用 `manifestOverrides`。
- 新增脚本时顺手写成 Python，导致这个技能必须依赖 Python 环境才能正常使用。
