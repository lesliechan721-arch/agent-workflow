# review-agent-skill Eval

本目录是完整源测试资产，使用当前项目 Selected Cases v1 / Manifest v1。它们是测试适配，不是通用运行期依赖。独立源码审核可在没有 AW CLI 时进行；真实 parser、独立 Oracle 审核和模型运行是不同证据。

共 58 个 case。suite 与 profile 以 manifest 为准。当前迁移后的 Oracle 和模型行为尚未独立验证，模型状态为 **NOT_RUN**。

| Suite | 用例文件 | 数量 | Profile | 模型状态 |
| --- | --- | ---: | --- | --- |
| `trigger` | [trigger-cases.json](trigger-cases.json) | 24 | project-default | NOT_RUN |
| `behavior` | [behavior-cases.json](behavior-cases.json) | 8 | project-default | NOT_RUN |
| `package-view` | [package-view-cases.json](package-view-cases.json) | 4 | project-default | NOT_RUN |
| `applicability-and-roles` | [applicability-and-roles-cases.json](applicability-and-roles-cases.json) | 5 | project-default | NOT_RUN |
| `redesign-behavior` | [redesign-behavior-cases.json](redesign-behavior-cases.json) | 6 | project-default | NOT_RUN |
| `architecture-behavior` | [architecture-behavior-cases.json](architecture-behavior-cases.json) | 5 | project-default | NOT_RUN |
| `architecture-applicability-and-roles` | [architecture-applicability-and-roles-cases.json](architecture-applicability-and-roles-cases.json) | 4 | project-default | NOT_RUN |
| `architecture-redesign-behavior` | [architecture-redesign-behavior-cases.json](architecture-redesign-behavior-cases.json) | 2 | project-default | NOT_RUN |

## 测什么与不测什么

Trigger 保留同一任务的普通请求与显式调用对照。普通请求不加载手动入口；正例使用 `$review-agent-skill`。显式名称只证明请求调用；实际加载须由正确 participant 的成功读取或受信任的本次原生注入记录证明。必要证据不可用时记录执行错误。加载成功不能证明模型理解或任务完成；conversation cases 另行检查执行质量。expectedLoad 不表示首次入口，也不禁止其它合法辅助能力。Conversation 的业务语义来自真实输入、允许差异与可观察断言；workspaceFiles、允许写入和 artifacts 分别约束输入与输出，不靠“已验证”的文字制造前提。

完整普通包、注入源码、给定 final 与实际断链分开；坏方法与完整正确方法形成对照。UI-only case 不要求可选的 policy 字段。

`source_topics_neutral_review` 与 `source_topics_resolved_reference_control` 使用相同请求和来源，差别在被审方法是否传达完整含义；请求不标注缺陷位置或版本优劣。UI-only case 已同步当前 checker 的 ruleset/覆盖/诊断，不要求已取消的工具 profile；运行器环境 profile 保持不变。

## 运行前与结果使用

先用当前项目公开 parser 检查外形，再独立审核 Oracle、fixture 和可达性。写入 case 核对允许路径与实际产物；只读效果不能只靠禁写 sandbox 证明。工具正常输出、错误、stdout/stderr、退出码和依赖闭包使用确定性检查；模型读取与任务质量用语义验证，不匹配文档固定措辞。

新运行前由实际 Runner 形成正确目标、workspace、provider 和 case 绑定，并取得独立准入及预算。源码格式通过不等于可执行准入，NOT_RUN 不等于生产 Skill 已失败；失败先排除用例、fixture、grader、环境与方差。不能为了通过测试改变用户目标。

当前方法入口：[SKILL.md](../SKILL.md)。本目录不依赖已删除的迁移记录，也不保存伪造的通过凭据。

架构方法案例位于 `architecture-*` suites，覆盖工作流交接、调用方和公开能力，仍使用同一 Reviewer。`workflow_result_is_not_leaf_average` 与 `delta_without_baseline_reports_limited_scope` 分别保护组合判断和差量证据边界。
