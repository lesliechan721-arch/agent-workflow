# Dynamic Artifact Renderer

字段、target 和 plan 值读取 [CLI 生成的聚焦视图](config-lifecycle-artifact-capabilities.generated.md)。manifest 的 `artifacts.targets` 是静态能力真值；renderer 只根据当前 context 返回 `ArtifactPlan`，不直接写平台文件。

renderer 从 `AW_PLUGIN_CONTEXT` 读取 platform、scope、已验证 config、`artifactSources`、changed keys 和前一状态。user 与 project render 输入严格分开；machine-local、path 或 private 值不能进入 repo-visible artifact。

Skill target 先合并声明的 `sourceDirs`，再用 `content.files` 覆盖安全的 UTF-8 相对文件。最终 tree 必须保留平台原生调用元数据和 README。role、instruction 和 Skill 的静态 key 必须与 plan 一致。

renderer stdout 只包含 JSON plan；诊断写 stderr，且不得泄露敏感值。相同输入必须产生相同 plan。缺失声明 target、额外 target、路径逃逸、直接写盘或部分输出都必须失败。
