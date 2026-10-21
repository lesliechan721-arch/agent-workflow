# 方法归属与资料生命周期 Eval

`method-lifecycle-workflow` 使用现有 Engine 的 `prepare/grade` provider，注册在本 Skill 的 manifest。`project-lifecycle` profile 提供 dev-workflow、decision-kit 和用于实际展示的 browser-use；它不改变生产插件依赖。该 suite 的执行仍需独立 Audit 和本次模型运行授权。

| 场景 | 实际前提与结果 |
| --- | --- |
| `shape-grill-before-material-answer` | 只有模型实际询问导出范围及其后果时才提供隐藏答案，再核对真实生成的本地 Spec 与设计停止点。 |
| `generated-local-spec-to-clean-context` | 正常问答轮次让设计者实际生成 Spec、取得独立审查和用户确认；另一条用户答案单独授权实施。两次都支持文本或 `requestUserInput` 提问，授权问题必须晚于 Spec 确认，授权前保护产品文件。新实施上下文须读取这些真实产物，行为检查仍采用原始要求。 |
| `prototype-answer-and-new-question` | 只有本轮原型已实际展示且请求布局反馈时才交付布局答案；后续保存超时问题另由 Grill 取得决定。工具、用户可见展示或反馈证据不足时不能通过。 |
| `completed-project-without-local-history` | 前置轮次实际实施、审查并按授权提交；测量轮次让无作者历史的新读者只读取已提交项目副本。适配器另从 Git 对象重建无本地过程资料的副本，运行原始行为检查及项目测试；测试需实际执行并通过，零测试或全部跳过不能通过。 |

前置轮次是本次真实执行，不使用预制好 Spec、Ticket、实现或审查结论；前置行为不冒充测量轮次的行为。新上下文、方法读取、独立审查、问答顺序和产物含义由 Engine 的真实事件及独立逐项判断核对。适配器不启动模型，也不根据角色名称、输出标题或模型自述推断这些事实。无法观察的部分保留 `unknown`。

确定性测试使用合成 Engine evidence 只验证适配器的成功与失败边界，包括隐藏答案隔离、确认与授权顺序、行为变异、缺失证据、测试未执行、提交内容和无关暂存保护。它们不构成真实 Skill 行为或独立 Oracle 准入证据。

准备入口：

```bash
aw skill eval prepare dev-workflow dev-workflow \
  --suite method-lifecycle-workflow --profile project-lifecycle \
  --workspace-root . --output .aw/evals/method-lifecycle --json
aw-skill-eval spec validate .aw/evals/method-lifecycle/spec.json
```

输出目录必须尚不存在。准备和结构验证不调用模型；真实运行仍需要精确绑定的独立 EvalAudit 与相应授权。原型展示和真实问答、跨上下文实施及维护者判断只有真实运行才能验证。
