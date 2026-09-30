# Simplification Method

## 候选来源

- 模型默认会正确处理的规则；
- schema、配置、`--help` 可直接查询的缓存；
- 没有 observed/normative 依据的理论边界；
- 重复或 scattering；
- 必要的层级、关系、顺序或条件散落在冗长叙述中，增加定位和重建结构的成本；
- rare branch 的 common-path 内容；
- 没有真实 consumer 的固定字段/schema；
- 不必要 mandatory stage；
- challenge-only 规则；
- 只服务一个父 Skill 的碎片化公开 Skill。

## 保真结构改写

必要信息主要表达层级、关系、顺序或条件，且叙述使读者需要自行重建结构时，可作为一个表达改写候选。目录与组成可用带注释的树，既定流程与回流可用流程图，条件与动作可用决策表。原本清楚的短句、必要理由和重要例外按其表达需要保留。

优先采用正文中可直接读取的文本结构，替换同义叙述；只补结构无法准确表达的必要说明。关系含义应明确，例如包含、调用与执行顺序各自表达，方法调用不被画成新增执行者；符号和图例的解释成本一并考虑。

改写保留责任主体、触发条件、权限、顺序与并行关系、适用例外、停止与完成条件、约束强度及引用用途。结构应表达现有规则；新增目录、改变阶段或能力边界属于另一种行为变更，按范围另行处理。比较时核对原意及实际使用，沿用相同来源、权限和验收。

## 复杂度指标

- SKILL.md 与典型 active-path token；
- mandatory stages、hard gates、prohibitions、conditional branches；
- fixed intermediate artifacts 与 machine contracts；
- public Skill count、handoff count、dependency depth；
- runtime/model calls、duration 和维护文件数。

尺寸不是唯一指标；必须说明减少了什么注意力或选择成本。

## 边界

先尝试已知重复、过期缓存、无真实消费者结构和非必要强制步骤；未知删除风险标 needs-ablation。保留用户领域约定、已确认设计、可访问依据、确证脆弱点和不可逆操作保护；按实际读者检查缩减后能否理解目标并完成工作。

删减结论对应任务族与执行角色。比较普通执行时保持原始资料和权限，仅移除对已删除能力的悬空调用并记录；有问题的对照先修实验条件。生产 caller 的变更仍受原授权范围约束。

单 Skill 简化默认不修改其它公开 Skill、插件依赖或 runtime。发现全局碎片化时给出另一个有界架构建议；用户扩大范围后才合并入口。每轮采用可回滚的局部补丁，拒绝候选只撤回本次变更。
