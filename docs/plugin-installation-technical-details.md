# 插件安装技术细节：Codex 与 Claude Code

本文描述当前基线下，`@yiliang/aw` 如何把一个 `agent-workflows` 插件安装到 Codex 和 Claude Code。它面向 CLI 维护者和插件作者，重点说明运行时写入链路、关键文件、scope 差异和失败恢复语义；日常命令用法见 [plugin-installation.md](./plugin-installation.md)。

## 安装模型总览

插件安装不是直接把 `plugins/<name>/` 复制到平台目录，而是经过四层：

1. **源码层**：插件作者维护 `plugins/<name>/.agents-plugin/plugin.json` 以及 `skills/`、`.mcp.json`、`slash-commands/`、脚本等源码。
2. **embedded bundle**：`pnpm build` 生成 `packages/cli/plugins-dist/`。每个插件会得到 AW 源码 manifest、Claude 平台 manifest 和 Codex 平台 manifest。
3. **本机 marketplace**：需要平台 native plugin runtime 时，`aw init`、`aw install` 或 `aw upgrade` 会把 embedded bundle 同步到 `~/.aw/`。
4. **平台 scope**：CLI 再按 `--platform` 和 `--scope` 写入 Claude Code 或 Codex 的原生状态、repo-managed artifacts、tracking manifest 和 AW ledger。

关键 bundle 路径如下：

```text
packages/cli/plugins-dist/
├── .claude-plugin/marketplace.json
├── .agents/plugins/marketplace.json
└── plugins/<name>/
    ├── .agents-plugin/plugin.json
    ├── .claude-plugin/plugin.json
    ├── .codex-plugin/plugin.json
    ├── claude/...
    └── codex/...
```

`~/.aw/` 是 embedded bundle 的本机镜像，同时保存运行时状态：

```text
~/.aw/
├── config.json
├── installed.json
├── native-recovery/codex/user/<plugin>@aw.json
├── plugin-config/<plugin>/config.json
├── plugin-install-snapshots/<...>/<plugin>/<digest>/bundle/**
├── .claude-plugin/marketplace.json
├── .agents/plugins/marketplace.json
└── plugins/<name>/**
```

刷新 `~/.aw/` 时，CLI 会保留 `installed.json`、`plugin-config/`、`plugin-install-snapshots/` 和 Codex recovery breadcrumb；这些不是发布 bundle 内容，不能被 marketplace refresh 当成脏文件删除。

## 通用安装流水线

`aw install <plugin> -p <platform> -s <scope>` 的命令层大致按下面顺序执行：

1. 解析 current catalog，按插件名拿到 `PluginMeta`。
2. 推断或校验目标平台，并检查 `marketplace.policy.products` 是否允许安装。
3. 对 Codex project scope 做安装可行性和写入安全预检：纯 native-only 插件不能 project 安装，包含 `apps` 的 Codex 插件也不能 project 安装。
4. 对声明了 required config 的插件做 AW config preflight；可交互时补问缺失配置，非交互时 fail fast。
5. 如果目标需要 native runtime，调用 `ensureLocalMarketplace()` 同步 `~/.aw/`；纯 Codex project repo-managed 安装只读 catalog，不初始化或修复用户级 marketplace。
6. 物化 skill trigger 偏好。Claude 和 Codex user 会改写 `~/.aw/plugins/<name>/<platform>/skills/**`；Codex project 会复制并改写当前仓库的 `.agents/skills/<skill>/`。
7. 执行平台 native install。Claude Code 总是走 native plugin 命令；Codex 只有 user scope 且插件声明 `skills`、`slashCommands`、`mcpServers` 或 `apps` 时才走 native plugin。
8. 写 AW-managed artifacts，例如规则文件、permissions、Codex config block、hooks、agent role 等。
9. 持久化 lifecycle/config 安装快照，然后运行 `install` lifecycle。lifecycle 运行在平台状态和 artifacts 写入之后、tracking 和 ledger 提交之前。
10. 写 scope tracking manifest，再写 `~/.aw/installed.json` ledger。
11. 安装成功后做状态检查和 drift warning 收集；Codex user native 安装成功时还会删除对应 recovery breadcrumb。

失败时，CLI 会尽量回滚本次写入的 skill materialization、artifacts、tracking、安装快照和 ledger。Codex user native RPC 一旦成功，AW 不会再伪装成“完全原子”：Codex 已经写入的 native enabled/cache 会通过 recovery breadcrumb 暴露出来，供后续 repair install 或 uninstall 清理。

## Claude Code 安装

Claude Code 的 `user` 和 `project` scope 都走 Claude 原生 plugin runtime。

| scope | 配置目录 | tracking manifest | 原生 marketplace 状态 |
|---|---|---|---|
| `user` | `~/.claude/` | `~/.claude/.agent-workflows-manifest.json` | `~/.claude/plugins/` |
| `project` | `<cwd>/.claude/` | `<cwd>/.claude/.agent-workflows-manifest.json` | `~/.claude/plugins/` |

Claude 安装步骤：

