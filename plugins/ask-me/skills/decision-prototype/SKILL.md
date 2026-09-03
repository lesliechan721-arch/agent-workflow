---
name: decision-prototype
description: "当一个重要决定无法只靠提问或文字分析可靠确定，必须让用户看到、运行、操作、实验或测量候选方案时使用。制作回答单一问题的轻量原型，收集反馈并形成独立决定记录。不要用于已经可以直接决定的问题、完整产品探索或正式生产实现。"
---

# Decision Prototype

制作用户可以直接反应的轻量原型，用最低成本回答一个明确决定。

## 核心流程

1. 读取当前对话、已有决定、可选共享决策方向，以及相关代码和文档。确认阻塞点是需要用户判断的问题，而不是可调查事实或普通局部实现选择。
2. 写出唯一的原型问题、用户需要观察什么，以及什么反馈足以停止。不要用“探索整个产品”代替具体问题。
3. 选择最低足够形式：候选文案、图片、可点击网页、流程 walkthrough、API consumer 示例、状态模拟器或技术 spike。默认从低保真开始，只有它无法回答问题时才提高保真度。
4. 简单且无需保存或迭代的文案、单图和低成本示例可以直接展示。需要持久化、迭代或标准网页反馈时：
   - 使用 [原型说明模板](assets/prototype-brief.md)；
   - 生成或修改 `prototype.json` 前读取 [Prototype schema](assets/prototype.schema.json)，写入后依据它检查字段和合法值，不得添加未声明字段；schema 是字段和合法值的唯一事实源；
   - 优先使用用户或调用者目录，其次遵循仓库约定；都没有时使用 `prototypes/<decision-id>/`；
   - 目录只保存 `brief.md`、`prototype.json`、`artifact/`、按需出现的 `feedback.json` 和 `verdict.md`，不复制 Review Shell，也不覆盖生产文件。
5. 只要 Artifact 需要持久化或预期会迭代，优先使用 Builder 子代理构建和修改它。主代理拥有 `brief.md`、`prototype.json`、用户反馈和 `verdict.md`；Builder 只创建或修改 `artifact/**`，并返回路径、查看方式、变更摘要和限制，不替用户作决定。Builder 成功后，主代理只消费返回摘要和必要结果，不重新运行或写入 `artifact/**`；需要复验、补证或修复时继续交给 Builder。每轮可以复用现有 Builder，也可以使用新 Builder，由当前成本和上下文决定。没有可用子代理、委派失败，或工作小到委派明显更低效，主代理才做最小回退。无需保存或迭代的直接聊天示例继续由主代理完成。
6. 默认先用少量候选、`都不接受` 和补充评论取得方向。具体位置或连续调整会改变决定时，才增加引导问题、局部标注或受控参数。标准网页反馈能显著降低歧义时，读取 [Prototype Review](references/prototype-review.md)；命令参数和 receipt 以 `node scripts/prototype-review.mjs --help` 及脚本 stdout 为准。
7. 根据用户反馈继续：
   - 需要修改：更新 Artifact，精确递增 revision，再取得新一轮反馈；
   - 暴露新的材料问题：停止当前 Prototype，向用户说明新问题；
   - 当前问题已形成稳定结论：已有 Prototype 目录时写入 [Prototype 结论模板](assets/prototype-verdict.md)；未持久化时在回复中交付简短决定记录。
8. 存在 `verdict.md` 时，它只记录当前结论、支持证据、仍未解决内容和新的材料问题。被否决方向只有在安全、兼容、迁移、回滚或避免高概率重复错误需要时才保留。

结束时向用户说明当前结论及仍未解决的问题。原型默认可丢弃；只有用户明确选择复用，且后续实现者重新评估结构、测试和风险后，生产实现才可以从原型演进。
