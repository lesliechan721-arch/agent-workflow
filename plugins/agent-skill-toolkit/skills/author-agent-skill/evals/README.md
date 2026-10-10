# author-agent-skill Eval

本目录是完整源测试资产，使用当前项目 Selected Cases v1 / Manifest v1。它们是测试适配，不是通用运行期依赖。独立源码审核可在没有 AW CLI 时进行；真实 parser、独立 Oracle 审核和模型运行是不同证据。

共 28 个 case。既有 case ID 与 requiredForRelease 保留；新增 redesign-behavior 初始非必需，但不能据此跳过新能力的验收。实际源格式检查以本次设计 evidence 为准，全部模型状态为 NOT_RUN。

| Suite | 用例文件 | 数量 | Profile | 发布必需 | 模型状态 |
| --- | --- | ---: | --- | --- | --- |
| `trigger` | [trigger-cases.json](trigger-cases.json) | 8 | project-default | 是 | NOT_RUN |
| `behavior` | [behavior-cases.json](behavior-cases.json) | 7 | project-default | 是 | NOT_RUN |
| `applicability-and-roles` | [applicability-and-roles-cases.json](applicability-and-roles-cases.json) | 4 | project-default | 否 | NOT_RUN |
| `redesign-behavior` | [redesign-behavior-cases.json](redesign-behavior-cases.json) | 9 | project-default | 否 | NOT_RUN |

## 测什么与不测什么

Trigger 的 expectedLoad 只观察任意加载，不表示首次入口，不禁止合理辅助能力。Conversation 的业务语义来自真实输入、允许差异与可观察断言；workspaceFiles、允许写入和 artifacts 分别约束输入与输出，不靠“已验证”的文字制造前提。

创建和脚本案例须在通用工具已经实现并分发的运行包上执行；本设计不提供假工具结果。JSONL 消费方对照和原有局部编辑保护保留。

`synthesize_method_from_source_topics` 只给原始领域资料与目标，不给最终正文或预定资源布局。后续让其真实生成物进入 [消费对照](source-synthesis-chain.md)，不能用人工完整版本替换。这条链尚未运行；当前三份新增综合/评审样例是作者已见的诊断资产，不冒充未见集。

完整开发另按 [反馈、修复与重验](full-development-loop.md) 验收：在真实反馈、独立性、有效准入、授权及预算齐备时，观察 Author 完成一次范围内修复并让修后包实际重验。只写文件或只做结构检查不能通过。该场景为 NOT_RUN 的分段执行设计，不是新增 Selected Cases 条目，也不声明当前 Runner 已支持自动串联；静态 suite 全通过不能替代这条能力验收。既有局部修改反例保持。

`create_deterministic_json_counter` 不固定脚本文件名。评价者从交付 `SKILL.md` 取得实际入口，结合真实文件、调用和 stdout/stderr/退出码核对行为；明确命名的 `SKILL.md` 仍由 artifacts 检查。下列对照不增加 suite 条目，也不放宽真实脚本要求：

| 对照 | 应有判断 |
| --- | --- |
| `scripts/count.mjs` 与 `scripts/count-records.mjs` 内容等价，正文各自正确引用，实际行为满足任务 | 两者均满足命名与脚本行为要求，不因名称不同拒绝。 |
| 正文声明入口但没有实际脚本 | 不通过产物存在检查。 |
| 脚本存在，但正文引用另一个不存在的入口 | 不通过引用与可执行性检查。 |
| 文件与引用存在，但数量、输入上限、帮助或错误行为不符 | 不通过实际行为检查。 |

这些判据不由“文件里写了命令”或作者自述代替；只执行命名对照 fixture，也不证明模型评价器已经给出正确 grade。

## 运行前与结果使用

先用当前项目公开 parser 检查外形，再独立审核 Oracle、fixture 和可达性。写入 case 核对允许路径与实际产物；只读效果不能只靠禁写 sandbox 证明。工具正常输出、错误、stdout/stderr、退出码和依赖闭包使用确定性检查；模型读取与任务质量用语义验证，不匹配文档固定措辞。

新运行前由实际 Runner 形成正确目标、workspace、provider 和 case 绑定，并取得独立准入及预算。源码格式通过不等于可执行准入，NOT_RUN 不等于生产 Skill 已失败；失败先排除用例、fixture、grader、环境与方差。不能为了通过测试改变用户目标。

当前方法入口：[SKILL.md](../SKILL.md)。本目录不依赖已删除的迁移记录，也不保存伪造的通过凭据。
