---
name: dev-spec
description: 当材料决定已经基本明确，需要把对话、仓库事实和原型结论整理成可跨会话、可交接、可审查的开发规格，或根据 Spec Review 修订现有 Spec 时使用。记录稳定决定、验收和实现自由；不要写成逐步执行计划。
---

# Dev Spec

Spec 是已经形成决定的记录。它固定材料性共识，不预测全部实施细节。

## 产物位置

优先使用用户或调用者给定的路径，其次遵循仓库约定。都没有时写入：

```text
docs/dev/<task-slug>/spec.md
```

## 工作流

1. 收集已确认的决定、仓库事实、Prototype 结论、现有约束和适用的 Spec Review findings。
2. 使用 [Spec 模板](assets/spec-template.md)。只写会影响材料结果或验收的内容。
3. Prototype 的稳定结论进入规范性章节；完整原型、用户反馈、被否决方案和实验过程保留为 Evidence 链接；未解决的材料问题进入 Open decisions。
4. 技术细节只有在满足至少一项时进入 Spec：用户需要理解或授权；两个合格实现者可能产生材料性不同结果；必须跨上下文保存；判断交付必须依赖它。
5. 文件拆分、局部算法、类型设计、测试组织和任务顺序写入 `Agent discretion`。
6. 修订 Review findings 时，修复问题本身及其影响范围，不把单个 finding 扩展成通用流程规则。

## 完成条件

- 用户可观察行为、范围、材料决定、验收、风险和实现自由清楚。
- Open decisions 为空，或只包含明确委托给实现阶段的非材料事项。
- Spec 内部和它引用的证据没有材料冲突。

## 输出

```text
结果：complete / blocked
产物：<Spec 路径>
未解决：<材料决定、证据缺口或无>
下一步：<decision-grill / decision-prototype / dev-review-spec>
```

材料决定未解决时使用 `decision-grill`；需要体验或实验依据时使用 `decision-prototype`；Spec 完成或修订后使用 `dev-review-spec`。
