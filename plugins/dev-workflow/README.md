# Dev Workflow

五个阶段：需求对齐、规格确认、实施准备、实施集成、交付核验。前两阶段由dev-design协调，后三阶段由dev-build协调；完整入口dev-workflow连接两者并保持用户授权边界。

```bash
aw install dev-workflow --scope user --target codex --target claude-code
```

```text
使用 dev-design 先完成需求与设计，暂不实施。
使用 dev-build 按当前已确认任务Spec及适用合同完成实现和验证。
使用 dev-workflow 从需求对齐推进到完整交付。
```

| 能力 | 当前职责 |
| --- | --- |
| dev-workflow | 完整阶段与用户检查点 |
| dev-design | 主题对齐、项目知识、规格与必要独立审查，结束于设计 |
| dev-spec | 形成当前完整任务规格，按用途维护公共合同 |
| dev-review-spec | 对本次规范范围作独立判断 |
| dev-breakdown | 形成可独立实施的当前任务 |
| dev-build | 准备、集成、milestone与完整交付闭环 |
| dev-implement | 受约束工作项及实际验证 |
| dev-review-code | 两份独立判断，或执行已分配的一个轴 |

依赖decision-kit。Shape协调Grill材料问答与Prototype可体验证据；简单问答可以一轮完成。完整任务规格及过程资料默认仅本地 `.dev-workflows/<task>/` 保存，已确认要求保持精度。长期按需维护词汇、重要决定、受影响公开合同和确有消费者的设计；小任务复用当前请求，无需创建空文档。

milestone仍需要相称验证和独立审查，不普遍要求commit。适用授权下可创建有回退价值的本地checkpoint，最终按授权提交一致的项目资料/代码/测试；过程文件不进Git，未完成默认不推送。修复预算、旧授权和停止点保持。

规格独立审查后仍需用户确认适用设计，设计认可不自动授权实施。完整代码审查保留两份独立判断；缺少审查条件时报告限制。新自动修订或修复授权未指定轮数时，默认最多三轮；旧的更低上限和停止点继续有效，预算耗尽不降低交付标准。
