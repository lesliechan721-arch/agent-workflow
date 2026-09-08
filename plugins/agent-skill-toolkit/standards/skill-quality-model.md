# 规则权威索引

这是维护者导航，不是运行时全量必读规则。正文仅在 owner 文件编辑；规则迁移不能仅在旧位置删除而无新归属。Author 与 Reviewer 采用相同原则，但权限、工作流和独立证据仍分开。

| ID | 权威正文 owner（相对插件根；跨插件注明） | 使用方 |
| --- | --- | --- |
| CONTENT.FACT / LOAD / POINTER / CONTROL / OUTPUT / VALIDATION | agent-content-toolkit/skills/agent-content/references/agent-content-standard.md | 通用内容、Skill 作者与审稿 |
| CONTENT.REFERENCE | agent-content-toolkit/skills/agent-content/references/reference-design.md | 创建与评价参考材料 |
| SKILL.INVOCATION | references/skill-invocation.md | Author、Skill Review、Architecture；构建时投影 |
| SKILL.COMPOSITION | references/skill-composition.md | Author、Skill Review、Architecture；构建时投影 |
| SKILL.DESIGN | skills/author-agent-skill/references/design-and-validation.md | 作者方法，不作独立裁决 |
| REVIEW.METHOD / EVIDENCE / SCORE | skills/review-agent-skill/references/review-standard.md、evidence-and-severity.md、review-dimensions.md | 只读问题判断、证据与评分 |
| EVAL.DESIGN | skills/author-agent-skill/references/eval-design.md | 通用 case 写作，不拥有 runner 方言 |
| EVAL.AUDIT | skills/audit-agent-skill-evals/references/eval-audit-standard.md | 源审核、独立准入、结果解释 |
| AW.EVAL.PROFILE | aw-skill-eval-runner/skills/run-aw-skill-evals/references/aw-eval-profile.md | AW 调用方、适配和正式 Audit；按条件提供 |
| SIMPLIFY.ACCEPT | skills/simplify-agent-skill/references/ablation-acceptance.md | 有限预算下的对照接受 |
| ARCH.PORTFOLIO | skills/review-agent-architecture/references/public-surface-review.md | 公开入口、依赖及用户选择成本 |

上述两份共享规则只维护插件根下的源码。manifest 的 `buildConfig.skillRuntimeFiles` 在 AW build 时投影到 Author 和两个 Reviewer 的本地 references；不维护派生源码，也不要求 Review 激活 Author。可选 AW 归档说明由 `aw-development-toolkit/references/report-publication.md` 拥有并通过 runtime export 投影，不形成反向安装依赖。

内容层的两种负担是跨文档概念；Skill 数量、手动宏、caller/leaf 与插件依赖是领域应用。AW 字段/模板/脚本属于 Runner；通用插件测试采用 AW 格式不等于它的运行规范也依赖 AW。
