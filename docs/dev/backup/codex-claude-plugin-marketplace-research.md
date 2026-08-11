# Codex 与 Claude Code Git 插件市场调研

> 历史文档
> 适用背景：本文记录的是项目尚未落地 npm embedded bundle 与 `~/.aw` 本地市场之前的前期调研。
> 失效说明：文中把 repo root marketplace、源码树 `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` 当当前推荐路径的部分已经失效。
> 当前方案：请以 [docs/dev/plans/npm-plugin-marketplace-new.md](plans/npm-plugin-marketplace-new.md) 和 [docs/dev/todos/npm-plugin-marketplace-new.md](todos/npm-plugin-marketplace-new.md) 为准。

本文只聚焦一件事：

- 把当前项目做成一个可被 `Codex` 和 `Claude Code` 消费的 `Git plugin marketplace`

能力面交集、扩展边界这部分，已有文档可参考：

- `docs/codex-plugins.md`
- `docs/codex-claude-code-extension-research.md`

本次调研使用的源码：

- Codex: `/Users/LeslieChan/Desktop/codex/codex-rs`
- Claude Code: `/Users/LeslieChan/Desktop/claude-code-source-code/src`

## 结论先行

当前项目里真正适合承载这份调研文档的是 `agent-workflows/`。它现在只有 `docs/`，还没有任何插件市场必需的 manifest 和插件目录，所以现状还不能被任何一端当成 marketplace 使用。

如果目标是“一个 Git 仓库，同时给 Codex 和 Claude Code 当插件市场”，这件事是可行的，但要接受两个事实：

- 仓库层的市场入口可以基本共用
- 用户侧接入配置不能共用，两个 agent 的登记方式完全不同

最稳的做法是：

1. 仓库根增加 `plugins/`
2. 仓库根增加 `.claude-plugin/marketplace.json`
3. 同步放一份 `.agents/plugins/marketplace.json` 给 Codex 走原生约定
4. 每个插件目录至少放 `.claude-plugin/plugin.json`
5. 如果希望兼容 Codex 自己的脚手架和目录习惯，再补 `.codex-plugin/plugin.json`

如果你希望一份 `marketplace.json` 同时被两边读取，真正要控制的是“共享字段的最小交集”：

- 本地插件 source 用字符串相对路径：`"./plugins/<name>"`
- 远程 git 插件 source 用 `url` 或 `git-subdir`
- 不要在共享 marketplace 里用 Claude 专属的 `github` / `npm` / `pip` source
- `plugin.json` 里与 Codex 重名的字段，值类型要按 Codex 的窄模型来写

## 当前项目现状

`<workspace>/llm-agent` 是一个多项目目录。和这次调研最相关的是：

- `<workspace>/llm-agent/agent-workflows`

这个目录目前只有：

- `.git/`
- `docs/`

它还缺少下面这些关键文件：

- `.claude-plugin/marketplace.json`
- `.agents/plugins/marketplace.json`
- `plugins/<plugin-name>/...`
- `plugins/<plugin-name>/.claude-plugin/plugin.json`

所以如果你要把“当前项目”做成 Git marketplace，本质上是在 `agent-workflows/` 里从零补一套市场仓库骨架。

## Codex 的市场模型

### 1. 市场发现方式

Codex 会在两类地方找 marketplace：

- 用户已添加到 `config.toml` 的 marketplace
- 当前工作目录对应 git repo 根里的 marketplace

这点和 Claude Code 很不一样。Codex 有 repo-local 自动发现能力，打开一个带 marketplace manifest 的仓库，就能在 `plugin/list` 里看到它。

对应实现点：

- `/Users/LeslieChan/Desktop/codex/codex-rs/core/src/plugins/manager.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core-plugins/src/marketplace.rs`

### 2. 支持的 marketplace manifest 位置

Codex 市场根目录支持两种入口：

- `.agents/plugins/marketplace.json`
- `.claude-plugin/marketplace.json`

对应实现点：

- `/Users/LeslieChan/Desktop/codex/codex-rs/core-plugins/src/marketplace.rs`

这意味着对 Codex 来说，当前项目只放 `.claude-plugin/marketplace.json` 也能工作；但如果你想对齐 Codex 自己的 repo 约定，仍然建议同时保留 `.agents/plugins/marketplace.json`。

### 3. `marketplace/add` 接受什么 source

Codex 把 marketplace source 分成两类：

- Git source
- Local directory source

