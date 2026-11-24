# Agent Subagent

组织已授权的通用子代理委派、原生与外部执行器自省、执行配置与跨平台调度。

## 安装与平台支持

本插件面向全部 9 个 AW 目标平台按实际能力自动渲染交付物：

```bash
aw plugin install agent-subagent --scope user
```

- **8 个 Native 平台**（Codex、Claude Code、Antigravity、Cursor、OpenCode、Pi、GitHub Copilot CLI、Grok Build）：均交付 `spawn-subagent` 技能及共享托管命令包 `<来源>/agent-subagent`，调用入口由 AW 按当前平台自动绑定为 `aw command run <来源>/agent-subagent/<platform> --`；未配置 `subagentCommands` 时自动省略外部执行协议与通讯文档，实现开箱 0 跳原生调度。
  - Codex、Claude Code、Antigravity、Cursor、Pi、Copilot CLI、Grok Build 同时交付中性 `subagent` 原生角色（Pi 需启用兼容 subagent 扩展如 `@tintinweb/pi-subagents`）。
  - OpenCode 暂不支持 AW 注册新角色，`spawn-subagent` 自动切换为无专属角色原生分支并保留完整外部执行与自省能力。
- **`generic` 通用平台**：交付纯通用版 `spawn-subagent` 与中性任务指令，不含 AW 托管命令与外部委派文档；保留与 `common` 配置及跨插件引用的结构兼容。

## 包含的 Skill

`spawn-subagent` 用于已授权的实际委派、上下文准备、执行器自省选型、等待、续接与产物验收。仅讨论是否委派或执行者直接完成已分配任务时不触发。

```text
使用 spawn-subagent，把这项已授权的实现交给合适的执行者。
```

## 配置、自省与外部执行

- **通用 4 档位（`simple` / `general` / `complex` / `advanced`）与自定义规则**：全平台默认 `{ "executor": "native" }`，不写死模型名，确保跨平台零配置安全可用。TUI 编辑 `model` / `reasoningEffort` 时自动异步拉取宿主或外部执行器的实时动态建议，且始终允许手工输入；也可通过 `aw plugin config suggestions` 只读查询。
- **单一工作区外部执行（Adapter v6）**：`subagentCommands` 支持内建 `codex`、`claude-code`、`antigravity` 及自定义 `custom`、`custom-managed` 适配器，全部基于工作区目录运行。
- **双源执行器自省**：每个外部执行器可按需补充 `description`、`models[]` 与 `modelsPolicy`（默认 `merge` 与动态探针融合，`override` 时以非空静态列表作白名单并跳过动态探测）。调度期通过 `inspect` 列出执行器或获取实时模型与支持的推理强度。
- **`--instructions-file` 三态合同**：省略时自动注入中性默认角色指令；传 `""` 关闭角色指令；传文件路径时由父侧读取一次并拼入外部 prompt。
- **通信、恢复与留存**：双向通信与终态恢复独立开关（默认开启）；运行记录存于 `~/.aw-subagent`，保留期由 `subagentRetentionHours` 控制（默认 24 小时，`0` 表示永不过期）。

## 影响与边界

- 外部执行与动态自省会使用对应 CLI 的真实认证与配置并可能访问网络；外部任务可能产生模型费用，须仅注册可信且已获准的执行器。
- 仅保存配置须 `apply` 才更新命令包快照；升级、重装或删除前先结束或 `stop` 活跃任务。
- 详细协议与适配器开发见 `skills/spawn-subagent/docs/README.md`。
