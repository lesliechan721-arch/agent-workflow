# Dynamic Artifact Renderer

为已选定的动态 target 实现 renderer 时读取。涉及配置定义或安装态 reader 时采用 组件方法（`references/plugin-components.md`）。查询当前 capability receipt 中所需领域；CLI/Core 与作者 validator 是字段和行为真值。

普通动态产物由 `artifacts.targets` 声明；命令 target 从 `managedCommands` 生成，不重复登记，先读 托管命令（`references/managed-commands.md`）。renderer 根据当前 context 返回 `ArtifactPlan`，不直接写平台文件，也不在其中复制第二套 Skill 或 Agent 内容标准。

## 请求与配置

从 `AW_PLUGIN_CONTEXT` 读取 surface、适用时的 platform/distribution、scope、已验证 config、`requestedArtifactIds`、`artifactSources`、changed keys 和前一状态。

`requestedArtifactIds` 非空、无重复，并按 manifest 顺序规范化。只为这些 ID 各返回一个 artifact。config 和 changed keys 只含本批 targets 的 refreshKeys 并集；context 不提供 config store 路径。`artifactSources` 可列出当前 surface/scope 的 Skill 静态来源，用于按声明读取 sourceDirs，不扩大本批配置或输出范围。

context home 和进程的 `AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME` 都是请求级临时路径。这是输入隔离，不是 OS sandbox。user 配置按 default < user 合并，project 配置按 default < user < project 合并，交给 renderer 前已验证。

同一 surface 与 scope 内 target ID 唯一；不同 surface 或不重叠 scope 可以复用 ID。共享 codex-native projection 的 target ID 与 Skill key 分别在整个 projection 中全局唯一。

## 敏感字段与批次

所有 codex.skill delivery、claude.skill 和 agent-skills.skill 的 refreshKeys 都不能包含 sensitive 字段；命令 target 及其依赖闭包同样必须非敏感，其它非 Skill target 可以使用。相同 surface/scope 同时包含 Skill 和读取 sensitive 字段的非 Skill target 时，AW 分成两批请求。两批使用相同且不可变的 previousArtifacts；每批只获得自己的配置，并返回精确匹配其 ID 的 plan。

## 生成 Skill 与 Native delivery

Skill target 先合并声明的 sourceDirs，再以 content.files 覆盖安全的 UTF-8 相对文件。最终树保留 README、平台原生调用 metadata 和完整资源闭包。role、instruction 与 Skill 的静态 key 必须匹配 plan。

codex.skill 按当前 capability 显式选择 delivery。共享 native 使用 `mode: "codex-native"`、`identity: "shared"`、`renderProfile: "user"`；其他支持的模式按公开合同声明。非 codex.skill target 不声明 delivery。

共享 native 的 refresh key 只能引用 user-only、非敏感字段；渲染使用 user 有效配置，即使任务 scope 为 project。动态 native Skill 不能与静态 Skill 同名。同一插件的全部 native target 使用相同 scopes；存在静态 Codex Skill、MCP、Hook 或 App 时，scopes 固定为 project 与 user。Slash command 不因此变成 native 组件约束的成员。

## 共享资源与输出

runtimeImports 是已声明的构建复用关系，不推断安装 dependencies。context 每项提供 artifactId、name、providerPluginId、exportName、path、digest。按当前 target ID 与声明 name 选择，仅读其 bundle-local path，不拼接 provider/sibling source，也不写导入文件。声明与 capability 传播见 构建与共享（`references/build-and-sharing.md`）。

stdout 仅含 JSON plan，诊断写 stderr；所有输出均不得泄露敏感值。相同输入产生相同 plan。缺少 target、额外 target、路径逃逸、直接写盘或部分结果都必须失败。

AW 在 staging/live 写入前扫描内容。长度至少 8 个 Unicode code point 的 sensitive string，其原文或 JSON 转义形态命中都会阻断；该阈值不表示凭据强度。stdout、stderr、日志和诊断仍脱敏所有长度的敏感值。只有 AW 生成或按内容验证过的 receipt 才能在精确路径排除扫描；不能使用 basename 或通配符。renderer 不生成、复制或修改保留 receipt。

## AW-owned 命令包

独立包使用 `{kind:"aw",name:"managed-commands"}` 和固定 scope，只设置 `AW_PLUGIN_SURFACE=managed-commands`，不设置 platform/distribution。从 commandSources 按 packageKey 读取本批只读 bundle 目录。动态集合每次完整返回 entries，空集合撤销本集合命令；生成包返回完整普通配置文件集，不覆盖可执行 entry 或保留 receipt。沿用 ArtifactPlan v2 和原输出限值；字段由 managed-commands capability surface 提供。

## Portable distribution

在 agent-skills distribution 下，环境设置 `AW_PLUGIN_DISTRIBUTION=agent-skills`，不设置 `AW_PLUGIN_PLATFORM`。context 的 surface 为 `{ "kind": "distribution", "name": "agent-skills" }`，distribution 为 agent-skills，scope 继续区分 user/project。

按 sourceDirs、distribution skillRuntimeFiles、renderer files 的合同顺序形成 final。为当前请求的每个 target 返回 artifact；disabled target 也返回 disabled，不直接省略。声明与导出使用 Portable 分发（`references/portable-skills.md`），不能以 Native final 代替其验证。
