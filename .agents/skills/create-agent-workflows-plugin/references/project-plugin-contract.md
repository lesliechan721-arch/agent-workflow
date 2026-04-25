# 当前项目的插件契约

这份摘要只保留创建插件时反复会用到的约束。细节和推导过程来自：

- `docs/dev/plans/npm-plugin-marketplace-new.md`
- `docs/codex-plugins.md`
- `docs/codex-claude-code-extension-research.md`
- `packages/cli/src/utils/manifest.ts`
- `packages/cli/src/generators/local-plugin.ts`

## 三层目录角色

当前仓库把插件相关内容拆成三层：

1. 源码层
   - `plugins/marketplace-source.json`
   - `plugins/<name>/.agents-plugin/plugin.json`
   - `plugins/<name>/skills/**`、`hooks/**`、`agents/**`、配置文件等源码素材
2. embedded runtime bundle
   - `packages/cli/plugins-dist/**`
   - 由 `pnpm build` 生成，是 npm 包内唯一 runtime 真值
3. 本地 marketplace 镜像
   - `~/.aw/**`
   - 由 `aw init` 或 `ensureLocalMarketplace()` 复制和校验，不做二次生成

作者日常只维护源码层。embedded bundle 和 `~/.aw` 都不是手工编辑目标。

## 源码目录结构

新插件放在 `plugins/<name>/`，最小稳定结构如下：

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

如果插件需要额外源码素材，可以继续在源码目录下添加：

- `hooks/`
- `agents/`
- `config/`
- `commands/`
- `output-styles/`
- `lsp/`

但这些都属于源码输入，最终落点由 build 生成器决定。

## 唯一源 manifest

当前项目把 `plugins/<name>/.agents-plugin/plugin.json` 视为唯一源码 manifest。

创建或修改插件时，只改这份文件和它引用的源码素材。不要手改：

- repo root `.claude-plugin/marketplace.json`
- repo root `.agents/plugins/marketplace.json`
- 源码树 `plugins/<name>/.claude-plugin/plugin.json`
- 源码树 `plugins/<name>/.codex-plugin/plugin.json`

这些路径要么已经退出运行时角色，要么根本不该再出现在源码树里。

## marketplace 作者模型

marketplace metadata 分成两层：

- root metadata：`plugins/marketplace-source.json`
  - 当前正式字段只保留 `owner` 与 `interface.displayName`
- entry metadata：`plugins/<name>/.agents-plugin/plugin.json.marketplace`
  - 当前正式字段包括 `category`、`tags`、`strict`、`policy`

也就是说：

- `plugins/marketplace-source.json` 不是运行时 marketplace manifest
- 插件 entry 不能回头去写 repo root marketplace
- build 会基于这两层源码元数据重建两份 runtime marketplace manifest

## 共享字段约束

共享字段遵循 Codex 可解析的最窄子集：

- `skills` 使用单个字符串路径，例如 `./skills`
- `mcpServers` 使用单个字符串路径，例如 `./config/mcp-servers.json`
- `apps` 如需共用，也按单个字符串路径处理
- 路径必须以 `./` 开头
- 路径必须留在插件根目录内
- `interface` 只放展示信息，不是 capability 开关

## extensions 与 buildConfig 的分工

### `extensions`

`extensions` 描述需要在安装或运行期派生的跨平台能力：

- `extensions.instructions`
- `extensions.permissions`
- `extensions.hooks`
- `extensions.agents`

共享 `hooks` / `agents` 一律继续写在这里。不要新增顶层 `claude` block，也不要伪造 `manifestOverrides.claude.hooks` / `agents`。

### `buildConfig`

`buildConfig` 只负责 build 阶段的 bundle 生成差异：

- `templates`
- `fileRules`
- `manifestOverrides`

当前 `manifestOverrides.claude` 的白名单只有：

- `commands`
- `outputStyles`
- `lspServers`
- `userConfig`
- `channels`

换句话说，`buildConfig` 不是一个任意扩展的 Claude 私有逃生口。

## 运行时生成结果

`pnpm build` 后，生成器会把源码素材展开为 bundle：

- `packages/cli/plugins-dist/plugins/<name>/.agents-plugin/plugin.json`
- `packages/cli/plugins-dist/plugins/<name>/.claude-plugin/plugin.json`
- `packages/cli/plugins-dist/plugins/<name>/.codex-plugin/plugin.json`
- `packages/cli/plugins-dist/.claude-plugin/marketplace.json`
- `packages/cli/plugins-dist/.agents/plugins/marketplace.json`

随后 `aw init` 只会把这套 bundle 复制并校验到 `~/.aw`。

## Skill 触发配置

skill 的自动 / 手动触发不是共享 manifest 层的能力，而是各平台各自解释 skill 元数据：

- Codex 看 `agents/openai.yaml` 里的 `policy.allow_implicit_invocation`
- Claude Code 看 `SKILL.md` frontmatter 里的 `user-invocable` 和 `disable-model-invocation`

需要配触发方式时，不要只改一侧字段。先读 `references/skill-trigger-rules.md` 再落配置。

## 共享能力面和平台差异

共享插件层最稳的交集只有：

- `skills`
- `MCP`
- 少量 manifest 元数据

需要单独看平台差异的部分：

- Claude Code 插件原生支持 `agents`、`hooks`、`commands`、`LSP`
- Codex 插件运行时只稳定承认 `skills`、`MCP`、`apps`
- Codex 的 hooks、agent roles、repo-managed instructions 更接近配置层，不是插件原生能力

因此新插件应先把共享层做薄，再决定是否追加平台差异。

## 创建插件时最容易犯的错

- 把 `plugins/marketplace-source.json` 当成运行时 marketplace 去手改。
- 在源码树里创建 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`。
- 想靠 repo root marketplace 作为运行时真值，而不是走 build 产物和 `~/.aw`。
- 把 Claude 的 `user-invocable` / `disable-model-invocation` 当成 Codex 也会识别的字段。
- 直接给 `skills`、`mcpServers`、`apps` 写数组或对象，导致 Codex 解析失败。
- 共享 `hooks` / `agents` 没写 `extensions.*`，反而去滥用 `manifestOverrides`。
- 新增脚本时顺手写成 Python，导致技能变成依赖 Python 环境才能正常使用。
