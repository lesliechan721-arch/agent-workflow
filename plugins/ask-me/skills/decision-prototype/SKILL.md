---
name: decision-prototype
description: "当一个重要决定无法只靠提问或文字分析可靠确定，必须让用户看到、运行、操作、实验或测量候选方案时使用。制作回答单一问题的轻量原型，收集反馈并形成独立决定记录。不要用于已经可以直接决定的问题、完整产品探索或正式生产实现。"
---

# Decision Prototype

制作一个用户可以直接反应的轻量原型，用最低成本回答一个明确决定。

## 工作流

1. 读取当前对话、已有决定、可选共享 Decision frame，以及相关代码和文档。确认阻塞点是需要用户判断的问题，而不是可调查事实或普通局部实现选择。
2. 写出唯一的原型问题、用户需要观察什么，以及什么反馈足以停止。不要用“探索整个产品”代替具体问题。
3. 选择最低足够形式：候选文案、图片、可点击网页、流程 walkthrough、API consumer 示例、状态模拟器或技术 spike。
4. 使用[原型说明模板](assets/prototype-brief.md)。优先使用用户或调用者目录，其次遵循仓库约定；都没有时使用 `prototypes/<decision-id>/`。目录只保存 brief、配置、artifact、feedback 和 verdict，不复制 Review Shell，也不覆盖生产文件。
5. 默认先用少量候选、`都不接受` 和补充评论取得方向。只有具体位置或连续调整会改变决定时，才升级到引导问题、局部标注或受控参数；只有低保真无法回答时提高保真度。
6. 简单文案、单图或低成本示例可直接展示；适合有限选项时使用 {{questionTool}}。需要标准网页反馈时读取 [Prototype Review](references/prototype-review.md) 和 [运行时接口](references/prototype-review-runtime.md)：
   - 执行 `start` 取得 URL 和 session；
   - 使用当前环境可用的浏览器、页面预览或端口能力打开 URL，脚本不自动打开；
   - 执行 `wait`，直到用户提交、取消、超时或服务失败；
   - `submitted` 后读取 receipt 指向的 `feedback.json`，核对 Prototype ID 和 revision，然后在当前任务中自动继续，不要求用户返回聊天说明“已经完成”。
7. 多文件交互页面、视觉资源、两轮以上修改或大量仓库分析时，可以使用 fresh Prototype builder 子代理。Builder 只创建或修改 artifact，并返回路径、查看方式、变更摘要和限制；不要替用户作决定。
8. 反馈为 `revise` 时更新 artifact、递增 revision，并按需启动下一次 Review。反馈为 `new-material-question` 时停止当前 Prototype，先向用户说明并处理新问题。
9. 决定形成后写入 `verdict.md`，记录当前结论、支持证据、未解决项和新的材料问题。被否决方向只有在安全、兼容、迁移、回滚或避免高概率重复错误需要时才保留。

结束时向用户说明当前结论及仍未解决的问题。使用 Review Shell 时，机器反馈保存在与当前 Prototype revision 绑定的 `feedback.json`。

原型默认可丢弃。只有用户明确选择复用，且后续实现者重新评估结构、测试和风险后，生产实现才可以从原型演进。