1. 读取目标 scope 的 `settings.json`，同时读取 `~/.claude/plugins/installed_plugins.json`，检查同名插件是否已经由非 `aw` marketplace 管理。
2. 调用 `ensureLocalMarketplace()`，确保 `~/.aw` 中有当前 bundle。
3. 检查 `settings.json` 中声明的 `aw` marketplace、`known_marketplaces.json` 中的 install location，以及 `~/.aw/plugins/<name>` 是否是可用的 active local bundle。
4. 如需注册或修复 marketplace，执行：

   ```bash
   claude plugin marketplace add <AW_HOME> --scope <scope>
   ```

5. 执行原生插件安装：

   ```bash
   claude plugin install <plugin>@aw --scope <scope>
   ```

Claude 原生 runtime 会从 `~/.aw/plugins/<name>/.claude-plugin/plugin.json` 加载平台能力，包括 skills、MCP、generated slash commands、output styles、hooks、agents、LSP servers 等。AW 不手写 `.claude-plugin/plugin.json`，也不把源码 manifest 直接交给 Claude。

原生命令完成后，AW 还会写自己管理的扩展层：

- `extensions.instructions` 生成到 `<scope>/.claude/rules/aw-<plugin>-<instruction>.md`。
- `extensions.permissions` 合并进 `<scope>/.claude/settings.json`。CLI 把自己生成的权限放在 `awGenerated.permissions[plugin]`，重建最终 `permissions` 时会保留用户手写权限。
- Claude hooks 由 build 阶段写入 Claude platform manifest 的 `hooks` 字段，并由 Claude native plugin runtime 加载；CLI 不额外写一个 AW 管理的 `.claude/hooks.json`。

最后，CLI 会在 `~/.aw/installed.json` 记录 Claude scope record，其中包含能力快照、安装选项和 lifecycle/config snapshot 元数据。

## Codex User Scope 安装

Codex user scope 分成两类：

- **需要 native plugin runtime**：插件声明了 `skills`、`slashCommands`、`mcpServers` 或 `apps`。这类安装必须走 Codex native marketplace 和 app-server RPC。
- **不需要 native plugin runtime**：只有 Codex `extensions.*` 或动态 artifacts。CLI 不调用 native install，只写 `~/.codex/` 下的 AW-managed artifacts。

Codex user 关键路径：

```text
~/.codex/config.toml
~/.codex/plugins/cache/aw/<plugin>/<version>/
~/.codex/rules/aw-*.rules
~/.codex/hooks.json
~/.codex/agents/*.toml
~/.aw/native-recovery/codex/user/<plugin>@aw.json
```

需要 native runtime 时，安装步骤如下：

1. 调用 `ensureLocalMarketplace()`，并解析 canonical `AW_HOME`。
2. 读取 `~/.codex/config.toml`，检查 `[plugins."<plugin>@..."]` 是否显示同名插件由外部 marketplace 管理。
3. 确保 `[marketplaces.aw]` 指向 canonical `AW_HOME`，必要时执行：

   ```bash
   codex plugin marketplace add <canonical AW_HOME>
   ```

   CLI 会重新读取 `~/.codex/config.toml` 校验 `source_type = "local"` 且 source 指向 `AW_HOME`，不会接受旧的“source 指向 marketplace.json 文件”模型。

4. 计算 Codex marketplace manifest：

   ```text
   <AW_HOME>/.agents/plugins/marketplace.json
   ```

5. 启动私有 app-server：

   ```bash
   codex app-server
   ```

6. 通过 stdio JSONL 发送初始化和安装请求：

   ```json
   {"id":"init-1","method":"initialize","params":{"clientInfo":{"name":"aw","version":"<aw-version>"},"capabilities":{}}}
   {"method":"initialized"}
   {"id":"install-1","method":"plugin/install","params":{"marketplacePath":"<AW_HOME>/.agents/plugins/marketplace.json","pluginName":"<plugin>"}}
   ```

7. `plugin/install` 成功后，Codex 自己负责写用户级 `[plugins."<plugin>@aw"].enabled = true`，并 materialize cache 到 `~/.codex/plugins/cache/aw/<plugin>/<version>/`。AW 不再回退到只写 enabled config。
8. AW 立刻写入 recovery breadcrumb，初始状态通常是 `pending_after_native_write`。只有这个文件写入成功后，才继续执行 post-check、lifecycle、tracking、ledger 等后续步骤。
9. post-check 必须同时满足：

   - `~/.codex/config.toml` 中 `[plugins."<plugin>@aw"].enabled === true`
   - `~/.codex/plugins/cache/aw/<plugin>/...` 下存在单一 active cache 版本

10. 后续再写 AW-managed Codex artifacts、运行 lifecycle、提交 tracking 和 ledger。所有步骤成功后，删除 recovery breadcrumb。

Codex user scope 的 AW-managed artifacts 写在用户级 `~/.codex/`：

