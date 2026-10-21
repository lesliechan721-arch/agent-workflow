# audit-agent-skill-evals Eval

本目录是完整源测试资产，使用当前项目 Selected Cases v1 / Manifest v1。它们是测试适配，不是通用运行期依赖。独立源码审核可在没有 AW CLI 时进行；真实 parser、独立 Oracle 审核和模型运行是不同证据。

共 21 个 case。各 suite 按所选任务和独立 Audit 执行。实际源格式检查以本次设计 evidence 为准，全部模型状态为 NOT_RUN。

| Suite | 用例文件 | 数量 | Profile | 模型状态 |
| --- | --- | ---: | --- | --- |
| `trigger` | [trigger-cases.json](trigger-cases.json) | 8 | project-default | NOT_RUN |
| `behavior` | [behavior-cases.json](behavior-cases.json) | 5 | project-default | NOT_RUN |
| `applicability-and-roles` | [applicability-and-roles-cases.json](applicability-and-roles-cases.json) | 5 | project-default | NOT_RUN |
| `redesign-behavior` | [redesign-behavior-cases.json](redesign-behavior-cases.json) | 3 | project-default | NOT_RUN |

## 测什么与不测什么

Trigger 的 expectedLoad 只观察任意加载，不表示首次入口，不禁止合理辅助能力。Conversation 的业务语义来自真实输入、允许差异与可观察断言；workspaceFiles、允许写入和 artifacts 分别约束输入与输出，不靠“已验证”的文字制造前提。

源审核可使用非 AW 合同；角色前提推理不等于真实独立性证明。正式成功准入、精确绑定仍需实际 Runner 和合格独立上下文。

## 运行前与结果使用

先用当前项目公开 parser 检查外形，再独立审核 Oracle、fixture 和可达性。写入 case 核对允许路径与实际产物；只读效果不能只靠禁写 sandbox 证明。工具正常输出、错误、stdout/stderr、退出码和依赖闭包使用确定性检查；模型读取与任务质量用语义验证，不匹配文档固定措辞。

新运行前由实际 Runner 形成正确目标、workspace、provider 和 case 绑定，并取得独立准入及预算。源码格式通过不等于可执行准入，NOT_RUN 不等于生产 Skill 已失败；失败先排除用例、fixture、grader、环境与方差。不能为了通过测试改变用户目标。

当前方法入口：[SKILL.md](../SKILL.md)。本目录不依赖已删除的迁移记录，也不保存伪造的通过凭据。
