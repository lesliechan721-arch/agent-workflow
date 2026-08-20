# Codex Enhance

补充 Codex harness 当前不足的实施前澄清、只读证据探索和通用子代理编排能力。

> 该插件仅支持 Codex。

## 安装

```bash
aw install codex-enhance -p codex
```

## 包含的 Skill

| Skill | 什么时候使用 |
| --- | --- |
| [`codex-clarifier`](skills/codex-clarifier/) | 具体实现请求仍有会改变结果、范围或验收的关键歧义，需要先查事实并用最少问题补齐边界 |
| [`codex-explore`](skills/codex-explore/) | 代码、文档、日志或网络资料范围很大，需要隔离只读探索并汇总证据 |
| [`codex-subagent-guide`](skills/codex-subagent-guide/) | 已经决定使用子代理，需要选择任务角色、模型、上下文、等待和清理策略 |

## `codex-clarifier`

该 Skill 先读取对话、代码、配置和文档，只把无法查明且会明显改变成品的决定交给用户。它不增加常驻质量门禁；Codex 仍按 Skill 的发现规则决定是否加载。

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
实现订单导出前，先确认导出范围是否仍有会改变用户行为的关键歧义。
```

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
