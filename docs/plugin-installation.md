# 插件安装指南

## 前置条件

- 已全局安装 `@yiliang/aw`（`npm install -g @yiliang/aw`）
- 至少安装了 Claude Code 或 Codex 其中一个

## 快速上手

```bash
# 1. 可选：提前初始化本地 marketplace，便于确认 native plugin runtime 正常
aw init

# 2. 安装插件
aw install git-commit

# 3. 查看安装状态
aw status
```

`aw install` 和 `aw upgrade` 只有在目标需要 native plugin runtime 时才会同步 `~/.aw`。显式运行 `aw init` 不是硬性前置步骤，但适合首次安装、升级 CLI 后排查 bundle 问题，或想提前确认本机 marketplace 状态时使用。纯 `Codex + project scope` 安装走 repo-managed artifacts，只读使用 catalog，不会为了当前项目写入去初始化、修复或注册用户级 Codex marketplace。

---

## 命令参考

### `aw init`

初始化或刷新本地 marketplace，将 npm 包内置的插件包同步到 `~/.aw/`。这主要服务 Codex user scope、Claude native plugin runtime 和共享账本维护；Codex project repo-managed 安装本身不要求先跑 `aw init`。

```bash
aw init [-f|--force]
```

- `-f, --force`：忽略缓存，强制重新同步（升级 CLI 版本后如遇异常可使用）
- 若本地镜像缺失、过期或不健康，安装/升级命令也会自动回到 embedded bundle 并尝试同步；重复执行 `aw init` 无副作用

---

### `aw install`

```bash
aw install [插件名...] [-s project|user] [-p codex|claude|both|auto] [-t default|manual|auto] [--script-timeout <ms>] [-i]
```

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `-s, --scope` | `user` | `user`：安装到用户全局目录（`~/.claude/` 或 `~/.codex/`）；`project`：安装到当前目录（`.claude/` 或 `.codex/`） |
| `-p, --platform` | `auto` | `auto` 自动检测平台；双平台同时可用时，安装/卸载/升级需要能从当前 scope 的既有状态唯一推断目标平台，否则要显式指定 `claude`、`codex` 或 `both` |
| `-t, --skill-trigger` | 见下文 | 安装时的 skill 触发偏好：`default`、`manual` 或 `auto` |
| `--script-timeout` | 插件 manifest 或 `30000` | 覆盖 lifecycle 脚本超时，单位毫秒，合法范围 `1000..300000` |
| `-i, --interactive` | 关闭 | 强制进入交互确认流程；非 TTY、CI 或 `--no-interactive` 下不会等待输入 |

一次安装多个插件：

```bash
aw install git-commit another-plugin -p claude
```

---

### `aw uninstall`

```bash
aw uninstall [插件名...] [-s project|user] [-p codex|claude|both|auto] [--script-timeout <ms>] [-i]
```

参数与 `install` 相同。卸载会清理当前 scope 里 AW 管理的平台原生注册、repo-managed artifacts、tracking manifest 和 ledger 记录，但默认保留 AW 自管配置；需要删除配置时运行 `aw config reset <插件名>`。Codex project scope 只清理当前仓库里 AW 追踪到的 repo-managed artifacts，不会删除用户级 Codex native plugin 状态。

---

### `aw upgrade`

```bash
aw upgrade [插件名...] [-a|--all] [-s project|user] [-p codex|claude|both|auto] [-t default|manual|auto] [--script-timeout <ms>] [-i]
```

- 指定插件名，或用 `-a, --all` 升级当前 scope 下所有已管理的插件
- 显式升级某个插件时可传 `-t, --skill-trigger` 调整 skill 触发偏好；`upgrade --all` 不接受这个参数，会按各 scope 的 ledger 记录恢复
- 若插件的能力（instructions / permissions / hooks / native hooks / agents）发生变更，CLI 会先卸载再重新安装
- `upgrade --all` 只处理 `catalogCompatibility=current` 且 scope 已初始化的插件；缺失、能力变更、外部 marketplace 管理、tracking 损坏、项目配置不可读或 install options 无法恢复时会把对应 target 放入 `skipped[]`
- `upgrade --all` 的人类 receipt 会同时展示 succeeded / skipped 摘要；部分成功部分跳过时退出码为 `0`，全部 target 都 skipped 且没有成功升级时退出码为 `1`

