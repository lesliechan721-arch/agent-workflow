# `codex-explorer-plugin` 实现代码复审报告

审查对象：

- 计划文档：`docs/dev/plans/codex-explorer-plugin.md`
- 实现代码：`packages/cli/src/**`、`plugins/codex-explore/**`
- 测试：`packages/cli/tests/**`、`plugins/codex-explore/scripts/render-artifacts.test.mjs`

审查时间：2026-05-04

## Findings

本轮没有发现新的实现缺陷、计划偏差或会阻塞交付的测试缺口。

### 1. 上一轮遗留的 `tracking-only codex.agentRole` project config 访问问题已经关闭

关闭状态：Closed

上一轮报告里唯一还没闭环的问题，是“当前 manifest 已变化，但 tracking 中只剩 dynamic `codex.agentRole` artifact”时，project scope 的 status / preflight 可能误判为不需要读取 `.codex/config.toml`。这次我确认实现已经补齐：

- `trackingRecordTouchesCodexProjectConfig()` 现在会把 `target === "codex.agentRole"` 的 dynamic role artifact 计入 project config access 判断，`needsCodexProjectConfigAccess()` 继续统一复用这条 helper，见 `packages/cli/src/utils/codex-project-surface.ts:196-213`
- 对应的 write preflight 回归也已经补上，直接覆盖了“当前插件 manifest 本身不再声明 project-config-backed artifact，但 tracking 中保留 dynamic role artifact”的分支，见 `packages/cli/tests/unit/codex-project-safety.test.ts:965-1010`

由于 status 和 project write safety 都共用这条 access 判断链，这个边角分支现在已经闭环。我这次没有再看到上一轮报告里提到的遗漏行为。

## 按计划核对

这轮实现和 `docs/dev/plans/codex-explorer-plugin.md` 的主线是一致的，我重点确认了下面几类 contract：

- 动态 artifact contract 已按计划落地。`codex-explore` manifest 同时声明了 `scripts.artifacts.render`、两个 `artifacts.targets`、scope、`refreshKeys`、`requiresCodexProjectConfig` 和静态 `roleKey`，见 `plugins/codex-explore/.agents-plugin/plugin.json:26-84`。renderer 只返回 plan，不直接写 `.codex` 文件，instruction/role 的 present/disabled 语义也与计划一致，见 `plugins/codex-explore/scripts/render-artifacts.mjs:74-188`
- scope-aware render config、ArtifactPlan 校验和 digest 逻辑都按计划收口。`resolveArtifactRenderConfig()` 明确区分 `default + user` 与 `default + user + project` 两种渲染口径，见 `packages/cli/src/utils/artifact-renderer.ts:185-294`；`validateArtifactPlan()` 会严格限制 target、state、`refreshKeys`、`roleKey` 和声明一致性，见 `packages/cli/src/utils/artifact-plan.ts:17-167`、`184-220`、`320-367`、`442-487`
- `codex.agentRole` 的 command-level preflight 也确实放在 renderer 和任何写入之前。role namespace 会解析 `[agents.*]`、`config_file` 指向的 role layer，以及未被引用的 `agents/**/*.toml`，然后按最终 role 名做冲突判断，见 `packages/cli/src/commands/codex-project-safety.ts:291-360`、`packages/cli/src/utils/codex-roles.ts:196-260`。安装/升级前置失败的行为也有集成回归锁住，见 `packages/cli/tests/integration/codex-explore-plugin.test.ts:925-983`、`1301-1389`
- status / refresh / historical fallback 这条链路也基本按计划完成了。instruction shared block digest、多 layer role visibility、config stale / refresh failed 诊断都已经在状态计算里实现，见 `packages/cli/src/adapters/codex.ts:1889-2025`；refresh 仍然走 renderer + apply + tracking 元数据，不旁路 lifecycle，也按 user/project 两个原子单元拆开，见 `packages/cli/src/utils/artifact-refresh.ts:123-291`
- `codex-explore` 最终交付内容和计划一致。轻量 instruction 只使用内置 `explorer`、保留模型不可用/用户显式指定其它模型时的说明规则；`SKILL.md` 走手动 `$codex-explore` workflow，且强制等待结果后再 `close_agent`；专用 role prompt 保持只读边界，见 `plugins/codex-explore/scripts/render-artifacts.mjs:74-117`、`plugins/codex-explore/skills/codex-explore/SKILL.md:11-38`
- 作者工具、bundle 与打包链路也同步到了新 contract。动态 role metadata / skill policy 校验已经进入作者工具集成测试，见 `packages/cli/tests/integration/authoring-tools.test.ts:1354-1380`；build / tarball smoke 也锁住了 `codex-explore` 的 manifest、renderer、skill、role 和 instruction bundle，见 `packages/cli/tests/smoke/build-smoke.test.ts:59-118`、`packages/cli/tests/smoke/pack-smoke.test.ts:89-106`

