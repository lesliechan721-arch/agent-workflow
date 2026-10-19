---
name: dev-review-loop
description: 当用户显式选择对明确代码范围完成独立审查、必要修复、验证与复审时使用。已知获准工作可先完成再核验；不承担需求设计、多任务实施协调或整体产品交付。
user-invocable: true
disable-model-invocation: true
---

# Dev Review Loop

负责当前代码范围的有界核验修复，不接管设计或 Build。单点诊断、普通修改和只读审查使用各自的直接方法。

用户启动后读取并采用 [有界核验修复](references/methods/review-loop.md)，在当前范围和授权内执行。只读限制、累计预算与停止点保持；共享方法不授权其他自动技能启动本流程。
