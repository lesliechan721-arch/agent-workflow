# 插件安装指南

## 前置条件

- 已全局安装 `@yiliang/aw`（`npm install -g @yiliang/aw`）
- 至少安装了 Claude Code 或 Codex 其中一个

## 快速上手

```bash
# 1. 初始化本地 marketplace（每台机器只需一次）
aw init

# 2. 安装插件
aw install git-commit

# 3. 查看安装状态
aw status
```

---

## 命令参考

### `aw init`

初始化本地 marketplace，将 npm 包内置的插件包同步到 `~/.aw/`。

```bash
aw init [--force]
```

- `--force`：忽略缓存，强制重新同步（升级 CLI 版本后如遇异常可使用）
- 首次使用或 CLI 升级后需重新执行；若包内容未变，重复执行无副作用

---

### `aw install`

```bash
aw install <插件名...> [--scope project|user] [--platform codex|claude|both|auto]
```

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `--scope` | `project` | `project`：安装到当前目录（`.claude/` 或 `.codex/`）；`user`：安装到用户全局目录（`~/.claude/` 或 `~/.codex/`） |
| `--platform` | `auto` | `auto` 自动检测已安装的平台；也可显式指定 `claude`、`codex` 或 `both` |

一次安装多个插件：

```bash
aw install git-commit another-plugin --scope project --platform claude
```

---

### `aw uninstall`

```bash
aw uninstall <插件名...> [--scope project|user] [--platform codex|claude|both|auto]
```

参数与 `install` 相同。卸载会清理所有由该插件生成的文件和配置项。

---

### `aw upgrade`

```bash
aw upgrade [插件名...] [--all] [--scope project|user] [--platform codex|claude|both|auto]
```

- 指定插件名，或用 `--all` 升级当前 scope 下所有已管理的插件
- 若插件的能力（instructions / permissions / hooks / native hooks / agents）发生变更，CLI 会先卸载再重新安装

---

### `aw status`

```bash
aw status [插件名...] [--scope project|user] [--platform codex|claude|both|auto]
```

不指定插件名时，显示所有已安装插件的状态。输出包含：

- `scopeInitialized`：当前 scope 是否已初始化
- `ledgerState`：账本状态（`available` 正常 / `degraded` 异常）
- `catalogCompatibility`：`current`（最新）/ `capabilityChanged`（能力已变更，需升级）/ `missing`（插件已下线）
- `generated-artifacts`：各 artifact 文件是否存在
- `session-state`：instructions / rules / hooks / agents 当前是否对 AI 可见

---

## Scope 与 Platform 说明

### Scope

| | `project` | `user` |
|---|---|---|
| 写入位置 | 当前目录下的 `.claude/` 或 `.codex/` | `~/.claude/` 或 `~/.codex/` |
| 适用场景 | 项目级配置，提交到版本控制 | 跨项目共享的个人配置 |

> **Codex 注意**：无论 `--scope` 如何，原生插件注册始终在 user scope（`~/.codex/config.toml`）进行；`--scope project` 仅影响 `.codex/` 目录下的自定义扩展文件。

### Platform

| 值 | 行为 |
|---|---|
| `auto`（默认）| 自动检测已安装的平台；若两者均可用，从已有安装记录推断 |
| `claude` | 仅安装到 Claude Code |
| `codex` | 仅安装到 Codex |
| `both` | 同时安装到两个平台（均需可用） |

---

## 安装后生成的文件

安装成功后，CLI 会在对应目录写入以下产物：

**Claude**
- `.claude/rules/aw-<名称>.md` — instructions 文件
- `.claude/settings.json` — 追加 permissions 配置
- Claude hooks 来自插件 bundle 内的 `claude/hooks/hooks.json`，由 Claude Code 原生插件加载；CLI 不会把它作为额外 repo-managed hook 文件写入项目目录

**Codex**
- `.codex/config.toml` — 追加 managed instructions block
- `.codex/rules/*.rules` — Codex execpolicy `prefix_rule(...)` 权限规则
- `.codex/hooks.json` — Codex `hooks.<Event>[]` 钩子配置，包含公共 hooks 和 `extensions.nativeHooks.codex`
- `.codex/agents/*.toml` — Codex agent role 文件

Codex 的 `.codex/hooks.json` 是共享文件。CLI 只替换自己 tracking 到的 hook groups，手写配置或其它工具写入的 runtime-valid groups 会原样保留。

同时会在 `~/.aw/installed.json` 更新安装账本，在平台目录下写入 `.agent-workflows-manifest.json` 追踪清单（用于精确卸载/升级）。

---

## 可用插件

| 插件名 | 描述 | 支持平台 |
|--------|------|----------|
| `git-commit` | 用户要求提交时自动触发 skill，按 Conventional Commits 规范完成 git 提交 | Codex |

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
aw install git-commit --scope project
aw status        # 确认安装成功
```

### 升级所有插件

```bash
aw upgrade --all --scope project
```

### 迁移到新机器

新机器上只需重新执行 `aw init` 和 `aw install`，原来提交到版本控制的生成文件（`.claude/rules/` 等）会被覆盖为最新版本。

---

## 故障排查

### `ledgerState=degraded`

安装或卸载过程中断（如 Ctrl+C）可能导致账本进入 degraded 状态。恢复方法：

```bash
# 查看具体原因
aw status

# 尝试重新卸载后安装
aw uninstall git-commit --scope project
aw install git-commit --scope project
```

### 插件安装后 AI 看不到 instructions

执行 `aw status` 查看 `session-state` 字段：

- `blockedByProjectTrust`：Codex 项目信任未开启，需在 Codex 中将项目标记为 trusted
- `shadowedByProjectDeveloperInstructions`：被项目自定义 instructions 覆盖
- `absent`：文件未正确生成，尝试重新安装

### 提示"插件已由外部 marketplace 管理"

当前平台已通过其他 marketplace 安装了同名插件，CLI 不会干预。请先通过对应 marketplace 卸载该插件，再使用 `aw install`。
