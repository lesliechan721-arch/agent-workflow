# 插件安装指南

## 前置条件

- 已全局安装 `@yiliang/aw`（`npm install -g @yiliang/aw`）
- 至少安装了 Claude Code 或 Codex 其中一个

## 快速上手

```bash
# 1. 可选：提前初始化本地 marketplace，便于确认 CLI bundle 正常
aw init

# 2. 安装插件
aw install git-commit

# 3. 查看安装状态
aw status
```

`aw install` 和 `aw upgrade` 会在需要时自动同步 `~/.aw`。显式运行 `aw init` 不是硬性前置步骤，但适合首次安装、升级 CLI 后排查 bundle 问题，或想提前确认本机 marketplace 状态时使用。

---

## 命令参考

### `aw init`

初始化或刷新本地 marketplace，将 npm 包内置的插件包同步到 `~/.aw/`。

```bash
aw init [-f|--force]
```

- `-f, --force`：忽略缓存，强制重新同步（升级 CLI 版本后如遇异常可使用）
- 若本地镜像缺失、过期或不健康，安装/升级命令也会自动回到 embedded bundle 并尝试同步；重复执行 `aw init` 无副作用

---

### `aw install`

```bash
aw install [插件名...] [-s project|user] [-p codex|claude|both|auto] [-t default|manual|auto] [-i]
```

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `-s, --scope` | `user` | `user`：安装到用户全局目录（`~/.claude/` 或 `~/.codex/`）；`project`：安装到当前目录（`.claude/` 或 `.codex/`） |
| `-p, --platform` | `auto` | `auto` 自动检测平台；双平台同时可用时，安装/卸载/升级需要能从当前 scope 的既有状态唯一推断目标平台，否则要显式指定 `claude`、`codex` 或 `both` |
| `-t, --skill-trigger` | 见下文 | 安装时的 skill 触发偏好：`default`、`manual` 或 `auto` |
| `-i, --interactive` | 关闭 | 强制进入交互确认流程；非 TTY、CI 或 `--no-interactive` 下不会等待输入 |

一次安装多个插件：

```bash
aw install git-commit another-plugin -p claude
```

---

### `aw uninstall`

```bash
aw uninstall [插件名...] [-s project|user] [-p codex|claude|both|auto] [-i]
```

参数与 `install` 相同。卸载会清理所有由该插件生成的文件和配置项。

---

### `aw upgrade`

```bash
aw upgrade [插件名...] [-a|--all] [-s project|user] [-p codex|claude|both|auto] [-t default|manual|auto] [-i]
```

- 指定插件名，或用 `-a, --all` 升级当前 scope 下所有已管理的插件
- 显式升级某个插件时可传 `-t, --skill-trigger` 调整 skill 触发偏好；`upgrade --all` 不接受这个参数，会按各 scope 的 ledger 记录恢复
- 若插件的能力（instructions / permissions / hooks / native hooks / agents）发生变更，CLI 会先卸载再重新安装
- `upgrade --all` 只处理 `catalogCompatibility=current` 且 scope 已初始化的插件；缺失、能力变更、外部 marketplace 管理或 `installed.json` degraded 时需要显式处理

---

## 交互式模式

`install`、`uninstall`、`upgrade` 可以在 TTY 下进入交互式流程：

```bash
aw install
aw uninstall -i
aw upgrade -i
```

交互式模式只从 CLI 提供的候选列表中选择插件，不接受手动输入任意插件名。安装候选来自当前 catalog；卸载候选来自 AW ledger、平台原生配置、tracking manifest 和 runtime evidence；升级候选会再结合当前 catalog 判断是否可升级。非 TTY、`CI=true`、`--no-interactive` 或没有可用 prompt 时不会等待输入，而是返回明确错误和可复制命令示例。

在 `Codex + project scope` 下，交互式安装只会列出包含 repo-managed artifacts 的插件；纯 native-only 插件不会被当作项目级安装候选。

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

