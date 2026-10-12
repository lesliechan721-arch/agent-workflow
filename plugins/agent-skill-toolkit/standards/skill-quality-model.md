# 规则权威索引

这是维护者导航，不是运行时全量必读规则。正文仅在 owner 文件编辑；规则迁移不能仅在旧位置删除而无新归属。Author 与 Reviewer 采用相同原则，但权限、工作流和独立证据仍分开。

| ID | 权威正文 owner（相对插件根；跨插件注明） | 使用方 |
| --- | --- | --- |
| CONTENT.FACT / LOAD / POINTER / CONTROL / OUTPUT / VALIDATION | agent-content-toolkit/skills/agent-content/SKILL.md | 共同内容方法内联；通用内容、Skill 作者与审稿 |
| CONTENT.REFERENCE | agent-content-toolkit/skills/agent-content/references/reference-design.md | 创建与评价参考材料 |
| SKILL.INVOCATION | references/skill-invocation.md | Author、Skill Review、Architecture；构建时投影 |
| SKILL.COMPOSITION | references/skill-composition.md | Author、Skill Review、Simplifier、Architecture；构建时投影 |
| SKILL.DESIGN | skills/author-agent-skill/references/design-and-validation.md | 作者方法，不作独立裁决 |
| REVIEW.METHOD / EVIDENCE / SCORE | skills/review-agent-skill/references/review-standard.md、evidence-and-severity.md、review-dimensions.md | 只读问题判断、证据与评分 |
| EVAL.DESIGN | skills/author-agent-skill/references/eval-design.md | 通用 case 写作，不拥有 runner 方言 |
| EVAL.AUDIT | skills/audit-agent-skill-evals/references/eval-audit-standard.md | 用例资格、对照与结果解释 |
| EVAL.ADMISSION | skills/audit-agent-skill-evals/references/formal-admission.md | 实际运行器要求的正式独立准入 |
| SIMPLIFY.ACCEPT | skills/simplify-agent-skill/references/ablation-acceptance.md | 有限预算下的对照接受 |
| ARCH.PORTFOLIO | skills/review-agent-architecture/references/public-surface-review.md | 公开入口、依赖及用户选择成本 |

共享格式、调用和组合规则只维护一处，按 manifest 以相同文件名投影到实际消费者：`skill-format.md`、`skill-invocation.md`、`skill-composition.md`。Author 不另设别名；本地作者方法不要求 Reviewer 激活 Author。运行器格式由当前运行器提供。

## 新增共享资源

| 权威正文 | 使用方 | 用途 |
| --- | --- | --- |
| references/skill-format.md | Author、Skill Review、Simplifier | 普通包与作者检查基线 |
| skills/author-agent-skill/references/trigger-development.md | Author | 发现、调用、description 与执行问题分层；重复观察、训练/验证与候选选择 |
| skills/author-agent-skill/references/development-iteration.md | Author | 授权内持续开发及有界验证 |

统一格式以标准字段为主，只收录常用调用差异。共享资料按问题读取，投影不意味着每次全部加载。

工具调用片段共置在拥有对应脚本的 Skill 主文件中。完整接口由工具 help 和实现合同维护。正式 Eval 准入方法由 `skills/audit-agent-skill-evals/references/formal-admission.md` 条件提供。
