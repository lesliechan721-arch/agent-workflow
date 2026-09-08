# AW Workflow Review

发现 dependency、build import、Skill runtime file import、artifact runtime import 和 materialized profile 边；不要把不同边合成一个图。

固定一个用户结果和代表性路径，使用 `review-agent-architecture` 判断入口、handoff、state/evidence owner、失败传播、permissions 和最小架构。只有需要 leaf 证据时才调用 leaf Reviewer。