支持的输入形态有：

- `owner/repo`
- `https://...git`
- `git@...:repo.git`
- 本地目录

不支持“直接给一个远程 marketplace.json URL，当成 marketplace source”。

对应实现点：

- `/Users/LeslieChan/Desktop/codex/codex-rs/core/src/plugins/marketplace_add/source.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core/src/plugins/marketplace_add.rs`

### 4. 用户侧登记在哪里

Codex 会把已添加 marketplace 记到用户 `config.toml`：

```toml
[marketplaces.agent-workflows]
last_updated = "2026-04-22T00:00:00Z"
source_type = "git"
source = "https://github.com/your-org/agent-workflows.git"
ref = "main"
sparse_paths = [".claude-plugin", ".agents", "plugins"]
```

它关心的字段主要是：

- `source_type`
- `source`
- `ref`
- `sparse_paths`
- `last_updated`
- `last_revision`

对应实现点：

- `/Users/LeslieChan/Desktop/codex/codex-rs/config/src/types.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/config/src/marketplace_edit.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core-plugins/src/marketplace_upgrade.rs`

### 5. marketplace entry 长什么样

Codex 读取的 marketplace entry 关注这些字段：

- `name`
- `source`
- `policy`
- `category`

其中 `policy` 里有：

- `installation`
- `authentication`
- `products`

对应实现点：

- `/Users/LeslieChan/Desktop/codex/codex-rs/core-plugins/src/marketplace.rs`

Codex 支持的插件 source 主要是：

- 本地相对路径
- `url`
- `git-subdir`

本地路径必须：

- 以 `./` 开头
- 相对仓库根
- 不能越出 marketplace root

### 6. 插件 manifest 位置

Codex 插件 manifest 支持：

- `.codex-plugin/plugin.json`
- `.claude-plugin/plugin.json`

对应实现点：

- `/Users/LeslieChan/Desktop/codex/codex-rs/utils/plugins/src/plugin_namespace.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core-plugins/src/manifest.rs`

这意味着如果你的插件目录里只有 `.claude-plugin/plugin.json`，Codex 也能读到。

## Claude Code 的市场模型

### 1. 没有 repo-local 自动发现

Claude Code 不会因为你当前打开了某个 git 仓库，就自动把这个仓库当 marketplace。

它只认“已声明的 marketplace”，声明来源主要是：

- `claude plugin marketplace add ...`
- `settings.json` 里的 `extraKnownMarketplaces`

对应实现点：

- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/marketplaceManager.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/cli/handlers/plugins.ts`

### 2. 默认 marketplace 入口位置

Claude Code 对 git / directory marketplace 的默认 manifest 位置是：

- `.claude-plugin/marketplace.json`

对应实现点：

- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/marketplaceManager.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/schemas.ts`

这也是为什么“共享入口”建议优先选 `.claude-plugin/marketplace.json`。

### 3. 用户侧有三层状态

Claude Code 的 marketplace 不是只写一份配置，而是三层：

1. settings 意图层
2. `known_marketplaces.json` 物化状态层
3. marketplace cache 目录

最常见的两个落点是：

- `settings.json` 里的 `extraKnownMarketplaces`
- `~/.claude/plugins/known_marketplaces.json`

CLI `claude plugin marketplace add` 做了两件事：

- 调 `addMarketplaceSource(...)` 把 marketplace 拉到本地并登记到 `known_marketplaces.json`
- 再把 source 写回 settings 的 `extraKnownMarketplaces`

对应实现点：

- `/Users/LeslieChan/Desktop/claude-code-source-code/src/cli/handlers/plugins.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/marketplaceManager.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/settings/types.ts`

### 4. 支持的 marketplace source 更宽

Claude Code 的 marketplace source 支持：

- `url`
- `github`
- `git`
- `file`
- `directory`
- `settings`

企业策略还支持：

- `hostPattern`
- `pathPattern`

对应实现点：

- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/schemas.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/parseMarketplaceInput.ts`

也就是说，Claude Code 可以把“远程 marketplace.json URL”直接当 marketplace 用；但这条路和 Codex 不兼容。

### 5. marketplace entry 长什么样

Claude Code 的 `PluginMarketplaceEntrySchema` 关注的是：

- `name`
- `source`
- `category`
- `tags`
- `strict`
- 以及一整套可内联的 plugin manifest 字段

它没有 Codex 那种每个插件 entry 自带的：

- `installation policy`
- `authentication policy`
- `products`

Claude Code 更偏“市场是清单，安全和限制走 settings / policy 层”，不是把安装策略塞进每个 entry。

对应实现点：

- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/schemas.ts`