---

### `aw config`

`aw config` 管理 AW 自管插件配置，独立于 Claude 原生 `userConfig`。插件只要在当前 catalog 中声明了 `config.schema`，就可以先配置后安装，也可以在未安装插件的另一层 scope 里预置覆盖值。

```bash
aw config list <插件名> [-s project|user] [-j]
aw config get <插件名> [key] [-s project|user] [-j]
aw config set <插件名> <key> <value> [-s project|user] [--value-json] [-j]
aw config configure <插件名> [-s project|user] [-i] [--no-interactive] [-j]
aw config unset <插件名> <key> [-s project|user] [-j]
aw config reset <插件名> [-s project|user] [-i] [--no-interactive] [-y] [-j]
```

- `set` / `unset` / `reset` / `configure` 默认写 `user`；`get` / `list` 默认读取 effective config。
- effective config 按 `manifest default < user store < project store` 合并，project 覆盖 user。
- project config 在仓库或 workspace 内锚定 repo root；不在仓库内时退回 normalized command `cwd`。
- `file` / `directory` 配置写入时会把相对路径按 AW project root 解析，并以 canonical absolute realpath 落盘；后续每次读取都会重新校验路径是否仍存在且类型正确。
- `--value-json` 只影响 `set` 的输入值解析；`--json` 只影响输出格式。
- `reset` 是 store 级删除。即使 current catalog 已经找不到插件，只要 store 存在，`aw config reset <插件名> -s <scope> --yes` 仍可清理残留配置。存在 store 且未传 `--yes` 时，CLI 会要求交互确认；非 TTY、`CI=true`、`--no-interactive` 或无 prompt 时不会静默删除。

插件名会先经过 config store 路径段安全校验：只允许非空单段名称，拒绝路径分隔符、`.`、`..`、绝对路径和 URL-like 值。

带动态 artifact 的插件会在配置写入后按需刷新已安装产物。刷新只在写入的 key 命中已安装 artifact 的 `refreshKeys` 时触发；未命中时只保存配置。user 配置写入会刷新 user scope artifact，并在当前仓库也安装了 project artifact 时一并刷新当前仓库；project 配置写入只刷新当前仓库 project artifact，不会改写 user artifact。CLI 不会扫描所有历史项目。

刷新使用 artifact render config，而不是 `get/list` 的 effective config：user artifact 只看 `default < user store`，project artifact 看 `default < user store < 当前 project store`。如果 renderer、project preflight 或写盘失败，已经写入的 config store 会保留，受影响 artifact 会被标记为最近刷新失败，`aw status` 可继续诊断。`aw config ... --json` 会在 receipt 中包含 `artifactRefresh.attempted`、`status`、`triggerKeys`、`artifacts[]`，失败时还会有稳定的 `error` 摘要。

---

## 交互式模式

`install`、`uninstall`、`upgrade` 可以在 TTY 下进入交互式流程：

```bash
aw install
aw uninstall -i
aw upgrade -i
```

交互式模式只从 CLI 提供的候选列表中选择插件，不接受手动输入任意插件名。安装候选来自当前 catalog；卸载候选来自 AW ledger、平台原生配置、tracking manifest 和 runtime evidence；升级候选会再结合当前 catalog 判断是否可升级。非 TTY、`CI=true`、`--no-interactive` 或没有可用 prompt 时不会等待输入，而是返回明确错误和可复制命令示例。

在 `Codex + project scope` 下，交互式安装只会列出包含 repo-managed artifacts 的插件；纯 native-only 插件不会被当作项目级安装候选。skills-only、mcp-only、slashCommands-only 和 extensions-only 插件都可以作为项目级候选；带 `apps` 的 Codex project 安装会明确拒绝，请改用 `--scope user` 或拆分插件。

如果插件声明了 required AW config，`install` / `upgrade` 会在写入平台状态前先解析 effective config。Codex project install / explicit upgrade / mixed explicit command 的顺序更严格：先做不会写状态的安全预检，包括 project installability、用户级 Codex config external ownership、必要的 `.codex/config.toml` 解析、tracking identity 和未受管 repo artifact 冲突；这些都通过后，才进入 required AW config preflight / prompt。缺少必填项或 `file` / `directory` 路径失效时，TTY 且允许交互的命令会复用配置向导补问一次；非交互、`CI=true`、`--no-interactive` 或缺少 prompt 时会确定性失败，并提示可复制的 `aw config configure` / `aw config set` 命令。同一插件在 `--platform both` 或重复 target 中只会补问和写入一次配置，prompt 返回的 selected scope 是唯一写入层。

