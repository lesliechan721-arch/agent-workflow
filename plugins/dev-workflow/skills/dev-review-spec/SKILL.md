---
name: dev-review-spec
description: 当已有 Spec、计划或设计草案，需要独立判断是否可以批准、是否仍缺材料决定、是否可实现可验证，或是否规定过度时使用。该 Skill 可以单独调用；正式结论必须来自 fresh 独立 reviewer 上下文。
---

# Dev Review Spec

你是 Review 协调器，不是 reviewer。正式 Spec Review 必须由一个 fresh 独立子代理上下文完成。

## 独立审查

1. 固定审查目标，计算可复算的目标 revision：优先使用 Git blob/OID；没有 Git 身份时使用目标精确内容的 SHA-256。
2. 只向 reviewer 提供目标 Spec、它明确引用的决定与 Prototype 证据、必要仓库事实和适用规范。不要传入调用者期望的 verdict、实现者自我评价或隐藏推理。
3. 使用当前平台的子代理能力创建一个 fresh reviewer。reviewer 只读检查：
   - 决策完整性；
   - 可实现性；
   - 可验证性；
   - 边界纪律。
4. 子代理无法创建、不是 fresh context、目标在审查中变化，或 reviewer 未完成时，返回 `incomplete`。不要用当前上下文补做审查，也不要覆盖已有正式报告。
5. reviewer 完成后重新确认目标 revision 未变化，再保存其结论。协调器可以统一格式，但不得删除、弱化或改写 finding 的实质判断。

## 报告与历史

默认在回复中报告。需要持久化且未指定路径时，覆盖：

```text
docs/dev/<task-slug>/spec-review.md
```

Git 负责普通历史。Assured 模式或用户明确要求保留轮次时，额外把本次完整报告写入：

```text
docs/dev/<task-slug>/reviews/spec/<timestamp>.md
```

不创建额外 pointer、round lineage 或 finding registry。

读取并使用 [规格审查模板](assets/spec-review-template.md)。报告必须绑定 Target 和 Target revision。目标 revision 变化后，旧报告不能代表当前 Spec。

## 输出

```text
结果：clean / blocked / incomplete
产物：<报告路径 / 无>
未解决：<阻塞问题或无>
建议动作：<补充决定 / 收集证据 / 修订 Spec / 可以批准>
```

先报告，不修改被审 Spec。
