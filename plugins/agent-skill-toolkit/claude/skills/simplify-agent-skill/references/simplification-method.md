# Simplification Method

## 候选来源

- 模型默认会正确处理的规则；
- schema、配置、`--help` 可直接查询的缓存；
- 没有 observed/normative 依据的理论边界；
- 重复或 scattering；
- rare branch 的 common-path 内容；
- 没有真实 consumer 的固定字段/schema；
- 不必要 mandatory stage；
- challenge-only 规则；
- 只服务一个父 Skill 的碎片化公开 Skill。

## 复杂度指标

- SKILL.md 与典型 active-path token；
- mandatory stages、hard gates、prohibitions、conditional branches；
- fixed intermediate artifacts 与 machine contracts；
- public Skill count、handoff count、dependency depth；
- runtime/model calls、duration 和维护文件数。

尺寸不是唯一指标；必须说明减少了什么注意力或选择成本。

## 边界

先尝试已知重复、过期缓存、无真实消费者结构和非必要强制步骤；未知删除风险标 needs-ablation。保留用户领域约定、确证脆弱点和不可逆操作保护，不因它们较长而删除。

单 Skill 简化默认不修改其它公开 Skill、插件依赖或 runtime。发现全局碎片化时给出另一个有界架构建议；用户扩大范围后才合并入口。每轮采用可回滚的局部补丁，拒绝候选只撤回本次变更。