## 代码质量

这轮代码质量是好的，主要体现在几件事上：

- 没有为了 `codex-explore` 在 core adapter 里塞插件特判。manifest metadata、renderer、plan validation、status、refresh、preflight 都是按通用动态 artifact 基础设施接进去的。
- 风险点基本都收敛在 helper 和事务边界里，而不是散落在命令层。比如 project config access 判断收敛在 `codex-project-surface.ts`，role namespace/visibility 收敛在 `codex-roles.ts`，refresh 原子单元和 tracking 回写收敛在 `artifact-refresh.ts`。
- `packages/cli/src/adapters/codex.ts` 仍然是高复杂度文件，但这次新增逻辑没有再开旁路；instruction 和 role 对同一份 Codex config 的改动仍通过同一事务提交，并且保留 rollback baseline，这和计划要求一致。

我这次没有再看到明显的“为了赶功能先写通，再靠测试兜底”的痕迹。实现复杂，但边界是清楚的。

## 测试执行与覆盖判断

我这次实际执行了这些测试：

- `pnpm --filter @yiliang/aw exec vitest run tests/unit/artifact-plan.test.ts tests/unit/artifact-renderer.test.ts tests/unit/codex-project-safety.test.ts tests/unit/codex-adapter.test.ts tests/unit/adapter-status.test.ts tests/integration/codex-explore-plugin.test.ts tests/integration/authoring-tools.test.ts tests/integration/codex-static-extensions.test.ts tests/integration/discovery.test.ts`
- `pnpm plugin:test codex-explore`
- `pnpm test:smoke:build`
- `pnpm test:smoke:plugin-scripts`
- `pnpm test:smoke:pack`

结果：

- 上述 9 个 unit / integration test files 共 171 个测试全部通过
- `pnpm plugin:test codex-explore` 通过，1 个测试文件通过
- `pnpm test:smoke:build` 5 个测试通过
- `pnpm test:smoke:plugin-scripts` 1 个测试通过
- `pnpm test:smoke:pack` 2 个测试通过

覆盖判断：

- 上一轮报告提到的唯一遗留问题，这次已经有实现修复，也有直接回归
- 计划里的关键主路径和高风险边角，包括 manifest / renderer contract、ArtifactPlan 校验、role preflight、status visibility、config-triggered refresh、historical fallback、作者工具校验、build/pack/plugin-scripts smoke，这次都能在现有测试里找到对应锁点
- 我没有再看到会影响本次验收结论的测试空白；至少对本次计划涉及的核心变更和高风险分支来说，覆盖已经闭环

一些我重点核对过的测试点：

- 轻量 instruction / role prompt / skill 内容回归：`plugins/codex-explore/scripts/render-artifacts.test.mjs:73-232`
- project scope status 的 artifact health + projectTrust + session visibility：`packages/cli/tests/integration/codex-explore-plugin.test.ts:1024-1157`
- user config 写入同时刷新 user / current project artifact，以及 `refreshReach` 只记录当前 repo：`packages/cli/tests/integration/codex-explore-plugin.test.ts:1482-1589`、`2366-2465`
- user/project refresh 原子单元拆分，project 失败不回滚已成功提交的 user artifact：`packages/cli/tests/integration/codex-explore-plugin.test.ts:2559-2665`
- config-triggered refresh 不运行 lifecycle，status 也不运行 renderer / lifecycle：`packages/cli/tests/integration/codex-explore-plugin.test.ts:2114-2202`
- capabilityChanged 重装后清理旧 dynamic ids / role identity / residue：`packages/cli/tests/integration/codex-explore-plugin.test.ts:3209-3275`
- 动态 artifact 历史恢复不再编造假 role 名：`packages/cli/tests/integration/discovery.test.ts:215-255`

## 结论

和上一版复审相比，这轮已经可以给出“通过”的结论。

我的判断是：

- 上一轮报告里的问题已经修复
- 这轮没有再发现新的实现问题
- 实现整体遵循计划，没有看到明显偏航
- 代码质量和边界控制达到了可以交付的水位
- 测试对本次计划的核心变更和高风险边角已经形成闭环

如果后续还要继续迭代这个动态 artifact 基础设施，我会优先盯 `packages/cli/src/adapters/codex.ts` 的复杂度演进；但就这次 `codex-explore` 计划实现本身来说，我认为已经可以验收通过。