### 6. 插件 manifest 位置

Claude Code 的插件 manifest 走：

- `.claude-plugin/plugin.json`

对应实现点：

- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/pluginLoader.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/validatePlugin.ts`

## 两边最关键的差别

| 维度 | Codex | Claude Code | 对当前项目的含义 |
| --- | --- | --- | --- |
| 仓库自动发现 | 支持，按 `cwd` 找 repo root | 不支持 | 同一个市场仓库，本地打开时 Codex 更“即插即用” |
| 默认市场入口 | `.agents/plugins/marketplace.json`，也兼容 `.claude-plugin/marketplace.json` | `.claude-plugin/marketplace.json` | 共享入口应优先放 `.claude-plugin/marketplace.json` |
| 用户侧登记 | `config.toml [marketplaces.*]` | `extraKnownMarketplaces` + `known_marketplaces.json` | 消费端配置必须分开写 |
| marketplace source | Git / local dir | URL / GitHub / Git / file / directory / settings | 如果要双端共用，市场本身必须走 Git 仓库模式 |
| 插件 source | 本地路径 / `url` / `git-subdir` | 本地路径 / `url` / `github` / `git-subdir` / `npm` / `pip` | 共享 marketplace 不要用 Claude 专属 source |
| 插件 manifest 入口 | `.codex-plugin` 或 `.claude-plugin` | `.claude-plugin` | 插件目录至少放 `.claude-plugin/plugin.json` |
| entry 级策略 | 有 `policy.installation` / `policy.authentication` / `products` | 没有同级模型 | 若共享 `marketplace.json`，这些字段可以保留给 Codex，Claude 会忽略 |
| 市场更新模型 | 记 `last_revision`，按 git revision 升级 | `autoUpdate` + 后台 refresh | 运维方式不同，但不影响市场仓库布局 |
| 策略控制 | 更偏 entry/product + config | 更偏 settings policy：`strictKnownMarketplaces` / `blockedMarketplaces` | 企业接入时，Claude 的策略面更强 |

## 当前项目如何做成双端 Git marketplace

### 推荐目录骨架

```text
agent-workflows/
  .claude-plugin/
    marketplace.json
  .agents/
    plugins/
      marketplace.json
  plugins/
    workflow-core/
      .claude-plugin/
        plugin.json
      skills/
        workflow-core/
          SKILL.md
      .mcp.json
      agents/
        reviewer.md
      hooks/
        hooks.json
