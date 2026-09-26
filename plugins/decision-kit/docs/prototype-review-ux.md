# Prototype Review UX 维护者说明

此文档不属于 `decision-prototype` 的运行时 reference closure。它供 Review Shell 维护、设计评审和浏览器测试使用。

应继续由实现和 Playwright smoke 保护：

- 人读的决定目标、优先级和约束；
- tabs 与大尺寸 Preview；
- 单选、多选和无选择模式；
- 渐进显示详细反馈；
- 标注 drawer 与编号 marker；
- 剩余期限、显式延长和取消；
- 单一提交动作和保存成功状态，提交后禁用编辑；
- 真实的到期、取消或失联状态，不把它们当作用户决定；
- 键盘可达、错误就近显示、状态不只依赖颜色。

页面连接只证明 Shell 已完成认证初始化。提交成功只证明反馈已保存，不承诺 Agent 当时在线或已经读取。脚本隔离的逻辑演示使用操作和总体反馈，不提供静态 HTML 的 DOM 标注能力。

Agent 使用 Review Shell 时不需要读取此文档。
