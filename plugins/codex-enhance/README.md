# Codex Enhance

为 Codex 增加两个互相独立的多代理能力：大范围只读证据探索，以及已授权委派中的通用子代理编排。

> 该插件仅支持 Codex。

## 安装

```bash
aw install codex-enhance -p codex
```

## 包含的 Skill

| Skill | 什么时候使用 |
| --- | --- |
| [`codex-explore`](skills/codex-explore/) | 代码、文档、日志或网络资料范围很大，需要隔离只读探索并汇总证据 |
| [`codex-subagent-guide`](skills/codex-subagent-guide/) | 已经决定使用子代理，需要选择任务角色、模型、上下文、等待和清理策略 |

## `codex-explore`

探索按深度提供 `quick`、`standard` 和 `deep` 三档角色。无法明确分档时使用 `standard`。用户显式指定模型或推理强度时，会使用不锁定参数的 custom role。

探索子代理负责收集和整理证据，不负责最终质量判断，也不执行产品写操作。

## `codex-subagent-guide`

该 Skill 不决定是否应该委派，也不授予委派权限。它在授权已经明确后，根据交付物把任务分为简单、通用、复杂、计划与审核，并应用合适的 role、context fork、响应式等待和条件清理策略。

## 配置

```bash
aw config list codex-enhance -s user
aw config set codex-enhance standardModel gpt-5.6-terra -s user
aw config set codex-enhance standardReasoningEffort high -s user
aw config set codex-enhance minimumInitialWaitMinutes 15 -s user
```

每个探索深度和通用任务类型都可以独立配置模型与推理强度。`minimumInitialWaitMinutes` 是没有更具体规则时使用的首次响应式等待窗口下限。

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