- `extensions.instructions` 和动态 `codex.developerInstructionsBlock` 写入 `config.toml` 的 AW managed developer instructions block。
- `mcpServers` 写入 `config.toml` 的 `[mcp_servers.*]`。
- 动态 `codex.agentRole` 写入 `config.toml [agents.<roleKey>]`，并生成 `~/.codex/agents/aw-<plugin>-<roleKey>.toml`。
- `extensions.permissions` 生成 `~/.codex/rules/aw-*.rules`。
- 公共 hooks 和 `extensions.nativeHooks.codex` 合并到 `~/.codex/hooks.json`，只替换 AW 追踪到的 hook groups。
- 静态 `extensions.agents` 生成 `~/.codex/agents/aw-*.toml`。

Codex user native 的失败语义很重要：

- 如果 `codex app-server` 启动失败、RPC 方法不可用、plugins feature 被禁用、请求被拒绝或超时，命令失败，不写 config-only fallback。
- 如果 `plugin/install` 已成功但 recovery breadcrumb 写入失败，命令立即失败，并说明 AW 不能承诺后续自动 repair/uninstall 授权。
- 如果 breadcrumb 已写入但 post-check、lifecycle、tracking 或 ledger 失败，命令仍失败；Codex native side effect 保留，breadcrumb 更新为具体失败状态。用户可以运行显式 `aw install <plugin> -p codex -s user` 修复，或运行 `aw uninstall <plugin> -p codex -s user` 清理。

## Codex Project Scope 安装

Codex project scope 完全走 repo-managed artifacts，不走 native plugin 平面：

- 不执行 `codex plugin marketplace add`
- 不启动 `codex app-server`
- 不写 `~/.codex/config.toml [marketplaces]`
- 不写 `~/.codex/config.toml [plugins]`
- 不写 `~/.codex/plugins/cache/...`

project scope 的 Codex 配置目录解析到仓库根：

```text
<repo-root>/.agents/skills/<skill>/
<repo-root>/.codex/config.toml
<repo-root>/.codex/rules/aw-*.rules
<repo-root>/.codex/hooks.json
<repo-root>/.codex/agents/*.toml
<repo-root>/.codex/.agent-workflows-manifest.json
```

安装时，CLI 先从 embedded/current catalog 复制 Codex skill 到 `.agents/skills/<skill>/`，再按 `--skill-trigger` 改写 `.agents/skills/<skill>/agents/openai.yaml`。公共 `slashCommands` 在 Codex 侧也会变成 manual-only skill，因此同样写入 `.agents/skills/<command>/`。

其它 repo-managed artifacts 与 user scope 类似，只是落在当前仓库：

- `mcpServers`、静态/dynamic instructions、动态 role registration 写入 `<repo-root>/.codex/config.toml`。
- `extensions.permissions` 写入 `<repo-root>/.codex/rules/aw-*.rules`。
- Codex hooks 写入 `<repo-root>/.codex/hooks.json`。
- 静态 agent 和动态 role layer 写入 `<repo-root>/.codex/agents/*.toml`。
- tracking manifest 写入 `<repo-root>/.codex/.agent-workflows-manifest.json`。

Codex project scope 会 fail fast 的情况：

- 插件没有任何 project-managed surface，例如只有 `apps` 或只有 native plugin runtime 能承载的能力。
- 插件声明了 `apps`，因为 Codex project scope 当前不支持 apps。
- `.codex/config.toml` 中存在同名非 AW managed MCP server、agent role 或其它会被覆盖的配置。
- tracking manifest 缺少必要 artifact identity，导致 CLI 无法安全判断哪些文件属于 AW。

即使本机没有 `codex` 可执行文件，符合条件的 Codex project repo-managed 安装也应该可用，因为它不依赖 Codex native CLI。

## Ledger、Tracking 与安装快照

成功安装后，AW 会写三类自己的状态：

- **tracking manifest**：每个 scope 一个 `.agent-workflows-manifest.json`。Claude 放在 `.claude/`；Codex 放在 `.codex/`。其中 `GeneratedArtifact.path` 是绝对路径，`skill` 和 `mcpServer` 必须带 `artifactKey`。
- **ledger**：`~/.aw/installed.json`。记录插件版本、platform/scope、project key、能力快照、`skillTriggerPreference`、skill trigger 写入顺序和 lifecycle/config snapshot 元数据。
- **install snapshot**：`~/.aw/plugin-install-snapshots/...`。保存安装时使用的 bundle 和 manifest digest，供 uninstall/status 使用旧版本 lifecycle/config 真值，避免当前 catalog 已变化时误判。

这三者分工不同：tracking 用来精确卸载和判断 artifact drift；ledger 用来判断 scope 是否受管、继承安装选项和升级；install snapshot 用来在插件升级或 catalog 变化后仍能解释已安装实例。

## 维护边界

- 改 Codex user native 流程时，必须同时考虑 app-server RPC、post-check、recovery breadcrumb 和 `[marketplaces.aw]` cleanup，不能只改 `config.toml`。
- 改 Codex project 能力时，必须更新 project installability、write safety preflight、tracking identity 和文档中的 repo-managed surface。
- 改 Claude bundle 能力时，要区分 Claude native plugin manifest 能加载的内容和 AW 额外写入的 `rules/settings.json`。
- 改 manifest/schema、adapter 行为、scope 语义或安装/分发流程时，也要同步检查 `.agents/skills/create-agent-workflows-plugin/` 下的作者技能、模板、示例和校验脚本。
