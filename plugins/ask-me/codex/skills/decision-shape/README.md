# Decision Shape

通过问答和按需 Prototype，把复杂需求、计划、方案或重要决定塑造成一份完整、当前有效的共享理解。

## 适合使用

- 一个复杂主题包含多个相互依赖的材料决定。
- 讨论和可体验证据可能需要交替进行。
- 需要跨会话保存当前共享理解，但不需要保存完整讨论历史。

一次性决策访谈直接使用 `decision-grill`。只需回答一个原型问题时直接使用 `decision-prototype`。

## 工作方式

Skill 会先调查事实，并维护一份用户可见的共享决策方向（Decision frame）。它把同一方向传给当前叶子 Skill：可以通过讨论解决时组合 `decision-grill`；必须看到、运行、操作、实验或测量时组合 `decision-prototype`。两个叶子 Skill 仍可独立使用，不会重新制定外层方向。

共享方向改变时，只重新打开受影响的决定。其它已确认决定、证据和边界继续有效。

Shape 与最新用户确认或 Prototype 结论冲突时，Skill 会先暴露冲突。可能推翻当前方向的证据仍缺失，且用户未接受后果时，Shape 保持开放。

完成时返回当前有效的 Shape。调用者提供路径、仓库有明确约定或跨会话确有价值时，Skill 会维护 Shape 文件；否则只在对话中交付。

## 边界

- 不内置开发目录、Spec 生命周期或保障等级。
- 不实现、审查、提交或发布结果。
- Shape 不记录完整问答、模型思考或 Prototype 修改日志。
- 同一时刻只组合一个叶子 Skill。

主要指令见 [`SKILL.md`](SKILL.md)，模板见 [`assets/shape-template.md`](assets/shape-template.md)，评测材料见 [`evals/`](evals/)。
