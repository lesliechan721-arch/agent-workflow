# AW ReviewInputBundle

adapter 接受包含 `.agents-plugin/plugin.json` 的 AW 插件根。

```bash
node scripts/prepare-aw-review-bundle.mjs <plugin-root> \
  --repo-root <workspace-root> \
  --source agent-content-toolkit=<path> \
  --source agent-skill-toolkit=<path> \
  --final codex-project=<materialized-dir> \
  --eval-audit <eval-audit-result.json> \
  --eval-case <trigger-cases.json> \
  --eval-result <eval-run-bundle.json>
```

Artifact role 包括 `source`、`final`、`evidence` 和 `project-profile`。每个 artifact 都记录相对于 `environment.repositoryRoot` 的权威 POSIX 路径、规范化普通文件 mode、内容 digest、profile、currentness 和 owner。生产源码身份在带版本和长度前缀的记录流中绑定 path、mode 和内容 SHA-256。记录在 hash 前使用一次全局 POSIX 路径排序。必须提供 `target.currentness`，它聚合所有生产 artifact。Git status、ignored production file 和 index/worktree mode 差异必须匹配 artifact reason 和 target dirty reason；Git 无法证明 currentness 时，该值为 `unknown`。basename 为 `.DS_Store` 的任一路径段都不进入 artifact set、digest 和 currentness；其它隐藏生产文件使用普通生产规则。被忽略的直接 Skill Eval/report 证据保留为历史材料，不会使生产源码变为 dirty。

`providedStages` 只记录已完成的阶段。每个结果文件必须位于 handoff root 内，并通过 `validate-review-input-bundle.mjs`；非空路径或 final artifact 不能证明评审已经完成。`eval-result-triage` 阶段必须通过目标 Skill、corpus、preflight audit、plan 和完整结果 digest，准确绑定一个 `eval-execution` 阶段。孤立、过期或重复使用的 triage 证据无效。

准备插件级证据后，使用 `prepare-aw-review-targets.mjs` 为每个 source Skill 和 materialized profile 创建一个确定性通用评审目标。

`prepare-aw-review-targets.mjs --bundle <plugin-bundle.json>` 按 `targetSkillDigest` 将 audit/run evidence 投影到对应 source/final Skill；不匹配证据不会复制。Stage `resultPath` 使用可验证的本地路径，handoff validator 仍要求它位于显式 handoff root 内。
