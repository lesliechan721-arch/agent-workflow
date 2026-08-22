# 发布迁移交接

本文记录 schema 4 发布模型的一次性迁移前提和回归证据。本文不定义当前发布候选。运行 `pnpm --silent release:status -- --json` 获取权威候选和动作。

## 外部迁移基线

迁移模型接受以下历史起点：

- `@lesliechan721/aw` 可以有旧 `0.1.0-beta.1` 和 `0.1.0-beta.2` 发布。这些发布可以没有 `awRelease` metadata。
- `@lesliechan721/agent-skill-eval` 可以没有对应发布。
- official Catalog 可以没有 `catalog/latest`、`catalog/beta` 或 schema 4 ledger 历史。

这些事实是迁移输入。它们不是永久例外，也不是当前 remote 状态声明。schema 4 的 fixed distribution floor 是 `0.1.0-beta.3`。第一个完整 CLI train 必须为两个包使用 schema 1 `awRelease` metadata。第一个 schema 4 Catalog 发布必须使用 combined tag-first 路径。不要硬编码下一个 beta 编号。status 会保留全部已观察的旧身份，并选择下一个候选。

只有 Eval 没有任何发布历史，且 `@lesliechan721/aw` 的 legacy `latest` 仍严格指向无 metadata 的 `0.1.0-beta.1` 时，首个 committed stable plan 才把 stable baseline 视为空。该严格事实只来自 plan 绑定的完整 registry history。Eval-first 成功、AW 失败后，live history 可以保留 AW legacy latest 结构并重试同一 plan；status 不会把该混合历史当作新的首次 stable 基线。普通 `latest` lookup 仍拒绝 prerelease。

Release maintenance 的 status、prepare、publish 和 recover 使用同一个 canonical SSH remote `git@github.com:lesliechan721-arch/agent-workflow.git`。该 remote 服务维护者认证，不来自 local `origin`。runtime 用户的内置 official source 继续使用固定 HTTPS URL `https://github.com/lesliechan721-arch/agent-workflow.git`。两种 URL 有不同职责，不能互相替代。

先提交 target、CLI bump 同步产生的两个 public package version mirror 和选定的 source 变更。该提交完成后再 prepare。下一个 commit 只包含 immutable plan 和 `release/current-plan.json`。双包部分发布只能重试同一个已提交 plan 和 candidate。如果 tag-first 已发布 immutable tag 和两个 CLI 包，但没有推进 channel，使用显式 `release:recover -- catalog <version>` 路径。

## 回归矩阵

每一行指定能提供足够可观察证据的最低测试层。local workflow 使用 integration 层，因为单个 unit 测试不能证明这些跨模块边界。

| 风险 | 证据 |
|---|---|
| development Plugin 内容变化，但 target 不变 | `authoring-tools.test.ts`：development status 从真实物化 Plugin tree 返回通过的 `unreleasedChanges`。 |
| 已发布 stable target 收到新内容 | `release-model.test.ts`：`skips or defers when the stable target identity already exists` 返回 `target-bump-required`。 |
| 首次 beta、内容变化 N+1、内容不变复用 | `release-model.test.ts`：`starts, reuses, and increments a beta train from published content identity`。`plugin-release.test.ts` 的 `reuses a beta version for identical content and increments it for changed content` 保护 Plugin staging 身份。 |
| 归一内容相同时从 beta 到 stable | `release-model.test.ts`：`publishes stable directly or from the latest matching beta`。`plugin-release.test.ts`：`keeps both beta and latest publication history when stable content is reused`。 |
| beta 后内容变化，再请求 stable | `release-model.test.ts`：`requires another beta when the latest beta differs or has no digest` 返回 `beta-required`。 |
| CLI-only 发布 | `publish-plan-script.test.ts`：`publishes the CLI train when Catalog mode is none but the CLI axis is publish`。 |
| Catalog-only 发布 | `release-phase2.test.ts`：`fixes catalog-only and promotion modes in status instead of deferring them to publishing`。`publish-plan-script.test.ts` 验证写入前重建 committed Catalog candidate。 |
| 多 Plugin，只有变化项产生 candidate，stable skip 和 beta publish 混合 | `plugin-release.test.ts`：`stages a stable skip beside a beta publish only with matching stable history`。 |
| 拒绝 plan-only commit、source、target、artifact 或 history drift | `release-phase2.test.ts` 的 isolated plan commit 和 final materialization drift integration cases。`publish-plan-script.test.ts` 拒绝重建 Catalog 不匹配。local workflow integration case 拒绝 dirty source 和 remote history drift。 |
| recover 只接受显式 existing immutable tag | `release-recover-script.test.ts` 的 canonical identity 和 guarded promotion 测试。`catalog-git-publisher.test.ts` 覆盖 guarded tag discovery 和 missing-guard 拒绝。 |
| AW 旧 beta 1/2 且 Eval 为空时选择 beta 3 或更高版本 | `release-phase2.test.ts`：`reserves legacy beta observations and starts the next complete CLI train at beta.3`。 |
| 新 metadata 和双包部分重试 | `publish-cli-script.test.ts` 覆盖 Eval-first 发布、匹配的 Eval partial retry 和不匹配时拒绝；`publish-plan-script.test.ts` 覆盖首个 stable Eval 成功、AW 失败后重放同一 committed plan，并只在双包 latest 完整后 promotion。`release-cli-pack.test.ts` 验证两个带 `awRelease` 的 package artifact。 |
| Catalog 写入前 registry 完整历史漂移 | `publish-plan-script.test.ts` 覆盖 catalog-only、bootstrap、atomic-combined 的首次写前拒绝、同计划 Eval partial retry，以及 Catalog/npm 写回调的二次漂移拒绝。 |
| 首次 schema 4 bootstrap | `catalog-bootstrap-smoke.test.ts` 使用真实 local bare remote 覆盖 bootstrap、orphan channels、immutable tag、retry 和 provider fetch。 |
| tag-first 顺序和失败恢复 | `publish-release-script.test.ts` 覆盖 tag、CLI、promotion 顺序，atomic tag 失败，CLI 失败后 tag 保持未 promotion，以及固定 recover 命令。 |
| promotion floor、origin 和 freshness | `publish-plan-script.test.ts` 覆盖完整 train floor 和写入前 dist-tag 重查。`catalog-git-publisher.test.ts` 真实执行 status/prepare、plan 写入和 plan-only commit，再用与 tag origin 不同的新 plan identity 完成 promotion，并拒绝 origin 篡改。`release-recover-script.test.ts` 覆盖 remote-write train drift。 |
| tag ahead 但没有 guard | `catalog-git-publisher.test.ts` 通过真实 local Git refs 扫描所有 canonical stable/beta tag，并拒绝任一不低于自身 channel 的无 guard tag；缺少该 channel 也拒绝。 |
| 端到端 local orchestration 和 exact retry | `release-phase2.test.ts`：`runs target, source commit, prepare, plan-only commit, publication retry, and drift gates as one local workflow`。它使用真实 Git commits、公开 release orchestration 和注入的 local publication provider。provider 在不访问网络时记录 Catalog/tag、Eval、AW 和 promotion actions。 |

`catalog-git-publisher.test.ts` 和使用 local bare repository 的 Catalog smoke 测试继续覆盖 publisher 实现边界。这些边界包括 atomic ref 更新、publication lock、完整 schema 4 ledger merge、annotated tag、tag identity 和 channel history。orchestration fixture 不重复这些证据。
