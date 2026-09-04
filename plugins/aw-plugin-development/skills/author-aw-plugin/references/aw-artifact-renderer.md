# Dynamic Artifact Renderer

先读取 `aw plugin capabilities --json` receipt；只有 receipt 含所需领域时，才查询该领域。`artifacts.targets` 是静态能力真值；renderer 只根据当前 context 返回 `ArtifactPlan`，plan 由 `aw plugin validate` 验证，不直接写平台文件。

renderer 从 `AW_PLUGIN_CONTEXT` 读取 platform、scope、已验证 config、`requestedArtifactIds`、`artifactSources`、changed keys 和前一状态。`requestedArtifactIds` 是非空、无重复且按 manifest 顺序规范化的本次请求；renderer 只对这些 ID 各返回一个 artifact。context 的 config 和 changed keys 只包含本次 target 的 `refreshKeys` 并集，不提供 config store 路径。三个 context home 和进程的 `AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME` 都是请求级临时路径；这是输入隔离，不是 OS sandbox。同一 surface 与 scope 内的 target ID 必须唯一；不同 surface 或不重叠 scope 可复用 ID。例外是 `codex-native` shared projection：其 target ID 与 Skill key 在整个 projection 内分别全局唯一。user target 使用按 `default < user` 合并并验证的有效配置；project target 使用按 `default < user < project` 合并并验证的有效配置。敏感标量或 object child 不能进入输出或诊断。

Skill target 先合并声明的 `sourceDirs`，再用 `content.files` 覆盖安全的 UTF-8 相对文件。最终 tree 必须保留平台原生调用元数据和 README。role、instruction 和 Skill 的静态 key 必须与 plan 一致。

`codex.skill` target 按 live capability receipt 显式选择 delivery。native delivery 的 refresh key 只能引用 user-only、非 sensitive config field，且不能引用含 sensitive fixed/KV child 的 object。native dynamic Skill 不能与静态 Skill 同名。同一插件的所有 native target 必须使用完全相同的 scopes；存在静态 Codex Skill、MCP、Hook 或 App 时，该 scopes 必须是 `{project,user}`。其它 target 不声明 delivery。AW 在任何 live native 写入前检查最终 Skill tree 和 receipt 中的 sensitive 明文，但 renderer 仍负责不生成该内容。

renderer stdout 只包含 JSON plan；诊断写 stderr，且不得泄露敏感值。相同输入必须产生相同 plan。缺失声明 target、额外 target、路径逃逸、直接写盘或部分输出都必须失败。

## Portable Agent Skills distribution

当 renderer 在 `agent-skills` distribution 执行时，环境有 `AW_PLUGIN_DISTRIBUTION=agent-skills`，且不设置 `AW_PLUGIN_PLATFORM`。`AW_PLUGIN_CONTEXT` 中 `surface` 是 `{ "kind": "distribution", "name": "agent-skills" }`，`distribution` 是 `"agent-skills"`，并继续用 `scope` 区分 user 与 project。

`runtimeImports` 的每项是 `{ artifactId, name, providerPluginId, exportName, path, digest }`。它是 typed build-time reuse edge，不声明、也不推断 manifest `dependencies`。用当前声明 target 的 `id` 和其 runtime import 的 `name` 选择一项；只读该项的 bundle-local `path`，不要拼接 provider 或 sibling source 路径，也不要写入该文件。

对当前 `agent-skills` distribution 和 scope 中 `requestedArtifactIds` 指定的每个 target 都返回一个 plan artifact；target 为 disabled 时也返回 disabled artifact，而不是省略它。
