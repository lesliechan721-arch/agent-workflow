# Shared standards

`rules.json` 是唯一人工维护的质量规则源。每条规则用稳定 ID 表达 principle，并为不同动作提供投影视图：writing、content_review、skill_author、skill_review、eval_design、eval_audit。

生成文件只包含目标 Skill 需要的投影，不在运行时同时加载完整规则库。
Composition verdict、拆分信号和 P0/P1 evidence admission 也维护在 `rules.json`，并生成 Author/Reviewer 的 focused reference。`review-result-rules.generated.json` 只包含 ReviewResult validator 需要的 12 维 ID 和权重。