---

## Skill 触发偏好

`-t, --skill-trigger` 只影响插件作者在 `.agents-plugin/plugin.json` 中允许安装时覆盖的 skill。未允许覆盖的 skill 会保留插件默认策略，并在命令输出中给出提示。

| 值 | 含义 |
|----|------|
| `default` | 恢复插件源码里的默认触发策略 |
| `manual` | 禁止模型自动触发，但保留用户显式触发入口 |
| `auto` | 允许模型自动触发 |

默认策略仍来自平台原生文件：Codex 读取 `skills/<skill>/agents/openai.yaml` 的 `policy.allow_implicit_invocation`，Claude Code 读取 `SKILL.md` frontmatter 的 `disable-model-invocation` 和 `user-invocable`。

重复执行 `aw install` 时，未传 `--skill-trigger` 不等于重置。只要 `installed.json` 处于 available 状态，CLI 会沿用当前 `platform / scope / plugin` 上一次记录的偏好；只有显式传 `-t default` 才会主动恢复默认策略。`aw upgrade <插件名>` 未传参数时也遵循同样的 ledger 继承规则。

如果 `installed.json` 处于 degraded 状态，CLI 不能安全相信旧记录。对已经受管的 target，重复 `install` 或显式 `upgrade` 必须传 `--skill-trigger default|manual|auto` 才能继续；未受管的新安装 target 仍按 `default` 安装。

`~/.aw` 是本机共享 marketplace。Codex user scope 和 Claude native runtime 仍共享同一用户下同名插件的 runtime skill 文件；在另一个 project 或 scope 里安装同名插件并选择不同偏好，可能会改变共享 runtime，CLI 会尽量在命令输出和 `aw status` 中提示 sibling scope drift。Codex project scope 例外：它只改当前仓库的 `.agents/skills/<skill>/agents/openai.yaml`，不参与共享 runtime 选举、`aw init` replay 或本地 marketplace rebuild replay。

`skillTriggerApplicability` 是 status / upgrade 判断里的稳定语义：

- `none`：目标没有 skill trigger 面，例如 mcp-only 或 extensions-only
- `fixed`：有 skill artifact，但运行时固定，例如公共 `slashCommands` 生成的 manual-only Codex skill，或所有 skill 都不允许 install override
- `overridable`：至少一个 Codex project skill 允许 `--skill-trigger` 覆盖；tracking-only evidence 且缺少可恢复 ledger install options 时，显式 install / upgrade 必须要求用户传 `--skill-trigger`，`upgrade --all` 会以 `installOptionsUnavailable` 跳过

---

### `aw status`

```bash
aw status [插件名...] [-s project|user] [-p codex|claude|both] [-j|--json]
```

不指定插件名时，显示 AW 管理过或平台可发现的插件摘要。`status` 的 `--scope` 和 `--platform` 是过滤条件；不传时会跨 scope / platform 扫描。为了兼容旧习惯，`aw status -p auto` 等同于不传 platform 过滤。

默认输出是日常状态面板，包含：

- 状态摘要：每个插件的整体健康状态，例如可用、部分可用、需要处理、外部管理、未安装或未知
- 明细：按 platform + scope 展示 native 注册（只在相关时作为诊断）、repo-managed artifacts、catalog 状态、skill trigger、config/script health、`healthSource` 和可见性摘要
- 下一步：给出最可能的修复或确认命令，例如 `aw status <plugin> --verbose`、`aw upgrade <plugin>` 或 `aw install <plugin>`

