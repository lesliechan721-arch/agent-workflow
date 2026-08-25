# AW ReviewInputBundle

adapter 接受包含 `.agents-plugin/plugin.json` 的 AW 插件根。

ReviewInputBundle 由上层兼容 Runner 准备，并显式传入插件根、materialized final 和 evidence。Reviewer 不从目标项目发现仓库私有脚本或参数。

Release checker 在读取 Review 或 Eval evidence 前固定 source 和全部 materialized final collection inventory，并拒绝越界、符号链接或非目录 collection root。后续机器检查只复用该 inventory；边界失败时不读取 evidence。

空 leaf inventory 不接受也不需要 leaf Review/Eval evidence。非空 inventory 要求 ReviewResultLite v2 按 production digest 精确覆盖；所有传入 evidence 都必须是非符号链接普通文件且被当前 leaf target 消费，重复或多余 evidence 失败。

Leaf plan 同时包含 manifest `skills` 的静态 source leaf，以及 `artifacts.targets` 中 `codex.skill`、`claude.skill` 的动态 leaf。同一 platform 的动态 `skillKey` 从该 platform 的静态 final 集合排除，与 bundler 语义一致。动态 leaf 以 target id、`skillKey`、platform 和 scopes 绑定 final profile；它没有独立 source review target。动态 leaf 固定要求 Eval，并以 `skillKey` 绑定 canonical `skills/<skillKey>/evals/manifest.json` 和完整 preflight/run/triage 证据链。该 manifest 至少包含一个 release-required suite 和非空 release case corpus；三段证据必须匹配当前 corpus digest、case IDs 和 suite `defaultRuns`。显式 final profile 必须属于插件支持平台和选定 release scope，每个固定 final leaf name 在同一 profile 内唯一且必须被计划消费。

Artifact role 包括 `source`、`final`、`evidence` 和 `project-profile`。每个 artifact 都记录相对于 `environment.repositoryRoot` 的权威 POSIX 路径、规范化普通文件 mode、内容 digest、profile、currentness 和 owner。生产源码身份在带版本和长度前缀的记录流中绑定 path、mode 和内容 SHA-256。记录在 hash 前使用一次全局 POSIX 路径排序。必须提供 `target.currentness`，它聚合所有生产 artifact。Git status、ignored production file 和 index/worktree mode 差异必须匹配 artifact reason 和 target dirty reason；Git 无法证明 currentness 时，该值为 `unknown`。basename 为 `.DS_Store` 的任一路径段都不进入 artifact set、digest 和 currentness；其它隐藏生产文件使用普通生产规则。被忽略的直接 Skill Eval/report 证据保留为历史材料，不会使生产源码变为 dirty。

`providedStages` 只记录已完成的阶段。每个结果文件必须位于 handoff root 内，并通过 `validate-review-input-bundle.mjs`；非空路径或 final artifact 不能证明评审已经完成。`eval-result-triage` 阶段必须通过目标 Skill、corpus、preflight audit、plan 和完整结果 digest，准确绑定一个 `eval-execution` 阶段。孤立、过期或重复使用的 triage 证据无效。

准备插件级证据后，先使用 `prepare-aw-review-target-plan.mjs` 固定 expected source 和 materialized target。release-quality 未显式给出 `--profile` 时，工具从 marketplace 产品推导全部平台×scope profile。缺少 required final 时，target 保留为 `missing`，不能由 summary 手工标为已覆盖。

`prepare-aw-review-targets.mjs --bundle <plugin-bundle.json> --output-root <handoff-root>` 按 `targetSkillDigest` 将 audit/run evidence 投影到对应 source/final Skill，并为每个 target 生成强制 `package-inspection` stage；不匹配证据不会复制。Stage `resultPath` 使用可验证的本地路径，handoff validator 仍要求它位于显式 handoff root 内。

每个 `ReviewResult` 必须以 `--bundle <target-bundle.json>` 验证。最终 `AWReviewSummary` v2 必须记录 target plan 文件 digest，并使用 `validate-aw-review-summary.mjs <summary.json> --plan <target-plan.json> --plugin-root <plugin-root> --evidence <id> <result> <bundle> ...` 从当前 manifest、Skill 根和 release scope 重算 expected target，再验证 expected/actual 完全相等。每个 `reviewEvidenceId` 必须对应一份通过机器 validator 的真实结果。相同 production digest 和 review mode 可以复用一个 ID，但每个 expected target 仍必须单独出现在 coverage 中。