```

这里建议这样理解：

- `.claude-plugin/marketplace.json`
  - 给 Claude Code 用
  - 也是双端共享的主入口
- `.agents/plugins/marketplace.json`
  - 给 Codex 走原生 repo 约定
  - 最好做成从同一份源生成的镜像，不要手工双写
- `plugins/<name>/.claude-plugin/plugin.json`
  - 插件共享主 manifest
- `plugins/<name>/.codex-plugin/plugin.json`
  - 不是必需
  - 但如果后续要接 Codex 自己的脚手架和约定，保留会更稳

### 共享 manifest 的建议

#### 1. marketplace.json

如果你想一份 `marketplace.json` 同时被两边吃掉，建议按下面的交集写：

- 必带 `owner`
  - Claude Code 要求
- 可以带 `interface`
  - Codex 会用，Claude Code 会忽略
- 本地插件 source 用字符串
  - 例如 `./plugins/workflow-core`
- 远程 git 插件 source 用 `url` 或 `git-subdir`
- 不要在共享 marketplace 里用 `github` / `npm` / `pip`
- 可以带 `policy`
  - Codex 会用，Claude Code 会忽略

一个更稳的共享示例：

```json
{
  "name": "agent-workflows",
  "owner": {
    "name": "Leslie Chan",
    "url": "https://github.com/your-org/agent-workflows"
  },
  "interface": {
    "displayName": "Agent Workflows"
  },
  "plugins": [
    {
      "name": "workflow-core",
      "source": "./plugins/workflow-core",
      "description": "共享工作流基础插件",
      "category": "workflow",
      "strict": true,
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL",
        "products": ["CODEX"]
      }
    }
  ]
}
```

这里最关键的一点是：

- `owner` 是给 Claude 的
- `interface` 和 `policy` 是给 Codex 的
- 两边都不会因为这些“对方专属字段”直接报错

#### 2. plugin.json

共享 `plugin.json` 也可以做，但要控制重名字段的值类型。

最稳的共享写法是：

- `skills` 用字符串路径
- `mcpServers` 用字符串路径
- `apps` 如果要共用，也按 Codex 识别模型写
- `agents` / `commands` / `hooks` / `lspServers` 这类 Claude 字段可以保留
  - Codex 会忽略未知顶层字段

一个更稳的共享示例：

```json
{
  "name": "workflow-core",
  "version": "0.1.0",
  "description": "共享 workflow 基础能力",
  "skills": "./skills",
  "mcpServers": "./.mcp.json",
  "interface": {
    "displayName": "Workflow Core",
    "shortDescription": "Shared workflow toolkit"
  },
  "agents": ["./agents/reviewer.md"],
  "hooks": "./hooks/hooks.json"
}
```

这份文件的实际效果是：

- Claude Code 会同时吃到 `skills + MCP + agents + hooks`
- Codex 只会吃到 `skills + MCP + interface`

### 什么时候要拆成两份 marketplace.json

如果你后面出现下面这些需求，就不要坚持“共享一份 marketplace.json”：

- 需要在 Claude 侧使用 `github` / `npm` / `pip` 类型的插件 source
- 需要 Claude 侧使用 settings-inline marketplace
- 需要两边插件排序、暴露策略、source 模型明显分叉

这时更好的做法是：

- `.claude-plugin/marketplace.json`
  - 面向 Claude Code
- `.agents/plugins/marketplace.json`
  - 面向 Codex

然后把插件目录本体继续共用。

## 消费端怎么接入

### Codex 侧

如果只是“本地打开 marketplace 仓库本身”，Codex 可以靠 repo-local discovery 直接看到它。

如果要把它当远程 Git marketplace 加到用户环境里，等价于：

```toml
[marketplaces.agent-workflows]
source_type = "git"
source = "https://github.com/your-org/agent-workflows.git"
ref = "main"
sparse_paths = [".claude-plugin", ".agents", "plugins"]
```

也可以走 `marketplace/add`，让 Codex 自动把这段写进 `config.toml`。

### Claude Code 侧

Claude Code 需要显式声明 marketplace。等价的 settings 形态大致是：

```json
{
  "extraKnownMarketplaces": {
    "agent-workflows": {
      "source": {
        "source": "git",
        "url": "https://github.com/your-org/agent-workflows.git",
        "ref": "main",
        "sparsePaths": [".claude-plugin", "plugins"]
      },
      "autoUpdate": true
    }
  }
}
```

或者直接跑：

```bash
claude plugin marketplace add https://github.com/your-org/agent-workflows.git --scope user
```

CLI 会同时完成：

- marketplace 拉取和缓存
- `known_marketplaces.json` 写入
- `extraKnownMarketplaces` 写入

## 给当前项目的直接建议

如果这次只想把项目先做成“可用的双端 Git marketplace”，建议按下面顺序推进：

1. 在 `agent-workflows/` 下创建 `plugins/`
2. 先落一份共享版 `.claude-plugin/marketplace.json`
3. 再把它镜像到 `.agents/plugins/marketplace.json`
4. 先做一个最小插件，只承载 `skills + MCP`
5. 插件 manifest 先只放 `.claude-plugin/plugin.json`
6. 等 Codex 侧脚手架或发布流程需要时，再加 `.codex-plugin/plugin.json`

第一阶段不建议一上来就做复杂分叉，原因很简单：

- 当前项目还没有任何实际插件目录
- 先跑通一个共享最小集，比一开始维护两套 manifest 成本低很多

## 参考源码

### Codex

- `/Users/LeslieChan/Desktop/codex/codex-rs/core/src/plugins/manager.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core/src/plugins/marketplace_add.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core/src/plugins/marketplace_add/source.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core/src/plugins/installed_marketplaces.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core-plugins/src/marketplace.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core-plugins/src/manifest.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core-plugins/src/marketplace_upgrade.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/config/src/types.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/config/src/marketplace_edit.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/app-server-protocol/src/protocol/v2.rs`

### Claude Code

- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/schemas.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/parseMarketplaceInput.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/marketplaceManager.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/pluginLoader.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/officialMarketplace.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/officialMarketplaceStartupCheck.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/settings/types.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/settings/pluginOnlyPolicy.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/cli/handlers/plugins.ts`