`--verbose` 会展开诊断字段，包括平台检测、native marketplace/plugin 状态、scope 初始化状态、ledger 状态、catalog 兼容性、managed evidence、skill trigger ledger/runtime/drift、config/script health、generated artifacts、session state 和 drift warnings。Codex project scope 的默认状态面板以 repo-managed evidence 为主；用户级 native marketplace 注册缺失不会覆盖正常的 repo-managed installed signal。动态 artifact 会单独展示 instruction / role 等 artifact health，常见状态包括 healthy、disabled by config、block missing、content drift、config digest stale 和 recent refresh failed。user 配置写入没有扫描历史项目时，`refreshReach` 会说明本次已刷新 user / 当前 project，以及其它已知 project target 是否可能仍 stale。`healthSource` 表示健康真值来自 `installSnapshot`、`currentCatalog`、`historical` 或 `none`。`status` 只读，不会执行 lifecycle、不会执行 artifact renderer、不会刷新 marketplace、不会创建配置目录；失效的 `file` / `directory` 配置会显示为 `invalid-config`。`-j, --json` 输出稳定 JSON schema；即使和 `--verbose`、`--debug` 叠加，stdout 也只包含可直接 `JSON.parse` 的 JSON。

---

## Scope 与 Platform 说明

### Scope

| | `project` | `user` |
|---|---|---|
| 写入位置 | 当前项目目录下的 `.claude/`；Codex 写当前仓库的 `.agents/skills` 和 `.codex/` | `~/.claude/` 或 `~/.codex/`，并按需使用 `~/.aw` native runtime |
| 适用场景 | 项目级配置，提交到版本控制 | 跨项目共享的个人配置 |

> **Codex 注意**：`--scope user` 仍使用 Codex native plugin 平面，AW 会通过 `codex plugin marketplace add <canonical ~/.aw>` 注册本地 marketplace，并维护用户级 `[plugins."<plugin>@aw"]` enabled 状态。`--scope project` 不写 `~/.codex/config.toml [marketplaces]` 或 `[plugins]`，也不调用 native marketplace add；它只写当前仓库的 repo-managed artifacts，并用 `.codex/.agent-workflows-manifest.json` 追踪。

### Platform

| 值 | 行为 |
|---|---|
| `auto`（默认）| 自动检测平台；`status` 会展示所有可用平台，写入型命令会先按插件的 `marketplace.policy.products` 过滤，再在双平台可用时尝试唯一推断目标平台 |
| `claude` | 仅安装到 Claude Code |
| `codex` | 仅安装到 Codex |
| `both` | 同时安装到两个平台（均需可用） |

如果插件声明了 `marketplace.policy.products`，安装和升级时会拦截不匹配的平台；省略该字段表示不限制平台。

---

## 安装后生成的文件

安装成功后，CLI 会在对应目录写入以下产物：

**Claude**
- `.claude/rules/aw-<名称>.md` — instructions 文件
- `.claude/settings.json` — 合并 permissions 配置，并在 `awGenerated` 下记录 CLI 生成部分，尽量保留手写权限
- Claude hooks 来自插件 bundle 内的 `claude/hooks/hooks.json`，由 Claude Code 原生插件加载；CLI 不会把它作为额外 repo-managed hook 文件写入项目目录

**Codex**
- `.agents/skills/<skill>/` — Codex project scope 的 repo skill；公共 `slashCommands` 也会在 Codex 侧生成 manual-only skill
- `.codex/config.toml` — 追加 managed instructions block，写入动态 `developer_instructions` block、Codex agent role 注册项和 `mcp_servers`；MCP server key 保留 rendered `.mcp.json` 的原始属性名，包含点号、空格或 Unicode 时使用 TOML quoted key，例如 `[mcp_servers."acme.tools v1"]`
- `.codex/rules/*.rules` — Codex execpolicy `prefix_rule(...)` 权限规则
- `.codex/hooks.json` — Codex `hooks.<Event>[]` 钩子配置，包含公共 hooks 和 `extensions.nativeHooks.codex`
- `.codex/agents/*.toml` — Codex agent role 文件

Codex 的 `.codex/hooks.json` 是共享文件。CLI 只替换自己 tracking 到的 hook groups，手写配置或其它工具写入的 runtime-valid groups 会原样保留。

同时会在 `~/.aw/installed.json` 更新安装账本，在平台目录下写入 `.agent-workflows-manifest.json` 追踪清单（用于精确卸载/升级）。tracking 中的 `GeneratedArtifact.path` 一律是绝对文件系统路径；`.agents/skills/<skill>`、`.codex/config.toml` 只是文档和 receipt 里的展示写法。`kind: "skill"` 和 `kind: "mcpServer"` 必须带 `artifactKey`，分别记录 skill 名和 MCP server 原始 key，不能只靠共享文件路径区分。动态 artifact 还会记录 `id`、`target`、`state`、`refreshKeys`、`configDigest`、`contentDigest`、`disabledReason`、`roleKey`、`lastRefresh` 和 `refreshReach` 等字段，供 refresh、status、upgrade 和 uninstall 精确识别。

