---
name: decision-prototype
description: "当一个重要决定无法只靠提问或文字分析可靠确定，必须让用户看到、运行、操作、实验或测量候选方案时使用。制作回答单一问题的轻量原型，收集反馈并形成独立决定记录。不要用于已经可以直接决定的问题、完整产品探索或正式生产实现。"
---

# Decision Prototype

制作一个用户可以直接反应的轻量原型，用最低成本回答一个明确决定。

## 工作流

1. 读取当前对话、已有决定及相关代码和文档。确认阻塞点需要用户判断，而不是可以调查的事实或普通局部实现选择。
2. 写出唯一的原型问题、用户需要观察什么，以及得到什么反馈后可以停止。不要用“探索整个产品”代替具体问题。
3. 选择最低成本形式：候选文案、图片、可点击网页、流程 walkthrough、API consumer 示例、状态模拟器或最小技术 spike。
4. 使用[原型说明模板](assets/prototype-brief.md)，并创建 `brief.md`、`prototype.json` 和 `artifact/`。优先使用用户给定目录，其次遵循仓库约定；都没有时使用 `prototypes/<decision-id>/`。不要覆盖生产文件。
5. 默认先提供少量候选、`都不接受` 和补充评论。只有具体位置或连续调整会改变决定时，才增加引导问题、局部标注或受控参数。
6. 简单文案、单图或低成本示例不启动 Review Shell；适合有限选项时使用 {{questionTool}}。标准网页反馈必须读取 [Prototype Review](references/prototype-review.md)，然后执行 `start`。Agent 使用环境可用能力打开返回的 URL，再执行 `wait`。没有打开能力时，把 URL 给用户并仍执行 `wait`；环境不能长时间阻塞时，用 `status` 重试。
7. `wait` 返回 `submitted` 后，读取 receipt 指向的 `feedback.json`，并按 [Prototype Review](references/prototype-review.md) 核对 ID、revision 和 `feedbackDigest`；只有全部一致时才继续。`busy` 是可重试的非终态；`superseded`、摘要不一致、`timeout` 或 `cancelled` 都不表示接受或拒绝。`revise` 必须更新 artifact、递增 revision，并为新 revision 启动新会话。
8. 记录当前决定、支持证据、未解决项和新的材料问题。被否决方向只在安全、兼容、迁移、回滚或避免高概率重复错误需要时保留。

复杂 artifact 可以使用 Prototype builder 子代理。Builder 只修改 artifact，并返回路径、查看方式、变更摘要和限制；用户决定仍由当前 Skill 负责。

Prototype 目录只包含 `brief.md`、`prototype.json`、`artifact/`、提交后生成的 `feedback.json` 和决定后生成的 `verdict.md`。Review Shell 和会话状态不写入 Prototype 目录。

原型默认可丢弃。只有用户明确选择复用，且后续实现者重新评估结构、测试和风险后，生产实现才可以从原型演进。
