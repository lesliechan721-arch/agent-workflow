# Source Map

本文件区分发布依据与设计启发。最后核验：2026-08-08。release 模式必须重新打开标记为 current-check 的官方来源。

## Normative / official sources

| 主题 | 权威来源 | 本地用途 | current-check |
| --- | --- | --- | ---: |
| Agent Skill 结构、frontmatter、渐进式披露、文件引用 | https://agentskills.io/specification | package-validity 与规范评分 | yes |
| 范围、上下文、控制校准、模板、checklist、validation loop | https://agentskills.io/skill-creation/best-practices | instruction、scope、context 评分 | yes |
| description 和 trigger eval | https://agentskills.io/skill-creation/optimizing-descriptions | triggering 评分 | yes |
| scripts 的依赖、路径、接口和安全 | https://agentskills.io/skill-creation/using-scripts | scripts 评分 | yes |
| behavior eval、baseline、assertion、trace 和迭代 | https://agentskills.io/skill-creation/evaluating-skills | evals 与 problem-value 评分 | yes |

客户端特有调用字段、tool schema、角色配置和权限声明以目标客户端当前文档或源码为 normative 来源，不由本包预先假定。

## Non-normative heuristic lens

| 来源 | 使用范围 | 权威限制 |
| --- | --- | --- |
| https://github.com/mattpocock/skills/tree/main/skills/productivity/writing-for-agents | context pointer、两种 load、信息层级、co-location、completion bound、sprawl、剪枝 | 第三方设计启发，只能形成 heuristic finding；不得作为 P0/P1 或官方规范声明的唯一依据 |

使用该 lens 时保留其术语含义，但必须结合被审 Skill、实际 trace 和官方规范。客户端特有的 model/user invocation 机制只有在目标客户端确认支持时才评估。

## 来源使用纪律

- 报告中区分 source-derived、package-derived 和 reviewer inference。
- 规范或工具可能变化时使用当前来源，不凭缓存记忆。
- 引用第三方原则时说明它是 heuristic，不把审美偏好升级为发布门禁。
- 本文件只保存 source map、用途和核验日期，不复制可直接在线读取的大段规范。