带 lifecycle/config 的插件还会在 `~/.aw/plugin-install-snapshots/` 下记录每个 platform + scope 的安装快照。后续 `uninstall` 和 `status` 会优先使用该快照解释 lifecycle/config 真值；即使本地 marketplace 已刷新到新版本，也不会把新 catalog 的 schema 或脚本误当成旧安装的运行时。

---

## 常用短选项

| 短选项 | 长选项 | 适用命令 |
|---|---|---|
| `-s` | `--scope <scope>` | `install` / `uninstall` / `upgrade` / `status` |
| `-p` | `--platform <platform>` | `install` / `uninstall` / `upgrade` / `status` |
| `-t` | `--skill-trigger <preference>` | `install` / 显式插件 `upgrade` |
| `-i` | `--interactive` | `install` / `uninstall` / `upgrade` |
| `-a` | `--all` | `upgrade` |
| `-v` | `--verbose` | `install` / `uninstall` / `upgrade` / `status` |
| `-D` | `--debug` | `install` / `uninstall` / `upgrade` / `status` |
| `-j` | `--json` | `config` / `status` |
| `-f` | `--force` | `init` |

---

## 可用插件

| 插件名 | 描述 | 支持平台 |
|--------|------|----------|
| `git-commit` | 用户要求提交时自动触发 skill，按 Conventional Commits 规范完成 git 提交 | Codex / Claude Code |

查看完整列表：

```bash
aw status
```

---

## 常见工作流

### 在新项目中启用插件

```bash
cd my-project
aw init          # 若本机已初始化过可跳过
aw install git-commit
aw status        # 确认安装成功
```

### 升级所有插件

```bash
aw upgrade -a
```

### 迁移到新机器

新机器上重新执行 `aw init` 和 `aw install` 即可恢复需要 native runtime 的本机 marketplace 与平台原生注册。Codex project scope 的 repo-managed 文件（如 `.agents/skills/`、`.codex/config.toml`、`.codex/rules/`、`.codex/hooks.json`）随项目存在，重新安装或升级时会按当前插件版本刷新；用户级配置仍需要在新机器上重新安装。

---

## 故障排查

### `ledgerState=degraded`

安装或卸载过程中断（如 Ctrl+C）可能导致账本进入 degraded 状态。恢复方法：

```bash
# 查看具体原因
aw status

# 已受管插件重新安装或显式升级时，必须明确 skill 触发偏好
aw install git-commit -t default

# 或尝试重新卸载后安装
aw uninstall git-commit
aw install git-commit -t default
```

### 插件安装后 AI 看不到 instructions

执行 `aw status` 查看 `session-state` 字段：

- `blockedByProjectTrust`：Codex 项目信任未开启，需在 Codex 中将项目标记为 trusted
- `shadowedByProjectDeveloperInstructions`：被项目自定义 instructions 覆盖
- `absent`：文件未正确生成，尝试重新安装

### 提示"插件已由外部 marketplace 管理"

Codex project scope 安装 / 显式升级时，如果用户级 `~/.codex/config.toml [plugins]` 中已有同名外部 native plugin，CLI 会在写入任何 repo artifact 前拒绝，避免运行时歧义。已有 repo-managed evidence 的 `status` 会继续以当前仓库的安装状态为主，把 external ownership 作为附加诊断和下一步；`uninstall -p codex -s project` 只清理 AW 管理的 repo artifacts，不删除用户级 native plugin。

### `upgrade --all` 跳过 code

`upgrade --all` 的 direct command 返回值包含稳定 `skipped[]`。CLI receipt 会展示 code 和原因。首版 code 如下：

`scopeNotInitialized`、`codexProjectUserConfigUnreadable`、`externalOwnershipUnknown`、`externalOwnershipPresent`、`trackingIntegrityError`、`installOptionsUnavailable`、`catalogNotCurrent`、`catalogNotProjectInstallable`、`projectConfigUnreadable`、`unmanagedRepoArtifactConflict`。
