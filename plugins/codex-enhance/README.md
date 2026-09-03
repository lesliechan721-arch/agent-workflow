# Codex Enhance

补充 Codex harness 的只读证据探索和通用子代理编排能力。

> 该插件仅支持 Codex。

## 安装

```bash
aw install codex-enhance -p codex
```

## 包含的 Skill

| Skill                                                  | 什么时候使用                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| [`codex-explore`](skills/codex-explore/)               | 代码、文档、日志或网络资料范围很大，需要隔离只读探索并汇总证据     |
| [`codex-subagent-guide`](skills/codex-subagent-guide/) | 已经决定使用子代理，需要选择任务角色、模型、上下文、等待和清理策略 |

## `codex-explore`

探索按深度提供 `quick`、`standard` 和 `deep` 三档角色。无法明确分档时使用
`standard`。用户显式指定模型或推理强度时，会使用不锁定参数的 custom role。

探索子代理负责收集和整理证据，不负责最终质量判断，也不执行产品写操作。

## `codex-subagent-guide`

该 Skill 不决定是否应该委派，也不授予委派权限。它在授权已经明确后，根据交付物把任务分为简单、通用、复杂、计划与审核，并应用合适的 role、context
fork、响应式等待和条件清理策略。

## 配置

```bash
aw config list codex-enhance -s user
aw config set codex-enhance standardProfile -s user --value-json '{"model":"gpt-5.6-terra","reasoningEffort":"high"}'
aw config set codex-enhance exploreMinimumInitialWaitMinutes -s user --value-json '15'
aw config set codex-enhance subagentMinimumInitialWaitMinutes -s user --value-json '15'
```

配置界面按 `codex-explore` 和 `codex-subagent-guide`
分组。七个角色分别使用 `quickProfile`、`standardProfile`、`deepProfile`、`simpleTaskProfile`、`generalTaskProfile`、`complexTaskProfile` 和 `advancedTaskProfile`。每个 profile 必须一次提供完整的 `model` 与 `reasoningEffort`；user 或 project 层写入会完整覆盖继承的 profile，不合并单个属性。两个首次响应式等待窗口只允许在 user 层设置。

两个 Skill 的内容由个人默认生成，并共享在同一个 canonical Codex native 插件中。当前项目可以单独启用该插件，但 project profile 只改变当前项目的 Agent role，不改变共享 Skill 的内容。更改任一等待窗口并应用后，会重新生成共享 Skill，并影响所有启用该插件的项目；project 层不能修改这两个字段。

已有可见安装时，只保存个人默认会让现有 native 插件保持不变，并显示为待同步。当前没有可见安装时，只保存设置，不产生 render drift。使用 `--apply --yes` 或之后运行同步，可重新生成 native 插件，同时保留已有的 user 和 project activation。

旧 store 和旧配置 key 不会自动迁移或删除。升级后，按需设置新 profile 和两个等待窗口；无效配置层使用显式 config reset 恢复，旧的 AW-owned 输出可通过 cleanup 后重新安装恢复。

## 典型用法

```text
用只读探索查清支付回调可能失败的路径，给出证据和未确认项，不修改代码。
```

```text
这个任务已经允许使用子代理。帮我选择合适的角色并管理等待与清理。
```

## 维护者

插件通过 renderer 生成最终 Codex Skill 和 Agent roles。确定性测试：

```bash
pnpm plugin:test codex-enhance
```

真实 Codex CLI/App 的 project activation、trust 和加载行为由独立 qualification 验证。fake manager 测试只证明 AW 的生成、配置和迁移流程。macOS Codex App 与 Windows Codex 的真实 UI 行为如果没有在对应系统运行，仍是 qualification gap。