`~/.aw` 是本机共享 marketplace。同一用户、同名插件、同一平台只有一份当前生效的 skill 触发策略；在另一个 project 或 scope 里安装同名插件并选择不同偏好，可能会改变共享 runtime。CLI 会尽量在命令输出和 `aw status` 中提示 sibling scope drift。

---

### `aw status`

```bash
aw status [插件名...] [-s project|user] [-p codex|claude|both] [-j|--json]
```

不指定插件名时，显示 AW 管理过或平台可发现的插件摘要。`status` 的 `--scope` 和 `--platform` 是过滤条件；不传时会跨 scope / platform 扫描。为了兼容旧习惯，`aw status -p auto` 等同于不传 platform 过滤。

默认输出是日常状态面板，包含：

- 状态摘要：每个插件的整体健康状态，例如可用、部分可用、需要处理、外部管理、未安装或未知
- 明细：按 platform + scope 展示 native 注册、repo-managed artifacts、catalog 状态、skill trigger 和可见性摘要
- 下一步：给出最可能的修复或确认命令，例如 `aw status <plugin> --verbose`、`aw upgrade <plugin>` 或 `aw install <plugin>`

`--verbose` 会展开诊断字段，包括平台检测、native marketplace/plugin 状态、scope 初始化状态、ledger 状态、catalog 兼容性、managed evidence、skill trigger ledger/runtime/drift、generated artifacts、session state 和 drift warnings。`-j, --json` 输出稳定 JSON schema；即使和 `--verbose`、`--debug` 叠加，stdout 也只包含可直接 `JSON.parse` 的 JSON。

---

## Scope 与 Platform 说明

### Scope

| | `project` | `user` |
|---|---|---|
| 写入位置 | 当前目录下的 `.claude/` 或 `.codex/` | `~/.claude/` 或 `~/.codex/` |
| 适用场景 | 项目级配置，提交到版本控制 | 跨项目共享的个人配置 |

> **Codex 注意**：无论 `--scope` 如何，原生 marketplace/plugin 注册始终在 user scope（`~/.codex/config.toml`）进行；`--scope project` 仅影响当前仓库根目录 `.codex/` 下的自定义扩展文件。
> 需要 Codex 原生 plugin 能力时，AW 会先运行 `codex plugin marketplace add <canonical ~/.aw>`，让 Codex 校验并注册本地 marketplace；local source 不会被复制成 `.tmp/marketplaces/aw` 这类副本。当前 Codex 上游还没有稳定的 `codex plugin install <plugin>@aw` 子命令，因此插件 enabled 状态仍由 AW 写入 `[plugins."<plugin>@aw"]`。

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
- `.codex/config.toml` — 追加 managed instructions block
- `.codex/rules/*.rules` — Codex execpolicy `prefix_rule(...)` 权限规则
- `.codex/hooks.json` — Codex `hooks.<Event>[]` 钩子配置，包含公共 hooks 和 `extensions.nativeHooks.codex`
- `.codex/agents/*.toml` — Codex agent role 文件

Codex 的 `.codex/hooks.json` 是共享文件。CLI 只替换自己 tracking 到的 hook groups，手写配置或其它工具写入的 runtime-valid groups 会原样保留。

同时会在 `~/.aw/installed.json` 更新安装账本，在平台目录下写入 `.agent-workflows-manifest.json` 追踪清单（用于精确卸载/升级）。

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
| `-j` | `--json` | `status` |
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

新机器上重新执行 `aw init` 和 `aw install` 即可恢复本机 marketplace 与平台原生注册。项目里已提交的 repo-managed 文件（如 `.claude/rules/`、`.codex/rules/`、`.codex/hooks.json`）会按当前插件版本刷新；用户级配置仍需要在新机器上重新安装。

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

当前平台已通过其他 marketplace 安装了同名插件，CLI 不会干预。请先通过对应 marketplace 卸载该插件，再使用 `aw install`。
