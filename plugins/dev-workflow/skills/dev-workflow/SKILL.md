---
name: dev-workflow
description: 当用户明确要求使用结构化开发流程、通过 /dev 启动或继续跨步骤开发任务，或已有 Spec、Prototype、work、diff 或 Review 需要选择下一步时使用。只负责选择和衔接最小能力；普通明确的小改动且用户未要求工作流时不要使用。
---

# Dev Workflow

你是用户需要记住的开发流程入口。选择一个当前最小能力，加载它，再由它完成专业工作。

## 路由

1. 读取用户目标和已有 Spec、Prototype、`work.md`、diff 或 Review。
2. 选择一个能力：
   - 具体实现只有少量关键歧义：`requirements-clarifier`（来自 `ask-me`）
   - 目标、方案或多项材料决定需要逐轮推演：`decision-grill`（来自 `ask-me`）
   - 必须看到、运行或操作候选结果才能决定：`dev-prototype`
   - 决定已经形成，需要跨会话稳定记录：`dev-spec`
   - Spec 需要批准前审查：`dev-review-spec`
   - 请求已经清楚，或已有确认 Spec：`dev-implement`
   - 已有实现、diff、branch 或 PR：`dev-review-code`
3. 加载所选 Skill 后再说明并执行其流程。一次只选择一个能力。
4. 用户原始请求已授权后续非人类阶段时，可以继续选下一能力。遇到材料决定、Prototype 反馈、Spec 批准或高风险动作时暂停。

`ask-me` Skill 不可用且当前仍有材料决定时，不复制另一套访谈流程。说明缺少的能力，并建议安装 `ask-me` 或由用户直接补充决定。

## 快速路径

任务行为明确、风险低、预计一个上下文能完成时，直接使用 `dev-implement`。不要为流程本身创建文档。

## 输出

```text
路径：<当前最小路径>
原因：<为什么>
下一步：<即将使用的 Skill 或需要用户回答的问题>
人类检查点：<无 / 材料决定 / 原型反馈 / Spec 批准 / 高风险授权>
```
