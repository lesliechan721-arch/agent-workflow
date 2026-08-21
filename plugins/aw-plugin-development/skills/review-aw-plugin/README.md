# Review AW Plugin

只读评审 AW 插件源码和 materialized Skill。通用质量结论由 `review-agent-skill` 产生；只有明确请求发布检查时，项目工具才实时计算 profile coverage、runtime closure 和 review binding。

默认流程不生成 `AWReviewTargetPlan`、`ReviewInputBundle` 或 `AWReviewSummary`。旧接口仅用于历史报告兼容。

该 Skill 不修改生产源码、README 或 manifest，也不发布报告。repo-local 或 portable Agent Skill 直接使用 `review-agent-skill`。
