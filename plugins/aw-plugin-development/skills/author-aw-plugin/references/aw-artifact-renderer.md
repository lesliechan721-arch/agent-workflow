# Dynamic Artifact Renderer

先读取 `aw plugin capabilities --json` receipt；只有 receipt 含所需领域时，才查询该领域。`artifacts.targets` 是静态能力真值；renderer 只根据当前 context 返回 `ArtifactPlan`，plan 由 `aw plugin validate` 验证，不直接写平台文件。

renderer 从 `AW_PLUGIN_CONTEXT` 读取 platform、scope、已验证 config、`artifactSources`、changed keys 和前一状态。user target 使用按 `default < user` 合并并验证的有效配置；project target 使用按 `default < user < project` 合并并验证的有效配置。敏感标量或 object child 不能进入输出或诊断。

Skill target 先合并声明的 `sourceDirs`，再用 `content.files` 覆盖安全的 UTF-8 相对文件。最终 tree 必须保留平台原生调用元数据和 README。role、instruction 和 Skill 的静态 key 必须与 plan 一致。

renderer stdout 只包含 JSON plan；诊断写 stderr，且不得泄露敏感值。相同输入必须产生相同 plan。缺失声明 target、额外 target、路径逃逸、直接写盘或部分输出都必须失败。

## Portable Agent Skills distribution

当 renderer 在 `agent-skills` distribution 执行时，环境有 `AW_PLUGIN_DISTRIBUTION=agent-skills`，且不设置 `AW_PLUGIN_PLATFORM`。`AW_PLUGIN_CONTEXT` 中 `surface` 是 `{ "kind": "distribution", "name": "agent-skills" }`，`distribution` 是 `"agent-skills"`，并继续用 `scope` 区分 user 与 project。

`runtimeImports` 的每项是 `{ artifactId, name, providerPluginId, exportName, path, digest }`。它是 typed build-time reuse edge，不声明、也不推断 manifest `dependencies`。用当前声明 target 的 `id` 和其 runtime import 的 `name` 选择一项；只读该项的 bundle-local `path`，不要拼接 provider 或 sibling source 路径，也不要写入该文件。

对当前 `agent-skills` distribution 和 scope 的每个声明 target 都返回一个 plan artifact；target 为 disabled 时也返回 disabled artifact，而不是省略它。
