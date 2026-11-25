# Agent Subagent

组织已授权的通用子代理委派、原生与外部执行器自省、执行配置与跨平台调度。

## 安装与平台支持

本插件面向全部 9 个 AW 目标平台按实际能力自动渲染交付物：

```bash
aw plugin install agent-subagent --scope user
```

- **8 个 Native 平台**（Codex、Claude Code、Antigravity、Cursor、OpenCode、Pi、GitHub Copilot CLI、Grok Build）：均交付 `spawn-subagent` 技能及共享托管命令包 `<来源>/agent-subagent`，调用入口由 AW 按当前平台自动绑定为 `aw command run <来源>/agent-subagent/<platform> --`。
  - **Antigravity 原生调度**：顶层交互会话优先使用 `swarm`（支持精确模型 ID、完整自包含 `brief` 与 `share`/`branch` 并行工作区，完成后 `kill` 清理）；无头 CLI、嵌套子会话或调用方显式要求宿主硬权限隔离 `TypeName`（如 `research`）时自动回退 `invoke_subagent`，并使用调用方指定 `TypeName` 或宿主默认角色（未指定角色时并入 `assets/task-instructions.md` 核心边界）。
  - 全 9 个平台均不再通过 AW 交付原生 `subagent` 角色；原生委派统一使用调用方指定角色或宿主默认角色（未指定角色时将 `assets/task-instructions.md` 的核心边界并入任务提示），并完整保留原生与外部执行、自省能力。
  - 当当前平台未配置外部执行器且 4 个难度档位共用同一原生基线时，渲染器将基线直接内联于 `SKILL.md` 并自动省略选型与外部协议文档，实现 0 跳原生调度。
- **`generic` 通用平台**：免初始化必填（默认 `{ "executor": "native" }`），交付纯通用版 `spawn-subagent` 与中性任务指令，不含 AW 托管命令与外部委派文档。

## 包含的 Skill

`spawn-subagent` 用于已授权的实际委派、上下文准备、执行器自省选型、等待、续接与产物验收。仅讨论是否委派或执行者直接完成已分配任务时不触发。

```text
使用 spawn-subagent，把这项已授权的实现交给合适的执行者。
```

## 配置、自省与外部执行

- **平台专属单必填基线 + 可选精细覆写**：
  - 5 个执行档位字段（`generalTaskProfile`、`simpleTaskProfile`、`complexTaskProfile`、`advancedTaskProfile`、`taskCustomProfiles`）均声明 `platformOnly: true`，按启用平台独立隔离，不从 `common` 继承；
  - 仅 **`generalTaskProfile`** 为平台必填基线（`generic` 平台默认 `{ "executor": "native" }` 豁免）；`simple` / `complex` / `advanced` 为可选覆写，省略时自动继承 `generalTaskProfile`；
  - 首次在 TUI 安装或修复缺配时自动进入平台初始化引导页，统一通过 Suggestions v2 按 `hint` 规则（在线实时目录优先，离线 Claude 由 `haiku`/`sonnet`/`opus`/`fable` 内置别名兜底；无探针/失败时兜底显式 `沿用宿主默认`）预填未保存草稿（绝不静默写盘），并支持一键预填全部可选档位。
- **Suggestions v2 两级复合选型与属性联动**：对象级 `executor-model-profile` 一次原子选定模型与推理强度（Antigravity 按模型家族聚合 2 级选型并自动清理不适用 `reasoningEffort`）；切换 `executor` 时自动清理旧 `model`/`reasoningEffort` 并在保存前预览确认。也可通过 `aw plugin config suggestions` 只读查询对象或标量建议。
- **单一工作区外部执行（Adapter v6）**：`subagentCommands` 支持在 `common` 共享或按平台覆盖，内建 `codex`、`claude-code`、`antigravity` 及自定义 `custom`、`custom-managed` 适配器，全部基于工作区目录运行。
- **三态能力自省（`separate` / `none` / `unknown`）**：每个外部执行器可按需补充 `description`、`models[]`（含可选 `defaultEffort` 与显式 `efforts: []` 表示不支持独立强度）及 `modelsPolicy`（`merge` / `override`）。调度期 `inspect` 仅输出真实环境与静态目录，不混入配置期内置别名。
- **`--instructions-file` 三态合同**：省略时自动注入中性默认角色指令；传 `""` 关闭角色指令；传文件路径时由父侧读取一次并前置拼入外部 prompt。
- **通信、恢复与留存**：双向通信与终态恢复独立开关（默认开启）；运行记录存于 `~/.aw-subagent`，保留期由 `subagentRetentionHours` 控制（默认 24 小时，`0` 表示永不过期）。

## 影响与边界

- 外部执行与动态自省会使用对应 CLI 的真实认证与配置并可能访问网络；外部任务可能产生模型费用，须仅注册可信且已获准的执行器。
- 仅保存配置须 `apply` 才更新命令包快照；升级、重装或删除前先结束或 `stop` 活跃任务。
- 详细协议与适配器开发见 `skills/spawn-subagent/docs/README.md`。
