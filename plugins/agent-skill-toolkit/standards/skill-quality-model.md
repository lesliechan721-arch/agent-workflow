# 规则权威索引

维护者导航，不是运行时必读清单。正文只在唯一 owner 文件编辑；创作、重构与只读评审共用同一质量标准，不再拆出重复评审或简化副本。

| ID | 权威正文 owner（相对插件根；跨插件注明） | 职责 |
| --- | --- | --- |
| CONTENT.CORE | `agent-content-toolkit/skills/agent-content/SKILL.md` | 指针、两种负担、跳数、反抽象机制、剪枝与去免责 |
| CONTENT.REFACTOR | `agent-content-toolkit/skills/agent-content/references/refactoring-methods.md` | 内容层 4 类重构手法与语义保真核对 |
| SKILL.ENTRY | `skills/agent-skill/SKILL.md` | 创建、修改、重构与只读评审统一入口及包工具调用 |
| SKILL.DESIGN | `skills/agent-skill/references/design-and-validation.md` | Failure-Mode First、行为抓手、机制保真、证据分层与停止静态打磨 |
| SKILL.FORMAT | `skills/agent-skill/references/skill-format.md` | 标准目录、frontmatter 与双平台调用开关 |
| SKILL.INVOCATION | `skills/agent-skill/references/skill-invocation.md`、`trigger-development.md` | 调用边界、防大网/两跳索引反模式与触发实验 |
| SKILL.COMPOSITION | `skills/agent-skill/references/skill-composition.md` | 单体/多 Skill 工作流、公开面与插件边界、Skill 层重构手法 |
| SKILL.SCRIPT | `skills/agent-skill/references/script-authoring.md` | 随包脚本接口、正文接入与运行自检 |
| SKILL.ABLATION | `skills/agent-skill/references/ablation-acceptance.md` | 基线 vs 候选受控重构与消融验收 |
| EVAL.DESIGN | `skills/agent-skill/references/eval-design.md` | 通用 Eval 用例、fixture 与断言设计 |
| EVAL.AUDIT | `skills/audit-agent-skill-evals/SKILL.md`、`references/eval-audit-standard.md` | 独立 Eval 源审核、公平对照与结果归因 |
| EVAL.ADMISSION | `skills/audit-agent-skill-evals/references/formal-admission.md` | 运行器正式准入（preflight） |

`agent-skill` 的所有参考与打包工具均共置在本 Skill 内，不再跨 Skill 复制投影。`audit-agent-skill-evals` 保持独立，用于隔离 Eval 审核与作者职责。
